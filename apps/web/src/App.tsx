import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { byAttention, type Command, type Decision, type Outcome, type PerzianEvent, type ServerMessage, type SessionInfo, type SessionStatus } from "@perzian/protocol";
import { empty, reduce, type State } from "./state.ts";
import { demoEvents } from "./demo.ts";

type Action = { kind: "event"; event: PerzianEvent } | { kind: "reset"; events: PerzianEvent[] };
const reducer = (s: State, a: Action): State => (a.kind === "reset" ? a.events.reduce(reduce, empty) : reduce(s, a.event));

const STATUS_LABEL: Record<SessionStatus, string> = { needs_you: "Needs you", working: "Working", failed: "Failed", done: "Done", idle: "Idle" };
const STATUS_ORDER: SessionStatus[] = ["needs_you", "working", "failed", "done", "idle"];

function useDaemon() {
  const demo = new URLSearchParams(location.search).has("demo");
  const [state, dispatch] = useReducer(reducer, empty);
  const [connected, setConnected] = useState(demo);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (demo) {
      dispatch({ kind: "reset", events: demoEvents });
      return;
    }
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => setConnected(true);
      sock.onclose = () => {
        setConnected(false);
        retry = setTimeout(connect, 1500);
      };
      sock.onmessage = (m) => {
        const msg = JSON.parse(m.data) as ServerMessage;
        if (msg.type === "snapshot") dispatch({ kind: "reset", events: msg.events });
        else if (msg.type === "event") dispatch({ kind: "event", event: msg.event });
        else console.error(msg.message);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      ws.current?.close();
    };
  }, [demo]);

  const send = (cmd: Command) => {
    if (demo) {
      if (cmd.type === "decision.answer") {
        const d = state.decisions[cmd.decisionId];
        dispatch({ kind: "event", event: { type: "decision.resolved", decisionId: cmd.decisionId, sessionId: d.sessionId, optionId: cmd.optionId } });
        dispatch({ kind: "event", event: { type: "session.status", sessionId: d.sessionId, status: "working", at: Date.now() } });
      }
      return;
    }
    ws.current?.send(JSON.stringify(cmd));
  };

  return { state, send, connected, demo };
}

export function App() {
  const { state, send, connected, demo } = useDaemon();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const sessions = useMemo(() => Object.values(state.sessions).sort(byAttention), [state.sessions]);
  const decisions = useMemo(() => Object.values(state.decisions).sort((a, b) => a.createdAt - b.createdAt), [state.decisions]);
  const counts = useMemo(() => {
    const c: Record<SessionStatus, number> = { needs_you: 0, working: 0, failed: 0, done: 0, idle: 0 };
    for (const s of sessions) c[s.status]++;
    return c;
  }, [sessions]);
  const byProject = useMemo(() => {
    const m = new Map<string, SessionInfo[]>();
    for (const s of sessions) m.set(s.project, [...(m.get(s.project) ?? []), s]);
    return [...m.entries()];
  }, [sessions]);

  const sel = selected ? state.sessions[selected] : null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden />
          perzian
          {demo && <span className="tag">demo</span>}
          <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Daemon connected" : "Daemon offline"} />
        </div>
        <div className="counts">
          {STATUS_ORDER.filter((k) => counts[k] > 0).map((k) => (
            <span key={k} className={`count s-${k}`}>
              <i />
              {counts[k]} <em>{STATUS_LABEL[k]}</em>
            </span>
          ))}
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>New session</button>
      </header>

      <main className="layout">
        <aside className="rail" aria-label="Needs you">
          <h2 className="eyebrow">Needs you <b>{decisions.length}</b></h2>
          {decisions.length === 0 && <p className="quiet">Nothing waiting. Agents are on it.</p>}
          {decisions.map((d) => (
            <DecisionCard key={d.id} decision={d} session={state.sessions[d.sessionId]} onAnswer={(optionId) => send({ type: "decision.answer", decisionId: d.id, optionId })} onOpen={() => setSelected(d.sessionId)} />
          ))}
        </aside>

        <section className="tower" aria-label="Sessions">
          {sessions.length === 0 && (
            <div className="empty">
              <p>No sessions yet.</p>
              <button className="btn primary" onClick={() => setCreating(true)}>Start one</button>
            </div>
          )}
          {byProject.map(([project, list]) => (
            <div key={project} className="project">
              <h3 className="eyebrow">{project}</h3>
              <div className="tiles">
                {list.map((s) => (
                  <Tile key={s.id} s={s} outcome={state.outcomes[s.id]} active={s.id === selected} onClick={() => setSelected(s.id === selected ? null : s.id)} />
                ))}
              </div>
            </div>
          ))}
        </section>

        {sel && <Detail s={sel} state={state} send={send} onClose={() => setSelected(null)} />}
      </main>

      {creating && <NewSession onClose={() => setCreating(false)} onCreate={(cmd) => { send(cmd); setCreating(false); }} />}
    </div>
  );
}

