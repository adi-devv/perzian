import { createServer } from "node:http";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { DAEMON_PORT, type Command, type CreateSessionArgs, type ReportCall, type ServerMessage, type SessionInfo } from "@perzian/protocol";
import { EventStore } from "./store.ts";
import { AgentSession, prepareWorkspace, type PendingDecision, type SessionDeps } from "./session.ts";
import * as git from "./git.ts";
import { listClaudeSessions, toEvents } from "./importer.ts";
import { mergeProofs } from "./proof.ts";
import { assertPromptable, interruptedShip, ship } from "./ship.ts";
import { doctor, doctorHeaders, installCommand, resetDoctorCache } from "./doctor.ts";
import { Credentials, PROVIDERS } from "./credentials.ts";
import { exec } from "node:child_process";
import { detectChecks } from "./checks.ts";
import { LeadNotifier, type ChildReport } from "./notify.ts";
import { trustedOrigin } from "./origin.ts";
import type { AgentKind, ApiKeyProvider, InstallResult } from "@perzian/protocol";

const port = Number(process.env.PERZIAN_PORT ?? DAEMON_PORT);
const home = resolve(process.env.PERZIAN_HOME ?? join(homedir(), ".perzian"));
const daemonUrl = `http://127.0.0.1:${port}`;
const store = new EventStore(home);
{
  const b = store.boot;
  const c = b.compacted ? `, compacted to ${b.compacted.events} events (${(b.compacted.bytes / 1e6).toFixed(2)} MB; previous log in events.jsonl.bak)` : "";
  console.log(`[store] loaded ${b.events} events (${(b.bytes / 1e6).toFixed(2)} MB) in ${b.ms.toFixed(0)} ms${c}`);
}
const sessions = new Map<string, AgentSession>();
const decisions = new Map<string, PendingDecision>();
const creds = new Credentials(home);
await creds.load();
const deps: SessionDeps = { store, daemonUrl, decisions, creds };


let installing: Promise<InstallResult> | undefined;
function runInstaller(agent: AgentKind): Promise<InstallResult> {
  installing ??= new Promise<InstallResult>((done) => {
    exec(installCommand(agent), { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.split("\n").filter((l) => l.trim()).slice(-12).join("\n");
      done({ ok: !err, output });
    });
  }).finally(() => {
    installing = undefined;
    resetDoctorCache();
  });
  return installing;
}

// Restore sessions from the log as dormant; anything that was mid-flight (the daemon was stopped or
// crashed during a turn) is now idle, with no open decisions and no tool calls left spinning.
const OPEN_TOOL = (status: string) => status !== "completed" && status !== "failed" && status !== "cancelled";
{
  const state = store.state();
  for (const d of Object.values(state.decisions)) store.emit({ type: "decision.resolved", decisionId: d.id, sessionId: d.sessionId, optionId: null });
  for (const info of Object.values(state.sessions)) {
    if (info.archived) continue;
    const s = new AgentSession({ ...info, live: false }, deps);
    sessions.set(info.id, s);
    if (info.live) store.emit({ type: "session.updated", sessionId: info.id, patch: { live: false } });
    const at = Date.now();
    for (const t of state.transcripts[info.id] ?? []) {
      if (t.kind === "tool" && OPEN_TOOL(t.status)) store.emit({ type: "session.transcript", sessionId: info.id, item: { ...t, status: "cancelled", at } });
    }
    if (info.status === "working" || info.status === "needs_you") {
      s.notice("Interrupted: the daemon restarted during this turn");
      s.setStatus("idle");
    }
    if (info.ship?.state === "shipping") s.setShip(interruptedShip(info.ship));
  }
}

