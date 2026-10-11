import { useState } from "react";
import type { AgentCheck, ApiKeyProvider, CredentialStatus, DoctorReport } from "@perzian/protocol";
import { DAEMON_ADDR, installAgent, isDesktop, useCredentials, useDoctor } from "./daemon.ts";

/* ───────────── Project folder memory (shared with New session) ───────────── */

const PROJECT_KEY = "perzian.lastProject";
export function loadProject(): string {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? "";
  } catch {
    return "";
  }
}
export function saveProject(p: string) {
  try {
    localStorage.setItem(PROJECT_KEY, p);
  } catch {}
}
/** The lead agent works from its own folder; tell it which repo the task is about. */
export const withProject = (prompt: string, path: string) => `${prompt}\n\nProject folder: ${path}`;

export const EXAMPLES = ["Fix the failing test", "Add a /health endpoint with a test", "Explain this repo's architecture in 5 bullets"];

/* ───────────── First run ───────────── */

type Mark = "ok" | "todo" | "bad" | "wait" | "unknown";

function Step({ mark, label, meta, children }: { mark: Mark; label: string; meta?: string; children?: React.ReactNode }) {
  return (
    <li className={`step m-${mark}`}>
      <span className="step-mark" aria-label={mark === "ok" ? "Done" : mark === "bad" ? "Needs action" : mark === "wait" ? "Checking" : "To do"}>
        {mark === "ok" ? "✓" : mark === "bad" ? "✕" : mark === "unknown" ? "–" : ""}
      </span>
      <div className="step-body">
        <div className="step-line">
          <span className="step-label">{label}</span>
          {meta && <span className="step-meta">{meta}</span>}
        </div>
        {children}
      </div>
    </li>
  );
}

export function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code>{cmd}</code>
      <button
        type="button"
        className="cmd-copy"
        onClick={() => {
          navigator.clipboard?.writeText(cmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }, () => {});
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

interface Doctor {
  report: DoctorReport | null;
  loading: boolean;
  failed: boolean;
  recheck: () => void;
}

type Creds = ReturnType<typeof useCredentials>;

const shellQuote = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Whether the first task can start, and if not, the one thing to do first. Gates every way to start. */
export function readiness(report: DoctorReport | null, project: string): { ready: boolean; blocker: string } {
  const claude = report?.agents.find((a) => a.kind === "claude-code");
  const proj = report?.project && report.project.input === project.trim() ? report.project : undefined;
  const blocker = !report
    ? "Checking your setup…"
    : !claude?.installed
      ? "Install Claude Code to start."
      : claude.signedIn === false
        ? "Sign in to start."
        : !proj?.exists
          ? "Pick a project folder to start."
          : proj.noCommits
            ? "Make a first commit in your project to start."
            : proj.detached
              ? "Check out a branch in your project to start."
              : "";
  return { ready: !blocker, blocker };
}

export function Onboarding({ doctor, project, setProject, onStart }: { doctor: Doctor; project: string; setProject: (p: string) => void; onStart: (prompt: string) => void }) {
  const { report, loading, failed, recheck } = doctor;
  const creds = useCredentials(true);
  const claude = report?.agents.find((a) => a.kind === "claude-code");
  const proj = report?.project && report.project.input === project.trim() ? report.project : undefined;
  const again = (
    <button type="button" className="btn small" onClick={recheck} disabled={loading}>
      {loading ? "Checking…" : "Check again"}
    </button>
  );

  // 1 · installed
  let installMark: Mark = "wait";
  let installMeta: string | undefined = "Checking…";
  let installFix: React.ReactNode = null;
  if (failed && !report) {
    installMark = "bad";
    installMeta = undefined;
    installFix = (
      <div className="step-fix">
        <p>Couldn't run the checks. Restart the daemon so it picks up the latest code, then check again.</p>
        {again}
      </div>
    );
  } else if (claude?.installed) {
    installMark = "ok";
    installMeta = [claude.version && `v${claude.version}`, claude.source === "bundled" && "bundled"].filter(Boolean).join(" · ");
  } else if (claude) {
    installMark = "bad";
    installMeta = "Not found";
    installFix = <InstallFix agent={claude} onDone={recheck} again={again} />;
  }

  // 2 · signed in
  const sign = signInStep(claude, again, creds, recheck);

  // 3 · project
  let projMark: Mark = "todo";
  let projMeta: string | undefined;
  if (project.trim()) {
    if (!proj) projMark = "wait";
    else if (proj.exists && (proj.noCommits || proj.detached)) {
      projMark = "bad";
      projMeta = proj.noCommits ? "git repo · no commits yet" : "git repo · detached HEAD";
    } else if (proj.exists) {
      projMark = "ok";
      projMeta = proj.gitRoot ? "git repo" : "not a git repo";
    } else {
      projMark = "bad";
      projMeta = "Folder not found";
    }
  }

  const { ready, blocker } = readiness(report, project);
  const codex = report?.agents.find((a) => a.kind === "codex");

  return (
    <div className="onboard">
      <div className="welcome-mark" aria-hidden />
      <h2>Set up your first session</h2>
      <p className="onboard-sub">Three checks, then hand Perzian a task. It splits the work into coding sessions and brings back results with proof.</p>

      <ol className="steps">
        <Step mark={installMark} label="Claude Code installed" meta={installMeta}>
          {installFix}
        </Step>
        <Step mark={sign.mark} label="Signed in" meta={sign.meta}>
          {sign.fix}
        </Step>
        <Step mark={projMark} label="Pick a project folder" meta={projMeta}>
          <input
            id="onboard-project"
            className="step-input"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="~/code/app"
            spellCheck={false}
            autoComplete="off"
            aria-label="Project folder"
          />
          {proj && !proj.exists && <p className="step-note">Nothing at {proj.path}. Paste the full path to a folder on this machine.</p>}
          {proj?.exists && !proj.gitRoot && <p className="step-note">Works, but without git Perzian can't isolate sessions in worktrees or map changes.</p>}
          {proj?.noCommits && (
            <div className="step-fix">
              <p>Sessions branch from your latest commit, and this repo has none yet. Make a first commit, then check again.</p>
              <CopyCmd cmd={`cd ${shellQuote(proj.path)} && git add -A && git commit -m "Initial commit"`} />
              {again}
            </div>
          )}
          {proj?.detached && (
            <div className="step-fix">
              <p>Your checkout isn't on a branch, so finished work has nowhere to merge. Switch back to the branch you were on (or the one you work on), then check again.</p>
              <CopyCmd cmd={`cd ${shellQuote(proj.path)} && git switch -`} />
              {again}
            </div>
          )}
        </Step>
      </ol>

      <div className="examples" aria-label="Example tasks">
        <span className="eyebrow">Try one</span>
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="example" disabled={!ready} onClick={() => onStart(ex)}>
            <span>{ex}</span>
            <span className="example-go" aria-hidden>→</span>
          </button>
        ))}
        <p className="hint">{ready ? "Or describe your own task below." : blocker}</p>
      </div>

      {report && (
        <p className="onboard-foot">
          {codex?.installed ? `Codex ${codex.version ?? ""} available` : "Codex not installed"} · git {report.git.installed ? (report.git.version ?? "ok") : "missing"} · home <code>{report.home}</code>
        </p>
      )}
    </div>
  );
}

