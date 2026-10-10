import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, type PerzianEvent, type SessionInfo, type State, type TranscriptItem } from "@perzian/protocol";
import { ARCHIVED_TTL_MS, compact, EventStore, replay, TRANSCRIPT_KEEP, TRIMMED_NOTICE } from "../src/store.ts";

const NOW = Date.now();
const DAY = 86400_000;
const tmp = mkdtempSync(join(tmpdir(), "perzian-store-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let dirN = 0;
const freshDir = () => join(tmp, `home-${++dirN}`);

// Small deterministic PRNG so failures reproduce.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const session = (id: string, at: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, role: "worker", title: id, project: "/r", cwd: "/r", agent: "claude-code", status: "idle", createdAt: at, updatedAt: at, ...extra,
});

// A log exercising every event type, tool-status rewrites, decisions opened and resolved, events for
// unknown sessions, a parent/child spawn, and sessions long enough to be trimmed.
function makeLog(n: number, seed = 1): PerzianEvent[] {
  const r = rng(seed);
  const ev: PerzianEvent[] = [];
  let t = NOW - 30 * DAY;
  const ids = ["main", "a", "b", "c", "old-archived", "new-archived"];
  ev.push({ type: "session.created", session: session("main", t, { role: "main" }) });
  for (const id of ids.slice(1)) ev.push({ type: "session.created", session: session(id, t, id === "c" ? { parentId: "main" } : {}) });
  ev.push({ type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "c", title: "c", at: t } });
  ev.push({ type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "old-archived", title: "old", at: t } });
  let tool = 0;
  const open: { id: string; sessionId: string }[] = [];
  while (ev.length < n) {
    t += 1000;
    const sid = ids[Math.floor(r() * 4)]; // the archived ones stay quiet
    const x = r();
    if (x < 0.06) ev.push({ type: "session.status", sessionId: sid, status: (["working", "done", "idle", "needs_you"] as const)[Math.floor(r() * 4)], at: t });
    else if (x < 0.3) ev.push({ type: "session.transcript", sessionId: sid, item: { kind: "agent", text: `reply ${ev.length}`, at: t } });
    else if (x < 0.34) ev.push({ type: "session.transcript", sessionId: sid, item: { kind: "user", text: `ask ${ev.length}`, at: t } });
    else if (x < 0.5) ev.push({ type: "session.transcript", sessionId: sid, item: { kind: "tool", toolCallId: `t${++tool}`, title: "Read x", status: "pending", toolKind: "read", at: t } });
    else if (x < 0.62 && tool) {
      // rewrite an earlier tool's status (possibly long ago)
      const tc = `t${1 + Math.floor(r() * tool)}`;
      ev.push({ type: "session.transcript", sessionId: sid, item: { kind: "tool", toolCallId: tc, title: "Read x", status: r() < 0.5 ? "completed" : "in_progress", at: t } });
    } else if (x < 0.66) ev.push({ type: "session.changes", sessionId: sid, files: [{ path: `f${ev.length}.ts`, kind: "modified", additions: 1, deletions: 0 }], at: t });
    else if (x < 0.7) ev.push({ type: "session.progress", sessionId: sid, progress: { phase: "p", step: 1, of: 3 } });
    else if (x < 0.72) ev.push({ type: "session.config", sessionId: sid, config: { models: [{ value: "m", name: "M" }], modes: [], currentModel: `m${ev.length}` } });
    else if (x < 0.74) ev.push({ type: "outcome.reported", outcome: { sessionId: sid, intent: `i${ev.length}`, status: "success", changed: [], proof: [], risks: [], followups: [], createdAt: t } });
    else if (x < 0.77) {
      const id = `d${ev.length}`;
      open.push({ id, sessionId: sid });
      ev.push({ type: "decision.requested", decision: { id, sessionId: sid, source: "permission", question: "ok?", options: [{ id: "y", label: "Yes" }], createdAt: t } });
    } else if (x < 0.8 && open.length) {
      const d = open.splice(Math.floor(r() * open.length), 1)[0];
      ev.push({ type: "decision.resolved", decisionId: d.id, sessionId: d.sessionId, optionId: null });
    } else if (x < 0.81) ev.push({ type: "session.transcript", sessionId: "ghost", item: { kind: "notice", text: "orphan", at: t } });
    else if (x < 0.82) ev.push({ type: "session.updated", sessionId: "ghost", patch: { title: "nope" } });
    else ev.push({ type: "session.updated", sessionId: sid, patch: { seenAt: t, title: `title ${ev.length}` } });
  }
  ev.push({ type: "session.status", sessionId: "old-archived", status: "done", at: NOW - 8 * DAY });
  ev.push({ type: "session.updated", sessionId: "old-archived", patch: { archived: true } });
  ev.push({ type: "session.status", sessionId: "new-archived", status: "done", at: NOW - 1 * DAY });
  ev.push({ type: "session.updated", sessionId: "new-archived", patch: { archived: true } });
  ev.push({ type: "decision.requested", decision: { id: "d-old", sessionId: "old-archived", source: "permission", question: "?", options: [], createdAt: t } });
  return ev;
}