// The lead hears about the sessions it started when they finish (see notify.ts).
const notifier = new LeadNotifier({
  busy: (leadId) => {
    const st = sessions.get(leadId)?.info.status;
    return st === "working" || st === "needs_you";
  },
  report: (childId): ChildReport | undefined => {
    const state = store.state();
    const info = state.sessions[childId];
    if (!info) return undefined;
    const o = state.outcomes[childId];
    return { id: info.id, title: info.title, status: info.status, outcome: o && { status: o.status, intent: o.intent, proof: o.proof, derived: o.derived }, changedFiles: (state.changes[childId] ?? []).length };
  },
  deliver: (leadId, text) => {
    const lead = sessions.get(leadId);
    if (lead && !lead.info.archived) void lead.prompt(text, { system: true }).catch((e) => console.error(`[${leadId}]`, e));
  },
  notice: (leadId, text) => sessions.get(leadId)?.notice(text),
});
store.subscribe((e) => {
  if (e.type !== "session.status") return;
  const info = store.state().sessions[e.sessionId];
  if (!info) return;
  // Deferred: delivering prompts the lead, which emits events, and we're inside an emit.
  if (info.parentId && (e.status === "done" || e.status === "failed")) setImmediate(() => notifier.childSettled(info.parentId!, info.id));
  if (info.role === "main" && e.status !== "working" && e.status !== "needs_you") setImmediate(() => notifier.leadIdle(info.id));
});

const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

async function createSession(args: CreateSessionArgs, extra: { role?: "main" | "worker"; parentId?: string } = {}): Promise<AgentSession> {
  const project = expand(args.project);
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new Error(`Project folder not found: ${project}`);
  const id = crypto.randomUUID();
  const title = args.title?.trim() || args.prompt.split("\n")[0].slice(0, 48) || basename(project);
  const ws = await prepareWorkspace(project, home, title, id, !!args.worktree);
  const checks = detectChecks(ws.cwd);
  const s = AgentSession.create(
    { id, project, cwd: ws.cwd, branch: ws.branch, worktree: ws.worktree, baseSha: ws.baseSha, baseBranch: "baseBranch" in ws ? ws.baseBranch : undefined, title, agent: args.agent ?? "claude-code", model: args.model, mode: args.mode, checks, ...extra },
    deps,
  );
  notifier.childPrompted(s.info.id, !!extra.parentId);
  sessions.set(s.info.id, s);
  if (extra.parentId) {
    store.emit({ type: "session.transcript", sessionId: extra.parentId, item: { kind: "spawn", childId: s.info.id, title, at: Date.now() } });
  }
  void s.prompt(args.prompt).catch((e) => console.error(`[${s.info.id}]`, e));
  return s;
}

function mainSession(): AgentSession | undefined {
  return [...sessions.values()].find((s) => s.info.role === "main" && !s.info.archived);
}

async function handleCommand(cmd: Command): Promise<void> {
  const s = "sessionId" in cmd ? sessions.get(cmd.sessionId) : undefined;
  switch (cmd.type) {
    case "session.create":
      await createSession(cmd);
      break;
    case "main.start": {
      const existing = mainSession();
      if (existing) {
        if (cmd.model !== undefined) await existing.applyModel(cmd.model);
        if (cmd.prompt) notifier.developerPrompted(existing.info.id);
        if (cmd.prompt) void existing.prompt(cmd.prompt);
        break;
      }
      const dir = join(home, "main");
      mkdirSync(dir, { recursive: true });
      const m = AgentSession.create({ project: dir, cwd: dir, title: "Perzian", agent: cmd.agent ?? "claude-code", model: cmd.model, role: "main", mode: "ask" }, deps);
      sessions.set(m.info.id, m);
      if (cmd.prompt) void m.prompt(cmd.prompt);
      else await m.ensureStarted();
      break;
    }
    case "session.prompt":
      if (!s) throw new Error("Unknown session");
      assertPromptable(s.info);
      if (s.info.role === "main") notifier.developerPrompted(s.info.id);
      else notifier.childPrompted(s.info.id, false);
      void s.prompt(cmd.prompt);
      break;
    case "session.cancel":
      await s?.cancel();
      break;
    case "session.setModel":
      await s?.applyModel(cmd.model);
      break;
    case "session.setMode":
      await s?.applyMode(cmd.mode);
      break;
    case "session.seen":
      store.emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { seenAt: Date.now() } });
      break;
    case "sessions.import": {
      // Bring in recent Claude Code sessions from ~/.claude/projects; they resume via ACP loadSession.
      const known = [...sessions.values()].map((x) => x.info.acpSessionId).filter((v): v is string => !!v);
      const found = await listClaudeSessions({ sinceDays: cmd.sinceDays, limit: cmd.limit, perzianHome: home, excludeIds: known });
      for (const imp of found) {
        const id = crypto.randomUUID();
        const events = toEvents(imp, id, { baseSha: await git.head(imp.cwd) });
        for (const e of events) store.emit(e);
        const info = store.state().sessions[id];
        if (info) sessions.set(id, new AgentSession({ ...info }, deps));
      }
      break;
    }
    case "session.ship": {
      if (!s) throw new Error("Unknown session");
      if (s.info.ship?.state === "shipping") break;
      s.setShip({ state: "shipping", how: cmd.how, at: Date.now() });
      const result = await ship(s.info, cmd.how, () => s.dispose());
      s.setShip(result);
      break;
    }
    case "session.archive":
      s?.dropDecisions();
      s?.archive();
      break;
    case "decision.answer":
      decisions.get(cmd.decisionId)?.resolve(cmd.optionId);
      break;
  }
}

