// Main-process view of the daemon: subscribes to the event stream and keeps a minimal fold
// (sessions + open decisions) so the shell can drive the dock badge and native notifications.
// The fold mirrors packages/protocol/src/fold.ts for the slices it keeps; keep them in step.

export const emptyState = () => ({ sessions: {}, decisions: {} });

function patchSession(s, id, patch) {
  const cur = s.sessions[id];
  if (!cur) return s;
  return { ...s, sessions: { ...s.sessions, [id]: { ...cur, ...patch } } };
}

export function reduce(s, e) {
  switch (e?.type) {
    case "session.created":
      return { ...s, sessions: { ...s.sessions, [e.session.id]: e.session } };
    case "session.updated":
      return patchSession(s, e.sessionId, e.patch);
    case "session.status":
      return patchSession(s, e.sessionId, { status: e.status, updatedAt: e.at });
    case "session.progress":
      return patchSession(s, e.sessionId, { progress: e.progress });
    case "decision.requested":
      return { ...s, decisions: { ...s.decisions, [e.decision.id]: e.decision } };
    case "decision.resolved": {
      const { [e.decisionId]: _, ...rest } = s.decisions;
      return { ...s, decisions: rest };
    }
    default:
      return s; // transcripts, configs, changes, outcomes: not needed in the shell
  }
}

export const isUnseen = (s) => (s.status === "done" || s.status === "failed") && (s.seenAt ?? 0) < s.updatedAt;

// What the dock badge counts: open decisions + failed sessions the dev hasn't looked at.
export function attentionCount(state) {
  const failed = Object.values(state.sessions).filter((s) => !s.archived && s.status === "failed" && isUnseen(s)).length;
  return Object.keys(state.decisions).length + failed;
}

// Connects to the daemon WebSocket with backoff. onChange(state, liveEvent|null) fires after every
// snapshot (liveEvent = null, prev = previous state) and every live event.
export function subscribe(url, { onChange, onStatus, log = console }) {
  let state = emptyState();
  let ws;
  let retry = 0;
  let timer;
  let closed = false;

  const connect = () => {
    if (closed) return;
    let sock;
    try {
      sock = ws = new globalThis.WebSocket(url);
    } catch (err) {
      log.error("[desktop] ws construct failed:", err);
      return schedule();
    }
    let opened = false;
    let ended = false;
    // Electron's bundled undici may fire only `error` (no `close`) on a refused connection, so
    // either one ends this socket; a stalled handshake is cut off by the watchdog.
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(watchdog);
      if (opened) onStatus?.(false);
      try {
        sock.close();
      } catch {}
      schedule();
    };
    const watchdog = setTimeout(() => !opened && end(), 5000);
    sock.onopen = () => {
      opened = true;
      clearTimeout(watchdog);
      retry = 0;
      onStatus?.(true);
    };
    sock.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      } catch {
        return;
      }
      try {
        if (msg.type === "snapshot") {
          const prev = state;
          state = (msg.events ?? []).reduce(reduce, emptyState());
          onChange(state, null, prev);
        } else if (msg.type === "event") {
          const prev = state;
          state = reduce(state, msg.event);
          onChange(state, msg.event, prev);
        }
      } catch (err) {
        log.error("[desktop] fold/handler error:", err);
      }
    };
    sock.onerror = end;
    sock.onclose = end;
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    const delay = Math.min(5000, 250 * 2 ** retry++);
    timer = setTimeout(connect, delay);
  };

  connect();
  return {
    get state() {
      return state;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {}
    },
  };
}
