import type { AgentConfig, Decision, FileChange, Outcome, PerzianEvent, PermissionMode, SessionInfo, TranscriptItem, UsageCard, UsageCardMode } from "./index.ts";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "edits", "plan", "auto"];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export interface State {
  sessions: Record<string, SessionInfo>;
  transcripts: Record<string, TranscriptItem[]>;
  decisions: Record<string, Decision>; // open only
  outcomes: Record<string, Outcome>; // latest per session
  changes: Record<string, FileChange[]>; // latest per session
  configs: Record<string, AgentConfig>;
  /** Global settings, folded from settings.* events. */
  settings: { defaultMode: PermissionMode; /** Folders added by hand, oldest first. */ projects: string[]; usageCard: UsageCardMode; /** Welcome splash on startup. */ splash: boolean };
  /** Account usage cards by key (window + reset); see UsageCard. */
  usageCards: Record<string, UsageCard>;
}

export const emptyState: State = { sessions: {}, transcripts: {}, decisions: {}, outcomes: {}, changes: {}, configs: {}, usageCards: {}, settings: { defaultMode: DEFAULT_PERMISSION_MODE, projects: [], usageCard: "ask", splash: true } };

function patchSession(s: State, id: string, patch: Partial<SessionInfo>): State {
  const cur = s.sessions[id];
  if (!cur) return s;
  return { ...s, sessions: { ...s.sessions, [id]: { ...cur, ...patch } } };
}

/** Events after which a session is no longer interrupted: it runs again, or the ship or setup the restart cut short is retried. */
export function clearsInterrupted(e: PerzianEvent): boolean {
  if (e.type === "session.status") return e.status === "working";
  if (e.type === "session.updated") return e.patch.ship?.state === "shipping" || e.patch.setup?.state === "running" || e.patch.setup?.state === "skipped";
  return false;
}

// Pure fold used by both the daemon (to rebuild on boot) and the UI.
export function reduce(s: State, e: PerzianEvent): State {
  const next = step(s, e);
  if (!clearsInterrupted(e) || !("sessionId" in e)) return next;
  const cur = next.sessions[e.sessionId];
  if (!cur?.interrupted) return next;
  const { interrupted: _, ...rest } = cur;
  return { ...next, sessions: { ...next.sessions, [e.sessionId]: rest } };
}

function step(s: State, e: PerzianEvent): State {
  switch (e.type) {
    case "session.created":
      return { ...s, sessions: { ...s.sessions, [e.session.id]: e.session } };
    case "session.updated":
      return patchSession(s, e.sessionId, e.patch);
    case "session.status":
      return patchSession(s, e.sessionId, { status: e.status, updatedAt: e.at });
    case "session.paused":
      return patchSession(s, e.sessionId, { status: "paused", pause: e.pause, updatedAt: e.pause.at });
    case "session.resumed": {
      const cur = s.sessions[e.sessionId];
      if (!cur) return s;
      const { pause: _, ...rest } = cur;
      return { ...s, sessions: { ...s.sessions, [e.sessionId]: { ...rest, status: cur.status === "paused" ? "idle" : cur.status, updatedAt: e.at } } };
    }
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
    case "settings.defaultMode":
      return { ...s, settings: { ...s.settings, defaultMode: e.mode } };
    case "usage.card":
      return s.usageCards[e.card.key] ? s : { ...s, usageCards: { ...s.usageCards, [e.card.key]: e.card } };
    case "usage.answered": {
      const cur = s.usageCards[e.key];
      if (!cur || cur.answer) return s;
      return { ...s, usageCards: { ...s.usageCards, [e.key]: { ...cur, answer: { choice: e.choice, at: e.at, ...(e.auto ? { auto: true } : {}) } } } };
    }
    case "settings.usageCard":
      return { ...s, settings: { ...s.settings, usageCard: e.mode } };
    case "settings.splash":
      return s.settings.splash === e.show ? s : { ...s, settings: { ...s.settings, splash: e.show } };
    case "settings.projectAdded":
      return s.settings.projects.includes(e.path) ? s : { ...s, settings: { ...s.settings, projects: [...s.settings.projects, e.path] } };
  }
}

/** The usage card waiting for an answer (the oldest, if somehow several), or undefined. */
export function pendingUsageCard(s: Pick<State, "usageCards">): UsageCard | undefined {
  return Object.values(s.usageCards).filter((c) => !c.answer).sort((a, b) => a.at - b.at)[0];
}

export const fold =(events: PerzianEvent[]): State => events.reduce(reduce, emptyState);
