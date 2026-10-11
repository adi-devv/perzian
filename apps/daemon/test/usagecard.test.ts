// The account-level usage card: one question per window, a timeout that counts as Pause, "Keep going",
// the saved setting, and the shared limit. Fake sessions record what the governor asks of them.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, pendingUsageCard, type PerzianEvent } from "@perzian/protocol";
import { EventStore } from "../src/store.ts";
import { CARD_TIMEOUT_MS, UsageGovernor, type GovernedSession } from "../src/usagecard.ts";
import { hitFromReading, readRateLimit, type LimitHit, type RateLimitReading } from "../src/limits.ts";
import { startMode } from "../src/defaults.ts";

const HOUR = 3600_000;
const resetsAt = Date.now() + 2 * HOUR;
const near = (over: Partial<RateLimitReading> = {}): RateLimitReading => ({ state: "near", resetAt: resetsAt, window: "five_hour", utilization: 0.96, ...over });

class Fake implements GovernedSession {
  after: LimitHit[] = [];
  shared: LimitHit[] = [];
  info: GovernedSession["info"];
  constructor(id: string, o: Partial<GovernedSession["info"]> = {}) {
    this.info = { id, role: "worker", agent: "claude-code", status: "working", ...o };
  }
  pauseAfterCurrentStep(hit: LimitHit) {
    this.after.push(hit);
  }
  pauseForSharedLimit(hit: LimitHit) {
    this.shared.push(hit);
  }
}

