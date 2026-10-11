import { createServer } from "node:http";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { DAEMON_PORT, PERMISSION_MODES, USAGE_CARD_MODES, type Command, type CreateSessionArgs, type ReportCall, type ServerMessage, type SessionInfo } from "@perzian/protocol";
import { EventStore } from "./store.ts";
import { AgentSession, prepareWorkspace, type PendingDecision, type SessionDeps } from "./session.ts";
import * as git from "./git.ts";
import { listClaudeSessions, toEvents } from "./importer.ts";
import { mergeProofs } from "./proof.ts";
import { assertPromptable, isShipHow, ship } from "./ship.ts";
import { interruptions } from "./boot.ts";
import { doctor, doctorHeaders, installCommand, resetDoctorCache } from "./doctor.ts";
import { Credentials, PROVIDERS } from "./credentials.ts";
import { exec } from "node:child_process";
import { allChecks, detectChecks, loadDeclaredChecks, loadDeclaredSetup } from "./checks.ts";
import { hasGithubOrigin, shipPreference } from "./github.ts";
import { KeepAwake, isActive } from "./keepawake.ts";
import { LeadNotifier, filePersistence, type ChildReport } from "./notify.ts";
import { spawnBlocker } from "./observe.ts";
import { ResumeQueue } from "./resume.ts";
import { loadDesktopToken, trustedOrigin } from "./origin.ts";
import { Devices, PairingCodes, PhoneAccess } from "./phone.ts";
import { Presence, PushSender, itemForEvent, loadVapid } from "./push.ts";
import { answerDecision } from "./decisions.ts";
import { repoTree } from "./repotree.ts";
import { startMode } from "./defaults.ts";
import { UsageGovernor } from "./usagecard.ts";
import { fileURLToPath } from "node:url";
import type { AgentKind, ApiKeyProvider, InstallResult } from "@perzian/protocol";

const port = Number(process.env.PERZIAN_PORT ?? DAEMON_PORT);
const home = resolve(process.env.PERZIAN_HOME ?? join(homedir(), ".perzian"));
const daemonUrl = `http://127.0.0.1:${port}`;
const store = new EventStore(home);
loadDesktopToken(home);
{
  const b = store.boot;
  const c = b.compacted ? `, compacted to ${b.compacted.events} events (${(b.compacted.bytes / 1e6).toFixed(2)} MB; previous log in events.jsonl.bak)` : "";
  console.log(`[store] loaded ${b.events} events (${(b.bytes / 1e6).toFixed(2)} MB) in ${b.ms.toFixed(0)} ms${c}`);
}
const sessions = new Map<string, AgentSession>();
const decisions = new Map<string, PendingDecision>();
const creds = new Credentials(home);
await creds.load();
// One account, one usage question: nearing the limit raises a single card; a refused session stops the others.
const usage = new UsageGovernor({ store, sessions: () => sessions.values() });
const deps: SessionDeps = { store, daemonUrl, decisions, creds, usage };


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
// crashed during a turn, a decision, a ship or a setup) is closed out and marked interrupted (boot.ts).
{
  for (const e of interruptions(store.state())) store.emit(e);
  for (const info of Object.values(store.state().sessions)) {
    if (!info.archived) sessions.set(info.id, new AgentSession({ ...info }, deps));
  }
  usage.attach(); // a usage card still open when the daemon stopped keeps its timeout
}

