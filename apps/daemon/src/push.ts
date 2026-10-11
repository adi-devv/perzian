// Web Push to paired phones. The daemon sends it itself (VAPID, straight to the browser vendor's push
// service); there are no servers of ours in the path. What a push may say is deliberately tiny: a status
// word and the session's title. Never code, diffs, file names or agent text. Opening the app (behind the
// device token) is how you see anything more.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { PerzianEvent, SessionInfo } from "@perzian/protocol";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Where the push services live. A paired phone chooses its own endpoint, and the daemon POSTs to it: without
 *  this list a stolen token could aim the daemon at any URL. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/** A well-formed subscription for a known push service, or undefined. */
export function validateSubscription(x: unknown): PushSubscriptionJSON | undefined {
  const o = x as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (typeof o?.endpoint !== "string" || o.endpoint.length > 1024) return undefined;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  const b64 = /^[A-Za-z0-9_-]{8,200}={0,2}$/;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !b64.test(p256dh) || !b64.test(auth)) return undefined;
  let u: URL;
  try {
    u = new URL(o.endpoint);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password || !PUSH_HOSTS.some((r) => r.test(u.hostname))) return undefined;
  return { endpoint: u.toString(), keys: { p256dh, auth } };
}

/* ───────────── VAPID keys ───────────── */

export interface Vapid {
  publicKey: string;
  privateKey: string;
}

/** Generated once, kept in <PERZIAN_HOME>/vapid.json (0600). Replacing it would orphan every subscription. */
export function loadVapid(home: string): Vapid {
  const file = join(home, "vapid.json");
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Vapid>;
    if (typeof j.publicKey === "string" && typeof j.privateKey === "string") {
      chmodSync(file, 0o600);
      return { publicKey: j.publicKey, privateKey: j.privateKey };
    }
  } catch {}
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}

/* ───────────── What to send ───────────── */

export type PushKind = "needs_you" | "failed" | "done";
export interface PushItem {
  sessionId: string;
  kind: PushKind;
  /** The session's title (2-5 words). */
  title: string;
}
export interface PushPayload {
  title: string;
  body: string;
  /** Same tag replaces the previous notification instead of stacking. */
  tag: string;
  /** Where tapping opens the PWA. */
  url: string;
  urgent: boolean;
}

/** Stands in for a session id on the account usage card's push. */
export const USAGE_ID = "usage-card";

const WORD: Record<PushKind, string> = { needs_you: "Needs you", failed: "Failed", done: "Done" };
const URGENCY: Record<PushKind, number> = { needs_you: 0, failed: 1, done: 2 };

