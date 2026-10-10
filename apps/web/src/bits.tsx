import { useEffect, useState } from "react";
import type { Decision, FileChange, Outcome, SessionInfo, SessionStatus } from "@perzian/protocol";

export const STATUS_LABEL: Record<SessionStatus, string> = { needs_you: "Needs you", working: "Working", failed: "Failed", done: "Done", idle: "Idle" };

export function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
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

// Tiny +/- bar: total width ~ log(churn), split green/red.
export function ChurnBar({ files }: { files: FileChange[] }) {
  const { add, del } = churn(files);
  if (!files.length) return null;
  const total = add + del;
  const w = Math.min(64, 14 + Math.log2(total + 1) * 6);
  return (
    <span className="churn" title={`${files.length} files · +${add} −${del}`}>
      <span className="churn-bar" style={{ width: w }}>
        <i className="add" style={{ flex: add || 0.0001 }} />
        <i className="del" style={{ flex: del || 0.0001 }} />
      </span>
      <span className="churn-n">{files.length}</span>
    </span>
  );
}

export function StatusGlyph({ s }: { s: SessionInfo }) {
  if (s.status === "working" && s.progress) return <Ring step={s.progress.step} of={s.progress.of} />;
  return <span className="dot" />;
}

export function ProofPills({ o }: { o: Outcome }) {
  if (!o.proof.length) return o.derived ? <span className="pill muted">no proof reported</span> : null;
  return (
    <span className="pills">
      {o.proof.map((p, i) => (
        <span key={i} className={`pill ${p.passed ? "ok" : "bad"}`} title={p.detail}>
          {p.passed ? "✓" : "✕"} {p.label}
        </span>
      ))}
    </span>
  );
}

export function DecisionCard({ d, session, onAnswer, onOpen, index }: { d: Decision; session?: SessionInfo; onAnswer: (id: string | null) => void; onOpen?: () => void; index?: number }) {
  const perm = d.source === "permission";
  return (
    <article className={`decision ${perm ? "perm" : "ask"}`}>
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

// Change map: files grouped by directory, each block sized by churn and split by +/−. Click opens the diff.
export function ChangeMap({ files, onOpen }: { files: FileChange[]; onOpen: (path: string) => void }) {
  if (!files.length) return <p className="quiet">No file changes yet.</p>;
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
          <span className="cm-dir">{dir}/</span>
          <div className="cm-files">
            {list.map((f) => {
              const n = f.additions + f.deletions;
              const grow = 1 + Math.sqrt(n / max) * 3;
              return (
                <button key={f.path} className={`cm-file c-${f.kind}`} style={{ flexGrow: grow }} onClick={() => onOpen(f.path)} title={`${f.path}  +${f.additions} −${f.deletions}`}>
                  <span className="cm-name">
                    <b>{GLYPH[f.kind]}</b>
                    {f.path.slice(f.path.lastIndexOf("/") + 1)}
                  </span>
                  <span className="cm-split">
                    <i className="add" style={{ flex: f.additions || 0.0001 }} />
                    <i className="del" style={{ flex: f.deletions || 0.0001 }} />
                  </span>
                  <span className="cm-n">
                    <em className="a">+{f.additions}</em> <em className="d">−{f.deletions}</em>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