// The lead hears about the sessions it started when they finish, pause at a usage limit or resume
// (see notify.ts). A paused lead counts as busy: updates wait until it resumes.
const notifier = new LeadNotifier({
  busy: (leadId) => {
    const st = sessions.get(leadId)?.info.status;
    return st === "working" || st === "needs_you" || st === "paused";
  },
  report: (childId): ChildReport | undefined => {
    const state = store.state();
    const info = state.sessions[childId];
    if (!info) return undefined;
    const o = state.outcomes[childId];
    const p = info.pause;
    return {
      id: info.id,
      title: info.title,
      status: info.status,
      outcome: o && { status: o.status, intent: o.intent, proof: o.proof, derived: o.derived },
      changedFiles: (state.changes[childId] ?? []).length,
      ...(p ? { pause: { resumeAt: p.resumeAt, window: p.window, estimated: p.estimated, early: p.early } } : {}),
    };
  },
  deliver: (leadId, text) => {
    const lead = sessions.get(leadId);
    if (lead && !lead.info.archived) void lead.prompt(text, { system: true }).catch((e) => console.error(`[${leadId}]`, e));
  },
  notice: (leadId, text) => sessions.get(leadId)?.notice(text),
  // A worker that started sessions of its own hears about them too, worded for a worker.
  audience: (leadId) => (sessions.get(leadId)?.info.role === "main" ? "lead" : "worker"),
  ...filePersistence(join(home, "notify-pending.json")),
});
// Updates the lead hadn't heard yet when the daemon last stopped: deliver now (deferred: we're still booting).
setImmediate(() => notifier.restore());
store.subscribe((e) => {
  if (e.type === "session.paused" || e.type === "session.resumed") {
    const info = store.state().sessions[e.sessionId];
    if (info && e.type === "session.resumed") setImmediate(() => notifier.leadIdle(info.id));
    if (!info?.parentId) return;
    if (e.type === "session.paused") setImmediate(() => notifier.childPaused(info.parentId!, info.id));
    // Resumed by the reset or "Resume now"; a developer's own message to the child isn't news for the lead.
    else if (e.reason === "reset" || e.reason === "now") setImmediate(() => notifier.childResumed(info.parentId!, info.id));
    return;
  }
  if (e.type !== "session.status") return;
  const info = store.state().sessions[e.sessionId];
  if (!info) return;
  // Deferred: delivering prompts the lead, which emits events, and we're inside an emit.
  if (info.parentId && (e.status === "done" || e.status === "failed")) setImmediate(() => notifier.childSettled(info.parentId!, info.id));
  // Any session may be a parent (workers can start sessions); nothing pending makes this a no-op.
  if (e.status !== "working" && e.status !== "needs_you") setImmediate(() => notifier.leadIdle(info.id));
});

// Keep the Mac awake while any session is working or needs you (macOS only; see keepawake.ts).
const keepAwake = new KeepAwake();
const syncAwake = () => keepAwake.set(Object.values(store.state().sessions).some((s) => !s.archived && isActive(s.status)));
store.subscribe((e) => {
  if (e.type === "session.status" || e.type === "session.created" || (e.type === "session.updated" && "archived" in e.patch)) syncAwake();
});

// Sessions paused at a usage limit resume by themselves when it resets: same session, same worktree, a
// short "continue" message. The queue is rebuilt from the log, so a restart doesn't lose it.
const resumeQueue = new ResumeQueue({
  resume: (id) => {
    const s = sessions.get(id);
    if (!s || s.info.archived) return;
    void s.resume("reset").catch((e) => console.error(`[${id}]`, e));
  },
});
resumeQueue.attach(store);
{
  const waiting = resumeQueue.pending();
  if (waiting.length) console.log(`[resume] ${waiting.length} paused session(s); next at ${new Date(waiting[0].at).toLocaleString()}`);
}

const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

