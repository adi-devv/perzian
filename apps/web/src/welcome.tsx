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
          <div className="splash-id">
            <h2>
              Perzian <span className="splash-ver">{__PERZIAN_VERSION__}</span>
            </h2>
            <p className="splash-tag">Talk to one agent. Command them all.</p>
          </div>
        </header>

        <div className="splash-cols">
          <section className="splash-col" aria-label="Quick setup">
            <h3>Quick setup</h3>
            <div className="sp-list">
              <div className="sp-row">
                <span className="sp-k">Default mode</span>
                <ModePicker value={state.settings.defaultMode} onChange={(mode) => send({ type: "settings.setDefaultMode", mode })} title={`New sessions start in ${MODE_LABEL[state.settings.defaultMode]}`} />
              </div>
              {doctor.report?.agents.map((a) => <AgentLine key={a.kind} a={a} />)}
              {!doctor.report && (
                <div className="sp-row">
                  <span className="sp-k">Agents</span>
                  <span className="sp-v muted">{doctor.failed ? "Setup check failed" : "Checking…"}</span>
                </div>
              )}
              <GithubRow gh={doctor.report?.github} login={gh} />
            </div>
            <GithubNote gh={doctor.report?.github} login={gh} />
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
              <p className="sp-quiet">None yet</p>
            )}
            <h3 className="sp-gap">Links</h3>
            <nav className="splash-links" aria-label="Links">
              {LINKS.map(([label, href]) => (
                <a key={label} href={href} target="_blank" rel="noreferrer">
                  {label} <span aria-hidden>↗</span>
                </a>
              ))}
            </nav>
          </section>
        </div>

        <footer className="splash-foot">
          <label className="sp-check">
            <input type="checkbox" checked={state.settings.splash} onChange={(e) => send({ type: "settings.setSplash", show: e.target.checked })} />
            <span className="sp-box" aria-hidden />
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

function Status({ tone, children }: { tone: "ok" | "off"; children: React.ReactNode }) {
  return (
    <span className="sp-v muted">
      <i className={`dot sp-dot ${tone}`} aria-hidden />
      {children}
    </span>
  );
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-link"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }, () => {});
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function AgentLine({ a }: { a: AgentCheck }) {
  const [how, setHow] = useState(false);
  let value: React.ReactNode;
  if (!a.installed) {
    value = (
      <>
        <Status tone="off">Not found</Status>
        <button className="text-link" onClick={() => setHow(!how)}>How to install</button>
      </>
    );
  } else if (a.signedIn === false) {
    value = (
      <>
        <Status tone="off">Not signed in</Status>
        <CopyText text={a.signInCommand} label={`Copy \`${a.signInCommand}\``} />
      </>
    );
  } else if (a.signedIn) value = <Status tone="ok">Signed in</Status>;
  else value = <Status tone="ok">Installed</Status>;
  return (
    <>
      <div className="sp-row">
        <span className="sp-k">{a.label}</span>
        <span className="sp-vs">{value}</span>
      </div>
      {!a.installed && how && (
        <div className="sp-extra">
          <CopyCmd cmd={a.installCommand} />
        </div>
      )}
    </>
  );
}

function GithubRow({ gh, login }: { gh?: GitHubCheck; login: ReturnType<typeof useGithubLogin> }) {
  const { login: l } = login;
  let value: React.ReactNode;
  if (!gh) value = <span className="sp-v muted">Checking…</span>;
  else if (gh.signedIn) value = <Status tone="ok">{gh.user ?? "Connected"}</Status>;
  else if (!gh.ghInstalled) value = gh.installCommand ? <CopyText text={gh.installCommand} label="Copy install command" /> : <a className="text-link" href={gh.installUrl} target="_blank" rel="noreferrer">Install GitHub CLI</a>;
  else if (l.state === "waiting" && l.code) {
    value = (
      <>
        <code className="sp-code">{l.code}</code>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard?.writeText(l.code!).catch(() => {});
            window.open(l.url ?? "https://github.com/login/device", "_blank", "noreferrer");
          }}
        >
          Copy code &amp; open
        </button>
      </>
    );
  } else {
    value = (
      <button className="btn small" disabled={l.state === "waiting"} onClick={login.start}>
        {l.state === "waiting" ? "Starting…" : "Connect"}
      </button>
    );
  }
  return (
    <div className="sp-row">
      <span className="sp-k">
        GitHub <span className="sp-opt">optional</span>
      </span>
      <span className="sp-vs">{value}</span>
    </div>
  );
}

function GithubNote({ gh, login }: { gh?: GitHubCheck; login: ReturnType<typeof useGithubLogin> }) {
  const { login: l } = login;
  if (!gh || gh.signedIn) return null;
  const msg = l.state === "waiting" && l.code ? "Waiting for you to finish in the browser…" : l.state === "failed" ? `${l.error ?? "Didn't finish"}. Try again.` : "Needed for PRs and CI status. You can skip this.";
  return <p className="sp-quiet">{msg}</p>;
}
