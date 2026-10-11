import { test } from "node:test";
import assert from "node:assert/strict";
import { byAttention, checkPlan, crewMatch, crewStatus, emptyState, fold, isUnseen, needsYou, recentProjects, reduce, shownPrompt, shownStatus, withProject } from "../src/index.ts";
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

test("session.paused sets status and the pause; session.resumed clears both", () => {
  const pause = { reason: "You've hit your session limit · resets 5:40pm (Asia/Calcutta)", resumeAt: 1000, window: "five_hour" as const, at: 10 };
  let s = fold([created(session("a", { status: "working" })), { type: "session.paused", sessionId: "a", pause }]);
  assert.equal(s.sessions.a.status, "paused");
  assert.deepEqual(s.sessions.a.pause, pause);
  assert.equal(s.sessions.a.updatedAt, 10);
  s = reduce(s, { type: "session.resumed", sessionId: "a", at: 20, reason: "reset" });
  assert.equal(s.sessions.a.status, "idle");
  assert.equal("pause" in s.sessions.a, false, "no leftover key, so it serializes away");
  assert.equal(s.sessions.a.updatedAt, 20);
  // A late resumed for a session that already moved on doesn't change its status.
  s = reduce(s, { type: "session.status", sessionId: "a", status: "working", at: 30 });
  s = reduce(s, { type: "session.resumed", sessionId: "a", at: 40, reason: "now" });
  assert.equal(s.sessions.a.status, "working");
  assert.equal(reduce(s, { type: "session.resumed", sessionId: "missing", at: 1, reason: "now" }), s);
});

test("byAttention: needs_you > failed > done > working > paused > idle, then most recently updated", () => {
  const mk = (id: string, status: SessionStatus, updatedAt: number) => session(id, { status, updatedAt });
  const list = [
    mk("paused", "paused", 60),
    mk("idle", "idle", 50),
    mk("working", "working", 50),
    mk("done", "done", 50),
    mk("needs-old", "needs_you", 10),
    mk("failed", "failed", 50),
    mk("needs-new", "needs_you", 20),
  ];
  assert.deepEqual(
    list.sort(byAttention).map((s) => s.id),
    ["needs-new", "needs-old", "failed", "done", "working", "paused", "idle"],
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

test("crewStatus counts workers by group, 'done' only when unseen, ignoring lead and archived", () => {
  const sessions = [
    session("a", { status: "working" }),
    session("b", { status: "working" }),
    session("c", { status: "needs_you" }),
    session("d", { status: "done", updatedAt: 5, seenAt: 3 }),
    session("e", { status: "done", updatedAt: 5, seenAt: 9 }),
    session("f", { status: "failed", updatedAt: 5 }),
    session("g", { status: "working", archived: true }),
    session("main", { status: "working", role: "main" }),
  ];
  assert.deepEqual(crewStatus(sessions), [
    { key: "needs_you", count: 1 },
    { key: "failed", count: 1 },
    { key: "working", count: 2 },
    { key: "done", count: 1 },
  ]);
  assert.deepEqual(crewStatus([session("m", { role: "main" })]), []);
  assert.ok(crewMatch("done", sessions[3]) && !crewMatch("done", sessions[4]));
});

test("checkPlan lists declared checks first, then detected commands not already declared", () => {
  assert.deepEqual(checkPlan({}), []);
  assert.deepEqual(checkPlan({ declaredChecks: [{ name: "unit", run: "npm test", timeoutSec: 9 }], checks: ["npm test", "npm run typecheck"] }), [
    { name: "unit", run: "npm test", timeoutSec: 9 },
    { name: "npm run typecheck", run: "npm run typecheck" },
  ]);
});

test("recentProjects: added folders first, then worker projects, never the lead's own folder", () => {
  const sessions = {
    lead: session("lead", { role: "main", project: "/home/.perzian/main" }),
    a: session("a", { project: "/code/api" }),
    b: session("b", { project: "/code/web" }),
    c: session("c", { project: "/code/api" }),
  };
  assert.deepEqual(recentProjects({ sessions, settings: { projects: ["/code/docs"] } }), ["/code/docs", "/code/api", "/code/web"]);
});

test("an interrupted session needs you: counted and sorted as needs_you, not under its own status", () => {
  const sessions = [
    session("a", { status: "idle", interrupted: { during: "turn", at: 2 } }),
    session("b", { status: "done", updatedAt: 5, interrupted: { during: "ship", at: 2 } }),
    session("c", { status: "working", updatedAt: 9 }),
  ];
  assert.deepEqual(crewStatus(sessions), [{ key: "needs_you", count: 2 }, { key: "working", count: 1 }]);
  assert.equal(shownStatus(sessions[1]), "needs_you");
  assert.ok(needsYou(sessions[0]) && !needsYou(sessions[2]));
  assert.deepEqual([...sessions].sort(byAttention).map((s) => s.id), ["b", "a", "c"]);
});

test("interrupted clears once the session runs again or its ship/setup is retried", () => {
  const mark: PerzianEvent = { type: "session.updated", sessionId: "a", patch: { interrupted: { during: "turn", at: 2 } } };
  const base = [created(session("a")), mark];
  assert.ok(fold(base).sessions.a.interrupted);
  assert.ok(fold([...base, { type: "session.status", sessionId: "a", status: "idle", at: 3 }]).sessions.a.interrupted);
  assert.equal(fold([...base, { type: "session.status", sessionId: "a", status: "working", at: 3 }]).sessions.a.interrupted, undefined);
  assert.equal(fold([...base, { type: "session.updated", sessionId: "a", patch: { ship: { state: "shipping", how: "merge", at: 3 } } }]).sessions.a.interrupted, undefined);
  assert.equal(fold([...base, { type: "session.updated", sessionId: "a", patch: { setup: { state: "skipped", copied: [], install: [], at: 3 } } }]).sessions.a.interrupted, undefined);
  assert.ok(fold([...base, { type: "session.updated", sessionId: "a", patch: { title: "x" } }]).sessions.a.interrupted);
});

test("shownPrompt hides the project-folder line withProject adds, and nothing else", () => {
  assert.equal(shownPrompt(withProject("add a login page", "/Users/me/app")), "add a login page");
  assert.equal(shownPrompt(withProject("two\nlines", "/x")), "two\nlines");
  assert.equal(shownPrompt("plain"), "plain");
  // Mentioned mid-message, it is the developer's own text.
  assert.equal(shownPrompt("Project folder: /x\n\nmore"), "Project folder: /x\n\nmore");
  assert.equal(shownPrompt("a\n\nProject folder: /x\nthen more"), "a\n\nProject folder: /x\nthen more");
});

test("shownPrompt also hides the extra-folders line", () => {
  assert.equal(shownPrompt(withProject("task", "/a", ["~/b", "~/c"])), "task");
});
