// GitHub through the developer's own `gh` login: "Connected as <user>" for the doctor. Read-only
// (`gh auth status`), never reads the token, and the runner is injectable so tests never touch gh.
import { execFile } from "node:child_process";
import type { GitHubCheck } from "@perzian/protocol";
import { remoteHost } from "./ship.ts";

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  /** The binary isn't installed. */
  missing?: boolean;
}
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<RunResult>;

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((done) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 8000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: string | number }) | null;
        done({ ok: !e, out: String(stdout ?? ""), err: String(stderr || e?.message || ""), ...(e?.code === "ENOENT" ? { missing: true } : {}) });
      },
    );
    child.stdin?.end();
  });

/** The project's origin host, or github.com when it has none. */
export async function projectHost(gitRoot: string | undefined, runner: Runner = run): Promise<string> {
  if (!gitRoot) return "github.com";
  const r = await runner("git", ["remote", "get-url", "origin"], { cwd: gitRoot, timeout: 3000 });
  return (r.ok && remoteHost(r.out)) || "github.com";
}

/** Whether the repo's origin is on GitHub (github.com or a *github* enterprise host): PR is the default ship action then. */
export async function hasGithubOrigin(gitRoot: string, runner: Runner = run): Promise<boolean> {
  const r = await runner("git", ["remote", "get-url", "origin"], { cwd: gitRoot, timeout: 3000 });
  const host = r.ok ? remoteHost(r.out) : undefined;
  return !!host && host.includes("github");
}

/** The leading ship action: perzian.json's "ship" wins; otherwise PR when the repo has a GitHub origin, else Merge. */
export const shipPreference = (configured: "pr" | "merge" | undefined, githubOrigin: boolean): "pr" | "merge" => configured ?? (githubOrigin ? "pr" : "merge");

export function ghInstall(platform = process.platform): { installCommand?: string; installUrl: string } {
  const installUrl = "https://cli.github.com";
  if (platform === "darwin") return { installCommand: "brew install gh", installUrl };
  if (platform === "win32") return { installCommand: "winget install --id GitHub.cli", installUrl };
  return { installUrl };
}

/** Who gh is signed in as on `host`. Never reads or returns the token. */
export async function githubCheck(host: string, runner: Runner = run, platform = process.platform): Promise<GitHubCheck> {
  const base = { host, ...ghInstall(platform), signInCommand: host === "github.com" ? "gh auth login" : `gh auth login --hostname ${host}` };
  const r = await runner("gh", ["auth", "status", "--hostname", host, "--json", "hosts"], { timeout: 8000 });
  if (r.missing) return { ...base, ghInstalled: false, signedIn: false };
  try {
    const j = JSON.parse(r.out) as { hosts?: Record<string, { state?: string; active?: boolean; login?: string }[]> };
    const ok = (j.hosts?.[host] ?? []).filter((a) => a.state === "success");
    const user = (ok.find((a) => a.active) ?? ok[0])?.login;
    return { ...base, ghInstalled: true, signedIn: !!user, ...(user ? { user } : {}) };
  } catch {
    // Older gh without `auth status --json`: read the text report.
    const text = `${r.out}\n${r.err}`;
    const m = /Logged in to (\S+) (?:account|as) (\S+)/.exec(text);
    if (m && m[1] === host) return { ...base, ghInstalled: true, signedIn: true, user: m[2].replace(/[()]/g, "") };
    if (/not logged in|gh auth login/i.test(text)) return { ...base, ghInstalled: true, signedIn: false };
    return { ...base, ghInstalled: true, signedIn: null };
  }
}