// What compaction is allowed to change: transcripts trimmed to the tail (behind a notice), archived
// sessions past the TTL dropped (with spawn items pointing at them), orphaned entries dropped.
function expected(state: State, keep = TRANSCRIPT_KEEP): State {
  const gone = (id: string) => !state.sessions[id] || (state.sessions[id].archived && NOW - state.sessions[id].updatedAt > ARCHIVED_TTL_MS);
  const pick = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !gone(id)));
  const transcripts: Record<string, TranscriptItem[]> = {};
  for (const [id, list] of Object.entries(pick(state.transcripts))) {
    const all = list.filter((t) => t.kind !== "spawn" || !gone(t.childId));
    transcripts[id] = all.length > keep ? [{ kind: "notice", text: TRIMMED_NOTICE, at: all[all.length - keep - 1].at }, ...all.slice(-keep)] : all;
  }
  return {
    sessions: pick(state.sessions),
    transcripts,
    decisions: Object.fromEntries(Object.entries(state.decisions).filter(([, d]) => !gone(d.sessionId))),
    outcomes: pick(state.outcomes),
    changes: pick(state.changes),
    configs: pick(state.configs),
  };
}

const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const writeLog = (dir: string, events: PerzianEvent[]) => {
  new EventStore(dir, { compact: "never" }).close(); // creates the dir
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e) + "\n").join(""));
};

describe("replay", () => {
  test("matches protocol fold exactly", () => {
    for (const seed of [1, 2, 3]) {
      const events = makeLog(3000, seed);
      assert.deepEqual(replay(events), fold(events));
    }
  });

  test("never mutates the events it replays", () => {
    const events = makeLog(800);
    const before = JSON.stringify(events);
    replay(events);
    assert.equal(JSON.stringify(events), before);
  });
});

describe("compact", () => {
  test("compact(fold(events)) folds back to an equivalent state", () => {
    for (const seed of [1, 7]) {
      const events = makeLog(6000, seed);
      const state = fold(events);
      const out = compact(state, { now: NOW });
      assert.deepEqual(fold(out), expected(state));
      assert.ok(out.length < events.length / 2, `compacted ${out.length} of ${events.length}`);
    }
  });

  test("trims long transcripts behind a notice and drops stale archived sessions", () => {
    const state = fold(makeLog(6000));
    const after = fold(compact(state, { now: NOW }));
    const a = after.transcripts.a;
    assert.ok(state.transcripts.a.length > TRANSCRIPT_KEEP);
    assert.equal(a.length, TRANSCRIPT_KEEP + 1);
    assert.deepEqual(a[0], { kind: "notice", text: TRIMMED_NOTICE, at: a[0].at });
    assert.deepEqual(a.slice(1), state.transcripts.a.slice(-TRANSCRIPT_KEEP));
    assert.equal(after.sessions["old-archived"], undefined);
    assert.equal(after.decisions["d-old"], undefined);
    assert.ok(after.sessions["new-archived"], "recently archived sessions are kept");
    const untrimmed = fold(compact(state, { now: NOW, keep: Infinity })).transcripts.main;
    assert.ok(!untrimmed.some((t) => t.kind === "spawn" && t.childId === "old-archived"), "spawn of a dropped session goes too");
    assert.ok(untrimmed.some((t) => t.kind === "spawn" && t.childId === "c"));
    assert.equal(after.sessions.ghost, undefined);
    assert.equal(after.transcripts.ghost, undefined);
  });

  test("is idempotent", () => {
    const once = compact(fold(makeLog(4000)), { now: NOW });
    assert.equal(compact(fold(once), { now: NOW }).length, once.length);
    assert.deepEqual(fold(compact(fold(once), { now: NOW })), fold(once));
  });
});

