import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { githubCheck, hasGithubOrigin, projectHost, shipPreference, type Runner } from "../src/github.ts";
import { parseConfig, loadDeclaredChecks } from "../src/checks.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = (r: Partial<Awaited<ReturnType<Runner>>>): Runner => async () => ({ ok: true, out: "", err: "", ...r });

describe("githubCheck", () => {
  const hosts = (list: object[]) => JSON.stringify({ hosts: { "github.com": list } });
  test("connected: the active signed-in account", async () => {
    const c = await githubCheck("github.com", fake({ out: hosts([{ state: "success", active: false, login: "old" }, { state: "success", active: true, login: "adi" }]) }), "darwin");
    assert.equal(c.signedIn, true);
    assert.equal(c.user, "adi");
    assert.equal(c.installCommand, "brew install gh");
    assert.equal(c.signInCommand, "gh auth login");
  });
  test("signed out, and a failed login does not count", async () => {
    const c = await githubCheck("github.com", fake({ ok: false, out: hosts([{ state: "error", active: true, login: "x" }]) }), "linux");
    assert.equal(c.signedIn, false);
    assert.equal(c.user, undefined);
    assert.equal(c.installCommand, undefined);
  });
  test("gh missing", async () => {
    const c = await githubCheck("github.com", fake({ ok: false, missing: true }));
    assert.deepEqual([c.ghInstalled, c.signedIn], [false, false]);
  });
  test("other host: sign-in command names it; text fallback for old gh", async () => {
    const c = await githubCheck("git.corp.dev", fake({ out: "git.corp.dev\n  ✓ Logged in to git.corp.dev account sam (keyring)" }));
    assert.equal(c.signInCommand, "gh auth login --hostname git.corp.dev");
    assert.deepEqual([c.signedIn, c.user], [true, "sam"]);
  });
  test("never returns a token", async () => {
    const c = await githubCheck("github.com", fake({ out: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "a", token: "ghp_secret" }] } }) }));
    assert.ok(!JSON.stringify(c).includes("ghp_secret"));
  });
});

describe("origin host and ship default", () => {
  test("projectHost / hasGithubOrigin read origin", async () => {
    assert.equal(await projectHost("/r", fake({ out: "git@git.corp.dev:a/b.git\n" })), "git.corp.dev");
    assert.equal(await projectHost("/r", fake({ ok: false })), "github.com");
    assert.equal(await hasGithubOrigin("/r", fake({ out: "https://github.com/a/b.git" })), true);
    assert.equal(await hasGithubOrigin("/r", fake({ out: "git@gitlab.com:a/b.git" })), false);
    assert.equal(await hasGithubOrigin("/r", fake({ ok: false })), false);
  });
  test("perzian.json wins; else PR only with a GitHub origin", () => {
    assert.equal(shipPreference(undefined, true), "pr");
    assert.equal(shipPreference(undefined, false), "merge");
    assert.equal(shipPreference("merge", true), "merge");
    assert.equal(shipPreference("pr", false), "pr");
  });
  test("perzian.json \"ship\" is validated", () => {
    assert.equal(parseConfig('{"ship":"pr"}').ship, "pr");
    assert.equal(parseConfig("{}").ship, undefined);
    assert.throws(() => parseConfig('{"ship":"push"}'), /"ship" must be "pr" or "merge"/);
    const dir = mkdtempSync(join(tmpdir(), "perzian-ship-"));
    writeFileSync(join(dir, "perzian.json"), '{"ship":"merge"}');
    assert.equal(loadDeclaredChecks(dir).ship, "merge");
  });
});