function signInStep(claude: AgentCheck | undefined, again: React.ReactNode, creds: Creds, recheck: () => void): { mark: Mark; meta?: string; fix?: React.ReactNode } {
  if (!claude) return { mark: "wait" };
  if (!claude.installed) return { mark: "todo" };
  const key = creds.list?.find((c) => c.provider === "anthropic");
  if (key?.set) return { mark: "ok", meta: `API key ···${key.last4}`, fix: <ApiKeyField provider="anthropic" status={key} creds={creds} onChange={recheck} /> };
  if (claude.signedIn === true) return { mark: "ok", meta: claude.authMethod };
  if (claude.signedIn === null) return { mark: "unknown", meta: "Couldn't tell. Claude Code will ask if needed." };
  return {
    mark: "bad",
    meta: "Not signed in",
    fix: (
      <div className="step-fix">
        <p>With your Claude plan: sign in once in a terminal, then check again.</p>
        <CopyCmd cmd={claude.signInCommand} />
        {again}
        <p className="or">Or use an Anthropic API key, billed per token to your API account.</p>
        <ApiKeyField provider="anthropic" status={key} creds={creds} onChange={recheck} />
      </div>
    ),
  };
}

/* ───────────── Install + API keys ───────────── */

function InstallFix({ agent, onDone, again }: { agent: AgentCheck; onDone: () => void; again: React.ReactNode }) {
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  const [output, setOutput] = useState("");
  return (
    <div className="step-fix">
      <div className="row-btns">
        <button
          type="button"
          className="btn small primary"
          disabled={state === "running"}
          onClick={async () => {
            setState("running");
            const r = await installAgent(agent.kind).catch((e: Error) => ({ ok: false, output: e.message }));
            setOutput(r.output);
            setState(r.ok ? "idle" : "failed");
            onDone();
          }}
        >
          {state === "running" ? "Installing…" : `Install ${agent.label}`}
        </button>
        {again}
      </div>
      {state === "failed" && <pre className="install-out">{output || "The installer failed."}</pre>}
      <p className="step-note">Runs the official installer. Or run it yourself:</p>
      <CopyCmd cmd={agent.installCommand} />
    </div>
  );
}

