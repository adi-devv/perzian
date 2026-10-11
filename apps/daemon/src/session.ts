import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildPrompt, refOf, type Attachments } from "./attachments.ts";
import {
  FOLLOWUP_REMINDER,
  MAIN_INSTRUCTIONS,
  knownProjects,
  leadProjectsBrief,
  REPORT_INSTRUCTIONS,
  type AgentConfig,
  type AttachmentInfo,
  type AgentKind,
  type Decision,
  type GitState,
  type PauseInfo,
  type PermissionMode,
  type SessionInfo,
  type SessionStatus,
} from "@perzian/protocol";
import type { EventStore } from "./store.ts";
import * as git from "./git.ts";
import { fixCiPrompt, toPrStatus, updateBasePrompt, type PrView } from "./prstatus.ts";
import { symbolChanges } from "./symbols.ts";
import { ProofTracker, derivedStatus, mergeProofs } from "./proof.ts";
import { existsSync } from "node:fs";
import { adapterEntry, agentEnv } from "./agents.ts";
import type { Credentials } from "./credentials.ts";
import { permissionDetail, permissionPolicy } from "./permissions.ts";
import { ToolObserver, isWriteCall, outsideOf, parentToolCallId, pathInside, touchedPaths } from "./observe.ts";
import { UsageMeter } from "./usage.ts";
import { SetupGate, readyWorktree } from "./setup.ts";
import { MAX_FIX_ATTEMPTS, declaredBrief, declaredProofs, fixPrompt, runDeclaredChecks } from "./checks.ts";
import { checkPlan, clearsInterrupted, type CheckResult, type CheckRun, type DeclaredCheck, type PerzianEvent } from "@perzian/protocol";
import { hitFromReading, limitFromError, parseLimitText, pauseThreshold, readRateLimit, resumeTime, type LimitHit, type RateLimitReading } from "./limits.ts";

/** Sent to a session when its usage limit resets. */
export const CONTINUE_PROMPT = "(Perzian: your usage limit has reset. Continue where you left off.)";

/** Claude Code's own commands, sent verbatim even before the agent has listed them. */
const BUILTIN_COMMANDS = new Set(["compact", "clear", "context", "cost", "init", "review", "help"]);

const here = dirname(fileURLToPath(import.meta.url));
const reportMcpEntry = join(here, "../../../packages/report-mcp/src/index.ts");
const tsxCli = join(here, "../../../node_modules/tsx/dist/cli.mjs");
const bundledReportMcp = join(here, "report-mcp.mjs");
// Packaged app: a prebuilt report-mcp next to the bundle (or PERZIAN_REPORT_MCP); dev: run the TS source via tsx.
const reportMcpArgs = (): string[] =>
  process.env.PERZIAN_REPORT_MCP ? [process.env.PERZIAN_REPORT_MCP] : existsSync(bundledReportMcp) ? [bundledReportMcp] : [tsxCli, reportMcpEntry];


