import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@perzian/protocol";
import { createWorktree, currentBranch } from "../src/git.ts";
import { ship } from "../src/ship.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function setup(title = "Add greeting") {
  const project = mkdtempSync(join(tmpdir(), "pz-ship-"));
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "a.txt"), "one\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");
  const home = mkdtempSync(join(tmpdir(), "pz-home-"));
  const wt = await createWorktree(project, home, title, "abcdef123");
  const info = { id: "s1", role: "worker", title, project, cwd: wt.path, branch: wt.branch, worktree: true, baseBranch: await currentBranch(project), agent: "claude-code", status: "done", createdAt: 0, updatedAt: 0 } as SessionInfo;
  return { project, info };
}

describe("ship", () => {
  test("merge commits leftovers, merges into the base branch and removes the worktree", async () => {
    const { project, info } = await setup();
    writeFileSync(join(info.cwd, "hello.txt"), "hi\n");
    let stopped = false;
    const r = await ship(info, "merge", () => (stopped = true));
    assert.equal(r.state, "merged", r.detail);
    assert.equal(r.into, "main");
    assert.ok(stopped);
    assert.equal(readFileSync(join(project, "hello.txt"), "utf8"), "hi\n");
    assert.ok(!existsSync(info.cwd), "worktree removed");
    assert.equal(git(project, "branch", "--list", info.branch!), "", "merged branch deleted");
  });

  test("a conflict aborts the merge and names the files", async () => {
    const { project, info } = await setup();
    writeFileSync(join(info.cwd, "a.txt"), "theirs\n");
    writeFileSync(join(project, "a.txt"), "ours\n");
    git(project, "commit", "-qam", "ours");
    const r = await ship(info, "merge", () => {});
    assert.equal(r.state, "conflict");
    assert.deepEqual(r.files, ["a.txt"]);
    assert.equal(git(project, "status", "--porcelain"), "", "checkout left clean");
    assert.ok(existsSync(info.cwd), "worktree kept to resolve");
  });

  test("refuses a dirty checkout, the wrong branch, and an empty branch", async () => {
    const { project, info } = await setup();
    assert.match((await ship(info, "merge", () => {})).detail ?? "", /no new commits/);
    writeFileSync(join(info.cwd, "b.txt"), "b\n");
    writeFileSync(join(project, "a.txt"), "local edit\n");
    assert.match((await ship(info, "merge", () => {})).detail ?? "", /uncommitted changes/);
    git(project, "checkout", "-q", "-b", "other");
    assert.match((await ship(info, "merge", () => {})).detail ?? "", /started from main/);
  });

  test("a session in the checkout itself has nothing to ship", async () => {
    const r = await ship({ worktree: false } as SessionInfo, "merge", () => {});
    assert.equal(r.state, "error");
  });
});
