import type { SessionUsage } from "@perzian/protocol";

// Turns an adapter's usage_update stream into a session total that survives adapter restarts.
//
// Claude's adapter reports cost as a running total for its own process. After a restart the
// reading starts over, except that a resumed conversation's first reading may already include
// the history we counted. So: within a process add what each reading adds; a reading that drops
// means the adapter started over; a first reading at or above our stored total is taken as
// already including it.

export interface UsageReading {
  cost?: { amount: number; currency: string } | null;
  used?: number;
  size?: number;
}

export class UsageMeter {
  private usage: SessionUsage;
  private base: number;
  private last: number | undefined;

  constructor(initial?: SessionUsage) {
    this.usage = { ...initial };
    this.base = initial?.costUsd ?? 0;
  }

  /** A new adapter process: its first reading is measured against what we already have. */
  restart(): void {
    this.base = this.usage.costUsd ?? 0;
    this.last = undefined;
  }

  /** The new usage when it changed enough to be worth an event, else null. */
  read(r: UsageReading): SessionUsage | null {
    const next: SessionUsage = { ...this.usage };
    const amount = r.cost && r.cost.currency === "USD" && Number.isFinite(r.cost.amount) && r.cost.amount >= 0 ? r.cost.amount : undefined;
    if (amount !== undefined) {
      if (this.last === undefined) {
        if (this.base > 0 && amount >= this.base) this.base = 0;
      } else if (amount < this.last) {
        this.base += this.last;
      }
      this.last = amount;
      next.costUsd = this.base + amount;
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
