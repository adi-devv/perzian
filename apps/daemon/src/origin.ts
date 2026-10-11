// Browsers let any website send requests to 127.0.0.1, and this daemon runs agents and installers.
// Only Perzian's own UI may drive it from a browser: the desktop app (file://, origin "null"), the Vite
// dev server on port 4318 (the proxy forwards the page's Origin), and PERZIAN_WEB_URL when it points at
// this machine. Any other localhost port is someone else's page. Non-browser clients send no Origin.

export const WEB_PORT = 4318;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function webOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set(LOOPBACK.map((h) => `http://${h}:${WEB_PORT}`));
  try {
    const u = new URL(env.PERZIAN_WEB_URL ?? "");
    if (LOOPBACK.includes(u.hostname) || u.hostname === "::1") out.add(u.origin);
  } catch {}
  return out;
}

const DEFAULT = webOrigins();

/** May a request with this Origin header drive the daemon? */
export function trustedOrigin(origin: string | undefined, allowed: Set<string> = DEFAULT): boolean {
  return !origin || origin === "null" || origin === "file://" || allowed.has(origin);
}

/** The value for Access-Control-Allow-Origin, when this origin may read responses. */
export function corsOrigin(origin: string | undefined, allowed: Set<string> = DEFAULT): string | undefined {
  return origin && origin !== "file://" && trustedOrigin(origin, allowed) ? origin : undefined;
}
