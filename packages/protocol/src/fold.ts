import type { AgentConfig, Decision, FileChange, Outcome, PerzianEvent, SessionInfo, TranscriptItem } from "./index.ts";

export interface State {
  sessions: Record<string, SessionInfo>;
  transcripts: Record<string, TranscriptItem[]>;
  decisions: Record<string, Decision>; // open only
  outcomes: Record<string, Outcome>; // latest per session
  changes: Record<string, FileChange[]>; // latest per session
  configs: Record<string, AgentConfig>;
}

export const emptyState: State = { sessions: {}, transcripts: {}, decisions: {}, outcomes: {}, changes: {}, configs: {} };

function patchSession(s: State, id: string, patch: Partial<SessionInfo>): State {
  const cur = s.sessions[id];
  if (!cur) return s;
  return { ...s, sessions: { ...s.sessions, [id]: { ...cur, ...patch } } };
}

// Pure fold used by both the daemon (to rebuild on boot) and the UI.
export function reduce(s: State, e: PerzianEvent): State {
  switch (e.type) {
    case "session.created":
      return { ...s, sessions: { ...s.sessions, [e.session.id]: e.session } };
    case "session.updated":
      return patchSession(s, e.sessionId, e.patch);
    case "session.status":
      return patchSession(s, e.sessionId, { status: e.status, updatedAt: e.at });
    case "session.progress":
      return patchSession(s, e.sessionId, { progress: e.progress });
    case "session.transcript": {
      const list = s.transcripts[e.sessionId] ?? [];
      const item = e.item;
      // Tool status updates replace the earlier entry for the same call, in place.
      let next: TranscriptItem[];
      if (item.kind === "tool") {
        const i = list.findIndex((x) => x.kind === "tool" && x.toolCallId === item.toolCallId);
        next = i === -1 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
      } else next = [...list, item];
      return { ...s, transcripts: { ...s.transcripts, [e.sessionId]: next } };
    }
    case "session.config":
      return { ...s, configs: { ...s.configs, [e.sessionId]: e.config } };
    case "session.changes":
      return { ...s, changes: { ...s.changes, [e.sessionId]: e.files } };
    case "decision.requested":
      return { ...s, decisions: { ...s.decisions, [e.decision.id]: e.decision } };
    case "decision.resolved": {
      const { [e.decisionId]: _, ...rest } = s.decisions;
      return { ...s, decisions: rest };
    }
    case "outcome.reported":
      return { ...s, outcomes: { ...s.outcomes, [e.outcome.sessionId]: e.outcome } };
  }
}

export const fold = (events: PerzianEvent[]): State => events.reduce(reduce, emptyState);
