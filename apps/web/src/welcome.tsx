import { useEffect, useState } from "react";
import { MODE_LABEL, projectName, type AgentCheck, type Command, type GitHubCheck, type State } from "@perzian/protocol";
import { useDoctor, useGithubLogin } from "./daemon.ts";
import { ModePicker } from "./bits.tsx";
import { CopyCmd } from "./onboarding.tsx";

type Send = (c: Command) => void;

const REPO = "https://github.com/adi-devv/perzian";
const LINKS: [string, string][] = [
  ["What's new", `${REPO}/releases`],
  ["Docs", `${REPO}#readme`],
  ["Report an issue", `${REPO}/issues/new`],
];

// "Blender-style" intro: a centered card on first launch and from Welcome in the ⋯ menu. Quick setup on the
// left (nothing here is required to chat), recent projects and links on the right.
export function Welcome({ state, send, recent, onUseProject, onStart }: { state: State; send: Send; recent: string[]; onUseProject: (path: string) => void; onStart: () => void }) {
  const doctor = useDoctor("", true);
  const gh = useGithubLogin(doctor.recheck);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onStart();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onStart]);

  return (
    <div className="modal splash-back" onClick={onStart}>
      <div className="splash" role="dialog" aria-label="Welcome to Perzian" onClick={(e) => e.stopPropagation()}>
        <header className="splash-top">
          <span className="mark big" aria-hidden />
          <div>
            <h2>
              Perzian <span className="splash-ver">{__PERZIAN_VERSION__}</span>
            </h2>
            <p className="splash-tag">Talk to one agent. Command them all.</p>
          </div>
        </header>

        <div className="splash-cols">
          <section className="splash-col" aria-label="Quick setup">
            <h3>Quick setup</h3>
            <div className="sp-row">
              <span className="sp-k">Default mode</span>
              <ModePicker value={state.settings.defaultMode} onChange={(mode) => send({ type: "settings.setDefaultMode", mode })} title={`New sessions start in ${MODE_LABEL[state.settings.defaultMode]}`} />
            </div>
            <div className="sp-agents">
              {doctor.report?.agents.map((a) => <AgentLine key={a.kind} a={a} />)}
              {!doctor.report && <span className="sp-quiet">{doctor.failed ? "Setup check failed" : "Checking…"}</span>}
            </div>
            <GithubBlock gh={doctor.report?.github} login={gh} />
          </section>

          <section className="splash-col" aria-label="Projects and links">
            <h3>Recent projects</h3>
            {recent.length ? (
              <div className="folder-recent">
                {recent.map((p) => (
                  <button key={p} className="btn small" title={p} onClick={() => onUseProject(p)}>
                    {projectName(p)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="sp-quiet">None yet. Perzian asks when it needs one.</p>
            )}
            <nav className="splash-links" aria-label="Links">
              {LINKS.map(([label, href]) => (
                <a key={label} href={href} target="_blank" rel="noreferrer" className="text-link">
                  {label}
                </a>
              ))}
            </nav>
          </section>
        </div>

        <footer className="splash-foot">
          <label className="sp-check">
            <input type="checkbox" checked={state.settings.splash} onChange={(e) => send({ type: "settings.setSplash", show: e.target.checked })} />
            Show on startup
          </label>
          <button className="btn primary" autoFocus onClick={onStart}>
            Start
          </button>
        </footer>
      </div>
    </div>
  );
}

function AgentLine({ a }: { a: AgentCheck }) {
  const [how, setHow] = useState(false);
  const status = !a.installed ? "not found" : a.signedIn === false ? "not signed in" : a.signedIn ? "✓ signed in" : "installed";
  return (
    <div className="sp-agent">
      <div className="sp-row">
        <span className="sp-k">{a.label}</span>
        <span className="sp-v">
          {status}
          {!a.installed && (
            <>
              {" · "}
              <button className="text-link" onClick={() => setHow(!how)}>how to install</button>
            </>
          )}
        </span>
      </div>
      {!a.installed && how && <CopyCmd cmd={a.installCommand} />}
      {a.installed && a.signedIn === false && <CopyCmd cmd={a.signInCommand} />}
    </div>
  );
}

function GithubBlock({ gh, login }: { gh?: GitHubCheck; login: ReturnType<typeof useGithubLogin> }) {
  const { login: l } = login;
  let body: React.ReactNode;
  if (!gh) body = <span className="sp-quiet">Checking…</span>;
  else if (gh.signedIn) body = <span className="sp-v">Connected{gh.user ? ` as ${gh.user}` : ""}</span>;
  else if (!gh.ghInstalled) body = gh.installCommand ? <CopyCmd cmd={gh.installCommand} /> : <a className="text-link" href={gh.installUrl} target="_blank" rel="noreferrer">Install GitHub CLI</a>;
  else if (l.state === "waiting" && l.code) {
    body = (
      <div className="sp-code">
        <code className="code-big">{l.code}</code>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard?.writeText(l.code!).catch(() => {});
            window.open(l.url ?? "https://github.com/login/device", "_blank", "noreferrer");
          }}
        >
          Copy code &amp; open GitHub
        </button>
        <span className="sp-quiet">Waiting for you to finish in the browser…</span>
      </div>
    );
  } else {
    body = (
      <div className="sp-code">
        <button className="btn small" disabled={l.state === "waiting"} onClick={login.start}>
          {l.state === "waiting" ? "Starting…" : "Connect GitHub"}
        </button>
        {l.state === "failed" && <span className="sp-quiet">{l.error ?? "Didn't finish"} · try again</span>}
      </div>
    );
  }
  return (
    <div className="sp-gh">
      <div className="sp-row">
        <span className="sp-k">GitHub <span className="sp-opt">optional</span></span>
        {gh && !gh.signedIn && !gh.ghInstalled ? <span className="sp-v">gh not installed</span> : null}
      </div>
      {body}
      {!gh?.signedIn && <p className="sp-quiet">Needed for PRs and CI status. You can skip this.</p>}
    </div>
  );
}