async function createSession(args: CreateSessionArgs, extra: { role?: "main" | "worker"; parentId?: string } = {}): Promise<AgentSession> {
  const extraDirs = (args.extraDirs ?? []).filter((d) => typeof d === "string" && d.trim()).map((d) => expand(d.trim()));
  for (const d of extraDirs) if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error(`Extra folder not found: ${d}`);
  // An empty path would resolve to the daemon's own folder.
  if (!args.project?.trim()) throw new Error("No project folder given");
  const project = expand(args.project.trim());
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new Error(`Project folder not found: ${project}`);
  const id = crypto.randomUUID();
  const title = args.title?.trim() || args.prompt.split("\n")[0].slice(0, 48) || basename(project);
  const ws = await prepareWorkspace(project, home, title, id, args.worktree);
  // perzian.json from the worktree (committed), else the checkout (not committed yet). Read once, here.
  const declared = loadDeclaredChecks(ws.cwd, project);
  const setupCfg = loadDeclaredSetup(ws.cwd, project);
  const checks = allChecks(detectChecks(ws.cwd), declared.checks);
  const shipDefault = ws.worktree ? shipPreference(declared.ship, await hasGithubOrigin(project)) : undefined;
  const s = AgentSession.create(
    { id, project, cwd: ws.cwd, branch: ws.branch, worktree: ws.worktree, baseSha: ws.baseSha, baseBranch: "baseBranch" in ws ? ws.baseBranch : undefined, title, agent: args.agent ?? "claude-code", model: args.model, mode: startMode(args.mode, store.state().settings), ...(extraDirs.length ? { extraDirs } : {}), checks, declaredChecks: declared.checks, declaredSetup: setupCfg.steps, checksError: declared.error ?? setupCfg.error, ...(shipDefault ? { shipDefault } : {}), ...extra },
    deps,
  );
  if (args.worktree !== false && !ws.worktree) s.notice("This folder isn't a git repo, so the session works in it directly (no worktree)");
  if (declared.error) s.notice(`${declared.error}. Declared checks won't run until it's fixed.`);
  notifier.childPrompted(s.info.id, !!extra.parentId);
  sessions.set(s.info.id, s);
  // A fresh worktree gets the checkout's local files and its dependencies before the first prompt goes out.
  if (ws.worktree) void s.runSetup();
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
      notifier.developerPrompted(s.info.id);
      if (s.info.role !== "main") notifier.childPrompted(s.info.id, false);
      void s.prompt(cmd.prompt);
      break;
    case "session.cancel":
      await s?.cancel();
      break;
    case "session.resume":
      if (!s) throw new Error("Unknown session");
      void s.resume("now").catch((e) => console.error(`[${s.info.id}]`, e));
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
    case "ui.presence":
      presence.report(!!cmd.focused);
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
      if (!isShipHow(cmd.how)) throw new Error(`Unknown ship method: ${String(cmd.how)}`);
      if (s.info.ship?.state === "shipping") break;
      s.setShip({ state: "shipping", how: cmd.how, at: Date.now() });
      const result = await ship(s.info, cmd.how, () => s.dispose());
      s.setShip(result);
      break;
    }
    case "settings.setDefaultMode":
      if (!PERMISSION_MODES.includes(cmd.mode)) throw new Error(`Unknown mode: ${String(cmd.mode)}`);
      if (store.state().settings.defaultMode !== cmd.mode) store.emit({ type: "settings.defaultMode", mode: cmd.mode, at: Date.now() });
      break;
    case "settings.setUsageCard":
      if (!USAGE_CARD_MODES.includes(cmd.mode)) throw new Error(`Unknown usage card mode: ${String(cmd.mode)}`);
      if (store.state().settings.usageCard !== cmd.mode) store.emit({ type: "settings.usageCard", mode: cmd.mode, at: Date.now() });
      break;
    case "usage.answer":
      if (cmd.choice !== "pause" && cmd.choice !== "keep_going") throw new Error(`Unknown choice: ${String(cmd.choice)}`);
      if (cmd.dontAsk && store.state().settings.usageCard !== cmd.choice) store.emit({ type: "settings.usageCard", mode: cmd.choice, at: Date.now() });
      usage.answer(cmd.key, cmd.choice);
      break;
    case "settings.addProject": {
      if (typeof cmd.path !== "string" || !cmd.path.trim()) throw new Error("Choose a folder");
      const path = expand(cmd.path.trim());
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Project folder not found: ${path}`);
      if (!store.state().settings.projects.includes(path)) store.emit({ type: "settings.projectAdded", path, at: Date.now() });
      break;
    }
    case "session.runChecks":
      if (!s) throw new Error("Unknown session");
      void s.rerunChecks().catch((e) => console.error(`[${s.info.id}]`, e));
      break;
    case "session.setup":
      if (!s) throw new Error("Unknown session");
      // The held first prompt came from the lead when it spawned this session: report the result to it.
      if (s.info.parentId && s.info.setup?.state === "failed") notifier.childPrompted(s.info.id, true);
      if (cmd.action === "retry") void s.retrySetup();
      else s.skipSetup();
      break;
    case "session.archive":
      s?.dropDecisions();
      s?.archive();
      break;
    case "decision.answer":
      answerDecision(decisions, cmd.decisionId, cmd.optionId);
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
    ...(info.pause ? { pausedUntil: new Date(info.pause.resumeAt).toISOString(), pauseReason: info.pause.reason } : {}),
    progress: info.progress,
    checks: info.checks,
    // perzian.json checks the daemon runs itself when the worker finishes, and how the last run went.
    requiredChecks: info.declaredChecks?.map((c) => `${c.name}: ${c.run}`),
    requiredChecksResult: info.checkRun && { state: info.checkRun.state, failed: info.checkRun.results.filter((r) => r.state === "failed").map((r) => r.name) },
    checksError: info.checksError,
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
      const blocked = spawnBlocker(s.info.id, (id) => sessions.get(id)?.info);
      if (blocked) throw new Error(blocked);
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
  const token = url.searchParams.get("t");
  if (!trustedOrigin(origin, token)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden origin");
    return;
  }
  const json = (status: number, body: unknown) => res.writeHead(status, doctorHeaders(origin, token)).end(JSON.stringify(body));
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...doctorHeaders(origin, token), "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "content-type" }).end();
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
    if (url.pathname.startsWith("/api/phone")) {
      if (url.pathname === "/api/phone" && req.method === "GET") json(200, await phone.status());
      else if (url.pathname === "/api/phone" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { on?: boolean; mode?: string };
        json(200, b.on ? await phone.turnOn(b.mode === "tunnel" ? "tunnel" : b.mode === "tailscale" ? "tailscale" : undefined) : await phone.turnOff());
      }
      else if (url.pathname === "/api/phone/pair" && req.method === "POST") json(200, phone.pair());
      else if (url.pathname === "/api/phone/devices" && req.method === "DELETE") json(200, await phone.forgetAll());
      else json(404, { error: "not found" });
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
    if (url.pathname === "/api/worktrees/leftover" && req.method === "GET") {
      json(200, git.leftoverWorktrees(home, [...sessions.values()].map((x) => x.info)));
      return;
    }
    if (url.pathname === "/api/worktrees/remove" && req.method === "POST") {
      const { path } = JSON.parse(await readBody(req)) as { path?: string };
      if (typeof path !== "string" || !path) throw new Error("No worktree given");
      await git.removeLeftoverWorktree(home, [...sessions.values()].map((x) => x.info), path);
      json(200, { ok: true });
      return;
    }
    if (url.pathname === "/api/doctor") {
      const report = await doctor(home, { project: url.searchParams.get("project") ?? undefined, fresh: url.searchParams.has("fresh"), creds });
      res.writeHead(200, doctorHeaders(origin, token)).end(JSON.stringify(report));
      return;
    }
    if (url.pathname === "/api/tree" && req.method === "GET") {
      const s = sessions.get(url.searchParams.get("session") ?? "");
      if (!s) throw new Error("unknown session");
      json(200, await repoTree(s.info.cwd));
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
    res.writeHead(400, { "content-type": "text/plain", ...(origin && trustedOrigin(origin, token) ? { "access-control-allow-origin": origin } : {}) }).end(String((e as Error).message ?? e));
  }
});

const wss = new WebSocketServer({ server: http, path: "/ws", verifyClient: ({ origin, req }: { origin?: string; req: { url?: string } }) => trustedOrigin(origin, new URL(req.url ?? "/", daemonUrl).searchParams.get("t")) });
const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

// A paired phone answers and stops things; it doesn't start sessions, prompt, import or ship.
const PHONE_COMMANDS: ReadonlySet<string> = new Set(["decision.answer", "session.cancel", "session.resume", "session.seen"]);

function attach(ws: WebSocket, phone: boolean) {
  send(ws, { type: "snapshot", events: store.snapshot() });
  const unsubscribe = store.subscribe((event) => send(ws, { type: "event", event }));
  ws.on("message", (raw) => {
    Promise.resolve()
      .then(() => {
        const cmd = JSON.parse(String(raw)) as Command;
        if (phone && !PHONE_COMMANDS.has(cmd?.type)) throw new Error("Not available from a phone");
        return handleCommand(cmd);
      })
      .catch((e) => send(ws, { type: "error", message: String((e as Error).message ?? e) }));
  });
  ws.on("close", unsubscribe);
}
wss.on("connection", (ws) => attach(ws, false));

// Phone access (phone.ts): off unless the developer turned it on. Its own listener, always token-gated.
const here = fileURLToPath(new URL(".", import.meta.url));
const phoneWebDir = () => [process.env.PERZIAN_WEB_DIR, join(here, "../../web/dist"), join(here, "../web")].find((d) => d && existsSync(join(d, "index.html")));
const phoneDevices = new Devices(home);
const vapid = loadVapid(home);
const phone = new PhoneAccess({
  home,
  port: Number(process.env.PERZIAN_PHONE_PORT ?? port + 2),
  httpsPort: Number(process.env.PERZIAN_PHONE_HTTPS ?? 8443),
  devices: phoneDevices,
  codes: new PairingCodes(),
  webDir: phoneWebDir,
  onConnection: (ws) => attach(ws, true),
  push: { publicKey: vapid.publicKey },
});
void phone.restore();

// Web Push (push.ts): a session that needs you, failed or is done, coalesced over 5 s, title only. Quiet while
// the Mac UI is focused and active, and while Phone access is off.
const presence = new Presence();
const pusher = new PushSender({ devices: phoneDevices, vapid, enabled: () => phone.isOn(), uiActive: () => presence.active() });
store.subscribe((e) => pusher.notify(itemForEvent(e, store.state().sessions)));

// A taken port is almost always another daemon; say so and exit non-zero instead of a stack trace.
const listenFailed = (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `perzian daemon: port ${port} is already in use (another Perzian daemon?). Stop it, or set PERZIAN_PORT to another port.` : `perzian daemon: can't listen on ${daemonUrl}: ${e.message}`);
  process.exit(1);
};
http.on("error", listenFailed);
wss.on("error", listenFailed); // ws re-emits the server's errors; unhandled, they'd crash with a trace
http.listen(port, "127.0.0.1", () => console.log(`perzian daemon on ${daemonUrl} (home ${home})`));

const shutdown = () => {
  phone.killTunnel();
  pusher.dispose();
  keepAwake.stop();
  resumeQueue.dispose();
  for (const s of sessions.values()) s.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => phone.killTunnel()); // however we leave, cloudflared doesn't outlive us
