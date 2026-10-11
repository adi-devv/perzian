import { useEffect, useRef, useState } from "react";
import { AGENTS, MODE_LABEL, type Command, type Decision, type FileChange, type PermissionMode, type SessionInfo, type SessionStatus, type State, type TranscriptItem } from "@perzian/protocol";
import { isFailureNotice } from "./onboarding.tsx";

type Send = (c: Command) => void;

/** The one placeholder for the lead's composer, in the real app and the demo, with or without a lead session. */
export const LEAD_PLACEHOLDER = "Ask Perzian, or tell it what to build…";

export const STATUS_LABEL: Record<SessionStatus, string> = { needs_you: "Needs you", working: "Working", failed: "Failed", done: "Done", idle: "Idle", paused: "Paused" };

/** "3:40 pm", or "Tue 3:40 pm" when it isn't today; "~" when the agent gave no reset time. */
export function resumeTime(p: NonNullable<SessionInfo["pause"]>): string {
  const d = new Date(p.resumeAt);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const day = d.toDateString() === new Date().toDateString() ? "" : `${d.toLocaleDateString([], { weekday: "short" })} `;
  return `${p.estimated ? "~" : ""}${day}${time}`;
}

/** The status in words: "Paused · resumes 3:40 pm" for a session waiting out a usage limit. */
export function statusText(s: SessionInfo): string {
  // An archived session keeps its last status in the log; it won't resume or finish any more.
  if (s.archived) return "Archived";
  return s.status === "paused" && s.pause ? `Paused · resumes ${resumeTime(s.pause)}` : statusLabel(s);
}

/** Why it's paused, for a tooltip. */
export function pauseTitle(s: SessionInfo): string | undefined {
  const p = s.pause;
  if (s.status !== "paused" || !p) return undefined;
  const how = p.early ? "Paused near the usage limit, after its current step." : "Paused at the usage limit.";
  const when = p.estimated ? "No reset time was given; it tries again then." : "It resumes by itself when the limit resets.";
  return `${how} ${when}\n${p.reason}`;
}

// The status as words, with worktree setup folded in: "Setting up…" while it runs, "Setup failed" when it stops the session.
export function statusLabel(s: SessionInfo): string {
  if (s.status === "working" && s.setup?.state === "running") return "Setting up…";
  if (s.status === "failed" && s.setup?.state === "failed") return "Setup failed";
  return STATUS_LABEL[s.status];
}

export function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export function cost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// Spend, plus a hairline meter of how full the context window is.
export function Usage({ s }: { s: SessionInfo }) {
  const u = s.usage;
  if (!u || (u.costUsd === undefined && !u.contextSize)) return null;
  const pct = u.contextSize && u.contextUsed !== undefined ? Math.min(100, Math.round((u.contextUsed / u.contextSize) * 100)) : undefined;
  const title = [u.costUsd !== undefined && `${cost(u.costUsd)} spent in this session`, pct !== undefined && `context ${pct}% full (${k(u.contextUsed!)} of ${k(u.contextSize!)} tokens)`].filter(Boolean).join(" · ");
  return (
    <span className="usage chip" title={title}>
      {u.costUsd !== undefined && <span>{cost(u.costUsd)}</span>}
      {pct !== undefined && (
        <span className={`ctx ${pct >= 80 ? "full" : ""}`} aria-label={`Context ${pct}% full`}>
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}

// Re-render every 30s so relative times stay fresh.
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function Ring({ step, of, size = 18 }: { step: number; of: number; size?: number }) {
  const r = 7, c = 2 * Math.PI * r, pct = Math.min(1, step / Math.max(1, of));
  return (
    <svg className="ring" viewBox="0 0 18 18" width={size} height={size} aria-label={`Step ${step} of ${of}`}>
      <circle cx="9" cy="9" r={r} className="ring-bg" />
      <circle cx="9" cy="9" r={r} className="ring-fg" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

export function churn(files: FileChange[]) {
  return files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 });
}

// Compact +/− counts, colored only in the digits.
// One small mark per state: blue pulsing dot (working, or its step ring), amber dot (needs you), red dot (failed),
// green check (done), hollow grey ring (paused or asleep). Dots and checks only; the tile carries the rest.
export function StatusGlyph({ s }: { s: SessionInfo }) {
  if (s.status === "working" && s.progress) return <Ring step={s.progress.step} of={s.progress.of} size={14} />;
  if (s.status === "done")
    return (
      <svg key="done" className="chk" viewBox="0 0 12 12" width="11" height="11" aria-hidden>
        <path d="M2.4 6.3l2.3 2.3 4.9-5.2" />
      </svg>
    );
  const hollow = s.status === "paused" || s.status === "idle";
  return <span key={s.status} className={`dot ${hollow ? "hollow" : ""}`} />;
}

/** Focus a control on mount, unless the developer is already typing somewhere. */
export function useFocusOnMount(on: boolean | undefined) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!on) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.closest("input, textarea, select")) return;
    ref.current?.focus({ preventScroll: true });
  }, [on]);
  return ref;
}

