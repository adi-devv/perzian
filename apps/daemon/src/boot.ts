import type { PerzianEvent, SessionInfo, State } from "@perzian/protocol";
import { interruptedShip } from "./ship.ts";

const OPEN_TOOL = (status: string) => status !== "completed" && status !== "failed" && status !== "cancelled";

export const INTERRUPTED_TURN = "Interrupted: the daemon restarted during this turn";
export const INTERRUPTED_DECISION = "Interrupted: the daemon restarted while waiting for your answer";

/**
 * What a restart leaves behind, closed out: sessions come back dormant, and anything that was mid-flight
 * is marked so the developer sees it (`interrupted`, which counts as needing them) instead of a quiet idle.
 *
 * Open decisions are closed, not restored. The permission request (or the ask_decision MCP call) was a call
 * from the agent's adapter process, which died with the daemon; ACP loadSession brings back the conversation
 * but not the turn that was waiting, so nothing would receive an answer. Each one leaves a line in the
 * transcript, and Retry re-sends the last message so the agent asks again.
 */
export function interruptions(state: State, now = Date.now()): PerzianEvent[] {
  const out: PerzianEvent[] = [];
  const asking = new Set<string>();
  for (const d of Object.values(state.decisions)) {
    asking.add(d.sessionId);
    out.push({ type: "decision.resolved", decisionId: d.id, sessionId: d.sessionId, optionId: null });
    out.push({ type: "session.transcript", sessionId: d.sessionId, item: { kind: "decision", decisionId: d.id, source: d.source, question: d.question, ...(d.detail ? { detail: d.detail } : {}), answer: null, restarted: true, at: now } });
  }
  for (const info of Object.values(state.sessions)) {
    if (info.archived) continue;
    const sessionId = info.id;
    const patch = (p: Partial<SessionInfo>) => out.push({ type: "session.updated", sessionId, patch: p });
    if (info.live) patch({ live: false });
    for (const t of state.transcripts[sessionId] ?? []) {
      if (t.kind === "tool" && OPEN_TOOL(t.status)) out.push({ type: "session.transcript", sessionId, item: { ...t, status: "cancelled", at: now } });
    }
    const run = info.checkRun;
    if (run && (run.state === "running" || run.state === "fixing")) {
      const results = run.results.map((r) => (r.state === "running" ? { ...r, state: "pending" as const } : r));
      patch({ checkRun: { ...run, state: "cancelled", results, at: now } });
    }
    let during: NonNullable<SessionInfo["interrupted"]>["during"] | undefined;
    // A worktree setup the restart cut short: Retry / Start anyway (the setup bar says why), rather than spin forever.
    if (info.setup?.state === "running") {
      const setup = { ...info.setup, state: "failed" as const, error: { command: info.setup.current ?? "setup", tail: "Interrupted: the daemon restarted during setup." }, at: now };
      delete setup.current;
      patch({ setup });
      during = "setup";
    } else if (info.status === "working" || info.status === "needs_you") {
      const waiting = asking.has(sessionId);
      out.push({ type: "session.transcript", sessionId, item: { kind: "notice", text: waiting ? INTERRUPTED_DECISION : INTERRUPTED_TURN, at: now } });
      during = waiting ? "decision" : "turn";
    }
    if (info.status === "working" || info.status === "needs_you") out.push({ type: "session.status", sessionId, status: "idle", at: now });
    if (info.ship?.state === "shipping") {
      patch({ ship: interruptedShip(info.ship) });
      during ??= "ship";
    }
    if (during) patch({ interrupted: { during, at: now } });
  }
  return out;
}
