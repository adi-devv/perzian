import { test } from "node:test";
import assert from "node:assert/strict";
import { byAttention, emptyState, fold, isUnseen, reduce } from "../src/index.ts";
import type { Decision, Outcome, PerzianEvent, SessionInfo, SessionStatus } from "../src/index.ts";

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  role: "worker",
  title: `Session ${id}`,
  project: "/repo",
  cwd: "/repo",
  agent: "claude-code",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const created = (s: SessionInfo): PerzianEvent => ({ type: "session.created", session: s });

test("session.created adds the session", () => {
  const s = fold([created(session("a"))]);
  assert.deepEqual(Object.keys(s.sessions), ["a"]);
  assert.equal(s.sessions.a.title, "Session a");
});

test("session.updated patches fields and ignores unknown sessions", () => {
  const s = fold([
    created(session("a")),
    { type: "session.updated", sessionId: "a", patch: { title: "Renamed", model: "m1", live: true } },
    { type: "session.updated", sessionId: "missing", patch: { title: "x" } },
  ]);
  assert.equal(s.sessions.a.title, "Renamed");
  assert.equal(s.sessions.a.model, "m1");
  assert.equal(s.sessions.a.live, true);
  assert.equal(s.sessions.a.cwd, "/repo");
  assert.equal(s.sessions.missing, undefined);
});

test("session.status sets status and bumps updatedAt", () => {
  const s = fold([created(session("a")), { type: "session.status", sessionId: "a", status: "working", at: 42 }]);
  assert.equal(s.sessions.a.status, "working");
  assert.equal(s.sessions.a.updatedAt, 42);
});

test("session.progress sets progress", () => {
  const progress = { phase: "test", step: 2, of: 3, note: "running" };
  const s = fold([created(session("a")), { type: "session.progress", sessionId: "a", progress }]);
  assert.deepEqual(s.sessions.a.progress, progress);
});

test("transcript appends items and replaces tool items in place by toolCallId", () => {
  const s = fold([
    created(session("a")),
    { type: "session.transcript", sessionId: "a", item: { kind: "user", text: "hi", at: 1 } },
    { type: "session.transcript", sessionId: "a", item: { kind: "tool", toolCallId: "t1", title: "Read", status: "pending", at: 2 } },
    { type: "session.transcript", sessionId: "a", item: { kind: "agent", text: "ok", at: 3 } },
    { type: "session.transcript", sessionId: "a", item: { kind: "tool", toolCallId: "t2", title: "Edit", status: "pending", at: 4 } },
    { type: "session.transcript", sessionId: "a", item: { kind: "tool", toolCallId: "t1", title: "Read file.ts", status: "completed", at: 5 } },
  ]);
  const t = s.transcripts.a;
  assert.equal(t.length, 4);
  assert.deepEqual(
    t.map((x) => x.kind),
    ["user", "tool", "agent", "tool"],
  );
  assert.deepEqual(t[1], { kind: "tool", toolCallId: "t1", title: "Read file.ts", status: "completed", at: 5 });
  assert.equal(t[3].kind === "tool" && t[3].toolCallId, "t2");
});

test("transcripts are kept per session", () => {
  const s = fold([
    { type: "session.transcript", sessionId: "a", item: { kind: "tool", toolCallId: "t1", title: "A", status: "pending", at: 1 } },
    { type: "session.transcript", sessionId: "b", item: { kind: "tool", toolCallId: "t1", title: "B", status: "pending", at: 1 } },
  ]);
  assert.equal(s.transcripts.a.length, 1);
  assert.equal(s.transcripts.b.length, 1);
});

test("decision requested then resolved", () => {
  const d = (id: string): Decision => ({
    id,
    sessionId: "a",
    source: "ask_decision",
    question: "Which?",
    options: [{ id: "x", label: "X" }],
    createdAt: 1,
  });
  let s = fold([created(session("a")), { type: "decision.requested", decision: d("d1") }, { type: "decision.requested", decision: d("d2") }]);
  assert.deepEqual(Object.keys(s.decisions).sort(), ["d1", "d2"]);
  s = reduce(s, { type: "decision.resolved", decisionId: "d1", sessionId: "a", optionId: "x" });
  assert.deepEqual(Object.keys(s.decisions), ["d2"]);
  s = reduce(s, { type: "decision.resolved", decisionId: "d2", sessionId: "a", optionId: null });
  assert.deepEqual(s.decisions, {});
});

