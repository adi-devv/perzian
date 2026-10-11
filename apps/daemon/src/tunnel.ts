// "No setup" mode: a Cloudflare quick tunnel to the phone listener, using the user's own `cloudflared`.
// We never download or bundle it. The tunnel URL (https://<random>.trycloudflare.com) is public on the
// internet and changes every run; the pairing code and device tokens still gate everything but the static
// UI shell. Same trust model as the MagicDNS name: the Host/Origin allowlist gets that one name (phone.ts).

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Run } from "./tailscale.ts";

/** Homebrew's bin dirs are often missing from PATH when the daemon is started by the desktop app. */
const FALLBACKS = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];

export async function findCloudflared(exec: Run, exists: (p: string) => boolean = existsSync): Promise<string | undefined> {
  if ((await exec("cloudflared", ["--version"], 5000)).ok) return "cloudflared";
  return FALLBACKS.find(exists);
}

/** The quick-tunnel URL in cloudflared's log output, or undefined. Not api.trycloudflare.com (it appears in error lines). */
export function parseTunnelUrl(text: string): string | undefined {
  for (const m of text.matchAll(/https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com(?![a-z0-9.-])/gi)) {
    const sub = m[1].toLowerCase();
    if (sub !== "api") return `https://${sub}.trycloudflare.com`;
  }
  return undefined;
}

export type Spawn = (file: string, args: string[]) => ChildProcess;
const defaultSpawn: Spawn = (file, args) => nodeSpawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });

export interface Tunnel {
  url: string;
  /** The hostname to allow on the phone listener. */
  host: string;
  stop(): void;
}

/** Starts the tunnel and resolves once cloudflared prints its URL. `onExit` fires if it dies on its own afterwards. */
export function startTunnel(bin: string, port: number, o: { spawn?: Spawn; timeoutMs?: number; onExit?: () => void } = {}): Promise<Tunnel> {
  return new Promise((ok, bad) => {
    let child: ChildProcess;
    try {
      child = (o.spawn ?? defaultSpawn)(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]);
    } catch (e) {
      return bad(new Error(`Couldn't start cloudflared (${(e as Error).message}).`));
    }
    let settled = false;
    let stopped = false;
    let buf = "";
    const stop = () => {
      stopped = true;
      try {
        child.kill();
      } catch {}
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      bad(new Error(msg));
    };
    const timer = setTimeout(() => fail("Cloudflare didn't answer in time. Check your connection and try again."), o.timeoutMs ?? 30_000);
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      buf = (buf + chunk).slice(-8192);
      const url = parseTunnelUrl(buf);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      ok({ url, host: new URL(url).hostname, stop });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => fail(`Couldn't start cloudflared (${e.message}).`));
    child.on("exit", () => {
      if (!settled) fail("cloudflared stopped before the tunnel came up.");
      else if (!stopped) o.onExit?.();
    });
  });
}
