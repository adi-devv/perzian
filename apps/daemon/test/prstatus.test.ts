import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store.ts";
import { AgentSession, type SessionDeps } from "../src/session.ts";
import { fixCiPrompt, parsePrView, summarizeChecks, toPrStatus, updateBasePrompt, type PrView } from "../src/prstatus.ts";

const run_ = (name: string, status: string, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion });
const ctx = (context: string, state: string) => ({ __typename: "StatusContext", context, state });

describe("statusCheckRollup -> summary", () => {
  test("all done and fine is passing; skipped and neutral count as fine", () => {
    assert.deepEqual(summarizeChecks([run_("lint", "COMPLETED", "SUCCESS"), run_("e2e", "COMPLETED", "SKIPPED"), run_("docs", "COMPLETED", "NEUTRAL"), ctx("deploy", "SUCCESS")]), { checks: "passing", failing: [] });
  });

  test("any failure wins over pending, and the failing names are listed once each", () => {
    const s = summarizeChecks([run_("test", "COMPLETED", "FAILURE"), run_("build", "IN_PROGRESS"), run_("lint", "COMPLETED", "TIMED_OUT"), ctx("ci/legacy", "ERROR"), run_("test", "COMPLETED", "FAILURE"), run_("ok", "COMPLETED", "SUCCESS")]);
    assert.deepEqual(s, { checks: "failing", failing: ["test", "lint", "ci/legacy"] });
  });

  test("anything still running or queued is pending", () => {
    assert.equal(summarizeChecks([run_("a", "COMPLETED", "SUCCESS"), run_("b", "QUEUED")]).checks, "pending");
    assert.equal(summarizeChecks([run_("a", "IN_PROGRESS")]).checks, "pending");
    assert.equal(summarizeChecks([ctx("x", "PENDING")]).checks, "pending");
    assert.equal(summarizeChecks([run_("a", "COMPLETED", "ACTION_REQUIRED")]).checks, "pending");
  });

  test("no checks, or something that isn't a list, is none", () => {
    assert.deepEqual(summarizeChecks([]), { checks: "none", failing: [] });
    assert.deepEqual(summarizeChecks(undefined), { checks: "none", failing: [] });
    assert.deepEqual(summarizeChecks(null), { checks: "none", failing: [] });
    assert.deepEqual(summarizeChecks("nope"), { checks: "none", failing: [] });
  });

  test("a cancelled run (usually superseded) neither fails nor passes", () => {
    assert.equal(summarizeChecks([run_("a", "COMPLETED", "CANCELLED")]).checks, "none");
    assert.equal(summarizeChecks([run_("a", "COMPLETED", "CANCELLED"), run_("b", "COMPLETED", "SUCCESS")]).checks, "passing");
  });
});

describe("gh pr view -> PrStatus", () => {
  const view = (over: Partial<PrView> = {}): PrView => ({ url: "https://github.com/o/r/pull/7", state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [], ...over });

  test("parsePrView needs a url and a state", () => {
    assert.deepEqual(parsePrView('{"url":"u","state":"OPEN"}'), { url: "u", state: "OPEN" });
    assert.equal(parsePrView('{"state":"OPEN"}'), undefined);
    assert.equal(parsePrView("null"), undefined);
  });

  test("open: checks, review decision and conflicts", () => {
    const pr = toPrStatus(view({ statusCheckRollup: [run_("test", "COMPLETED", "FAILURE")], reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }));
    assert.deepEqual(pr, { state: "open", url: "https://github.com/o/r/pull/7", checks: "failing", failing: ["test"], review: "changes_requested", conflicting: true });
    assert.equal(toPrStatus(view({ reviewDecision: "APPROVED" })).review, "approved");
    assert.equal(toPrStatus(view({ reviewDecision: "REVIEW_REQUIRED" })).review, "review_required");
    assert.equal("review" in toPrStatus(view()), false);
    assert.equal("conflicting" in toPrStatus(view({ mergeable: "UNKNOWN" })), false);
  });

  test("merged and closed drop the checks and review: they're history", () => {
    const rollup = [run_("test", "COMPLETED", "FAILURE")];
    assert.deepEqual(toPrStatus(view({ state: "MERGED", statusCheckRollup: rollup, reviewDecision: "APPROVED" })), { state: "merged", url: "https://github.com/o/r/pull/7", checks: "none", failing: [] });
    assert.equal(toPrStatus(view({ state: "CLOSED" })).state, "closed");
  });
});