const KEY_LABEL: Record<ApiKeyProvider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

export function ApiKeyField({ provider, status, creds, onChange }: { provider: ApiKeyProvider; status?: CredentialStatus; creds: Creds; onChange?: () => void }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status?.set)
    return (
      <div className="key-set">
        <code>
          {KEY_LABEL[provider]} key ···{status.last4}
        </code>
        <button type="button" className="link-btn" onClick={() => creds.remove(provider).then(onChange)}>
          Remove
        </button>
      </div>
    );
  return (
    <form
      className="key-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const msg = await creds.save(provider, key);
        setBusy(false);
        setErr(msg);
        if (!msg) {
          setKey("");
          onChange?.();
        }
      }}
    >
      <input
        type="password"
        className="step-input"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
        autoComplete="off"
        spellCheck={false}
        aria-label={`${KEY_LABEL[provider]} API key`}
      />
      <button type="submit" className="btn small" disabled={!key.trim() || busy}>
        {busy ? "Saving…" : "Save"}
      </button>
      {err && <p className="step-note bad">{err}</p>}
    </form>
  );
}

const AGENT_KEY: Record<AgentCheck["kind"], ApiKeyProvider> = { "claude-code": "anthropic", codex: "openai" };

/** Accounts & keys, reachable any time from the sidebar. */
export function Accounts({ onClose }: { onClose: () => void }) {
  const doctor = useDoctor("", true);
  const creds = useCredentials(true);
  return (
    <div className="modal" onClick={onClose}>
      <div className="accounts" role="dialog" aria-label="Accounts and API keys" onClick={(e) => e.stopPropagation()}>
        <h2>Accounts</h2>
        <p className="onboard-sub">Agents use your subscription sign-in. Add an API key to use it instead. Keys stay on this machine (in the Keychain on macOS) and only go to that agent.</p>
        {(doctor.report?.agents ?? []).map((a) => {
          const provider = AGENT_KEY[a.kind];
          const status = creds.list?.find((c) => c.provider === provider);
          const how = !a.installed ? "Not installed" : status?.set ? "Using API key" : a.signedIn ? `Signed in${a.authMethod ? ` · ${a.authMethod}` : ""}` : a.signedIn === false ? "Not signed in" : "Sign-in unknown";
          return (
            <section key={a.kind} className="account">
              <div className="step-line">
                <span className="step-label">{a.label}</span>
                <span className="step-meta">{[a.version && `v${a.version}`, how].filter(Boolean).join(" · ")}</span>
              </div>
              {!a.installed && <InstallFix agent={a} onDone={doctor.recheck} again={null} />}
              <ApiKeyField provider={provider} status={status} creds={creds} onChange={doctor.recheck} />
            </section>
          );
        })}
        {!doctor.report && <p className="quiet">{doctor.failed ? "Couldn't reach the daemon." : "Checking…"}</p>}
      </div>
    </div>
  );
}

/* ───────────── Daemon offline ───────────── */

/** The daemon answered but refused this page: it only takes Perzian's own UI. */
export function DaemonRefused() {
  return (
    <div className="onboard">
      <span className="offline-mark" aria-hidden />
      <h2>The daemon is running, but refused this page</h2>
      <p className="onboard-sub">
        Perzian only takes requests from its own window, so other pages on this machine can't drive your agents. Open it at{" "}
        <a href="http://localhost:4318">http://localhost:4318</a> or use the desktop app.
      </p>
    </div>
  );
}

export function DaemonOffline() {
  return (
    <div className="onboard">
      <span className="offline-mark" aria-hidden />
      <h2>The Perzian daemon isn't running</h2>
      {isDesktop ? (
        <p className="onboard-sub">The app couldn't reach {DAEMON_ADDR}. Quit Perzian and open it again; it starts the daemon for you.</p>
      ) : (
        <>
          <p className="onboard-sub">This page talks to {DAEMON_ADDR}, which runs your agents. Start it from the repo root:</p>
          <CopyCmd cmd="npm run dev" />
        </>
      )}
      <p className="reconnect">
        <span className="dot s-working" /> Reconnecting on its own
      </p>
    </div>
  );
}

export function OfflineBanner() {
  return (
    <div className="banner" role="status">
      <span className="dot s-failed" />
      Daemon offline. Showing the last state; reconnecting. {isDesktop ? "Reopen the app if this persists." : <>Start it with <code>npm run dev</code>.</>}
    </div>
  );
}

