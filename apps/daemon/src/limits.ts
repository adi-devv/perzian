// Plan usage limits: recognize "you hit your limit" from an agent and work out when it resets.
//
// Sources, most to least structured:
// - Claude: `usage_update` carries the CLI's rate-limit info in _meta["_claude/rateLimit"]
//   ({ status: allowed | allowed_warning | rejected, resetsAt (unix s), rateLimitType, utilization }).
// - Claude: when a request is refused the CLI writes a synthetic assistant message, e.g.
//   "You've hit your session limit · resets 5:40pm (Asia/Calcutta)", and the prompt then fails with the
//   same text (data.errorKind "rate_limit" when the API said so).
// - Codex (best effort, untested against a real account): the turn fails with
//   data.codexErrorInfo "usageLimitExceeded" / "rateLimitExceeded" and a message like "You've hit your
//   usage limit. … try again in 4 days 3 hours 5 minutes." Codex's own window percentages aren't sent
//   over ACP, so there's no early pause for it (TBD).
import type { LimitWindow } from "@perzian/protocol";

export interface LimitHit {
  /** The agent's words, or a short description built from structured info. */
  reason: string;
  /** When the limit resets, ms since epoch, if it could be told. */
  resetAt?: number;
  window?: LimitWindow;
  /** A short-term rate limit (429) rather than a plan window: retried sooner when no reset is given. */
  transient?: boolean;
  /** Already decided (shared with other sessions): resume exactly then, whatever `resetAt` says. */
  resumeAt?: number;
  /** With `resumeAt`: it is a retry guess, not a told reset time. */
  estimated?: boolean;
}

