import type { Decision, Outcome, PerzianEvent, SessionInfo, TranscriptItem } from "@perzian/protocol";

export interface State {
  sessions: Record<string, SessionInfo>;
  transcripts: Record<string, TranscriptItem[]>;
  decisions: Record<string, Decision>; // open only
  outcomes: Record<string, Outcome>; // latest per session
}

export const empty: State = { sessions: {}, transcripts: {}, decisions: {}, outcomes: {} };

// UI state is a pure fold over daemon events.
export function reduce(s: State, e: PerzianEvent): State {
  switch (e.type) {
    case "session.created":
      return { ...s, sessions: { ...s.sessions, [e.session.id]: e.session } };
    case "session.status": {
      const cur = s.sessions[e.sessionId];
      if (!cur) return s;
      return { ...s, sessions: { ...s.sessions, [e.sessionId]: { ...cur, status: e.status, updatedAt: e.at } } };
    }
    case "session.progress": {
      const cur = s.sessions[e.sessionId];
      if (!cur) return s;
      return { ...s, sessions: { ...s.sessions, [e.sessionId]: { ...cur, progress: e.progress } } };
    }
    case "session.transcript": {
      const list = s.transcripts[e.sessionId] ?? [];
      const item = e.item;
      // Tool status updates replace the earlier entry for the same call.
      const next =
        item.kind === "tool"
          ? [...list.filter((i) => !(i.kind === "tool" && i.toolCallId === item.toolCallId)), item]
          : [...list, item];
      return { ...s, transcripts: { ...s.transcripts, [e.sessionId]: next } };
    }
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
