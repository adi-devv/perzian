import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_RETRY_MS,
  MIN_WAIT_MS,
  TRANSIENT_RETRY_MS,
  hitFromReading,
  limitFromError,
  parseLimitText,
  parseResetTime,
  pauseThreshold,
  readRateLimit,
  resumeTime,
  zonedEpoch,
} from "../src/limits.ts";

// Sunday 11 Oct 2026, 10:00 UTC = 15:30 in India, 06:00 in New York, 03:00 in Los Angeles.
const NOW = Date.parse("2026-10-11T10:00:00Z");
const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());
const parse = (text: string, timeZone = "UTC", strict = false) => parseLimitText(text, { now: NOW, timeZone, strict });

describe("parseLimitText: Claude messages", () => {
  test("session limit with an IANA zone in parentheses", () => {
    const hit = parse("You've hit your session limit · resets 5:40pm (Asia/Calcutta)");
    assert.equal(hit?.reason, "You've hit your session limit · resets 5:40pm (Asia/Calcutta)");
    assert.equal(iso(hit?.resetAt), "2026-10-11T12:10:00.000Z");
    assert.equal(hit?.window, "five_hour");
  });

  test("the printed zone wins over the default zone", () => {
    const hit = parse("You've hit your session limit · resets 5:40pm (Asia/Kolkata)", "America/Los_Angeles");
    assert.equal(iso(hit?.resetAt), "2026-10-11T12:10:00.000Z");
  });

  test("no zone printed: the default zone", () => {
    assert.equal(iso(parse("You've hit your session limit · resets 9pm", "America/New_York")?.resetAt), "2026-10-12T01:00:00.000Z");
  });

  test("weekly limit with a month and day", () => {
    const hit = parse("You've hit your weekly limit · resets Oct 14, 5pm (America/New_York)");
    assert.equal(iso(hit?.resetAt), "2026-10-14T21:00:00.000Z", "EDT is UTC-4");
    assert.equal(hit?.window, "seven_day");
  });

  test("day-first date and a winter zone", () => {
    assert.equal(iso(parse("You've hit your weekly limit · resets 14 Oct 9am (Europe/Berlin)")?.resetAt), "2026-10-14T07:00:00.000Z");
    assert.equal(iso(parse("You've hit your weekly limit · resets Dec 2, 9am (Europe/Berlin)")?.resetAt), "2026-12-02T08:00:00.000Z", "CET is UTC+1");
  });

  test("a date already well past means next year", () => {
    assert.equal(iso(parse("You've hit your weekly limit · resets Jan 3, 9am (UTC)")?.resetAt), "2027-01-03T09:00:00.000Z");
  });

  test("model-scoped limit with a weekday", () => {
    const hit = parse("You've reached your Opus limit · resets Mon 9am (Europe/London)");
    assert.equal(iso(hit?.resetAt), "2026-10-12T08:00:00.000Z", "Monday, BST");
    assert.equal(hit?.window, "seven_day_opus");
  });

  test("a time already passed today means tomorrow; just passed means now", () => {
    assert.equal(iso(parse("5-hour limit reached ∙ resets 2am (UTC)")?.resetAt), "2026-10-12T02:00:00.000Z");
    assert.equal(iso(parse("You've hit your session limit · resets 12am (UTC)")?.resetAt), "2026-10-12T00:00:00.000Z");
    assert.equal(iso(parse("You've hit your session limit · resets 9:55am (UTC)")?.resetAt), "2026-10-11T09:55:00.000Z", "within the slack: today");
  });

  test("spaced and dotted am/pm, 24-hour clock, older wording", () => {
    assert.equal(iso(parse("You've hit your limit · resets 5:40 p.m. (Asia/Kolkata)")?.resetAt), "2026-10-11T12:10:00.000Z");
    assert.equal(iso(parse("Claude usage limit reached. Your limit will reset at 17:40 UTC.")?.resetAt), "2026-10-11T17:40:00.000Z");
    assert.equal(iso(parse("Claude usage limit reached. Your limit will reset at 5pm (America/Chicago).")?.resetAt), "2026-10-11T22:00:00.000Z");
  });

  test("older pipe format with a unix timestamp", () => {
    const hit = parse("Claude AI usage limit reached|1791748800");
    assert.equal(iso(hit?.resetAt), "2026-10-11T20:00:00.000Z");
    assert.equal(hit?.reason, "Claude AI usage limit reached");
  });

  test("an unknown zone falls back to the default", () => {
    assert.equal(iso(parse("You've hit your session limit · resets 4pm (Mars/Olympus)", "UTC")?.resetAt), "2026-10-11T16:00:00.000Z");
  });

  test("a limit with no reset time is still a limit, unless waiting can't fix it", () => {
    const hit = parse("You've hit your usage limit");
    assert.equal(hit?.resetAt, undefined);
    assert.equal(parse("You're out of usage credits · add funds to continue"), null);
    assert.equal(parse("Your seat type doesn't include usage"), null);
  });
});