describe("EventStore", () => {
  test("state() stays equal to a fold of the log across emits and reboots", () => {
    const dir = freshDir();
    const events = makeLog(1500);
    const s1 = new EventStore(dir, { compact: "never" });
    for (const e of events) s1.emit(e);
    assert.deepEqual(json(s1.state()), json(fold(s1.all())));
    s1.close();
    const s2 = new EventStore(dir, { compact: "never" });
    assert.equal(s2.all().length, events.length);
    assert.deepEqual(s2.state(), fold(events));
    s2.emit({ type: "session.status", sessionId: "a", status: "done", at: NOW });
    assert.equal(s2.state().sessions.a.status, "done");
    s2.close();
  });

  test("compacts on boot past the threshold, atomically, keeping a backup", () => {
    const dir = freshDir();
    const events = makeLog(6000);
    writeLog(dir, events);
    const original = readFileSync(join(dir, "events.jsonl"), "utf8");
    const s = new EventStore(dir, { maxEvents: 5000, now: () => NOW });
    assert.ok(s.boot.compacted && s.boot.compacted.events < events.length);
    assert.equal(readFileSync(join(dir, "events.jsonl.bak"), "utf8"), original);
    assert.ok(!existsSync(join(dir, "events.jsonl.tmp")));
    assert.deepEqual(json(s.state()), json(expected(fold(events))));
    // appends after compaction land in the new file
    s.emit({ type: "session.status", sessionId: "b", status: "failed", at: NOW });
    s.close();
    const again = new EventStore(dir, { maxEvents: 5000, now: () => NOW });
    assert.equal(again.boot.compacted, undefined, "already compact: no rewrite");
    assert.equal(again.state().sessions.b.status, "failed");
    assert.equal(readFileSync(join(dir, "events.jsonl.bak"), "utf8"), original, "backup untouched");
    again.close();
  });

  test("leaves a log under the threshold alone", () => {
    const dir = freshDir();
    writeLog(dir, makeLog(2000));
    const s = new EventStore(dir);
    assert.equal(s.boot.compacted, undefined);
    assert.equal(s.all().length, 2000 + 5);
    assert.ok(!existsSync(join(dir, "events.jsonl.bak")));
    s.close();
  });

  test("survives a line torn by a crash mid-write", () => {
    const dir = freshDir();
    const events = makeLog(300);
    writeLog(dir, events);
    appendFileSync(join(dir, "events.jsonl"), '{"type":"session.status","sessionId":"a","sta');
    const s = new EventStore(dir, { now: () => NOW });
    assert.equal(s.boot.skippedLines, 1);
    s.emit({ type: "session.status", sessionId: "a", status: "done", at: NOW });
    s.close();
    const again = new EventStore(dir, { now: () => NOW });
    assert.equal(again.boot.skippedLines, 0);
    assert.equal(again.state().sessions.a.status, "done");
    again.close();
  });

  test("snapshot() folds to the live state, bounded", () => {
    const dir = freshDir();
    const s = new EventStore(dir, { compact: "never" });
    for (const e of makeLog(6000)) s.emit(e);
    const snap = s.snapshot();
    assert.ok(snap.length < s.all().length / 2);
    const st = fold(snap);
    assert.deepEqual(Object.keys(st.sessions).sort(), Object.keys(s.state().sessions).filter((id) => id !== "old-archived").sort());
    assert.ok(Object.values(st.transcripts).every((t) => t.length <= TRANSCRIPT_KEEP + 1));
    s.close();
  });
});
