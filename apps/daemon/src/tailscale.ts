// Thin wrapper over the `tailscale` CLI: find it, read `status --json`, and point `tailscale serve` at the
// phone listener. Parsing is a pure function so it can be tested without Tailscale installed.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { TailscaleState } from "@perzian/protocol";

/** The Mac App Store / standalone app doesn't put `tailscale` on PATH; its bundled CLI is here. */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscaleInfo {
  state: TailscaleState;
  /** MagicDNS name without the trailing dot, e.g. mac.tail1234.ts.net. */
  dnsName?: string;
}

/** Interpret `tailscale status --json`. Anything unexpected reads as "logged out", the safe, fixable state. */
export function parseStatus(raw: string): TailscaleInfo {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return { state: "logged-out" };
  }
  if (j?.BackendState !== "Running") return { state: "logged-out" };
  const dnsName = typeof j.Self?.DNSName === "string" ? j.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  // `tailscale serve` needs MagicDNS and HTTPS certificates enabled for the tailnet.
  const https = Array.isArray(j.CertDomains) ? j.CertDomains.length > 0 : true;
  if (!dnsName.endsWith(".ts.net") || j.CurrentTailnet?.MagicDNSEnabled === false || !https) return { state: "no-https", dnsName: dnsName || undefined };
  return { state: "ready", dnsName };
}

export type Run = (file: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; out: string }>;

export const run: Run = (file, args, timeoutMs) =>
  new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });

/** The CLI to run, or undefined when Tailscale isn't installed. */
export async function findCli(exec: Run = run): Promise<string | undefined> {
  if ((await exec("tailscale", ["version"], 5000)).ok) return "tailscale";
  return existsSync(MAC_APP_CLI) ? MAC_APP_CLI : undefined;
}

export async function tailscaleInfo(exec: Run = run): Promise<TailscaleInfo & { cli?: string }> {
  const cli = await findCli(exec);
  if (!cli) return { state: "missing" };
  const r = await exec(cli, ["status", "--json"], 8000);
  // A stopped or logged-out client exits non-zero but may still print JSON; parse whatever came back.
  return { ...parseStatus(r.out), cli };
}

/** Proxy https://<mac>.<tailnet>.ts.net:<httpsPort> to the phone listener. Not port 443, so a `serve` the developer already runs there stays theirs. */
export async function serveOn(cli: string, httpsPort: number, localPort: number, exec: Run = run): Promise<{ ok: boolean; out: string }> {
  return exec(cli, ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], 20_000);
}

export async function serveOff(cli: string, httpsPort: number, exec: Run = run): Promise<{ ok: boolean; out: string }> {
  return exec(cli, ["serve", `--https=${httpsPort}`, "off"], 10_000);
}