const dirs: string[] = [];
const governors: UsageGovernor[] = [];
afterEach(() => {
  for (const g of governors.splice(0)) g.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(fakes: Fake[], timeoutMs = CARD_TIMEOUT_MS) {
  const dir = mkdtempSync(join(tmpdir(), "perzian-usage-"));
  dirs.push(dir);
  const store = new EventStore(dir, { compact: "never" });
  const gov = new UsageGovernor({ store, sessions: () => fakes, timeoutMs });
  governors.push(gov);
  const events = () => store.all();
  const cards = () => events().filter((e) => e.type === "usage.card");
  return { store, gov, events, cards, close: () => store.close() };
}

describe("usage card", () => {
  test("one card per window and reset, however many sessions report it", () => {
    const [a, b] = [new Fake("a"), new Fake("b")];
    const { gov, store, cards } = setup([a, b]);
    gov.near(near(), "a");
    gov.near(near(), "b");
    gov.near(near({ utilization: 0.97 }), "a");
    assert.equal(cards().length, 1);
    assert.equal(pendingUsageCard(store.state())?.key, `five_hour:${resetsAt}`);
    // Workers keep running while it's open.
    assert.deepEqual([a.after, b.after], [[], []]);
    // Another window, or the same window after it reset, is a new question.
    gov.near(near({ window: "seven_day" }), "a");
    gov.near(near({ resetAt: resetsAt + 5 * HOUR }), "a");
    assert.equal(cards().length, 3);
    store.close();
  });

  test("unanswered: pauses after the timeout, all workers with the same resume time", async () => {
    const [a, b, lead, idle, codex] = [new Fake("a"), new Fake("b"), new Fake("lead", { role: "main" }), new Fake("idle", { status: "idle" }), new Fake("x", { agent: "codex" })];
    const { gov, store, events } = setup([a, b, lead, idle, codex], 25);
    gov.near(near(), "a");
    gov.near(near(), "lead"); // the lead raises the card too, but is never paused by it
    assert.deepEqual([a.after.length, b.after.length], [0, 0]);
    await new Promise((r) => setTimeout(r, 120));
    const answered = events().find((e): e is Extract<PerzianEvent, { type: "usage.answered" }> => e.type === "usage.answered");
    assert.deepEqual([answered?.choice, answered?.auto], ["pause", true]);
    assert.equal(a.after.length, 1);
    assert.equal(b.after.length, 1);
    assert.equal(a.after[0].resumeAt, b.after[0].resumeAt);
    assert.equal(a.after[0].resumeAt, resetsAt);
    assert.deepEqual([lead.after, idle.after, codex.after], [[], [], []]);
    assert.equal(pendingUsageCard(store.state()), undefined);
    assert.equal(store.state().usageCards[`five_hour:${resetsAt}`].answer?.auto, true);
    store.close();
  });

  test("Pause answered by hand: no second pause from the timeout; a worker reporting later stops too", async () => {
    const [a, late] = [new Fake("a"), new Fake("late")];
    const { gov, store } = setup([a, late], 25);
    gov.near(near(), "a");
    gov.answer(`five_hour:${resetsAt}`, "pause");
    assert.equal(a.after.length, 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(a.after.length, 1, "the timeout doesn't answer twice");
    late.after.length = 0;
    gov.near(near({ utilization: 0.98 }), "late");
    assert.equal(late.after.length, 1);
    assert.equal(late.after[0].resetAt, resetsAt);
    store.close();
  });

  test("Keep going: no early pauses for that window, even past the timeout; the next window asks again", async () => {
    const a = new Fake("a");
    const { gov, store, cards } = setup([a], 25);
    gov.near(near(), "a");
    gov.answer(`five_hour:${resetsAt}`, "keep_going");
    gov.near(near({ utilization: 0.99 }), "a");
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual([a.after, cards().length], [[], 1]);
    gov.near(near({ resetAt: resetsAt + 5 * HOUR }), "a");
    assert.equal(cards().length, 2);
    store.close();
  });

  test("the saved setting skips the card: keep_going never pauses, pause always does", () => {
    const a = new Fake("a");
    const { gov, store, cards } = setup([a]);
    store.emit({ type: "settings.usageCard", mode: "keep_going", at: Date.now() });
    gov.near(near(), "a");
    assert.deepEqual([a.after, cards().length], [[], 0]);
    store.emit({ type: "settings.usageCard", mode: "pause", at: Date.now() });
    gov.near(near(), "a");
    assert.equal(a.after.length, 1);
    assert.equal(cards().length, 0, "no card either way");
    store.close();
  });

  test("a card's choice and the setting fold, and survive a restart", () => {
    const events: PerzianEvent[] = [
      { type: "usage.card", card: { key: "k", resetsAt, utilization: 0.95, at: 1, autoAt: 2 } },
      { type: "settings.usageCard", mode: "keep_going", at: 3 },
      { type: "usage.answered", key: "k", choice: "keep_going", at: 4 },
      { type: "usage.answered", key: "k", choice: "pause", at: 5 },
    ];
    const s = fold(events);
    assert.equal(s.settings.usageCard, "keep_going");
    assert.equal(s.usageCards.k.answer?.choice, "keep_going", "the first answer stands");
    assert.equal(pendingUsageCard(s), undefined);

    const dir = mkdtempSync(join(tmpdir(), "perzian-usage-"));
    dirs.push(dir);
    const store = new EventStore(dir, { compact: "never" });
    for (const e of events) store.emit(e);
    store.close();
    const again = new EventStore(dir, { compact: "always" });
    assert.deepEqual(again.state().usageCards, s.usageCards);
    assert.equal(again.state().settings.usageCard, "keep_going");
    again.close();
  });

  test("a card still open after a restart keeps its timeout", async () => {
    const a = new Fake("a");
    const { gov, store } = setup([a], 25);
    store.emit({ type: "usage.card", card: { key: "five_hour:1", window: "five_hour", resetsAt, utilization: 0.96, at: Date.now(), autoAt: Date.now() + 25 } });
    gov.attach();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(a.after.length, 1);
    store.close();
  });
});

describe("overage warning", () => {
  test("the reading and the card carry the extra-usage flag", () => {
    const base = { status: "allowed_warning", resetsAt: Math.floor(resetsAt / 1000), rateLimitType: "five_hour", utilization: 0.96 };
    assert.equal(readRateLimit({ ...base })?.overage, undefined);
    for (const extra of [{ isUsingOverage: true }, { overageStatus: "allowed" }, { overageStatus: "allowed_warning" }]) {
      const r = readRateLimit({ ...base, ...extra });
      assert.equal(r?.state, "near", "still asks: the developer should know");
      assert.equal(r?.overage, true);
    }
    const { gov, store, cards } = setup([new Fake("a")]);
    gov.near(readRateLimit({ ...base, overageStatus: "allowed" })!, "a");
    gov.near(readRateLimit({ ...base, rateLimitType: "seven_day" })!, "a");
    const [withExtra, without] = cards().map((e) => (e.type === "usage.card" ? e.card.overage : undefined));
    assert.deepEqual([withExtra, without], [true, undefined]);
    store.close();
  });
});

describe("shared limit", () => {
  test("a refused session pauses the other working Claude workers at once, with one resume time", () => {
    const [refused, a, b, lead, idle, codex, paused] = [
      new Fake("r"), new Fake("a"), new Fake("b"), new Fake("lead", { role: "main" }), new Fake("idle", { status: "idle" }), new Fake("x", { agent: "codex" }), new Fake("p", { status: "paused" }),
    ];
    const { gov, store } = setup([refused, a, b, lead, idle, codex, paused]);
    const hit = { ...hitFromReading({ state: "rejected", resetAt: resetsAt, window: "five_hour" }), resumeAt: resetsAt };
    gov.refused("r", hit);
    assert.equal(a.shared.length, 1);
    assert.equal(b.shared.length, 1);
    assert.equal(a.shared[0].resumeAt, resetsAt);
    assert.equal(a.shared[0].resumeAt, b.shared[0].resumeAt);
    assert.deepEqual([refused.shared, lead.shared, idle.shared, codex.shared, paused.shared], [[], [], [], [], []]);
    store.close();
  });

  test("without a resume time yet, all of them still get the same guess; a short-term 429 pauses nobody", () => {
    const [a, b] = [new Fake("a"), new Fake("b")];
    const { gov, store } = setup([a, b]);
    gov.refused("r", { reason: "Rate limited", transient: true });
    assert.deepEqual([a.shared, b.shared], [[], []]);
    gov.refused("r", { reason: "You've hit your limit" });
    assert.equal(a.shared[0].resumeAt, b.shared[0].resumeAt);
    assert.equal(a.shared[0].estimated, true);
    store.close();
  });
});

describe("default mode for a new session", () => {
  test("the creator's choice wins, else the global default", () => {
    const s = fold([{ type: "settings.defaultMode", mode: "edits", at: 1 }]);
    assert.equal(startMode(undefined, s.settings), "edits");
    assert.equal(startMode("plan", s.settings), "plan");
    assert.equal(startMode(undefined, fold([]).settings), "ask");
  });
});
