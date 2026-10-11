import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Devices, PairingCodes, createPhoneServer, type PhoneServer } from "../src/phone.ts";
import { parseStatus } from "../src/tailscale.ts";
import { trustedOrigin } from "../src/origin.ts";

const HOST = "mac.tail1234.ts.net";
const tmp = () => mkdtempSync(join(tmpdir(), "pz-phone-"));

function setup(codes = new PairingCodes()) {
  const dir = tmp();
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html>shell");
  writeFileSync(join(dir, "secret.txt"), "outside");
  const devices = new Devices(join(dir, "home"));
  const connected: WebSocket[] = [];
  const server = createPhoneServer({ hosts: new Set([HOST]), devices, codes, webDir: web, onConnection: (ws) => connected.push(ws) });
  const ready = new Promise<number>((ok) => server.http.listen(0, "127.0.0.1", () => ok((server.http.address() as AddressInfo).port)));
  return { dir, devices, codes, server, ready, connected };
}

function call(port: number, path: string, o: { method?: string; headers?: IncomingHttpHeaders; body?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((done, bad) => {
    const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: o.host ?? HOST, ...o.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    r.on("error", bad);
    r.end(o.body);
  });
}

const pair = (port: number, code: string, host?: string) => call(port, "/pair", { method: "POST", body: JSON.stringify({ code }), host });

/** Opens a WebSocket on the phone path; resolves "open", or the HTTP status that refused it. */
function dial(port: number, query = "", headers: Record<string, string> = {}): Promise<{ result: "open" | number; ws?: WebSocket }> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers: { host: HOST, ...headers } });
    ws.on("open", () => done({ result: "open", ws }));
    ws.on("unexpected-response", (_req, res) => done({ result: res.statusCode ?? 0 }));
    ws.on("error", () => {});
  });
}

describe("phone path: device tokens", () => {
  const s = setup();
  after(() => s.server.close());

  test("no token or a bad token is rejected (HTTP and WebSocket)", async () => {
    const port = await s.ready;
    s.devices.add(); // a real device exists, so "no devices" isn't what rejects
    for (const [label, headers, q] of [
      ["no token", {}, ""],
      ["bad bearer", { authorization: "Bearer nope" }, ""],
      ["bad ?t=", {}, "?t=nope"],
      ["empty ?t=", {}, "?t="],
      ["the desktop-style token spelling", {}, `?t=${"a".repeat(48)}`],
    ] as const) {
      assert.equal((await call(port, `/api/ping${q}`, { headers })).status, 401, label);
      const w = await dial(port, q, headers);
      assert.equal(w.result, 401, `ws ${label}`);
    }
    assert.equal(s.connected.length, 0);
  });

  test("a valid token works as a Bearer header or ?t=", async () => {
    const port = await s.ready;
    const token = s.devices.add();
    assert.equal((await call(port, "/api/ping", { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await call(port, `/api/ping?t=${token}`)).status, 200);
    const w = await dial(port, `?t=${token}`, { origin: `https://${HOST}:8443` });
    assert.equal(w.result, "open");
    w.ws?.close();
  });

  test("loopback is not trusted on this path: no Origin and a loopback Host get nothing", async () => {
    const port = await s.ready;
    assert.equal((await call(port, "/api/ping", { host: `127.0.0.1:${port}` })).status, 403);
    assert.equal((await call(port, "/api/ping", { host: "localhost" })).status, 403);
    assert.notEqual((await dial(port, "", { host: `127.0.0.1:${port}` })).result, "open");
  });

  test("a valid token still needs our own Host and Origin (rebinding, other websites)", async () => {
    const port = await s.ready;
    const token = s.devices.add();
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await call(port, "/api/ping", { headers: auth, host: "evil.example" })).status, 403);
    assert.equal((await call(port, "/api/ping", { headers: { ...auth, origin: "https://evil.example" } })).status, 403);
    assert.equal((await call(port, "/api/ping", { headers: { ...auth, origin: "null" } })).status, 403);
    assert.notEqual((await dial(port, `?t=${token}`, { origin: "https://evil.example" })).result, "open");
    const cors = await call(port, "/api/ping", { headers: { ...auth, origin: `https://${HOST}` } });
    assert.equal(cors.status, 200);
    assert.equal(cors.headers["access-control-allow-origin"], undefined, "never any CORS");
  });

  test("a token doesn't reach the management API (turn on/off, pairing codes, forget)", async () => {
    const port = await s.ready;
    const auth = { authorization: `Bearer ${s.devices.add()}` };
    for (const [method, path] of [["GET", "/api/phone"], ["POST", "/api/phone/pair"], ["DELETE", "/api/phone/devices"], ["POST", "/api/install"], ["GET", "/api/doctor"], ["GET", "/api/file?session=x&path=y"]] as const) {
      assert.equal((await call(port, path, { method, headers: auth })).status, 404, `${method} ${path}`);
    }
  });

  test("the UI shell loads without a token; nothing outside the web folder does", async () => {
    const port = await s.ready;
    const home = await call(port, "/");
    assert.equal(home.status, 200);
    assert.match(home.body, /shell/);
    for (const p of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt"]) {
      const r = await call(port, p);
      assert.ok(!r.body.includes("outside"), p);
    }
  });

  test("tokens are stored hashed and the file is private", () => {
    const home = join(s.dir, "home");
    const token = s.devices.add();
    const file = join(home, "phones.json");
    assert.ok(!readFileSync(file, "utf8").includes(token));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(new Devices(home).verify(token), "survives a restart");
  });
});

