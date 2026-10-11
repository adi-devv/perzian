// Shared types between the daemon and the UI. All UI state is a fold over PerzianEvent (see fold.ts).

export type SessionStatus = "idle" | "working" | "needs_you" | "done" | "failed";
export type AgentKind = "claude-code" | "codex";
export type SessionRole = "main" | "worker";

// Permission modes, from most to least supervised. Mapped to each agent's own mode ids.
export type PermissionMode = "ask" | "edits" | "plan" | "auto";

export interface SessionInfo {
  id: string;
  role: SessionRole;
  parentId?: string; // set when the main agent spawned it
  title: string;
  project: string; // absolute repo path
  cwd: string; // worktree path or project path
  branch?: string;
  worktree?: boolean;
  baseSha?: string; // HEAD when the session started; change maps diff against this
  agent: AgentKind;
  model?: string;
  mode?: PermissionMode;
  status: SessionStatus;
  progress?: Progress;
  live?: boolean; // adapter process attached
  acpSessionId?: string;
  archived?: boolean;
  seenAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Progress {
  phase: string;
  step: number;
  of: number;
  note?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  tradeoff?: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "choice";
}

export interface Decision {
  id: string;
  sessionId: string;
  source: "permission" | "ask_decision";
  question: string;
  detail?: string;
  options: DecisionOption[];
  recommended?: string;
  createdAt: number;
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  /** Changed declarations in this file (from tree-sitter + diff hunks). Absent = language not analyzed. */
  symbols?: SymbolChange[];
}

/** A declaration that changed between base and the working tree. `name` is qualified for members ("Class.method"). */
export interface SymbolChange {
  name: string;
  kind: "function" | "class" | "method" | "type" | "interface" | "variable" | "component";
  change: "added" | "modified" | "deleted";
  /** 1-based start line: in the new file, or in the base file when deleted. */
  line: number;
}

export interface Proof {
  kind: "tests" | "build" | "typecheck" | "lint" | "screenshot" | "command" | "manual";
  label: string;
  passed: boolean;
  detail?: string;
  // Set when the daemon watched the command run (vs. the agent's own claim).
  observed?: boolean;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary?: string; // e.g. "45 passed", "3 failed, 42 passed", "2 errors"
}

export interface Outcome {
  sessionId: string;
  intent: string;
  status: "success" | "partial" | "failed";
  changed: { path: string; kind: ChangeKind }[];
  proof: Proof[];
  risks: string[];
  followups: string[];
  derived?: boolean; // built by the daemon because the agent didn't report one
  createdAt: number;
}

export interface AgentConfig {
  models: { value: string; name: string }[];
  currentModel?: string;
  modes: { id: string; name: string }[];
  currentMode?: string;
}

export type TranscriptItem =
  | { kind: "user"; text: string; at: number }
  | { kind: "agent"; text: string; at: number }
  | { kind: "tool"; toolCallId: string; title: string; status: string; toolKind?: string; at: number }
  | { kind: "spawn"; childId: string; title: string; at: number }
  | { kind: "notice"; text: string; at: number };

export type PerzianEvent =
  | { type: "session.created"; session: SessionInfo }
  | { type: "session.updated"; sessionId: string; patch: Partial<Omit<SessionInfo, "id" | "status">> }
  | { type: "session.status"; sessionId: string; status: SessionStatus; at: number }
  | { type: "session.progress"; sessionId: string; progress: Progress }
  | { type: "session.transcript"; sessionId: string; item: TranscriptItem }
  | { type: "session.config"; sessionId: string; config: AgentConfig }
  | { type: "session.changes"; sessionId: string; files: FileChange[]; at: number }
  | { type: "decision.requested"; decision: Decision }
  | { type: "decision.resolved"; decisionId: string; sessionId: string; optionId: string | null }
  | { type: "outcome.reported"; outcome: Outcome };

export interface CreateSessionArgs {
  project: string;
  prompt: string;
  title?: string;
  agent?: AgentKind;
  model?: string;
  mode?: PermissionMode;
  worktree?: boolean;
}

// UI -> daemon
export type Command =
  | ({ type: "session.create" } & CreateSessionArgs)
  | { type: "session.prompt"; sessionId: string; prompt: string }
  | { type: "session.cancel"; sessionId: string }
  | { type: "session.setModel"; sessionId: string; model: string }
  | { type: "session.setMode"; sessionId: string; mode: PermissionMode }
  | { type: "session.seen"; sessionId: string }
  | { type: "session.archive"; sessionId: string }
  | { type: "main.start"; model?: string; agent?: AgentKind; prompt?: string }
  | { type: "sessions.import"; sinceDays?: number; limit?: number }
  | { type: "decision.answer"; decisionId: string; optionId: string | null };

// daemon -> UI envelope
export type ServerMessage =
  | { type: "snapshot"; events: PerzianEvent[] }
  | { type: "event"; event: PerzianEvent }
  | { type: "error"; message: string };

// report-mcp -> daemon (HTTP POST /report)
export type ReportCall =
  | { tool: "report_progress"; sessionId: string; args: Progress }
  | { tool: "ask_decision"; sessionId: string; args: { question: string; options: { id: string; label: string; tradeoff?: string }[]; recommended?: string } }
  | { tool: "report_outcome"; sessionId: string; args: Omit<Outcome, "sessionId" | "createdAt" | "derived"> }
  | { tool: "list_sessions"; sessionId: string; args: Record<string, never> }
  | { tool: "spawn_session"; sessionId: string; args: CreateSessionArgs }
  | { tool: "send_to_session"; sessionId: string; args: { id: string; prompt: string } }
  | { tool: "get_session"; sessionId: string; args: { id: string } };

export const DAEMON_PORT = 4317;

export const AGENTS: Record<AgentKind, { label: string; models: { id: string; label: string }[] }> = {
  "claude-code": {
    label: "Claude",
    models: [
      { id: "", label: "Default" },
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5" },
      { id: "claude-fable-5-1", label: "Fable 5.1" },
    ],
  },
  codex: { label: "Codex", models: [{ id: "", label: "Default" }] },
};

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "Ask me",
  edits: "Auto-accept edits",
  plan: "Plan only",
  auto: "Full auto",
};

