// Phone access: the daemon answers these on the loopback API (never on the phone path).
//   GET    /api/phone          -> PhoneStatus
//   POST   /api/phone          {on: boolean, mode?: PhoneMode} -> PhoneStatus   (opt-in; off by default)
//   POST   /api/phone/pair     -> PhonePairing                (one-time code, short expiry, single use)
//   DELETE /api/phone/devices  -> PhoneStatus                 ("Forget all phones")
// The phone itself only ever calls /pair, the WebSocket and (with its device token) /api/push/* on the HTTPS address.

/** missing: no tailscale CLI · logged-out: installed, not signed in or stopped · no-https: MagicDNS/HTTPS certs off for the tailnet · ready. */
export type TailscaleState = "missing" | "logged-out" | "no-https" | "ready";

/** tailscale: https://<mac>.<tailnet>.ts.net · tunnel: a Cloudflare quick tunnel (https://*.trycloudflare.com), nothing to sign in to. */
export type PhoneMode = "tailscale" | "tunnel";

export interface PhoneStatus {
  /** How the phone reaches this Mac (the last choice while off). */
  mode: PhoneMode;
  /** `cloudflared` is on PATH, so "No setup" can be offered. */
  cloudflared: boolean;
  /** The developer turned Phone access on and the proxy is up. */
  on: boolean;
  tailscale: TailscaleState;
  /** Where the phone connects, e.g. https://mac.tail1234.ts.net:8443, or the tunnel's URL (changes every run). Set when reachable. */
  url?: string;
  /** Paired phones (count only; tokens are never shown). */
  phones: number;
  /** Why it couldn't turn on, in a sentence. */
  error?: string;
}

export interface PhonePairing {
  url: string;
  /** One-time code; the QR carries it in the URL fragment (never sent to a server). */
  code: string;
  expiresAt: number;
}
