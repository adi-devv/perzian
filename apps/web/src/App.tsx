import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, isUnseen, pendingUsageCard, shownPrompt, shownStatus, type BranchList, type Command, type SessionInfo, type State, type TranscriptItem } from "@perzian/protocol";
import { isDemo, useBranches, useDaemon, useDoctor, type Link } from "./daemon.ts";
import { ProjectCard } from "./askproject.tsx";
import { Welcome } from "./welcome.tsx";
import { Accounts, FolderPicker, recentProjects, DaemonOffline, DaemonRefused, FailureNotice, OfflineBanner, Onboarding, ShortcutHelp, friendlyError, isFailureNotice, loadProject, parseFolders, readiness, saveProject, withProject } from "./onboarding.tsx";
import { PairScreen, PhoneHome, useNarrow } from "./phone.tsx";
import { BasePicker, Composer, DecisionLine, LEAD_PLACEHOLDER, ModePicker, ModelPicker, Ring, StatusGlyph, churn, pauseTitle, retryTarget, statusText, useTick } from "./bits.tsx";
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
  // The welcome splash: on startup while "Show on startup" is on (a beat after connecting, so the saved setting has arrived),
  // and any time from the ⋯ menu.
  const [welcome, setWelcome] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [splashReady, setSplashReady] = useState(false);
  useEffect(() => {
    if (!link || link !== "online") return;
    const t = setTimeout(() => setSplashReady(true), 400);
    return () => clearTimeout(t);
  }, [link]);

  const all = Object.values(state.sessions).filter((s) => !s.archived);
  const main = all.find((s) => s.role === "main");
  // First run: connected, nothing started yet. The demo always has sessions, so it never lands here.
  const firstRun = !isDemo && link === "online" && all.length === 0;
  const recent = useMemo(() => recentProjects(state), [state.sessions]);
  // First run needs no project: chat starts right away. A project chip is only a hint for the lead's first message.
  const doctor = useDoctor(leadProject ?? "", firstRun);
  const gate = firstRun ? readiness(doctor.report) : { ready: true, blocker: "" };
  // The branch new sessions start from ("" = the repo's default), picked beside the composer. Only a non-default one is sent.
  const [base, setBase] = useState("");
  const baseProject = leadProject;
  const branches = useBranches(baseProject);
  useEffect(() => setBase(""), [baseProject]);
  const baseArg = base && base !== branches?.default && branches?.branches.includes(base) ? base : undefined;
  const startLead = (prompt: string) => {
    if (!gate.ready) return;
    send({ type: "main.start", prompt });
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
  const showWelcome = !isDemo && !narrow && (welcome || (splashReady && state.settings.splash && !splashDone));
  const closeWelcome = () => {
    setWelcome(false);
    setSplashDone(true);
    open(null);
    focusLead();
  };
  const modal = help || accounts || adding || showWelcome;

  // Keyboard: ⌘1 / Esc Perzian · ↑/↓ move between tiles, Enter opens · 1-9 answer a decision · / focus the input · ? help
  useEffect(() => {
    const card = pendingUsageCard(state);
    const onKey = (e: KeyboardEvent) => {
      const el =e.target instanceof Element ? e.target : null;
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
      // An empty composer still lets 1-9 answer the card on screen (focus stays in it after sending); with text in it, digits type.
      const emptyComposer = el instanceof HTMLTextAreaElement && el.closest(".composer") && !el.value;
      if (typing && !(emptyComposer && /^[1-9]$/.test(e.key) && (answerable() || card))) return;
      if (e.metaKey || e.ctrlKey || e.altKey || modal) return;
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
        const shown = answerable();
        // The account usage card takes 1 (Pause) / 2 (Keep going) when no session's own call is on screen.
        if (!shown && card && (e.key === "1" || e.key === "2")) {
          e.preventDefault();
          send({ type: "usage.answer", key: card.key, choice: e.key === "1" ? "pause" : "keep_going" });
          return;
        }
        const opt = shown?.options[Number(e.key) - 1];
        if (!shown || !opt) return;
        e.preventDefault();
        send({ type: "decision.answer", decisionId: shown.id, optionId: opt.id });
      }
    };
    // In a session: its own oldest call. Otherwise the call on the topmost tile that is asking.
    const answerable = () => {
      const owner = selected ?? document.querySelector<HTMLElement>("[data-tile]:has(.t-ask)")?.dataset.tile;
      return decisions.find((d) => d.sessionId === owner);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decisions, selected, help, adding, accounts, mainItems.length, state.usageCards]);

  // A phone that isn't paired yet, or any window under 600px: the attention queue, nothing else.
  if (link === "unpaired") return <PairScreen />;
  if (narrow) return <PhoneHome state={state} send={send} link={link} error={error} />;

  return (
    <div className="app">
      <Crew state={state} workers={workers} selected={sel?.id ?? null} onOpen={open} send={send} connected={connected} onAddProject={() => setAdding(true)} onImport={() => send({ type: "sessions.import" })} onHelp={() => setHelp(true)} onAccounts={() => setAccounts(true)} onUseProject={startInFolder} onWelcome={() => setWelcome(true)} />

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
          focus={firstRun && !showWelcome}
          firstRun={firstRun ? <Onboarding doctor={doctor} project={leadProject ?? ""} /> : null}
          chips={firstRun ? recent : []}
          onChip={startInFolder}
          leadProject={leadProject}
          onProjectUsed={() => setLeadProject(null)}
          branches={branches}
          base={base}
          onBase={setBase}
          baseArg={baseArg}
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
      {showWelcome && <Welcome state={state} send={send} recent={recent} onUseProject={(p) => { setLeadProject(p); closeWelcome(); }} onStart={closeWelcome} />}
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

function Thread({ hidden, state, main, send, onOpen, link, onStart, blocked, focus, firstRun, chips, onChip, leadProject, onProjectUsed, branches, base, onBase, baseArg }: { hidden: boolean; state: State; main?: SessionInfo; send: Send; onOpen: (id: string) => void; link: Link; onStart: (prompt: string) => void; blocked?: string; focus?: boolean; firstRun: React.ReactNode; chips: string[]; onChip: (path: string) => void; leadProject: string | null; onProjectUsed: () => void; branches: BranchList | null; base: string; onBase: (b: string) => void; baseArg?: string }) {
  const items = main ? (state.transcripts[main.id] ?? []) : [];
  const empty = Object.keys(state.sessions).length === 0;
  const retry = main ? retryTarget(items, main.status) : null;
  const [extras, setExtras] = useState("");
  const end =useRef<HTMLDivElement>(null);
  // The demo's "this is scripted" notices are a dismissible hint above the composer, not a line in the stream.
  const demoNote = isDemo ? [...items].reverse().find((i) => i.kind === "notice" && i.text.startsWith("Demo:")) : undefined;
  const [hintGone, setHintGone] = useState(() => {
    try {
      return localStorage.getItem("perzian.demoHint") === "1";
    } catch {
      return false;
    }
  });
  // The lead's open "Which project?" card (ask_project).
  const ask = main ? Object.values(state.decisions).filter((d) => d.sessionId === main.id && d.source === "ask_project").sort((a, b) => a.createdAt - b.createdAt)[0] : undefined;
  // Stay at the end as messages arrive, and land there again when coming back from a session.
  useEffect(() => {
    if (!hidden) end.current?.scrollIntoView({ block: "end" });
  }, [items.length, hidden, ask?.id]);
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
        {ask && <ProjectCard key={ask.id} d={ask} send={send} />}
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
          note={(folder || branches) && (
            <>
              {folder && (
                <span className="proj-chip" title={leadProject ?? undefined}>
                  in <b>{folder}</b>
                  <button type="button" className="icon" aria-label="Clear project" onClick={onProjectUsed}>✕</button>
                </span>
              )}
              {branches && <BasePicker list={branches} value={base} onChange={onBase} state={state} />}
              {folder && (
                <input
                  className="extra-dirs"
                  value={extras}
                  onChange={(e) => setExtras(e.target.value)}
                  placeholder="Also edit: ~/other-repo, …"
                  aria-label="Extra folders the sessions may also edit"
                  spellCheck={false}
                />
              )}
            </>
          )}
          onSubmit={(text) => {
            const prompt = leadProject ? withProject(text, leadProject, parseFolders(extras), baseArg) : text;
            if (leadProject) {
              onProjectUsed();
              setExtras("");
            }
            if (main) send({ type: "session.prompt", sessionId: main.id, prompt });
            else onStart(prompt);
          }}
          onStop={main ? () => send({ type: "session.cancel", sessionId: main.id }) : undefined}
        />
        {chips.length > 0 && !main && (
          <div className="folder-recent chips" aria-label="Recent projects">
            {chips.map((p) => (
              <button key={p} type="button" className={`btn small${p === leadProject ? " on" : ""}`} title={p} onClick={() => onChip(p)}>
                {p.split("/").filter(Boolean).slice(-1)[0] ?? p}
              </button>
            ))}
          </div>
        )}
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
            return b.system ? null : <div key={i} className="msg user">{shownPrompt(b.text)}</div>;
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
          case "decision":
            return <DecisionLine key={i} item={b} />;
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
  const status = shownStatus(s);
  const word = !(status === "done" || status === "idle" || (status === "working" && s.setup?.state !== "running"));
  // A session another session started: same rail and elbow as the crew column, indented.
  const nested = !!s.parentId && s.parentId !== "main" && state.sessions[s.parentId]?.role !== "main";
  const files = state.changes[s.id] ?? [];
  const { add, del } = churn(files);
  const detail = [s.branch, AGENTS[s.agent].label, files.length ? `${files.length} files +${add} −${del}` : ""].filter(Boolean).join(" · ");
  return (
    <button className={`live s-${status}${nested ? " nested" : ""}`} onClick={onOpen} title={detail}>
      <span className="live-arrow" aria-hidden>↳</span>
      <StatusGlyph s={s} />
      <span className="live-title">{s.title}</span>
      {word && <span key={statusText(s)} className="live-status" title={pauseTitle(s)}>{statusText(s)}</span>}
    </button>
  );
}

export { Ring };
