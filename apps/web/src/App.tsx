import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, isUnseen, type Command, type SessionInfo, type State, type TranscriptItem } from "@perzian/protocol";
import { isDemo, useDaemon, useDoctor, type Link } from "./daemon.ts";
import { Accounts, FolderPicker, recentProjects, DaemonOffline, DaemonRefused, FailureNotice, OfflineBanner, Onboarding, ShortcutHelp, friendlyError, isFailureNotice, loadProject, readiness, saveProject, withProject } from "./onboarding.tsx";
import { PairScreen, PhoneHome, useNarrow } from "./phone.tsx";
import { Composer, LEAD_PLACEHOLDER, ModePicker, ModelPicker, Ring, StatusGlyph, churn, pauseTitle, retryTarget, statusText, useTick } from "./bits.tsx";
import { Crew } from "./crew.tsx";
import { SessionDetail } from "./detail.tsx";

type Send = (c: Command) => void;

export function App() {
  const { state, send, link, connected, error, clearError } = useDaemon();
  // Which session fills the center column; null is Perzian's chat.
  const [selected, setSelected] = useState<string | null>(null);
  // Lead messages that arrived while a session was open count from here (the lead transcript length when you left it).
  const [leadSeen, setLeadSeen] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const [adding, setAdding] = useState(false);
  const [project, setProject] = useState(loadProject);
  // A folder picked with "Add project": the next lead message carries it, then it clears.
  const [leadProject, setLeadProject] = useState<string | null>(null);
  const narrow = useNarrow();
  useTick();

  const all = Object.values(state.sessions).filter((s) => !s.archived);
  const main = all.find((s) => s.role === "main");
  // First run: connected, nothing started yet. The demo always has sessions, so it never lands here.
  const firstRun = !isDemo && link === "online" && all.length === 0;
  const recent = useMemo(() => recentProjects(state), [state.sessions]);
  const doctor = useDoctor(project, firstRun);
  const checked = doctor.report?.project;
  const projectPath = checked?.exists && checked.input === project.trim() ? checked.path : undefined;
  // Remember a folder once the daemon confirms it exists, so a reload keeps it.
  useEffect(() => {
    if (projectPath) saveProject(project.trim());
  }, [projectPath]);
  // The same checks gate the example buttons and the free-text composer on first run.
  const gate = firstRun ? readiness(doctor.report, project) : { ready: true, blocker: "" };
  const startLead = (prompt: string) => {
    if (!gate.ready) return;
    send({ type: "main.start", prompt: firstRun && projectPath ? withProject(prompt, projectPath) : prompt });
  };

  // Use a folder for the lead's next message and land in Perzian's chat.
  const startInFolder = (p: string) => {
    setLeadProject(p);
    open(null);
    focusLead();
  };

  // Errors fade on their own; clicking dismisses sooner.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 10_000);
    return () => clearTimeout(t);
  }, [error]);
  const workers = useMemo(() => all.filter((s) => s.role === "worker"), [state.sessions]);
  // Oldest call first.
  const decisions = useMemo(() => Object.values(state.decisions).sort((a, b) => a.createdAt - b.createdAt), [state.decisions]);

  const sel = selected && state.sessions[selected] && !state.sessions[selected].archived ? state.sessions[selected] : null;
  const mainItems = main ? (state.transcripts[main.id] ?? []) : [];
  const leadNew = sel && leadSeen !== null ? mainItems.slice(leadSeen).filter((i) => i.kind === "agent").length : 0;

  const open = (id: string | null) => {
    if (id && !selected) setLeadSeen(mainItems.length);
    if (!id) setLeadSeen(null);
    setSelected(id);
    if (id && state.sessions[id] && isUnseen(state.sessions[id])) send({ type: "session.seen", sessionId: id });
  };
  // A result that lands while its session is open is seen already.
  useEffect(() => {
    if (sel && isUnseen(sel)) send({ type: "session.seen", sessionId: sel.id });
  }, [sel?.updatedAt, sel?.status]);
  // A session that was archived or removed while open: back to Perzian.
  useEffect(() => {
    if (selected && !sel) open(null);
  }, [selected, sel]);

  const focusLead = () => requestAnimationFrame(() => document.getElementById("main-composer")?.focus());
  const modal = help || accounts || adding;

  // Keyboard: ⌘1 / Esc Perzian · ↑/↓ move between tiles, Enter opens · 1-9 answer a decision · / focus the input · ? help
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      const typing = el?.closest("input, textarea, select");
      if ((e.metaKey || e.ctrlKey) && e.key === "1" && !modal) {
        e.preventDefault();
        open(null);
        focusLead();
        return;
      }
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (adding) setAdding(false);
        else if (accounts) setAccounts(false);
        // A draft in the input: the first Esc only leaves the input, so going back can't lose it.
        else if (typing && (el as HTMLTextAreaElement).value) (el as HTMLElement).blur();
        else if (selected) {
          if (typing) (el as HTMLElement).blur();
          open(null);
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || modal) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setHelp((v) => !v);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById(selected ? "session-composer" : "main-composer")?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Only from the crew column (or nowhere in particular), so arrows still scroll a diff.
        const a = document.activeElement;
        if (a && a !== document.body && !a.closest(".crewcol")) return;
        const tiles = [...document.querySelectorAll<HTMLElement>("[data-tile]")];
        if (!tiles.length) return;
        e.preventDefault();
        const focused = tiles.indexOf(a?.closest("[data-tile]") as HTMLElement);
        const cur = focused >= 0 ? focused : selected ? tiles.findIndex((t) => t.dataset.tile === selected) : -1;
        const next = e.key === "ArrowDown" ? Math.min(cur + 1, tiles.length - 1) : Math.max(cur - 1, 0);
        tiles[next].focus();
        tiles[next].scrollIntoView({ block: "nearest" });
      } else if (/^[1-9]$/.test(e.key)) {
        // In a session: its own oldest call. Otherwise the call on the topmost tile that is asking.
        const owner = selected ?? document.querySelector<HTMLElement>("[data-tile]:has(.t-ask)")?.dataset.tile;
        const shown = decisions.find((d) => d.sessionId === owner);
        const opt = shown?.options[Number(e.key) - 1];
        if (shown && opt) send({ type: "decision.answer", decisionId: shown.id, optionId: opt.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decisions, selected, help, adding, accounts, mainItems.length]);

  // A phone that isn't paired yet, or any window under 600px: the attention queue, nothing else.
  if (link === "unpaired") return <PairScreen />;
  if (narrow) return <PhoneHome state={state} send={send} link={link} error={error} />;

  return (
    <div className="app">
      <Crew state={state} workers={workers} selected={sel?.id ?? null} onOpen={open} send={send} connected={connected} onAddProject={() => setAdding(true)} onImport={() => send({ type: "sessions.import" })} onHelp={() => setHelp(true)} onAccounts={() => setAccounts(true)} onUseProject={startInFolder} />

      <div className="center">
        <Thread
          hidden={!!sel}
          state={state}
          main={main}
          send={send}
          onOpen={open}
          link={link}
          onStart={startLead}
          blocked={gate.ready ? undefined : gate.blocker}
          focus={firstRun && !!project.trim()}
          firstRun={firstRun ? <Onboarding doctor={doctor} project={project} setProject={setProject} recent={recent} /> : null}
          leadProject={leadProject}
          onProjectUsed={() => setLeadProject(null)}
        />
        {sel && <SessionDetail key={sel.id} s={sel} state={state} send={send} onBack={() => { open(null); focusLead(); }} onOpen={open} leadNew={leadNew} />}
      </div>

      {adding && (
        <AddProject
          recent={recent}
          onClose={() => setAdding(false)}
          onPick={(p) => {
            saveProject(p);
            // The daemon keeps it (event store), so it stays in the crew column after a reload.
            send({ type: "settings.addProject", path: p });
            setAdding(false);
            startInFolder(p);
          }}
        />
      )}
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

/* ───────────── Add project: pick a folder; the lead's next message is about it ───────────── */

function AddProject({ recent, onClose, onPick }: { recent: string[]; onClose: () => void; onPick: (path: string) => void }) {
  const [path, setPath] = useState(loadProject);
  return (
    <div className="modal" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (path.trim()) onPick(path.trim()); }}>
        <h2>Add project</h2>
        <FolderPicker id="ap-project" project={path} setProject={setPath} recent={recent} onPicked={() => undefined} autoFocus={!path} />
        <p className="quiet small">Then tell Perzian what to build in it. Sessions appear on the left.</p>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!path.trim()}>Use this folder</button>
        </div>
      </form>
    </div>
  );
}