/** The option that says no: what a destructive request focuses by default. */
export const denyOption = (d: Decision) => d.options.find((o) => o.kind === "reject_once") ?? d.options.find((o) => o.kind === "reject_always");

export function DecisionCard({ d, session, onAnswer, onOpen, index }: { d: Decision; session?: SessionInfo; onAnswer: (id: string | null) => void; onOpen?: () => void; index?: number }) {
  const perm = d.source === "permission";
  const deny = d.destructive ? denyOption(d) : undefined;
  const denyRef = useFocusOnMount(!!deny);
  return (
    <article className={`decision ${perm ? "perm" : "ask"} ${d.destructive ? "destructive" : ""}`}>
      <header>
        <button className="decision-src" onClick={onOpen} title="Open session">
          <span className="dot" />
          {session?.title ?? "Session"}
        </button>
        {index !== undefined && index < 9 && <kbd>{index + 1}</kbd>}
        <span className="age">{ago(d.createdAt)}</span>
      </header>
      {perm ? (
        <div className="perm-body">
          {d.destructive && <span className="danger-tag">Destructive · {d.destructive}</span>}
          <OutsideTag d={d} />
          <span className="perm-tool">{d.question}</span>
          {d.detail && <code>{d.detail}</code>}
        </div>
      ) : (
        <p className="decision-q">{d.question}</p>
      )}
      <div className={`options ${perm ? "row" : ""}`}>
        {d.options.map((o) => (
          <button key={o.id} ref={deny?.id === o.id ? denyRef : undefined} className={`opt k-${o.kind ?? "choice"} ${d.recommended === o.id ? "rec" : ""} ${deny?.id === o.id ? "deny-default" : ""}`} onClick={() => onAnswer(o.id)}>
            <span className="opt-label">{o.label}</span>
            {o.tradeoff && <span className="opt-trade">{o.tradeoff}</span>}
          </button>
        ))}
      </div>
    </article>
  );
}

/** "Outside project: <path>" for an edit, delete or move beyond the session's folders. Grey: it is information, not an alarm. */
export function OutsideTag({ d }: { d: Decision }) {
  if (!d.outside?.length) return null;
  const more = d.outside.length - 1;
  return (
    <span className="out-tag" title={d.outside.join("\n")}>
      Outside project: <code>{d.outside[0]}</code>
      {more > 0 && ` +${more}`}
    </span>
  );
}

