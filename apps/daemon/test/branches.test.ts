import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git.ts";
import { prepareWorkspace } from "../src/session.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function identify(dir: string, root: string) {
  run(dir, "config", "user.email", "test@example.com");
  run(dir, "config", "user.name", "Test");
  run(dir, "config", "commit.gpgsign", "false");
  run(dir, "config", "core.hooksPath", join(root, "no-hooks"));
}

function commit(dir: string, file: string, text = "x\n") {
  writeFileSync(join(dir, file), text);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", `add ${file}`);
}

/** A bare "origin" with main (one commit) and `develop` (one more), cloned into `project`, plus a second clone `other` to push from. */
function makeTeamRepo() {
  const root = mkdtempSync(join(tmpdir(), "perzian-branches-"));
  const origin = join(root, "origin.git");
  const project = join(root, "project");
  const other = join(root, "other");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(root, "clone", "-q", origin, other);
  identify(other, root);
  commit(other, "a.txt");
  run(other, "push", "-q", "origin", "main");
  run(other, "checkout", "-q", "-b", "develop");
  commit(other, "dev.txt");
  run(other, "push", "-q", "origin", "develop");
  run(other, "checkout", "-q", "main");
  run(root, "clone", "-q", origin, project);
  identify(project, root);
  return { root, origin, project, other };
}

