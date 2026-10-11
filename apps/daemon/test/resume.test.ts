import { after, afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PauseInfo, SessionInfo } from "@perzian/protocol";
import { EventStore } from "../src/store.ts";
import { ResumeQueue } from "../src/resume.ts";
import { AgentSession, type SessionDeps } from "../src/session.ts";
import { MIN_WAIT_MS } from "../src/limits.ts";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const HOUR = 3600_000;
const tmp = mkdtempSync(join(tmpdir(), "perzian-resume-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let dirN = 0;
const freshDir = () => join(tmp, `home-${++dirN}`);

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, role: "worker", title: id, project: "/r", cwd: "/r", agent: "claude-code", status: "working", createdAt: NOW, updatedAt: NOW, ...extra,
});
const pause = (resumeAt: number): PauseInfo => ({ reason: "You've hit your session limit", resumeAt, window: "five_hour", at: NOW });

describe("ResumeQueue scheduling (fake timers)", () => {
  afterEach(() => mock.timers.reset());

  test("resumes at the reset time plus jitter, not before", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const resumed: string[] = [];
    const q = new ResumeQueue({ resume: (id) => resumed.push(id), jitterMs: () => 30_000, tickMs: 15_000 });
    q.schedule("a", NOW + HOUR);
    q.schedule("b", NOW + 2 * HOUR);
    assert.deepEqual(q.pending().map((p) => p.sessionId), ["a", "b"]);
    mock.timers.tick(HOUR);
    assert.deepEqual(resumed, [], "the reset time alone isn't enough: jitter");
    mock.timers.tick(30_000);
    assert.deepEqual(resumed, ["a"]);
    mock.timers.tick(HOUR);
    assert.deepEqual(resumed, ["a", "b"]);
    assert.deepEqual(q.pending(), []);
    q.dispose();
  });

  test("session.resumed (e.g. Resume now) and archiving take a session off the queue", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const resumed: string[] = [];
    const q = new ResumeQueue({ resume: (id) => resumed.push(id), jitterMs: () => 0, tickMs: 15_000 });
    q.onEvent({ type: "session.paused", sessionId: "a", pause: pause(NOW + HOUR) });
    q.onEvent({ type: "session.paused", sessionId: "b", pause: pause(NOW + HOUR) });
    q.onEvent({ type: "session.paused", sessionId: "c", pause: pause(NOW + HOUR) });
    q.onEvent({ type: "session.resumed", sessionId: "a", at: NOW, reason: "now" });
    q.onEvent({ type: "session.updated", sessionId: "b", patch: { archived: true } });
    mock.timers.tick(2 * HOUR);
    assert.deepEqual(resumed, ["c"]);
    q.dispose();
  });

  test("a pause again reschedules to the new reset time", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const resumed: string[] = [];
    const q = new ResumeQueue({ resume: (id) => resumed.push(id), jitterMs: () => 0, tickMs: 15_000 });
    q.onEvent({ type: "session.paused", sessionId: "a", pause: pause(NOW + HOUR) });
    q.onEvent({ type: "session.paused", sessionId: "a", pause: pause(NOW + 3 * HOUR) });
    mock.timers.tick(2 * HOUR);
    assert.deepEqual(resumed, []);
    mock.timers.tick(HOUR);
    assert.deepEqual(resumed, ["a"]);
    q.dispose();
  });

  test("goes by the wall clock: a reset that passed while the machine slept fires on the next tick", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    let wall = NOW;
    const resumed: string[] = [];
    const q = new ResumeQueue({ resume: (id) => resumed.push(id), now: () => wall, jitterMs: () => 0, tickMs: 15_000 });
    q.schedule("a", NOW + 5 * HOUR);
    wall += 5 * HOUR; // asleep: the wall clock moved, the timers didn't
    assert.deepEqual(resumed, []);
    mock.timers.tick(15_000);
    assert.deepEqual(resumed, ["a"]);
    q.dispose();
  });

  test("one session's resume throwing doesn't stop the others", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const resumed: string[] = [];
    const err = mock.method(console, "error", () => {});
    const q = new ResumeQueue({
      resume: (id) => {
        if (id === "a") throw new Error("boom");
        resumed.push(id);
      },
      jitterMs: () => 0,
      tickMs: 15_000,
    });
    q.schedule("a", NOW + HOUR);
    q.schedule("b", NOW + HOUR);
    mock.timers.tick(HOUR);
    assert.deepEqual(resumed, ["b"]);
    assert.equal(err.mock.callCount(), 1);
    err.mock.restore();
    q.dispose();
  });
});

