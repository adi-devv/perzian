import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerzianEvent, SessionInfo } from "@perzian/protocol";
import { Devices, PairingCodes, createPhoneServer } from "../src/phone.ts";
import { Coalescer, Presence, PushSender, buildPayload, itemForEvent, loadVapid, validateSubscription, type PushItem, type PushSubscriptionJSON } from "../src/push.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pz-push-"));
const sub = (n: string): PushSubscriptionJSON => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

describe("subscription validation", () => {
  test("accepts known push services only, https only", () => {
    assert.ok(validateSubscription(sub("a")));
    assert.ok(validateSubscription({ ...sub("a"), endpoint: "https://web.push.apple.com/QAbc" }));
    assert.ok(validateSubscription({ ...sub("a"), endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x" }));
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x", "https://127.0.0.1/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "nope", ""]) {
      assert.equal(validateSubscription({ ...sub("a"), endpoint }), undefined, endpoint);
    }
    assert.equal(validateSubscription({ endpoint: sub("a").endpoint }), undefined);
    assert.equal(validateSubscription({ ...sub("a"), keys: { p256dh: "x y", auth: "z" } }), undefined);
    assert.equal(validateSubscription(null), undefined);
  });
});

describe("subscription store and revoke", () => {
  test("stored per device, persisted 0600, and deleted when the device is revoked", () => {
    const home = tmp();
    const d = new Devices(home);
    const t1 = d.add();
    const t2 = d.add();
    const [id1, id2] = [d.idOf(t1)!, d.idOf(t2)!];
    assert.notEqual(id1, id2);
    assert.equal(d.idOf("bogus"), undefined);
    assert.ok(d.setSubscription(id1, sub("one")));
    assert.ok(d.setSubscription(id2, sub("two")));
    assert.ok(d.setSubscription(id1, sub("one-again"))); // one subscription per device: replaced
    assert.equal(d.subscriptions().length, 2);
    assert.equal(statSync(join(home, "phones.json")).mode & 0o777, 0o600);
    // The token itself is never stored; the id isn't the token.
    const raw = readFileSync(join(home, "phones.json"), "utf8");
    assert.ok(!raw.includes(t1) && !raw.includes(t2));
    // Survives a restart.
    const again = new Devices(home);
    assert.deepEqual(again.subscriptions().map((s) => s.sub.endpoint).sort(), [sub("one-again").endpoint, sub("two").endpoint].sort());
    // Revoking one phone: its token stops working and only its subscription goes.
    let revoked = 0;
    again.onRevoke(() => revoked++);
    assert.ok(again.revoke(id1));
    assert.equal(again.verify(t1), false);
    assert.equal(again.verify(t2), true);
    assert.deepEqual(again.subscriptions().map((s) => s.id), [id2]);
    assert.equal(revoked, 1);
    assert.equal(again.revoke(id1), false);
    assert.deepEqual(new Devices(home).subscriptions().map((s) => s.id), [id2]);
    again.revokeAll();
    assert.equal(again.subscriptions().length, 0);
    assert.equal(new Devices(home).subscriptions().length, 0);
  });

  test("an old phones.json (no subscriptions) loads, and a junk subscription on disk is ignored", () => {
    const home = tmp();
    const d = new Devices(home);
    const t = d.add();
    const file = join(home, "phones.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.devices[0].sub = { endpoint: "https://evil.example/x", keys: { p256dh: "aaaaaaaaaa", auth: "bbbbbbbbbb" } };
    writeFileSync(file, JSON.stringify(j));
    const again = new Devices(home);
    assert.ok(again.verify(t));
    assert.equal(again.subscriptions().length, 0);
  });

  test("dropSubscription keeps the device paired", () => {
    const d = new Devices(tmp());
    const t = d.add();
    const id = d.idOf(t)!;
    d.setSubscription(id, sub("x"));
    d.dropSubscription(id);
    assert.equal(d.subscriptions().length, 0);
    assert.ok(d.verify(t));
  });
});

describe("push endpoints on the phone listener", () => {
  const dir = tmp();
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "index.html"), "shell");
  const devices = new Devices(join(dir, "home"));
  const server = createPhoneServer({ hosts: new Set(["mac.ts.net"]), devices, codes: new PairingCodes(), webDir: join(dir, "web"), onConnection: () => {}, push: { publicKey: "PUBKEY" } });
  const ready = new Promise<number>((ok) => server.http.listen(0, "127.0.0.1", () => ok((server.http.address() as AddressInfo).port)));
  after(() => server.close());
  const call = (port: number, method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; body: string }>((done, bad) => {
      const r = request({ host: "127.0.0.1", port, path, method, headers: { host: "mac.ts.net" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: b }));
      });
      r.on("error", bad);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });

  test("need a device token; subscribe stores for that device only; bad endpoints are refused", async () => {
    const port = await ready;
    assert.equal((await call(port, "GET", "/api/push/key")).status, 401);
    assert.equal((await call(port, "POST", "/api/push/subscribe?t=nope", sub("x"))).status, 401);
    const token = devices.add();
    const other = devices.add();
    assert.equal((await call(port, "GET", `/api/push/key?t=${token}`)).body, JSON.stringify({ publicKey: "PUBKEY" }));
    assert.equal((await call(port, "POST", `/api/push/subscribe?t=${token}`, { ...sub("x"), endpoint: "https://evil.example/x" })).status, 400);
    assert.equal(devices.subscriptions().length, 0);
    assert.equal((await call(port, "POST", `/api/push/subscribe?t=${token}`, sub("x"))).status, 200);
    assert.deepEqual(devices.subscriptions().map((s) => s.id), [devices.idOf(token)]);
    assert.equal(devices.idOf(other) !== devices.idOf(token), true);
    assert.equal((await call(port, "DELETE", `/api/push/subscribe?t=${token}`)).status, 200);
    assert.equal(devices.subscriptions().length, 0);
  });
});