describe("base resolution", () => {
  let t: ReturnType<typeof makeTeamRepo>;
  before(() => (t = makeTeamRepo()));
  after(() => rmSync(t.root, { recursive: true, force: true }));

  test("no base: the repo's default branch, cut from origin/<base> after a fetch", async () => {
    commit(t.other, "b.txt"); // origin/main moves past the project's local main
    run(t.other, "push", "-q", "origin", "main");
    const originMain = run(t.other, "rev-parse", "HEAD");
    assert.notEqual(run(t.project, "rev-parse", "main"), originMain);

    const start = await git.resolveBase(t.project);
    assert.deepEqual([start.base, start.from, start.sha, start.notice], ["main", "origin/main", originMain, undefined]);
    assert.notEqual(run(t.project, "rev-parse", "main"), originMain, "the developer's own main is never moved");
  });

  test("an explicit base is fetched and used; origin/ prefixes are accepted", async () => {
    const develop = run(t.other, "rev-parse", "develop");
    for (const asked of ["develop", "origin/develop"]) {
      const start = await git.resolveBase(t.project, asked);
      assert.deepEqual([start.base, start.from, start.sha], ["develop", "origin/develop", develop]);
    }
  });

  test("the worktree starts at that commit and records it", async () => {
    const ws = await prepareWorkspace(t.project, join(t.root, "home"), "Team task", "dddddd444", undefined, "develop");
    assert.equal(ws.worktree, true);
    assert.equal(ws.baseSha, run(t.other, "rev-parse", "develop"));
    assert.equal("baseBranch" in ws ? ws.baseBranch : undefined, "develop");
    assert.equal(run(ws.cwd, "rev-parse", "HEAD"), ws.baseSha);
  });

  test("offline: falls back to the local branch and says so", async () => {
    run(t.project, "remote", "set-url", "origin", join(t.root, "gone.git"));
    const local = await git.resolveBase(t.project, "main", { fetchTimeoutMs: 5000 });
    assert.deepEqual([local.base, local.from, local.sha], ["main", "main", run(t.project, "rev-parse", "main")]);
    assert.match(local.notice ?? "", /Couldn't fetch origin; started from your local main/);

    const ws = await prepareWorkspace(t.project, join(t.root, "home"), "Offline task", "eeeeee555", undefined, "main");
    assert.equal(ws.baseSha, local.sha);
    assert.match(("notice" in ws && ws.notice) || "", /local main/);

    // A branch that exists only on origin: the copy from the last fetch is the best there is.
    const remoteOnly = await git.resolveBase(t.project, "develop", { fetchTimeoutMs: 5000 });
    assert.equal(remoteOnly.from, "origin/develop");
    assert.match(remoteOnly.notice ?? "", /Couldn't fetch origin; started from origin\/develop as last fetched/);
    run(t.project, "remote", "set-url", "origin", t.origin);
  });

  test("a branch that doesn't exist, or isn't a valid name, is an error that names it", async () => {
    await assert.rejects(git.resolveBase(t.project, "nope"), /no branch named nope/);
    await assert.rejects(git.resolveBase(t.project, "-x"), /isn't a valid branch name/);
  });

  test("no origin at all: the local branch, no note", async () => {
    const root = mkdtempSync(join(tmpdir(), "perzian-nooriginn-"));
    try {
      run(root, "init", "-q", "-b", "main");
      identify(root, root);
      commit(root, "a.txt");
      const start = await git.resolveBase(root);
      assert.deepEqual([start.base, start.from, start.notice], ["main", "main", undefined]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stacking: another session's branch is used as it is locally, never fetched", async () => {
    const ws = await prepareWorkspace(t.project, join(t.root, "home"), "Parent task", "ffffff666", undefined, "develop");
    commit(ws.cwd, "parent.txt");
    const child = await git.resolveBase(t.project, ws.branch!);
    assert.deepEqual([child.base, child.from, child.sha, child.notice], [ws.branch, ws.branch, run(ws.cwd, "rev-parse", "HEAD"), undefined]);
  });

  test("listBranches: default first, origin-only branches included once", async () => {
    const list = await git.listBranches(t.project);
    assert.equal(list.repo, true);
    assert.equal(list.default, "main");
    assert.equal(list.branches[0], "main");
    assert.equal(list.branches.filter((b) => b === "develop").length, 1);
  });
});

describe("how far the base moved", () => {
  test("parseBehind reads a count and nothing else", () => {
    assert.equal(git.parseBehind("3\n"), 3);
    assert.equal(git.parseBehind("0"), 0);
    assert.equal(git.parseBehind(""), undefined);
    assert.equal(git.parseBehind("fatal: bad revision"), undefined);
    assert.equal(git.parseBehind("1 2"), undefined);
  });

  let t: ReturnType<typeof makeTeamRepo>;
  before(() => (t = makeTeamRepo()));
  after(() => rmSync(t.root, { recursive: true, force: true }));

  test("commits on origin/<base> that the session branch lacks, after a fetch", async () => {
    const ws = await prepareWorkspace(t.project, join(t.root, "home"), "Mover", "aaaaaa777");
    commit(ws.cwd, "mine.txt"); // the session's own commit never counts as behind
    assert.equal(await git.behindBase(ws.cwd, "main"), 0);

    commit(t.other, "one.txt");
    commit(t.other, "two.txt");
    run(t.other, "push", "-q", "origin", "main");
    assert.equal(await git.behindBase(ws.cwd, "main"), 0, "nothing is known until origin/main is fetched");
    assert.equal(await git.refreshBase(ws.cwd, "main"), true);
    assert.equal(await git.behindBase(ws.cwd, "main"), 2);

    run(ws.cwd, "merge", "-q", "--no-edit", "origin/main");
    assert.equal(await git.behindBase(ws.cwd, "main"), 0);
  });

  test("a stacked session is behind its parent's branch, with no fetch", async () => {
    const parent = await prepareWorkspace(t.project, join(t.root, "home"), "Parent", "bbbbbb888");
    const child = await prepareWorkspace(t.project, join(t.root, "home"), "Child", "cccccc999", undefined, parent.branch);
    assert.equal(await git.behindBase(child.cwd, parent.branch!), 0);
    assert.equal(await git.refreshBase(child.cwd, parent.branch!), false);
    commit(parent.cwd, "later.txt");
    assert.equal(await git.behindBase(child.cwd, parent.branch!), 1);
  });

  test("unknown base or failed fetch: undefined and false, never a throw", async () => {
    const ws = await prepareWorkspace(t.project, join(t.root, "home"), "Lost", "dddddd000");
    assert.equal(await git.behindBase(ws.cwd, "no-such-branch"), undefined);
    assert.equal(await git.refreshBase(ws.cwd, "no-such-branch"), false);
  });
});
