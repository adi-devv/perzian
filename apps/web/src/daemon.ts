import { useEffect, useReducer, useRef, useState } from "react";
import { emptyState, fold, reduce, type AgentKind, type ApiKeyProvider, type Command, type CredentialStatus, type DoctorReport, type InstallResult, type LeftoverWorktree, type PerzianEvent, type RepoTree, type ServerMessage, type State } from "@perzian/protocol";
import { demoEvents } from "./demo.ts";
import { demoAutoplay, demoSend } from "./demoScript.ts";

// In the desktop app (file://) talk to the daemon directly; in dev go through the Vite proxy.
const direct = location.protocol === "file:";
const port = new URLSearchParams(location.search).get("port") ?? "4317";
export const API_BASE = direct ? `http://127.0.0.1:${port}` : "";
// The desktop app passes the daemon's token (?t=); file:// pages count only with it.
const token = new URLSearchParams(location.search).get("t");
// A phone opens the HTTPS tailnet address (*.ts.net) or the quick tunnel's (*.trycloudflare.com). It carries a long-lived device token from pairing in
// localStorage, sent as ?t= (a WebSocket can't set headers). Without one it shows the pairing screen.
export const isPhone = location.hostname.endsWith(".ts.net") || location.hostname.endsWith(".trycloudflare.com");
const DEVICE_KEY = "perzian.device";
let deviceToken: string | null = null;
try {
  deviceToken = isPhone ? localStorage.getItem(DEVICE_KEY) : null;
} catch {}
const rememberDevice = (t: string | null) => {
  deviceToken = t;
  try {
    if (t) localStorage.setItem(DEVICE_KEY, t);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {}
};
/** Trade a one-time code (from the QR or typed) for a device token. Resolves to an error message, or null when paired. */
export async function pairPhone(code: string): Promise<string | null> {
  try {
    const res = await fetch("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    if (!res.ok) return ((await res.json()) as { error?: string }).error ?? "That code didn't work.";
    rememberDevice(((await res.json()) as { token: string }).token);
    return null;
  } catch {
    return "Couldn't reach your Mac. Is Perzian running?";
  }
}
/** An API URL, carrying the desktop token or this phone's device token when there is one. */
export const api = (path: string) => {
  const t = isPhone ? deviceToken : direct ? token : null;
  return t ? `${API_BASE}${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(t)}` : `${API_BASE}${path}`;
};
const WS_URL = direct ? `ws://127.0.0.1:${port}/ws${token ? `?t=${encodeURIComponent(token)}` : ""}` : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${isPhone && deviceToken ? `?t=${encodeURIComponent(deviceToken)}` : ""}`;
export const isDesktop = direct;
export const isDemo = new URLSearchParams(location.search).has("demo");
/** Shown when the daemon can't be reached. */
export const DAEMON_ADDR = direct ? `127.0.0.1:${port}` : "the local daemon";

/** connecting: no answer yet · online · offline: the socket closed (the daemon isn't running or restarted)
 *  · refused: the daemon is up but won't take this page (opened from an origin it doesn't trust). */
export type Link = "connecting" | "online" | "offline" | "refused" | "unpaired";

// A WebSocket the daemon rejects closes just like one to a dead port. Ask over HTTP to tell them apart:
// a 401/403 means it's running and saying no; a network error or proxy 5xx means it's down.
async function refused(): Promise<boolean> {
  try {
    const r = await fetch(api(`/api/ping`), { cache: "no-store" });
    return r.status === 401 || r.status === 403;
  } catch {
    return false;
  }
}

type Action = { kind: "event"; event: PerzianEvent } | { kind: "reset"; events: PerzianEvent[] };
const reducer = (s: State, a: Action): State => (a.kind === "reset" ? fold(a.events) : reduce(s, a.event));

export function useDaemon() {
  const [state, dispatch] = useReducer(reducer, emptyState);
  const [link, setLink] = useState<Link>(isDemo ? "online" : isPhone && !deviceToken ? "unpaired" : "connecting");
  const [error, setError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (isDemo) {
      dispatch({ kind: "reset", events: demoEvents });
      return demoAutoplay(() => stateRef.current, (e) => dispatch({ kind: "event", event: e }));
    }
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    if (isPhone && !deviceToken) return;
    const connect = () => {
      const sock = new WebSocket(WS_URL);
      ws.current = sock;
      // A replaced socket (reconnect, hot reload) may close after its successor opened; ignore it.
      sock.onopen = () => ws.current === sock && setLink("online");
      let opened = false;
      sock.addEventListener("open", () => (opened = true));
      sock.onclose = async () => {
        if (ws.current !== sock) return;
        const no = !opened && (await refused());
        if (ws.current !== sock || closed) return;
        // This phone was forgotten on the Mac: drop its token and ask to pair again.
        if (no && isPhone) {
          rememberDevice(null);
          setLink("unpaired");
          return;
        }
        setLink(no ? "refused" : "offline");
        retry = setTimeout(connect, no ? 4000 : 1200);
      };
      sock.onmessage = (m) => {
        const msg = JSON.parse(m.data) as ServerMessage;
        if (msg.type === "snapshot") dispatch({ kind: "reset", events: msg.events });
        else if (msg.type === "event") dispatch({ kind: "event", event: msg.event });
        else setError(msg.message);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  // Tell the daemon whether this window is being looked at, so pushes to the phone stay quiet meanwhile.
  // It treats silence as "not looking"; the 10 s beat keeps a focused window counted.
  useEffect(() => {
    if (isDemo || isPhone || link !== "online") return;
    const tell = () => {
      const s = ws.current;
      const cmd: Command = { type: "ui.presence", focused: document.hasFocus() && document.visibilityState === "visible" };
      if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify(cmd));
    };
    tell();
    const beat = setInterval(tell, 10_000);
    window.addEventListener("focus", tell);
    window.addEventListener("blur", tell);
    document.addEventListener("visibilitychange", tell);
    return () => {
      clearInterval(beat);
      window.removeEventListener("focus", tell);
      window.removeEventListener("blur", tell);
      document.removeEventListener("visibilitychange", tell);
    };
  }, [link]);

  const send = (cmd: Command) => {
    if (isDemo) return demoSend(cmd, stateRef.current, (e) => dispatch({ kind: "event", event: e }));
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(cmd));
    else setError("Not connected to the Perzian daemon");
  };

  return { state, send, link, connected: link === "online", error, clearError: () => setError(null) };
}

// First-run checks. Agent probes are cached on the daemon; `recheck` bypasses that.
export function useDoctor(project: string, enabled: boolean) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fresh = useRef(false);
  useEffect(() => {
    if (!enabled || isDemo) return;
    let cancelled = false;
    const q = new URLSearchParams();
    if (project.trim()) q.set("project", project.trim());
    if (fresh.current) q.set("fresh", "1");
    fresh.current = false;
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(api(`/api/doctor?${q}`))
        .then((r) => (r.ok ? (r.json() as Promise<DoctorReport>) : Promise.reject(new Error(String(r.status)))))
        .then((r) => !cancelled && (setReport(r), setFailed(false)), () => !cancelled && setFailed(true))
        .finally(() => !cancelled && setLoading(false));
    }, project ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project, enabled, nonce]);
  const recheck = () => {
    fresh.current = true;
    setNonce((n) => n + 1);
  };
  return { report, loading, failed, recheck };
}

// API keys live on the daemon (Keychain); the UI only ever sees whether one is set and its last 4 chars.
export function useCredentials(enabled: boolean) {
  const [list, setList] = useState<CredentialStatus[] | null>(null);
  const call = async (method: string, query = "", body?: unknown) => {
    const res = await fetch(api(`/api/credentials${query}`), { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(await res.text());
    setList((await res.json()) as CredentialStatus[]);
  };
  useEffect(() => {
    if (enabled && !isDemo) call("GET").catch(() => {});
  }, [enabled]);
  return {
    list,
    /** Resolves to an error message, or null when saved. */
    save: (provider: ApiKeyProvider, key: string) => call("POST", "", { provider, key }).then(() => null, (e: Error) => e.message),
    remove: (provider: ApiKeyProvider) => call("DELETE", `?provider=${provider}`).catch(() => {}),
  };
}

/** Worktree folders no live session uses (archived or merged sessions leave them). Read-only. */
export function useLeftover(enabled: boolean) {
  const [list, setList] = useState<LeftoverWorktree[] | null>(null);
  useEffect(() => {
    if (!enabled || isDemo) return;
    let cancelled = false;
    fetch(api(`/api/worktrees/leftover`))
      .then((r) => (r.ok ? (r.json() as Promise<LeftoverWorktree[]>) : []))
      .then((l) => !cancelled && setList(l), () => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return list;
}

export async function installAgent(agent: AgentKind): Promise<InstallResult> {
  const res = await fetch(api(`/api/install`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }) });
  if (!res.ok) return { ok: false, output: await res.text() };
  return (await res.json()) as InstallResult;
}

export async function fetchText(kind: "diff" | "file", session: string, path: string): Promise<string> {
  if (isDemo) return kind === "diff" ? DEMO_DIFF : "// Demo mode: file contents come from the daemon.";
  const res = await fetch(api(`/api/${kind}?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`));
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}

/** The session folder's file tree for the Map; null in demo mode or when it can't be read (the Map then draws only changed files). */
export async function fetchTree(session: string): Promise<RepoTree | null> {
  if (isDemo) return null;
  try {
    const res = await fetch(api(`/api/tree?session=${encodeURIComponent(session)}`));
    return res.ok ? ((await res.json()) as RepoTree) : null;
  } catch {
    return null;
  }
}

const DEMO_DIFF =`diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,6 +1,14 @@
 import { redis } from "../db";
-import jwt from "jsonwebtoken";
+import { randomBytes } from "node:crypto";

-export function issue(user) {
-  return jwt.sign({ sub: user.id }, process.env.SECRET);
+const TTL = 60 * 60 * 24 * 7;
+
+export async function issue(user: { id: string }) {
+  const sid = randomBytes(24).toString("base64url");
+  await redis.set(\`sess:\${sid}\`, user.id, "EX", TTL);
+  return sid;
+}
+
+export async function revoke(sid: string) {
+  await redis.del(\`sess:\${sid}\`);
 }
`;
