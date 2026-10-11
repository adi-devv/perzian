import { useEffect, useReducer, useRef, useState } from "react";
import { emptyState, fold, reduce, type AgentKind, type ApiKeyProvider, type Command, type CredentialStatus, type DoctorReport, type InstallResult, type PerzianEvent, type ServerMessage, type State } from "@perzian/protocol";
import { demoEvents } from "./demo.ts";

// In the desktop app (file://) talk to the daemon directly; in dev go through the Vite proxy.
const direct = location.protocol === "file:";
const port = new URLSearchParams(location.search).get("port") ?? "4317";
export const API_BASE = direct ? `http://127.0.0.1:${port}` : "";
const WS_URL = direct ? `ws://127.0.0.1:${port}/ws` : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
export const isDesktop = direct;
export const isDemo = new URLSearchParams(location.search).has("demo");
/** Shown when the daemon can't be reached. */
export const DAEMON_ADDR = direct ? `127.0.0.1:${port}` : "the local daemon";

/** connecting: no answer yet · online · offline: the socket closed (the daemon isn't running or restarted). */
export type Link = "connecting" | "online" | "offline";

type Action = { kind: "event"; event: PerzianEvent } | { kind: "reset"; events: PerzianEvent[] };
const reducer = (s: State, a: Action): State => (a.kind === "reset" ? fold(a.events) : reduce(s, a.event));

export function useDaemon() {
  const [state, dispatch] = useReducer(reducer, emptyState);
  const [link, setLink] = useState<Link>(isDemo ? "online" : "connecting");
  const [error, setError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (isDemo) {
      dispatch({ kind: "reset", events: demoEvents });
      return;
    }
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      const sock = new WebSocket(WS_URL);
      ws.current = sock;
      // A replaced socket (reconnect, hot reload) may close after its successor opened; ignore it.
      sock.onopen = () => ws.current === sock && setLink("online");
      sock.onclose = () => {
        if (ws.current !== sock) return;
        setLink("offline");
        if (!closed) retry = setTimeout(connect, 1200);
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

  const send = (cmd: Command) => {
    if (isDemo) return demoSend(cmd, stateRef.current, (e) => dispatch({ kind: "event", event: e }));
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(cmd));
    else setError("Not connected to the Perzian daemon");
  };

  return { state, send, link, connected: link === "online", error, clearError: () => setError(null) };
}

// Minimal local behavior so the demo feels alive.
function demoSend(cmd: Command, s: State, emit: (e: PerzianEvent) => void) {
  const at = Date.now();
  if (cmd.type === "decision.answer") {
    const d = s.decisions[cmd.decisionId];
    if (!d) return;
    emit({ type: "decision.resolved", decisionId: d.id, sessionId: d.sessionId, optionId: cmd.optionId });
    emit({ type: "session.status", sessionId: d.sessionId, status: "working", at });
  } else if (cmd.type === "session.seen") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { seenAt: at } });
  } else if (cmd.type === "session.prompt" || (cmd.type === "main.start" && cmd.prompt)) {
    const id = cmd.type === "session.prompt" ? cmd.sessionId : "main";
    const text = cmd.type === "session.prompt" ? cmd.prompt : cmd.prompt!;
    emit({ type: "session.transcript", sessionId: id, item: { kind: "user", text, at } });
    emit({ type: "session.status", sessionId: id, status: "working", at });
    setTimeout(() => {
      emit({ type: "session.transcript", sessionId: id, item: { kind: "agent", text: "Demo mode: start the daemon to run real agents.", at: Date.now() } });
      emit({ type: "session.status", sessionId: id, status: "done", at: Date.now() });
    }, 700);
  } else if (cmd.type === "session.setModel") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { model: cmd.model } });
  } else if (cmd.type === "session.setMode") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { mode: cmd.mode } });
  } else if (cmd.type === "session.archive") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { archived: true } });
  }
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
      fetch(`${API_BASE}/api/doctor?${q}`)
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
    const res = await fetch(`${API_BASE}/api/credentials${query}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
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

export async function installAgent(agent: AgentKind): Promise<InstallResult> {
  const res = await fetch(`${API_BASE}/api/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }) });
  if (!res.ok) return { ok: false, output: await res.text() };
  return (await res.json()) as InstallResult;
}

export async function fetchText(kind: "diff" | "file", session: string, path: string): Promise<string> {
  if (isDemo) return kind === "diff" ? DEMO_DIFF : "// Demo mode: file contents come from the daemon.";
  const res = await fetch(`${API_BASE}/api/${kind}?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`);
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}

const DEMO_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
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
