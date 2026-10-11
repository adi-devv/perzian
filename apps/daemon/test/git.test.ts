import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(): { root: string; repo: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "perzian-git-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  run(repo, "init", "-q");
  run(repo, "config", "user.email", "test@example.com");
  run(repo, "config", "user.name", "Test");
  run(repo, "config", "commit.gpgsign", "false");
  run(repo, "config", "core.hooksPath", join(root, "no-hooks"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "keep.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.txt"), "a\nb\n");
  writeFileSync(join(repo, "src", "old.ts"), "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "init");
  return { root, repo, base: run(repo, "rev-parse", "HEAD") };
}

describe("git helpers", () => {
  let root: string;
  let repo: string;
  let base: string;

  before(() => {
    ({ root, repo, base } = makeRepo());
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("isRepo / head / currentBranch", async () => {
    assert.equal(await git.isRepo(repo), true);
    assert.equal(await git.isRepo(root), false);
    assert.equal(await git.head(repo), base);
    assert.equal(await git.head(root), undefined);
    assert.equal(await git.currentBranch(repo), run(repo, "rev-parse", "--abbrev-ref", "HEAD"));
  });

  test("changes: clean tree has no changes", async () => {
    assert.deepEqual(await git.changes(repo, base), []);
  });

  test("changes: modified, added, deleted, renamed, untracked", async () => {
    writeFileSync(join(repo, "keep.txt"), "one\nTWO\nthree\nfour\n"); // +2 -1
    writeFileSync(join(repo, "staged.txt"), "s1\ns2\n");
    run(repo, "add", "staged.txt"); // added (tracked)
    unlinkSync(join(repo, "gone.txt")); // deleted -2
    run(repo, "mv", "src/old.ts", "src/new.ts"); // renamed, unchanged content
    writeFileSync(join(repo, "fresh.md"), "# hi\nline 2\nline 3\n"); // untracked, 3 lines
    writeFileSync(join(repo, "noeol.txt"), "x\ny"); // untracked, no trailing newline, 2 lines
    writeFileSync(join(repo, "ignored.log"), "nope\n"); // gitignored

    const files = await git.changes(repo, base);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.deepEqual(
      files.map((f) => f.path),
      ["fresh.md", "gone.txt", "keep.txt", "noeol.txt", "src/new.ts", "staged.txt"],
    );
    assert.deepEqual(by["keep.txt"], { path: "keep.txt", kind: "modified", additions: 2, deletions: 1 });
    assert.deepEqual(by["staged.txt"], { path: "staged.txt", kind: "added", additions: 2, deletions: 0 });
    assert.deepEqual(by["gone.txt"], { path: "gone.txt", kind: "deleted", additions: 0, deletions: 2 });
    assert.deepEqual(by["src/new.ts"], { path: "src/new.ts", kind: "renamed", additions: 0, deletions: 0 });
    // Untracked line counts should match what git reports once the file is added.
    assert.deepEqual(by["fresh.md"], { path: "fresh.md", kind: "added", additions: 3, deletions: 0 });
    assert.deepEqual(by["noeol.txt"], { path: "noeol.txt", kind: "added", additions: 2, deletions: 0 });
    assert.equal(by["ignored.log"], undefined);
  });

  test("changes: renamed with edits counts additions/deletions on the new path", async () => {
    writeFileSync(join(repo, "src", "new.ts"), "export const x = 1;\nexport const y = 20;\nexport const z = 3;\n");
    const f = (await git.changes(repo, base)).find((x) => x.path === "src/new.ts");
    assert.deepEqual(f, { path: "src/new.ts", kind: "renamed", additions: 1, deletions: 1 });
  });

  test("changes: committed work after base is still included", async () => {
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "work");
    const paths = (await git.changes(repo, base)).map((f) => f.path);
    assert.deepEqual(paths, ["fresh.md", "gone.txt", "keep.txt", "noeol.txt", "src/new.ts", "staged.txt"]);
  });

  test("fileDiff: tracked file shows a unified diff vs base", async () => {
    const d = await git.fileDiff(repo, base, "keep.txt");
    assert.match(d, /^diff --git a\/keep\.txt b\/keep\.txt/m);
    assert.match(d, /^-two$/m);
    assert.match(d, /^\+TWO$/m);
    assert.match(d, /^\+four$/m);
  });

  test("fileDiff: untracked file shows as all additions", async () => {
    writeFileSync(join(repo, "untracked.txt"), "hello\nworld\n");
    const d = await git.fileDiff(repo, base, "untracked.txt");
    assert.match(d, /new file mode/);
    assert.match(d, /^\+hello$/m);
    assert.match(d, /^\+world$/m);
  });

  test("fileDiff / fileContent reject paths outside cwd", async () => {
    await assert.rejects(git.fileDiff(repo, base, "../outside.txt"), /outside/);
    assert.throws(() => git.fileContent(repo, "../outside.txt"), /outside/);
    assert.throws(() => git.fileContent(repo, "/etc/hosts"), /outside/);
    assert.throws(() => git.fileContent(repo, "src/../../repo-sibling"), /outside/);
  });

  test("fileContent reads files inside cwd", () => {
    assert.equal(git.fileContent(repo, "keep.txt"), "one\nTWO\nthree\nfour\n");
    assert.equal(git.fileContent(repo + "/", "keep.txt"), "one\nTWO\nthree\nfour\n");
  });

  test("createWorktree creates perzian/<slug>-<id6> branch and directory", async () => {
    const home = join(root, "home");
    const id = "abcdef123456";
    const wt = await git.createWorktree(repo, home, "Fix: the Login bug!", id);
    assert.equal(wt.branch, "perzian/fix-the-login-bug-abcdef");
    assert.equal(wt.path, join(home, "worktrees", "repo", "fix-the-login-bug-abcdef"));
    assert.ok(existsSync(join(wt.path, ".git")));
    assert.equal(await git.currentBranch(wt.path), wt.branch);
    assert.equal(await git.head(wt.path), await git.head(repo));
    assert.match(run(repo, "worktree", "list"), /fix-the-login-bug-abcdef/);
    assert.deepEqual(await git.changes(wt.path, (await git.head(wt.path))!), []);
  });

  test("createWorktree falls back to 'task' for empty titles", async () => {
    const wt = await git.createWorktree(repo, join(root, "home"), "!!!", "999999xyz");
    assert.equal(wt.branch, "perzian/task-999999");
    assert.equal(wt.baseBranch, await git.currentBranch(repo));
  });

  test("fileContent refuses symlinks that point outside the worktree", () => {
    writeFileSync(join(root, "secret.txt"), "outside\n");
    symlinkSync(join(root, "secret.txt"), join(repo, "escape.txt"));
    symlinkSync(join(repo, "keep.txt"), join(repo, "inside-link.txt"));
    assert.throws(() => git.fileContent(repo, "escape.txt"), /outside/);
    assert.equal(git.fileContent(repo, "inside-link.txt"), "one\nTWO\nthree\nfour\n");
  });

  test("createWorktree refuses an empty repo and a detached HEAD with a clear reason", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    run(empty, "init", "-q");
    await assert.rejects(git.createWorktree(empty, join(root, "home"), "x", "111111"), /no commits yet/);

    run(repo, "checkout", "-q", "--detach");
    assert.equal(await git.currentBranch(repo), undefined);
    await assert.rejects(git.createWorktree(repo, join(root, "home"), "x", "222222"), /detached HEAD/);
    run(repo, "checkout", "-q", "-");
  });
});