function Ring({ step, of }: { step: number; of: number }) {
  const r = 9, c = 2 * Math.PI * r, pct = Math.min(1, step / Math.max(1, of));
  return (
    <svg className="ring" viewBox="0 0 24 24" width="24" height="24" aria-label={`Step ${step} of ${of}`}>
      <circle cx="12" cy="12" r={r} className="ring-bg" />
      <circle cx="12" cy="12" r={r} className="ring-fg" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 12 12)" />
    </svg>
  );
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function Tile({ s, outcome, active, onClick }: { s: SessionInfo; outcome?: Outcome; active: boolean; onClick: () => void }) {
  const passed = outcome?.proof.filter((p) => p.passed).length ?? 0;
  const total = outcome?.proof.length ?? 0;
  return (
    <button className={`tile s-${s.status} ${active ? "active" : ""}`} onClick={onClick}>
      <div className="tile-top">
        <span className="dot" />
        <span className="tile-status">{STATUS_LABEL[s.status]}</span>
        <span className="tile-age">{ago(s.updatedAt)}</span>
      </div>
      <div className="tile-title">{s.title}</div>
      <div className="tile-meta">
        {s.branch && <code>{s.branch}</code>}
        <span className={`agent a-${s.agent}`}>{s.agent === "codex" ? "Codex" : "Claude"}</span>
      </div>
      <div className="tile-foot">
        {s.status === "working" && s.progress && (
          <>
            <Ring step={s.progress.step} of={s.progress.of} />
            <span>{s.progress.phase}</span>
          </>
        )}
        {outcome && (s.status === "done" || s.status === "failed") && (
          <span className="proof-mini">
            {outcome.proof.map((p, i) => <i key={i} className={p.passed ? "ok" : "bad"} />)}
            {passed}/{total} checks · {outcome.changed.length} files
          </span>
        )}
      </div>
    </button>
  );
}

function DecisionCard({ decision, session, onAnswer, onOpen }: { decision: Decision; session?: SessionInfo; onAnswer: (id: string | null) => void; onOpen: () => void }) {
  const isPerm = decision.source === "permission";
  return (
    <article className={`decision ${isPerm ? "perm" : ""}`}>
      <button className="decision-src" onClick={onOpen}>
        <span className="dot" />
        {session?.title ?? "Session"}
        <span className="tile-age">{ago(decision.createdAt)}</span>
      </button>
      {isPerm ? <code className="decision-cmd">{decision.question}</code> : <p className="decision-q">{decision.question}</p>}
      <div className={`options ${isPerm ? "row" : ""}`}>
        {decision.options.map((o) => (
          <button
            key={o.id}
            className={`opt k-${o.kind ?? "choice"} ${decision.recommended === o.id ? "rec" : ""}`}
            onClick={() => onAnswer(o.id)}
          >
            <span className="opt-label">{o.label}</span>
            {o.tradeoff && <span className="opt-trade">{o.tradeoff}</span>}
          </button>
        ))}
      </div>
    </article>
  );
}

