import { usageKey, type AgentConfig, type LimitWindow, type UsageReading, type Decision, type FileChange, type Outcome, type PerzianEvent, type PermissionMode, type SessionInfo, type TranscriptItem, type UsageCard, type UsageCardMode } from "./index.ts";

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
  /** Plan-window usage as last reported, and the "on pace" lines dismissed (see usageNotice). */
  usage: { windows: Partial<Record<LimitWindow, UsageReading>>; dismissed: string[] };
}

export const emptyState: State = { sessions: {}, transcripts: {}, decisions: {}, outcomes: {}, changes: {}, configs: {}, usageCards: {}, usage: { windows: {}, dismissed: [] }, settings: { defaultMode: DEFAULT_PERMISSION_MODE, projects: [], usageCard: "ask", splash: true } };

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
    case "usage.reading":
      return { ...s, usage: { ...s.usage, windows: { ...s.usage.windows, [e.reading.window]: e.reading } } };
    case "usage.dismissed":
      return s.usage.dismissed.includes(e.key) ? s : { ...s, usage: { ...s.usage, dismissed: [...s.usage.dismissed, e.key].slice(-8) } };
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

const HOUR = 3_600_000;
/** Length of each plan window; the overage and unknown ones have no pace. */
const WINDOW_MS: Partial<Record<LimitWindow, number>> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR, seven_day_opus: 168 * HOUR, seven_day_sonnet: 168 * HOUR };
export const WINDOW_NAME: Record<LimitWindow, string> = { five_hour: "session", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet", overage: "extra usage", unknown: "plan" };

/** The slim "on pace to hit your limit early" line: a window at least 30% used that, at this pace, runs out before it resets. Null otherwise, or once dismissed. */
export function usageNotice(usage: State["usage"], now: number): { key: string; window: LimitWindow; utilization: number; resetsAt: number } | null {
  let best: UsageReading | null = null;
  for (const r of Object.values(usage.windows)) {
    const len = WINDOW_MS[r.window];
    if (!len || r.utilization < 0.3 || r.resetsAt <= now || usage.dismissed.includes(usageKey(r))) continue;
    const elapsed = Math.min(1, Math.max(0.01, (len - (r.resetsAt - now)) / len));
    if (r.utilization / elapsed <= 1) continue;
    if (!best || r.utilization > best.utilization) best = r;
  }
  return best ? { key: usageKey(best), window: best.window, utilization: best.utilization, resetsAt: best.resetsAt } : null;
}