describe("the prompts the buttons send", () => {
  test("Update asks for a fetch and a merge or rebase of origin/<base>, conflicts included", () => {
    const p = updateBasePrompt("develop", 3);
    assert.match(p, /develop has 3 new commits/);
    assert.match(p, /git fetch origin develop/);
    assert.match(p, /Merge origin\/develop into this branch \(or rebase/);
    assert.match(p, /conflicts, resolve them/);
    assert.match(updateBasePrompt("main", 1), /1 new commit that/);
  });

  test("Update on a stacked session merges the parent's local branch, no fetch", () => {
    const p = updateBasePrompt("perzian/parent-aaaaaa", 2);
    assert.doesNotMatch(p, /git fetch/);
    assert.match(p, /Merge perzian\/parent-aaaaaa into this branch/);
  });

  test("Ask agent to fix CI names the failing checks and how to read their logs", () => {
    const p = fixCiPrompt(["test", "lint"], "https://github.com/o/r/pull/7");
    assert.match(p, /pull\/7/);
    assert.match(p, /- test\n- lint/);
    assert.match(p, /gh run view --log-failed/);
    assert.match(fixCiPrompt([]), /gh pr checks/);
  });
});

// ---- Folded into the session: PR state and base-moved, from a real repo with a fake gh ----

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a session folds PR state and base-moved into git", () => {
  let root: string;
  let origin: string;
  let other: string;
  let project: string;
  let n = 0;
  const stores: EventStore[] = [];
  const identify = (dir: string) => {
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "core.hooksPath", join(root, "no-hooks"));
  };
  const commit = (dir: string, file: string) => {
    writeFileSync(join(dir, file), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", file);
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "perzian-prstate-"));
    origin = join(root, "origin.git");
    other = join(root, "other");
    project = join(root, "project");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, other);
    identify(other);
    commit(other, "a.txt");
    git(other, "push", "-q", "origin", "main");
    git(root, "clone", "-q", origin, project);
    identify(project);
    git(project, "checkout", "-q", "-b", "feature");
    commit(project, "feature.txt");
  });
  after(() => {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  });

  function session(over: Partial<SessionDeps> = {}) {
    const dir = join(root, `home-${++n}`);
    mkdirSync(dir);
    const store = new EventStore(dir, { compact: "never" });
    stores.push(store);
    const deps: SessionDeps = { store, daemonUrl: "http://127.0.0.1:1", decisions: new Map(), ...over };
    const s = AgentSession.create({ project, cwd: project, title: "Feature", agent: "claude-code", branch: "feature", worktree: true, baseBranch: "main", baseSha: git(project, "rev-parse", "main") }, deps);
    return s;
  }

  test("the PR's state, failing checks and review land in info.git; prUrl only while open", async () => {
    let view: PrView = { url: "https://github.com/o/r/pull/7", state: "OPEN", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [run_("test", "COMPLETED", "FAILURE"), run_("lint", "COMPLETED", "SUCCESS")] };
    const asked: (string | undefined)[] = [];
    const s = session({ prLookup: async (_cwd, branch) => (asked.push(branch), view), baseFetch: async () => false });
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 50)); // the PR lookup runs after the repo read
    assert.deepEqual(asked, ["feature"]);
    assert.deepEqual(s.info.git?.pr, { state: "open", url: view.url, checks: "failing", failing: ["test"], review: "review_required" });
    assert.equal(s.info.git?.prUrl, view.url);
    assert.equal(s.info.git?.ahead, 1);

    // At most once a minute: a second read right away doesn't ask gh again.
    view = { ...view, statusCheckRollup: [run_("test", "COMPLETED", "SUCCESS")] };
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(asked.length, 1);
    s.dispose();
  });

  test("a PR that gh reports merged is Merged, and polling stops", async () => {
    let calls = 0;
    const s = session({ prLookup: async () => (calls++, { url: "https://github.com/o/r/pull/8", state: "MERGED" }), baseFetch: async () => false });
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(s.info.git?.pr, { state: "merged", url: "https://github.com/o/r/pull/8", checks: "none", failing: [] });
    assert.equal(s.info.git?.prUrl, undefined);
    await s.refreshRepo();
    assert.equal(calls, 1);
    s.dispose();
  });

  test("gh failing (offline, signed out) changes nothing", async () => {
    const s = session({ prLookup: async () => undefined, baseFetch: async () => false });
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.info.git?.pr, undefined);
    s.dispose();
  });

  test("base moved: commits on origin/<base> the branch lacks; fetched at most every 2 minutes", async () => {
    let fetches = 0;
    const s = session({ prLookup: async () => undefined, baseFetch: async (cwd, base) => (fetches++, (await import("../src/git.ts")).refreshBase(cwd, base)) });
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fetches, 1);
    assert.equal(s.info.git?.behind, undefined, "nothing new on origin yet");

    commit(other, "b.txt");
    commit(other, "c.txt");
    git(other, "push", "-q", "origin", "main");
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fetches, 1, "inside the 2 minute window: no new fetch");
    assert.equal(s.info.git?.behind, undefined);

    (s as unknown as { lastBaseFetch: number }).lastBaseFetch = Date.now() - 121_000;
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fetches, 2);
    assert.equal(s.info.git?.behind, 2);

    git(project, "merge", "-q", "--no-edit", "origin/main"); // the agent updated the branch
    await s.refreshRepo();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.info.git?.behind, undefined, "the count drops as soon as the base is merged in");
    s.dispose();
  });
});
