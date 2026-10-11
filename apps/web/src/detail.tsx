import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AGENTS, checkPlan, shownPrompt, shownStatus, type Command, type FileChange, type Outcome, type SessionInfo, type State, type Subagent, type TranscriptItem } from "@perzian/protocol";
import type { ThemedToken } from "shiki/core";
import { fetchText } from "./daemon.ts";
import { FailureNotice } from "./onboarding.tsx";
import { tokenize } from "./highlight.ts";
import { Slot, useExiting } from "./motion.tsx";
import { RepoMap } from "./repomap.tsx";
import { Attached, Composer, ContextRing, UsageLine } from "./composer.tsx";
import { DecisionCard, DecisionLine, gitChip, ModePicker, ModelPicker, StatusGlyph, Usage, ago, churn, prSummary, retryTarget, stackedOn, statusText } from "./bits.tsx";

type Send = (c: Command) => void;
type Tab = "changes" | "map" | "checks" | "transcript";

const TABS: [Tab, string][] = [["changes", "Changes"], ["map", "Map"], ["checks", "Checks"], ["transcript", "Transcript"]];
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const secs = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)}s`);

/** Done opens on what changed, failed on why, the rest on what's happening. */
function defaultTab(s: SessionInfo, files: number): Tab {
  if (s.status === "done") return "changes";
  if (s.status === "failed") return "checks";
  return files ? "changes" : "transcript";
}

/* ───────────── Session detail: the whole center column for one session ───────────── */

export function SessionDetail({ s, state, send, onBack, onOpen, leadNew }: { s: SessionInfo; state: State; send: Send; onBack: () => void; onOpen: (id: string) => void; leadNew: number }) {
  const parent = s.parentId && s.parentId !== "main" ? state.sessions[s.parentId] : undefined;
  const files = state.changes[s.id] ?? [];
  const outcome = state.outcomes[s.id];
  const transcript = state.transcripts[s.id] ?? [];
  const [tab, setTab] = useState<Tab>(() => defaultTab(s, files.length));
  const [file, setFile] = useState<string | null>(null);
  const pending = useExiting(Object.values(state.decisions).filter((d) => d.sessionId === s.id).sort((a, b) => a.createdAt - b.createdAt), (d) => d.id);
  const closed = !!s.worktree && s.ship?.state === "merged";
  const retry = closed ? null : retryTarget(transcript, s.status);
  const failure = retry ? transcript[retry.index] : undefined;
  const failedChecks = (s.checkRun?.results ?? []).filter((r) => r.state === "failed");

  // The transcript sticks to the bottom while you're at the bottom; scrolled up, it stays where you are.
  const body = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (tab === "transcript" && el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [tab, transcript.length]);
  const pick = (t: Tab) => {
    stuck.current = true;
    setTab(t);
  };

  const fix = () =>
    send({
      type: "session.prompt",
      sessionId: s.id,
      prompt: failedChecks.length
        ? `These required checks fail: ${failedChecks.map((r) => `${r.name} (\`${r.run}\`)`).join(", ")}. Find the cause and fix it, then run them again.`
        : (retry?.prompt && `The last run failed. Find the cause, fix it, and run the checks again. The task was: ${retry.prompt}`) || "The last run failed. Find the cause, fix it, and run the checks again.",
    });
  const review = () => {
    pick("changes");
    setTimeout(() => document.getElementById("ship-primary")?.focus({ preventScroll: false }), 0);
  };
  const shippable = !!s.worktree && !!s.branch;
  let primary: React.ReactNode = null;
  if (s.status === "failed") primary = <button className="btn primary" onClick={fix}>Ask agent to fix</button>;
  else if (s.status === "done" && files.length > 0 && s.ship?.state !== "merged" && s.ship?.state !== "pr")
    primary = <button className="btn primary" onClick={review}>{shippable ? "Review & ship" : "Review changes"}</button>;
  else if (s.status === "paused") primary = <button className="btn primary" onClick={() => send({ type: "session.resume", sessionId: s.id })}>Resume now</button>;

  return (
    <section className="detail" aria-label={`Session: ${s.title}`}>
      <header className="d-head">
        <div className="d-row">
          <button className="btn back" onClick={onBack} title="Back to Perzian (Esc)">
            ← Perzian
            {leadNew > 0 && <span className="badge" role="status" aria-label={`${leadNew} new from Perzian`}>{leadNew}</span>}
          </button>
          <span className={`stpill s-${shownStatus(s)}`}>
            <StatusGlyph s={s} />
            <span key={statusText(s)} className="status-text">{statusText(s)}</span>
          </span>
          {s.branch && <code className="meta branch" title={s.cwd}>{s.worktree ? "⎇ " : ""}{s.branch}</code>}
          <span className="sp" />
          {primary}
        </div>
        <h2 className="d-title">
          {parent && (
            <>
              <button className="crumb" onClick={() => onOpen(parent.id)} title="The session that started this one">{parent.title}</button>
              <span className="crumb-sep" aria-hidden>›</span>
            </>
          )}
          {s.title}
        </h2>
        <div className="d-sub">
          <span title={AGENTS[s.agent].experimental ? "Experimental: less tested than Claude Code" : undefined}>{AGENTS[s.agent].label}</span>
          <Usage s={s} />
          <span className="sp" />
          <ArchiveButton s={s} files={files.length} send={send} onDone={onBack} />
        </div>

        <Facts s={s} state={state} send={send} onOpen={onOpen} quietOutside={pending.some((p) => p.item.outside?.length)} />
        <SetupBar s={s} send={send} />
        {retry && failure?.kind === "notice" && <FailureNotice text={failure.text} onRetry={() => send({ type: "session.prompt", sessionId: s.id, prompt: retry.prompt })} />}
        {pending.length > 0 && (
          <div className="d-needs" aria-label="Needs you">
            {pending.map(({ item: d, leaving }) => (
              <Slot key={d.id} id={d.id} leaving={leaving}>
                <DecisionCard d={d} session={s} onAnswer={(optionId) => send({ type: "decision.answer", decisionId: d.id, optionId })} />
              </Slot>
            ))}
          </div>
        )}

        <div className="dtabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "on" : ""}`} onClick={() => pick(t)}>
              {label}
              {t === "changes" && files.length > 0 && <em className="n">{files.length}</em>}
              {t === "checks" && failedChecks.length > 0 && <em className="n bad">{failedChecks.length}</em>}
            </button>
          ))}
        </div>
      </header>

      <div className="d-body" ref={body} onScroll={() => { const el = body.current; if (el && tab === "transcript") stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {tab === "changes" && <ChangesTab s={s} files={files} outcome={outcome} state={state} send={send} file={file} onFile={setFile} closed={closed} />}
        {tab === "map" && <MapTab s={s} state={state} onFile={(p) => { setFile(p); pick("changes"); }} onOpen={onOpen} />}
        {tab === "checks" && <ChecksTab s={s} outcome={outcome} send={send} fix={fix} />}
        {tab === "transcript" && <TranscriptTab items={transcript} state={state} subagents={s.subagents ?? []} />}
      </div>

      <div className="d-foot">
        {closed ? (
          <p className="closed-note">This session is closed. Ask Perzian to start a new one to keep going.</p>
        ) : (
          <Composer
            id="session-composer"
            to={s.title}
            placeholder={`Tell ${s.title}…`}
            busy={s.status === "working"}
            commands={s.commands}
            above={<UsageLine state={state} send={send} />}
            left={<ModePicker value={s.mode ?? "ask"} onChange={(mode) => send({ type: "session.setMode", sessionId: s.id, mode })} />}
            right={<ModelPicker s={s} state={state} send={send} />}
            ring={<ContextRing s={s} state={state} send={send} />}
            onSubmit={(text, attachments) => send({ type: "session.prompt", sessionId: s.id, prompt: text, ...(attachments.length ? { attachments } : {}) })}
            onStop={() => send({ type: "session.cancel", sessionId: s.id })}
          />
        )}
      </div>
    </section>
  );
}

