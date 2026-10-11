// Phone access, both ends: the Mac's "Open on phone" sheet (QR + one-time code), the pairing screen a new
// phone sees, and the phone's own layout (attention queue, decision cards, compact tiles; nothing else).
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { byAttention, type PhonePairing, type PhoneStatus, type State } from "@perzian/protocol";
import { api, isDemo, isPhone, pairPhone, type Link } from "./daemon.ts";
import { DecisionCard, StatusGlyph, ago, statusText, useTick } from "./bits.tsx";
import type { Command } from "@perzian/protocol";

/** True below 600px: the phone layout. */
export function useNarrow(): boolean {
  const q = "(max-width: 599px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/* ───────────── The Mac side ───────────── */

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(api(path), { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export function PhoneButton() {
  const [open, setOpen] = useState(false);
  if (isDemo || isPhone) return null;
  return (
    <>
      <button className="btn small" onClick={() => setOpen(true)}>
        Open on phone
      </button>
      {open && <PhoneSheet onClose={() => setOpen(false)} />}
    </>
  );
}

const SETUP: Record<string, { title: string; steps: string[] }> = {
  missing: { title: "Install Tailscale", steps: ["Install Tailscale on this Mac and on your phone (tailscale.com/download).", "Sign in to both with the same account.", "Come back and check again."] },
  "logged-out": { title: "Sign in to Tailscale", steps: ["Open Tailscale on this Mac and sign in (menu bar icon).", "Sign in on your phone with the same account.", "Check again."] },
  "no-https": { title: "Turn on HTTPS in Tailscale", steps: ["In the Tailscale admin console, open DNS.", "Turn on MagicDNS, then Enable HTTPS.", "Check again."] },
};

function PhoneSheet({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => run(async () => setStatus(await call<PhoneStatus>("GET", "/api/phone")));
  const newCode = () => call<PhonePairing>("POST", "/api/phone/pair").then(setPairing);
  useEffect(() => {
    refresh();
  }, []);
  // A code is made when the sheet opens with access on, and never shown stale.
  useEffect(() => {
    if (status?.on && !pairing) run(newCode);
  }, [status?.on]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const setup = status && !status.on ? SETUP[status.tailscale] : undefined;

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet phone-sheet" role="dialog" aria-label="Open on phone" onClick={(e) => e.stopPropagation()}>
        <h2>Open on phone</h2>
        {!status && <p className="quiet">Checking Tailscale…</p>}
        {setup && (
          <>
            <p className="onboard-sub">{setup.title}</p>
            <ol className="steps">
              {setup.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </>
        )}
        {status && !status.on && !setup && <p className="onboard-sub">Serves Perzian to your own Tailscale network only. Each phone pairs once with a code from this screen. Off until you turn it on.</p>}
        {status?.on && pairing && (
          <div className="pair">
            <Qr text={`${pairing.url}/#pair=${pairing.code}`} dim={left === 0} />
            <code className="pair-code">{pairing.code}</code>
            <p className="quiet">{left > 0 ? `Scan with your phone's camera. One use, expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.` : "Code expired."}</p>
            <p className="quiet pair-url">{pairing.url}</p>
          </div>
        )}
        {(err || status?.error) && <p className="phone-err">{err ?? status?.error}</p>}
        <div className="sheet-actions">
          {status?.on ? (
            <>
              <button className="btn" disabled={busy || status.phones === 0} onClick={() => run(async () => setStatus(await call<PhoneStatus>("DELETE", "/api/phone/devices")))}>
                Forget all phones{status.phones ? ` (${status.phones})` : ""}
              </button>
              <button className="btn" disabled={busy} onClick={() => run(newCode)}>
                New code
              </button>
              <button className="btn" disabled={busy} onClick={() => run(async () => (setPairing(null), setStatus(await call<PhoneStatus>("POST", "/api/phone", { on: false }))))}>
                Turn off
              </button>
            </>
          ) : setup ? (
            <button className="btn" disabled={busy} onClick={refresh}>
              Check again
            </button>
          ) : (
            status && (
              <button className="btn primary" disabled={busy} onClick={() => run(async () => setStatus(await call<PhoneStatus>("POST", "/api/phone", { on: true })))}>
                Turn on phone access
              </button>
            )
          )}
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Qr({ text, dim }: { text: string; dim?: boolean }) {
  const { size, d } = useMemo(() => {
    const m = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
    let d = "";
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.get(x, y)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    return { size: m.size + 4, d };
  }, [text]);
  return (
    <svg className={`qr ${dim ? "dim" : ""}`} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code to pair your phone" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/* ───────────── The phone side ───────────── */

/** A new phone: the QR link carries the code in #pair=; otherwise type it. */
export function PairScreen() {
  const fromLink = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("pair") ?? "", []);
  const [code, setCode] = useState(fromLink);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (c: string) => {
    if (!c.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const e = await pairPhone(c);
    if (e) {
      setErr(e);
      setBusy(false);
    } else {
      history.replaceState(null, "", location.pathname);
      location.reload();
    }
  };
  useEffect(() => {
    if (fromLink) void submit(fromLink);
  }, []);
  return (
    <div className="phone">
      <div className="onboard">
        <span className="offline-mark" aria-hidden />
        <h2>Pair this phone</h2>
        <p className="onboard-sub">On your Mac, open Perzian, choose Open on phone, and scan the QR code. Or type the code shown there.</p>
        <form className="pair-form" onSubmit={(e) => (e.preventDefault(), submit(code))}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-label="Pairing code" />
          <button className="btn primary" disabled={busy || !code.trim()}>
            Pair
          </button>
        </form>
        {err && <p className="phone-err">{err}</p>}
      </div>
    </div>
  );
}

/** Under 600px: what needs you, answerable, and one compact tile per session. No composer, no drawers. */
export function PhoneHome({ state, send, link }: { state: State; send: (c: Command) => void; link: Link }) {
  useTick();
  const workers = Object.values(state.sessions)
    .filter((s) => !s.archived && s.role === "worker")
    .sort(byAttention);
  const decisions = Object.values(state.decisions).sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="phone">
      <header className="phone-head">
        <span className="brand">
          <span className="mark" aria-hidden />
          Perzian
        </span>
        <span className={`conn ${link === "online" ? "on" : "off"}`} title={link === "online" ? "Connected" : "Can't reach your Mac"} />
      </header>
      {link !== "online" && <p className="quiet phone-note">{link === "connecting" ? "Connecting…" : "Can't reach your Mac. Is Perzian running and awake?"}</p>}
      {decisions.length > 0 && (
        <section aria-label="Needs you">
          <h2 className="eyebrow s-needs_you">
            <span className="dot" /> Needs you <b>{decisions.length}</b>
          </h2>
          <div className="needs-list">
            {decisions.map((d) => (
              <DecisionCard key={d.id} d={d} session={state.sessions[d.sessionId]} onAnswer={(optionId) => send({ type: "decision.answer", decisionId: d.id, optionId })} />
            ))}
          </div>
        </section>
      )}
      <section aria-label="Sessions">
        <h2 className="eyebrow">Sessions</h2>
        {workers.length === 0 && <p className="quiet">Nothing running.</p>}
        <div className="tiles">
          {workers.map((s) => {
            const files = (state.changes[s.id] ?? []).length;
            return (
              <article key={s.id} className={`tile s-${s.status}`}>
                <StatusGlyph s={s} />
                <div className="tile-main">
                  <span className="tile-title">{s.title}</span>
                  <span className="tile-sub">
                    {statusText(s)}
                    {s.progress && s.status === "working" ? ` · ${s.progress.phase} ${s.progress.step}/${s.progress.of}` : ""}
                    {files ? ` · ${files} files` : ""}
                  </span>
                </div>
                <span className="age">{ago(s.updatedAt)}</span>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
