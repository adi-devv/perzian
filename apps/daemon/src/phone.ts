// Phone access, opt-in and off by default. `tailscale serve` proxies https://<mac>.<tailnet>.ts.net:<port>
// to a SEPARATE listener (127.0.0.1:PHONE_PORT, started only while Phone access is on).
//
// Why a separate listener and not the main one with header sniffing: `tailscale serve` reaches the daemon
// from loopback, and on the main listener (4317) loopback and "no Origin" mean "trusted local client".
// Anything arriving through the proxy would inherit that trust. The phone listener has no such tier:
//   - every request except the static UI shell and /pair needs a device token (Authorization: Bearer or ?t=),
//   - the Host header must be our own MagicDNS name (blocks DNS rebinding from a website to 127.0.0.1),
//   - a browser Origin must be that same name (no cross-site calls), and no CORS header is ever sent,
//   - the API is an allowlist (ping + a handful of commands in index.ts), not the whole loopback API.
// The main listener never serves the phone path and the phone listener never serves the management API
// (turn on/off, pairing codes, forget), so a stolen device token can't mint more devices.
// "No setup" mode swaps the MagicDNS name for a Cloudflare quick tunnel's name (tunnel.ts): the same single-name
// Host/Origin allowlist, the same tokens, nothing else changes.
// Tailscale-* headers are not used for trust: other local processes can hit this port directly and can
// forge them. The token is the only credential.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { PhoneMode, PhonePairing, PhoneStatus } from "@perzian/protocol";
import { run, serveOff, serveOn, tailscaleInfo, type Run } from "./tailscale.ts";
import { findCloudflared, startTunnel, type Tunnel } from "./tunnel.ts";
import { validateSubscription, type PushSubscriptionJSON } from "./push.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Paired phones. Only SHA-256 hashes of their tokens are stored (<PERZIAN_HOME>/phones.json, 0600), plus each
 *  phone's Web Push subscription when it turned notifications on. A device's id is the start of its hash: it
 *  can't be turned back into the token. Revoking a device deletes its subscription with it. */
