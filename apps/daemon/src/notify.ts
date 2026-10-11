// Tells the lead when the sessions it started finish, pause at a usage limit, or resume: one short,
// machine-readable system prompt per batch of children that change close together, delivered only between
// the lead's turns.
//
// Loop guards: only turns the lead itself started (spawn_session / send_to_session) are reported, never
// work the developer drove directly in a child; and after MAX_AUTO_TURNS lead turns triggered by these
// updates with no developer message in between, delivery pauses until the developer speaks.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Outcome, PauseInfo, Proof, SessionInfo } from "@perzian/protocol";

export const NOTIFY_PREFIX = "[perzian]";

/** What happened to a child: its turn ended, it paused at a usage limit, or it resumed after one. */
export type ChildEvent = "finished" | "paused" | "resumed";

export interface ChildReport {
  id: string;
  title: string;
  status: SessionInfo["status"];
  outcome?: Pick<Outcome, "status" | "intent" | "proof" | "derived">;
  changedFiles: number;
  pause?: Pick<PauseInfo, "resumeAt" | "window" | "estimated" | "early">;
  /** Set by the notifier; absent means finished. */
  event?: ChildEvent;
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

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d${h}h` : h ? `${h}h${mm}m` : `${mm}m`;
}

/** "Sun 3:40 PM" in the daemon's (the developer's) time zone. */
export function clockTime(at: number, timeZone?: string): string {
  return new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

export function formatChildLine(c: ChildReport, now = Date.now(), timeZone?: string): string {
  const head = [`id=${c.id}`, `title="${clean(c.title, 48)}"`];
  if (c.event === "paused") {
    const parts = [...head, "status=paused"];
    if (c.pause) {
      parts.push(`resumes_at="${clockTime(c.pause.resumeAt, timeZone)}"`, `resumes_in=${c.pause.estimated ? "~" : ""}${duration(c.pause.resumeAt - now)}`);
      if (c.pause.window) parts.push(`limit=${c.pause.window}`);
      if (c.pause.early) parts.push("early=true");
    }
    parts.push(`files=${c.changedFiles}`);
    return `- ${parts.join(" ")}`;
  }
  if (c.event === "resumed") return `- ${[...head, "status=resumed", `files=${c.changedFiles}`].join(" ")}`;
  const parts = [...head, `status=${c.status}`];
  if (c.outcome) {
    parts.push(`outcome=${c.outcome.status}${c.outcome.derived ? "(derived)" : ""}`);
    parts.push(`proof=${proofSummary(c.outcome.proof)}`);
  } else parts.push("outcome=none");
  parts.push(`files=${c.changedFiles}`);
  if (c.outcome?.intent) parts.push(`intent="${clean(c.outcome.intent, 100)}"`);
  return `- ${parts.join(" ")}`;
}

const sessions = (n: number) => (n === 1 ? "a session" : `${n} sessions`);

/** `worker`: the recipient is a session that started these (not the lead), so it carries on with its own task. */
export function formatChildFinished(children: ChildReport[], now = Date.now(), timeZone?: string, audience: "lead" | "worker" = "lead"): string {
  const count = (e: ChildEvent) => children.filter((c) => (c.event ?? "finished") === e).length;
  // An early pause (near the limit, after its current step) isn't "hit the limit"; say which, so the lead doesn't.
  const near = children.filter((c) => c.event === "paused" && c.pause?.early).length;
  const what = [
    count("finished") && `${sessions(count("finished"))} finished`,
    count("paused") - near && `${sessions(count("paused") - near)} paused at a usage limit (resumes by itself; nothing to do)`,
    near && `${sessions(near)} paused just before a usage limit (resumes by itself; nothing to do)`,
    count("resumed") && `${sessions(count("resumed"))} resumed after a usage limit reset`,
  ].filter(Boolean);
  return [
    `${NOTIFY_PREFIX} Automatic update, not from the developer: ${what.join("; ")}.`,
    ...children.map((c) => formatChildLine(c, now, timeZone)),
    audience === "worker"
      ? "These are sessions you started. Carry on with your own task using the result; don't reply to the developer about this update."
      : "Reply to the developer in one short line (under 20 words): result, proof, what needs them. Don't start new work from this update; the developer decides what's next.",
  ].join("\n");
}

export interface NotifierDeps {
  /** True while the lead is mid-turn (working, or waiting on the developer). */
  busy(leadId: string): boolean;
  /** Current report for a child, or undefined when it's gone. */
  report(childId: string): ChildReport | undefined;
  deliver(leadId: string, text: string): void;
  notice(leadId: string, text: string): void;
  /** Who the recipient is; default "lead". */
  audience?(leadId: string): "lead" | "worker";
  /** Persistence of pending updates across restarts (see `filePersistence`); both optional. */
  load?(): PendingUpdates;
  save?(data: PendingUpdates): void;
  debounceMs?: number;
  maxAutoTurns?: number;
}

/** Pending updates as plain data: leadId -> child id -> event. */
export type PendingUpdates = Record<string, Record<string, ChildEvent>>;

/** Keeps pending updates in a small JSON file so a daemon restart doesn't lose them. Never throws. */
export function filePersistence(path: string): Pick<NotifierDeps, "load" | "save"> {
  return {
    load: () => {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as PendingUpdates;
        return raw && typeof raw === "object" ? raw : {};
      } catch {
        return {};
      }
    },
    save: (data) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(data));
      } catch {}
    },
  };
}

export class LeadNotifier {
  private pending = new Map<string, Map<string, ChildEvent>>(); // leadId -> child id -> latest event
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
    this.queue(leadId, childId, "finished");
  }

  /** A child paused at a usage limit, or resumed after one. Reported for any child: the lead should know
   * why its crew went quiet, whoever drove the turn. The child's turn isn't over, so `byLead` stays. */
  childPaused(leadId: string, childId: string): void {
    this.queue(leadId, childId, "paused");
  }

  childResumed(leadId: string, childId: string): void {
    this.queue(leadId, childId, "resumed");
  }

  private queue(leadId: string, childId: string, event: ChildEvent): void {
    let set = this.pending.get(leadId);
    if (!set) this.pending.set(leadId, (set = new Map()));
    // Latest wins, except that a finish isn't replaced by a pause/resume note.
    if (set.get(childId) !== "finished" || event === "finished") set.set(childId, event);
    this.persist();
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

  private persist(): void {
    if (!this.deps.save) return;
    const data: PendingUpdates = {};
    for (const [lead, ids] of this.pending) if (ids.size) data[lead] = Object.fromEntries(ids);
    this.deps.save(data);
  }

  /** After a restart: take back the updates saved before it and deliver them as soon as each lead is idle. */
  restore(): void {
    for (const [leadId, ids] of Object.entries(this.deps.load?.() ?? {})) {
      let set = this.pending.get(leadId);
      if (!set) this.pending.set(leadId, (set = new Map()));
      for (const [id, event] of Object.entries(ids)) if (!set.has(id)) set.set(id, event);
      this.ready.add(leadId);
      this.flush(leadId);
    }
  }

  /** The lead's turn ended; deliver anything that was held. */
  leadIdle(leadId: string): void {
    this.flush(leadId);
  }

  pendingFor(leadId: string): string[] {
    return [...(this.pending.get(leadId)?.keys() ?? [])];
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
    const reports: ChildReport[] = [];
    for (const [id, event] of ids) {
      const r = this.deps.report(id);
      if (r) reports.push({ ...r, event });
    }
    this.pending.delete(leadId);
    this.ready.delete(leadId);
    this.persist();
    if (!reports.length) return;
    this.autoTurns.set(leadId, n + 1);
    this.deps.deliver(leadId, formatChildFinished(reports, Date.now(), undefined, this.deps.audience?.(leadId)));
  }
}