describe("revoking phones", () => {
  test("a revoked token is rejected and live connections are cut", async () => {
    const s = setup();
    after(() => s.server.close());
    const port = await s.ready;
    const token = s.devices.add();
    const w = await dial(port, `?t=${token}`);
    assert.equal(w.result, "open");
    const closed = new Promise((ok) => w.ws!.on("close", ok));
    assert.equal((await call(port, `/api/ping?t=${token}`)).status, 200);
    s.devices.revokeAll();
    await closed;
    assert.equal((await call(port, `/api/ping?t=${token}`)).status, 401);
    assert.equal((await dial(port, `?t=${token}`)).result, 401);
    assert.equal(s.devices.count(), 0);
    assert.ok(!new Devices(join(s.dir, "home")).verify(token), "still revoked after a restart");
  });
});

describe("one-time pairing codes", () => {
  test("a code is single use", () => {
    const c = new PairingCodes();
    const { code } = c.issue();
    assert.ok(c.redeem(code.toLowerCase().replace("-", " ")), "typed loosely");
    assert.ok(!c.redeem(code), "second use");
  });

  test("a code expires", () => {
    let now = 1_000_000;
    const c = new PairingCodes(() => now, 120_000);
    const { code, expiresAt } = c.issue();
    assert.equal(expiresAt, now + 120_000);
    now += 120_001;
    assert.ok(!c.redeem(code));
    const again = c.issue();
    now += 119_000;
    assert.ok(c.redeem(again.code), "still valid just before expiry");
  });

  test("a new code replaces the old one, and guessing locks pairing out", () => {
    let now = 5_000;
    const c = new PairingCodes(() => now);
    const first = c.issue();
    const second = c.issue();
    assert.ok(!c.redeem(first.code), "old code is dead");
    for (let i = 0; i < 5; i++) assert.ok(!c.redeem(`WRONG-${i}`));
    assert.ok(!c.redeem(second.code), "locked, and outstanding codes were burned");
    now += 61_000;
    assert.ok(!c.redeem(second.code), "still burned after the lock");
    assert.ok(c.redeem(c.issue().code), "works again after the lock");
  });

  test("over HTTP: code -> token, once; wrong Host can't pair; the token then works", async () => {
    const s = setup();
    after(() => s.server.close());
    const port = await s.ready;
    const { code } = s.codes.issue();
    assert.equal((await pair(port, code, "evil.example")).status, 403);
    assert.equal((await pair(port, "NOT-A-CODE")).status, 403);
    const ok = await pair(port, code);
    assert.equal(ok.status, 200);
    const { token } = JSON.parse(ok.body) as { token: string };
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await pair(port, code)).status, 403, "single use");
    assert.equal((await call(port, "/api/ping", { headers: { authorization: `Bearer ${token}` } })).status, 200);
  });
});

describe("tailscale status", () => {
  const running = { BackendState: "Running", Self: { DNSName: "Mac.tail1234.ts.net." }, CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ["mac.tail1234.ts.net"] };
  test("ready when running with a MagicDNS name and HTTPS certs", () => {
    assert.deepEqual(parseStatus(JSON.stringify(running)), { state: "ready", dnsName: "mac.tail1234.ts.net" });
  });
  test("logged out, stopped, garbage", () => {
    assert.equal(parseStatus(JSON.stringify({ BackendState: "NeedsLogin" })).state, "logged-out");
    assert.equal(parseStatus(JSON.stringify({ BackendState: "Stopped" })).state, "logged-out");
    assert.equal(parseStatus("tailscale is not running").state, "logged-out");
  });
  test("no HTTPS certs or MagicDNS", () => {
    assert.equal(parseStatus(JSON.stringify({ ...running, CertDomains: [] })).state, "no-https");
    assert.equal(parseStatus(JSON.stringify({ ...running, CurrentTailnet: { MagicDNSEnabled: false } })).state, "no-https");
  });
});

describe("existing trust is unchanged", () => {
  test("loopback web origin and no-Origin clients still pass; others don't", () => {
    for (const o of [undefined, "http://localhost:4318", "http://127.0.0.1:4318"]) assert.ok(trustedOrigin(o), String(o));
    assert.ok(!trustedOrigin(`https://${HOST}:8443`), "the phone origin isn't trusted on the main listener");
    assert.ok(!trustedOrigin("null", undefined, undefined, "t".repeat(48)));
  });
});
