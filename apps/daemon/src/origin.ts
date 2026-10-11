// Browsers let any website send requests to 127.0.0.1, and this daemon runs agents and installers.
// Only Perzian's own UI may drive it from a browser: the desktop app (file://, origin "null"), the Vite
// dev server on port 4318 (the proxy forwards the page's Origin), and PERZIAN_WEB_URL when it points at
// this machine. Any other localhost port is someone else's page. Non-browser clients send no Origin.
// Origin "null" is also what any sandboxed iframe sends, so it counts only with the desktop token
// (<PERZIAN_HOME>/desktop-token, 0600), which the desktop app reads and passes to its UI as ?t=.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WEB_PORT = 4318;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function webOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  // PERZIAN_WEB_PORT: the dev server moved off 4318 (vite.config.ts reads the same variable).
  const port = /^\d{2,5}$/.test(env.PERZIAN_WEB_PORT ?? "") ? Number(env.PERZIAN_WEB_PORT) : WEB_PORT;
  const out = new Set(LOOPBACK.map((h) => `http://${h}:${port}`));
  try {
    const u = new URL(env.PERZIAN_WEB_URL ?? "");
    if (LOOPBACK.includes(u.hostname) || u.hostname === "::1") out.add(u.origin);
  } catch {}
  return out;
}

const DEFAULT = webOrigins();
let desktop: string | undefined;

/** Read or create the token that lets the desktop app's file:// UI in. */
export function loadDesktopToken(home: string): string {
  const file = join(home, "desktop-token");
  if (existsSync(file)) desktop = readFileSync(file, "utf8").trim();
  if (!desktop || desktop.length < 32) {
    desktop = randomBytes(24).toString("hex");
    mkdirSync(home, { recursive: true });
    writeFileSync(file, desktop, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return desktop;
}

// Byte lengths, not string lengths: timingSafeEqual throws on a mismatch (e.g. a non-ASCII token).
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** May a request with this Origin header (and ?t= token) drive the daemon? */
export function trustedOrigin(origin: string | undefined, token?: string | null, allowed: Set<string> = DEFAULT, expected = desktop): boolean {
  if (!origin) return true;
  if (origin === "null" || origin === "file://") return !!expected && !!token && same(token, expected);
  return allowed.has(origin);
}

/** The value for Access-Control-Allow-Origin, when this origin may read responses. */
export function corsOrigin(origin: string | undefined, token?: string | null, allowed: Set<string> = DEFAULT, expected = desktop): string | undefined {
  return origin && origin !== "file://" && trustedOrigin(origin, token, allowed, expected) ? origin : undefined;
}
