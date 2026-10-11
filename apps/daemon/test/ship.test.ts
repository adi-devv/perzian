import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@perzian/protocol";
import { createWorktree, currentBranch } from "../src/git.ts";
import { assertPromptable, interruptedShip, isSensitive, remoteHost, ship, stageable, tail } from "../src/ship.ts";

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

  test("refuses while the agent is still at work, and an unknown method", async () => {
    const { project, info } = await setup();
    writeFileSync(join(info.cwd, "b.txt"), "b\n");
    for (const status of ["working", "needs_you", "paused"] as const) {
      const r = await ship({ ...info, status }, "merge", () => assert.fail("stopped"));
      assert.equal(r.state, "error", status);
      assert.match(r.detail ?? "", /Wait for/);
    }
    assert.match((await ship({ ...info, setup: { state: "running", copied: [], install: [] } } as SessionInfo, "pr", () => {})).detail ?? "", /still being set up/);
    await assert.rejects(ship(info, "rebase" as "merge", () => {}), /Unknown ship method/);
    assert.equal(git(project, "log", "--oneline").split("\n").length, 1, "nothing landed");
    assert.ok(existsSync(join(info.cwd, "b.txt")));
  });

  test("a session in the checkout itself has nothing to ship", async () => {
    const r = await ship({ worktree: false } as SessionInfo, "merge", () => {});
    assert.equal(r.state, "error");
  });

  test("merge leaves ignored and secret-looking files out of the commit", async () => {
    const { project, info } = await setup();
    writeFileSync(join(info.cwd, ".gitignore"), "build/\n");
    mkdirSync(join(info.cwd, "build"));
    writeFileSync(join(info.cwd, "build", "out.js"), "x\n");
    writeFileSync(join(info.cwd, ".env"), "SECRET=1\n");
    mkdirSync(join(info.cwd, "api"));
    writeFileSync(join(info.cwd, "api", ".env.local"), "TOKEN=2\n");
    writeFileSync(join(info.cwd, ".env.example"), "SECRET=\n");
    writeFileSync(join(info.cwd, "feature.ts"), "export {};\n");
    const r = await ship(info, "merge", () => {});
    assert.equal(r.state, "merged", r.detail);
    const landed = git(project, "ls-files").split("\n").sort();
    assert.deepEqual(landed, [".env.example", ".gitignore", "a.txt", "feature.ts"]);
    assert.match(r.detail ?? "", /Left out \.env, api\/\.env\.local/);
    assert.ok(existsSync(join(info.cwd, ".env")), "secret kept in the worktree, which stays");
  });

  test("open PR checks for a remote before pushing anything", async () => {
    const { info } = await setup();
    writeFileSync(join(info.cwd, "hello.txt"), "hi\n");
    const r = await ship(info, "pr", () => {});
    assert.equal(r.state, "error");
    assert.match(r.detail ?? "", /no origin remote/);
    assert.equal(git(info.cwd, "status", "--porcelain"), "?? hello.txt", "nothing committed or pushed");
  });

  test("merged sessions refuse prompts; an interrupted ship becomes retryable", () => {
    const merged = { worktree: true, ship: { state: "merged", how: "merge", into: "main", at: 1 } } as SessionInfo;
    assert.throws(() => assertPromptable(merged), /already merged into main/);
    assert.doesNotThrow(() => assertPromptable({ worktree: true, ship: { state: "pr", how: "pr", at: 1 } } as SessionInfo));
    const r = interruptedShip({ state: "shipping", how: "merge", at: 1 });
    assert.equal(r.state, "error");
    assert.match(r.detail ?? "", /Interrupted/);
  });
});

describe("ship helpers", () => {
  test("tail keeps error lines and the file lists under them", () => {
    const err = [
      "Updating 1a2b..3c4d",
      "error: Your local changes to the following files would be overwritten by merge:",
      "\tsrc/a.ts",
      "\tsrc/b.ts",
      "Please commit your changes or stash them before you merge.",
      "Aborting",
    ].join("\n");
    assert.equal(tail(err), "error: Your local changes to the following files would be overwritten by merge: src/a.ts src/b.ts");
    const push = "To github.com:o/r.git\n ! [rejected]        x -> x (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected\nhint: integrate the remote changes";
    assert.equal(tail(push), "! [rejected]        x -> x (fetch first) error: failed to push some refs");
    assert.equal(tail("a\nb\nc\nd"), "b c d");
  });

  test("stageable splits porcelain -z output and follows renames", () => {
    const out = ["?? new.ts", " M .env", "?? config/.env.production", "R  b.ts", "a.ts", "?? .env.example", " D gone.ts", "?? certs/server.pem", ""].join("\0");
    assert.deepEqual(stageable(out), { add: ["new.ts", "b.ts", "a.ts", ".env.example", "gone.ts"], skipped: [".env", "config/.env.production", "certs/server.pem"] });
  });

  test("isSensitive / remoteHost", () => {
    for (const p of [".env", "x/.env.local", "id_rsa", "k.key", ".npmrc"]) assert.ok(isSensitive(p), p);
    for (const p of [".env.example", "env.ts", "src/.envrc.md", "keys.ts"]) assert.ok(!isSensitive(p), p);
    assert.equal(remoteHost("git@github.com:o/r.git"), "github.com");
    assert.equal(remoteHost("https://github.com/o/r"), "github.com");
    assert.equal(remoteHost("ssh://git@ghe.corp.io:22/o/r.git"), "ghe.corp.io");
    assert.equal(remoteHost("/srv/repo.git"), undefined);
  });
});