/* ───────────── Perzian's chat: the one place work starts ───────────── */

function Thread({ hidden, state, main, send, onOpen, link, onStart, blocked, focus, firstRun, leadProject, onProjectUsed }: { hidden: boolean; state: State; main?: SessionInfo; send: Send; onOpen: (id: string) => void; link: Link; onStart: (prompt: string) => void; blocked?: string; focus?: boolean; firstRun: React.ReactNode; leadProject: string | null; onProjectUsed: () => void }) {
  const items = main ? (state.transcripts[main.id] ?? []) : [];
  const empty = Object.keys(state.sessions).length === 0;
  const retry = main ? retryTarget(items, main.status) : null;
  const end = useRef<HTMLDivElement>(null);
  // The demo's "this is scripted" notices are a dismissible hint above the composer, not a line in the stream.
  const demoNote = isDemo ? [...items].reverse().find((i) => i.kind === "notice" && i.text.startsWith("Demo:")) : undefined;
  const [hintGone, setHintGone] = useState(() => {
    try {
      return localStorage.getItem("perzian.demoHint") === "1";
    } catch {
      return false;
    }
  });
  // Stay at the end as messages arrive, and land there again when coming back from a session.
  useEffect(() => {
    if (!hidden) end.current?.scrollIntoView({ block: "end" });
  }, [items.length, hidden]);
  const folder = leadProject?.split("/").filter(Boolean).slice(-1)[0];

  return (
    <main className="thread" hidden={hidden} aria-label="Perzian">
      <div className="thread-head drag">
        <h1 className="lead-h">Perzian</h1>
        <span className="grow" />
        {main?.status === "working" && <span className="thinking">thinking</span>}
        {main?.status === "paused" && <Paused s={main} send={send} />}
        {main && <ModelPicker s={main} state={state} send={send} />}
      </div>

      <div className="thread-scroll">
        {link === "refused" && <DaemonRefused />}
        {link === "offline" && (empty ? <DaemonOffline /> : <OfflineBanner />)}
        {firstRun}
        <ThreadItems items={items} state={state} onOpen={onOpen} retry={retry && main ? { index: retry.index, run: () => send({ type: "session.prompt", sessionId: main.id, prompt: retry.prompt }) } : undefined} />
        <div ref={end} />
      </div>

      <div className="dock">
        {demoNote && demoNote.kind === "notice" && !hintGone && (
          <p className="hint demo-hint">
            {demoNote.text}{" "}
            <button
              className="text-link"
              onClick={() => {
                setHintGone(true);
                try {
                  localStorage.setItem("perzian.demoHint", "1");
                } catch {
                  /* private mode */
                }
              }}
            >
              Dismiss
            </button>
          </p>
        )}
        <Composer
          id="main-composer"
          to="Perzian"
          placeholder={LEAD_PLACEHOLDER}
          focus={focus}
          busy={main?.status === "working"}
          blocked={main ? undefined : blocked}
          controls={<ModePicker value={state.settings.defaultMode} onChange={(mode) => send({ type: "settings.setDefaultMode", mode })} title="Permission mode new sessions start in" />}
          note={folder && (
            <span className="proj-chip" title={leadProject ?? undefined}>
              in <b>{folder}</b>
              <button type="button" className="icon" aria-label="Clear project" onClick={onProjectUsed}>✕</button>
            </span>
          )}
          onSubmit={(text) => {
            const prompt = leadProject ? withProject(text, leadProject) : text;
            if (leadProject) onProjectUsed();
            if (main) send({ type: "session.prompt", sessionId: main.id, prompt });
            else onStart(prompt);
          }}
          onStop={main ? () => send({ type: "session.cancel", sessionId: main.id }) : undefined}
        />
      </div>
    </main>
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
            // Daemon updates to the lead ("sessions finished") are plumbing: the session's own line above already shows it.
            return b.system ? null : <div key={i} className="msg user">{b.text}</div>;
          case "agent":
            return <div key={i} className="msg agent">{b.text}</div>;
          case "notice":
            if (isDemo && b.text.startsWith("Demo:")) return null;
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

function ToolStrip({ tools }: { tools: TranscriptItem[] }) {
  const failed = tools.filter((t) => t.kind === "tool" && t.status === "failed").length;
  const titles = tools.map((t) => (t.kind === "tool" ? t.title : "")).filter(Boolean).join("\n");
  return (
    <div className="toolstrip" title={titles}>
      {tools.length} action{tools.length === 1 ? "" : "s"}
      {failed > 0 && <span className="toolstrip-fail"> · {failed} failed</span>}
    </div>
  );
}

// "Paused · resumes 3:40 pm" and a way not to wait. No color: paused at a limit needs nothing from you.
function Paused({ s, send }: { s: SessionInfo; send: Send }) {
  useTick();
  return (
    <span className="paused" title={pauseTitle(s)}>
      <span className="status-text">{statusText(s)}</span>
      <button className="text-link" onClick={() => send({ type: "session.resume", sessionId: s.id })}>Resume now</button>
    </span>
  );
}

// A spawned session, inline in the conversation as one line, updating live. Branch, files and
// proof live in its detail view one click away.
function LiveCard({ s, state, onOpen }: { s: SessionInfo; state: State; onOpen: () => void }) {
  // The glyph (dot, check, ring) already says working and done; words stay where a dot is ambiguous: needs you, failed, paused, setup.
  const word = !(s.status === "done" || s.status === "idle" || (s.status === "working" && s.setup?.state !== "running"));
  // A session another session started: same rail and elbow as the crew column, indented.
  const nested = !!s.parentId && s.parentId !== "main" && state.sessions[s.parentId]?.role !== "main";
  const files = state.changes[s.id] ?? [];
  const { add, del } = churn(files);
  const detail = [s.branch, AGENTS[s.agent].label, files.length ? `${files.length} files +${add} −${del}` : ""].filter(Boolean).join(" · ");
  return (
    <button className={`live s-${s.status}${nested ? " nested" : ""}`} onClick={onOpen} title={detail}>
      <span className="live-arrow" aria-hidden>↳</span>
      <StatusGlyph s={s} />
      <span className="live-title">{s.title}</span>
      {word && <span key={statusText(s)} className="live-status" title={pauseTitle(s)}>{statusText(s)}</span>}
    </button>
  );
}

export { Ring };