export class Devices {
  private devices = new Map<string, { createdAt: number; sub?: PushSubscriptionJSON }>();
  private listeners: Array<() => void> = [];
  constructor(private home: string) {
    try {
      const j = JSON.parse(readFileSync(join(home, "phones.json"), "utf8")) as { devices?: Array<{ hash: string; createdAt: number; sub?: unknown }> };
      for (const d of j.devices ?? []) {
        if (typeof d.hash !== "string") continue;
        const sub = validateSubscription(d.sub);
        this.devices.set(d.hash, { createdAt: d.createdAt, ...(sub ? { sub } : {}) });
      }
    } catch {}
  }
  private save() {
    mkdirSync(this.home, { recursive: true });
    const file = join(this.home, "phones.json");
    writeFileSync(file, JSON.stringify({ devices: [...this.devices].map(([hash, d]) => ({ hash, ...d })) }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  /** A new long-lived token; the caller hands it to the phone once and never sees it again. */
  add(): string {
    const token = randomBytes(32).toString("hex");
    this.devices.set(sha256(token), { createdAt: Date.now() });
    this.save();
    return token;
  }
  verify(token: string | undefined | null): boolean {
    return !!token && token.length <= 256 && this.devices.has(sha256(token));
  }
  count(): number {
    return this.devices.size;
  }
  /** The id of the device this token belongs to, or undefined when it isn't (or is no longer) paired. */
  idOf(token: string | undefined | null): string | undefined {
    return this.verify(token) ? sha256(token!).slice(0, 16) : undefined;
  }
  private hashOf(id: string): string | undefined {
    return [...this.devices.keys()].find((h) => h.slice(0, 16) === id);
  }
  setSubscription(id: string, sub: PushSubscriptionJSON): boolean {
    const h = this.hashOf(id);
    if (!h) return false;
    this.devices.get(h)!.sub = sub;
    this.save();
    return true;
  }
  dropSubscription(id: string) {
    const h = this.hashOf(id);
    if (!h || !this.devices.get(h)!.sub) return;
    delete this.devices.get(h)!.sub;
    this.save();
  }
  subscriptions(): Array<{ id: string; sub: PushSubscriptionJSON }> {
    return [...this.devices].flatMap(([hash, d]) => (d.sub ? [{ id: hash.slice(0, 16), sub: d.sub }] : []));
  }
  /** Forget one phone: its token stops working and its subscription is deleted. */
  revoke(id: string): boolean {
    const h = this.hashOf(id);
    if (!h) return false;
    this.devices.delete(h);
    this.save();
    for (const l of this.listeners) l();
    return true;
  }
  revokeAll() {
    this.devices.clear();
    this.save();
    for (const l of this.listeners) l();
  }
  onRevoke(l: () => void) {
    this.listeners.push(l);
  }
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** One-time pairing codes: in memory only, short expiry, single use, and locked after repeated misses. */
export class PairingCodes {
  private codes = new Map<string, number>(); // sha256(code) -> expiresAt
  private misses: number[] = [];
  private lockedUntil = 0;
  constructor(private now: () => number = Date.now, private ttlMs = 2 * 60_000, private maxMisses = 5, private windowMs = 60_000) {}
  issue(): { code: string; expiresAt: number } {
    const bytes = randomBytes(10);
    const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    const expiresAt = this.now() + this.ttlMs;
    this.codes.clear(); // one outstanding code at a time
    this.codes.set(sha256(raw), expiresAt);
    return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt };
  }
  /** True once per issued code, before it expires. */
  redeem(input: string): boolean {
    const now = this.now();
    if (now < this.lockedUntil) return false;
    const key = sha256(normalizeCode(String(input ?? "")));
    const exp = this.codes.get(key);
    if (exp !== undefined) {
      this.codes.delete(key);
      if (exp > now) return true;
    }
    this.misses = this.misses.filter((t) => now - t < this.windowMs);
    this.misses.push(now);
    if (this.misses.length >= this.maxMisses) {
      // Someone is guessing: burn every outstanding code and stop answering for a while.
      this.codes.clear();
      this.misses = [];
      this.lockedUntil = now + this.windowMs;
    }
    return false;
  }
}

function hostname(h: string): string {
  const m = /^\[([^\]]+)\]/.exec(h);
  return (m ? m[1] : h.replace(/:\d+$/, "")).toLowerCase();
}

export interface PhoneAuth {
  /** The names this listener answers to (the MagicDNS name). */
  hosts: Set<string>;
  devices: Devices;
}

/** Host and Origin must be ours. Returns a rejection reason, or undefined when fine. */
export function badOrigin(headers: IncomingMessage["headers"], hosts: Set<string>): string | undefined {
  if (!headers.host || !hosts.has(hostname(headers.host))) return "bad host";
  const o = headers.origin;
  if (o !== undefined) {
    try {
      if (!hosts.has(hostname(new URL(o).host))) return "bad origin";
    } catch {
      return "bad origin";
    }
  }
  return undefined;
}

export function deviceToken(req: IncomingMessage, url: URL): string | undefined {
  const a = req.headers.authorization;
  if (a && /^bearer /i.test(a)) return a.slice(7).trim();
  return url.searchParams.get("t") ?? undefined;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function serveStatic(webDir: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  const root = resolve(webDir);
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = resolve(root, rel);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html"); // the SPA shell
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}

export interface PhoneServerOptions extends PhoneAuth {
  codes: PairingCodes;
  /** The built web UI (index.html, manifest, icons). Served without a token: it holds no data. */
  webDir: string;
  /** An authenticated WebSocket from a phone. */
  onConnection: (ws: WebSocket) => void;
  /** Web Push: the VAPID public key phones subscribe with. Absent = /api/push/* answers 404. */
  push?: { publicKey: string };
}

export interface PhoneServer {
  http: Server;
  wss: WebSocketServer;
  close(): Promise<void>;
}

export function createPhoneServer(o: PhoneServerOptions): PhoneServer {
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  const http = createServer(async (req, res) => {
    try {
      const reason = badOrigin(req.headers, o.hosts);
      if (reason) return void res.writeHead(403, { "content-type": "text/plain" }).end(reason);
      const url = new URL(req.url ?? "/", "http://phone.invalid");
      const path = url.pathname;
      if (req.method === "POST" && path === "/pair") {
        let body = "";
        for await (const chunk of req) if ((body += chunk).length > 2048) return void json(res, 413, { error: "too large" });
        let code = "";
        try {
          code = String((JSON.parse(body) as { code?: unknown }).code ?? "");
        } catch {}
        // One answer for wrong, expired and already-used codes.
        if (!o.codes.redeem(code)) return void json(res, 403, { error: "That code didn't work. Make a new one on your Mac." });
        return void json(res, 200, { token: o.devices.add() });
      }
      if (path === "/ws" || path.startsWith("/api/")) {
        if (!o.devices.verify(deviceToken(req, url))) return void json(res, 401, { error: "unpaired" });
        if (path === "/api/ping") return void json(res, 200, { ok: true });
        if (o.push && path === "/api/push/key" && req.method === "GET") return void json(res, 200, { publicKey: o.push.publicKey });
        if (o.push && path === "/api/push/subscribe") {
          const id = o.devices.idOf(deviceToken(req, url));
          if (!id) return void json(res, 401, { error: "unpaired" });
          if (req.method === "DELETE") {
            o.devices.dropSubscription(id);
            return void json(res, 200, { ok: true });
          }
          if (req.method !== "POST") return void json(res, 404, { error: "not found" });
          let body = "";
          for await (const chunk of req) if ((body += chunk).length > 4096) return void json(res, 413, { error: "too large" });
          let sub: PushSubscriptionJSON | undefined;
          try {
            sub = validateSubscription(JSON.parse(body));
          } catch {}
          if (!sub) return void json(res, 400, { error: "bad subscription" });
          o.devices.setSubscription(id, sub);
          return void json(res, 200, { ok: true });
        }
        return void json(res, 404, { error: "not found" });
      }
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(o.webDir, path, req, res);
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
  const wss = new WebSocketServer({
    server: http,
    path: "/ws",
    verifyClient: ({ req }: { req: IncomingMessage }) => !badOrigin(req.headers, o.hosts) && o.devices.verify(deviceToken(req, new URL(req.url ?? "/", "http://phone.invalid"))),
  });
  wss.on("connection", o.onConnection);
  // "Forget all phones" cuts live connections too.
  o.devices.onRevoke(() => wss.clients.forEach((c) => c.terminate()));
  return {
    http,
    wss,
    close: () =>
      new Promise((done) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => http.close(() => done()));
        http.closeAllConnections?.();
      }),
  };
}

export interface PhoneAccessOptions {
  home: string;
  /** Where the phone listener binds on 127.0.0.1. */
  port: number;
  /** The HTTPS port on the tailnet name. Not 443, so a `tailscale serve` the developer already uses isn't touched. */
  httpsPort: number;
  devices: Devices;
  codes: PairingCodes;
  webDir: () => string | undefined;
  onConnection: (ws: WebSocket) => void;
  push?: { publicKey: string };
  exec?: Run;
  /** Tests inject these; defaults run the real `cloudflared`. */
  findCloudflared?: typeof findCloudflared;
  startTunnel?: typeof startTunnel;
}

/** The on/off switch: starts the phone listener and a way in (tailscale proxy or Cloudflare quick tunnel) together, and stops both. */
export class PhoneAccess {
  private server?: PhoneServer;
  private cli?: string;
  private tunnel?: Tunnel;
  private url?: string;
  private mode: PhoneMode = "tailscale";
  private lastError?: string;
  constructor(private o: PhoneAccessOptions) {
    try {
      if ((JSON.parse(readFileSync(this.flag(), "utf8")) as { mode?: string }).mode === "tunnel") this.mode = "tunnel";
    } catch {}
  }

  private flag = () => join(this.o.home, "phone.json");
  private writeFlag(on: boolean) {
    writeFileSync(this.flag(), JSON.stringify({ on, mode: this.mode }), { mode: 0o600 });
  }
  /** Phone access is on: the listener is up. */
  isOn(): boolean {
    return !!this.server;
  }

  async status(): Promise<PhoneStatus> {
    const exec = this.o.exec ?? run;
    const [t, cf] = await Promise.all([tailscaleInfo(exec), (this.o.findCloudflared ?? findCloudflared)(exec)]);
    const url = this.server ? this.url : this.mode === "tailscale" && t.dnsName && t.state === "ready" ? `https://${t.dnsName}:${this.o.httpsPort}` : undefined;
    return { on: !!this.server, mode: this.mode, cloudflared: !!cf, tailscale: t.state, ...(url ? { url } : {}), phones: this.o.devices.count(), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  private starting?: Promise<PhoneStatus>;
  /** A double click shares one start. */
  turnOn(mode?: PhoneMode): Promise<PhoneStatus> {
    this.starting ??= this.start(mode).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(mode?: PhoneMode): Promise<PhoneStatus> {
    if (this.server) return this.status();
    if (mode) this.mode = mode;
    this.lastError = undefined;
    const exec = this.o.exec ?? run;
    const webDir = this.o.webDir();
    let cli: string | undefined;
    let dnsName: string | undefined;
    let cloudflared: string | undefined;
    if (this.mode === "tunnel") {
      cloudflared = await (this.o.findCloudflared ?? findCloudflared)(exec);
      if (!cloudflared) return this.fail("cloudflared isn't installed. Run: brew install cloudflared");
    } else {
      const t = await tailscaleInfo(exec);
      if (t.state !== "ready" || !t.cli || !t.dnsName) return this.fail(t.state === "missing" ? "Tailscale isn't installed." : t.state === "no-https" ? "Turn on MagicDNS and HTTPS certificates for your tailnet." : "Tailscale isn't signed in.");
      cli = t.cli;
      dnsName = t.dnsName;
    }
    if (!webDir) return this.fail("The web UI isn't built. Run: npm run build");
    // Tunnel mode: the allowlist starts empty (everything is refused) and gets the tunnel's name once it exists.
    const hosts = new Set<string>(dnsName ? [dnsName] : []);
    const server = createPhoneServer({ hosts, devices: this.o.devices, codes: this.o.codes, webDir, onConnection: this.o.onConnection, push: this.o.push });
    try {
      await new Promise<void>((ok, bad) => {
        server.http.once("error", bad);
        server.http.listen(this.o.port, "127.0.0.1", () => ok());
      });
    } catch (e) {
      return this.fail(`Can't listen on 127.0.0.1:${this.o.port} (${(e as Error).message}).`);
    }
    if (cli && dnsName) {
      const s = await serveOn(cli, this.o.httpsPort, this.o.port, exec);
      if (!s.ok) {
        await server.close();
        return this.fail(`tailscale serve failed: ${s.out.split("\n").filter(Boolean).slice(-2).join(" ") || "no output"}`);
      }
      this.cli = cli;
      this.url = `https://${dnsName}:${this.o.httpsPort}`;
    } else {
      try {
        const tunnel: Tunnel = await (this.o.startTunnel ?? startTunnel)(cloudflared!, this.o.port, { onExit: () => void this.tunnelDied(tunnel) });
        hosts.add(tunnel.host);
        this.tunnel = tunnel;
        this.url = tunnel.url;
      } catch (e) {
        await server.close();
        return this.fail((e as Error).message);
      }
    }
    this.server = server;
    this.writeFlag(true);
    return this.status();
  }

  /** cloudflared died on its own: the link is gone, so close the door and say so. */
  private async tunnelDied(t: Tunnel) {
    if (this.tunnel !== t) return;
    await this.turnOff();
    this.lastError = "The tunnel stopped. Turn phone access on again for a new link.";
  }

  private async fail(msg: string): Promise<PhoneStatus> {
    this.lastError = msg;
    return this.status();
  }

  async turnOff(): Promise<PhoneStatus> {
    this.lastError = undefined;
    const server = this.server;
    this.server = undefined;
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    tunnel?.stop();
    this.writeFlag(false);
    if (this.cli) await serveOff(this.cli, this.o.httpsPort, this.o.exec ?? run);
    this.cli = undefined;
    this.url = undefined;
    await server?.close();
    return this.status();
  }

  /** Daemon exit: synchronous, so it works from process "exit". Takes the tunnel down; the on/off flag stays so a restart resumes. */
  killTunnel() {
    const t = this.tunnel;
    this.tunnel = undefined;
    t?.stop();
  }

  /** After a daemon restart, resume if it was on. Off by default: no flag file, nothing starts. A tunnel gets a new URL. */
  async restore(): Promise<void> {
    try {
      if ((JSON.parse(readFileSync(this.flag(), "utf8")) as { on?: boolean }).on) await this.turnOn();
    } catch {}
  }

  pair(): PhonePairing {
    if (!this.server || !this.url) throw new Error("Turn on Phone access first");
    return { url: this.url, ...this.o.codes.issue() };
  }

  async forgetAll(): Promise<PhoneStatus> {
    this.o.devices.revokeAll();
    return this.status();
  }
}