export interface ParseOptions {
  now: number;
  /** IANA zone for times printed without one. Default: this machine's. */
  timeZone?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Pause early (after the current step) once a window is this full. PERZIAN_PAUSE_AT=off disables. */
export const NEAR_LIMIT = 0.95;
/** No reset time reported: try again after this long. */
export const FALLBACK_RETRY_MS = HOUR;
export const TRANSIENT_RETRY_MS = 5 * MINUTE;
/** Never resume sooner than this after pausing, even if the printed reset time has just passed. */
export const MIN_WAIT_MS = MINUTE;
// A wall-clock reset time printed without a date is today, unless it's this far in the past: then tomorrow.
const PAST_SLACK_MS = 15 * MINUTE;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

// Where a limit message starts: Claude Code's usage-limit prefixes and older wording, Codex's wording.
const LIMIT_PHRASE =
  /(?:you've|you have) (?:hit|reached) your\b|claude(?: ai)? usage limit reached|(?:5-hour|five-hour|session|weekly|daily|opus|sonnet|usage) limit (?:reached|exceeded|hit)|you're out of (?:usage|extra usage)/i;
// Looser, for error messages only (never for model prose).
const LIMIT_IN_ERROR = /\b(?:usage limit|session limit|weekly limit|5-hour limit|usage_limit|usageLimitExceeded)\b/i;
const RATE_IN_ERROR = /\b(?:rate[ _-]?limit(?:ed|Exceeded)?|too many requests|status 429|429 too many)\b/i;
// Limits that don't reset on a clock (credits, funds, seats, admin settings): without a reset time these
// stay failures, since waiting won't help.
const NOT_TIMED = /add funds|contact your admin|seat type|disabled by your admin|set to \$0|requires usage credits|out of usage credits/i;

export function windowOf(text: string): LimitWindow | undefined {
  if (/\bopus\b/i.test(text)) return "seven_day_opus";
  if (/\bsonnet\b/i.test(text)) return "seven_day_sonnet";
  if (/week|7-day|seven[- ]day/i.test(text)) return "seven_day";
  if (/session limit|5-hour|five[- ]hour|\b5h\b/i.test(text)) return "five_hour";
  if (/extra usage|overage/i.test(text)) return "overage";
  return undefined;
}

const clean = (s: string) =>
  s
    .replace(/^(?:Error:\s*)?(?:Internal error(?::\s*|$))?/i, "")
    .replace(/\|\s*\d{10,13}\b/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

/**
 * A usage-limit message, or null. `strict` (for agent text): the text must end with a limit message, as
 * Claude's synthetic one does, so a model merely talking about rate limits doesn't pause anything.
 * Otherwise (error messages) a limit phrase anywhere counts.
 */
export function parseLimitText(text: string, opts: ParseOptions & { strict?: boolean }): LimitHit | null {
  const t = text.trim();
  if (!t) return null;
  let reason: string | undefined;
  let transient = false;
  if (opts.strict) {
    const tail = t.slice(-400);
    let m: RegExpExecArray | null;
    let last: number | undefined;
    const re = new RegExp(LIMIT_PHRASE.source, "gi");
    while ((m = re.exec(tail))) last = m.index;
    if (last === undefined) return null;
    const msg = tail.slice(last);
    if (msg.length > 250 || !/limit|usage/i.test(msg)) return null;
    // The message must start a sentence or line, not sit in the middle of one.
    const before = tail.slice(0, last).trimEnd();
    if (before && !/[.!?:\n]$/.test(before) && !/\n\s*$/.test(tail.slice(0, last))) return null;
    reason = clean(msg);
  } else if (LIMIT_PHRASE.test(t) || LIMIT_IN_ERROR.test(t)) {
    reason = clean(t);
  } else if (RATE_IN_ERROR.test(t)) {
    reason = clean(t);
    transient = true;
  } else return null;

  const resetAt = parseResetTime(t, opts);
  if (resetAt === undefined && NOT_TIMED.test(t)) return null;
  const window = windowOf(reason);
  return { reason, ...(resetAt !== undefined ? { resetAt } : {}), ...(window ? { window } : {}), ...(transient && !window ? { transient } : {}) };
}

/** The reset time named in a limit message (ms since epoch), or undefined. */
export function parseResetTime(text: string, opts: ParseOptions): number | undefined {
  const tz = validZone(opts.timeZone) ?? localZone();
  // "Claude AI usage limit reached|1760000000" (older Claude Code), unix seconds or ms.
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch) return toMs(Number(epoch[1]));
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(text);
  if (iso) {
    const t = Date.parse(iso[1].replace(" ", "T"));
    if (Number.isFinite(t)) return t;
  }
  const kw = /\b(?:resets?|reset at|try again|available again|until)\b[\s:]*(?:at\s+|on\s+)?/gi;
  let k: RegExpExecArray | null;
  while ((k = kw.exec(text))) {
    const at = wallClock(text.slice(k.index + k[0].length), tz, opts.now);
    if (at !== undefined) return at;
  }
  const rel = /\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(?:\s*,?\s*(?:and\s+)?)?)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const u = unit.toLowerCase();
      ms += Number(n) * (u.startsWith("d") ? DAY : u.startsWith("h") ? HOUR : u.startsWith("m") ? MINUTE : 1000);
    }
    if (ms > 0) return opts.now + ms;
  }
  return undefined;
}

