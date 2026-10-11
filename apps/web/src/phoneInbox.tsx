// The phone's layout (under 600px): first an inbox of everything that needs you across all sessions, answerable
// in place, then a compact crew summary. Tap or swipe a card to open its session. Everything here is a fold over
// the daemon's events (inbox() in the protocol); answers go out as the same decision.answer the Mac sends.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { byAttention, crewMatch, crewStatus, failureLine, inbox, isUnseen, type Command, type CrewKey, type Decision, type InboxItem, type SessionInfo, type State } from "@perzian/protocol";
import type { Link } from "./daemon.ts";
import { DecisionCard, StatusGlyph, ago, statusText, useTick } from "./bits.tsx";
import { Count, Slot, useExiting } from "./motion.tsx";

type Send = (c: Command) => void;

const projectName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const CREW_LABEL: Record<CrewKey, string> = { needs_you: "need you", failed: "failed", working: "working", paused: "paused", done: "done" };

/** The open session lives in history state, so the phone's back gesture returns to the inbox. */
function useOpenSession(): [string | null, (id: string | null) => void] {
  const read = () => (history.state as { perzianSession?: string } | null)?.perzianSession ?? null;
  const [open, setOpen] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setOpen(read());
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (id: string | null) => {
    if (id) {
      history.pushState({ perzianSession: id }, "");
      setOpen(id);
    } else if (read()) history.back();
    else setOpen(null);
  };
  return [open, go];
}

export function PhoneHome({ state, send, link, error }: { state: State; send: Send; link: Link; error?: string | null }) {
  useTick();
  const online = link === "online";
  const items = useMemo(() => inbox(state), [state.decisions, state.sessions, state.outcomes, state.transcripts]);
  const [open, go] = useOpenSession();
  const sel = open ? state.sessions[open] : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [open]);

  // Answers on their way (decision id -> option). A card with one stays disabled until the daemon resolves it, so a
  // double tap can't answer twice. Any link change forgets them: after a reconnect the snapshot says what's still open.
  const [sent, setSent] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setSent({});
  }, [link]);
  const answer = (d: Decision, optionId: string | null) => {
    if (!online || d.id in sent) return;
    setSent((m) => ({ ...m, [d.id]: optionId }));
    send({ type: "decision.answer", decisionId: d.id, optionId });
  };
  const dismiss = (sessionId: string) => online && send({ type: "session.seen", sessionId });
  const openSession = (id: string) => go(id);
  // An open session is seen: its failure or conflict leaves the inbox (as on the Mac), also when it lands while open.
  useEffect(() => {
    if (!sel || !online) return;
    const unseenConflict = sel.ship?.state === "conflict" && (sel.seenAt ?? 0) < sel.ship.at;
    if (isUnseen(sel) || unseenConflict) send({ type: "session.seen", sessionId: sel.id });
  }, [sel?.id, sel?.updatedAt, sel?.ship?.at, online]);
  const card = (item: InboxItem, swipe: boolean) => (
    <InboxCard key={item.key} item={item} state={state} online={online} sent={sent} onAnswer={answer} onDismiss={dismiss} onOpen={swipe ? openSession : undefined} />
  );

  return (
    <div className="phone" ref={scroller}>
      <header className="phone-head">
        {sel ? (
          <button className="btn phone-back" onClick={() => go(null)} aria-label="Back to inbox">
            ‹ Inbox
          </button>
        ) : (
          <span className="brand">
            <span className="mark" aria-hidden />
            Perzian
          </span>
        )}
        <span className={`conn ${online ? "on" : "off"}`} title={online ? "Connected" : "Can't reach your Mac"} />
      </header>
      {!online && (
        <div className="phone-reconnect" role="status">
          <span className="dot" />
          <span>
            {link === "connecting" ? "Connecting to your Mac…" : "Reconnecting to your Mac…"}
            <small>Answers wait until it's back.</small>
          </span>
        </div>
      )}
      {error && <p className="phone-err">{error}</p>}
      {sel ? (
        <PhoneSession s={sel} state={state} send={send} online={online} items={items.filter((i) => i.sessionId === sel.id)} card={(i) => card(i, false)} />
      ) : (
        <>
          <Inbox items={items} online={online} card={(i) => card(i, true)} />
          <CrewSummary state={state} onOpen={openSession} />
        </>
      )}
    </div>
  );
}

