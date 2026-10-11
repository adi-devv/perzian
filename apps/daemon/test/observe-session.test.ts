// AgentSession against the fake ACP agent's "observe" scenario: what the agent does on its own (a subagent,
// a background server, a commit, a worktree, an edit outside the folder) ends up on the session as events.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../src/store.ts";
import { AgentSession, type SessionDeps } from "../src/session.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "perzian-observe-")));
const saved = { adapter: process.env.PERZIAN_TEST_ADAPTER, scenario: process.env.FAKE_SCENARIO, outside: process.env.FAKE_OUTSIDE };
before(() => {
  process.env.PERZIAN_TEST_ADAPTER = join(here, "fixtures/fake-acp-agent.mjs");
  process.env.FAKE_SCENARIO = "observe";
});
after(() => {
  for (const [k, v] of [["PERZIAN_TEST_ADAPTER", saved.adapter], ["FAKE_SCENARIO", saved.scenario], ["FAKE_OUTSIDE", saved.outside]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const sessions: AgentSession[] = [];
const stores: EventStore[] = [];
afterEach(async () => {
  const live = sessions.splice(0);
  for (const s of live) s.dispose();
  for (let i = 0; i < 100 && live.some((s) => s.info.live); i++) await new Promise((r) => setTimeout(r, 20));
  for (const st of stores.splice(0)) st.close();
});

/** `outsideIsExtra`: the folder the agent edits is one of the session's extra folders. */
function make(mode: "edits" | "ask", outsideIsExtra = false) {
  const dir = join(tmp, `case-${++n}`);
  const project = join(dir, "repo");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "a.txt"), "one\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");
  const outsideDir = join(dir, "outside");
  mkdirSync(outsideDir);
  process.env.FAKE_OUTSIDE = join(outsideDir, "notes.txt");
  const store = new EventStore(join(dir, "home"), { compact: "never" });
  const deps: SessionDeps = { store, daemonUrl: "http://127.0.0.1:1", decisions: new Map(), prLookup: async () => ({ url: "https://example.test/pr/1", state: "OPEN" }) };
  const s = AgentSession.create(
    { project, cwd: project, title: "Worker", agent: "claude-code", mode, branch: "main", baseSha: git(project, "rev-parse", "HEAD"), ...(outsideIsExtra ? { extraDirs: [outsideDir] } : {}) },
    deps,
  );
  sessions.push(s);
  stores.push(store);
  return { s, store, deps, project, outside: process.env.FAKE_OUTSIDE, dir };
}

const until = async (cond: () => unknown, ms = 15_000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("an agent acting on its own is observed", () => {
  test("edits outside the folder ask (even in edits mode); everything the agent did is recorded", async () => {
    const { s, store, deps, outside } = make("edits");
    const turn = s.prompt("go");
    await until(() => deps.decisions.size);
    const [pending] = [...deps.decisions.values()];
    assert.deepEqual(pending.decision.outside, [outside]);
    assert.equal(s.info.status, "needs_you");
    pending.resolve("allow");
    await turn;

    const info = store.state().sessions[s.info.id];
    assert.equal(info.status, "done");
    assert.deepEqual(info.outsidePaths, [outside]);

    assert.deepEqual(info.subagents, [{ id: "sub1", description: "Explore the repo", status: "done" }]);
    const inner = store.state().transcripts[s.info.id].find((t) => t.kind === "tool" && t.toolCallId === "inner1");
    assert.equal(inner?.kind === "tool" ? inner.parentToolCallId : undefined, "sub1", "nested call groups under its subagent");

    assert.deepEqual(info.background?.map((b) => ({ command: b.command, port: b.port, taskId: b.taskId })), [{ command: "npm run dev -- --port 5173", port: 5173, taskId: "bash_1" }]);

    assert.equal(info.branch, "agent-feature");
    assert.equal(info.git?.ahead, 1);
    assert.equal(info.git?.pushed, false);
    await until(() => store.state().sessions[s.info.id].git?.prUrl); // gh is looked up without holding the turn
    assert.equal(store.state().sessions[s.info.id].git?.prUrl, "https://example.test/pr/1");

    assert.equal(info.extraWorktrees?.length, 1);
    assert.equal(info.extraWorktrees?.[0].branch, "side");
    assert.match(info.extraWorktrees?.[0].path ?? "", /side-\d+$/);
    assert.equal(info.extraWorktrees?.[0].changed, 1, "the commit the agent made is in the other worktree too (it branched from it)");
  });

  test("an edit inside an extra folder is not outside", async () => {
    const { s, store, deps } = make("edits", true);
    await s.prompt("go");
    assert.equal(deps.decisions.size, 0, "no card: the folder was added");
    assert.equal(store.state().sessions[s.info.id].outsidePaths, undefined);
  });

  test("switching to a branch that doesn't contain the base recomputes the base against the original branch", async () => {
    const { s, store, project } = make("ask");
    const first = git(project, "rev-parse", "HEAD");
    writeFileSync(join(project, "b.txt"), "two\n");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "second");
    const base = git(project, "rev-parse", "HEAD");
    s.info.baseSha = base;
    git(project, "switch", "-q", "-c", "old", first);
    writeFileSync(join(project, "c.txt"), "three\n");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "on old");
    await s.refreshRepo();
    const info = store.state().sessions[s.info.id];
    assert.equal(info.branch, "old");
    assert.equal(info.baseSha, first, "merge-base with main");
    assert.equal(info.git?.ahead, 1);
    const files = await s.refreshChanges();
    assert.deepEqual(files.map((f) => f.path), ["c.txt"], "the change map only has the work done since the fork point");
  });
});

