// What a daemon restart does to sessions that were busy (boot.ts), and the transcript line a closed decision leaves.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crewStatus, fold, needsYou, type Decision, type PerzianEvent, type SessionInfo, type State } from "@perzian/protocol";
import { INTERRUPTED_DECISION, INTERRUPTED_TURN, interruptions } from "../src/boot.ts";
import { EventStore, replay } from "../src/store.ts";
import { AgentSession, type SessionDeps } from "../src/session.ts";

const tmp = mkdtempSync(join(tmpdir(), "perzian-boot-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, role: "worker", title: id, project: "/r", cwd: "/r", agent: "claude-code", status: "idle", createdAt: 1, updatedAt: 1, ...extra,
});
const decision = (id: string, sessionId: string): Decision => ({
  id, sessionId, source: "permission", question: "Terminal", detail: "npm test", options: [{ id: "y", label: "Allow", kind: "allow_once" }, { id: "n", label: "Reject", kind: "reject_once" }], createdAt: 2,
});

function boot(events: PerzianEvent[]): { before: State; after: State; emitted: PerzianEvent[] } {
  const before = fold(events);
  const emitted = interruptions(before, 100);
  return { before, after: fold([...events, ...emitted]), emitted };
}

describe("daemon restart", () => {
  test("a session waiting on a decision: the card closes with a line, Retry asks again, and it needs you", () => {
    const { after: st, emitted } = boot([
      { type: "session.created", session: session("a", { status: "working", live: true }) },
      { type: "session.transcript", sessionId: "a", item: { kind: "user", text: "add tests", at: 1 } },
      { type: "decision.requested", decision: decision("d1", "a") },
      { type: "session.status", sessionId: "a", status: "needs_you", at: 2 },
    ]);
    // Never left waiting with no card: the decision is gone, and the transcript says why.
    assert.deepEqual(st.decisions, {});
    const items = st.transcripts.a;
    assert.deepEqual(items.find((i) => i.kind === "decision"), { kind: "decision", decisionId: "d1", source: "permission", question: "Terminal", detail: "npm test", answer: null, restarted: true, at: 100 });
    assert.ok(items.some((i) => i.kind === "notice" && i.text === INTERRUPTED_DECISION));
    const a = st.sessions.a;
    assert.equal(a.status, "idle");
    assert.equal(a.live, false);
    assert.deepEqual(a.interrupted, { during: "decision", at: 100 });
    assert.ok(needsYou(a));
    assert.deepEqual(crewStatus(Object.values(st.sessions)), [{ key: "needs_you", count: 1 }]);
    assert.ok(emitted.some((e) => e.type === "decision.resolved" && e.optionId === null));
  });

  test("mid-turn, mid-ship and mid-setup each mark the session interrupted; quiet sessions are left alone", () => {
    const { after: st } = boot([
      { type: "session.created", session: session("turn", { status: "working" }) },
      { type: "session.created", session: session("ship", { status: "done", ship: { state: "shipping", how: "merge", at: 1 } }) },
      { type: "session.created", session: session("setup", { status: "working", setup: { state: "running", copied: [], install: ["npm ci"], current: "npm ci", at: 1 } }) },
      { type: "session.created", session: session("quiet", { status: "done" }) },
    ]);
    assert.equal(st.sessions.turn.interrupted?.during, "turn");
    assert.ok(st.transcripts.turn.some((i) => i.kind === "notice" && i.text === INTERRUPTED_TURN));
    assert.equal(st.sessions.ship.interrupted?.during, "ship");
    assert.equal(st.sessions.ship.ship?.state, "error");
    assert.equal(st.sessions.setup.interrupted?.during, "setup");
    assert.equal(st.sessions.setup.setup?.state, "failed");
    assert.equal(st.sessions.setup.status, "idle");
    assert.equal(st.sessions.quiet.interrupted, undefined);
    assert.deepEqual(crewStatus(Object.values(st.sessions)).find((c) => c.key === "needs_you"), { key: "needs_you", count: 3 });
  });

  test("running again clears it, in the protocol fold and the daemon's replay alike", () => {
    const { emitted } = boot([{ type: "session.created", session: session("a", { status: "working" }) }]);
    const events: PerzianEvent[] = [{ type: "session.created", session: session("a", { status: "working" }) }, ...emitted];
    assert.ok(fold(events).sessions.a.interrupted);
    const again: PerzianEvent[] = [...events, { type: "session.status", sessionId: "a", status: "working", at: 200 }];
    assert.equal(fold(again).sessions.a.interrupted, undefined);
    assert.deepEqual(replay(again), fold(again));
    // Retrying a ship clears it too.
    const ship: PerzianEvent[] = [{ type: "session.created", session: session("b", { status: "done", ship: { state: "shipping", how: "pr", at: 1 } }) }];
    const shipped = [...ship, ...interruptions(fold(ship), 100), { type: "session.updated", sessionId: "b", patch: { ship: { state: "shipping", how: "pr", at: 300 } } } as PerzianEvent];
    assert.equal(fold(shipped).sessions.b.interrupted, undefined);
    assert.deepEqual(replay(shipped), fold(shipped));
  });
});

describe("answered decisions", () => {
  test("leave a line in the transcript with the chosen option's label (or null when dismissed)", async () => {
    const store = new EventStore(join(tmp, "home"), { compact: "never" });
    const deps: SessionDeps = { store, daemonUrl: "http://127.0.0.1:1", decisions: new Map() };
    const s = AgentSession.create({ project: tmp, cwd: tmp, title: "W", agent: "claude-code", role: "worker" }, deps);
    const answered = s.requestDecision({ source: "ask_decision", question: "Which schema?", options: [{ id: "small", label: "Small table", kind: "choice" }, { id: "big", label: "Big table", kind: "choice" }] });
    const [pending] = [...deps.decisions.values()];
    pending.resolve("big");
    assert.equal(await answered, "big");
    const dropped = s.requestDecision({ source: "permission", question: "Run rm -rf dist", options: [{ id: "y", label: "Allow" }] });
    s.dropDecisions();
    assert.equal(await dropped, null);
    const lines = (store.state().transcripts[s.info.id] ?? []).flatMap((i) => (i.kind === "decision" ? [[i.question, i.answer, i.source]] : []));
    assert.deepEqual(lines, [["Which schema?", "Big table", "ask_decision"], ["Run rm -rf dist", null, "permission"]]);
    store.close();
  });
});
