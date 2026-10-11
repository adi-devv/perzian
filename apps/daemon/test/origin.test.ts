import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corsOrigin, loadDesktopToken, trustedOrigin, webOrigins } from "../src/origin.ts";
import { checkProject } from "../src/doctor.ts";

describe("trustedOrigin", () => {
  const key = "a".repeat(48);
  const web = webOrigins({});

  test("the web UI on 4318 (any loopback spelling) and non-browser clients", () => {
    for (const o of [undefined, "http://localhost:4318", "http://127.0.0.1:4318", "http://[::1]:4318"]) assert.ok(trustedOrigin(o), String(o));
  });

  test("file:// and origin null (any sandboxed iframe) only with the desktop token", () => {
    for (const o of ["null", "file://"]) {
      assert.ok(trustedOrigin(o, key, web, key), o);
      assert.ok(!trustedOrigin(o, undefined, web, key), `${o} without a token`);
      assert.ok(!trustedOrigin(o, "b".repeat(48), web, key), `${o} with the wrong token`);
      assert.ok(!trustedOrigin(o, key.slice(1), web, key), `${o} with a shorter token`);
      assert.ok(!trustedOrigin(o, "é".repeat(48), web, key), `${o} with a same-length non-ASCII token`);
      assert.ok(!trustedOrigin(o, "", web, ""), `${o} when no token was loaded`);
    }
    // The token doesn't open other origins.
    assert.ok(!trustedOrigin("https://evil.com", key, web, key));
  });

  test("loadDesktopToken creates a private token once and reuses it", () => {
    const home = join(mkdtempSync(join(tmpdir(), "pz-tok-")), "home");
    const t = loadDesktopToken(home);
    assert.match(t, /^[0-9a-f]{48}$/);
    assert.equal(statSync(join(home, "desktop-token")).mode & 0o777, 0o600);
    assert.equal(loadDesktopToken(home), t);
    assert.equal(readFileSync(join(home, "desktop-token"), "utf8"), t);
    assert.ok(trustedOrigin("null", t));
    writeFileSync(join(home, "desktop-token"), "short");
    assert.notEqual(loadDesktopToken(home), "short", "a weak token is replaced");
  });

  test("not other localhost ports, other hosts, or look-alikes", () => {
    for (const o of ["http://localhost:3000", "http://127.0.0.1:8080", "http://localhost", "https://evil.com", "http://localhost:4318.evil.com", "http://localhost:43180"]) assert.ok(!trustedOrigin(o), o);
  });

  test("PERZIAN_WEB_URL adds its origin only when it's on this machine", () => {
    assert.ok(trustedOrigin("http://localhost:5555", undefined, webOrigins({ PERZIAN_WEB_URL: "http://localhost:5555/app" })));
    assert.ok(!trustedOrigin("https://example.com", undefined, webOrigins({ PERZIAN_WEB_URL: "https://example.com" })));
    // A second dev stack: PERZIAN_WEB_PORT moves the trusted dev-server port (and only to a port number).
    assert.ok(trustedOrigin("http://localhost:4328", undefined, webOrigins({ PERZIAN_WEB_PORT: "4328" })));
    assert.ok(!trustedOrigin("http://localhost:4318", undefined, webOrigins({ PERZIAN_WEB_PORT: "4328" })));
    assert.ok(trustedOrigin("http://localhost:4318", undefined, webOrigins({ PERZIAN_WEB_PORT: "evil.com" })));
  });

  test("corsOrigin echoes trusted browser origins only", () => {
    assert.equal(corsOrigin("null", key, web, key), "null");
    assert.equal(corsOrigin("null", "wrong", web, key), undefined);
    assert.equal(corsOrigin("file://", key, web, key), undefined);
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