describe("parseLimitText: Codex messages (best effort)", () => {
  test("relative wait", () => {
    const hit = parse("You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 21 hours 33 minutes.");
    assert.equal(iso(hit?.resetAt), "2026-10-16T07:33:00.000Z");
  });

  test("absolute time with an ordinal and a year", () => {
    assert.equal(iso(parse("You've hit your usage limit. Try again at Oct 12th, 2026 3:40 PM.", "America/Los_Angeles")?.resetAt), "2026-10-12T22:40:00.000Z");
  });

  test("short rate limits are transient", () => {
    const hit = parse("exceeded retry limit, last status: 429 Too Many Requests, try again in 30s");
    assert.equal(hit?.transient, true);
    assert.equal(iso(hit?.resetAt), "2026-10-11T10:00:30.000Z");
  });
});

describe("parseLimitText strict (agent text)", () => {
  test("prose about limits isn't a limit", () => {
    assert.equal(parse("I added a rate limit to /search; you've reached your goal.", "UTC", true), null);
    assert.equal(parse("The usage limit middleware now returns 429.", "UTC", true), null);
    assert.equal(parse("Done. Note that you've hit your session limit · resets 5pm logic is in limits.ts", "UTC", true), null, "quoted mid-sentence");
    assert.equal(parse(`You've hit your session limit · resets 5pm${" and more prose".repeat(20)}`, "UTC", true), null, "too long to be the limit message");
  });

  test("a limit message at the end of the turn's text counts", () => {
    const a = parse("Fixed the bug.\n\nYou've hit your session limit · resets 5:40pm (Asia/Calcutta)", "UTC", true);
    assert.equal(a?.reason, "You've hit your session limit · resets 5:40pm (Asia/Calcutta)");
    const glued = parse("Running the tests now.You've hit your session limit · resets 5:40pm (Asia/Calcutta)", "UTC", true);
    assert.equal(iso(glued?.resetAt), "2026-10-11T12:10:00.000Z");
    assert.equal(parse("Running the tests nowYou've hit your session limit · resets 5:40pm", "UTC", true), null, "mid-sentence");
  });
});

describe("parseResetTime and zonedEpoch", () => {
  test("ISO timestamps", () => {
    assert.equal(parseResetTime("resets at 2026-10-11T17:40:00Z", { now: NOW }), Date.parse("2026-10-11T17:40:00Z"));
    assert.equal(parseResetTime("until 2026-10-11T17:40:00+05:30", { now: NOW }), Date.parse("2026-10-11T12:10:00Z"));
  });

  test("nothing to read", () => {
    assert.equal(parseResetTime("You've hit your limit", { now: NOW }), undefined);
    assert.equal(parseResetTime("resets 5", { now: NOW }), undefined, "a bare hour is ambiguous");
  });

  test("DST: wall-clock times on both sides of a change", () => {
    assert.equal(iso(zonedEpoch(2026, 2, 7, 12, 0, "America/New_York")), "2026-03-07T17:00:00.000Z");
    assert.equal(iso(zonedEpoch(2026, 2, 9, 12, 0, "America/New_York")), "2026-03-09T16:00:00.000Z");
    assert.equal(iso(zonedEpoch(2026, 9, 32, 1, 0, "UTC")), "2026-11-01T01:00:00.000Z", "day overflow rolls over");
  });
});

