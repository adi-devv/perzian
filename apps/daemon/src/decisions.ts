import type { PendingDecision } from "./session.ts";

/** decision.answer: resolves an open decision once. A second answer (another device, a stale card on a phone that
 *  was offline, a double tap) finds nothing open and is refused, so the agent never gets two answers. */
export function answerDecision(decisions: Map<string, PendingDecision>, decisionId: string, optionId: string | null): void {
  const pending = decisions.get(decisionId);
  if (!pending) throw new Error("Already answered");
  if (optionId !== null && !pending.decision.options.some((o) => o.id === optionId)) throw new Error("That answer isn't one of the options");
  pending.resolve(optionId);
}
