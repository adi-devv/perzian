import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENTS,
  MODE_LABEL,
  byAttention,
  isUnseen,
  type AgentKind,
  type Command,
  type PermissionMode,
  type SessionInfo,
  type State,
  type TranscriptItem,
} from "@perzian/protocol";
import { fetchText, isDemo, useDaemon, useDoctor, type Link } from "./daemon.ts";
import { Accounts, DaemonOffline, FailureNotice, OfflineBanner, Onboarding, ShortcutHelp, friendlyError, isFailureNotice, loadProject, saveProject, withProject } from "./onboarding.tsx";
import { tokenize } from "./highlight.ts";
import type { ThemedToken } from "shiki/core";
import { ChangeMap, ChurnBar, DecisionCard, ProofPills, Ring, STATUS_LABEL, StatusGlyph, Usage, ago, churn, cost, useTick } from "./bits.tsx";

type Send = (c: Command) => void;

export function App() {
  const { state, send, link, connected, error, clearError } = useDaemon();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<{ session: string; path: string } | null>(null);
  const [help, setHelp] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const [project, setProject] = useState(loadProject);
  useTick();

  const all = Object.values(state.sessions).filter((s) => !s.archived);
  const main = all.find((s) => s.role === "main");
  // First run: connected, nothing started yet. The demo always has sessions, so it never lands here.
  const firstRun = !isDemo && link === "online" && all.length === 0;
  const doctor = useDoctor(project, firstRun);
  const checked = doctor.report?.project;
  const projectPath = checked?.exists && checked.input === project.trim() ? checked.path : undefined;
  // Remember a folder once the daemon confirms it exists, so a reload keeps it.
  useEffect(() => {
    if (projectPath) saveProject(project.trim());
  }, [projectPath]);
  const startLead = (prompt: string) => {
    send({ type: "main.start", prompt: firstRun && projectPath ? withProject(prompt, projectPath) : prompt });
  };

  // Errors fade on their own; clicking dismisses sooner.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 10_000);
    return () => clearTimeout(t);
  }, [error]);
  const workers = useMemo(() => all.filter((s) => s.role === "worker").sort(byAttention), [state.sessions]);
  // Oldest call first; in the demo the visitor's own run should be the card they see.
  const decisions = useMemo(() => Object.values(state.decisions).sort((a, b) => (isDemo ? b.createdAt - a.createdAt : a.createdAt - b.createdAt)), [state.decisions]);

  const open = (id: string | null) => {
    setSelected(id);
    if (id && state.sessions[id] && isUnseen(state.sessions[id])) send({ type: "session.seen", sessionId: id });
  };

  // Keyboard: n new · esc close · 1-9 answer the first decision · / focus composer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest("input, textarea, select");
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (viewing) setViewing(null);
        else if (creating) setCreating(false);
        else setSelected(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setHelp((v) => !v);
      } else if (e.key === "n") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("main-composer")?.focus();
      } else if (/^[1-9]$/.test(e.key) && decisions[0]) {
        const opt = decisions[0].options[Number(e.key) - 1];
        if (opt) send({ type: "decision.answer", decisionId: decisions[0].id, optionId: opt.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decisions, viewing, creating, help]);

  const sel = selected ? state.sessions[selected] : null;

  return (
    <div className={`app ${sel ? "with-drawer" : ""}`}>
      <Sidebar state={state} main={main} workers={workers} selected={selected} onSelect={open} onNew={() => setCreating(true)} onImport={() => send({ type: "sessions.import" })} onHelp={() => setHelp(true)} onAccounts={() => setAccounts(true)} connected={connected} />

      <Thread
        state={state}
        main={main}
        send={send}
        onOpen={open}
        decisions={decisions}
        link={link}
        onStart={startLead}
        firstRun={firstRun ? <Onboarding doctor={doctor} project={project} setProject={setProject} onStart={startLead} /> : null}
      />

      {sel && <Drawer key={sel.id} s={sel} state={state} send={send} onClose={() => setSelected(null)} onFile={(path) => setViewing({ session: sel.id, path })} onOpen={open} />}

      {creating && <NewSession onClose={() => setCreating(false)} onCreate={(cmd) => { send(cmd); setCreating(false); }} />}
      {viewing && <FileViewer {...viewing} onClose={() => setViewing(null)} />}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {accounts && <Accounts onClose={() => setAccounts(false)} />}
      {error && <Toast message={error} onClose={clearError} />}
    </div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  const { what, fix } = friendlyError(message);
  return (
    <div className="toast" role="alert" onClick={onClose} title={message}>
      <span className="toast-what">{what}</span> <span className="toast-fix">{fix}</span>
    </div>
  );
}

/** The last failure in a transcript that nothing has been sent after, and the prompt to resend. */
function retryTarget(items: TranscriptItem[], status: SessionInfo["status"]): { index: number; prompt: string } | null {
  if (status === "working" || status === "needs_you") return null;
  let fail = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    if (it.kind === "notice" && isFailureNotice(it.text)) {
      fail = i;
      break;
    }
  }
  if (fail < 0) return null;
  for (let i = fail - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return it.system ? null : { index: fail, prompt: it.text };
  }
  return null;
}