describe("ResumeQueue persistence (the event store is the queue)", () => {
  afterEach(() => mock.timers.reset());

  const deps = (store: EventStore): SessionDeps => ({ store, daemonUrl: "http://127.0.0.1:0", decisions: new Map() });

  test("a pause survives a daemon restart and resumes on time", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const dir = freshDir();

    // First daemon: a session hits its limit.
    let store = new EventStore(dir, { compact: "never" });
    const s = AgentSession.create({ id: "w1", project: "/r", cwd: "/r", title: "Worker", agent: "claude-code" }, deps(store));
    AgentSession.create({ id: "w2", project: "/r", cwd: "/r", title: "Other", agent: "claude-code" }, deps(store));
    s.pause({ reason: "You've hit your session limit · resets 1pm (UTC)", resetAt: NOW + 3 * HOUR, window: "five_hour" });
    assert.equal(store.state().sessions.w1.status, "paused");
    assert.equal(store.state().sessions.w1.pause?.resumeAt, NOW + 3 * HOUR);
    store.close();

    // Restart: a new store from the same log, a new queue. No other record of the queue exists.
    mock.timers.tick(HOUR);
    store = new EventStore(dir, { compact: "never" });
    const resumed: string[] = [];
    const q = new ResumeQueue({ resume: (id) => resumed.push(id), jitterMs: () => 20_000, tickMs: 15_000 });
    q.attach(store);
    assert.deepEqual(q.pending(), [{ sessionId: "w1", at: NOW + 3 * HOUR + 20_000 }]);
    mock.timers.tick(2 * HOUR);
    assert.deepEqual(resumed, []);
    mock.timers.tick(30_000);
    assert.deepEqual(resumed, ["w1"]);
    q.dispose();
    store.close();
  });

  test("compaction keeps the pause; a resume before the restart clears it", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const dir = freshDir();
    let store = new EventStore(dir, { compact: "never" });
    store.emit({ type: "session.created", session: session("a") });
    store.emit({ type: "session.created", session: session("b") });
    store.emit({ type: "session.paused", sessionId: "a", pause: pause(NOW + HOUR) });
    store.emit({ type: "session.paused", sessionId: "b", pause: pause(NOW + HOUR) });
    store.emit({ type: "session.resumed", sessionId: "b", at: NOW + 1000, reason: "now" });
    store.close();

    store = new EventStore(dir, { compact: "always" });
    assert.ok(store.boot.compacted, "rewritten to its compacted form");
    assert.equal(store.state().sessions.a.status, "paused");
    assert.equal(store.state().sessions.b.status, "idle");
    assert.equal(store.state().sessions.b.pause, undefined);
    const q = new ResumeQueue({ resume: () => {}, jitterMs: () => 0 });
    q.attach(store);
    assert.deepEqual(q.pending().map((p) => p.sessionId), ["a"]);
    q.dispose();
    store.close();
  });

  test("a reset that passed while the daemon was down resumes right after boot", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const dir = freshDir();
    let store = new EventStore(dir, { compact: "never" });
    store.emit({ type: "session.created", session: session("a") });
    store.emit({ type: "session.paused", sessionId: "a", pause: pause(NOW + HOUR) });
    store.close();
    mock.timers.tick(6 * HOUR); // the daemon was off
    store = new EventStore(dir, { compact: "never" });
    const resumed: string[] = [];
    const q = new ResumeQueue({ resume: (id) => resumed.push(id), jitterMs: () => 10_000, tickMs: 15_000 });
    q.attach(store);
    mock.timers.tick(15_000);
    assert.deepEqual(resumed, ["a"]);
    q.dispose();
    store.close();
  });

  test("a session's pause, cancel and early pause, end to end through the store and queue", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
    const store = new EventStore(freshDir(), { compact: "never" });
    const q = new ResumeQueue({ resume: () => {}, jitterMs: () => 0 });
    q.attach(store);
    const s = AgentSession.create({ id: "w", project: "/r", cwd: "/r", title: "W", agent: "claude-code" }, deps(store));

    // A reset time that has just passed still waits a minute; the queue follows the store.
    s.pause({ reason: "You've hit your session limit", resetAt: NOW - 1000 });
    assert.deepEqual(q.pending(), [{ sessionId: "w", at: NOW + MIN_WAIT_MS }]);
    const notices = (store.state().transcripts.w ?? []).filter((t) => t.kind === "notice").map((t) => t.kind === "notice" && t.text);
    assert.deepEqual(notices, ["Paused at the usage limit"]);

    // Stop instead of waiting: idle, off the queue.
    void s.cancel();
    assert.equal(store.state().sessions.w.status, "idle");
    assert.equal(s.info.status, "idle");
    assert.deepEqual(q.pending(), []);

    // An early pause, no reset time known: a retry guess, marked estimated.
    s.pause({ reason: "5-hour limit 96% used" }, true);
    const p = store.state().sessions.w.pause!;
    assert.equal(p.early, true);
    assert.equal(p.estimated, true);
    assert.equal(q.pending().length, 1);
    q.dispose();
    store.close();
  });
});