test("outcome: latest per session wins", () => {
  const o = (intent: string, sessionId = "a"): Outcome => ({
    sessionId,
    intent,
    status: "success",
    changed: [],
    proof: [],
    risks: [],
    followups: [],
    createdAt: 1,
  });
  const s = fold([
    { type: "outcome.reported", outcome: o("first") },
    { type: "outcome.reported", outcome: o("other", "b") },
    { type: "outcome.reported", outcome: o("second") },
  ]);
  assert.equal(s.outcomes.a.intent, "second");
  assert.equal(s.outcomes.b.intent, "other");
});

test("session.changes replaces the latest file list", () => {
  const s = fold([
    { type: "session.changes", sessionId: "a", files: [{ path: "a.ts", kind: "added", additions: 3, deletions: 0 }], at: 1 },
    { type: "session.changes", sessionId: "a", files: [{ path: "b.ts", kind: "modified", additions: 1, deletions: 1 }], at: 2 },
  ]);
  assert.deepEqual(s.changes.a, [{ path: "b.ts", kind: "modified", additions: 1, deletions: 1 }]);
});

test("session.config stores the agent config", () => {
  const config = { models: [{ value: "m", name: "M" }], currentModel: "m", modes: [], currentMode: undefined };
  const s = fold([{ type: "session.config", sessionId: "a", config }]);
  assert.deepEqual(s.configs.a, config);
});

test("fold does not mutate emptyState or prior states", () => {
  const before = JSON.stringify(emptyState);
  const s1 = fold([created(session("a"))]);
  const s2 = reduce(s1, { type: "session.status", sessionId: "a", status: "done", at: 9 });
  assert.equal(JSON.stringify(emptyState), before);
  assert.equal(s1.sessions.a.status, "idle");
  assert.equal(s2.sessions.a.status, "done");
});

test("byAttention: needs_you > failed > done > working > idle, then most recently updated", () => {
  const mk = (id: string, status: SessionStatus, updatedAt: number) => session(id, { status, updatedAt });
  const list = [
    mk("idle", "idle", 50),
    mk("working", "working", 50),
    mk("done", "done", 50),
    mk("needs-old", "needs_you", 10),
    mk("failed", "failed", 50),
    mk("needs-new", "needs_you", 20),
  ];
  assert.deepEqual(
    list.sort(byAttention).map((s) => s.id),
    ["needs-new", "needs-old", "failed", "done", "working", "idle"],
  );
});

test("isUnseen: only finished sessions updated after last seen", () => {
  assert.equal(isUnseen(session("a", { status: "done", updatedAt: 5 })), true);
  assert.equal(isUnseen(session("a", { status: "failed", updatedAt: 5, seenAt: 4 })), true);
  assert.equal(isUnseen(session("a", { status: "done", updatedAt: 5, seenAt: 5 })), false);
  assert.equal(isUnseen(session("a", { status: "working", updatedAt: 5 })), false);
  assert.equal(isUnseen(session("a", { status: "needs_you", updatedAt: 5 })), false);
});

test("daemon-sent user items keep their system flag through the fold", () => {
  const s = fold([
    created(session("lead", { role: "main" })),
    { type: "session.transcript", sessionId: "lead", item: { kind: "user", text: "hi", at: 1 } },
    { type: "session.transcript", sessionId: "lead", item: { kind: "user", text: "[perzian] a session finished.", at: 2, system: true } },
  ]);
  const items = s.transcripts.lead;
  assert.equal(items.length, 2);
  assert.equal(items[0].kind === "user" && items[0].system, undefined);
  assert.equal(items[1].kind === "user" && items[1].system, true);
});