/* ───────────── Sidebar: every session at a glance ───────────── */

function Sidebar({ state, main, workers, selected, onSelect, onNew, onImport, onHelp, onAccounts, connected }: { state: State; main?: SessionInfo; workers: SessionInfo[]; selected: string | null; onSelect: (id: string | null) => void; onNew: () => void; onImport: () => void; onHelp: () => void; onAccounts: () => void; connected: boolean }) {
  const counts = { needs_you: 0, working: 0, failed: 0, done: 0, idle: 0 };
  for (const s of workers) counts[s.status]++;
  const spent = [main, ...workers].reduce((n, s) => n + (s?.usage?.costUsd ?? 0), 0);
  const groups = new Map<string, SessionInfo[]>();
  for (const s of workers) groups.set(s.project, [...(groups.get(s.project) ?? []), s]);

  return (
    <nav className="sidebar" aria-label="Sessions">
      <div className="side-head drag">
        <span className="brand">
          <span className="mark" aria-hidden />
          Perzian
          {isDemo && <span className="tag">demo</span>}
        </span>
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Daemon connected" : "Daemon offline"} />
      </div>

      <div className="glance" aria-label="Status summary">
        {(["needs_you", "working", "failed", "done"] as const).map((k) => (
          <div key={k} className={`glance-cell s-${k} ${counts[k] ? "" : "zero"}`} title={STATUS_LABEL[k]}>
            <b>{counts[k]}</b>
            <span>{STATUS_LABEL[k]}</span>
          </div>
        ))}
      </div>

      <button className={`row main-row ${selected === null ? "active" : ""} ${main ? `s-${main.status}` : ""}`} onClick={() => onSelect(null)}>
        <span className="mark small" aria-hidden />
        <span className="row-title">Perzian</span>
        {main?.status === "working" && <span className="dot" />}
        <kbd>/</kbd>
      </button>

      <div className="side-scroll">
        {[...groups.entries()].map(([project, list]) => (
          <section key={project} className="side-group">
            <h3 className="eyebrow">{project.split("/").slice(-1)[0]}</h3>
            {list.map((s) => (
              <button key={s.id} className={`row s-${s.status} ${selected === s.id ? "active" : ""} ${s.live === false ? "dormant" : ""}`} onClick={() => onSelect(selected === s.id ? null : s.id)} title={`${STATUS_LABEL[s.status]} · ${s.branch ?? s.project}`}>
                <StatusGlyph s={s} />
                <span className="row-title">{s.title}</span>
                {isUnseen(s) && <span className="unseen" aria-label="New result" />}
                <ChurnBar files={state.changes[s.id] ?? []} />
              </button>
            ))}
          </section>
        ))}
        {workers.length === 0 && <p className="quiet side-empty">Sessions you or Perzian start show up here.</p>}
      </div>

      <div className="side-foot">
        {spent > 0 && <p className="spent" title="Reported by the agents across all sessions, including Perzian">{cost(spent)} spent</p>}
        <button className="btn new" onClick={onNew}>
          New session <kbd>N</kbd>
        </button>
        <button className="link-btn" onClick={onImport} title="Show your recent Claude Code sessions here; open one to continue it">
          Import recent Claude Code sessions
        </button>
        {!isDemo && (
          <button className="link-btn" onClick={onAccounts}>
            Accounts &amp; API keys
          </button>
        )}
        <button className="link-btn" onClick={onHelp}>
          Keyboard shortcuts <kbd>?</kbd>
        </button>
      </div>
    </nav>
  );
}