function brief(info: SessionInfo) {
  const state = store.state();
  const outcome = state.outcomes[info.id];
  const transcript = state.transcripts[info.id] ?? [];
  let lastAgent: (typeof transcript)[number] | undefined;
  for (let i = transcript.length - 1; i >= 0 && !lastAgent; i--) if (transcript[i].kind === "agent") lastAgent = transcript[i];
  return {
    id: info.id,
    title: info.title,
    project: info.project,
    branch: info.branch,
    status: info.status,
    progress: info.progress,
    checks: info.checks,
    changedFiles: (state.changes[info.id] ?? []).map((f) => `${f.kind[0].toUpperCase()} ${f.path} +${f.additions}/-${f.deletions}`),
    outcome: outcome && { status: outcome.status, intent: outcome.intent, proof: outcome.proof, risks: outcome.risks },
    lastMessage: lastAgent && lastAgent.kind === "agent" ? lastAgent.text.slice(0, 500) : undefined,
  };
}

async function handleReport(call: ReportCall): Promise<unknown> {
  const s = sessions.get(call.sessionId);
  if (!s) throw new Error(`unknown session ${call.sessionId}`);
  switch (call.tool) {
    case "report_progress":
      s.info.progress = call.args;
      store.emit({ type: "session.progress", sessionId: s.info.id, progress: call.args });
      return "ok";
    case "ask_decision": {
      const optionId = await s.requestDecision({
        source: "ask_decision",
        question: call.args.question,
        options: call.args.options.map((o) => ({ ...o, kind: "choice" as const })),
        recommended: call.args.recommended,
      });
      return optionId ?? "dismissed";
    }
    case "report_outcome": {
      s.markOutcome();
      // What the daemon saw run outranks what the agent says it ran.
      const proof = mergeProofs(s.proofs.proofs(), call.args.proof);
      const status = call.args.status === "success" && proof.some((p) => p.observed && !p.passed) ? "partial" : call.args.status;
      store.emit({ type: "outcome.reported", outcome: { ...call.args, status, proof, sessionId: s.info.id, createdAt: Date.now() } });
      return "ok";
    }
    case "list_sessions":
      return [...sessions.values()].filter((x) => x.info.role === "worker" && !x.info.archived).map((x) => brief(x.info));
    case "get_session": {
      const t = sessions.get(call.args.id);
      if (!t) throw new Error("no such session");
      return brief(t.info);
    }
    case "spawn_session": {
      const child = await createSession(call.args, { parentId: s.info.id });
      return { id: child.info.id, title: child.info.title, cwd: child.info.cwd, branch: child.info.branch };
    }
    case "send_to_session": {
      const t = sessions.get(call.args.id);
      if (!t) throw new Error("no such session");
      assertPromptable(t.info);
      notifier.childPrompted(t.info.id, s.info.role === "main");
      void t.prompt(call.args.prompt);
      return "sent";
    }
  }
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", daemonUrl);
  const origin = req.headers.origin;
  if (!trustedOrigin(origin)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden origin");
    return;
  }
  const json = (status: number, body: unknown) => res.writeHead(status, doctorHeaders(origin)).end(JSON.stringify(body));
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...doctorHeaders(origin), "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "content-type" }).end();
      return;
    }
    if (url.pathname === "/api/credentials") {
      if (req.method === "POST") {
        const { provider, key } = JSON.parse(await readBody(req)) as { provider: ApiKeyProvider; key: string };
        await creds.set(provider, String(key ?? ""));
        resetDoctorCache();
      } else if (req.method === "DELETE") {
        const provider = url.searchParams.get("provider") as ApiKeyProvider;
        if (!PROVIDERS.includes(provider)) throw new Error("Unknown provider");
        await creds.remove(provider);
        resetDoctorCache();
      }
      json(200, creds.status());
      return;
    }
    if (url.pathname === "/api/install" && req.method === "POST") {
      const { agent } = JSON.parse(await readBody(req)) as { agent: AgentKind };
      if (agent !== "claude-code" && agent !== "codex") throw new Error("Unknown agent");
      json(200, await runInstaller(agent));
      return;
    }
    if (req.method === "POST" && url.pathname === "/report") {
      const out = await handleReport(JSON.parse(await readBody(req)));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      return;
    }
    if (url.pathname === "/api/doctor") {
      const report = await doctor(home, { project: url.searchParams.get("project") ?? undefined, fresh: url.searchParams.has("fresh"), creds });
      res.writeHead(200, doctorHeaders(req.headers.origin)).end(JSON.stringify(report));
      return;
    }
    if (url.pathname === "/api/diff" || url.pathname === "/api/file") {
      const s = sessions.get(url.searchParams.get("session") ?? "");
      const path = url.searchParams.get("path") ?? "";
      if (!s) throw new Error("unknown session");
      const text = url.pathname === "/api/diff" ? (s.info.baseSha ? await git.fileDiff(s.info.cwd, s.info.baseSha, path) : "") : git.fileContent(s.info.cwd, path);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("perzian daemon");
  } catch (e) {
    res.writeHead(400, { "content-type": "text/plain", ...(origin && trustedOrigin(origin) ? { "access-control-allow-origin": origin } : {}) }).end(String((e as Error).message ?? e));
  }
});

