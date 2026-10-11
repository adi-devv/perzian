import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERMISSION_MODE, reduce, type PerzianEvent, type SessionInfo, type State, type TranscriptItem } from "@perzian/protocol";

export const TRANSCRIPT_KEEP = 400;
export const ARCHIVED_TTL_MS = 7 * 24 * 3600_000;
export const TRIMMED_NOTICE = "Earlier activity trimmed";
// Compaction runs on boot only when the log is past one of these (see EventStore).
export const COMPACT_BYTES = 2 * 1024 * 1024;
export const COMPACT_EVENTS = 20_000;
const MIN_GAIN = 0.75; // compacted log must be at most this fraction of the events to be worth writing

export interface CompactOptions {
  now?: number;
  keep?: number; // transcript items kept per session
  archivedTtlMs?: number; // archived sessions idle longer than this are dropped
}

// The minimal event sequence that folds back to `state`: per session its final info, config, change
// map, the last `keep` transcript items (behind a notice when trimmed) and latest outcome; then open
// decisions. Archived sessions idle past the TTL, and anything orphaned, are dropped.
export function compact(state: State, opts: CompactOptions = {}): PerzianEvent[] {
  const now = opts.now ?? Date.now();
  const keep = opts.keep ?? TRANSCRIPT_KEEP;
  const ttl = opts.archivedTtlMs ?? ARCHIVED_TTL_MS;
  const kept = new Set<string>();
  for (const s of Object.values(state.sessions)) if (!(s.archived && now - s.updatedAt > ttl)) kept.add(s.id);

  const out: PerzianEvent[] = [];
  if (state.settings.defaultMode !== DEFAULT_PERMISSION_MODE) out.push({ type: "settings.defaultMode", mode: state.settings.defaultMode, at: now });
  for (const path of state.settings.projects) out.push({ type: "settings.projectAdded", path, at: now });
  for (const id of kept) {
    const session = state.sessions[id];
    const sessionId = id;
    out.push({ type: "session.created", session });
    const config = state.configs[id];
    if (config) out.push({ type: "session.config", sessionId, config });
    const files = state.changes[id];
    if (files) out.push({ type: "session.changes", sessionId, files, at: session.updatedAt });
    const all = (state.transcripts[id] ?? []).filter((t) => t.kind !== "spawn" || kept.has(t.childId));
    const tail = all.length > keep ? all.slice(-keep) : all;
    if (tail.length < all.length) out.push({ type: "session.transcript", sessionId, item: { kind: "notice", text: TRIMMED_NOTICE, at: all[all.length - keep - 1].at } });
    for (const item of tail) out.push({ type: "session.transcript", sessionId, item });
    const outcome = state.outcomes[id];
    if (outcome) out.push({ type: "outcome.reported", outcome });
  }
  for (const decision of Object.values(state.decisions)) if (kept.has(decision.sessionId)) out.push({ type: "decision.requested", decision });
  return out;
}

// Same result as protocol `fold`, but mutates as it goes: `reduce` copies the transcript array on every
// item, which makes replaying a long log quadratic. Only used on boot; never shares objects with `events`.
export function replay(events: PerzianEvent[]): State {
  const sessions: Record<string, SessionInfo> = {};
  const transcripts: Record<string, TranscriptItem[]> = {};
  const toolIndex = new Map<string, Map<string, number>>(); // sessionId -> toolCallId -> index
  const st: State = { sessions, transcripts, decisions: {}, outcomes: {}, changes: {}, configs: {}, settings: { defaultMode: DEFAULT_PERMISSION_MODE, projects: [] } };
  const patch = (id: string, p: Partial<SessionInfo>) => {
    if (sessions[id]) Object.assign(sessions[id], p);
  };
  for (const e of events) {
    switch (e.type) {
      case "session.created":
        sessions[e.session.id] = { ...e.session };
        break;
      case "session.updated":
        patch(e.sessionId, e.patch);
        break;
      case "session.status":
        patch(e.sessionId, { status: e.status, updatedAt: e.at });
        break;
      case "session.paused":
        patch(e.sessionId, { status: "paused", pause: e.pause, updatedAt: e.pause.at });
        break;
      case "session.resumed": {
        const cur = sessions[e.sessionId];
        if (!cur) break;
        delete cur.pause;
        if (cur.status === "paused") cur.status = "idle";
        cur.updatedAt = e.at;
        break;
      }
      case "session.progress":
        patch(e.sessionId, { progress: e.progress });
        break;
      case "session.transcript": {
        const list = (transcripts[e.sessionId] ??= []);
        const item = e.item;
        if (item.kind === "tool") {
          let idx = toolIndex.get(e.sessionId);
          if (!idx) toolIndex.set(e.sessionId, (idx = new Map()));
          const i = idx.get(item.toolCallId);
          if (i === undefined) {
            idx.set(item.toolCallId, list.length);
            list.push(item);
          } else list[i] = item;
        } else list.push(item);
        break;
      }
      case "session.config":
        st.configs[e.sessionId] = e.config;
        break;
      case "session.changes":
        st.changes[e.sessionId] = e.files;
        break;
      case "decision.requested":
        st.decisions[e.decision.id] = e.decision;
        break;
      case "decision.resolved":
        delete st.decisions[e.decisionId];
        break;
      case "outcome.reported":
        st.outcomes[e.outcome.sessionId] = e.outcome;
        break;
      case "settings.defaultMode":
        st.settings = { ...st.settings, defaultMode: e.mode };
        break;
      case "settings.projectAdded":
        if (!st.settings.projects.includes(e.path)) st.settings = { ...st.settings, projects: [...st.settings.projects, e.path] };
        break;
      default: {
        const unhandled: never = e; // a new event type must be handled here and in protocol `reduce`
        void unhandled;
      }
    }
  }
  return st;
}