export interface Chip {
  key: string;
  label: string;
  title?: string;
  href?: string;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Facts the daemon observed about what the agent did on its own, as short grey chips. */
export function sessionChips(s: SessionInfo): Chip[] {
  const out: Chip[] = [];
  const wt = s.extraWorktrees ?? [];
  if (wt.length) out.push({ key: "wt", label: `+${plural(wt.length, "worktree")}`, title: wt.map((w) => [w.path, w.branch].filter(Boolean).join("  ⎇ ")).join("\n") });
  const sub = s.subagents ?? [];
  if (sub.length) out.push({ key: "sub", label: plural(sub.length, "subagent"), title: sub.map((x) => `${x.description} (${x.status})`).join("\n") });
  const outside = s.outsidePaths ?? [];
  if (outside.length) out.push({ key: "out", label: "outside project", title: outside.join("\n") });
  for (const b of (s.background ?? []).filter((p) => !p.ended)) {
    const label = `▶ ${b.command}${b.port ? ` :${b.port}` : ""}`;
    out.push({ key: `bg${b.id}`, label, title: b.port ? `Running in the background. Open http://localhost:${b.port}` : "Running in the background", href: b.port ? `http://localhost:${b.port}` : undefined });
  }
  return out;
}

/** "3 commits · pushed" plus the PR link, or null when the agent made no commits. */
export function gitChip(s: SessionInfo): { label: string; url?: string } | null {
  const g = s.git;
  if (!g || (!g.ahead && !g.prUrl)) return null;
  const label = [g.ahead ? plural(g.ahead, "commit") : "", g.ahead && g.pushed ? "pushed" : ""].filter(Boolean).join(" · ");
  return { label, url: g.prUrl };
}

/** `quietOutside`: the card on the tile already says which path is outside the project, so the chip would repeat it. */
export function Chips({ s, quietOutside }: { s: SessionInfo; quietOutside?: boolean }) {
  const chips = sessionChips(s).filter((c) => !(quietOutside && c.key === "out"));
  const g = gitChip(s);
  if (!chips.length && !g) return null;
  return (
    <div className="chips-row">
      {chips.map((c) =>
        c.href ? (
          <a key={c.key} className="mchip" href={c.href} target="_blank" rel="noopener" title={c.title} onClick={(e) => e.stopPropagation()}>{c.label}</a>
        ) : (
          <span key={c.key} className="mchip" title={c.title}>{c.label}</span>
        ),
      )}
      {g && (
        <span className="mchip" title="Commits the agent made itself">
          {g.label}
          {g.label && g.url ? " · " : ""}
          {g.url && <a href={g.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>PR ↗</a>}
        </span>
      )}
    </div>
  );
}

/** The last failure in a transcript that nothing has been sent after, and the prompt to resend. */
export function retryTarget(items: TranscriptItem[], status: SessionInfo["status"]): { index: number; prompt: string } | null {
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

/** An input; the placeholder says who it talks to (`to` is its accessible name). `blocked`: why sending isn't possible yet; typing still works and the text is kept. */
export function Composer({ id, to, placeholder, focus, busy, blocked, onSubmit, onStop, note, controls }: { id: string; to: string; placeholder: string; focus?: boolean; busy?: boolean; blocked?: string; onSubmit: (t: string) => void; onStop?: () => void; note?: React.ReactNode; controls?: React.ReactNode }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim() || blocked) return;
    onSubmit(text.trim());
    setText("");
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {note && <div className="composer-note">{note}</div>}
      <div className="composer-row">
        <textarea
          id={id}
          aria-label={to}
          rows={1}
          autoFocus={focus}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {controls}
        {busy && onStop ? (
          <button type="button" className="btn" onClick={onStop}>Stop</button>
        ) : (
          <button className="btn primary" disabled={!text.trim() || !!blocked} title={blocked}>Send</button>
        )}
      </div>
    </form>
  );
}

/** Permission mode as a compact toggle beside a composer, like Claude's: Ask / Edits / Plan / Auto. */
export function ModePicker({ value, onChange, disabled, title }: { value: PermissionMode; onChange?: (m: PermissionMode) => void; disabled?: boolean; title?: string }) {
  return (
    <select className="picker mode-pick" aria-label="Permission mode" title={title} disabled={disabled} value={value} onChange={(e) => onChange?.(e.target.value as PermissionMode)}>
      {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
    </select>
  );
}

export function ModelPicker({ s, state, send }: { s: SessionInfo; state: State; send: Send }) {
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
