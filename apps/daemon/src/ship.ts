import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionInfo, ShipState } from "@perzian/protocol";

// "Ship it": land a worktree session's work. Merge commits what the agent changed (never ignored or
// secret-looking files), merges the branch into the developer's checkout (which must be on the branch the
// session started from, and clean), then removes the worktree. A conflict aborts the merge and reports
// the files; nothing is left half-done. PR first checks gh can open one, then pushes the branch and opens
// a pull request, keeping the worktree for follow-ups.

const exec = promisify(execFile);

async function run(cwd: string, cmd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    return { ok: true, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string; code?: string | number };
    return { ok: false, out: x.stdout ?? "", err: (x.code === "ENOENT" ? "ENOENT " : "") + (x.stderr || x.message || "") };
  }
}

/** The lines of git/gh output worth showing: errors and the file lists under them, else the last few. */
export function tail(s: string, max = 600): string {
  const lines = s.split("\n").filter((l) => l.trim());
  const key = lines.filter((l) => /\b(fatal|error)\b:|^\s+\S|^\s*!/i.test(l) && !/^\s*hint:/i.test(l));
  return (key.length ? key : lines.slice(-3)).map((l) => l.trim()).join(" ").slice(0, max);
}

// Files that look like secrets stay out of the commit even when they aren't gitignored.
const SECRET = [/^\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /^\.(netrc|npmrc|pypirc)$/];
const TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/;
export function isSensitive(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return !TEMPLATE.test(name) && SECRET.some((re) => re.test(name));
}

/** Paths from `git status --porcelain -z`, split into what to commit and what to leave out. */
export function stageable(porcelainZ: string): { add: string[]; skipped: string[] } {
  const add: string[] = [];
  const skipped: string[] = [];
  const fields = porcelainZ.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const paths = [f.slice(3)];
    if (/[RC]/.test(f.slice(0, 2))) paths.push(fields[++i]); // rename/copy: the origin path follows
    for (const p of paths.filter(Boolean)) (isSensitive(p) ? skipped : add).push(p);
  }
  return { add, skipped };
}

/** A session whose work was merged has no worktree left to run in. */
export function assertPromptable(info: SessionInfo): void {
  if (info.worktree && info.ship?.state === "merged")
    throw new Error(`This session was already merged into ${info.ship.into ?? "your branch"}, so it's closed. Start a new session to keep going.`);
}

/** A ship the daemon was killed in the middle of: say so, and let it be tried again. */
export const interruptedShip = (prev: ShipState): ShipState => ({
  state: "error",
  how: prev.how,
  detail: `Interrupted: the daemon restarted while ${prev.how === "pr" ? "opening the PR" : "merging"}. Check your checkout${prev.how === "pr" ? " and GitHub" : ""}, then try again.`,
  at: Date.now(),
});

