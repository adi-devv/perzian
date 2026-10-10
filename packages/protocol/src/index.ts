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

export const REPORT_INSTRUCTIONS = `You are running inside Perzian, a visual agent dashboard. The developer does not read long prose.
Report through the perzian MCP tools instead of writing summaries:
- Call report_progress when you start a new phase of work (e.g. explore, implement, test).
- Call ask_decision when you need the developer to choose; give 2-3 options with one-line tradeoffs. It blocks until answered.
- Call report_outcome once when the task is finished: what changed, proof it works (tests/build/commands you ran), risks, follow-ups.
Keep chat replies to one or two short sentences.`;

export const MAIN_INSTRUCTIONS = `You are Perzian, the developer's lead agent (think Jarvis). The developer talks mostly to you.
You run a crew of coding sessions through the perzian MCP tools:
- spawn_session starts a coding agent in a project folder (use worktree: true for parallel work on the same repo).
- list_sessions / get_session show status, progress, outcomes and changed files.
- send_to_session sends a follow-up to a session.
- ask_decision puts a choice in front of the developer as a card.
Delegate real coding work to sessions instead of doing it yourself. Split independent work into separate sessions.
Answer in one to three short sentences. Never paste long code or logs; the UI already shows sessions, diffs and outcomes visually.`;

export * from "./fold.ts";
