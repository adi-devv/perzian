import { useRef, useState } from "react";
import { isUnseen, type Command, type Decision, type SessionInfo, type SessionStatus, type State } from "@perzian/protocol";
import { explainFailure, isFailureNotice } from "./onboarding.tsx";
import { PhoneButton } from "./phone.tsx";
import { useFlip } from "./motion.tsx";
import { Chips, OutsideTag, StatusGlyph, cost, denyOption, statusText, useFocusOnMount } from "./bits.tsx";
import { isDemo } from "./daemon.ts";

type Send = (c: Command) => void;

/* The crew: one live tile per session, grouped by project. Everything here is a fold over the daemon's state;
   the only local state is "pointer is over the column" (to hold the order still) and which done groups are open. */

// Needs you first, then failed, then what's running, then what's finished.
const RANK: Record<SessionStatus, number> = { needs_you: 0, failed: 1, working: 2, paused: 2, idle: 3, done: 4 };
const cmp = (a: SessionInfo, b: SessionInfo) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt;

/** All sessions in display order: projects with the most urgent session first, then each project's tiles by urgency. */
export function crewOrder(workers: SessionInfo[]): SessionInfo[] {
  const by = new Map<string, SessionInfo[]>();
  for (const w of workers) by.set(w.project, [...(by.get(w.project) ?? []), w]);
  const groups = [...by.entries()].map(([project, list]) => ({ project, list: list.sort(cmp) }));
  groups.sort((a, b) => cmp(a.list[0], b.list[0]) || a.project.localeCompare(b.project));
  return groups.flatMap((g) => g.list);
}

const base = (p: string) => p.split("/").filter(Boolean).slice(-1)[0] ?? p;

/** One line of state for a tile. */
export function tileLine(s: SessionInfo, state: State, pending: Decision[]): string {
  const items = state.transcripts[s.id] ?? [];
  if (s.status === "needs_you") return pending[0] ? pending[0].question : "Needs you";
  if (s.status === "failed") {
    if (s.setup?.state === "failed") return "Setup failed";
    const bad = s.checkRun?.results.find((r) => r.state === "failed");
    if (bad) return `${bad.name}: ${bad.summary ?? "failed"}`;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user") break;
      if (it.kind === "notice" && isFailureNotice(it.text)) return explainFailure(it.text).title + " · " + explainFailure(it.text).reason;
    }
    return "Stopped before finishing";
  }
  if (s.status === "paused") return statusText(s);
  if (s.status === "working") {
    if (s.setup?.state === "running") return "Setting up…";
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "tool") return it.status === "in_progress" || it.status === "pending" ? it.title : s.progress ? `${s.progress.phase} ${s.progress.step}/${s.progress.of}` : it.title;
      if (it.kind === "user") break;
    }
    if (s.progress) return `${s.progress.phase} ${s.progress.step}/${s.progress.of}${s.progress.note ? ` · ${s.progress.note}` : ""}`;
    return "Planning";
  }
  if (s.status === "idle") return s.live === false ? "Asleep" : "Ready";
  // done
  if (s.ship?.state === "merged") return `Merged into ${s.ship.into ?? "main"}`;
  if (s.ship?.state === "pr") return "PR opened";
  const o = state.outcomes[s.id];
  const run = s.checkRun;
  if (run?.state === "passed" || o?.proof.length) {
    const proof = o?.proof ?? [];
    const failed = proof.some((p) => !p.passed);
    return failed ? "Checks failed" : "Checks pass · ready to ship";
  }
  return "Ready to review";
}

