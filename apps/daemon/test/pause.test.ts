// AgentSession against a fake ACP agent (test/fixtures/fake-acp-agent.mjs): a usage limit pauses the
// session instead of failing it, and resuming continues the same conversation.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../src/store.ts";
import { AgentSession, CONTINUE_PROMPT, type SessionDeps, type UsageSignals } from "../src/session.ts";
import { UsageGovernor } from "../src/usagecard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "perzian-pause-"));
const saved = { adapter: process.env.PERZIAN_TEST_ADAPTER, scenario: process.env.FAKE_SCENARIO, pauseAt: process.env.PERZIAN_PAUSE_AT };
before(() => {
  process.env.PERZIAN_TEST_ADAPTER = join(here, "fixtures/fake-acp-agent.mjs");
  delete process.env.PERZIAN_PAUSE_AT;
});
after(() => {
  for (const [k, v] of [["PERZIAN_TEST_ADAPTER", saved.adapter], ["FAKE_SCENARIO", saved.scenario], ["PERZIAN_PAUSE_AT", saved.pauseAt]] as const) {
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
  // The adapter's exit handler writes `live: false`; let it land before the store closes.
  for (let i = 0; i < 100 && live.some((s) => s.info.live); i++) await new Promise((r) => setTimeout(r, 20));
  for (const st of stores.splice(0)) st.close();
});

function make(scenario: string, role: "main" | "worker" = "worker", usage?: UsageSignals) {
  process.env.FAKE_SCENARIO = scenario;
  const dir = join(tmp, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const store = new EventStore(join(dir, "home"), { compact: "never" });
  // Nearing a limit is the account governor's call (usagecard.ts): here it always answers Pause.
  store.emit({ type: "settings.usageCard", mode: "pause", at: Date.now() });
  const deps: SessionDeps = { store, daemonUrl: "http://127.0.0.1:1", decisions: new Map(), usage: usage ?? new UsageGovernor({ store, sessions: () => sessions }) };
  const s = AgentSession.create({ project: dir, cwd: dir, title: "Worker", agent: "claude-code", role }, deps);
  sessions.push(s);
  stores.push(store);
  return { s, store };
}

const items = (store: EventStore, id: string) => store.state().transcripts[id] ?? [];
const notices = (store: EventStore, id: string) => items(store, id).flatMap((t) => (t.kind === "notice" ? [t.text] : []));

describe("AgentSession at a usage limit", () => {
  test("a limit error pauses with the reset time instead of failing; resuming continues the conversation", async () => {
    const { s, store } = make("limit");
    const t0 = Date.now();
    await s.prompt("Add the endpoint");
    const info = store.state().sessions[s.info.id];
    assert.equal(info.status, "paused");
    assert.equal(s.info.status, "paused");
    const p = info.pause!;
    assert.equal(p.reason, "You've hit your session limit · resets 5:40pm (Asia/Calcutta)");
    assert.equal(p.window, "five_hour");
    assert.equal(p.estimated, undefined);
    assert.ok(p.resumeAt > t0 && p.resumeAt <= t0 + 24 * 3600_000 + 60_000, "the next 5:40 pm in India");
    assert.equal(new Date(p.resumeAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }), "17:40");
    assert.deepEqual(notices(store, s.info.id), ["Paused at the usage limit"], "no error notice");
    assert.equal(store.state().outcomes[s.info.id], undefined, "no outcome for unfinished work");

    await s.resume("reset");
    const after = store.state().sessions[s.info.id];
    assert.equal(after.status, "done");
    assert.equal(after.pause, undefined);
    const users = items(store, s.info.id).filter((t) => t.kind === "user");
    assert.deepEqual(users.at(-1), { ...users.at(-1), text: CONTINUE_PROMPT, system: true });
    const reply = items(store, s.info.id).filter((t) => t.kind === "agent").at(-1);
    assert.match(reply?.kind === "agent" ? reply.text : "", /Continue where you left off/, "the same adapter session got the message");
    assert.equal(after.acpSessionId, "fake-session");
  });

  test("a refused session tells the governor, with the resume time the others must share", async () => {
    const seen: { id: string; resumeAt?: number }[] = [];
    const { s, store } = make("limit", "worker", { near: () => {}, refused: (id, hit) => seen.push({ id, resumeAt: hit.resumeAt }) });
    await s.prompt("Add the endpoint");
    assert.deepEqual(seen, [{ id: s.info.id, resumeAt: store.state().sessions[s.info.id].pause!.resumeAt }]);
  });

  test("near the limit: the current step finishes, then it pauses early", async () => {
    const { s, store } = make("near");
    const t0 = Date.now();
    await s.prompt("Refactor the module");
    const info = store.state().sessions[s.info.id];
    assert.equal(info.status, "paused");
    assert.equal(info.pause?.early, true);
    assert.equal(info.pause?.window, "five_hour");
    assert.ok(Math.abs(info.pause!.resumeAt - (t0 + 2 * 3600_000)) < 5000);
    const tool = items(store, s.info.id).find((t) => t.kind === "tool");
    assert.equal(tool?.kind === "tool" && tool.status, "completed", "the step ran to completion");
    assert.deepEqual(notices(store, s.info.id), ["5-hour limit 97% used: pausing after the current step", "Paused near the usage limit, after the current step"]);

    // "Resume now" past an early pause doesn't stop again at the same threshold.
    await s.resume("now");
    assert.equal(store.state().sessions[s.info.id].status, "done");
  });

  test("the lead isn't paused early (it stays reachable)", async () => {
    process.env.FAKE_CANCEL_WAIT_MS = "300";
    const { s, store } = make("near", "main");
    await s.prompt("What's going on?");
    delete process.env.FAKE_CANCEL_WAIT_MS;
    // The fake waits for a cancel that never comes, then ends the turn normally.
    assert.equal(store.state().sessions[s.info.id].status, "done");
  });

  test("writing to a paused session resumes it with the developer's message", async () => {
    const { s, store } = make("limit");
    await s.prompt("Add the endpoint");
    assert.equal(s.info.status, "paused");
    await s.prompt("Try again now please");
    assert.equal(store.state().sessions[s.info.id].status, "done");
    const resumed = store.all().filter((e) => e.type === "session.resumed");
    assert.deepEqual(resumed.map((e) => e.type === "session.resumed" && e.reason), ["prompt"]);
  });
});
