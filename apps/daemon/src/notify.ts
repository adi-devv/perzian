// Tells the lead when the sessions it started finish: one short, machine-readable system prompt per
// batch of children that settle close together, delivered only between the lead's turns.
//
// Loop guards: only turns the lead itself started (spawn_session / send_to_session) are reported, never
// work the developer drove directly in a child; and after MAX_AUTO_TURNS lead turns triggered by these
// updates with no developer message in between, delivery pauses until the developer speaks.
import type { Outcome, Proof, SessionInfo } from "@perzian/protocol";

export const NOTIFY_PREFIX = "[perzian]";

export interface ChildReport {
  id: string;
  title: string;
  status: SessionInfo["status"];
  outcome?: Pick<Outcome, "status" | "intent" | "proof" | "derived">;
  changedFiles: number;
}

const clean = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function proofSummary(proof: Proof[]): string {
  const observed = proof.filter((p) => p.observed);
  if (!observed.length) return proof.length ? "unverified" : "none";
  return observed.map((p) => `${p.kind}:${p.passed ? "pass" : "fail"}${p.summary ? `(${clean(p.summary, 30)})` : ""}`).join(",");
}

export function formatChildLine(c: ChildReport): string {
  const parts = [`id=${c.id}`, `title="${clean(c.title, 48)}"`, `status=${c.status}`];
  if (c.outcome) {
    parts.push(`outcome=${c.outcome.status}${c.outcome.derived ? "(derived)" : ""}`);
    parts.push(`proof=${proofSummary(c.outcome.proof)}`);
  } else parts.push("outcome=none");
  parts.push(`files=${c.changedFiles}`);
  if (c.outcome?.intent) parts.push(`intent="${clean(c.outcome.intent, 100)}"`);
  return `- ${parts.join(" ")}`;
}

export function formatChildFinished(children: ChildReport[]): string {
  return [
    `${NOTIFY_PREFIX} Automatic update, not from the developer: ${children.length === 1 ? "a session" : `${children.length} sessions`} finished.`,
    ...children.map(formatChildLine),
    "Reply to the developer in one short line (under 20 words): result, proof, what needs them. Don't start new work from this update; the developer decides what's next.",
  ].join("\n");
}

export interface NotifierDeps {
  /** True while the lead is mid-turn (working, or waiting on the developer). */
  busy(leadId: string): boolean;
  /** Current report for a child, or undefined when it's gone. */
  report(childId: string): ChildReport | undefined;
  deliver(leadId: string, text: string): void;
  notice(leadId: string, text: string): void;
  debounceMs?: number;
  maxAutoTurns?: number;
}

export class LeadNotifier {
  private pending = new Map<string, Set<string>>(); // leadId -> child ids
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private ready = new Set<string>(); // leads whose debounce has elapsed, waiting for the turn to end
  private autoTurns = new Map<string, number>();
  private paused = new Set<string>();
  private byLead = new Set<string>(); // children whose current turn the lead started

  constructor(private deps: NotifierDeps) {}

  /** A prompt went to a child; `fromLead` says whether the lead (not the developer) sent it. */
  childPrompted(childId: string, fromLead: boolean): void {
    if (fromLead) this.byLead.add(childId);
    else this.byLead.delete(childId);
  }

  /** The developer wrote to the lead: reset the loop guard. */
  developerPrompted(leadId: string): void {
    this.autoTurns.delete(leadId);
    this.paused.delete(leadId);
  }

  /** A child reached done/failed. */
  childSettled(leadId: string, childId: string): void {
    if (!this.byLead.has(childId)) return;
    this.byLead.delete(childId);
    let set = this.pending.get(leadId);
    if (!set) this.pending.set(leadId, (set = new Set()));
    set.add(childId);
    this.ready.delete(leadId);
    clearTimeout(this.timers.get(leadId));
    this.timers.set(
      leadId,
      setTimeout(() => {
        this.timers.delete(leadId);
        this.ready.add(leadId);
        this.flush(leadId);
      }, this.deps.debounceMs ?? 1500),
    );
  }

  /** The lead's turn ended; deliver anything that was held. */
  leadIdle(leadId: string): void {
    this.flush(leadId);
  }

  pendingFor(leadId: string): string[] {
    return [...(this.pending.get(leadId) ?? [])];
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private flush(leadId: string): void {
    if (!this.ready.has(leadId) || this.deps.busy(leadId)) return;
    const ids = this.pending.get(leadId);
    if (!ids?.size) return;
    const max = this.deps.maxAutoTurns ?? 6;
    const n = this.autoTurns.get(leadId) ?? 0;
    if (n >= max) {
      if (!this.paused.has(leadId)) {
        this.paused.add(leadId);
        this.deps.notice(leadId, "Paused automatic session updates until you reply");
      }
      return;
    }
    const reports = [...ids].map((id) => this.deps.report(id)).filter((r): r is ChildReport => !!r);
    this.pending.delete(leadId);
    this.ready.delete(leadId);
    if (!reports.length) return;
    this.autoTurns.set(leadId, n + 1);
    this.deps.deliver(leadId, formatChildFinished(reports));
  }
}
