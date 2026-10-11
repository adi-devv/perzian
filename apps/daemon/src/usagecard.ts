// Account-level usage governor. All Claude sessions share one plan limit, so nearing it is one question for
// the developer, not one early pause per session (see the "Usage limits" part of docs/ARCHITECTURE.md).
//
// - Near the threshold (limits.ts NEAR_LIMIT / PERZIAN_PAUSE_AT): one `usage.card` per window + reset
//   ("Usage 95% · resets 10:15 pm", Pause sessions / Keep going). Workers keep running while it is open.
// - Pause: every working Claude worker stops after its current step, all with the same resume time.
//   Keep going: no early pause for that window; the real limit still pauses and auto-resumes.
// - Unanswered after CARD_TIMEOUT_MS: treated as Pause.
// - settings.usageCard "keep_going" / "pause" skips the card and always does that.
// - A session refused at the hard limit pauses every other working Claude session at once (same resume
//   time); the lead is left reachable unless it was refused itself.
//
// The answer is an event (`usage.answered`), so the card is a fold over the log; a card still open when
// the daemon restarts is picked up again by `attach()`.
import type { PerzianEvent, SessionInfo, State, UsageCard } from "@perzian/protocol";
import { hitFromReading, resumeTime, type LimitHit, type RateLimitReading } from "./limits.ts";
import type { UsageSignals } from "./session.ts";

/** How long the card waits for an answer before it counts as Pause. */
export const CARD_TIMEOUT_MS = 2 * 60_000;

export interface GovernedSession {
  info: Pick<SessionInfo, "id" | "role" | "agent" | "status" | "archived">;
  pauseAfterCurrentStep(hit: LimitHit): void;
  pauseForSharedLimit(hit: LimitHit): void;
}

export interface GovernorOptions {
  store: { state(): State; emit(e: PerzianEvent): void };
  sessions(): Iterable<GovernedSession>;
  now?: () => number;
  timeoutMs?: number;
}

export const cardKey = (r: { window?: string; resetAt?: number }) => `${r.window ?? "unknown"}:${r.resetAt}`;

export class UsageGovernor implements UsageSignals {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private opts: GovernorOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Arms the timeout of every card still open (after a restart). */
  attach(): void {
    for (const c of Object.values(this.opts.store.state().usageCards)) if (!c.answer) this.arm(c);
  }

  /** Records the window's usage for the UI (the usage line and the ring's popover), only when it moved. */
  reading(r: RateLimitReading): void {
    if (r.resetAt === undefined || r.utilization === undefined) return;
    const window = r.window ?? "unknown";
    const cur = this.opts.store.state().usage.windows[window];
    if (cur && cur.resetsAt === r.resetAt && Math.abs(cur.utilization - r.utilization) < 0.01) return;
    this.opts.store.emit({ type: "usage.reading", reading: { window, resetsAt: r.resetAt, utilization: r.utilization, at: this.now() } });
  }

  dismissNotice(key: string): void {
    if (!this.opts.store.state().usage.dismissed.includes(key)) this.opts.store.emit({ type: "usage.dismissed", key, at: this.now() });
  }

  near(r: RateLimitReading, sessionId: string): void {
    if (r.resetAt === undefined) return;
    const state = this.opts.store.state();
    const mode = state.settings.usageCard;
    if (mode === "keep_going") return;
    const session = this.worker(sessionId);
    if (mode === "pause") {
      this.pauseWorkers(hitFromReading(r));
      return;
    }
    const key = cardKey(r);
    const card = state.usageCards[key];
    if (!card) {
      const at = this.now();
      const fresh: UsageCard = { key, resetsAt: r.resetAt, utilization: r.utilization ?? 0, at, autoAt: at + (this.opts.timeoutMs ?? CARD_TIMEOUT_MS), ...(r.window ? { window: r.window } : {}), ...(r.overage ? { overage: true } : {}) };
      this.opts.store.emit({ type: "usage.card", card: fresh });
      this.arm(fresh);
    } else if (card.answer?.choice === "pause") {
      // Answered Pause earlier: a worker that wasn't running then stops too.
      if (session) session.pauseAfterCurrentStep(hitFromReading(r));
    }
    // Open or Keep going: nothing to do.
  }

  /** The developer's (or the timeout's) answer. Only the first answer to a card counts. */
  answer(key: string, choice: "pause" | "keep_going", auto = false): void {
    const card = this.opts.store.state().usageCards[key];
    if (!card || card.answer) return;
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.opts.store.emit({ type: "usage.answered", key, choice, at: this.now(), ...(auto ? { auto: true as const } : {}) });
    if (choice === "pause") this.pauseWorkers(hitFromReading({ state: "near", resetAt: card.resetsAt, utilization: card.utilization, ...(card.window ? { window: card.window } : {}) }));
  }

  refused(sessionId: string, hit: LimitHit): void {
    if (hit.transient) return; // a short-term 429 isn't the account's plan limit
    const shared = hit.resumeAt !== undefined ? hit : { ...hit, ...resumeFor(hit, this.now()) };
    for (const s of this.opts.sessions()) {
      if (s.info.id === sessionId || !this.isWorker(s) || s.info.status !== "working") continue;
      s.pauseForSharedLimit(shared);
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(card: UsageCard): void {
    clearTimeout(this.timers.get(card.key));
    const t = setTimeout(() => {
      this.timers.delete(card.key);
      // Wall clock, not the timer: the Mac may have slept through it.
      if (this.now() < card.autoAt) this.arm(card);
      else this.answer(card.key, "pause", true);
    }, Math.max(0, card.autoAt - this.now()));
    t.unref?.();
    this.timers.set(card.key, t);
  }

  private isWorker(s: GovernedSession): boolean {
    return s.info.role === "worker" && s.info.agent === "claude-code" && !s.info.archived;
  }

  private worker(id: string): GovernedSession | undefined {
    for (const s of this.opts.sessions()) if (s.info.id === id && this.isWorker(s)) return s;
    return undefined;
  }

  /** Every working Claude worker stops after its current step, with one shared resume time. */
  private pauseWorkers(hit: LimitHit): void {
    const shared = { ...hit, ...resumeFor(hit, this.now()) };
    for (const s of this.opts.sessions()) if (this.isWorker(s) && s.info.status === "working") s.pauseAfterCurrentStep(shared);
  }
}

function resumeFor(hit: LimitHit, now: number): Pick<LimitHit, "resumeAt" | "estimated"> {
  const { resumeAt, estimated } = resumeTime(hit, now);
  return { resumeAt, ...(estimated ? { estimated: true } : {}) };
}
