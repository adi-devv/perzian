// Shared types between the daemon and the UI. All UI state is a fold over PerzianEvent.

export type SessionStatus = "idle" | "working" | "needs_you" | "done" | "failed";

export type AgentKind = "claude-code" | "codex";

export interface SessionInfo {
  id: string;
  title: string;
  project: string; // absolute repo path
  cwd: string; // worktree path or project path
  branch?: string;
  agent: AgentKind;
  model?: string;
  status: SessionStatus;
  progress?: Progress;
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
  options: DecisionOption[];
  recommended?: string;
  createdAt: number;
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface Proof {
  kind: "tests" | "build" | "screenshot" | "command" | "manual";
  label: string;
  passed: boolean;
  detail?: string;
}

export interface Outcome {
  sessionId: string;
  intent: string;
  status: "success" | "partial" | "failed";
  changed: { path: string; kind: ChangeKind }[];
  proof: Proof[];
  risks: string[];
  followups: string[];
  createdAt: number;
}

export type TranscriptItem =
  | { kind: "user"; text: string; at: number }
  | { kind: "agent"; text: string; at: number }
  | { kind: "thought"; text: string; at: number }
  | { kind: "tool"; toolCallId: string; title: string; status: string; toolKind?: string; at: number };

export type PerzianEvent =
  | { type: "session.created"; session: SessionInfo }
  | { type: "session.status"; sessionId: string; status: SessionStatus; at: number }
  | { type: "session.progress"; sessionId: string; progress: Progress }
  | { type: "session.transcript"; sessionId: string; item: TranscriptItem }
  | { type: "decision.requested"; decision: Decision }
  | { type: "decision.resolved"; decisionId: string; sessionId: string; optionId: string | null }
  | { type: "outcome.reported"; outcome: Outcome };

// UI -> daemon
export type Command =
  | { type: "session.create"; project: string; title?: string; agent?: AgentKind; model?: string; prompt: string; worktree?: boolean }
  | { type: "session.prompt"; sessionId: string; prompt: string }
  | { type: "session.cancel"; sessionId: string }
  | { type: "decision.answer"; decisionId: string; optionId: string | null };

// daemon -> UI envelope
export type ServerMessage =
  | { type: "snapshot"; events: PerzianEvent[] }
  | { type: "event"; event: PerzianEvent }
  | { type: "error"; message: string };

// report-mcp -> daemon (HTTP POST to /report)
export type ReportCall =
  | { tool: "report_progress"; sessionId: string; args: Omit<Progress, never> }
  | { tool: "ask_decision"; sessionId: string; args: { question: string; options: { id: string; label: string; tradeoff?: string }[]; recommended?: string } }
  | { tool: "report_outcome"; sessionId: string; args: Omit<Outcome, "sessionId" | "createdAt"> };

export const DAEMON_PORT = 4317;

// Attention ordering: what needs the dev first.
const STATUS_RANK: Record<SessionStatus, number> = { needs_you: 0, failed: 1, done: 2, working: 3, idle: 4 };
export function byAttention(a: SessionInfo, b: SessionInfo): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.updatedAt - b.updatedAt;
}

export const REPORT_INSTRUCTIONS = `You are running inside Perzian, a visual agent dashboard. The developer does not read long prose.
Report through the perzian MCP tools instead of writing summaries:
- Call report_progress when you start a new phase of work (e.g. explore, implement, test).
- Call ask_decision when you need the developer to choose; give 2-3 options with one-line tradeoffs. It blocks until answered.
- Call report_outcome once when the task is finished: what changed, proof it works (tests/build/commands you ran), risks, follow-ups.
Keep chat replies to one or two short sentences.`;