/* ───────────── Thread: the main agent conversation, made of cards ───────────── */

function Thread({ state, main, send, onOpen, decisions, link, onStart, firstRun }: { state: State; main?: SessionInfo; send: Send; onOpen: (id: string) => void; decisions: State["decisions"][string][]; link: Link; onStart: (prompt: string) => void; firstRun: React.ReactNode }) {
  const items = main ? (state.transcripts[main.id] ?? []) : [];
  const empty = Object.keys(state.sessions).length === 0;
  const retry = main ? retryTarget(items, main.status) : null;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, decisions.length]);

  return (
    <main className="thread">
      <div className="thread-head drag">
        <h1>{main ? "Perzian" : "Talk to Perzian"}</h1>
        {main && <ModelPicker s={main} state={state} send={send} />}
        {main?.status === "working" && <span className="thinking">thinking</span>}
      </div>

      <div className="thread-scroll">
        {link === "offline" && (empty ? <DaemonOffline /> : <OfflineBanner />)}
        {firstRun}
        {!main && !firstRun && !(link === "offline" && empty) && link !== "connecting" && <Welcome />}
        <SinceYouLeft state={state} onOpen={onOpen} />
        <ThreadItems items={items} state={state} onOpen={onOpen} retry={retry && main ? { index: retry.index, run: () => send({ type: "session.prompt", sessionId: main.id, prompt: retry.prompt }) } : undefined} />
        <div ref={end} />
      </div>

      <div className="dock">
        {decisions.length > 0 && (
          <div className="needs" aria-label="Needs you">
            <h2 className="eyebrow s-needs_you">
              <span className="dot" /> Needs you <b>{decisions.length}</b>
            </h2>
            <div className="needs-list">
              {decisions.map((d, i) => (
                <DecisionCard key={d.id} d={d} index={i === 0 ? undefined : undefined} session={state.sessions[d.sessionId]} onOpen={() => onOpen(d.sessionId)} onAnswer={(optionId) => send({ type: "decision.answer", decisionId: d.id, optionId })} />
              ))}
            </div>
            <p className="hint">Press 1–{Math.min(9, decisions[0].options.length)} to answer the first card</p>
          </div>
        )}
        <Composer
          id="main-composer"
          placeholder={main ? "Ask Perzian, or tell it what to build…" : firstRun ? "Or describe your own task…" : "What are we working on? Perzian will split it into sessions."}
          busy={main?.status === "working"}
          onSubmit={(text) => (main ? send({ type: "session.prompt", sessionId: main.id, prompt: text }) : onStart(text))}
          onStop={main ? () => send({ type: "session.cancel", sessionId: main.id }) : undefined}
        />
      </div>
    </main>
  );
}

