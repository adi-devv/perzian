import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  MAIN_INSTRUCTIONS,
  REPORT_INSTRUCTIONS,
  type AgentConfig,
  type AgentKind,
  type Decision,
  type PermissionMode,
  type SessionInfo,
  type SessionStatus,
} from "@perzian/protocol";
import type { EventStore } from "./store.ts";
import * as git from "./git.ts";
import { symbolChanges } from "./symbols.ts";
import { ProofTracker, mergeProofs } from "./proof.ts";
import { existsSync } from "node:fs";
import { adapterEntry, agentEnv } from "./agents.ts";

const here = dirname(fileURLToPath(import.meta.url));
const reportMcpEntry = join(here, "../../../packages/report-mcp/src/index.ts");
const tsxCli = join(here, "../../../node_modules/tsx/dist/cli.mjs");
const bundledReportMcp = join(here, "report-mcp.mjs");
// Packaged app: a prebuilt report-mcp next to the bundle (or PERZIAN_REPORT_MCP); dev: run the TS source via tsx.
const reportMcpArgs = (): string[] =>
  process.env.PERZIAN_REPORT_MCP ? [process.env.PERZIAN_REPORT_MCP] : existsSync(bundledReportMcp) ? [bundledReportMcp] : [tsxCli, reportMcpEntry];


// Our permission modes -> candidate mode ids, first one the agent offers wins.
const MODE_IDS: Record<PermissionMode, string[]> = {
  ask: ["default", "ask", "read-only"],
  edits: ["acceptEdits", "auto", "auto-edit"],
  plan: ["plan", "read-only"],
  auto: ["bypassPermissions", "dontAsk", "full-access", "yolo"],
};

const DEBUG = !!process.env.PERZIAN_DEBUG;
const INTERNAL_TOOLS = new Set(["ToolSearch"]);

// claude-agent-acp sends the raw tool name as `name` and in _meta.claudeCode.toolName.
function toolName(update: { _meta?: Record<string, unknown> | null }): string | undefined {
  const u = update as { name?: unknown; _meta?: { claudeCode?: { toolName?: unknown } } | null };
  const n = typeof u.name === "string" ? u.name : u._meta?.claudeCode?.toolName;
  return typeof n === "string" ? n : undefined;
}
const OWN_TOOL = /^mcp__perzian__|^perzian[_.]/;
const isTerminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled";

export interface PendingDecision {
  decision: Decision;
  resolve: (optionId: string | null) => void;
}

export interface SessionDeps {
  store: EventStore;
  daemonUrl: string;
  decisions: Map<string, PendingDecision>;
}

// One agent session = one adapter process + one ACP connection. Can be dormant (restored from the log)
// and is re-attached on the next prompt.
export class AgentSession {
  private proc?: ChildProcess;
  private stderrTail = ""; // last lines the adapter (and the agent CLI under it) wrote to stderr
  private conn?: acp.ClientSideConnection;
  private starting?: Promise<void>;
  private agentText = "";
  private tools = new Map<string, { title: string; kind?: string; status: string; own: boolean; hidden: boolean }>();
  private inflight = 0;
  private outcomeThisTurn = false;
  // Verification commands the agent actually ran this turn, with real exit codes.
  readonly proofs = new ProofTracker();
  private changeTimer?: ReturnType<typeof setTimeout>;
  private modelOptionId?: string;
  private availableModes: string[] = [];
  private turn = 0;
  private lastChanges?: string;
  private disposing = false;
  private turnBaseline?: string;

  constructor(public info: SessionInfo, private deps: SessionDeps) {
    // A restored session starts from what the log already has, so reattaching doesn't re-emit it.
    const st = deps.store.state();
    const config = st.configs[info.id];
    if (config) this.config = config;
    const files = st.changes[info.id];
    if (files) this.lastChanges = JSON.stringify(files);
  }

