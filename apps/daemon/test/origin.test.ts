import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corsOrigin, trustedOrigin, webOrigins } from "../src/origin.ts";
import { checkProject } from "../src/doctor.ts";

describe("trustedOrigin", () => {
  test("the desktop app, the web UI on 4318 (any loopback spelling) and non-browser clients", () => {
    for (const o of [undefined, "null", "file://", "http://localhost:4318", "http://127.0.0.1:4318", "http://[::1]:4318"]) assert.ok(trustedOrigin(o), String(o));
  });

  test("not other localhost ports, other hosts, or look-alikes", () => {
    for (const o of ["http://localhost:3000", "http://127.0.0.1:8080", "http://localhost", "https://evil.com", "http://localhost:4318.evil.com", "http://localhost:43180"]) assert.ok(!trustedOrigin(o), o);
  });

  test("PERZIAN_WEB_URL adds its origin only when it's on this machine", () => {
    assert.ok(trustedOrigin("http://localhost:5555", webOrigins({ PERZIAN_WEB_URL: "http://localhost:5555/app" })));
    assert.ok(!trustedOrigin("https://example.com", webOrigins({ PERZIAN_WEB_URL: "https://example.com" })));
  });

  test("corsOrigin echoes trusted browser origins only", () => {
    assert.equal(corsOrigin("null"), "null");
    assert.equal(corsOrigin("http://[::1]:4318"), "http://[::1]:4318");
    assert.equal(corsOrigin("http://localhost:3000"), undefined);
    assert.equal(corsOrigin(undefined), undefined);
  });
});

describe("doctor checkProject", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

  test("flags a repo with no commits, and a detached HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pz-doc-"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    let p = await checkProject(repo);
    assert.ok(p.gitRoot);
    assert.equal(p.noCommits, true);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "init");
    p = await checkProject(repo);
    assert.equal(p.noCommits, undefined);
    assert.equal(p.detached, undefined);
    git(repo, "checkout", "-q", "--detach");
    assert.equal((await checkProject(repo)).detached, true);
    assert.equal((await checkProject(dir)).gitRoot, undefined);
  });
});