// "Where was I": results that landed while you weren't looking, one click each.
function SinceYouLeft({ state, onOpen }: { state: State; onOpen: (id: string) => void }) {
  const unseen = Object.values(state.sessions)
    .filter((s) => s.role === "worker" && !s.archived && isUnseen(s))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!unseen.length) return null;
  return (
    <div className="since">
      <span className="eyebrow">New results</span>
      {unseen.map((s) => (
        <button key={s.id} className={`since-chip s-${s.status}`} onClick={() => onOpen(s.id)}>
          <span className="dot" />
          {s.title}
          {state.outcomes[s.id]?.proof.length ? (
            <span className="since-proof">
              {state.outcomes[s.id].proof.filter((p) => p.passed).length}/{state.outcomes[s.id].proof.length}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-mark" aria-hidden />
      <h2>One agent to run the crew.</h2>
      <p>Describe the work. Perzian starts coding sessions in your repos, watches them, and only brings you decisions and results.</p>
      <ul>
        <li><span className="dot s-needs_you" /> Amber means it needs you</li>
        <li><span className="dot s-working" /> Blue pulses while it works</li>
        <li><span className="dot s-done" /> Green is done, with proof</li>
        <li><span className="dot s-failed" /> Red failed; open it to see why</li>
      </ul>
    </div>
  );
}

// Consecutive tool calls collapse into one strip; spawns render as live session cards.
function ThreadItems({ items, state, onOpen, retry }: { items: TranscriptItem[]; state: State; onOpen: (id: string) => void; retry?: { index: number; run: () => void } }) {
  const blocks: (TranscriptItem | TranscriptItem[])[] = [];
  const retryItem = retry ? items[retry.index] : undefined;
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === "tool" && Array.isArray(last)) last.push(it);
    else blocks.push(it.kind === "tool" ? [it] : it);
  }
  return (
    <>
      {blocks.map((b, i) => {
        if (Array.isArray(b)) return <ToolStrip key={i} tools={b} />;
        switch (b.kind) {
          case "user":
            // Daemon updates to the lead ("sessions finished") are plumbing, not something the developer typed.
            return b.system ? <SystemUpdate key={i} text={b.text} /> : <div key={i} className="msg user">{b.text}</div>;
          case "agent":
            return <div key={i} className="msg agent">{b.text}</div>;
          case "notice":
            return isFailureNotice(b.text) ? (
              <FailureNotice key={i} text={b.text} onRetry={b === retryItem ? retry?.run : undefined} />
            ) : (
              <div key={i} className="notice">{b.text}</div>
            );
          case "spawn": {
            const child = state.sessions[b.childId];
            return child ? <LiveCard key={i} s={child} state={state} onOpen={() => onOpen(child.id)} /> : null;
          }
          default:
            return null;
        }
      })}
    </>
  );
}

function SystemUpdate({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  const label = lines.length === 1 ? (/title="([^"]*)"/.exec(lines[0])?.[1] ?? "A session") + " finished" : `${lines.length || "Sessions"} sessions finished`;
  return (
    <div className="notice system-update" title={text}>
      ↳ {label} · Perzian notified
    </div>
  );
}

function ToolStrip({ tools }: { tools: TranscriptItem[] }) {
  return (
    <div className="toolstrip">
      {tools.map((t) => t.kind === "tool" && <span key={t.toolCallId} className={`act k-${t.toolKind ?? "other"} st-${t.status}`} title={t.title} />)}
      <span className="toolstrip-n">{tools.length} action{tools.length === 1 ? "" : "s"}</span>
    </div>
  );
}

// A spawned session, inline in the conversation, updating live.
function LiveCard({ s, state, onOpen }: { s: SessionInfo; state: State; onOpen: () => void }) {
  const files = state.changes[s.id] ?? [];
  const outcome = state.outcomes[s.id];
  const { add, del } = churn(files);
  const pending = Object.values(state.decisions).filter((d) => d.sessionId === s.id).length;
  return (
    <button className={`live s-${s.status}`} onClick={onOpen}>
      <div className="live-top">
        <StatusGlyph s={s} />
        <span className="live-title">{s.title}</span>
        <span className="live-status">{STATUS_LABEL[s.status]}{pending > 1 ? ` · ${pending}` : ""}</span>
        <span className="age">{ago(s.updatedAt)}</span>
      </div>
      <div className="live-meta">
        {s.branch && <code>{s.branch}</code>}
        <span className="agent-badge">{AGENTS[s.agent].label}</span>
        {s.usage?.costUsd !== undefined && <span className="agent-badge">{cost(s.usage.costUsd)}</span>}
        {s.progress && s.status === "working" && (
          <span className="live-phase">
            {s.progress.phase} · {s.progress.step}/{s.progress.of}
          </span>
        )}
        {files.length > 0 && (
          <span className="live-churn">
            {files.length} files <em className="a">+{add}</em> <em className="d">−{del}</em>
          </span>
        )}
      </div>
      {outcome && (s.status === "done" || s.status === "failed") && (
        <div className="live-outcome">
          <ProofPills o={outcome} />
          {outcome.risks[0] && <span className="risk">⚠ {outcome.risks[0]}</span>}
        </div>
      )}
    </button>
  );
}

function Composer({ id, placeholder, busy, onSubmit, onStop }: { id: string; placeholder: string; busy?: boolean; onSubmit: (t: string) => void; onStop?: () => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text.trim());
    setText("");
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        id={id}
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy && onStop ? (
        <button type="button" className="btn ghost" onClick={onStop}>Stop</button>
      ) : (
        <button className="btn primary" disabled={!text.trim()}>Send</button>
      )}
    </form>
  );
}