// "5:40pm (Asia/Calcutta)", "Oct 14, 5pm", "Mon 9am", "Oct 12th, 2025 3:40 PM", "17:40 UTC", "14 Oct".
function wallClock(s: string, defaultZone: string, now: number): number | undefined {
  let r = s;
  let m: RegExpExecArray | null;
  let wd: number | undefined, mon: number | undefined, day: number | undefined, year: number | undefined;
  let h: number | undefined, mi = 0;
  if ((m = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+/i.exec(r))) {
    wd = WEEKDAYS.indexOf(m[1].toLowerCase());
    r = r.slice(m[0].length);
  }
  if ((m = new RegExp(`^${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?,?\\s*(?:at\\s+)?`, "i").exec(r))) {
    mon = MONTHS.indexOf(m[1].toLowerCase());
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
    r = r.slice(m[0].length);
  } else if ((m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?:\\s+(\\d{4})\\b)?,?\\s*(?:at\\s+)?`, "i").exec(r))) {
    day = Number(m[1]);
    mon = MONTHS.indexOf(m[2].toLowerCase());
    year = m[3] ? Number(m[3]) : undefined;
    r = r.slice(m[0].length);
  }
  if ((m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?\s?m\.?(?![a-z])/i.exec(r))) {
    const hh = Number(m[1]);
    if (hh < 1 || hh > 12) return undefined;
    h = (hh % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
    mi = m[2] ? Number(m[2]) : 0;
    r = r.slice(m[0].length);
  } else if ((m = /^([01]?\d|2[0-3]):([0-5]\d)(?::\d{2})?(?!\d)/.exec(r))) {
    h = Number(m[1]);
    mi = Number(m[2]);
    r = r.slice(m[0].length);
  }
  if (h === undefined && mon === undefined) return undefined;
  if (mi > 59 || (day !== undefined && (day < 1 || day > 31))) return undefined;
  const zm = /^\s*\(?\s*([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT|Z)\s*\)?/.exec(r);
  const tz = (zm && validZone(zm[1] === "Z" ? "UTC" : zm[1])) || defaultZone;

  const today = partsIn(now, tz);
  const at = (y: number, mo: number, d: number) => zonedEpoch(y, mo, d, h ?? 0, mi, tz);
  if (mon !== undefined && day !== undefined) {
    let t = at(year ?? today.y, mon, day);
    if (year === undefined && t < now - DAY) t = at(today.y + 1, mon, day);
    return t;
  }
  let offset = wd !== undefined ? (wd - today.wd + 7) % 7 : 0;
  let t = at(today.y, today.mo, today.d + offset);
  if (t < now - PAST_SLACK_MS) {
    offset += wd !== undefined ? 7 : 1;
    t = at(today.y, today.mo, today.d + offset);
  }
  return t;
}

const toMs = (n: number) => (n < 1e12 ? n * 1000 : n);

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(epoch: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(epoch))) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), wd: WEEKDAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()) };
}

/** How far `tz` is ahead of UTC at `epoch`, in ms. */
function zoneOffset(epoch: number, tz: string): number {
  const p = partsIn(epoch, tz);
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(epoch / 1000) * 1000;
}

/** A wall-clock time in `tz` as ms since epoch. Day overflow (Oct 32) rolls over like Date.UTC. */
export function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffset(guess, tz);
  return guess - zoneOffset(first, tz);
}

// ---- Claude's structured rate-limit info ----

export interface RateLimitReading {
  /** rejected: the limit is hit; near: past the threshold; ok: neither. */
  state: "rejected" | "near" | "ok";
  resetAt?: number;
  window?: LimitWindow;
  /** 0..1 */
  utilization?: number;
  /** Extra (paid) usage is in use or allowed on this account: running past the plan limit may cost money. */
  overage?: true;
}

const RATE_WINDOW: Record<string, LimitWindow> = {
  five_hour: "five_hour",
  seven_day: "seven_day",
  seven_day_opus: "seven_day_opus",
  seven_day_sonnet: "seven_day_sonnet",
  seven_day_overage_included: "seven_day",
  overage: "overage",
};

export const WINDOW_LABEL: Record<LimitWindow, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  overage: "Extra usage limit",
  unknown: "Usage limit",
};

/** Reads _meta["_claude/rateLimit"] (SDKRateLimitInfo). `threshold` <= 0 or > 1 turns off "near". */
export function readRateLimit(info: unknown, threshold = NEAR_LIMIT): RateLimitReading | null {
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  const status = i.status;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return null;
  const resetAt = typeof i.resetsAt === "number" && i.resetsAt > 0 ? toMs(i.resetsAt) : undefined;
  const window = typeof i.rateLimitType === "string" ? RATE_WINDOW[i.rateLimitType] ?? "unknown" : undefined;
  const raw = typeof i.utilization === "number" && Number.isFinite(i.utilization) ? i.utilization : undefined;
  const utilization = raw === undefined ? undefined : raw > 1 ? raw / 100 : raw;
  // Past the plan limit but drawing on paid extra usage: not blocked, and the developer chose to pay.
  const overage = i.isUsingOverage === true || i.overageInUse === true || i.overageStatus === "allowed" || i.overageStatus === "allowed_warning";
  const base = { ...(resetAt !== undefined ? { resetAt } : {}), ...(window ? { window } : {}), ...(utilization !== undefined ? { utilization } : {}), ...(overage ? { overage: true as const } : {}) };
  if (status === "rejected") return { state: overage ? "ok" : "rejected", ...base };
  if (threshold > 0 && threshold <= 1 && utilization !== undefined && utilization >= threshold) return { state: "near", ...base };
  return { state: "ok", ...base };
}

export function hitFromReading(r: RateLimitReading): LimitHit {
  const label = WINDOW_LABEL[r.window ?? "unknown"];
  const reason = r.state === "near" ? `${label} ${Math.round((r.utilization ?? 0) * 100)}% used` : `${label} reached`;
  return { reason, ...(r.resetAt !== undefined ? { resetAt: r.resetAt } : {}), ...(r.window ? { window: r.window } : {}) };
}

// ---- Errors from a failed prompt ----

/** A usage or rate limit behind a failed `session/prompt`, from the ACP error's message and data. */
export function limitFromError(err: unknown, opts: ParseOptions, extra = ""): LimitHit | null {
  const e = err as { message?: unknown; data?: unknown } | null;
  const data = e?.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const texts = [str(data?.message), str(data?.additionalDetails), str(data?.details), str(e?.data), str(e?.message), extra].filter(Boolean);
  for (const t of texts) {
    const hit = parseLimitText(t, opts);
    if (hit) return hit;
  }
  const info = data?.errorKind ?? data?.codexErrorInfo;
  const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  if (kind === "rate_limit" || kind === "usageLimitExceeded" || kind === "rateLimitExceeded") {
    const all = texts.join(" \n");
    const resetAt = parseResetTime(all, opts);
    const reason = texts.map(clean).find(Boolean) || (kind === "rateLimitExceeded" ? "Rate limited" : "Usage limit reached");
    const window = windowOf(all);
    return { reason, ...(resetAt !== undefined ? { resetAt } : {}), ...(window ? { window } : {}), ...(kind === "rateLimitExceeded" && !window ? { transient: true } : {}) };
  }
  return null;
}

/** When to resume after `hit`: its reset time (never sooner than MIN_WAIT_MS), else a retry guess. */
export function resumeTime(hit: LimitHit, now: number): { resumeAt: number; estimated?: true } {
  if (hit.resumeAt !== undefined) return { resumeAt: hit.resumeAt, ...(hit.estimated ? { estimated: true as const } : {}) };
  if (hit.resetAt !== undefined && hit.resetAt > now - DAY && hit.resetAt < now + 31 * DAY) return { resumeAt: Math.max(hit.resetAt, now + MIN_WAIT_MS) };
  return { resumeAt: now + (hit.transient ? TRANSIENT_RETRY_MS : FALLBACK_RETRY_MS), estimated: true };
}

/** The pause threshold from PERZIAN_PAUSE_AT ("0.9", "90", "off"); NEAR_LIMIT by default. */
export function pauseThreshold(env = process.env.PERZIAN_PAUSE_AT): number {
  if (env === undefined || env === "") return NEAR_LIMIT;
  if (/^(off|false|no|0)$/i.test(env)) return 0;
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) return NEAR_LIMIT;
  return n > 1 ? n / 100 : n;
}
