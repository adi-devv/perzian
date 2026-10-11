import { useEffect, useRef, useState } from "react";
import { AGENTS, MODE_LABEL, type Command, type Decision, type FileChange, type PermissionMode, type SessionInfo, type SessionStatus, type State, type TranscriptItem } from "@perzian/protocol";
import { isFailureNotice } from "./onboarding.tsx";

type Send = (c: Command) => void;

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
export function StatusGlyph({ s }: { s: SessionInfo }) {
  if (s.status === "working" && s.progress) return <Ring step={s.progress.step} of={s.progress.of} />;
  return <span key={s.status} className="dot" />;
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

/** An input that says who it talks to: "To: Perzian" or "To: <session title>". `blocked`: why sending isn't possible yet; typing still works and the text is kept. */
export function Composer({ id, to, placeholder, focus, busy, blocked, onSubmit, onStop, note, controls }: { id: string; to: string; placeholder: string; focus?: boolean; busy?: boolean; blocked?: string; onSubmit: (t: string) => void; onStop?: () => void; note?: React.ReactNode; controls?: React.ReactNode }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim() || blocked) return;
    onSubmit(text.trim());
    setText("");
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label className="to" htmlFor={id}>
        To: <b>{to}</b>
        {note}
      </label>
      <div className="composer-row">
        <textarea
          id={id}
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