const CHANGE_GLYPH = { added: "+", modified: "~", deleted: "−", renamed: "→" } as const;

function OutcomeCard({ o }: { o: Outcome }) {
  return (
    <section className={`outcome o-${o.status}`}>
      <h4 className="eyebrow">Outcome</h4>
      <p className="outcome-intent">{o.intent}</p>
      <div className="proofs">
        {o.proof.map((p, i) => (
          <span key={i} className={`proof ${p.passed ? "ok" : "bad"}`} title={p.detail}>
            {p.passed ? "✓" : "✕"} {p.label}
          </span>
        ))}
      </div>
      <ul className="changes">
        {o.changed.map((c) => (
          <li key={c.path} className={`c-${c.kind}`}>
            <b>{CHANGE_GLYPH[c.kind]}</b>
            <code>{c.path}</code>
          </li>
        ))}
      </ul>
      {o.risks.length > 0 && (
        <div className="risks">
          {o.risks.map((r, i) => <p key={i}>⚠ {r}</p>)}
        </div>
      )}
    </section>
  );
}

function Detail({ s, state, send, onClose }: { s: SessionInfo; state: State; send: (c: Command) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const outcome = state.outcomes[s.id];
  const transcript = state.transcripts[s.id] ?? [];
  const tools = transcript.filter((t) => t.kind === "tool");
  return (
    <aside className={`detail s-${s.status}`} aria-label="Session detail">
      <div className="detail-head">
        <span className="dot" />
        <div>
          <h3>{s.title}</h3>
          <p className="quiet">
            {s.branch ?? s.project} · {s.model ?? s.agent}
          </p>
        </div>
        <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {outcome && <OutcomeCard o={outcome} />}

      <section>
        <h4 className="eyebrow">Activity <b>{tools.length}</b></h4>
        <div className="activity">
          {tools.map((t) => t.kind === "tool" && (
            <span key={t.toolCallId} className={`act k-${t.toolKind ?? "other"} st-${t.status}`} title={t.title} />
          ))}
        </div>
      </section>

      <button className="btn ghost wide" onClick={() => setShowTranscript((v) => !v)}>
        {showTranscript ? "Hide transcript" : `Read transcript (${transcript.length})`}
      </button>
      {showTranscript && (
        <ol className="transcript">
          {transcript.map((t, i) => (
            <li key={i} className={`t-${t.kind}`}>
              {t.kind === "tool" ? <><b>{t.toolKind ?? "tool"}</b> {t.title}</> : t.text}
            </li>
          ))}
        </ol>
      )}

      <form
        className="prompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          send({ type: "session.prompt", sessionId: s.id, prompt: text });
          setText("");
        }}
      >
        <input id="session-prompt" value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell this session…" />
        {s.status === "working" && <button type="button" className="btn ghost" onClick={() => send({ type: "session.cancel", sessionId: s.id })}>Stop</button>}
      </form>
    </aside>
  );
}

function NewSession({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Command) => void }) {
  const [project, setProject] = useState(() => localStorage.getItem("perzian.lastProject") ?? "");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  return (
    <div className="modal" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          localStorage.setItem("perzian.lastProject", project);
          onCreate({ type: "session.create", project, prompt, title: title || undefined, agent: "claude-code" });
        }}
      >
        <h3>New session</h3>
        <label>Project folder<input id="ns-project" required value={project} onChange={(e) => setProject(e.target.value)} placeholder="/Users/you/code/app" /></label>
        <label>Title<input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" /></label>
        <label>Task<textarea id="ns-prompt" required rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?" /></label>
        <div className="sheet-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary">Start</button>
        </div>
      </form>
    </div>
  );
}