/** Host of a git remote URL (https, ssh://, or scp-like git@host:path). */
export function remoteHost(url: string): string | undefined {
  const u = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return scp[1].toLowerCase();
  try {
    return new URL(u).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Why a PR can't be opened from `cwd`, checked before anything is pushed. */
async function prBlocker(cwd: string): Promise<string | undefined> {
  const origin = await run(cwd, "git", ["remote", "get-url", "origin"]);
  if (!origin.ok || !origin.out.trim()) return "This repo has no origin remote to push to. Add your GitHub repo (git remote add origin <url>), or merge instead.";
  const host = remoteHost(origin.out);
  if (!host) return `origin (${origin.out.trim()}) isn't a GitHub remote. Open the PR from your git host, or merge instead.`;
  const gh = await run(cwd, "gh", ["--version"]);
  if (!gh.ok) return gh.err.startsWith("ENOENT") ? "The GitHub CLI isn't installed. Install gh and run gh auth login, then try again." : `The GitHub CLI isn't working: ${tail(gh.err)}`;
  const auth = await run(cwd, "gh", ["auth", "status", "--hostname", host]);
  if (!auth.ok) return host === "github.com" || host.endsWith(".github.com") ? "The GitHub CLI isn't signed in. Run gh auth login, then try again." : `origin points at ${host}, which isn't a GitHub host gh is signed in to. Open the PR there, or merge instead.`;
  return undefined;
}

export const isShipHow = (how: unknown): how is "merge" | "pr" => how === "merge" || how === "pr";

/** Why shipping now would take the worktree out from under an agent still at work in it. */
export function busyReason(info: SessionInfo): string | undefined {
  if (info.status === "working" || info.status === "needs_you") return "Wait for the agent to finish (or stop it), then ship.";
  if (info.status === "paused") return "This session is paused at a usage limit and picks up again later. Wait for it to finish (or stop it), then ship.";
  if (info.setup?.state === "running") return "The worktree is still being set up. Wait for it to finish, then ship.";
  return undefined;
}

export async function ship(info: SessionInfo, how: "merge" | "pr", stop: () => void): Promise<ShipState> {
  if (!isShipHow(how)) throw new Error(`Unknown ship method: ${String(how)}`);
  const fail = (detail: string): ShipState => ({ state: "error", how, detail, at: Date.now() });
  const busy = busyReason(info);
  if (busy) return fail(busy);
  if (!info.worktree || !info.branch) return fail("This session worked in your checkout directly, so there's no branch to ship.");
  const wt = info.cwd;
  const branch = info.branch;

  if (how === "pr") {
    const blocked = await prBlocker(wt);
    if (blocked) return fail(blocked);
  }

  // What the agent left uncommitted becomes one commit named after the session. git status already
  // drops ignored files; secret-looking ones are left in the worktree, uncommitted.
  const status = await run(wt, "git", ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!status.ok) return fail(`Couldn't read the session's changes: ${tail(status.err)}`);
  const { add, skipped } = stageable(status.out);
  for (let i = 0; i < add.length; i += 200) {
    const a = await run(wt, "git", ["--literal-pathspecs", "add", "-A", "--", ...add.slice(i, i + 200)]);
    if (!a.ok) return fail(`Couldn't stage the session's changes: ${tail(a.err)}`);
  }
  if (!(await run(wt, "git", ["diff", "--cached", "--quiet"])).ok) {
    const c = await run(wt, "git", ["commit", "-m", info.title]);
    if (!c.ok) return fail(`Couldn't commit the session's changes: ${tail(c.err || c.out)}`);
  }
  const left = skipped.length ? `Left out ${skipped.join(", ")} (looks like secrets); ${skipped.length === 1 ? "it's" : "they're"} still in the worktree.` : undefined;

  if (how === "pr") {
    const push = await run(wt, "git", ["push", "-u", "origin", branch]);
    if (!push.ok) return fail(`Push failed: ${tail(push.err)}`);
    const args = ["pr", "create", "--head", branch, "--fill", ...(info.baseBranch ? ["--base", info.baseBranch] : [])];
    const pr = await run(wt, "gh", args);
    if (pr.ok) return { state: "pr", how, url: pr.out.trim().split("\n").pop(), ...(left ? { detail: left } : {}), at: Date.now() };
    const existing = await run(wt, "gh", ["pr", "view", branch, "--json", "url", "-q", ".url"]);
    if (existing.ok && existing.out.trim()) return { state: "pr", how, url: existing.out.trim(), ...(left ? { detail: left } : {}), at: Date.now() };
    return fail(`Couldn't open the PR: ${tail(pr.err)}`);
  }

  const project = info.project;
  const into = (await run(project, "git", ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  if (!into || into === "HEAD") return fail("Your checkout isn't on a branch. Check one out, then merge.");
  if (info.baseBranch && into !== info.baseBranch) return fail(`Your checkout is on ${into}, but this session started from ${info.baseBranch}. Switch to ${info.baseBranch}, or open a PR instead.`);
  const dirty = (await run(project, "git", ["status", "--porcelain", "--untracked-files=no"])).out.trim();
  if (dirty) return fail(`Your checkout has uncommitted changes in ${dirty.split("\n").length} file(s). Commit or stash them, then merge.`);
  const ahead = await run(project, "git", ["rev-list", "--count", `${into}..${branch}`]);
  if (ahead.ok && ahead.out.trim() === "0") return fail("Nothing to merge: the branch has no new commits.");

  const m = await run(project, "git", ["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch}: ${info.title}`, branch]);
  if (!m.ok) {
    const files = (await run(project, "git", ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
    await run(project, "git", ["merge", "--abort"]);
    return files.length ? { state: "conflict", how, into, files, at: Date.now() } : fail(`Merge failed: ${tail(m.err || m.out)}`);
  }

  stop();
  // The merged work now lives in the checkout. Remove the session's worktree folder (never with --force:
  // a worktree still holding left-out files stays) and keep the branch. The result records which.
  const rm = skipped.length ? { ok: false } : await run(project, "git", ["worktree", "remove", wt]);
  const detail = [left, rm.ok ? undefined : `The worktree folder was left in place: ${wt}`].filter(Boolean).join(" ");
  return { state: "merged", how, into, worktreeRemoved: rm.ok, ...(detail ? { detail: `Merged. ${detail}` } : {}), at: Date.now() };
}
