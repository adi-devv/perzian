// decision.answer resolves a card once: a stale card (a phone that was offline, a second device, a double tap)
// is refused instead of answering the agent twice.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store.ts";
import { AgentSession, type SessionDeps } from "../src/session.ts";
import { answerDecision } from "../src/decisions.ts";

const tmp = mkdtempSync(join(tmpdir(), "perzian-decisions-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function make() {
  const store = new EventStore(join(tmp, `home-${Math.random().toString(36).slice(2)}`), { compact: "never" });
  const deps: SessionDeps = { store, daemonUrl: "http://127.0.0.1:1", decisions: new Map() };
  const s = AgentSession.create({ project: tmp, cwd: tmp, title: "Worker", agent: "claude-code", role: "worker" }, deps);
  const resolved: (string | null)[] = [];
  store.subscribe((e) => e.type === "decision.resolved" && resolved.push(e.optionId));
  return { s, store, deps, resolved };
}

const ask = (s: AgentSession) => s.requestDecision({ source: "ask_decision", question: "Which way?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });

test("an answer resolves once; a second answer to the same card is refused", async () => {
  const { s, store, deps, resolved } = make();
  const answer = ask(s);
  const [id] = deps.decisions.keys();
  answerDecision(deps.decisions, id, "a");
  assert.equal(await answer, "a");
  assert.throws(() => answerDecision(deps.decisions, id, "b"), /Already answered/);
  assert.deepEqual(resolved, ["a"], "one decision.resolved, with the first answer");
  assert.equal(store.state().decisions[id], undefined);
  store.close();
});

test("a card dropped by the daemon (turn ended, cancel) can't be answered afterwards", async () => {
  const { s, store, deps, resolved } = make();
  const answer = ask(s);
  const [id] = deps.decisions.keys();
  s.dropDecisions();
  assert.equal(await answer, null);
  assert.throws(() => answerDecision(deps.decisions, id, "a"), /Already answered/);
  assert.deepEqual(resolved, [null]);
  store.close();
});

test("unknown cards and options that aren't on the card are refused without resolving", () => {
  const { s, store, deps, resolved } = make();
  void ask(s);
  const [id] = deps.decisions.keys();
  assert.throws(() => answerDecision(deps.decisions, "nope", "a"), /Already answered/);
  assert.throws(() => answerDecision(deps.decisions, id, "zzz"), /isn't one of the options/);
  assert.equal(deps.decisions.size, 1, "still open");
  assert.deepEqual(resolved, []);
  answerDecision(deps.decisions, id, null); // dismiss is always allowed
  assert.deepEqual(resolved, [null]);
  store.close();
});

test("resolving the same pending card twice emits once", () => {
  const { s, store, deps, resolved } = make();
  void ask(s);
  const [p] = deps.decisions.values();
  p.resolve("a");
  p.resolve("b");
  assert.deepEqual(resolved, ["a"]);
  store.close();
});