/* ───────────── Facts the daemon observed: what the agent did on its own ───────────── */

function Facts({ s, state, send, onOpen, quietOutside }: { s: SessionInfo; state: State; send: Send; onOpen: (id: string) => void; quietOutside?: boolean }) {
  const wt = s.extraWorktrees ?? [];
  const sub = s.subagents ?? [];
  const outside = quietOutside ? [] : (s.outsidePaths ?? []);
  const bg = (s.background ?? []).filter((b) => !b.ended);
  const dirs = s.extraDirs ?? [];
  const g = gitChip(s);
  const parent = stackedOn(s, state);
  const behind = s.worktree && s.ship?.state !== "merged" ? (s.git?.behind ?? 0) : 0;
  const pr = s.git?.pr;
  if (!wt.length && !sub.length && !outside.length && !bg.length && !dirs.length && !g && !parent && !behind && !pr) return null;
  return (
    <dl className="d-facts">
      {(parent || behind > 0) && (
        <div>
          <dt>Base</dt>
          <dd className="fact-base">
            {parent ? <button className="crumb" onClick={() => onOpen(parent.id)} title="The session whose branch this one started from">on {parent.title}</button> : <code>{s.baseBranch}</code>}
            {behind > 0 && (
              <span className="fact-line">
                <span title={`${s.baseBranch} has commits this branch doesn't have yet`}>Base moved · {behind} behind</span>
                <button className="btn small" disabled={s.status === "working"} title={s.status === "working" ? "Wait for the agent to finish" : `Ask the agent to merge or rebase ${s.baseBranch} into this branch`} onClick={() => send({ type: "session.updateBase", sessionId: s.id })}>
                  Update
                </button>
              </span>
            )}
          </dd>
        </div>
      )}
      {pr && (
        <div>
          <dt>Pull request</dt>
          <dd>
            <span className={`fact-line${pr.checks === "failing" ? " bad" : ""}`}>
              <a href={pr.url} target="_blank" rel="noopener">{prSummary(s)} ↗</a>
              {pr.checks === "failing" && pr.failing.map((n) => <code key={n}>{n}</code>)}
              {pr.checks === "failing" && (
                <button className="btn small" disabled={s.status === "working"} title="Sends the agent the failing check names and how to read their logs" onClick={() => send({ type: "session.fixCi", sessionId: s.id })}>
                  Ask agent to fix CI
                </button>
              )}
            </span>
          </dd>
        </div>
      )}
      {g && (
        <div>
          <dt>Git</dt>
          <dd>
            {g.label}
            {g.label && g.url ? " · " : ""}
            {g.url && <a href={g.url} target="_blank" rel="noopener">PR ↗</a>}
          </dd>
        </div>
      )}
      {bg.length > 0 && (
        <div>
          <dt>Running</dt>
          <dd>
            {bg.map((b) => (
              <span key={b.id} className="mchip">
                {b.port ? <a href={`http://localhost:${b.port}`} target="_blank" rel="noopener">▶ {b.command} :{b.port}</a> : <>▶ {b.command}</>}
              </span>
            ))}
          </dd>
        </div>
      )}
      {dirs.length > 0 && (
        <div>
          <dt>Also allowed</dt>
          <dd>{dirs.map((d) => <code key={d} title={d}>{d}</code>)}</dd>
        </div>
      )}
      {wt.length > 0 && (
        <div>
          <dt>{wt.length === 1 ? "Extra worktree" : "Extra worktrees"}</dt>
          <dd>
            {wt.map((w) => (
              <span key={w.path} className="fact-line">
                <code title={w.path}>{w.path}</code>
                {w.branch && <span>⎇ {w.branch}</span>}
                {w.changed !== undefined && <span>{w.changed} changed</span>}
              </span>
            ))}
          </dd>
        </div>
      )}
      {outside.length > 0 && (
        <div>
          <dt>Outside project</dt>
          <dd>{outside.map((p) => <code key={p} title={p}>{p}</code>)}</dd>
        </div>
      )}
      {sub.length > 0 && (
        <div>
          <dt>{sub.length === 1 ? "Subagent" : "Subagents"}</dt>
          <dd>
            {sub.map((x) => (
              <span key={x.id} className="fact-line">
                <span className={`sa-dot ${x.status}`} aria-hidden />
                <span title={x.status}>{x.description}</span>
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

/* ───────────── Changes: the review flow ───────────── */

function ChangesTab({ s, files, outcome, state, send, file, onFile, closed }: { s: SessionInfo; files: FileChange[]; outcome?: Outcome; state: State; send: Send; file: string | null; onFile: (p: string | null) => void; closed: boolean }) {
  const { add, del } = churn(files);
  const cur = files.find((f) => f.path === file) ?? files[0];
  return (
    <div className="changes">
      <ShipBar s={s} files={files.length} send={send} />
      <div className="cg">
        <div className="g-files">
          <h3 className="h3">
            Changed files
            {files.length > 0 && (
              <span className="stat">
                <em className="a">+{add}</em> <em className="d">−{del}</em>
              </span>
            )}
          </h3>
          {files.length === 0 && <p className="empty">{s.status === "working" ? "No file changes yet. Edits show up here as they happen." : s.status === "done" ? "Finished without changing files." : "No files changed."}</p>}
          <div className="flist">
            {files.map((f) => (
              <button key={f.path} className={`btn frow c-${f.kind} ${cur?.path === f.path ? "on" : ""}`} onClick={() => onFile(f.path)} title={f.path} aria-pressed={cur?.path === f.path}>
                <span className="fn">
                  <span className="fname">{name(f.path)}</span>
                  <span className="fdir">{dir(f.path)}</span>
                </span>
                <span className="pm">
                  <em className="a">+{f.additions}</em> <em className="d">−{f.deletions}</em>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="g-diff">{cur ? <CodeView session={s.id} path={cur.path} rev={`${cur.additions}:${cur.deletions}:${cur.kind}`} /> : <p className="empty">Pick a file to see its diff.</p>}</div>
        <div className="g-proof">
          <Proof s={s} outcome={outcome} send={send} state={state} closed={closed} />
        </div>
      </div>
    </div>
  );
}

/** Checks (command and duration each) and the outcome, side by side with the diff. */
function Proof({ s, outcome, send, closed }: { s: SessionInfo; outcome?: Outcome; send: Send; state: State; closed: boolean }) {
  const rows = proofRows(s, outcome);
  return (
    <div className="proof">
      <div>
        <h3 className="h3">Proof</h3>
        {rows.length ? <ProofList rows={rows} compact /> : <p className="quiet small">{s.status === "working" ? "Checks run when the agent finishes." : "No checks ran."}</p>}
      </div>
      <div>
        <h3 className="h3">
          Outcome
          {outcome?.derived && <span className="tag" title="The agent didn't report an outcome; built from git">auto</span>}
          {outcome?.status === "unverified" && <span className="tag" title="No checks ran, so nothing confirms it works">not verified</span>}
        </h3>
        {outcome ? (
          <>
            <p className="outcome-intent">{outcome.intent}</p>
            {outcome.risks.map((r, i) => <p key={i} className="risk">⚠ {r}</p>)}
            {outcome.followups.length > 0 && !closed && (
              <div className="followups">
                {outcome.followups.map((f, i) => (
                  <button key={i} className="followup" onClick={() => send({ type: "session.prompt", sessionId: s.id, prompt: f })} title="Send to this session as the next task">
                    <span>{f}</span>
                    <span className="followup-go">Send →</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="quiet small">{s.status === "failed" ? "None. The agent stopped before reporting one." : s.status === "done" ? "The agent didn't report an outcome." : "Lands here when the agent finishes."}</p>
        )}
      </div>
    </div>
  );
}

/* ───────────── Proof rows: declared checks plus what the agent reported ───────────── */

type Row = { key: string; name: string; cmd?: string; state: "passed" | "failed" | "running" | "pending"; meta?: string; du?: string; tail?: string; claimed?: boolean };

function proofRows(s: SessionInfo, o?: Outcome): Row[] {
  const byName = new Map((s.checkRun?.results ?? []).map((r) => [r.name, r]));
  const rows: Row[] = checkPlan(s).map((c) => {
    const r = byName.get(c.name);
    return { key: `c:${c.name}`, name: c.name, cmd: c.run, state: r?.state ?? "pending", meta: r?.summary ?? (r?.timedOut ? "timed out" : r?.state === "failed" && r.exitCode !== undefined ? `exit ${r.exitCode}` : undefined), du: secs(r?.durationMs), tail: r?.state === "failed" ? r.tail : undefined };
  });
  const have = new Set(rows.map((r) => r.cmd));
  (o?.proof ?? []).forEach((p, i) => {
    if (p.command && have.has(p.command)) return;
    rows.push({ key: `p:${i}`, name: p.label, cmd: p.command, state: p.passed ? "passed" : "failed", meta: p.summary, du: secs(p.durationMs), tail: p.passed ? undefined : p.detail, claimed: !p.observed });
  });
  return rows;
}

function ProofList({ rows, compact }: { rows: Row[]; compact?: boolean }) {
  return (
    <ul className={`chk-list ${compact ? "compact" : ""}`}>
      {rows.map((r) => (
        <li key={r.key} className={`chk ck-${r.state}`}>
          <span className="cm" aria-label={r.state}>{r.state === "passed" ? "✓" : r.state === "failed" ? "✕" : r.state === "running" ? "◌" : "·"}</span>
          <div className="nm">
            <b>
              {r.name}
              {r.meta && <span className="sm"> · {r.meta}</span>}
              {r.claimed && <em className="claim">claimed</em>}
            </b>
            {r.cmd && <code>{r.cmd}</code>}
          </div>
          {r.du && <span className="du">{r.du}</span>}
          {r.tail && <pre className="check-tail">{r.tail}</pre>}
        </li>
      ))}
    </ul>
  );
}

/* ───────────── Map: a treemap of the repo's real files, shaded by churn, sessions as dots (repomap.tsx) ───────────── */

function MapTab({ s, state, onFile, onOpen }: { s: SessionInfo; state: State; onFile: (p: string) => void; onOpen: (id: string) => void }) {
  const tools = (state.transcripts[s.id] ?? []).filter((t) => t.kind === "tool");
  return (
    <div className="map-tab">
      <RepoMap s={s} state={state} onFile={onFile} onOpen={onOpen} />
      <h3 className="h3 act-h">Activity</h3>
      <div className="activity">
        {tools.map((t) => t.kind === "tool" && <span key={t.toolCallId} className={`act k-${t.toolKind ?? "other"} st-${t.status}`} title={`${t.toolKind ?? "tool"}: ${t.title}`} />)}
        {tools.length === 0 && <span className="quiet small">Nothing yet</span>}
      </div>
      <div className="legend">
        <span><i className="act k-read" /> read</span>
        <span><i className="act k-edit" /> edit</span>
        <span><i className="act k-execute" /> run</span>
        <span><i className="act st-failed" /> failed</span>
      </div>
    </div>
  );
}

/* ───────────── Checks ───────────── */

function ChecksTab({ s, outcome, send, fix }: { s: SessionInfo; outcome?: Outcome; send: Send; fix: () => void }) {
  const rows = proofRows(s, outcome);
  const run = s.checkRun;
  const failed = (run?.results ?? []).some((r) => r.state === "failed") || rows.some((r) => r.state === "failed");
  return (
    <div className="pane">
      {/* A broken perzian.json means its checks don't run, even when detected ones still do: always say so. */}
      {s.checksError && <p className="checks-error">✕ {s.checksError}. Declared checks won't run until it's fixed.</p>}
      {rows.length ? <ProofList rows={rows} /> : <p className="empty">No checks for this project. Add them to perzian.json and they run when the agent finishes.</p>}
      <div className="row-btns">
        {checkPlan(s).length > 0 && (
          <button className="btn" disabled={run?.state === "running" || s.status === "working"} onClick={() => send({ type: "session.runChecks", sessionId: s.id })}>
            {run?.state === "running" ? "Running…" : "Run checks"}
          </button>
        )}
        {failed && s.status !== "working" && <button className="btn primary" onClick={fix}>Ask agent to fix</button>}
        {run && <span className="quiet small">{run.state === "fixing" ? `Sent back to the agent · fix ${run.attempt} of ${run.maxAttempts}` : run.state === "failed" ? `Still failing after ${run.maxAttempts} fixes` : run.state === "passed" ? "All pass" : run.state === "running" ? "Running" : "Stopped"} · {ago(run.at)}</span>}
      </div>
    </div>
  );
}

/* ───────────── Transcript: messages in a column; tool calls fold into one line each run ───────────── */

function TranscriptTab({ items, state, subagents }: { items: TranscriptItem[]; state: State; subagents: Subagent[] }) {
  const { blocks, kids } = useMemo(() => {
    // Calls that ran inside a subagent nest under the call that started it instead of sitting in the flow.
    const ids = new Set(items.flatMap((i) => (i.kind === "tool" ? [i.toolCallId] : [])));
    const kids = new Map<string, TranscriptItem[]>();
    const out: (TranscriptItem | TranscriptItem[])[] = [];
    for (const it of items) {
      if (it.kind === "tool" && it.parentToolCallId && ids.has(it.parentToolCallId)) {
        kids.set(it.parentToolCallId, [...(kids.get(it.parentToolCallId) ?? []), it]);
        continue;
      }
      const last = out[out.length - 1];
      if (it.kind === "tool" && Array.isArray(last)) last.push(it);
      else out.push(it.kind === "tool" ? [it] : it);
    }
    return { blocks: out, kids };
  }, [items]);
  if (!items.length) return <p className="empty">Nothing yet. What this session says and does shows up here.</p>;
  return (
    <ol className="tr">
      {blocks.map((b, i) => {
        if (Array.isArray(b)) return <li key={i} className="tr-item"><ToolGroup tools={b} kids={kids} subagents={subagents} /></li>;
        const at = new Date(b.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        switch (b.kind) {
          case "user":
            return <li key={i} className={`tr-item tr-user ${b.system ? "sys" : ""}`} title={at}><div className="bub"><Attached items={b.attachments} />{shownPrompt(b.text)}</div></li>;
          case "agent":
            return <li key={i} className="tr-item tr-agent" title={at}>{b.text}</li>;
          case "spawn":
            return <li key={i} className="tr-item tr-note">↳ started {state.sessions[b.childId]?.title ?? b.title}</li>;
          case "notice":
            return <li key={i} className="tr-item tr-note" title={at}>{b.text}</li>;
          case "decision":
            return <li key={i} className="tr-item" title={at}><DecisionLine item={b} /></li>;
          default:
            return null;
        }
      })}
    </ol>
  );
}

// A run of tool calls is one collapsed line ("5 actions · 1 failed"); open it to read each call, one per row.
// A subagent's own calls are indented under the call that started it.
function ToolGroup({ tools, kids, subagents }: { tools: TranscriptItem[]; kids: Map<string, TranscriptItem[]>; subagents: Subagent[] }) {
  const all = tools.flatMap((t) => (t.kind === "tool" ? [t, ...(kids.get(t.toolCallId) ?? [])] : []));
  const failed = all.filter((t) => t.kind === "tool" && t.status === "failed").length;
  return (
    <details className="tools">
      <summary>
        <span className="caret" aria-hidden>▸</span>
        {all.length} action{all.length === 1 ? "" : "s"}
        {failed > 0 && <span className="toolstrip-fail"> · {failed} failed</span>}
      </summary>
      <ul>
        {tools.map((t) => {
          if (t.kind !== "tool") return null;
          const inner = kids.get(t.toolCallId);
          const sa = subagents.find((x) => x.id === t.toolCallId);
          return (
            <Fragment key={t.toolCallId}>
              <li className={`st-${t.status}`}>
                <b>{inner || sa ? "subagent" : (t.toolKind ?? "tool")}</b>
                <span>
                  {t.title}
                  {sa && sa.status !== "done" ? ` · ${sa.status}` : ""}
                </span>
              </li>
              {inner?.map((c) =>
                c.kind === "tool" ? (
                  <li key={c.toolCallId} className={`st-${c.status} nested`}>
                    <b>{c.toolKind ?? "tool"}</b>
                    <span>{c.title}</span>
                  </li>
                ) : null,
              )}
            </Fragment>
          );
        })}
      </ul>
    </details>
  );
}

/* ───────────── Read-only code: a diff (default) or the whole file ───────────── */

function CodeView({ session, path, rev }: { session: string; path: string; rev: string }) {
  const [tab, setTab] = useState<"diff" | "file">("diff");
  const key = `${tab}:${session}:${path}`;
  const [loaded, setLoaded] = useState<{ key: string; text: string } | null>(null);
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);
  const [tokens, setTokens] = useState<Map<number, ThemedToken[]> | null>(null);
  useEffect(() => {
    let live = true;
    fetchText(tab, session, path).then(
      (text) => live && (setErr(null), setLoaded({ key, text })),
      (e) => live && setErr({ key, msg: String(e.message ?? e) }),
    );
    return () => {
      live = false;
    };
  }, [key, rev]);

  const text = loaded?.key === key ? loaded.text : null;
  const diff = tab === "diff";
  const lines = useMemo(() => (text ?? "").replace(/\n$/, "").split("\n"), [text]);
  const kinds = useMemo(() => lines.map((l) => classify(l, diff)), [lines, diff]);

  // Highlight only code lines; in a diff, strip the +/-/space prefix first and map tokens back by index.
  useEffect(() => {
    setTokens(null);
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
    <div className="codeview">
      <div className="cv-head">
        <code title={path}>{path}</code>
        <span className="tag">read-only</span>
        <div className="seg" role="group" aria-label="View">
          <button className={`btn small ${tab === "diff" ? "on" : ""}`} onClick={() => setTab("diff")}>Diff</button>
          <button className={`btn small ${tab === "file" ? "on" : ""}`} onClick={() => setTab("file")}>File</button>
        </div>
      </div>
      <div className="cv-body">
        {err?.key === key && <p className="quiet pad">{err.msg}</p>}
        {text === null && err?.key !== key && <p className="quiet pad">Loading…</p>}
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
  );
}

type LineKind = "" | "add" | "del" | "hunk" | "meta";
function classify(l: string, diff: boolean): LineKind {
  if (!diff) return "";
  if (l.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(l)) return "meta";
  if (l.startsWith("+")) return "add";
  if (l.startsWith("-")) return "del";
  return "";
}

/** Archive, with one extra click when the session has changes that were never merged or opened as a PR. */
function ArchiveButton({ s, files, send, onDone }: { s: SessionInfo; files: number; send: Send; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 5000);
    return () => clearTimeout(t);
  }, [sure]);
  const unshipped = files > 0 && s.ship?.state !== "merged" && s.ship?.state !== "pr";
  const archive = () => {
    send({ type: "session.archive", sessionId: s.id });
    onDone();
  };
  if (sure)
    return (
      <button className="btn small" onClick={archive} title="The branch and its files stay on disk">
        Archive with {files} unshipped file{files === 1 ? "" : "s"}?
      </button>
    );
  return (
    <button className="btn small ghost" onClick={() => (unshipped ? setSure(true) : archive())}>
      Archive
    </button>
  );
}

function ShipBar({ s, files, send }: { s: SessionInfo; files: number; send: Send }) {
  const [confirming, setConfirming] = useState(false);
  if (!s.worktree || !s.branch) return null;
  const sh = s.ship;
  if (sh?.state === "merged")
    return (
      <section className="ship shipped">
        <b>✓ Merged into {sh.into}</b>
        <span>{sh.detail ?? (sh.worktreeRemoved ? "Worktree cleaned up; the branch is kept." : "")}</span>
      </section>
    );
  if (sh?.state === "pr")
    return (
      <section className="ship shipped">
        <b>✓ Pull request opened</b>
        {sh.url && <a className="btn small" href={sh.url} target="_blank" rel="noopener">View on GitHub ↗</a>}
        {sh.detail && <span>{sh.detail}</span>}
      </section>
    );
  if (s.status === "working" || s.status === "needs_you" || (files === 0 && !sh)) return null;
  const busy = sh?.state === "shipping";
  const into = s.baseBranch ?? "your branch";
  // Required checks that fail on this branch: merging is still allowed, but never the default.
  const failing = (s.checkRun?.results ?? []).filter((r) => r.state === "failed").map((r) => r.name);
  const red = failing.length > 0 || s.status === "failed";
  // PR leads when the repo has a GitHub origin (or perzian.json says "ship": "pr"); sessions from before this field keep Merge first.
  const prFirst = s.shipDefault === "pr";
  const merge = { key: "merge", label: busy && sh.how === "merge" ? "Merging…" : `Merge into ${into}`, go: () => setConfirming(true) };
  const pr = { key: "pr", label: busy && sh.how === "pr" ? "Opening PR…" : "Open PR", go: () => send({ type: "session.ship", sessionId: s.id, how: "pr" }) };
  // Merging writes into the developer's own checkout, so it takes one quiet confirm.
  if (confirming && !busy)
    return (
      <section className="ship">
        <h3 className="eyebrow">Ship it</h3>
        <p className="ship-confirm">
          Merge {files} changed file{files === 1 ? "" : "s"} into <code>{into}</code> in <code title={s.project}>{s.project.split("/").filter(Boolean).pop() ?? s.project}</code>? The session's worktree is removed afterwards.
        </p>
        {red && <p className="ship-warn">{failing.length ? `Failing on this branch: ${failing.join(", ")}.` : "This session failed."}</p>}
        <div className="ship-row">
          <button className={`btn${red ? "" : " primary"}`} autoFocus={!red} onClick={() => { setConfirming(false); send({ type: "session.ship", sessionId: s.id, how: "merge" }); }}>
            {red ? "Merge anyway" : "Merge"}
          </button>
          <button className="btn" autoFocus={red} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </section>
    );
  return (
    <section className="ship">
      <h3 className="eyebrow">Ship it</h3>
      <div className="ship-row">
        {(prFirst ? [pr, merge] : [merge, pr]).map((b, i) => (
          <button key={b.key} id={i === 0 ? "ship-primary" : undefined} className={`btn${i === 0 && !red ? " primary" : ""}`} disabled={busy} onClick={b.go}>
            {b.label}
          </button>
        ))}
      </div>
      {sh?.state === "conflict" && (
        <div className="ship-msg">
          <b>Conflicts with {sh.into} in {sh.files?.length} file{sh.files?.length === 1 ? "" : "s"}.</b> Nothing was merged.
          <ul>{sh.files?.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          <button
            className="btn small"
            onClick={() => send({ type: "session.prompt", sessionId: s.id, prompt: `Merging into ${sh.into} conflicts in: ${sh.files?.join(", ")}. Rebase this branch onto ${sh.into}, resolve the conflicts, and run the checks again.` })}
          >
            Ask the agent to resolve
          </button>
        </div>
      )}
      {sh?.state === "error" && <p className="ship-msg">{sh.detail}</p>}
    </section>
  );
}

function SetupBar({ s, send }: { s: SessionInfo; send: Send }) {
  const st = s.setup;
  if (!st) return null;
  const files = st.copied.length ? `copied ${st.copied.length} local file${st.copied.length === 1 ? "" : "s"}` : "";
  const facts = [files, ...st.install].filter(Boolean).join(" · ");
  const detail = [...st.copied, ...(st.notes ?? [])].join("\n") || undefined;
  const act = (action: "retry" | "skip") => send({ type: "session.setup", sessionId: s.id, action });
  if (st.state === "running")
    return (
      <section className="setup">
        <div className="setup-line">
          <span className="dot s-working" />
          <b>Setting up…</b>
          <span className="setup-facts" title={detail}>{st.current ? <code>{st.current}</code> : (facts || "copying local files")}</span>
          <button type="button" className="btn ghost small" onClick={() => act("skip")} title="Send the first message now, without waiting">Start anyway</button>
        </div>
      </section>
    );
  if (st.state === "failed")
    return (
      <section className="setup" role="alert">
        <div className="setup-line">
          <span className="dot s-failed" />
          <b>Setup failed</b>
          <span className="setup-facts"><code>{st.error?.command}</code></span>
          <button type="button" className="btn small" onClick={() => act("retry")}>Retry</button>
          <button type="button" className="btn ghost small" onClick={() => act("skip")}>Start anyway</button>
        </div>
        {st.error?.tail && <pre className="setup-tail">{st.error.tail}</pre>}
      </section>
    );
  if (!facts && !st.notes?.length) return null;
  return (
    <p className="quiet setup-done" title={detail}>
      {st.state === "skipped" ? "Started without finishing setup" : "Worktree ready"}
      {facts && ` · ${facts}`}
      {st.notes?.map((n) => <span key={n} className="setup-note">{n}</span>)}
    </p>
  );
}