const oneLine = (s: string, n: number) => {
  const t = s.replace(/[`\s]+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The only place a push's words are made: status words and a session title, nothing else is read. */
export function buildPayload(items: PushItem[]): PushPayload {
  // One entry per session; the most urgent thing that happened to it wins.
  const bySession = new Map<string, PushItem>();
  for (const i of items) {
    const old = bySession.get(i.sessionId);
    if (!old || URGENCY[i.kind] <= URGENCY[old.kind]) bySession.set(i.sessionId, i);
  }
  const list = [...bySession.values()].sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind]);
  const urgent = list.some((i) => i.kind !== "done");
  if (list.length === 1) {
    const i = list[0];
    const id = i.sessionId.replace(/[^\w-]/g, "");
    return { title: WORD[i.kind], body: oneLine(i.title, 80) || "A session", tag: "perzian", url: i.sessionId === USAGE_ID ? "/" : `/#session=${id}`, urgent };
  }
  const n = (k: PushKind) => list.filter((i) => i.kind === k).length;
  const parts = [n("needs_you") && `${n("needs_you")} need you`, n("failed") && `${n("failed")} failed`, n("done") && `${n("done")} done`].filter(Boolean);
  return { title: "Perzian", body: parts.join(" · "), tag: "perzian", url: "/", urgent };
}

/** The push-worthy moment in an event, if it is one: a session that needs you, failed or is done. */
export function itemForEvent(e: PerzianEvent, sessions: Record<string, SessionInfo>): PushItem | undefined {
  // The account usage card, while unanswered: it pauses everything if nobody answers in time.
  if (e.type === "usage.card") return e.card.answer ? undefined : { sessionId: USAGE_ID, kind: "needs_you", title: `Usage ${Math.round(e.card.utilization * 100)}%` };
  if (e.type !== "session.status") return undefined;
  if (e.status !== "needs_you" && e.status !== "failed" && e.status !== "done") return undefined;
  const s = sessions[e.sessionId];
  if (!s || s.archived) return undefined;
  return { sessionId: s.id, kind: e.status, title: s.title };
}

/* ───────────── Coalescing ───────────── */

/** Collects items; the first one starts a window and everything inside it goes out together. */
export class Coalescer<T> {
  private pending: T[] = [];
  private cancel?: () => void;
  constructor(
    private flush: (items: T[]) => void,
    private windowMs = 5000,
    private schedule: (fn: () => void, ms: number) => () => void = (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    },
  ) {}
  add(item: T) {
    this.pending.push(item);
    this.cancel ??= this.schedule(() => {
      const items = this.pending;
      this.pending = [];
      this.cancel = undefined;
      this.flush(items);
    }, this.windowMs);
  }
  dispose() {
    this.cancel?.();
    this.cancel = undefined;
    this.pending = [];
  }
}

/* ───────────── Is the Mac UI being looked at? ───────────── */

/** The Mac UI reports focus now and then (ui.presence). Silence counts as "not looking", so a closed or crashed
 *  window never mutes pushes. Only the Mac's own socket can send this; a phone can't. */
export class Presence {
  private focused = false;
  private at = 0;
  constructor(private now: () => number = Date.now, private ttlMs = 30_000) {}
  report(focused: boolean) {
    this.focused = focused;
    this.at = this.now();
  }
  active(): boolean {
    return this.focused && this.now() - this.at < this.ttlMs;
  }
}

/* ───────────── Sending ───────────── */

export type SendPush = (sub: PushSubscriptionJSON, body: string, o: { TTL: number; urgency: "high" | "normal" }) => Promise<unknown>;

export interface PushDevices {
  subscriptions(): Array<{ id: string; sub: PushSubscriptionJSON }>;
  dropSubscription(id: string): void;
}

export interface PushSenderOptions {
  devices: PushDevices;
  vapid: Vapid;
  /** Phone access is on. Off means off: no pushes either. */
  enabled: () => boolean;
  /** The Mac UI is focused and active: it already has the developer's attention. */
  uiActive: () => boolean;
  send?: SendPush;
  windowMs?: number;
  schedule?: ConstructorParameters<typeof Coalescer>[2];
  /** VAPID contact. Push services use it only to reach us if we misbehave. */
  subject?: string;
}

export class PushSender {
  private coalescer: Coalescer<PushItem>;
  private send: SendPush;
  constructor(private o: PushSenderOptions) {
    const subject = o.subject ?? "mailto:perzian@example.com";
    this.send = o.send ?? ((sub, body, opts) => webpush.sendNotification(sub, body, { ...opts, vapidDetails: { subject, publicKey: o.vapid.publicKey, privateKey: o.vapid.privateKey } }));
    this.coalescer = new Coalescer<PushItem>((items) => void this.deliver(items), o.windowMs ?? 5000, o.schedule as never);
  }

  /** Queue a moment that may be worth a push; the window decides when it goes out. */
  notify(item: PushItem | undefined) {
    if (item) this.coalescer.add(item);
  }

  dispose() {
    this.coalescer.dispose();
  }

  /** Checked at send time, so "I switched to the Mac within five seconds" still counts. */
  private async deliver(items: PushItem[]) {
    if (!this.o.enabled() || this.o.uiActive()) return;
    const subs = this.o.devices.subscriptions();
    if (!subs.length) return;
    const payload = buildPayload(items);
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async ({ id, sub }) => {
        try {
          await this.send(sub, body, { TTL: 3600, urgency: payload.urgent ? "high" : "normal" });
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // The phone uninstalled the app or revoked permission: that subscription is gone for good.
          if (code === 404 || code === 410) this.o.devices.dropSubscription(id);
          else console.error(`perzian push: send failed (${code ?? (e as Error).message})`);
        }
      }),
    );
  }
}
