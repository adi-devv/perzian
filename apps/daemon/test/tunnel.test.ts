import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Devices, PairingCodes, PhoneAccess, badOrigin, createPhoneServer } from "../src/phone.ts";
import { findCloudflared, parseTunnelUrl, startTunnel, type Spawn, type Tunnel } from "../src/tunnel.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pz-tunnel-"));

describe("tunnel URL parsing", () => {
  test("finds the quick-tunnel URL in cloudflared's log", () => {
    const log = [
      "2026-10-11T10:00:00Z INF Thank you for trying Cloudflare Tunnel.",
      "2026-10-11T10:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-10-11T10:00:02Z INF +--------------------------------------------------------------------------------------------+",
      "2026-10-11T10:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-10-11T10:00:02Z INF |  https://Random-Words-Here-42.trycloudflare.com                                            |",
    ].join("\n");
    assert.equal(parseTunnelUrl(log), "https://random-words-here-42.trycloudflare.com");
  });

  test("ignores api.trycloudflare.com, other hosts, http and lookalikes", () => {
    assert.equal(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp'), undefined);
    assert.equal(parseTunnelUrl("http://abc.trycloudflare.com"), undefined);
    assert.equal(parseTunnelUrl("https://abc.trycloudflare.com.evil.example"), undefined);
    assert.equal(parseTunnelUrl("https://evil.example/?u=https://x.trycloudflare.org"), undefined);
    assert.equal(parseTunnelUrl("https://a.b.trycloudflare.com"), undefined); // one label only
    assert.equal(parseTunnelUrl(""), undefined);
    // An error line mentioning the API host doesn't hide a real URL after it.
    assert.equal(parseTunnelUrl("https://api.trycloudflare.com/x then https://ok-one.trycloudflare.com"), "https://ok-one.trycloudflare.com");
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: boolean; kill: () => boolean };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawn: Spawn = (file, args) => (calls.push({ file, args }), child as unknown as ChildProcess);
  return { child, spawn, calls };
}

describe("startTunnel", () => {
  test("runs cloudflared against the phone port and resolves with the URL from stderr", async () => {
    const f = fakeChild();
    const p = startTunnel("cloudflared", 4319, { spawn: f.spawn });
    f.child.stderr.write("INF |  https://abc-def.trycloudflare.com  |\n");
    const t = await p;
    assert.deepEqual(f.calls[0], { file: "cloudflared", args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4319"] });
    assert.equal(t.url, "https://abc-def.trycloudflare.com");
    assert.equal(t.host, "abc-def.trycloudflare.com");
    t.stop();
    assert.equal(f.child.killed, true);
  });

  test("a URL split across chunks still parses; exit after it is up reports onExit, our own stop does not", async () => {
    const f = fakeChild();
    let exits = 0;
    const p = startTunnel("cloudflared", 1, { spawn: f.spawn, onExit: () => exits++ });
    f.child.stderr.write("https://split-na");
    f.child.stderr.write("me.trycloudflare.com ");
    const t = await p;
    assert.equal(t.host, "split-name.trycloudflare.com");
    f.child.emit("exit", 1, null);
    assert.equal(exits, 1);
    const g = fakeChild();
    const q = startTunnel("cloudflared", 1, { spawn: g.spawn, onExit: () => exits++ });
    g.child.stdout.write("https://x1.trycloudflare.com\n");
    (await q).stop();
    assert.equal(exits, 1);
  });

  test("fails (and kills the process) when cloudflared exits early or never answers", async () => {
    const f = fakeChild();
    const p = startTunnel("cloudflared", 1, { spawn: f.spawn });
    f.child.stderr.write('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"\n');
    f.child.emit("exit", 1, null);
    await assert.rejects(p, /stopped before/);
    const g = fakeChild();
    await assert.rejects(startTunnel("cloudflared", 1, { spawn: g.spawn, timeoutMs: 20 }), /didn't answer/);
    assert.equal(g.child.killed, true);
    const spawnError = fakeChild();
    const e = startTunnel("cloudflared", 1, { spawn: spawnError.spawn });
    spawnError.child.emit("error", new Error("ENOENT"));
    await assert.rejects(e, /ENOENT/);
  });
});

describe("finding cloudflared", () => {
  test("on PATH, or in a Homebrew dir; otherwise missing (never downloaded)", async () => {
    assert.equal(await findCloudflared(async () => ({ ok: true, out: "cloudflared version 2026.1.0" })), "cloudflared");
    const missing = async () => ({ ok: false, out: "" });
    assert.equal(await findCloudflared(missing, () => false), undefined);
    assert.equal(await findCloudflared(missing, (p) => p === "/opt/homebrew/bin/cloudflared"), "/opt/homebrew/bin/cloudflared");
  });
});

describe("Host allowlisting for the tunnel host", () => {
  const TUNNEL = "abc-def.trycloudflare.com";
  const h = (host?: string, origin?: string) => ({ ...(host ? { host } : {}), ...(origin ? { origin } : {}) });

  test("exactly like the MagicDNS name: that Host/Origin only", () => {
    const hosts = new Set([TUNNEL]);
    assert.equal(badOrigin(h(TUNNEL), hosts), undefined);
    assert.equal(badOrigin(h(TUNNEL, `https://${TUNNEL}`), hosts), undefined);
    assert.equal(badOrigin(h("ABC-DEF.trycloudflare.com"), hosts), undefined);
    assert.equal(badOrigin(h("other-name.trycloudflare.com"), hosts), "bad host"); // another tunnel is not ours
    assert.equal(badOrigin(h("127.0.0.1:4319"), hosts), "bad host"); // DNS rebinding to loopback
    assert.equal(badOrigin(h(`${TUNNEL}.evil.example`), hosts), "bad host");
    assert.equal(badOrigin(h(TUNNEL, "https://other-name.trycloudflare.com"), hosts), "bad origin");
    assert.equal(badOrigin(h(TUNNEL, "https://evil.example"), hosts), "bad origin");
    assert.equal(badOrigin(h(), hosts), "bad host");
  });

  const dir = tmp();
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "index.html"), "shell");
  const hosts = new Set<string>(); // tunnel mode starts empty, like PhoneAccess does
  const devices = new Devices(join(dir, "home"));
  const server = createPhoneServer({ hosts, devices, codes: new PairingCodes(), webDir: join(dir, "web"), onConnection: () => {} });
  const ready = new Promise<number>((ok) => server.http.listen(0, "127.0.0.1", () => ok((server.http.address() as AddressInfo).port)));
  after(() => server.close());
  const get = (port: number, host: string, path: string) =>
    new Promise<number>((done, bad) => {
      const r = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => (res.resume(), done(res.statusCode ?? 0)));
      r.on("error", bad);
      r.end();
    });

  test("before the tunnel exists everything is refused; once added, the tunnel host still needs a token for the API", async () => {
    const port = await ready;
    assert.equal(await get(port, TUNNEL, "/"), 403);
    hosts.add(TUNNEL);
    assert.equal(await get(port, TUNNEL, "/"), 200); // the static shell holds no data
    assert.equal(await get(port, TUNNEL, "/api/ping"), 401); // the token still gates everything else
    assert.equal(await get(port, TUNNEL, "/ws"), 401);
    assert.equal(await get(port, "other-name.trycloudflare.com", "/"), 403);
    assert.equal(await get(port, "127.0.0.1", "/"), 403);
    assert.equal(await get(port, TUNNEL, `/api/ping?t=${devices.add()}`), 200);
  });
});

describe("PhoneAccess in tunnel mode", () => {
  function setup(opts: { cloudflared: boolean; fail?: string }) {
    const dir = tmp();
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "shell");
    const stopped: string[] = [];
    let n = 0;
    const started: number[] = [];
    const access = new PhoneAccess({
      home: dir,
      port: 0,
      httpsPort: 8443,
      devices: new Devices(dir),
      codes: new PairingCodes(),
      webDir: () => join(dir, "web"),
      onConnection: () => {},
      exec: async (file) => ({ ok: file === "cloudflared" && opts.cloudflared, out: "" }),
      findCloudflared: async () => (opts.cloudflared ? "cloudflared" : undefined),
      startTunnel: async (_bin, port) => {
        started.push(port);
        if (opts.fail) throw new Error(opts.fail);
        const host = `run-${++n}.trycloudflare.com`;
        const t: Tunnel = { url: `https://${host}`, host, stop: () => void stopped.push(host) };
        return t;
      },
    });
    return { access, stopped, started, dir };
  }

  test("missing cloudflared says how to install it and starts nothing", async () => {
    const s = setup({ cloudflared: false });
    const st = await s.access.turnOn("tunnel");
    assert.equal(st.on, false);
    assert.equal(st.cloudflared, false);
    assert.equal(st.error, "cloudflared isn't installed. Run: brew install cloudflared");
    assert.equal(s.started.length, 0);
  });

  test("a failed tunnel leaves access off; turning on gives the URL, off stops the tunnel, a new run gets a new URL", async () => {
    const bad = setup({ cloudflared: true, fail: "no network" });
    const failed = await bad.access.turnOn("tunnel");
    assert.equal(failed.on, false);
    assert.equal(failed.error, "no network");
    assert.equal(bad.access.isOn(), false);

    const s = setup({ cloudflared: true });
    const on = await s.access.turnOn("tunnel");
    assert.equal(on.on, true);
    assert.equal(on.mode, "tunnel");
    assert.equal(on.url, "https://run-1.trycloudflare.com");
    assert.equal(s.access.pair().url, "https://run-1.trycloudflare.com");
    const off = await s.access.turnOff();
    assert.equal(off.on, false);
    assert.deepEqual(s.stopped, ["run-1.trycloudflare.com"]);
    assert.throws(() => s.access.pair(), /Turn on/);
    // The mode is remembered; the next run has a fresh URL (and so a fresh QR).
    assert.equal((await s.access.status()).mode, "tunnel");
    const again = await s.access.turnOn();
    assert.equal(again.url, "https://run-2.trycloudflare.com");
    s.access.killTunnel(); // daemon exit
    assert.deepEqual(s.stopped, ["run-1.trycloudflare.com", "run-2.trycloudflare.com"]);
    await s.access.turnOff();
  });
});
