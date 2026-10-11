// The composer's state in events: attachments are ids only, slash commands and plan-window usage fold from events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, usageNotice, usageKey, type PerzianEvent, type SessionInfo } from "../src/index.ts";

const session: SessionInfo = { id: "a", role: "worker", title: "A", project: "/r", cwd: "/r", agent: "claude-code", status: "idle", createdAt: 1, updatedAt: 1 };
const created: PerzianEvent = { type: "session.created", session };

test("a user message folds with attachment ids and names only, never bytes", () => {
  const s = fold([created, { type: "session.transcript", sessionId: "a", item: { kind: "user", text: "see this", at: 2, attachments: [{ id: "i1", name: "shot.png", image: true }, { id: "i2", name: "log.txt" }] } }]);
  const item = s.transcripts.a[0];
  assert.equal(item.kind, "user");
  if (item.kind !== "user") return;
  assert.deepEqual(item.attachments, [{ id: "i1", name: "shot.png", image: true }, { id: "i2", name: "log.txt" }]);
  assert.ok(JSON.stringify(item).length < 200, "nothing but references");
});

test("the agent's slash commands fold into the session", () => {
  const commands = [{ name: "compact", description: "Free up context" }, { name: "review", hint: "PR number" }];
  const s = fold([created, { type: "session.updated", sessionId: "a", patch: { commands } }]);
  assert.deepEqual(s.sessions.a.commands, commands);
  const later = fold([created, { type: "session.updated", sessionId: "a", patch: { commands } }, { type: "session.updated", sessionId: "a", patch: { commands: [{ name: "init" }] } }]);
  assert.deepEqual(later.sessions.a.commands, [{ name: "init" }]);
});

const HOUR = 3_600_000;
const now = 1_000 * HOUR;
const reading = (utilization: number, left: number, window: "seven_day" | "five_hour" = "seven_day") => ({ window, utilization, resetsAt: now + left, at: now });

test("usage line: shown only when 30%+ used and on pace to run out before the reset", () => {
  const at = (r: ReturnType<typeof reading>, dismissed: string[] = []) => usageNotice(fold([{ type: "usage.reading", reading: r }, ...dismissed.map((key): PerzianEvent => ({ type: "usage.dismissed", key, at: now }))]).usage, now);
  // 39% used with 2 of 7 days gone: on pace for ~136%
  assert.equal(at(reading(0.39, 5 * 24 * HOUR))?.window, "seven_day");
  // 39% used with 6 of 7 days gone: fine
  assert.equal(at(reading(0.39, 1 * 24 * HOUR)), null);
  // fast but under 30%
  assert.equal(at(reading(0.2, 6 * 24 * HOUR)), null);
  // a window that already reset
  assert.equal(at(reading(0.9, -HOUR)), null);
  // dismissed for this window and reset, but not the next reset
  const r = reading(0.39, 5 * 24 * HOUR);
  assert.equal(at(r, [usageKey(r)]), null);
  assert.ok(at(reading(0.39, 5 * 24 * HOUR + 1), [usageKey(r)]));
});
