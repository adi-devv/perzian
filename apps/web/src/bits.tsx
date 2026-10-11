import { useEffect, useState } from "react";
import type { Decision, FileChange, Outcome, SessionInfo, SessionStatus } from "@perzian/protocol";

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
  return s.status === "paused" && s.pause ? `Paused · resumes ${resumeTime(s.pause)}` : STATUS_LABEL[s.status];
}

/** Why it's paused, for a tooltip. */
export function pauseTitle(s: SessionInfo): string | undefined {
  const p = s.pause;
  if (s.status !== "paused" || !p) return undefined;
  const how = p.early ? "Paused near the usage limit, after its current step." : "Paused at the usage limit.";
  const when = p.estimated ? "No reset time was given; it tries again then." : "It resumes by itself when the limit resets.";
  return `${how} ${when}\n${p.reason}`;
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
export function ChurnBar({ files }: { files: FileChange[] }) {
  const { add, del } = churn(files);
  if (!files.length) return null;
  return (
    <span className="churn" title={`${files.length} files · +${add} −${del}`}>
      <em className="a">+{add}</em>
      <em className="d">−{del}</em>
    </span>
  );
}

export function StatusGlyph({ s }: { s: SessionInfo }) {
  if (s.status === "working" && s.progress) return <Ring step={s.progress.step} of={s.progress.of} />;
  return <span className="dot" />;
}

// Observed proofs (the daemon saw the command run) read as facts; self-reported ones are marked as claims.
export function ProofPills({ o }: { o: Outcome }) {
  if (!o.proof.length) return o.derived ? <span className="pill muted">no checks run</span> : null;
  return (
    <span className="pills">
      {o.proof.map((p, i) => (
        <span
          key={i}
          className={`pill ${p.passed ? "ok" : "bad"} ${p.observed ? "observed" : "claimed"}`}
          title={[p.command && `$ ${p.command}`, p.exitCode !== undefined && `exit ${p.exitCode}`, p.durationMs !== undefined && `${(p.durationMs / 1000).toFixed(1)}s`, p.detail, p.observed ? "Verified by Perzian" : "Reported by the agent"].filter(Boolean).join("\n")}
        >
          {p.passed ? "✓" : "✕"} {p.summary ? `${p.label} · ${p.summary}` : p.label}
          {!p.observed && <em className="claim">claimed</em>}
        </span>
      ))}
    </span>
  );
}

export function DecisionCard({ d, session, onAnswer, onOpen, index }: { d: Decision; session?: SessionInfo; onAnswer: (id: string | null) => void; onOpen?: () => void; index?: number }) {
  const perm = d.source === "permission";
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
          <button key={o.id} className={`opt k-${o.kind ?? "choice"} ${d.recommended === o.id ? "rec" : ""}`} onClick={() => onAnswer(o.id)}>
            <span className="opt-label">{o.label}</span>
            {o.tradeoff && <span className="opt-trade">{o.tradeoff}</span>}
          </button>
        ))}
      </div>
    </article>
  );
}

const GLYPH = { added: "+", modified: "~", deleted: "−", renamed: "→" } as const;

// Change map: files grouped by directory; each row shows a magnitude bar and, when known,
// the functions/classes that changed. Click a row for the read-only diff.
const NO_CHANGES: Record<SessionStatus, string> = {
  working: "No file changes yet. Edits show up here as they happen.",
  needs_you: "No file changes yet.",
  done: "Finished without changing files.",
  failed: "No files changed before it stopped.",
  idle: "No file changes yet.",
  paused: "No file changes yet.",
};

export function ChangeMap({ files, onOpen, status }: { files: FileChange[]; onOpen: (path: string) => void; status?: SessionStatus }) {
  if (!files.length) return <p className="quiet">{NO_CHANGES[status ?? "idle"]}</p>;
  const groups = new Map<string, FileChange[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i === -1 ? "." : f.path.slice(0, i);
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  const max = Math.max(...files.map((f) => f.additions + f.deletions), 1);
  return (
    <div className="changemap">
      {[...groups.entries()].map(([dir, list]) => (
        <div key={dir} className="cm-group">
          <span className="cm-dir">{dir === "." ? "./" : `${dir}/`}</span>
          <div className="cm-files">
            {list.map((f) => {
              const n = f.additions + f.deletions;
              const width = `${Math.max(6, Math.sqrt(n / max) * 100)}%`;
              const symbols = (f as FileChange & { symbols?: { name: string; kind: string; change: string }[] }).symbols ?? [];
              return (
                <button key={f.path} className={`cm-file c-${f.kind}`} onClick={() => onOpen(f.path)} title={`${f.path}  +${f.additions} −${f.deletions}`}>
                  <span className="cm-name">
                    <b>{GLYPH[f.kind]}</b>
                    <span className="cm-fname">{f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
                  </span>
                  <span className="cm-split">
                    <span className="cm-mag" style={{ width }}>
                      <i className="add" style={{ flex: f.additions || 0.0001 }} />
                      <i className="del" style={{ flex: f.deletions || 0.0001 }} />
                    </span>
                  </span>
                  <span className="cm-n">
                    <em className="a">+{f.additions}</em> <em className="d">−{f.deletions}</em>
                  </span>
                  {symbols.length > 0 && (
                    <span className="cm-sym">
                      {symbols.slice(0, 12).map((sym, i) => (
                        <span key={i} className={`sym-${sym.change}`} title={sym.kind}>
                          {sym.name}
                          {sym.kind === "function" || sym.kind === "method" ? "()" : ""}
                        </span>
                      ))}
                      {symbols.length > 12 && <span>+{symbols.length - 12} more</span>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
