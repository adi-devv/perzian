import type { Decision, SessionInfo } from "./index.ts";
import type { State } from "./fold.ts";

/** One thing that needs the developer, across all sessions: the phone's first screen. Folded from State alone.
 *  decision: a permission or ask_decision card, answered with decision.answer.
 *  conflict: a merge stopped on conflicts. failed: the session stopped with a failure.
 *  conflict and failed drop out once the session is seen (session.seen) or its state moves on. */
export type InboxItem =
  | { kind: "decision"; key: string; sessionId: string; at: number; decision: Decision }
  | { kind: "conflict"; key: string; sessionId: string; at: number; files: string[]; into?: string }
  | { kind: "failed"; key: string; sessionId: string; at: number; why: string };

// Urgency: an agent blocked on you first (destructive asks before the rest), then work you'd lose track of.
const RANK = (i: InboxItem) => (i.kind === "decision" ? (i.decision.destructive ? 0 : 1) : i.kind === "conflict" ? 2 : 3);

/** Why a session failed, in one line: setup, checks, the agent's own failed outcome, or its last notice. */
export function failureLine(state: State, s: SessionInfo): string {
  if (s.setup?.state === "failed") return `Setup failed: ${s.setup.error?.command ?? "install"}`;
  const run = s.checkRun;
  if (run?.state === "failed") {
    const bad = run.results.filter((r) => r.state === "failed");
    return `Checks failed: ${bad.map((r) => (r.summary ? `${r.name} (${r.summary})` : r.name)).join(", ") || "see details"}`;
  }
  const out = state.outcomes[s.id];
  if (out?.status === "failed") return `Failed: ${out.intent}`;
  const items = state.transcripts[s.id] ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "notice") return firstLine(it.text);
    if (it.kind === "user") break;
  }
  return "Stopped with an error";
}

const firstLine = (t: string) => t.trim().split("\n")[0];

/** Everything that needs you, most urgent first, oldest first within the same urgency. */
export function inbox(state: State): InboxItem[] {
  const out: InboxItem[] = [];
  for (const d of Object.values(state.decisions)) {
    const s = state.sessions[d.sessionId];
    if (s?.archived) continue;
    out.push({ kind: "decision", key: `d:${d.id}`, sessionId: d.sessionId, at: d.createdAt, decision: d });
  }
  for (const s of Object.values(state.sessions)) {
    if (s.archived) continue;
    const seen = s.seenAt ?? 0;
    if (s.ship?.state === "conflict" && seen < s.ship.at) {
      out.push({ kind: "conflict", key: `c:${s.id}`, sessionId: s.id, at: s.ship.at, files: s.ship.files ?? [], into: s.ship.into });
    }
    if (s.status === "failed" && seen < s.updatedAt) {
      out.push({ kind: "failed", key: `f:${s.id}`, sessionId: s.id, at: s.updatedAt, why: failureLine(state, s) });
    }
  }
  return out.sort((a, b) => RANK(a) - RANK(b) || a.at - b.at);
}