describe("VAPID keys", () => {
  test("generated once, stored 0600, reused", () => {
    const home = tmp();
    const a = loadVapid(home);
    assert.equal(statSync(join(home, "vapid.json")).mode & 0o777, 0o600);
    assert.deepEqual(loadVapid(home), a);
    assert.ok(a.publicKey.length > 40 && a.privateKey.length > 20);
  });
});

describe("payload contents", () => {
  const item = (kind: PushItem["kind"], title: string, id = "s1"): PushItem => ({ sessionId: id, kind, title });

  test("one session: status word + title, opens that session", () => {
    const p = buildPayload([item("needs_you", "Fix login bug")]);
    assert.deepEqual(p, { title: "Needs you", body: "Fix login bug", tag: "perzian", url: "/#session=s1", urgent: true });
    assert.equal(buildPayload([item("done", "Add tests")]).urgent, false);
  });

  test("never carries code or diff contents, even if they sneak into a title or extra fields", () => {
    const evil = { ...item("failed", "x = `rm -rf /`\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const secret = 1".repeat(5)), diff: "SECRET_DIFF", code: "SECRET_CODE", text: "SECRET_TEXT" } as PushItem;
    const p = buildPayload([evil]);
    const wire = JSON.stringify(p);
    assert.ok(!/SECRET_/.test(wire)); // fields other than status + title are never read
    assert.deepEqual(Object.keys(p).sort(), ["body", "tag", "title", "urgent", "url"]);
    assert.ok(p.body.length <= 80);
    assert.ok(!p.body.includes("`") && !p.body.includes("\n"));
  });

  test("a hostile session id can't smuggle anything into the URL", () => {
    assert.equal(buildPayload([item("done", "t", "a/../b?x=1#y")]).url, "/#session=abx1y");
    assert.match(buildPayload([item("done", "t", "a/../b?x=1#y")]).url, /^\/#session=[\w-]*$/);
  });

  test("a burst: counts only, opens the inbox; one entry per session with the most urgent kind", () => {
    const p = buildPayload([item("done", "A", "a"), item("needs_you", "B", "b"), item("failed", "C", "c"), item("done", "B", "b")]);
    assert.equal(p.title, "Perzian");
    assert.equal(p.body, "1 need you · 1 failed · 1 done");
    assert.equal(p.url, "/");
    // The same session twice collapses back to a single-session notification.
    assert.equal(buildPayload([item("done", "A", "a"), item("needs_you", "A", "a")]).title, "Needs you");
  });
});

describe("which events push", () => {
  const info = (over: Partial<SessionInfo> = {}) => ({ id: "s1", title: "Fix bug", ...over }) as SessionInfo;
  const status = (s: string): PerzianEvent => ({ type: "session.status", sessionId: "s1", status: s, at: 1 }) as PerzianEvent;
  test("needs_you, failed and done; not working or archived or unknown sessions", () => {
    for (const k of ["needs_you", "failed", "done"]) assert.deepEqual(itemForEvent(status(k), { s1: info() }), { sessionId: "s1", kind: k, title: "Fix bug" });
    assert.equal(itemForEvent(status("working"), { s1: info() }), undefined);
    assert.equal(itemForEvent(status("done"), { s1: info({ archived: true }) }), undefined);
    assert.equal(itemForEvent(status("done"), {}), undefined);
    assert.equal(itemForEvent({ type: "session.progress" } as PerzianEvent, { s1: info() }), undefined);
  });
});

describe("coalescing", () => {
  function fake() {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    return { timers, schedule: (fn: () => void, ms: number) => (timers.push({ fn, ms, live: true }), () => void (timers[timers.length - 1].live = false)) };
  }

  test("a burst inside the window is one flush; the next burst starts a new window", () => {
    const f = fake();
    const out: number[][] = [];
    const c = new Coalescer<number>((items) => out.push(items), 5000, f.schedule);
    c.add(1);
    c.add(2);
    c.add(3);
    assert.equal(f.timers.length, 1); // one window, not one per item
    assert.equal(f.timers[0].ms, 5000);
    assert.deepEqual(out, []);
    f.timers[0].fn();
    assert.deepEqual(out, [[1, 2, 3]]);
    c.add(4);
    assert.equal(f.timers.length, 2);
    f.timers[1].fn();
    assert.deepEqual(out, [[1, 2, 3], [4]]);
  });

  test("PushSender: three sessions in one burst -> one push per phone", async () => {
    const f = fake();
    const sent: Array<{ endpoint: string; body: string }> = [];
    const devices = new Devices(tmp());
    devices.setSubscription(devices.idOf(devices.add())!, sub("p1"));
    devices.setSubscription(devices.idOf(devices.add())!, sub("p2"));
    const p = new PushSender({ devices, vapid: { publicKey: "k", privateKey: "k" }, enabled: () => true, uiActive: () => false, schedule: f.schedule as never, send: async (s, body) => void sent.push({ endpoint: s.endpoint, body }) });
    p.notify({ sessionId: "a", kind: "done", title: "A" });
    p.notify({ sessionId: "b", kind: "needs_you", title: "B" });
    p.notify({ sessionId: "c", kind: "failed", title: "C" });
    p.notify(undefined);
    f.timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2); // 2 phones x 1 notification
    assert.equal(JSON.parse(sent[0].body).body, "1 need you · 1 failed · 1 done");
  });
});