// Attention ordering: what needs the dev first.
const STATUS_RANK: Record<SessionStatus, number> = { needs_you: 0, failed: 1, done: 2, working: 3, idle: 4 };
export function byAttention(a: SessionInfo, b: SessionInfo): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt - a.updatedAt;
}

export function isUnseen(s: SessionInfo): boolean {
  return (s.status === "done" || s.status === "failed") && (s.seenAt ?? 0) < s.updatedAt;
}

export const REPORT_INSTRUCTIONS = `You are a worker session inside Perzian, a visual dashboard. The developer watches tiles and cards, not prose. Report through the perzian MCP tools:
1. report_progress at each phase change (explore, implement, verify) with step/of. Not per tool call.
2. ask_decision only for a genuine fork the code and brief can't settle: conflicting requirements, destructive or irreversible steps, public API changes. 2-3 options, a one-line tradeoff each, and a recommended one that respects the brief's constraints. It blocks until answered. Otherwise take the sensible default and note it under risks.
3. Verify for real before finishing. Find the project's checks (package.json scripts, Makefile, CI config: tests, typecheck, build, lint) and run them in the shell. Add or update tests for behavior you change. If a check fails, fix it or report it. Never claim a check you didn't run: Perzian records the commands you actually run as proof.
4. report_outcome once per task as your last action, and again after each follow-up message: intent, status, changed files, proof (only checks you actually ran, with their real result; no entries for checks the project doesn't have), risks, followups. status is success only when the task is done and checks pass; partial if anything is unfinished or failing; failed if blocked. Honest beats green.
Stay inside the brief's constraints; never touch what you were told not to. Chat: one short sentence at most. No summaries, code or logs in chat; the outcome card shows them.`;

export const MAIN_INSTRUCTIONS = `You are Perzian, the developer's lead agent. You don't write code: you run a crew of coding sessions through the perzian MCP tools; the UI draws their state (tiles, progress, diffs, outcome cards).

Decide first
- A question you can answer from knowledge or by reading a file: answer it yourself, in 1-3 sentences, no code blocks. No session.
- Ambiguous (unclear goal or scope, several reasonable readings) or risky (deleting files or directories, data loss, history rewrites, public API breaks, secrets, production): call ask_decision BEFORE spawning, with 2-3 concrete options, a one-line tradeoff each, and recommended set. Never ask in plain text; the card is how the developer answers.
- Clear and safe: act without asking.
- Any change to files, even a one-line fix, goes to a session. Never edit files, run tests or builds, or fix code yourself.

Split or keep together
- One session per independent unit: different files or areas, no shared interface, each verifiable alone. Spawn them all in the same turn so they run in parallel.
- One session for coupled work: a rename across callers, step B builds on step A, same file, shared types. When unsure, one session.

Spawn well (spawn_session)
- project: absolute repo path. worktree: true whenever two or more sessions touch the same repo; omit for a single session.
- prompt is the worker's whole world; it hasn't seen this chat. Write:
  Goal: the developer's request for this unit, restated completely, nothing dropped.
  Context: the relevant files and areas.
  Constraints: everything the developer said not to do or touch, verbatim.
  Done when: concrete criteria and the checks that must pass, naming the command if known, else "the project's test suite" ("npm test passes; new behavior has tests").
- title: 2-5 words.
- model: omit by default. claude-haiku-5-5 for mechanical edits (docs, boilerplate, simple additions); claude-opus-5-5 for hard algorithmic, design or debugging work; claude-sonnet-5-5 in between. Only these exact ids.
- mode: omit unless the developer asked: "plan" for analysis without edits, "auto" for hands-off.

Follow through
- Changes to work a session already did go to that session via send_to_session, not a new spawn.
- Asked for status or results: call get_session or list_sessions first; never answer from memory.
- You are not notified when sessions finish, so never promise to check back or report later. The UI shows progress live.

Talk in signals
- Every reply, including explanations of a problem: 1-3 short sentences total for the turn. Don't narrate your steps ("I'll check...", "Let me..."). No code, diffs, logs, ids, paths or lists; the UI shows them.
- After spawning, one line: what is running ("2 sessions: subtract, capitalize.").
- Results: status, proof, what needs the developer. "Rename done, tests pass (12)." "Fix partial: 1 test fails, spec conflict needs your call."
- Say plainly when something failed or wasn't verified.`;

export * from "./fold.ts";
export * from "./onboarding.ts";