  static create(
    opts: { project: string; cwd: string; title: string; agent: AgentKind; model?: string; mode?: PermissionMode; role?: "main" | "worker"; parentId?: string; branch?: string; worktree?: boolean; baseSha?: string; id?: string },
    deps: SessionDeps,
  ): AgentSession {
    const now = Date.now();
    const info: SessionInfo = {
      id: opts.id ?? randomUUID(),
      role: opts.role ?? "worker",
      parentId: opts.parentId,
      title: opts.title,
      project: opts.project,
      cwd: opts.cwd,
      branch: opts.branch,
      worktree: opts.worktree,
      baseSha: opts.baseSha,
      agent: opts.agent,
      model: opts.model || undefined,
      mode: opts.mode ?? "ask",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    deps.store.emit({ type: "session.created", session: info });
    return new AgentSession({ ...info }, deps);
  }

  private get store() {
    return this.deps.store;
  }

  private update(patch: Partial<SessionInfo>): void {
    Object.assign(this.info, patch);
    this.store.emit({ type: "session.updated", sessionId: this.info.id, patch });
  }

  setStatus(status: SessionStatus): void {
    if (this.info.status === status) return;
    this.info.status = status;
    this.info.updatedAt = Date.now();
    this.store.emit({ type: "session.status", sessionId: this.info.id, status, at: this.info.updatedAt });
  }

  // ACP errors are often a bare "Internal error"; the cause is in `data` or the agent's stderr.
  private describeError(err: unknown): string {
    const e = err as { message?: string; data?: unknown };
    const data = typeof e?.data === "string" ? e.data : e?.data && typeof e.data === "object" ? ((e.data as { details?: string; message?: string }).details ?? (e.data as { message?: string }).message ?? JSON.stringify(e.data)) : "";
    const tail = this.stderrTail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    const parts = [e?.message ?? String(err), data, tail].filter((x, i, a) => x && a.indexOf(x) === i);
    return `Error: ${parts.join(" · ").slice(0, 600)}`;
  }

  notice(text: string): void {
    this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "notice", text, at: Date.now() } });
  }

  markOutcome(): void {
    this.outcomeThisTurn = true;
  }

  ensureStarted(): Promise<void> {
    if (this.conn) return Promise.resolve();
    this.starting ??= this.start()
      .catch((err) => {
        // Don't leave a half-initialized adapter running.
        this.conn = undefined;
        this.dispose();
        throw err;
      })
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<void> {
    // The user's installed agent CLI when there is one, else the binary bundled with the adapter.
    const agent = agentEnv(this.info.agent);
    console.log(`[${this.info.id.slice(0, 6)}] ${this.info.agent} executable (${agent.resolved.source}): ${agent.resolved.path}`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...agent.env };
    if (this.info.agent === "claude-code" && this.info.model) env.ANTHROPIC_MODEL = this.info.model;
    const proc = spawn(process.execPath, [adapterEntry(this.info.agent)], { cwd: this.info.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    let stderr = "";
    proc.stderr!.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
      this.stderrTail = stderr;
    });
    const tail = () => stderr.split("\n").filter(Boolean).slice(-2).join(" ");
    // Rejects if the adapter can't be spawned or dies before the session is set up.
    const died = new Promise<never>((_, reject) => {
      proc.on("error", reject);
      proc.on("exit", (code, signal) => reject(new Error(`agent exited (${code ?? signal}) ${tail()}`)));
    });
    died.catch(() => {});
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return; // a newer adapter already replaced this one
      this.conn = undefined;
      this.proc = undefined;
      if (this.info.live) this.update({ live: false });
      if (!this.disposing && (this.info.status === "working" || this.info.status === "needs_you")) {
        this.dropDecisions();
        this.notice(`Agent exited (${code ?? signal}). ${tail()}`);
        this.setStatus("failed");
      }
      this.disposing = false;
    });

    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);
    const conn = new acp.ClientSideConnection(() => this.client(), stream);

    const init = await Promise.race([
      died,
      conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
    ]);
    const mcpServers = [
      {
        name: "perzian",
        // process.execPath is node, or Electron running as node inside the desktop app.
        command: process.execPath,
        args: reportMcpArgs(),
        env: [
          ...(process.env.ELECTRON_RUN_AS_NODE ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }] : []),
          { name: "PERZIAN_SESSION_ID", value: this.info.id },
          { name: "PERZIAN_DAEMON_URL", value: this.deps.daemonUrl },
          { name: "PERZIAN_ROLE", value: this.info.role },
        ],
      },
    ];

    let res: acp.NewSessionResponse | acp.LoadSessionResponse | undefined;
    if (this.info.acpSessionId && init.agentCapabilities?.loadSession) {
      // Replay is suppressed: we already have the transcript in our log.
      this.replaying = true;
      try {
        res = await Promise.race([died, conn.loadSession({ sessionId: this.info.acpSessionId, cwd: this.info.cwd, mcpServers })]);
        this.turn = 1; // the preamble is already part of the restored conversation
        this.notice("Reattached to the previous conversation");
      } catch (err) {
        if (DEBUG) console.error(`[${this.info.id.slice(0, 6)}] loadSession failed`, err);
      } finally {
        this.replaying = false;
        this.agentText = "";
      }
    }
    if (!res) {
      if (this.info.acpSessionId) this.notice("Previous conversation could not be restored; starting fresh");
      const created = await Promise.race([died, conn.newSession({ cwd: this.info.cwd, mcpServers })]);
      res = created;
      this.turn = 0;
      this.update({ acpSessionId: created.sessionId });
    }
    this.conn = conn;
    this.update({ live: true });
    this.readConfig(res);
    if (this.info.mode) await this.applyMode(this.info.mode).catch((e) => this.notice(`Could not set mode: ${(e as Error).message ?? e}`));
    if (this.info.model) await this.applyModel(this.info.model).catch((e) => this.notice(`Could not set model: ${(e as Error).message ?? e}`));
  }

  private replaying = false;
  private config: AgentConfig = { models: [], modes: [] };

  // Merges whatever the agent reported (new/load session response, set_config_option response, or a
  // config_option_update / current_mode_update notification) into the last known config.
  private readConfig(res: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null; currentModeId?: string }): void {
    const config: AgentConfig = { ...this.config };
    if (res.modes) {
      this.availableModes = res.modes.availableModes.map((m) => m.id);
      config.modes = res.modes.availableModes.map((m) => ({ id: m.id, name: m.name }));
      config.currentMode = res.modes.currentModeId;
    }
    if (res.currentModeId) config.currentMode = res.currentModeId;
    const flatten = (o: acp.SessionConfigOption & { type: "select" }) =>
      (o.options as (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[]).flatMap((x) => ("group" in x ? x.options : [x]));
    const modelOpt = res.configOptions?.find((o) => o.category === "model" && o.type === "select");
    if (modelOpt && modelOpt.type === "select") {
      this.modelOptionId = modelOpt.id;
      config.models = flatten(modelOpt).map((o) => ({ value: o.value, name: o.name }));
      config.currentModel = modelOpt.currentValue;
    }
    const modeOpt = res.configOptions?.find((o) => o.category === "mode" && o.type === "select");
    if (modeOpt && modeOpt.type === "select") {
      const modes = flatten(modeOpt).map((o) => ({ id: o.value, name: o.name }));
      if (modes.length) {
        config.modes = modes;
        this.availableModes = modes.map((m) => m.id);
      }
      config.currentMode = modeOpt.currentValue;
    }
    if (JSON.stringify(config) === JSON.stringify(this.config)) return;
    this.config = config;
    this.store.emit({ type: "session.config", sessionId: this.info.id, config });
  }

  // Mode/model changes go through one queue per session so rapid UI clicks apply in order.
  private configQueue: Promise<unknown> = Promise.resolve();
  private queueConfig(fn: () => Promise<void>): Promise<void> {
    const run = this.configQueue.then(fn, fn);
    this.configQueue = run.catch(() => {});
    return run;
  }

  applyMode(mode: PermissionMode): Promise<void> {
    if (this.info.mode !== mode) this.update({ mode });
    return this.queueConfig(async () => {
      if (!this.conn || !this.info.acpSessionId || this.info.mode !== mode) return; // superseded
      const modeId = MODE_IDS[mode].find((m) => this.availableModes.includes(m));
      if (!modeId) {
        this.notice(`This agent has no "${mode}" mode`);
        return;
      }
      if (this.config.currentMode === modeId) return;
      await this.conn.setSessionMode({ sessionId: this.info.acpSessionId, modeId });
      this.readConfig({ currentModeId: modeId });
    });
  }

  // "" means the agent's default model.
  applyModel(model: string): Promise<void> {
    if ((this.info.model ?? "") !== model) this.update({ model });
    return this.queueConfig(async () => {
      if (!this.conn || !this.info.acpSessionId || !this.modelOptionId || (this.info.model ?? "") !== model) return;
      const value = model ? this.matchModel(model) : this.config.models.find((m) => m.value === "default")?.value;
      if (!value || value === this.config.currentModel) return;
      const res = await this.conn.setSessionConfigOption({ sessionId: this.info.acpSessionId, configId: this.modelOptionId, value });
      this.readConfig({ configOptions: res.configOptions });
    });
  }

  // Our model ids ("claude-haiku-5-5") -> the agent's option values ("haiku", "claude-sonnet-5", ...).
  private matchModel(model: string): string {
    const opts = this.config.models;
    const exact = opts.find((o) => o.value === model);
    if (exact) return exact.value;
    // "claude-haiku-5-5" -> "haiku 5.5", compared against option names like "Haiku 5.5".
    const m = model.toLowerCase().match(/^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
    if (m) {
      const label = `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
      const byName = opts.find((o) => o.name.toLowerCase().replace(/\s*\(.*\)$/, "") === label);
      if (byName) return byName.value;
    }
    const prefixed = opts.find((o) => o.value.startsWith(model) || model.startsWith(o.value + "-"));
    if (prefixed && prefixed.value !== "default") return prefixed.value;
    const family = ["opus", "sonnet", "haiku", "fable"].find((f) => model.includes(f));
    return (family && (opts.find((o) => o.value === family) ?? opts.find((o) => o.value.includes(family)))?.value) || model;
  }

  async prompt(text: string): Promise<void> {
    this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "user", text, at: Date.now() } });
    // A prompt sent while a turn is running is queued by the agent; the session stays "working" until
    // the last one returns.
    const first = this.inflight++ === 0;
    if (first) {
      this.outcomeThisTurn = false;
      this.proofs.reset();
    }
    this.setStatus("working");
    try {
      await this.ensureStarted();
      if (!this.conn || !this.info.acpSessionId) throw new Error("session not started");
      if (first) this.turnBaseline = this.info.baseSha ? JSON.stringify(await git.changes(this.info.cwd, this.info.baseSha).catch(() => [])) : undefined;
      const preamble = this.info.role === "main" ? MAIN_INSTRUCTIONS : REPORT_INSTRUCTIONS;
      const body = this.turn++ === 0 ? `${preamble}\n\n---\n\n${text}` : text;
      const res = await this.conn.prompt({ sessionId: this.info.acpSessionId, prompt: [{ type: "text", text: body }] });
      this.flushAgentText();
      // Close the cancelled turn's tools now, even if a newer prompt is already queued behind it;
      // otherwise that prompt's end_turn would close them as "completed".
      if (res.stopReason === "cancelled") this.closeOpenTools("cancelled");
      if (this.inflight === 1) await this.finishTurn(text, res.stopReason);
    } catch (err) {
      this.flushAgentText();
      this.notice(this.describeError(err));
      if (this.inflight === 1) {
        this.dropDecisions();
        this.closeOpenTools("failed");
        this.setStatus("failed");
      }
    } finally {
      this.inflight--;
    }
  }

  // Tool calls the agent never closed (cancelled turn, crash) would spin forever in the UI.
  private closeOpenTools(status: string): void {
    for (const [toolCallId, t] of this.tools) {
      if (t.hidden || isTerminal(t.status)) continue;
      t.status = status;
      this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "tool", toolCallId, title: t.title, status, toolKind: t.kind, at: Date.now() } });
    }
  }

  private async finishTurn(prompt: string, stopReason: acp.StopReason): Promise<void> {
    this.dropDecisions();
    this.closeOpenTools(stopReason === "cancelled" ? "cancelled" : "completed");
    const files = await this.refreshChanges();
    // Only derive an outcome when this turn actually touched files (not for a follow-up question).
    const changedThisTurn = files.length > 0 && JSON.stringify(files) !== this.turnBaseline;
    const observed = this.proofs.proofs();
    const failedCheck = observed.some((p) => !p.passed);
    if (this.info.role === "worker" && this.outcomeThisTurn && observed.length) {
      // Checks that ran after the agent's report_outcome still belong in it.
      const reported = this.store.state().outcomes[this.info.id];
      if (reported && !reported.derived) {
        const proof = mergeProofs(observed, reported.proof.filter((p) => !p.observed));
        if (JSON.stringify(proof) !== JSON.stringify(reported.proof)) {
          const status = reported.status === "success" && failedCheck ? "partial" : reported.status;
          this.store.emit({ type: "outcome.reported", outcome: { ...reported, proof, status } });
        }
      }
    }
    if (this.info.role === "worker" && !this.outcomeThisTurn && (changedThisTurn || observed.length > 0) && stopReason === "end_turn") {
      this.store.emit({
        type: "outcome.reported",
        outcome: {
          sessionId: this.info.id,
          intent: prompt.split("\n")[0].slice(0, 140),
          status: failedCheck ? "partial" : "success",
          changed: files.map((f) => ({ path: f.path, kind: f.kind })),
          proof: observed,
          risks: [],
          followups: [],
          derived: true,
          createdAt: Date.now(),
        },
      });
    }
    this.setStatus(stopReason === "cancelled" ? "idle" : stopReason === "refusal" ? "failed" : "done");
  }

  async refreshChanges() {
    if (!this.info.baseSha) return [];
    try {
      const files = await symbolChanges(this.info.cwd, this.info.baseSha, await git.changes(this.info.cwd, this.info.baseSha));
      const key = JSON.stringify(files);
      if (key !== this.lastChanges) {
        this.lastChanges = key;
        this.store.emit({ type: "session.changes", sessionId: this.info.id, files, at: Date.now() });
      }
      return files;
    } catch {
      return [];
    }
  }

  private scheduleChanges(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => void this.refreshChanges(), 600);
  }

  async cancel(): Promise<void> {
    this.dropDecisions();
    // Everything still running belongs to the turn being cancelled; a late "completed" from the agent
    // won't reopen it (terminal tool states are sticky, see tool_call_update).
    this.closeOpenTools("cancelled");
    if (this.conn && this.info.acpSessionId) await this.conn.cancel({ sessionId: this.info.acpSessionId });
  }

  // Resolves this session's open decisions as dismissed (turn ended, cancelled, or agent gone).
  dropDecisions(): void {
    this.dropping = true;
    try {
      for (const p of [...this.deps.decisions.values()]) if (p.decision.sessionId === this.info.id) p.resolve(null);
    } finally {
      this.dropping = false;
    }
  }
  private dropping = false;

  archive(): void {
    this.dispose();
    this.update({ archived: true });
  }

  dispose(): void {
    if (!this.proc) return;
    this.disposing = true;
    this.proc.kill();
  }

  private flushAgentText(): void {
    if (!this.agentText.trim()) return;
    this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "agent", text: this.agentText.trim(), at: Date.now() } });
    this.agentText = "";
  }

  requestDecision(decision: Omit<Decision, "id" | "sessionId" | "createdAt">): Promise<string | null> {
    const d: Decision = { ...decision, id: randomUUID(), sessionId: this.info.id, createdAt: Date.now() };
    const prev = this.info.status;
    this.setStatus("needs_you");
    this.store.emit({ type: "decision.requested", decision: d });
    return new Promise((resolve) => {
      this.deps.decisions.set(d.id, {
        decision: d,
        resolve: (optionId) => {
          this.deps.decisions.delete(d.id);
          this.store.emit({ type: "decision.resolved", decisionId: d.id, sessionId: this.info.id, optionId });
          const stillWaiting = [...this.deps.decisions.values()].some((p) => p.decision.sessionId === this.info.id);
          if (!stillWaiting && !this.dropping && this.info.status === "needs_you") this.setStatus(prev === "idle" ? "idle" : "working");
          resolve(optionId);
        },
      });
    });
  }

  private client(): acp.Client {
    return {
      requestPermission: async (params) => {
        const title = params.toolCall.title ?? this.tools.get(params.toolCall.toolCallId)?.title ?? "";
        // Our own reporting tools never need the developer.
        if (OWN_TOOL.test(title) || this.tools.get(params.toolCall.toolCallId)?.own) {
          const allow = params.options.find((o) => o.kind === "allow_always") ?? params.options.find((o) => o.kind === "allow_once");
          if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
        }
        const raw = params.toolCall.rawInput as Record<string, unknown> | undefined;
        const detail = typeof raw?.command === "string" ? raw.command : typeof raw?.file_path === "string" ? raw.file_path : undefined;
        const optionId = await this.requestDecision({
          source: "permission",
          question: title || "Allow this action?",
          detail: detail && detail !== title ? detail : undefined,
          options: params.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
        });
        return optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } };
      },
      sessionUpdate: async ({ update }) => {
        if (DEBUG) console.error(`[acp ${this.info.id.slice(0, 6)}]`, JSON.stringify(update).slice(0, 300));
        if (this.replaying) return;
        const at = Date.now();
        const id = this.info.id;
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            if (update.content.type === "text") this.agentText += update.content.text;
            break;
          case "tool_call": {
            this.proofs.onToolCall(update);
            this.flushAgentText();
            const name = toolName(update) ?? update.title;
            const own = OWN_TOOL.test(name) || OWN_TOOL.test(update.title);
            // Our own report tools and Claude's ToolSearch (deferred-tool loading) are plumbing, not work.
            const hidden = own || INTERNAL_TOOLS.has(name);
            this.tools.set(update.toolCallId, { title: update.title, kind: update.kind, status: update.status ?? "pending", own, hidden });
            if (hidden) break;
            this.store.emit({
              type: "session.transcript",
              sessionId: id,
              item: { kind: "tool", toolCallId: update.toolCallId, title: update.title, status: update.status ?? "pending", toolKind: update.kind, at },
            });
            break;
          }
          case "tool_call_update": {
            this.proofs.onToolUpdate(update);
            const known = this.tools.get(update.toolCallId);
            // Once a call is closed (by the agent, or by us on cancel) later updates can't reopen or re-close it.
            if (known && isTerminal(known.status)) break;
            if (update.title && known && !known.hidden) known.title = update.title;
            if (update.status && known) known.status = update.status;
            if (known?.hidden) break;
            // An update for a call we never saw (e.g. from before a reattach): without a title it would
            // blank the transcript entry, and it may be one of our own tools.
            if (!known && (!update.title || OWN_TOOL.test(update.title) || OWN_TOOL.test(toolName(update) ?? ""))) break;
            if (update.status === "completed" || update.status === "failed" || (update.title && known)) {
              this.store.emit({
                type: "session.transcript",
                sessionId: id,
                item: {
                  kind: "tool",
                  toolCallId: update.toolCallId,
                  title: update.title || known?.title || "",
                  status: update.status ?? known?.status ?? "in_progress",
                  toolKind: update.kind ?? known?.kind,
                  at,
                },
              });
            }
            const k = update.kind ?? known?.kind;
            if (update.status === "completed" && (k === "edit" || k === "delete" || k === "move" || k === "execute")) this.scheduleChanges();
            break;
          }
          case "current_mode_update":
            this.readConfig({ currentModeId: update.currentModeId });
            break;
          case "config_option_update":
            this.readConfig({ configOptions: update.configOptions });
            break;
          default:
            break;
        }
      },
    };
  }
}

export async function prepareWorkspace(project: string, home: string, title: string, id: string, worktree: boolean) {
  if (!(await git.isRepo(project))) return { cwd: project, branch: undefined, baseSha: undefined, worktree: false };
  if (worktree) {
    const wt = await git.createWorktree(project, home, title, id);
    return { cwd: wt.path, branch: wt.branch, baseSha: await git.head(wt.path), worktree: true };
  }
  return { cwd: project, branch: await git.currentBranch(project), baseSha: await git.head(project), worktree: false };
}