const wss = new WebSocketServer({ server: http, path: "/ws", verifyClient: ({ origin }: { origin?: string }) => trustedOrigin(origin) });
const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

wss.on("connection", (ws) => {
  send(ws, { type: "snapshot", events: store.snapshot() });
  const unsubscribe = store.subscribe((event) => send(ws, { type: "event", event }));
  ws.on("message", (raw) => {
    Promise.resolve()
      .then(() => handleCommand(JSON.parse(String(raw)) as Command))
      .catch((e) => send(ws, { type: "error", message: String((e as Error).message ?? e) }));
  });
  ws.on("close", unsubscribe);
});

// A taken port is almost always another daemon; say so and exit non-zero instead of a stack trace.
const listenFailed = (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `perzian daemon: port ${port} is already in use (another Perzian daemon?). Stop it, or set PERZIAN_PORT to another port.` : `perzian daemon: can't listen on ${daemonUrl}: ${e.message}`);
  process.exit(1);
};
http.on("error", listenFailed);
wss.on("error", listenFailed); // ws re-emits the server's errors; unhandled, they'd crash with a trace
http.listen(port, "127.0.0.1", () => console.log(`perzian daemon on ${daemonUrl} (home ${home})`));

const shutdown = () => {
  for (const s of sessions.values()) s.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