/** Answer on the tile. Permission requests show the actual command or path first; a destructive one makes Deny the default. */
function TileAnswer({ d, send }: { d: Decision; send: Send }) {
  const perm = d.source === "permission";
  const deny = d.destructive ? denyOption(d) : undefined;
  const ref = useFocusOnMount(!!deny);
  const answer = (optionId: string) => send({ type: "decision.answer", decisionId: d.id, optionId });
  return (
    <div className="t-ask">
      {d.destructive && <span className="danger-tag">Destructive · {d.destructive}</span>}
      <OutsideTag d={d} />
      {perm && d.detail && <code className="t-cmd" title={d.detail}>{d.detail}</code>}
      <div className={`t-ans ${perm ? "row" : "stack"}`}>
        {d.options.map((o) => {
          const isDeny = deny?.id === o.id;
          const primary = deny ? isDeny : o.kind === "allow_once";
          return (
            <button key={o.id} ref={isDeny ? ref : undefined} className={`btn small ${primary ? "primary" : ""}`} title={[o.label, o.tradeoff].filter(Boolean).join(" · ")} onClick={() => answer(o.id)}>
              <span className="lab">{o.label}</span>
              {!perm && o.tradeoff && <span className="trade">{o.tradeoff}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Tile({ s, state, send, selected, onOpen, parent }: { s: SessionInfo; state: State; send: Send; selected: boolean; onOpen: (id: string) => void; parent?: SessionInfo }) {
  const pending = Object.values(state.decisions)
    .filter((d) => d.sessionId === s.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const line = tileLine(s, state, pending);
  const done = s.status === "done" || s.status === "idle";
  const first = pending[0];
  return (
    <div
      className={`ctile s-${s.status} ${parent ? "child" : ""} ${selected ? "sel" : ""} ${done ? "compact" : ""} ${isUnseen(s) ? "unseen-row" : ""} ${first?.destructive ? "destructive" : ""}`}
      role="button"
      tabIndex={0}
      data-tile={s.id}
      data-flip={s.id}
      aria-current={selected ? "true" : undefined}
      title={`${s.title} · ${statusText(s)}${s.branch ? ` · ${s.branch}` : ""}${parent ? ` · from ${parent.title}` : ""}`}
      onClick={() => onOpen(s.id)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(s.id);
        }
      }}
    >
      <div className="t-head">
        <StatusGlyph s={s} />
        <span className="t-title">{s.title}</span>
        {done && <span className="t-meta">{line}</span>}
      </div>
      {!done && (
        <div className="t-line" key={line}>
          {line}
        </div>
      )}
      {!done && <Chips s={s} quietOutside={!!first?.outside?.length} />}
      {s.status === "needs_you" && first && (
        <div onClick={(e) => e.stopPropagation()}>
          <TileAnswer d={first} send={send} />
          {pending.length > 1 && <p className="t-more">+{pending.length - 1} more waiting</p>}
        </div>
      )}
    </div>
  );
}

function Summary({ workers }: { workers: SessionInfo[] }) {
  const n = (st: SessionStatus) => workers.filter((w) => w.status === st).length;
  const needs = n("needs_you"), failed = n("failed"), working = n("working"), paused = n("paused"), done = n("done");
  const parts: React.ReactNode[] = [];
  if (needs) parts.push(<span key="n" className="n-needs">{needs} need{needs === 1 ? "s" : ""} you</span>);
  if (failed) parts.push(<span key="f" className="n-failed">{failed} failed</span>);
  if (working) parts.push(<span key="w">{working} working</span>);
  if (paused) parts.push(<span key="p">{paused} paused</span>);
  if (!parts.length) parts.push(<span key="q">{workers.length ? `All quiet · ${done} done` : "No sessions yet"}</span>);
  return (
    <div className="summary" role="status" aria-live="polite">
      {parts.flatMap((p, i) => (i ? [<span key={`s${i}`} className="sep">·</span>, p] : [p]))}
    </div>
  );
}

const DONE_FOLD = 3;

export function Crew({ state, workers, selected, onOpen, send, connected, onAddProject, onImport, onHelp, onAccounts, onUseProject }: { state: State; workers: SessionInfo[]; selected: string | null; onOpen: (id: string) => void; send: Send; connected: boolean; onAddProject: () => void; onImport: () => void; onHelp: () => void; onAccounts: () => void; onUseProject: (path: string) => void }) {
  // While the pointer is over the column the order holds still, so a tile never moves out from under a click.
  // New orders queue and apply on mouseleave.
  const [held, setHeld] = useState(false);
  const flat = crewOrder(workers).map((s) => s.id);
  const shown = useRef(flat);
  if (!held) shown.current = flat;
  else {
    const known = shown.current.filter((id) => flat.includes(id));
    shown.current = [...known, ...flat.filter((id) => !known.includes(id))];
  }
  const order = shown.current;
  const byId = new Map(workers.map((w) => [w.id, w]));
  const groups = new Map<string, SessionInfo[]>();
  for (const id of order) {
    const s = byId.get(id);
    if (s) groups.set(s.project, [...(groups.get(s.project) ?? []), s]);
  }
  for (const p of state.settings.projects) if (!groups.has(p)) groups.set(p, []);
  const scroll = useFlip<HTMLDivElement>(order.join(), 150);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const spent = workers.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);

  return (
    <nav className="crewcol" aria-label="Crew" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
      <div className="side-head drag">
        <span className="brand">
          <span className="mark" aria-hidden />
          Perzian
          {isDemo && <span className="tag">demo</span>}
        </span>
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Daemon connected" : "Daemon offline"} />
      </div>
      <Summary workers={workers} />

      <div className="crew-list" ref={scroll}>
        {[...groups.entries()].map(([project, list]) => {
          // A session started by another session nests under it, indented, when both live in this project.
          const parentOf = (x: SessionInfo) => (x.parentId && x.parentId !== "main" ? list.find((p) => p.id === x.parentId) : undefined);
          const top = list.filter((x) => !parentOf(x));
          const active = top.filter((x) => x.status !== "done");
          const done = top.filter((x) => x.status === "done");
          const fold = done.length > DONE_FOLD && !open.has(project);
          const row = (x: SessionInfo) => (
            <div key={x.id} className="crew-nest">
              <Tile s={x} state={state} send={send} selected={selected === x.id} onOpen={onOpen} />
              {list.filter((c) => c.parentId === x.id).map((c) => <Tile key={c.id} s={c} parent={x} state={state} send={send} selected={selected === c.id} onOpen={onOpen} />)}
            </div>
          );
          return (
            <section key={project} className="crew-group">
              <h3 className="grp-h" title={project}>
                <span>{base(project)}</span>
              </h3>
              {list.length === 0 && (
                <button className="btn small ghost empty-proj" onClick={() => onUseProject(project)}>Tell Perzian what to build here</button>
              )}
              {active.map(row)}
              {done.length > DONE_FOLD && (
                <button
                  className="btn small done-toggle"
                  aria-expanded={!fold}
                  onClick={() => setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(project)) n.delete(project);
                    else n.add(project);
                    return n;
                  })}
                >
                  <span>{done.length} done</span>
                  <span aria-hidden>{fold ? "▸" : "▾"}</span>
                </button>
              )}
              {!fold && done.map(row)}
            </section>
          );
        })}
        {workers.length === 0 && <p className="quiet crew-empty">Ask Perzian for something and its sessions show up here.</p>}
      </div>

      <div className="crew-foot">
        {spent > 0 && <p className="spent" title="Reported by the agents across all sessions">{cost(spent)} spent</p>}
        <div className="crew-foot-row">
          <button className="btn grow-btn" onClick={onAddProject}>Add project</button>
          <details className="more" onToggle={(e) => e.currentTarget.classList.toggle("open", e.currentTarget.open)}>
            <summary className="btn" aria-label="More">⋯</summary>
            <div className="more-menu" onClick={(e) => { const d = e.currentTarget.closest("details"); if (d && (e.target as HTMLElement).closest("button")) d.open = false; }}>
              <button className="btn small" onClick={onImport} title="Show your recent Claude Code sessions here; open one to continue it">Import Claude Code sessions</button>
              {!isDemo && <button className="btn small" onClick={onAccounts}>Accounts &amp; API keys</button>}
              <PhoneButton />
              <button className="btn small" onClick={onHelp}>Keyboard shortcuts <kbd>?</kbd></button>
            </div>
          </details>
        </div>
      </div>
    </nav>
  );
}

