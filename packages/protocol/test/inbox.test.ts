import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, inbox, reduce } from "../src/index.ts";
import type { Decision, PerzianEvent, SessionInfo } from "../src/index.ts";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  role: "worker",
  title: `Session ${id}`,
  project: "/repo",
  cwd: "/repo",
  agent: "claude-code",
  status: "working",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const created = (s: SessionInfo): PerzianEvent => ({ type: "session.created", session: s });
const decision = (id: string, sessionId: string, createdAt: number, over: Partial<Decision> = {}): PerzianEvent => ({
  type: "decision.requested",
  decision: { id, sessionId, source: "ask_decision", question: `Q ${id}?`, options: [{ id: "a", label: "A" }], createdAt, ...over },
});
const keys = (events: PerzianEvent[]) => inbox(fold(events)).map((i) => i.key);

test("what needs you: open decisions, unseen failures and merge conflicts; nothing else", () => {
  const state = fold([
    created(session("work")),
    created(session("done", { status: "done", updatedAt: 5 })),
    created(session("paused", { status: "paused" })),
    created(session("ask")),
    decision("d1", "ask", 10),
    created(session("fail", { status: "failed", updatedAt: 20 })),
    created(session("conf", { status: "done", updatedAt: 30, seenAt: 31, ship: { state: "conflict", how: "merge", into: "main", files: ["a.ts"], at: 40 } })),
  ]);
  const items = inbox(state);
  assert.deepEqual(items.map((i) => i.key), ["d:d1", "c:conf", "f:fail"]);
  const c = items[1];
  assert.equal(c.kind === "conflict" && c.files[0], "a.ts");
});

test("ordering: destructive asks, then other decisions, conflicts, failures; oldest first within each", () => {
  assert.deepEqual(
    keys([
      created(session("a")),
      created(session("b")),
      decision("new", "a", 50),
      decision("old", "b", 10),
      decision("rm", "a", 90, { source: "permission", destructive: "rm -rf" }),
      created(session("f2", { status: "failed", updatedAt: 5 })),
      created(session("f1", { status: "failed", updatedAt: 3 })),
      created(session("c", { status: "done", ship: { state: "conflict", how: "merge", at: 99 } })),
    ]),
    ["d:rm", "d:old", "d:new", "c:c", "f:f1", "f:f2"],
  );
});

test("resolved and seen items drop out", () => {
  let s = fold([created(session("a")), decision("d1", "a", 10), decision("d2", "a", 11), created(session("f", { status: "failed", updatedAt: 20 }))]);
  assert.deepEqual(inbox(s).map((i) => i.key), ["d:d1", "d:d2", "f:f"]);
  s = reduce(s, { type: "decision.resolved", decisionId: "d1", sessionId: "a", optionId: "a" });
  assert.deepEqual(inbox(s).map((i) => i.key), ["d:d2", "f:f"]);
  // Opening the failed session marks it seen.
  s = reduce(s, { type: "session.updated", sessionId: "f", patch: { seenAt: 21 } });
  assert.deepEqual(inbox(s).map((i) => i.key), ["d:d2"]);
  // A fresh failure after that needs you again.
  s = reduce(s, { type: "session.status", sessionId: "f", status: "failed", at: 30 });
  assert.deepEqual(inbox(s).map((i) => i.key), ["d:d2", "f:f"]);
  // A dismissed (null) answer clears it too.
  s = reduce(s, { type: "decision.resolved", decisionId: "d2", sessionId: "a", optionId: null });
  assert.deepEqual(inbox(s).map((i) => i.key), ["f:f"]);
});

test("a conflict drops out once seen or once the ship state moves on", () => {
  const conflict = { state: "conflict" as const, how: "merge" as const, files: ["x"], at: 40 };
  let s = fold([created(session("c", { status: "done", ship: conflict }))]);
  assert.equal(inbox(s).length, 1);
  s = reduce(s, { type: "session.updated", sessionId: "c", patch: { ship: { state: "merged", how: "merge", at: 50 } } });
  assert.equal(inbox(s).length, 0);
  s = reduce(s, { type: "session.updated", sessionId: "c", patch: { ship: conflict, seenAt: 41 } });
  assert.equal(inbox(s).length, 0);
});

test("archived sessions never need you", () => {
  assert.deepEqual(keys([created(session("a", { archived: true, status: "failed", updatedAt: 9 })), decision("d", "a", 1)]), []);
});

test("a failure says why in one line", () => {
  const s = fold([
    created(session("setup", { status: "failed", updatedAt: 2, setup: { state: "failed", copied: [], install: ["npm ci"], error: { command: "npm ci", tail: "x" }, at: 2 } })),
    created(session("checks", { status: "failed", updatedAt: 3, checkRun: { state: "failed", attempt: 2, maxAttempts: 2, at: 3, results: [{ name: "unit", run: "npm test", state: "failed", summary: "2 failed" }, { name: "lint", run: "npm run lint", state: "passed" }] } })),
    created(session("notice", { status: "failed", updatedAt: 4 })),
    { type: "session.transcript", sessionId: "notice", item: { kind: "notice", text: "Agent exited (code 1).\nstack…", at: 4 } },
  ]);
  const why = Object.fromEntries(inbox(s).map((i) => [i.sessionId, i.kind === "failed" ? i.why : ""]));
  assert.equal(why.setup, "Setup failed: npm ci");
  assert.equal(why.checks, "Checks failed: unit (2 failed)");
  assert.equal(why.notice, "Agent exited (code 1).");
});

test("an interrupted session is in the inbox until it runs again", () => {
  const s = session("a", { status: "idle", interrupted: { during: "turn", at: 4 } });
  const items = inbox(fold([created(s)]));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "failed");
  assert.match((items[0] as { why: string }).why, /Interrupted/);
  assert.equal(inbox(fold([created({ ...s, interrupted: undefined })])).length, 0);
});