export interface StoreOptions {
  /** "auto" (default): compact on boot when the log is past COMPACT_BYTES / COMPACT_EVENTS. */
  compact?: "auto" | "always" | "never";
  maxBytes?: number;
  maxEvents?: number;
  now?: () => number;
}

export interface BootStats {
  events: number;
  bytes: number;
  compacted?: { events: number; bytes: number };
  skippedLines: number;
  ms: number;
}

// Append-only event log ($PERZIAN_HOME/events.jsonl) plus the live fold of it. Everything the UI shows is
// a fold over these events; `state()` is kept current on every emit so nothing re-folds the log.
//
// Compaction is threshold-based rather than on every boot: the desktop app restarts the daemon often, and
// rewriting each time would churn events.jsonl.bak until it no longer held any real history. Past the
// threshold (and only if that drops at least a quarter of the events) the log is rewritten to its
// compacted form, which keeps boot bounded. WS snapshots are built from the live state and always bounded.
export class EventStore {
  private events: PerzianEvent[] = [];
  private st: State;
  private listeners = new Set<(e: PerzianEvent) => void>();
  private file: string;
  private fd: number;
  readonly boot: BootStats;

  constructor(dir = process.env.PERZIAN_HOME ?? join(homedir(), ".perzian"), opts: StoreOptions = {}) {
    const t0 = performance.now();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "events.jsonl");
    let text = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
    let skippedLines = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.events.push(JSON.parse(line));
      } catch {
        skippedLines++; // e.g. a line torn by a crash mid-write; don't refuse to boot over it
      }
    }
    if (skippedLines) console.warn(`[store] skipped ${skippedLines} unreadable line(s) in ${this.file}`);
    this.st = replay(this.events);
    const bytes = Buffer.byteLength(text);
    this.boot = { events: this.events.length, bytes, skippedLines, ms: 0 };

    const mode = opts.compact ?? (process.env.PERZIAN_COMPACT as StoreOptions["compact"]) ?? "auto";
    const over = bytes > (opts.maxBytes ?? COMPACT_BYTES) || this.events.length > (opts.maxEvents ?? COMPACT_EVENTS);
    if (mode === "always" || (mode === "auto" && over) || skippedLines) {
      const next = compact(this.st, { now: (opts.now ?? Date.now)() });
      // Only rewrite for a real gain, so a log that is big but already compact isn't rewritten (and its
      // backup overwritten) on every boot.
      if (next.length <= this.events.length * MIN_GAIN || skippedLines) {
        text = next.map((e) => JSON.stringify(e) + "\n").join("");
        this.writeAtomic(text);
        this.events = next;
        this.st = replay(next); // the dropped sessions are gone from the live state too
        this.boot.compacted = { events: next.length, bytes: Buffer.byteLength(text) };
      }
    }
    this.fd = openSync(this.file, "a");
    if (text && !text.endsWith("\n")) writeSync(this.fd, "\n"); // never glue the next event onto a torn line
    this.boot.ms = performance.now() - t0;
  }

  // Temp file + fsync + rename, so events.jsonl is always a complete log. The previous log is kept as
  // events.jsonl.bak (a hard link to it, falling back to a copy).
  private writeAtomic(text: string): void {
    const tmp = this.file + ".tmp";
    const bak = this.file + ".bak";
    writeFileSync(tmp, text);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.file)) {
      rmSync(bak, { force: true });
      try {
        linkSync(this.file, bak);
      } catch {
        copyFileSync(this.file, bak);
      }
    }
    renameSync(tmp, this.file);
  }

  emit(event: PerzianEvent): void {
    this.events.push(event);
    writeSync(this.fd, JSON.stringify(event) + "\n");
    this.st = reduce(this.st, event);
    for (const l of this.listeners) l(event);
  }

  /** The log since boot (compacted, if compaction ran). */
  all(): PerzianEvent[] {
    return this.events;
  }

  /** Live fold of the log. Treat as read-only; it is replaced (not mutated) on every emit. */
  state(): State {
    return this.st;
  }

  /** A bounded event list that folds to the current state, for WS snapshots. */
  snapshot(): PerzianEvent[] {
    return compact(this.st);
  }

  subscribe(listener: (e: PerzianEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    closeSync(this.fd);
  }
}
