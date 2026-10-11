import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git.ts";
import { prepareWorkspace } from "../src/session.ts";

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

describe("prepareWorkspace", () => {
  let root: string;
  let repo: string;
  before(() => ({ root, repo } = makeRepo()));
  after(() => rmSync(root, { recursive: true, force: true }));

  test("every task gets its own worktree by default, even a single one", async () => {
    const ws = await prepareWorkspace(repo, join(root, "home"), "One task", "aaaaaa111");
    assert.equal(ws.worktree, true);
    assert.notEqual(ws.cwd, repo);
    assert.equal(ws.branch, "perzian/one-task-aaaaaa");
    assert.equal("baseBranch" in ws ? ws.baseBranch : undefined, await git.currentBranch(repo));
  });

  test("worktree: false works in the checkout, on the developer's branch", async () => {
    const ws = await prepareWorkspace(repo, join(root, "home"), "In place", "bbbbbb222", false);
    assert.deepEqual([ws.cwd, ws.worktree, ws.branch], [repo, false, await git.currentBranch(repo)]);
  });

  test("a folder that isn't a repo is used as is", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const ws = await prepareWorkspace(plain, join(root, "home"), "x", "cccccc333");
    assert.deepEqual([ws.cwd, ws.worktree, ws.branch], [plain, false, undefined]);
  });
});

describe("git observation helpers", () => {
  let root: string;
  let repo: string;
  let base: string;
  before(() => {
    ({ root, repo, base } = makeRepo());
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("parseWorktrees reads the porcelain list", () => {
    const list = git.parseWorktrees("worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r-side\nHEAD def\ndetached\n\nworktree /gone\nHEAD 000\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n");
    assert.deepEqual(list.map((w) => [w.path, w.branch, w.prunable]), [["/r", "main", undefined], ["/r-side", undefined, undefined], ["/gone", "x", true]]);
  });

  test("worktrees lists the main one first, then ones added by hand", async () => {
    const side = join(root, "side");
    run(repo, "worktree", "add", "-q", "-b", "side", side);
    const list = await git.worktrees(repo);
    assert.equal(list.length, 2);
    assert.equal(git.realish(list[0].path), git.realish(repo));
    assert.equal(list[1].branch, "side");
    assert.equal((await git.worktrees(side)).length, 2, "same list from inside the other worktree");
  });

  test("aheadCount, isAncestor, mergeBase", async () => {
    assert.equal(await git.aheadCount(repo, base), 0);
    writeFileSync(join(repo, "n.txt"), "n\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "next");
    assert.equal(await git.aheadCount(repo, base), 1);
    assert.equal(await git.isAncestor(repo, base, "HEAD"), true);
    assert.equal(await git.isAncestor(repo, "HEAD", base), false);
    assert.equal(await git.isAncestor(repo, "deadbeef", "HEAD"), undefined);
    assert.equal(await git.mergeBase(repo, "HEAD", base), base);
  });

  test("upstreamState: none, then pushed, then ahead of the upstream", async () => {
    assert.deepEqual(await git.upstreamState(repo), { upstream: false, unpushed: 0 });
    const remote = join(root, "remote.git");
    run(root, "init", "-q", "--bare", remote);
    run(repo, "remote", "add", "origin", remote);
    run(repo, "push", "-q", "-u", "origin", "HEAD");
    assert.deepEqual(await git.upstreamState(repo), { upstream: true, unpushed: 0 });
    writeFileSync(join(repo, "m.txt"), "m\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "more");
    assert.deepEqual(await git.upstreamState(repo), { upstream: true, unpushed: 1 });
  });

  test("realish resolves symlinks of the nearest existing folder", () => {
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, "ln"));
    assert.equal(git.realish(join(root, "ln", "new", "f.ts")), join(git.realish(real), "new", "f.ts"));
  });
});

describe("leftoverWorktrees", () => {
  test("lists worktree folders no live session works in", () => {
    const home = mkdtempSync(join(tmpdir(), "perzian-left-"));
    try {
      const wt = (name: string) => {
        const p = join(home, "worktrees", "app", name);
        mkdirSync(p, { recursive: true });
        return p;
      };
      const live = wt("live-aaaaaa"), archived = wt("archived-bbbbbb"), merged = wt("merged-cccccc");
      wt("orphan-dddddd");
      const sessions = [
        { id: "1", cwd: live, worktree: true },
        { id: "2", cwd: archived, worktree: true, archived: true },
        { id: "3", cwd: merged, worktree: true, ship: { state: "merged" as const, how: "merge" as const, at: 0 } },
      ];
      const left = git.leftoverWorktrees(home, sessions);
      assert.deepEqual(left.map((l) => [l.name, l.sessionId]).sort(), [["archived-bbbbbb", "2"], ["merged-cccccc", "3"], ["orphan-dddddd", undefined]]);
      assert.equal(left[0].repo, "app");
      assert.ok(left[0].at);
      // A real linked worktree reports its branch and the safe removal command.
      const repo = join(home, "repo");
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: repo });
      const linked = join(home, "worktrees", "app", "real-eeeeee");
      execFileSync("git", ["worktree", "add", "-q", "-b", "perzian/real", linked], { cwd: repo });
      const real = git.leftoverWorktrees(home, []).find((l) => l.name === "real-eeeeee");
      assert.equal(real?.branch, "perzian/real");
      assert.ok(real?.project?.endsWith("repo"));
      assert.match(real?.command ?? "", /^git -C \S+repo worktree remove \S+real-eeeeee$/);
      assert.deepEqual(git.leftoverWorktrees(join(home, "nope"), sessions), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
