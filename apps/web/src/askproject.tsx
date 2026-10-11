import { useState } from "react";
import type { Command, Decision } from "@perzian/protocol";

/** The lead's "Which project?" card, in the chat: recent projects, the native folder picker (desktop) or a typed path.
 *  Every answer is a folder path sent as decision.answer; the daemon checks it, saves it as a project and returns it to the lead. */
export function ProjectCard({ d, send }: { d: Decision; send: (c: Command) => void }) {
  const [path, setPath] = useState("");
  const pick = window.perzian?.pickFolder;
  const answer = (p: string) => send({ type: "decision.answer", decisionId: d.id, optionId: p });
  return (
    <article className="decision ask project-card" aria-label="Which project?">
      <p className="decision-q">Which project?</p>
      {d.detail && <p className="hint">{d.detail}</p>}
      {d.options.length > 0 && (
        <div className="options">
          {d.options.map((o) => (
            <button key={o.id} className="opt" onClick={() => answer(o.id)} title={o.tradeoff}>
              <span className="opt-label">{o.label}</span>
              {o.tradeoff && <span className="opt-trade">{o.tradeoff}</span>}
            </button>
          ))}
        </div>
      )}
      {pick ? (
        <div className="folder-pick">
          <button className="btn small" onClick={() => void pick().then((p) => p && answer(p)).catch(() => {})}>
            Choose folder…
          </button>
        </div>
      ) : (
        <form className="folder-pick" onSubmit={(e) => { e.preventDefault(); if (path.trim()) answer(path.trim()); }}>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Type a project path, e.g. ~/code/app" spellCheck={false} autoComplete="off" aria-label="Project folder" />
          <button className="btn small" disabled={!path.trim()}>Use this folder</button>
        </form>
      )}
    </article>
  );
}