// Our permission modes -> candidate mode ids, first one the agent offers wins. For Claude, "edits" and
// "auto" also run in its asking mode and the daemon answers (see permissions.ts): in accept-edits or bypass
// mode Claude doesn't ask before rm -rf or a force push, so the daemon couldn't put a card in front of them.
// Codex has no such mode we can drive yet, so it keeps its own.
const MODE_IDS: Record<PermissionMode, string[]> = {
  ask: ["default", "ask", "read-only"],
  edits: ["default", "auto-edit", "auto"],
  plan: ["plan", "read-only"],
  auto: ["default", "auto-edit", "auto", "full-access"],
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
// Claude loads the developer's and the repo's settings; an allow rule there would answer before the daemon
// ever sees the request. Ask rules beat allow rules, so these send every shell command and edit to us.
const CLAUDE_ASK = { permissions: { ask: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"] } };
// extraDirs go to Claude as additionalDirectories (claude-agent-acp merges _meta.claudeCode.options into the SDK options).
const claudeMeta = (extraDirs?: string[]) => ({ claudeCode: { options: { settings: CLAUDE_ASK, ...(extraDirs?.length ? { additionalDirectories: extraDirs } : {}) } } });
const PR_CHECK_MS = 60_000;
/** The base branch is fetched at most this often to see whether it moved. */
const BASE_FETCH_MS = 120_000;
const isTerminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled";

export interface PendingDecision {
  decision: Decision;
  resolve: (optionId: string | null) => void;
}

export interface SessionDeps {
  store: EventStore;
  daemonUrl: string;
  decisions: Map<string, PendingDecision>;
  /** API keys chosen over a subscription login; absent in tests. */
  creds?: Credentials;
  /** Readies a fresh worktree (tests swap this out). */
  setup?: typeof readyWorktree;
  /** Runs this instead of the agent's ACP adapter (tests use a scripted fake agent). */
  adapter?: { command: string; args: string[] };
  /** Overrides each declared check's timeout, in ms (tests). */
  checkTimeoutMs?: number;
  /** Looks up the branch's pull request (tests swap out gh). */
  prLookup?: (cwd: string, branch?: string) => Promise<PrView | undefined>;
  /** Fetches the base branch from origin (tests swap out git's network). Resolves whether it worked. */
  baseFetch?: (cwd: string, base: string) => Promise<boolean>;
  /** The account-level usage governor (usagecard.ts); without it, nearing a limit pauses nothing. */
  usage?: UsageSignals;
  /** Where uploaded attachments live (tests omit it). */
  attachments?: Attachments;
}

/** An attachment resolved from its id: what the prompt needs (see attachments.ts). */
export type ResolvedAttachment = AttachmentInfo & { path: string };

/** What a session tells the account-level usage governor. */
export interface UsageSignals {
  /** A rate-limit reading past the pause threshold. */
  near(reading: RateLimitReading, sessionId: string): void;
  /** Any rate-limit reading (not only past the threshold): the plan windows' usage shown in the UI. */
  reading?(reading: RateLimitReading): void;
  /** This session was refused at its limit and paused; the others share the account, so they stop too. */
  refused(sessionId: string, hit: LimitHit): void;
}

// One agent session = one adapter process + one ACP connection. Can be dormant (restored from the log)
// and is re-attached on the next prompt.
export class AgentSession {
  private proc?: ChildProcess;
  private stderrTail = ""; // last lines the adapter (and the agent CLI under it) wrote to stderr
  private conn?: acp.ClientSideConnection;
  private starting?: Promise<void>;
  private agentText = "";
  private tools = new Map<string, { title: string; kind?: string; status: string; own: boolean; hidden: boolean; parent?: string; path?: string }>();
  // Observed facts (see observe.ts): outside paths, subagents, background processes; and the repo's state.
  private observer: ToolObserver;
  private startBranch?: string; // the branch the base was cut from; the base is recomputed against it
  private repoRunning?: Promise<void>;
  private repoAgain = false;
  private repoDirty = false;
  private lastPrCheck = 0;
  private lastBaseFetch = 0;
  private prTimer?: ReturnType<typeof setInterval>;
  private inflight = 0;
  private outcomeThisTurn = false;
  // Verification commands the agent actually ran this turn, with real exit codes.
  readonly proofs = new ProofTracker();
  private meter?: UsageMeter;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private modelOptionId?: string;
  private availableModes: string[] = [];
  private turn = 0;
  // The "Known projects" brief as the lead last saw it: sent again when the list changes.
  private briefSent?: string;
  private lastChanges?: string;
  private disposing = false;
  private turnBaseline?: string;
  // Prompts wait here while a fresh worktree is being set up (see runSetup).
  private gate = new SetupGate();
  private settingUp = false;
  // Declared checks: fix rounds sent back to the agent for the current task, whether this turn is one,
  // and the run in progress (aborted on cancel).
  private fixAttempts = 0;
  private fixTurn = false;
  private checksAbort?: AbortController;
  private downgraded?: number; // createdAt of the outcome our failing checks turned from success to partial
  // Usage limits (see limits.ts): hit this turn, so it ends Paused instead of Failed; or nearly hit, so it
  // stops after the current step. `turnText` is the agent's last words this turn, where Claude puts its
  // "You've hit your limit" message.
  private limitHit?: LimitHit;
  private pauseAfterStep?: LimitHit;
  private stoppingForLimit = false;
  /** The stop in progress is for a limit another session hit (not a warning): the pause isn't "early". */
  private stopIsHard = false;
  private turnText = "";
  /** "Resume now" on an early pause: don't pause early again before this time. */
  private nearLimitOkUntil = 0;

  constructor(public info: SessionInfo, private deps: SessionDeps) {
    // A restored session starts from what the log already has, so reattaching doesn't re-emit it.
    const st = deps.store.state();
    const config = st.configs[info.id];
    if (config) this.config = config;
    const files = st.changes[info.id];
    if (files) this.lastChanges = JSON.stringify(files);
    this.startBranch = info.baseBranch ?? info.branch;
    this.observer = new ToolObserver(info.cwd, () => this.roots(), info);
    if (info.git?.pr?.state === "open" && !info.archived) this.watchPr(true); // restored with its PR still open
  }

  /** The folders edits are expected in: the session's own and its extra ones. */
  roots(): string[] {
    return [this.info.cwd, ...(this.info.extraDirs ?? [])];
  }

  static create(
    opts: { project: string; cwd: string; title: string; agent: AgentKind; model?: string; mode?: PermissionMode; role?: "main" | "worker"; parentId?: string; branch?: string; worktree?: boolean; baseSha?: string; baseBranch?: string; id?: string; checks?: string[]; declaredChecks?: DeclaredCheck[]; declaredSetup?: DeclaredCheck[]; checksError?: string; extraDirs?: string[] },
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
      ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
      agent: opts.agent,
      model: opts.model || undefined,
      mode: opts.mode ?? "ask",
      ...(opts.checks?.length ? { checks: opts.checks } : {}),
      ...(opts.declaredChecks?.length ? { declaredChecks: opts.declaredChecks } : {}),
      ...(opts.declaredSetup?.length ? { declaredSetup: opts.declaredSetup } : {}),
      ...(opts.checksError ? { checksError: opts.checksError } : {}),
      ...(opts.extraDirs?.length ? { extraDirs: opts.extraDirs } : {}),
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
    this.emitInfo({ type: "session.updated", sessionId: this.info.id, patch });
  }

  setStatus(status: SessionStatus): void {
    if (this.info.status === status) return;
    this.info.status = status;
    this.info.updatedAt = Date.now();
    this.emitInfo({ type: "session.status", sessionId: this.info.id, status, at: this.info.updatedAt });
  }

  // Keeps `info` in step with the fold, which drops `interrupted` once the session runs again.
  private emitInfo(e: PerzianEvent): void {
    this.store.emit(e);
    if (clearsInterrupted(e)) delete this.info.interrupted;
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
    // The user's installed agent CLI when there is one, else the binary bundled with the adapter. Tests swap in
    // a scripted fake agent (deps.adapter, or PERZIAN_TEST_ADAPTER).
    const fake = process.env.PERZIAN_TEST_ADAPTER;
    const override = this.deps.adapter ?? (fake ? { command: process.execPath, args: [fake] } : undefined);
    const agent = override ? undefined : agentEnv(this.info.agent);
    if (agent) console.log(`[${this.info.id.slice(0, 6)}] ${this.info.agent} executable (${agent.resolved.source}): ${agent.resolved.path}`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...agent?.env, ...this.deps.creds?.envFor(this.info.agent) };
    if (this.info.agent === "claude-code" && this.info.model) env.ANTHROPIC_MODEL = this.info.model;
    this.meter ??= new UsageMeter(this.info.usage);
    this.meter.restart();
    const proc = override
      ? spawn(override.command, override.args, { cwd: this.info.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(process.execPath, [adapterEntry(this.info.agent)], { cwd: this.info.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
    this.canImage = !!init.agentCapabilities?.promptCapabilities?.image;
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

    const meta = this.info.agent === "claude-code" ? { _meta: claudeMeta(this.info.extraDirs) } : {};
    let res: acp.NewSessionResponse | acp.LoadSessionResponse | undefined;
    if (this.info.acpSessionId && init.agentCapabilities?.loadSession) {
      // Replay is suppressed: we already have the transcript in our log.
      this.replaying = true;
      try {
        res = await Promise.race([died, conn.loadSession({ sessionId: this.info.acpSessionId, cwd: this.info.cwd, mcpServers, ...meta })]);
        this.turn = 1; // the preamble is already part of the restored conversation
        // Worth a line in a worker's transcript; in Perzian's own chat it is noise after every restart.
        if (this.info.role !== "main") this.notice("Reattached to the previous conversation");
      } catch (err) {
        if (DEBUG) console.error(`[${this.info.id.slice(0, 6)}] loadSession failed`, err);
      } finally {
        this.replaying = false;
        this.agentText = "";
      }
    }
    if (!res) {
      if (this.info.acpSessionId) this.notice("Previous conversation could not be restored; starting fresh");
      const created = await Promise.race([died, conn.newSession({ cwd: this.info.cwd, mcpServers, ...meta })]);
      res = created;
      this.turn = 0;
      this.meter?.restart(false); // a new conversation's cost can't include what we already counted
      this.update({ acpSessionId: created.sessionId });
    }
    this.conn = conn;
    this.update({ live: true });
    this.readConfig(res);
    if (this.info.mode) await this.applyMode(this.info.mode).catch((e) => this.notice(`Could not set mode: ${(e as Error).message ?? e}`));
    if (this.info.model) await this.applyModel(this.info.model).catch((e) => this.notice(`Could not set model: ${(e as Error).message ?? e}`));
  }

  private canImage = false;
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
    // The lead never edits, so it has nothing to auto-accept; in those modes the agent wouldn't ask and
    // the daemon couldn't block its edits.
    if (this.info.role === "main" && (mode === "edits" || mode === "auto")) {
      this.notice("The lead always runs in Ask mode: it delegates edits to sessions");
      mode = "ask";
    }
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

  /**
   * `system`: sent by the daemon, not typed by the developer (marked in the transcript). `resend`: the text
   * is already in the transcript (the first prompt, held back by a setup that didn't finish).
   * `checkFix`: the daemon sending failed declared checks back; any other prompt starts a new task, so
   * the fix-attempt count starts over.
   */
  async prompt(text: string, opts: { system?: boolean; resend?: boolean; checkFix?: boolean; attachments?: ResolvedAttachment[] } = {}): Promise<void> {
    // Writing to a paused session resumes it now (the scheduled resume is dropped).
    this.clearPause("prompt");
    if (!opts.resend) this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "user", text, at: Date.now(), ...(opts.system ? { system: true as const } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments.map(refOf) } : {}) } });
    // A prompt sent while a turn is running is queued by the agent; the session stays "working" until
    // the last one returns.
    const first = this.inflight++ === 0;
    if (first) {
      this.outcomeThisTurn = false;
      this.proofs.reset();
      this.fixTurn = !!opts.checkFix;
      this.limitHit = undefined;
      this.pauseAfterStep = undefined;
      this.stoppingForLimit = false;
      this.stopIsHard = false;
      this.turnText = "";
    }
    if (!opts.checkFix) this.fixAttempts = 0;
    this.setStatus("working");
    let next: string | undefined;
    try {
      if (!(await this.setupDone())) {
        // Cancelled while the worktree was still being set up.
        if (this.inflight === 1) this.setStatus("idle");
        return;
      }
      await this.ensureStarted();
      if (!this.conn || !this.info.acpSessionId) throw new Error("session not started");
      if (first) this.turnBaseline = this.info.baseSha ? JSON.stringify(await git.changes(this.info.cwd, this.info.baseSha).catch(() => [])) : undefined;
      // A slash command goes to the agent as typed: the report preamble would turn "/compact" into plain text.
      const slash = /^\/([\w:-]+)(\s|$)/.exec(text.trimStart());
      const isCommand = !!slash && (BUILTIN_COMMANDS.has(slash[1]) || !!this.info.commands?.some((c) => c.name === slash[1]));
      const body = isCommand ? text.trimStart() : this.promptBody(text, this.turn++ === 0);
      const res = await this.conn.prompt({ sessionId: this.info.acpSessionId, prompt: buildPrompt(body, opts.attachments ?? [], this.canImage) });
      // /clear wipes the agent's context, preamble included: the next normal prompt brings it back.
      // (/compact keeps a summary of the conversation, so the preamble survives it.)
      if (isCommand && slash?.[1] === "clear" && res.stopReason === "end_turn") {
        this.turn = 0;
        this.briefSent = undefined;
      }
      this.flushAgentText();
      // Close the cancelled turn's tools now, even if a newer prompt is already queued behind it;
      // otherwise that prompt's end_turn would close them as "completed".
      if (res.stopReason === "cancelled") this.closeOpenTools("cancelled");
      if (this.inflight === 1) next = await this.finishTurn(text, res.stopReason);
    } catch (err) {
      this.flushAgentText();
      // A usage limit isn't a failure: pause, and resume when it resets.
      const now = Date.now();
      const said = limitFromError(err, { now }) ?? parseLimitText(this.turnText, { now, strict: true });
      const hit = this.mergeHit(said);
      if (hit) this.limitHit = hit;
      else this.notice(this.describeError(err));
      if (this.inflight === 1) {
        this.dropDecisions();
        this.closeOpenTools(hit ? "cancelled" : "failed");
        if (hit) {
          await this.refreshRepo();
          await this.refreshChanges();
          this.pause(hit);
        } else this.setStatus("failed");
      }
    } finally {
      this.inflight--;
    }
    // Failed declared checks go back to the agent as its next message; the session stays working.
    if (next) await this.prompt(next, { system: true, checkFix: true });
  }

  // True once the worktree is ready (or the developer chose to start anyway); false if the prompt was
  // cancelled while waiting.
  private async setupDone(): Promise<boolean> {
    const st = this.info.setup?.state;
    if (!st || st === "ok" || st === "skipped") return true;
    if (st === "failed") this.setStatus("failed"); // still blocked: the failure stays in front of the developer
    return this.gate.wait();
  }

  /**
   * Readies a fresh worktree before the agent's first message: copies local-only files from the checkout
   * and installs dependencies (setup.ts). Prompts wait for it; on failure the session shows failed until
   * the developer picks Retry or Start anyway.
   */
  runSetup(): Promise<void> {
    if (this.settingUp) return Promise.resolve();
    this.settingUp = true;
    this.update({ setup: { state: "running", copied: [], install: [], at: Date.now() } });
    if (this.gate.waiting) this.setStatus("working");
    const run = this.deps.setup ?? readyWorktree;
    return run(this.info.project, this.info.cwd, { steps: this.info.declaredSetup, onUpdate: (setup) => this.info.setup?.state === "running" && this.update({ setup }) })
      .catch((e): NonNullable<SessionInfo["setup"]> => ({ state: "failed", copied: [], install: [], error: { command: "setup", tail: String((e as Error).message ?? e) }, at: Date.now() }))
      .then((setup) => {
        this.settingUp = false;
        if (this.info.setup?.state === "skipped") return; // the developer started anyway meanwhile
        this.update({ setup });
        if (setup.state === "ok") this.gate.open();
        else if (this.gate.waiting) this.setStatus("failed");
      });
  }

  /** After a failed setup: run it again. A first prompt nothing is holding any more is sent once it's ready. */
  retrySetup(): Promise<void> {
    if (this.settingUp || this.info.setup?.state !== "failed") return Promise.resolve();
    const held = this.heldPrompt();
    const done = this.runSetup();
    if (held !== undefined) void this.prompt(held, { resend: true });
    return done;
  }

  /** After a failed or slow setup: start the agent without it. */
  skipSetup(): void {
    const setup = this.info.setup;
    if (setup?.state !== "failed" && setup?.state !== "running") return;
    const held = this.heldPrompt();
    this.update({ setup: { ...setup, state: "skipped", at: Date.now() } });
    if (this.gate.waiting) this.setStatus("working");
    this.gate.open();
    if (held !== undefined) void this.prompt(held, { resend: true });
  }

  // The first prompt, when no pending prompt holds it and the agent never started: the daemon restarted
  // during setup, or the prompt was cancelled while waiting.
  private heldPrompt(): string | undefined {
    if (this.gate.waiting || this.inflight || this.info.acpSessionId) return undefined;
    const first = this.store.state().transcripts[this.info.id]?.find((t) => t.kind === "user");
    return first?.kind === "user" ? first.text : undefined;
  }

  // What the agent receives: instructions on the first turn, plus for workers the detected checks; a
  // one-line rules reminder on later worker turns, since long sessions drift.
  private promptBody(text: string, first: boolean): string {
    if (this.info.role === "main") {
      const projects = leadProjectsBrief(knownProjects(this.store.state()));
      if (first) {
        this.briefSent = projects;
        return `${MAIN_INSTRUCTIONS}\n\n${projects}\n\n---\n\n${text}`;
      }
      // Projects were added since the lead last saw the list (answering ask_project, a new session): tell it again.
      if (projects !== this.briefSent) {
        this.briefSent = projects;
        return `(The known projects changed.)\n${projects}\n\n---\n\n${text}`;
      }
      return text;
    }
    if (!first) return `${FOLLOWUP_REMINDER}\n\n${text}`;
    const checks = this.info.checks?.length ? `\n\nChecks available: ${this.info.checks.join(", ")}` : "";
    const required = declaredBrief(this.info.declaredChecks);
    return `${REPORT_INSTRUCTIONS}\n\n---\n\n${text}${checks}${required ? `\n${required}` : ""}`;
  }

  // Tool calls the agent never closed (cancelled turn, crash) would spin forever in the UI.
  private closeOpenTools(status: string): void {
    const subagents = this.observer.closeOpen(status);
    if (subagents) this.update(subagents);
    for (const [toolCallId, t] of this.tools) {
      if (t.hidden || isTerminal(t.status)) continue;
      t.status = status;
      this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "tool", toolCallId, title: t.title, status, toolKind: t.kind, ...(t.parent ? { parentToolCallId: t.parent } : {}), ...(t.path ? { path: t.path } : {}), at: Date.now() } });
    }
  }

  /** Settles a turn. Returns a prompt to send next when declared checks failed and the agent gets another try. */
  private async finishTurn(prompt: string, stopReason: acp.StopReason): Promise<string | undefined> {
    this.dropDecisions();
    this.closeOpenTools(stopReason === "cancelled" ? "cancelled" : "completed");
    await this.refreshRepo();
    const files = await this.refreshChanges();
    // Stopped by a usage limit: the work isn't finished, so no outcome; it picks up when the limit resets.
    // A normal-looking end only counts when the agent's last words are a limit message with a reset time.
    const said = stopReason === "cancelled" ? null : parseLimitText(this.turnText, { now: Date.now(), strict: true });
    const hit = this.limitHit || said?.resetAt !== undefined ? this.mergeHit(said) : undefined;
    const early = !hit && stopReason === "cancelled" && this.stoppingForLimit ? this.pauseAfterStep : undefined;
    if (hit || early) {
      this.pause((hit ?? early)!, !hit && !this.stopIsHard, !hit);
      return;
    }
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
      // A fix round answers the daemon's message, not a new task: keep the task's intent.
      const previous = this.fixTurn ? this.store.state().outcomes[this.info.id] : undefined;
      this.store.emit({
        type: "outcome.reported",
        outcome: {
          sessionId: this.info.id,
          intent: previous?.intent ?? prompt.split("\n")[0].slice(0, 140),
          // No observed check, no success: the declared checks (if any) upgrade it when they pass.
          status: derivedStatus(observed),
          changed: files.map((f) => ({ path: f.path, kind: f.kind })),
          proof: observed,
          risks: previous?.risks ?? [],
          followups: previous?.followups ?? [],
          derived: true,
          createdAt: Date.now(),
        },
      });
    }
    // The agent says it's done: run the repo's declared checks ourselves. A fix round always re-runs them,
    // even when the agent changed nothing, so the loop can't stall.
    const declared = this.info.role === "worker" && stopReason === "end_turn" && !!this.info.declaredChecks?.length;
    if (declared && (changedThisTurn || this.outcomeThisTurn || this.fixTurn)) {
      const verdict = await this.runChecks();
      // A newer prompt arrived while the checks ran; that turn owns the status now.
      if (this.inflight > 1) return undefined;
      if (verdict.next) return verdict.next;
      if (verdict.cancelled) return void this.setStatus("idle");
      if (verdict.gaveUp) return void this.setStatus("failed");
    }
    this.setStatus(stopReason === "cancelled" ? "idle" : stopReason === "refusal" ? "failed" : "done");
    return undefined;
  }

  /** "Run checks": reruns the declared and detected checks on request. No fix rounds; the results are the answer. */
  async rerunChecks(): Promise<void> {
    if (this.checksAbort || this.info.status === "working") return;
    const plan = checkPlan(this.info);
    if (!plan.length) return;
    const publish = (state: CheckRun["state"], results: CheckResult[]) => this.update({ checkRun: { state, attempt: 0, maxAttempts: MAX_FIX_ATTEMPTS, results, at: Date.now() } });
    const abort = new AbortController();
    this.checksAbort = abort;
    publish("running", plan.map((c) => ({ name: c.name, run: c.run, state: "pending" })));
    try {
      const results = await runDeclaredChecks(plan, this.info.cwd, (r) => publish("running", r), { signal: abort.signal, timeoutMs: this.deps.checkTimeoutMs });
      if (abort.signal.aborted) return publish("cancelled", results);
      this.attachCheckProofs(results);
      publish(results.some((r) => r.state === "failed") ? "failed" : "passed", results);
    } finally {
      if (this.checksAbort === abort) this.checksAbort = undefined;
    }
  }

  /** Runs the declared checks in the session's worktree and decides what follows. */
  private async runChecks(): Promise<{ next?: string; gaveUp?: boolean; cancelled?: boolean }> {
    const checks = this.info.declaredChecks ?? [];
    const publish = (state: CheckRun["state"], results: CheckResult[], attempt = this.fixAttempts) =>
      this.update({ checkRun: { state, attempt, maxAttempts: MAX_FIX_ATTEMPTS, results, at: Date.now() } });
    const abort = new AbortController();
    this.checksAbort = abort;
    let results: CheckResult[];
    try {
      results = await runDeclaredChecks(checks, this.info.cwd, (r) => publish("running", r), { signal: abort.signal, timeoutMs: this.deps.checkTimeoutMs });
    } finally {
      if (this.checksAbort === abort) this.checksAbort = undefined;
    }
    if (abort.signal.aborted) {
      publish("cancelled", results);
      return { cancelled: true };
    }
    this.attachCheckProofs(results);
    const failed = results.filter((r) => r.state === "failed");
    if (!failed.length) {
      publish("passed", results);
      return {};
    }
    if (this.fixAttempts >= MAX_FIX_ATTEMPTS) {
      publish("failed", results);
      const names = failed.map((r) => r.name).join(", ");
      this.notice(`Checks still failing after ${MAX_FIX_ATTEMPTS} fix attempts: ${names}. Needs you.`);
      return { gaveUp: true };
    }
    this.fixAttempts++;
    publish("fixing", results);
    return { next: fixPrompt(failed, this.fixAttempts, MAX_FIX_ATTEMPTS) };
  }

  // Declared-check results join the session's latest outcome as observed proof, replacing earlier runs.
  private attachCheckProofs(results: CheckResult[]): void {
    const current = this.store.state().outcomes[this.info.id];
    if (!current) return;
    const proofs = declaredProofs(results);
    const names = new Set(proofs.map((p) => p.label));
    const runs = new Set(results.map((r) => r.run));
    const rest = current.proof.filter((p) => !names.has(p.label) && !(p.command && runs.has(p.command.trim())));
    const proof = [...proofs, ...rest];
    let status = current.status;
    if (current.derived) status = derivedStatus(proof);
    else if (status === "success" && proofs.some((p) => !p.passed)) {
      status = "partial";
      this.downgraded = current.createdAt;
    } else if (status === "partial" && this.downgraded === current.createdAt && proof.every((p) => p.passed || !p.observed)) {
      status = "success"; // only our checks made it partial, and they pass now
    }
    if (JSON.stringify(proof) === JSON.stringify(current.proof) && status === current.status) return;
    this.store.emit({ type: "outcome.reported", outcome: { ...current, proof, status } });
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

  /** `repo`: the agent ran a command, so also look at commits, branch, worktrees and PR. */
  private scheduleChanges(repo = false): void {
    if (repo) this.repoDirty = true;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      const withRepo = this.repoDirty;
      this.repoDirty = false;
      void (withRepo ? this.refreshRepo() : Promise.resolve()).then(() => this.refreshChanges());
    }, 600);
  }

  // ---- The repo as the agent left it: branch switches, rebases, commits, pushes, PRs, its own worktrees ----

  /** Runs one refresh at a time; a request that arrives meanwhile runs once more afterwards. */
  refreshRepo(): Promise<void> {
    if (!this.info.baseSha) return Promise.resolve();
    if (this.repoRunning) {
      this.repoAgain = true;
      return this.repoRunning;
    }
    const run = async () => {
      do {
        this.repoAgain = false;
        await this.observeRepo().catch(() => {});
      } while (this.repoAgain);
    };
    this.repoRunning = run().finally(() => (this.repoRunning = undefined));
    return this.repoRunning;
  }

  private async observeRepo(): Promise<void> {
    const cwd = this.info.cwd;
    const patch: Partial<SessionInfo> = {};
    let base = this.info.baseSha!;

    // Branch switch or rebase: the change map must still diff against where the work started.
    const branch = await git.currentBranch(cwd);
    const switched = branch !== undefined && branch !== this.info.branch;
    const ancestor = await git.isAncestor(cwd, base, "HEAD");
    if (switched) patch.branch = branch;
    if ((ancestor === false || (switched && branch !== this.startBranch)) && this.startBranch) {
      const mb = await git.mergeBase(cwd, "HEAD", this.startBranch);
      if (mb && mb !== base) {
        base = mb;
        patch.baseSha = mb;
        this.notice(`Base recomputed after ${switched ? `switching to ${branch}` : "a rebase or reset"}`);
      }
    }

    // Commits, push, PR.
    const ahead = (await git.aheadCount(cwd, base)) ?? 0;
    const up = await git.upstreamState(cwd);
    // What gh and the base fetch reported (prUrl, pr, behind) is kept; they're updated by their own refreshes.
    const { prUrl, pr, behind } = this.info.git ?? {};
    const gitState: GitState = { ahead, pushed: up.upstream && up.unpushed === 0, ...(prUrl ? { prUrl } : {}), ...(pr ? { pr } : {}), ...(behind ? { behind } : {}) };
    if (JSON.stringify(gitState) !== JSON.stringify(this.info.git)) patch.git = gitState;

    // Worktrees the agent made itself: not Perzian's (a session's cwd, the project, perzian/ branches), not another session's.
    const listed = await git.worktrees(cwd);
    const known = new Set<string>([git.realish(cwd), git.realish(this.info.project)]);
    const others = new Set<string>();
    for (const o of Object.values(this.store.state().sessions)) {
      if (o.id === this.info.id) continue;
      known.add(git.realish(o.cwd));
      for (const w of o.extraWorktrees ?? []) others.add(git.realish(w.path));
    }
    const mine = new Set((this.info.extraWorktrees ?? []).map((w) => git.realish(w.path)));
    const extra: NonNullable<SessionInfo["extraWorktrees"]> = [];
    for (const [i, w] of listed.entries()) {
      const real = git.realish(w.path);
      if (i === 0 || w.bare || w.prunable || known.has(real) || others.has(real) || w.branch?.startsWith("perzian/")) continue;
      if (!mine.has(real) && !existsSync(w.path)) continue;
      const changed = await git.changes(w.path, base).then((f) => f.length).catch(() => undefined);
      extra.push({ path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(changed !== undefined ? { changed } : {}) });
    }
    if (JSON.stringify(extra) !== JSON.stringify(this.info.extraWorktrees ?? [])) patch.extraWorktrees = extra;

    if (Object.keys(patch).length) this.update(patch);
    if (branch && (ahead > 0 || gitState.pushed)) void this.refreshPr();
    void this.refreshBehind();
  }

  /**
   * How far the base moved: commits on it this branch lacks. The base is fetched at most every 2 minutes
   * (offline or no origin just means the last known count stays); the count itself is cheap and re-read
   * after every turn, so it drops as soon as the agent has merged the base in.
   */
  private async refreshBehind(): Promise<void> {
    const base = this.info.baseBranch;
    if (!base || !this.info.worktree || this.info.ship?.state === "merged") return;
    if (Date.now() - this.lastBaseFetch >= BASE_FETCH_MS) {
      this.lastBaseFetch = Date.now();
      await (this.deps.baseFetch ?? git.refreshBase)(this.info.cwd, base).catch(() => false);
    }
    const n = (await git.behindBase(this.info.cwd, base).catch(() => undefined)) ?? 0;
    const cur = this.info.git;
    if ((cur?.behind ?? 0) === n || !cur) return;
    const { behind: _, ...rest } = cur;
    this.update({ git: { ...rest, ...(n ? { behind: n } : {}) } });
  }

  /** "Update" on the Base moved line: the agent merges or rebases the base in, and handles any conflicts. */
  async updateBase(): Promise<void> {
    const base = this.info.baseBranch;
    if (!base || !this.info.worktree) throw new Error("This session has no base branch to update from.");
    this.lastBaseFetch = 0; // the count is recomputed fresh when the turn ends
    await this.prompt(updateBasePrompt(base, this.info.git?.behind));
  }

  /** "Ask agent to fix CI": the failing check names, and where to read their logs. */
  async fixCi(): Promise<void> {
    const pr = this.info.git?.pr;
    if (pr?.state !== "open") throw new Error("This session has no open pull request.");
    this.lastPrCheck = 0; // re-read the checks once the agent has pushed
    await this.prompt(fixCiPrompt(pr.failing, pr.url));
  }

  /**
   * The branch's PR, state, checks and review, via gh: at most once a minute, while a PR is open or after
   * the agent pushed. gh missing, signed out, offline or no PR just means nothing changes.
   */
  private async refreshPr(): Promise<void> {
    if (Date.now() - this.lastPrCheck < PR_CHECK_MS) return;
    const known = this.info.git?.pr;
    if (known && known.state !== "open") return; // merged or closed: nothing more will change
    this.lastPrCheck = Date.now();
    const view = await (this.deps.prLookup ?? git.pullRequest)(this.info.cwd, this.info.branch).catch(() => undefined);
    const cur = this.info.git ?? { ahead: 0, pushed: false };
    if (!view) return;
    const pr = toPrStatus(view);
    const { prUrl: _, pr: __, ...rest } = cur;
    const next: GitState = { ...rest, ...(pr.state === "open" ? { prUrl: pr.url } : {}), pr };
    if (JSON.stringify(next) !== JSON.stringify(this.info.git)) this.update({ git: next });
    this.watchPr(pr.state === "open");
  }

  /** While a PR is open, look again every minute, even with the agent idle: CI finishes and reviews land on their own. */
  private watchPr(open: boolean): void {
    if (!open) {
      if (this.prTimer) clearInterval(this.prTimer);
      this.prTimer = undefined;
      return;
    }
    if (this.prTimer) return;
    this.prTimer = setInterval(() => void this.refreshPr(), PR_CHECK_MS);
    this.prTimer.unref();
  }

  // ---- Usage limits ----

  /** The agent's words win for the reason; the structured rate-limit info for the reset time. */
  private mergeHit(said: LimitHit | null): LimitHit | undefined {
    const known = this.limitHit;
    if (!known) return said ?? undefined;
    if (!said) return known;
    return { ...said, ...known, reason: said.reason, ...(said.window && !known.window ? { window: said.window } : {}), ...(known.resetAt === undefined && said.resetAt !== undefined ? { resetAt: said.resetAt } : {}) };
  }

  /** Stop at a usage limit: status "paused" until the limit resets (the resume queue picks it up). */
  pause(hit: LimitHit, early = false, fromOthers = false): void {
    const at = Date.now();
    const { resumeAt, estimated } = resumeTime(hit, at);
    const pause: PauseInfo = { reason: hit.reason, resumeAt, at, ...(estimated ? { estimated } : {}), ...(hit.window ? { window: hit.window } : {}), ...(early ? { early } : {}) };
    this.limitHit = undefined;
    this.pauseAfterStep = undefined;
    this.stoppingForLimit = false;
    this.stopIsHard = false;
    this.info.status = "paused";
    this.info.pause = pause;
    this.info.updatedAt = at;
    this.notice(early ? "Paused near the usage limit, after the current step" : "Paused at the usage limit");
    this.store.emit({ type: "session.paused", sessionId: this.info.id, pause });
    // Refused by the API (not stopped by us): the other sessions share this limit.
    if (!early && !fromOthers && !hit.transient) this.deps.usage?.refused(this.info.id, { ...hit, resumeAt, ...(estimated ? { estimated: true } : {}) });
  }

  /** Leaves "paused" (to idle), without prompting. False when it wasn't paused. */
  private clearPause(reason: "reset" | "now" | "prompt" | "cancel"): boolean {
    if (this.info.status !== "paused") return false;
    const at = Date.now();
    // The developer chose to go on past an early pause: don't stop again at the same threshold.
    if (this.info.pause?.early && reason !== "reset") this.nearLimitOkUntil = this.info.pause.resumeAt;
    delete this.info.pause;
    this.info.status = "idle";
    this.info.updatedAt = at;
    this.store.emit({ type: "session.resumed", sessionId: this.info.id, at, reason });
    return true;
  }

  /** The limit reset ("reset") or the developer pressed Resume now ("now"): continue the same conversation, same worktree. */
  resume(reason: "reset" | "now"): Promise<void> {
    if (!this.clearPause(reason)) return Promise.resolve();
    return this.prompt(CONTINUE_PROMPT, { system: true });
  }

  // Claude's rate-limit info rides on usage_update. Rejected: the limit is hit (the turn is about to fail).
  // Near the threshold: stop after the current step (see maybeStopForLimit). Workers only: the lead's
  // turns are short and it should stay reachable.
  private onRateLimit(info: unknown): void {
    const r = readRateLimit(info, pauseThreshold());
    if (r) this.deps.usage?.reading?.(r);
    if (this.inflight === 0 || !r) return;
    if (r.state === "rejected") this.limitHit ??= hitFromReading(r);
    // Near: the account-level card decides (usagecard.ts); the lead raises it too but is never paused by it.
    else if (r.state === "near" && r.resetAt !== undefined && Date.now() >= this.nearLimitOkUntil) this.deps.usage?.near(r, this.info.id);
  }

  /** Pause after the current step (the usage card said Pause). No-op unless working. */
  pauseAfterCurrentStep(hit: LimitHit): void {
    if (this.info.status !== "working" || this.pauseAfterStep) return;
    this.pauseAfterStep = hit;
    this.notice(`${hit.reason}: pausing after the current step`);
    this.maybeStopForLimit();
  }

  /** Another session hit the shared limit: stop this turn now and pause with the same resume time. */
  pauseForSharedLimit(hit: LimitHit): void {
    if (this.info.status !== "working" || this.stoppingForLimit || !this.conn || !this.info.acpSessionId) return;
    this.pauseAfterStep = hit;
    this.stoppingForLimit = true;
    this.stopIsHard = true;
    void this.conn.cancel({ sessionId: this.info.acpSessionId }).catch(() => {});
  }

  // A step is a tool call. Once the one running finishes (and nothing else is open or waiting on the
  // developer), cancel the turn; finishTurn then pauses instead of going idle.
  private maybeStopForLimit(): void {
    if (!this.pauseAfterStep || this.stoppingForLimit || !this.conn || !this.info.acpSessionId) return;
    if (this.info.status !== "working") return;
    for (const t of this.tools.values()) if (!isTerminal(t.status)) return;
    this.stoppingForLimit = true;
    void this.conn.cancel({ sessionId: this.info.acpSessionId }).catch(() => {});
  }

  async cancel(): Promise<void> {
    this.gate.cancel(); // prompts still waiting on setup
    this.pauseAfterStep = undefined;
    this.stoppingForLimit = false;
    if (this.clearPause("cancel")) return; // paused: nothing is running
    this.dropDecisions();
    // Everything still running belongs to the turn being cancelled; a late "completed" from the agent
    // won't reopen it (terminal tool states are sticky, see tool_call_update).
    this.closeOpenTools("cancelled");
    this.checksAbort?.abort(); // Stop while the daemon runs the declared checks: kill them, no fix round
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

  setShip(ship: SessionInfo["ship"]): void {
    this.update(ship?.state === "merged" ? { ship, live: false } : { ship });
    // A PR was just opened: read its state and checks now instead of waiting for the next turn.
    if (ship?.state === "pr") {
      this.lastPrCheck = 0;
      void this.refreshPr();
    }
  }

  archive(): void {
    this.dispose();
    this.update({ archived: true });
  }

  dispose(): void {
    this.watchPr(false);
    if (!this.proc) return;
    this.disposing = true;
    this.proc.kill();
  }

  private observeTool(update: Parameters<ToolObserver["onTool"]>[0]): void {
    const patch = this.observer.onTool(update);
    if (patch) this.update(patch);
  }

  private flushAgentText(): void {
    if (!this.agentText.trim()) return;
    this.turnText = this.agentText.trim();
    this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "agent", text: this.agentText.trim(), at: Date.now() } });
    this.agentText = "";
  }

  requestDecision(decision: Omit<Decision, "id" | "sessionId" | "createdAt">): Promise<string | null> {
    const d: Decision = { ...decision, id: randomUUID(), sessionId: this.info.id, createdAt: Date.now() };
    const prev = this.info.status;
    this.setStatus("needs_you");
    this.store.emit({ type: "decision.requested", decision: d });
    return new Promise((resolve) => {
      let settled = false;
      this.deps.decisions.set(d.id, {
        decision: d,
        resolve: (optionId) => {
          // Once only: a late second answer (or a drop racing an answer) must not resolve it again.
          if (settled) return;
          settled = true;
          this.deps.decisions.delete(d.id);
          this.store.emit({ type: "decision.resolved", decisionId: d.id, sessionId: this.info.id, optionId });
          // What was chosen stays in the transcript as one line.
          const answer = optionId === null ? null : (d.options.find((o) => o.id === optionId)?.label ?? optionId);
          this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "decision", decisionId: d.id, source: d.source, question: d.question, ...(d.detail ? { detail: d.detail } : {}), answer, at: Date.now() } });
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
        const known = this.tools.get(params.toolCall.toolCallId);
        const title = params.toolCall.title ?? known?.title ?? "";
        const raw = params.toolCall.rawInput as Record<string, unknown> | undefined;
        const kind = params.toolCall.kind ?? known?.kind;
        const command = typeof raw?.command === "string" ? raw.command : undefined;
        const outside = isWriteCall(kind, toolName(params.toolCall)) ? outsideOf(touchedPaths(params.toolCall, this.info.cwd), this.roots()) : [];
        const verdict = permissionPolicy({
          role: this.info.role,
          mode: this.info.mode,
          toolKind: kind ?? undefined,
          command,
          title,
          // A shell command's title is the command itself, so `perzian_x` there is not our tool.
          own: kind !== "execute" && command === undefined && (OWN_TOOL.test(title) || OWN_TOOL.test(toolName(params.toolCall) ?? "") || !!known?.own),
          declared: this.info.declaredChecks?.map((c) => c.run),
          outside,
        });
        const pick = (...kinds: acp.PermissionOptionKind[]) => kinds.map((k) => params.options.find((o) => o.kind === k)).find(Boolean);
        if (DEBUG) console.error(`[perm ${this.info.id.slice(0, 6)}] ${kind} ${JSON.stringify(command ?? title).slice(0, 120)} -> ${JSON.stringify(verdict)}`);
        if (verdict.action === "allow") {
          // Our own tools may be remembered; anything else is allowed once, so no standing rule is written.
          const allow = verdict.why === "own" ? pick("allow_always", "allow_once") : pick("allow_once");
          if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
        } else if (verdict.action === "deny") {
          this.notice(`Blocked: the lead doesn't ${verdict.why === "lead-edit" ? "edit files" : "run commands"} (${(command ?? title).slice(0, 80)})`);
          const reject = pick("reject_once", "reject_always");
          return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
        }
        const destructive = verdict.action === "ask" ? verdict.destructive : undefined;
        const detail = permissionDetail({ title, command, outside, filePath: typeof raw?.file_path === "string" ? raw.file_path : undefined, cwd: this.info.cwd });
        // A destructive command is allowed once at most: an "always" rule would let the next one through unasked.
        const options = params.options.filter((o) => !destructive || o.kind !== "allow_always");
        const optionId = await this.requestDecision({
          source: "permission",
          question: title || "Allow this action?",
          detail,
          options: options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
          ...(destructive ? { destructive } : {}),
          ...(outside.length ? { outside } : {}),
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
            const parent = parentToolCallId(update);
            const path = pathInside(update, this.info.cwd);
            this.tools.set(update.toolCallId, { title: update.title, kind: update.kind, status: update.status ?? "pending", own, hidden, ...(parent ? { parent } : {}), ...(path ? { path } : {}) });
            if (hidden) break;
            this.observeTool(update);
            this.store.emit({
              type: "session.transcript",
              sessionId: id,
              item: { kind: "tool", toolCallId: update.toolCallId, title: update.title, status: update.status ?? "pending", toolKind: update.kind, ...(parent ? { parentToolCallId: parent } : {}), ...(path ? { path } : {}), at },
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
            const path = pathInside(update, this.info.cwd) ?? known?.path;
            if (path && known) known.path = path;
            // Deferred: the stop goes out after this update is handled.
            if (update.status && isTerminal(update.status) && this.pauseAfterStep) queueMicrotask(() => this.maybeStopForLimit());
            if (known?.hidden) break;
            if (known || (update.title && !OWN_TOOL.test(update.title))) this.observeTool(update);
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
                  ...((parentToolCallId(update) ?? known?.parent) ? { parentToolCallId: parentToolCallId(update) ?? known?.parent } : {}),
                  ...(path ? { path } : {}),
                  at,
                },
              });
            }
            const k = update.kind ?? known?.kind;
            const done = update.status === "completed" || update.status === "failed";
            if (update.status === "completed" && (k === "edit" || k === "delete" || k === "move" || k === "execute")) this.scheduleChanges(k === "execute");
            // A command that failed may still have committed or switched branches; Claude's worktree tools aren't commands.
            else if (done && (k === "execute" || /worktree/i.test(toolName(update) ?? ""))) this.scheduleChanges(true);
            break;
          }
          case "current_mode_update":
            this.readConfig({ currentModeId: update.currentModeId });
            break;
          case "config_option_update":
            this.readConfig({ configOptions: update.configOptions });
            break;
          case "available_commands_update": {
            const commands = update.availableCommands.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.input && "hint" in c.input && c.input.hint ? { hint: c.input.hint } : {}) }));
            if (JSON.stringify(commands) !== JSON.stringify(this.info.commands ?? [])) this.update({ commands });
            break;
          }
          case "usage_update": {
            const usage = this.meter?.read(update);
            if (usage) this.update({ usage });
            this.onRateLimit((update._meta as Record<string, unknown> | null | undefined)?.["_claude/rateLimit"]);
            break;
          }
          default:
            break;
        }
      },
    };
  }
}

/**
 * Where a session works. Every task in a git repo gets its own worktree unless the caller says
 * `worktree: false`, so its work lands as a branch that can be merged or opened as a PR, never as
 * uncommitted edits on the developer's branch. `base` (default: the repo's default branch) is fetched
 * from origin and the worktree is cut from it.
 */
export async function prepareWorkspace(project: string, home: string, title: string, id: string, worktree?: boolean, base?: string) {
  if (!(await git.isRepo(project))) {
    if (base) throw new Error(`${project} isn't a git repo, so it can't start from ${base}.`);
    return { cwd: project, branch: undefined, baseSha: undefined, worktree: false };
  }
  if (worktree !== false) {
    const wt = await git.createWorktree(project, home, title, id, { base });
    return { cwd: wt.path, branch: wt.branch, baseSha: wt.baseSha, worktree: true, baseBranch: wt.baseBranch, notice: wt.notice };
  }
  return { cwd: project, branch: await git.currentBranch(project), baseSha: await git.head(project), worktree: false };
}