describe("limitFromError", () => {
  test("Claude: the error message carries the limit text", () => {
    const hit = limitFromError({ message: "Internal error: You've hit your session limit · resets 5:40pm (Asia/Calcutta)", data: { errorKind: "rate_limit" } }, { now: NOW });
    assert.equal(hit?.reason, "You've hit your session limit · resets 5:40pm (Asia/Calcutta)");
    assert.equal(iso(hit?.resetAt), "2026-10-11T12:10:00.000Z");
  });

  test("Claude: only the error kind", () => {
    const hit = limitFromError({ message: "Internal error", data: { errorKind: "rate_limit" } }, { now: NOW });
    assert.deepEqual(hit, { reason: "Usage limit reached" });
  });

  test("Codex: usageLimitExceeded with details", () => {
    const hit = limitFromError({ message: "Internal error", data: { message: "You've hit your usage limit. Try again in 2 hours 5 minutes.", codexErrorInfo: "usageLimitExceeded" } }, { now: NOW });
    assert.equal(iso(hit?.resetAt), "2026-10-11T12:05:00.000Z");
  });

  test("Codex: rateLimitExceeded is transient", () => {
    const hit = limitFromError({ message: "Internal error", data: { message: "stream error", codexErrorInfo: { rateLimitExceeded: {} } } }, { now: NOW });
    assert.deepEqual(hit, { reason: "stream error", transient: true });
  });

  test("other errors aren't limits", () => {
    assert.equal(limitFromError({ message: "Internal error: agent exited (1)" }, { now: NOW }), null);
    assert.equal(limitFromError(new Error("ENOENT"), { now: NOW }), null);
    assert.equal(limitFromError(null, { now: NOW }), null);
  });
});

describe("readRateLimit (Claude's _claude/rateLimit)", () => {
  const resetsAt = Date.parse("2026-10-11T12:10:00Z") / 1000;

  test("rejected: hit, with the reset time in seconds", () => {
    const r = readRateLimit({ status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1 });
    assert.deepEqual(r, { state: "rejected", resetAt: resetsAt * 1000, window: "five_hour", utilization: 1 });
    assert.deepEqual(hitFromReading(r!), { reason: "5-hour limit reached", resetAt: resetsAt * 1000, window: "five_hour" });
  });

  test("near: past the threshold, as a fraction or a percent", () => {
    assert.equal(readRateLimit({ status: "allowed_warning", resetsAt, rateLimitType: "seven_day", utilization: 0.96 })?.state, "near");
    const pct = readRateLimit({ status: "allowed_warning", resetsAt, rateLimitType: "seven_day_opus", utilization: 97 });
    assert.equal(pct?.state, "near");
    assert.equal(hitFromReading(pct!).reason, "Weekly Opus limit 97% used");
    assert.equal(readRateLimit({ status: "allowed", resetsAt, utilization: 0.5 })?.state, "ok");
  });

  test("extra usage in play: not blocked, no early pause", () => {
    assert.equal(readRateLimit({ status: "rejected", resetsAt, overageStatus: "allowed", isUsingOverage: true })?.state, "ok");
    assert.equal(readRateLimit({ status: "allowed_warning", resetsAt, utilization: 0.99, isUsingOverage: true })?.state, "ok");
  });

  test("threshold off, and junk", () => {
    assert.equal(readRateLimit({ status: "allowed_warning", resetsAt, utilization: 0.99 }, 0)?.state, "ok");
    assert.equal(readRateLimit(undefined), null);
    assert.equal(readRateLimit({ status: "weird" }), null);
  });

  test("PERZIAN_PAUSE_AT", () => {
    assert.equal(pauseThreshold(undefined), 0.95);
    assert.equal(pauseThreshold("90"), 0.9);
    assert.equal(pauseThreshold("0.8"), 0.8);
    assert.equal(pauseThreshold("off"), 0);
  });
});

describe("resumeTime", () => {
  test("the reset time, but never sooner than a minute", () => {
    assert.deepEqual(resumeTime({ reason: "x", resetAt: NOW + 3600_000 }, NOW), { resumeAt: NOW + 3600_000 });
    assert.deepEqual(resumeTime({ reason: "x", resetAt: NOW - 60_000 }, NOW), { resumeAt: NOW + MIN_WAIT_MS });
  });

  test("no (or absurd) reset time: a retry guess, sooner for a transient rate limit", () => {
    assert.deepEqual(resumeTime({ reason: "x" }, NOW), { resumeAt: NOW + FALLBACK_RETRY_MS, estimated: true });
    assert.deepEqual(resumeTime({ reason: "x", transient: true }, NOW), { resumeAt: NOW + TRANSIENT_RETRY_MS, estimated: true });
    assert.deepEqual(resumeTime({ reason: "x", resetAt: NOW + 400 * 86400_000 }, NOW), { resumeAt: NOW + FALLBACK_RETRY_MS, estimated: true });
  });
});