describe("when pushes are skipped or dropped", () => {
  async function run(o: { enabled?: boolean; uiActive?: boolean; fail?: number }) {
    const devices = new Devices(tmp());
    const t = devices.add();
    devices.setSubscription(devices.idOf(t)!, sub("p"));
    let n = 0;
    let flush!: () => void;
    const p = new PushSender({
      devices,
      vapid: { publicKey: "k", privateKey: "k" },
      enabled: () => o.enabled ?? true,
      uiActive: () => o.uiActive ?? false,
      schedule: (fn) => ((flush = fn), () => {}),
      send: async () => {
        n++;
        if (o.fail) throw Object.assign(new Error("gone"), { statusCode: o.fail });
      },
    });
    p.notify({ sessionId: "a", kind: "done", title: "A" });
    flush();
    await new Promise((r) => setImmediate(r));
    return { n, devices, t };
  }

  test("404 and 410 drop the subscription (and keep the device paired); other errors keep it", async () => {
    for (const code of [404, 410]) {
      const r = await run({ fail: code });
      assert.equal(r.n, 1);
      assert.equal(r.devices.subscriptions().length, 0);
      assert.ok(r.devices.verify(r.t));
    }
    const r = await run({ fail: 500 });
    assert.equal(r.devices.subscriptions().length, 1);
  });

  test("nothing is sent while the Mac UI is focused, or while Phone access is off", async () => {
    assert.equal((await run({ uiActive: true })).n, 0);
    assert.equal((await run({ enabled: false })).n, 0);
    assert.equal((await run({})).n, 1);
  });

  test("presence: focused counts only while fresh, so a closed window never mutes pushes", () => {
    let now = 0;
    const p = new Presence(() => now, 30_000);
    assert.equal(p.active(), false);
    p.report(true);
    assert.equal(p.active(), true);
    now = 29_000;
    assert.equal(p.active(), true);
    now = 31_000;
    assert.equal(p.active(), false);
    p.report(true);
    p.report(false);
    assert.equal(p.active(), false);
  });
});
