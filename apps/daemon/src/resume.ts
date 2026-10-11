// Resume queue: sessions paused at a usage limit, and when each resumes.
//
// The queue keeps no file of its own. Pauses are `session.paused` events in the event store, so the
// store's state is the persisted queue: on boot every paused session is scheduled again from it (a reset
// that passed while the daemon was down fires on the first tick). `session.resumed` (or archiving) takes
// a session off.
//
// Wall-clock polling instead of one long setTimeout per session: Node timers run on a monotonic clock that
// stops while a Mac sleeps, so a 5-hour timeout set before a 4-hour sleep would fire 4 hours late.
import type { PerzianEvent, State } from "@perzian/protocol";

export interface ResumeQueueOptions {
  /** A paused session is due: resume it (same session, same worktree). */
  resume(sessionId: string): void;
  now?: () => number;
  /** Added to each reset time so sessions don't all fire in the same second, and the reset has landed. */
  jitterMs?: () => number;
  /** How often to check the clock. */
  tickMs?: number;
}

export const RESUME_TICK_MS = 15_000;
export const defaultJitter = () => 15_000 + Math.floor(Math.random() * 45_000);

interface QueueSource {
  state(): State;
  subscribe(listener: (e: PerzianEvent) => void): () => void;
}

export class ResumeQueue {
  private due = new Map<string, number>(); // sessionId -> resume at (reset time + jitter)
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;

  constructor(private opts: ResumeQueueOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Schedule every paused session in `source`'s state, then follow its events. */
  attach(source: QueueSource): void {
    for (const s of Object.values(source.state().sessions)) {
      if (s.status === "paused" && s.pause && !s.archived) this.schedule(s.id, s.pause.resumeAt);
    }
    this.unsubscribe = source.subscribe((e) => this.onEvent(e));
  }

  onEvent(e: PerzianEvent): void {
    if (e.type === "session.paused") this.schedule(e.sessionId, e.pause.resumeAt);
    else if (e.type === "session.resumed") this.cancel(e.sessionId);
    else if (e.type === "session.updated" && e.patch.archived) this.cancel(e.sessionId);
  }

  schedule(sessionId: string, resumeAt: number): void {
    this.due.set(sessionId, resumeAt + Math.max(0, (this.opts.jitterMs ?? defaultJitter)()));
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), this.opts.tickMs ?? RESUME_TICK_MS);
      this.timer.unref?.();
    }
  }

  cancel(sessionId: string): void {
    this.due.delete(sessionId);
    if (!this.due.size) this.stop();
  }

  /** What's waiting, soonest first. */
  pending(): { sessionId: string; at: number }[] {
    return [...this.due].map(([sessionId, at]) => ({ sessionId, at })).sort((a, b) => a.at - b.at);
  }

  /** Resume everything that's due. Runs on every tick. */
  check(): void {
    const now = this.now();
    for (const [id, at] of [...this.due]) {
      if (at > now) continue;
      this.due.delete(id);
      try {
        this.opts.resume(id);
      } catch (e) {
        console.error(`[resume ${id.slice(0, 6)}]`, e);
      }
    }
    if (!this.due.size) this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
    this.unsubscribe?.();
    this.due.clear();
  }
}
