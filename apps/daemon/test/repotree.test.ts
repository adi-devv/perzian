import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoTree, parseLsTree, repoTree } from "../src/repotree.ts";

describe("buildRepoTree", () => {
  test("folders sum their files; children biggest first", () => {
    const t = buildRepoTree([["src/a.ts", 10], ["src/lib/b.ts", 30], ["README.md", 5]], "repo");
    assert.equal(t.name, "repo");
    assert.equal(t.size, 45);
    assert.equal(t.files, 3);
    assert.deepEqual(t.children?.map((c) => c.name), ["src", "README.md"]);
    const src = t.children![0];
    assert.equal(src.size, 40);
    assert.equal(src.files, 2);
    assert.deepEqual(src.children?.map((c) => c.name), ["lib", "a.ts"]);
    assert.equal(src.children![1].children, undefined, "a file has no children");
  });
  test("empty and odd entries", () => {
    const t = buildRepoTree([["", 3], ["x", Number.NaN], ["y", -4]]);
    assert.equal(t.size, 0);
    assert.equal(t.files, 2);
  });
});

test("parseLsTree keeps blobs with their sizes, skips submodules", () => {
  const text = ["100644 blob abc     12\tsrc/a b.ts", "160000 commit def       -\tvendor/sub", "100755 blob 123      7\tbin/run", ""].join("\0");
  assert.deepEqual([...parseLsTree(text)], [["src/a b.ts", 12], ["bin/run", 7]]);
});

test("repoTree reads a real repo: tracked and untracked, not ignored", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pz-tree-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  run("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "x".repeat(100));
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "src", "new.ts"), "y".repeat(40));
  writeFileSync(join(repo, "debug.log"), "ignored");
  const t = await repoTree(repo);
  const src = t.children?.find((c) => c.name === "src");
  assert.deepEqual(src?.children?.map((c) => [c.name, c.size]), [["a.ts", 100], ["new.ts", 40]]);
  assert.ok(!t.children?.some((c) => c.name === "debug.log"));
  assert.equal(t.files, 3); // .gitignore, src/a.ts, src/new.ts
});