/* ───────────── Failures ───────────── */

const FAILURE = /^(Agent exited|Error:|Interrupted)/;
export const isFailureNotice = (text: string) => FAILURE.test(text);

/** A one-line reason and what to do, from the daemon's notice text. */
export function explainFailure(text: string): { title: string; reason: string; fix: string } {
  const title = text.startsWith("Agent exited") ? "Agent exited" : text.startsWith("Interrupted") ? "Interrupted" : "Turn failed";
  const exit = /^Agent exited \(([^)]*)\)\.?\s*/.exec(text);
  let reason = (exit ? text.slice(exit[0].length) : text.replace(/^Error:\s*/, "").replace(/^Interrupted:\s*/, "")).trim();
  if (!reason) reason = exit ? `exit code ${exit[1]}` : "no details";
  reason = reason.split("\n")[0];
  if (reason.length > 160) reason = `${reason.slice(0, 157)}…`;
  const fix =
    /codex CLI not found/i.test(text)
      ? "Install Codex (npm install -g @openai/codex), then Retry."
      : /CLI not found|ENOENT|command not found|not an executable/i.test(text)
      ? "Install Claude Code (curl -fsSL https://claude.ai/install.sh | bash), then Retry."
      : /log ?in|logged in|authenticat|\b401\b|api key|\/login|credential/i.test(text)
        ? "Sign in to this agent (claude auth login or codex login in a terminal), or add an API key under Accounts & API keys, then Retry."
        : /rate.?limit|\b429\b|overloaded|\b529\b|quota|usage limit/i.test(text)
          ? "The model is busy or you hit a usage limit. Wait a moment, then Retry."
          : /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket/i.test(text)
            ? "Couldn't reach the model. Check your connection, then Retry."
            : title === "Interrupted"
              ? "The daemon restarted mid-turn. Retry to send the last message again."
              : "Retry, or open the transcript for the full log.";
  return { title, reason, fix };
}

export function FailureNotice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const f = explainFailure(text);
  return (
    <div className="failure" role="alert">
      <div className="failure-line">
        <span className={`dot ${f.title === "Interrupted" ? "s-idle" : "s-failed"}`} />
        <b>{f.title}</b>
        <span className="failure-reason" title={text}>{f.reason}</span>
        {onRetry && (
          <button type="button" className="btn small" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
      <p className="failure-fix">{f.fix}</p>
    </div>
  );
}

/** Daemon error messages, rewritten as what happened + what to do. */
export function friendlyError(msg: string): { what: string; fix: string } {
  if (/Not connected/i.test(msg))
    return { what: "Can't reach the Perzian daemon.", fix: isDesktop ? "Reopen the app, then try again." : "Start it with npm run dev, then try again." };
  const nf = /Project folder not found: (.*)/.exec(msg);
  if (nf) return { what: `Folder not found: ${nf[1]}`, fix: "Check the path and try again." };
  if (/unknown session|no such session/i.test(msg)) return { what: "That session is gone from the daemon.", fix: "Reload the page to resync." };
  if (/codex CLI not found/i.test(msg)) return { what: "Codex isn't installed.", fix: "Install it from Accounts & API keys, or run npm install -g @openai/codex, then try again." };
  if (/CLI not found/i.test(msg)) return { what: "Claude Code isn't installed.", fix: "Install it from Accounts & API keys, or run curl -fsSL https://claude.ai/install.sh | bash, then try again." };
  if (/agent exited/i.test(msg)) return { what: "The agent stopped while starting.", fix: "Check it's installed and signed in under Accounts & API keys, then try again." };
  // Daemon messages that already say what to do: first sentence is what happened, the rest is the fix.
  const split = /^(.*?(?:no commits yet|detached HEAD|already merged)[^.]*\.)\s*(.*)$/i.exec(msg);
  if (split) return { what: split[1], fix: split[2] || "Start a new session." };
  if (/not a git repo|worktree/i.test(msg)) return { what: msg.replace(/\.$/, "") + ".", fix: "Turn off “own git worktree” or pick a git repo." };
  return { what: msg.replace(/\.$/, "") + ".", fix: "Try again; if it keeps happening, check the daemon's terminal output." };
}

/* ───────────── Keyboard help ───────────── */

const SHORTCUTS: [string, string][] = [
  ["N", "New session"],
  ["/", "Talk to Perzian"],
  ["1–9", "Answer the first decision card"],
  ["Esc", "Close panel or dialog"],
  ["?", "Show these shortcuts"],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="keys" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Shortcuts</h2>
        <dl>
          {SHORTCUTS.map(([k, label]) => (
            <div key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