function Inbox({ items, online, card }: { items: InboxItem[]; online: boolean; card: (i: InboxItem) => ReactNode }) {
  const rows = useExiting(items, (i) => i.key);
  return (
    <section aria-label="Needs you" className="inbox">
      {items.length > 0 && (
        <h2 className="eyebrow s-needs_you">
          <span className="dot" /> Needs you <Count n={items.length} />
        </h2>
      )}
      <div className="needs-list">
        {rows.map(({ item, leaving }) => (
          <Slot key={item.key} id={item.key} leaving={leaving} className={item.kind === "failed" ? "s-failed" : "s-needs_you"}>
            {card(item)}
          </Slot>
        ))}
      </div>
      {/* Only say "nothing" when we know: offline, the list may be stale. */}
      {items.length === 0 && online && (
        <div className="inbox-empty">
          <svg className="chk" viewBox="0 0 12 12" width="16" height="16" aria-hidden>
            <path d="M2.4 6.3l2.3 2.3 4.9-5.2" />
          </svg>
          Nothing needs you
        </div>
      )}
    </section>
  );
}

function InboxCard({ item, state, online, sent, onAnswer, onDismiss, onOpen }: { item: InboxItem; state: State; online: boolean; sent: Record<string, string | null>; onAnswer: (d: Decision, optionId: string | null) => void; onDismiss: (sessionId: string) => void; onOpen?: (id: string) => void }) {
  const s = state.sessions[item.sessionId];
  const where = s ? projectName(s.project) : undefined;
  const open = onOpen ? () => onOpen(item.sessionId) : undefined;
  let body: ReactNode;
  if (item.kind === "decision") {
    const d = item.decision;
    const pending = d.id in sent;
    body = <DecisionCard d={d} session={s} where={where} onOpen={open} onAnswer={(o) => onAnswer(d, o)} disabled={!online || pending} chosen={pending ? (sent[d.id] ?? undefined) : undefined} />;
  } else {
    const what =
      item.kind === "conflict"
        ? `Merge${item.into ? ` into ${item.into}` : ""} hit conflicts${item.files.length ? ` in ${item.files.length} file${item.files.length === 1 ? "" : "s"}` : ""}`
        : item.why;
    body = (
      <article className={`decision inbox-${item.kind}`}>
        <header>
          <button className="decision-src" onClick={open} title="Open session">
            <span className="dot" />
            {s?.title ?? "Session"}
            {where && <span className="decision-where">{where}</span>}
          </button>
          <span className="age">{ago(item.at)}</span>
        </header>
        <p className="decision-q">{what}</p>
        <div className="options row">
          {open && (
            <button className="opt k-allow_once" onClick={open}>
              <span className="opt-label">Open</span>
            </button>
          )}
          <button className="opt" disabled={!online} onClick={() => onDismiss(item.sessionId)}>
            <span className="opt-label">Dismiss</span>
          </button>
        </div>
      </article>
    );
  }
  return open ? <Swipe onOpen={open}>{body}</Swipe> : body;
}

