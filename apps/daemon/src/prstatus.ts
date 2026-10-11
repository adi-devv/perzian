// A pull request as `gh pr view --json …` reports it, folded into the PrStatus the UI shows, plus the
// two prompts the session's buttons send to its agent. Pure, so tests never touch gh or git.
import type { PrStatus } from "@perzian/protocol";

export const PR_FIELDS = "url,state,mergeable,statusCheckRollup,reviewDecision";

/** The parts of `gh pr view` output we read. Only url and state are required (older callers and tests give just those). */
export interface PrView {
  url: string;
  state: string;
  mergeable?: string;
  reviewDecision?: string;
  statusCheckRollup?: unknown;
}

/** `gh pr view --json …` output; undefined when it isn't a PR (no url or state). */
export function parsePrView(json: string): PrView | undefined {
  const v = JSON.parse(json) as Partial<PrView> | null;
  return v && typeof v.url === "string" && typeof v.state === "string" ? (v as PrView) : undefined;
}

type Checks = Pick<PrStatus, "checks" | "failing">;

const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);
const FINE = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * statusCheckRollup is a list of CheckRuns ({ name, status, conclusion }) and commit StatusContexts
 * ({ context, state }). Any failure wins, then anything still running, else passing. A cancelled run is
 * usually a superseded one, so it counts for nothing; one that needs an action counts as still pending.
 */
export function summarizeChecks(rollup: unknown): Checks {
  if (!Array.isArray(rollup)) return { checks: "none", failing: [] };
  const failing: string[] = [];
  let pending = 0;
  let fine = 0;
  for (const raw of rollup) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { name?: unknown; context?: unknown; status?: unknown; conclusion?: unknown; state?: unknown };
    const name = String(c.name ?? c.context ?? "check");
    const status = typeof c.status === "string" ? c.status.toUpperCase() : "";
    const result = String((typeof c.conclusion === "string" && c.conclusion) || c.state || "").toUpperCase();
    if (FAILED.has(result)) failing.push(name);
    else if ((status && status !== "COMPLETED") || result === "PENDING" || result === "EXPECTED" || result === "ACTION_REQUIRED" || (!status && !result)) pending++;
    else if (FINE.has(result)) fine++;
  }
  const names = [...new Set(failing)];
  if (names.length) return { checks: "failing", failing: names };
  if (pending) return { checks: "pending", failing: [] };
  return { checks: fine ? "passing" : "none", failing: [] };
}

const REVIEW: Record<string, NonNullable<PrStatus["review"]>> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

/** The PR's state, checks and review, as the session stores them. */
export function toPrStatus(v: PrView): PrStatus {
  const state = v.state.toUpperCase() === "MERGED" ? "merged" : v.state.toUpperCase() === "OPEN" ? "open" : "closed";
  const review = REVIEW[(v.reviewDecision ?? "").toUpperCase()];
  return {
    state,
    url: v.url,
    // Checks of a finished PR are history; only an open PR's are worth a chip.
    ...(state === "open" ? summarizeChecks(v.statusCheckRollup) : { checks: "none" as const, failing: [] }),
    ...(review && state === "open" ? { review } : {}),
    ...(state === "open" && (v.mergeable ?? "").toUpperCase() === "CONFLICTING" ? { conflicting: true } : {}),
  };
}

/** "Update" on a session whose base moved: the agent merges or rebases it, so conflicts are its to handle. */
export function updateBasePrompt(base: string, behind?: number): string {
  const ref = base.startsWith("perzian/") ? base : `origin/${base}`;
  const n = behind ? `${behind} new commit${behind === 1 ? "" : "s"}` : "new commits";
  return [
    `${base} has ${n} that this branch doesn't have yet. Bring them in now:`,
    ...(base.startsWith("perzian/") ? [] : [`1. Run \`git fetch origin ${base}\`.`]),
    `${base.startsWith("perzian/") ? "1" : "2"}. Merge ${ref} into this branch (or rebase onto it if the work is unpushed and a linear history is cleaner).`,
    "If there are conflicts, resolve them, keeping both sides' intent, then run the project's checks and fix anything the merge broke.",
    "Don't force-push or touch any other branch.",
  ].join("\n");
}

/** "Ask agent to fix CI": the failing checks by name, and how to read their logs. */
export function fixCiPrompt(failing: string[], url?: string): string {
  const list = failing.length ? failing.map((n) => `- ${n}`).join("\n") : "- (a check on the PR; find which one with `gh pr checks`)";
  return [
    `CI is failing on${url ? ` ${url}` : " this branch's pull request"}. Failing checks:`,
    list,
    "Read the failures with `gh run view --log-failed` (find the run with `gh run list --branch <this branch>`; `gh pr checks` lists them).",
    "Find the cause, fix it, run the same checks locally to confirm, then commit and push to this branch.",
  ].join("\n");
}
