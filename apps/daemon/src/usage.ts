import type { SessionUsage } from "@perzian/protocol";

// Turns an adapter's usage_update stream into a session total that survives adapter restarts.
//
// Claude's adapter reports cost as a running total for its own process. The rules:
// - Within a process the total only goes up. A dip (1.0 → 0.9) is noise and is ignored; only a drop
//   below half the last reading means the adapter's counter started over, and then what it had counted
//   is kept and the new readings add to it.
// - A fresh conversation (session/new) starts from zero: its readings add to our stored total.
// - A resumed conversation (session/load) may already count the history we stored. A first reading at
//   or above half our total is taken as including it: the total becomes the larger of the two (never
//   counted twice). A smaller first reading is a counter that started over, and adds to the total.

export interface UsageReading {
  cost?: { amount: number; currency: string } | null;
  used?: number;
  size?: number;
}

/** Below this share of the previous reading, a reading means the counter started over. */
const RESET = 0.5;

export class UsageMeter {
  private usage: SessionUsage;
  private base: number;
  private last: number | undefined;
  private resumed = true;

  constructor(initial?: SessionUsage) {
    this.usage = { ...initial };
    this.base = initial?.costUsd ?? 0;
  }

  /** A new adapter process. `resumed` false: a fresh conversation, so its first reading can't include history. */
  restart(resumed = true): void {
    this.base = this.usage.costUsd ?? 0;
    this.last = undefined;
    this.resumed = resumed;
  }

  /** The new usage when it changed enough to be worth an event, else null. */
  read(r: UsageReading): SessionUsage | null {
    const next: SessionUsage = { ...this.usage };
    const amount = r.cost && r.cost.currency === "USD" && Number.isFinite(r.cost.amount) && r.cost.amount >= 0 ? r.cost.amount : undefined;
    if (amount !== undefined) {
      if (this.last === undefined) {
        if (this.resumed && this.base > 0 && amount >= this.base * RESET) this.base = Math.max(this.base - amount, 0);
        this.last = amount;
      } else if (amount < this.last * RESET) {
        this.base += this.last;
        this.last = amount;
      } else if (amount > this.last) {
        this.last = amount;
      }
      next.costUsd = this.base + this.last;
    }
    if (typeof r.used === "number" && r.used >= 0) next.contextUsed = r.used;
    if (typeof r.size === "number" && r.size > 0) next.contextSize = r.size;

    const prev = this.usage;
    this.usage = next;
    const costMoved = Math.abs((next.costUsd ?? 0) - (prev.costUsd ?? 0)) >= 0.0005;
    const size = next.contextSize ?? prev.contextSize ?? 0;
    // Mid-turn context readings arrive per message; only a visible move (1% of the window) is an event.
    const ctxMoved = next.contextSize !== prev.contextSize || (size > 0 ? Math.abs((next.contextUsed ?? 0) - (prev.contextUsed ?? 0)) >= size / 100 : next.contextUsed !== prev.contextUsed);
    return costMoved || ctxMoved ? next : null;
  }
}