function ModelPicker({ s, state, send }: { s: SessionInfo; state: State; send: Send }) {
  const reported = state.configs[s.id]?.models ?? [];
  const options = reported.length ? reported.map((m) => ({ id: m.value, label: m.name })) : AGENTS[s.agent].models;
  const current = reported.length ? (state.configs[s.id]?.currentModel ?? "") : (s.model ?? "");
  return (
    <select className="picker" aria-label="Model" value={current} onChange={(e) => send({ type: "session.setModel", sessionId: s.id, model: e.target.value })}>
      {!options.some((o) => o.id === current) && <option value={current}>{current || "Default"}</option>}
      {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
}

/* ───────────── Drawer: deep dive into one session ───────────── */

function Drawer({ s, state, send, onClose, onFile, onOpen }: { s: SessionInfo; state: State; send: Send; onClose: () => void; onFile: (path: string) => void; onOpen: (id: string) => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const outcome = state.outcomes[s.id];
  const files = state.changes[s.id] ?? [];
  const transcript = state.transcripts[s.id] ?? [];
  const tools = transcript.filter((t) => t.kind === "tool");
  const decisions = Object.values(state.decisions).filter((d) => d.sessionId === s.id);
  const lastAgent = [...transcript].reverse().find((t) => t.kind === "agent");
  const parent = s.parentId ? state.sessions[s.parentId] : undefined;
  const retry = retryTarget(transcript, s.status);
  const failure = retry ? transcript[retry.index] : undefined;

  return (
    <aside className={`drawer s-${s.status}`} aria-label="Session detail">
      <div className="drawer-head drag">
        <StatusGlyph s={s} />
        <div className="drawer-title">
          <h2>{s.title}</h2>
          <p>
            <span className="status-text">{STATUS_LABEL[s.status]}</span>
            {s.progress && s.status === "working" && <> · {s.progress.phase} {s.progress.step}/{s.progress.of}</>}
            {s.live === false && <> · asleep</>}
          </p>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="chips">
        {s.branch && <code className="chip" title={s.cwd}>{s.worktree ? "⑂ " : ""}{s.branch}</code>}
        <span className="chip" title={AGENTS[s.agent].experimental ? "Experimental: less tested than Claude Code" : undefined}>{AGENTS[s.agent].label}{AGENTS[s.agent].experimental ? " · experimental" : ""}</span>
        <ModelPicker s={s} state={state} send={send} />
        <Usage s={s} />
        <select className="picker" aria-label="Permission mode" value={s.mode ?? "ask"} onChange={(e) => send({ type: "session.setMode", sessionId: s.id, mode: e.target.value as PermissionMode })}>
          {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
        {parent && <button className="chip link" onClick={() => onOpen(parent.id)}>via {parent.title}</button>}
      </div>

      <div className="drawer-scroll">
        {retry && failure?.kind === "notice" && <FailureNotice text={failure.text} onRetry={() => send({ type: "session.prompt", sessionId: s.id, prompt: retry.prompt })} />}
        {decisions.map((d) => (
          <DecisionCard key={d.id} d={d} session={s} onAnswer={(optionId) => send({ type: "decision.answer", decisionId: d.id, optionId })} />
        ))}

        {outcome && (
          <section className={`outcome o-${outcome.status}`}>
            <div className="outcome-head">
              <span className="outcome-badge">{outcome.status === "success" ? "✓ Done" : outcome.status === "failed" ? "✕ Failed" : "◐ Partial"}</span>
              {outcome.derived && <span className="tag" title="The agent didn't report an outcome; built from git">auto</span>}
            </div>
            <p className="outcome-intent">{outcome.intent}</p>
            <ProofPills o={outcome} />
            {outcome.risks.map((r, i) => <p key={i} className="risk">⚠ {r}</p>)}
            {outcome.followups.length > 0 && (
              <div className="followups">
                {outcome.followups.map((f, i) => (
                  <button key={i} className="chip link" onClick={() => send({ type: "session.prompt", sessionId: s.id, prompt: f })} title="Send as a follow-up">
                    ↳ {f}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {!outcome && (
          <section>
            <h3 className="eyebrow">Outcome</h3>
            <p className="quiet">{s.status === "working" || s.status === "needs_you" ? "Lands here when the agent finishes, with proof." : s.status === "failed" ? "None. The agent stopped before reporting one." : "No outcome yet. Send a task to get one."}</p>
          </section>
        )}

        <section>
          <h3 className="eyebrow">
            Change map <b>{files.length}</b>
            {files.length > 0 && <ChurnBar files={files} />}
          </h3>
          <ChangeMap files={files} onOpen={onFile} status={s.status} />
        </section>

        <section>
          <h3 className="eyebrow">Activity <b>{tools.length}</b></h3>
          <div className="activity">
            {tools.map((t) => t.kind === "tool" && <span key={t.toolCallId} className={`act k-${t.toolKind ?? "other"} st-${t.status}`} title={`${t.toolKind ?? "tool"}: ${t.title}`} />)}
            {tools.length === 0 && <span className="quiet">Nothing yet</span>}
          </div>
          <div className="legend">
            <span><i className="act k-read" /> read</span>
            <span><i className="act k-edit" /> edit</span>
            <span><i className="act k-execute" /> run</span>
            <span><i className="act st-failed" /> failed</span>
          </div>
        </section>

        {lastAgent && lastAgent.kind === "agent" && !showTranscript && <div className="msg agent small">{lastAgent.text}</div>}

        <button className="btn ghost wide" onClick={() => setShowTranscript((v) => !v)}>
          {showTranscript ? "Hide transcript" : `Read full transcript (${transcript.length})`}
        </button>
        {showTranscript && (
          <ol className="transcript">
            {transcript.map((t, i) => (
              <li key={i} className={`t-${t.kind}`}>
                {t.kind === "tool" ? <><b>{t.toolKind ?? "tool"}</b> {t.title}</> : t.kind === "spawn" ? <>started {t.title}</> : t.text}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="drawer-foot">
        <Composer id="session-composer" placeholder={`Tell ${s.title}…`} busy={s.status === "working"} onSubmit={(text) => send({ type: "session.prompt", sessionId: s.id, prompt: text })} onStop={() => send({ type: "session.cancel", sessionId: s.id })} />
        <button className="btn ghost small" onClick={() => { send({ type: "session.archive", sessionId: s.id }); onClose(); }}>Archive</button>
      </div>
    </aside>
  );
}

/* ───────────── Read-only code ───────────── */

type LineKind = "" | "add" | "del" | "hunk" | "meta";
function classify(l: string, diff: boolean): LineKind {
  if (!diff) return "";
  if (l.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(l)) return "meta";
  if (l.startsWith("+")) return "add";
  if (l.startsWith("-")) return "del";
  return "";
}

function FileViewer({ session, path, onClose }: { session: string; path: string; onClose: () => void }) {
  const [tab, setTab] = useState<"diff" | "file">("diff");
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Map<number, ThemedToken[]> | null>(null);
  useEffect(() => {
    setText(null);
    setErr(null);
    setTokens(null);
    fetchText(tab, session, path).then(setText, (e) => setErr(String(e.message ?? e)));
  }, [tab, session, path]);

  const diff = tab === "diff";
  const lines = useMemo(() => (text ?? "").replace(/\n$/, "").split("\n"), [text]);
  const kinds = useMemo(() => lines.map((l) => classify(l, diff)), [lines, diff]);

  // Highlight only code lines; in a diff, strip the +/-/space prefix first and map tokens back by index.
  useEffect(() => {
    if (text === null) return;
    let cancelled = false;
    const idx: number[] = [];
    const code: string[] = [];
    lines.forEach((l, i) => {
      if (kinds[i] === "hunk" || kinds[i] === "meta") return;
      idx.push(i);
      code.push(diff ? l.slice(1) : l);
    });
    tokenize(code, path).then((t) => {
      if (cancelled || !t) return;
      const m = new Map<number, ThemedToken[]>();
      t.forEach((line, j) => m.set(idx[j], line));
      setTokens(m);
    });
    return () => {
      cancelled = true;
    };
  }, [text, lines, kinds, diff, path]);

  return (
    <div className="modal" onClick={onClose}>
      <div className="viewer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={path}>
        <div className="viewer-head">
          <code>{path}</code>
          <div className="tabs">
            <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>Diff</button>
            <button className={tab === "file" ? "on" : ""} onClick={() => setTab("file")}>File</button>
          </div>
          <span className="tag">read-only</span>
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="viewer-body">
          {err && <p className="quiet">{err}</p>}
          {text === null && !err && <p className="quiet">Loading…</p>}
          {text !== null && (
            <pre className={`code ${tab}`}>
              {lines.map((l, i) => {
                const k = kinds[i];
                const toks = tokens?.get(i);
                return (
                  <div key={i} className={`ln ${k}`}>
                    <span className="gutter">{diff ? (k === "add" ? "+" : k === "del" ? "−" : "") : i + 1}</span>
                    <span>
                      {toks
                        ? toks.length
                          ? toks.map((t, j) => <span key={j} style={{ color: t.color }}>{t.content}</span>)
                          : " "
                        : (diff && k !== "hunk" && k !== "meta" ? l.slice(1) : l) || " "}
                    </span>
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────── New session ───────────── */

function NewSession({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Command) => void }) {
  const remembered = loadProject();
  const [project, setProject] = useState(remembered);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [worktree, setWorktree] = useState(true);
  return (
    <div className="modal" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          saveProject(project);
          onCreate({ type: "session.create", project, prompt, title: title || undefined, agent, model: model || undefined, mode, worktree });
        }}
      >
        <h2>New session</h2>
        <label>
          Project folder
          <input id="ns-project" required value={project} onChange={(e) => setProject(e.target.value)} placeholder="~/code/app" autoFocus={!project} />
        </label>
        <label>
          Task
          <textarea id="ns-prompt" required rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?" autoFocus={!!project} />
        </label>
        <label>
          Title
          <input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short name for the tile (optional)" />
        </label>
        <div className="sheet-row">
          <label>
            Agent
            <select id="ns-agent" value={agent} onChange={(e) => { setAgent(e.target.value as AgentKind); setModel(""); }}>
              {(Object.keys(AGENTS) as AgentKind[]).map((a) => <option key={a} value={a}>{AGENTS[a].label}{AGENTS[a].experimental ? " (experimental)" : ""}</option>)}
            </select>
          </label>
          <label>
            Model
            <select id="ns-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {AGENTS[agent].models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label>
            Permissions
            <select id="ns-mode" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </label>
        </div>
        <label className="check">
          <input id="ns-worktree" type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          Run in its own git worktree <span className="quiet">(safe for parallel work)</span>
        </label>
        <div className="sheet-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary">Start session</button>
        </div>
      </form>
    </div>
  );
}

export { Ring };