/** Swipe a card left to open its session; vertical drags still scroll. */
function Swipe({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useRef<{ x: number; y: number; dx: number; horiz?: boolean } | null>(null);
  const move = (dx: number, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? "transform 0.18s ease-out" : "none";
    el.style.transform = dx ? `translateX(${dx}px)` : "";
    el.parentElement?.style.setProperty("--swipe", String(Math.min(1, -dx / 70)));
  };
  return (
    <div className="swipe">
      <span className="swipe-hint" aria-hidden>
        Open ›
      </span>
      <div
        ref={ref}
        className="swipe-card"
        onTouchStart={(e) => (t.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 })}
        onTouchMove={(e) => {
          const c = t.current;
          if (!c) return;
          const dx = e.touches[0].clientX - c.x;
          const dy = e.touches[0].clientY - c.y;
          if (c.horiz === undefined && Math.hypot(dx, dy) > 8) c.horiz = Math.abs(dx) > Math.abs(dy) * 1.2;
          if (!c.horiz) return;
          c.dx = Math.min(0, dx);
          move(c.dx * 0.7, false);
        }}
        onTouchEnd={() => {
          const c = t.current;
          t.current = null;
          move(0, true);
          if (c?.horiz && c.dx < -80) onOpen();
        }}
        onTouchCancel={() => {
          t.current = null;
          move(0, true);
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Counts by state (tap one to narrow the list), then one row per session. */
function CrewSummary({ state, onOpen }: { state: State; onOpen: (id: string) => void }) {
  const workers = Object.values(state.sessions)
    .filter((s) => !s.archived && s.role === "worker")
    .sort(byAttention);
  const counts = crewStatus(workers);
  const [filter, setFilter] = useState<CrewKey | null>(null);
  const active = filter && counts.some((c) => c.key === filter) ? filter : null;
  const shown = active ? workers.filter((s) => crewMatch(active, s)) : workers;
  if (!workers.length) return null;
  return (
    <section aria-label="Crew" className="crew-sum">
      <h2 className="eyebrow">Crew</h2>
      {counts.length > 0 && (
        <div className="crew-counts" role="group" aria-label="Filter by state">
          {counts.map((c) => (
            <button key={c.key} className={`ccount s-${c.key} ${active === c.key ? "on" : ""}`} aria-pressed={active === c.key} onClick={() => setFilter(active === c.key ? null : c.key)}>
              <span className="dot" />
              <b>{c.count}</b> {CREW_LABEL[c.key]}
            </button>
          ))}
        </div>
      )}
      <div className="tiles">
        {shown.map((s) => {
          const files = (state.changes[s.id] ?? []).length;
          return (
            <button key={s.id} className={`tile s-${s.status}`} onClick={() => onOpen(s.id)}>
              <StatusGlyph s={s} />
              <span className="tile-main">
                <span className="tile-title">{s.title}</span>
                <span className="tile-sub">
                  {statusText(s)}
                  {s.progress && s.status === "working" ? ` · ${s.progress.phase} ${s.progress.step}/${s.progress.of}` : ""}
                  {files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""} · {projectName(s.project)}
                </span>
              </span>
              <span className="age">{ago(s.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** One session on the phone: what it's asking, why it stopped, what it did. Stop and resume; the rest is on the Mac. */
function PhoneSession({ s, state, send, online, items, card }: { s: SessionInfo; state: State; send: Send; online: boolean; items: InboxItem[]; card: (i: InboxItem) => ReactNode }) {
  const out = state.outcomes[s.id];
  const files = state.changes[s.id] ?? [];
  const transcript = state.transcripts[s.id] ?? [];
  let said: string | undefined;
  for (let i = transcript.length - 1; i >= 0 && !said; i--) {
    const t = transcript[i];
    if (t.kind === "agent") said = t.text;
  }
  const decisions = items.filter((i) => i.kind === "decision");
  const rows = useExiting(decisions, (i) => i.key);
  const failed = failedChecks(s);
  return (
    <>
      <section className="ps-head">
        <h1>{s.title}</h1>
        <span className="quiet">
          {projectName(s.project)}
          {s.branch ? ` · ${s.branch}` : ""}
        </span>
        <span className={`ps-status s-${s.status}`}>
          <StatusGlyph s={s} />
          {statusText(s)}
          {s.progress && s.status === "working" ? ` · ${s.progress.phase} ${s.progress.step}/${s.progress.of}` : ""}
        </span>
        {s.status === "failed" && <p className="ps-why">{failureLine(state, s)}</p>}
      </section>
      {rows.length > 0 && (
        <div className="needs-list">
          {rows.map(({ item, leaving }) => (
            <Slot key={item.key} id={item.key} leaving={leaving} className="s-needs_you">
              {card(item)}
            </Slot>
          ))}
        </div>
      )}
      {s.ship?.state === "conflict" && (
        <section>
          <h2 className="eyebrow s-needs_you">
            <span className="dot" /> Merge conflicts <b>{s.ship.files?.length ?? 0}</b>
          </h2>
          <ul className="ps-list">
            {(s.ship.files ?? []).map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {said && <p className="msg small ps-said">{said}</p>}
      {out && (
        <section>
          <h2 className="eyebrow">Outcome</h2>
          <p className="ps-intent">{out.intent}</p>
          {out.proof.length > 0 && (
            <ul className="ps-list">
              {out.proof.map((p, i) => (
                <li key={i} className={p.passed ? "" : "bad"}>
                  {p.passed ? "✓" : "✕"} {p.label}
                  {p.summary ? <span className="quiet"> · {p.summary}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {failed.length > 0 && (
        <section>
          <h2 className="eyebrow">Checks</h2>
          <ul className="ps-list">
            {failed.map((r) => (
              <li key={r.name} className="bad">
                ✕ {r.name}
                {r.summary ? <span className="quiet"> · {r.summary}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {files.length > 0 && (
        <section>
          <h2 className="eyebrow">
            Changes <b>{files.length}</b>
          </h2>
          <ul className="ps-list">
            {files.slice(0, 40).map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <span className="quiet">
                  +{f.additions} −{f.deletions}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="ps-actions">
        {(s.status === "working" || s.status === "needs_you") && (
          <button className="btn" disabled={!online} onClick={() => send({ type: "session.cancel", sessionId: s.id })}>
            Stop
          </button>
        )}
        {s.status === "paused" && (
          <button className="btn" disabled={!online} onClick={() => send({ type: "session.resume", sessionId: s.id })}>
            Resume now
          </button>
        )}
      </div>
      <p className="quiet ps-foot">Prompt, review and ship on your Mac.</p>
    </>
  );
}

const failedChecks = (s: SessionInfo) => (s.checkRun?.state === "failed" ? s.checkRun.results.filter((r) => r.state === "failed") : []);
