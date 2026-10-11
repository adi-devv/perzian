import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangeKind, FileChange, LeftoverWorktree, SessionInfo } from "@perzian/protocol";
import { PR_FIELDS, parsePrView, type PrView } from "./prstatus.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], okCodes = [0]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (typeof err.code === "number" && okCodes.includes(err.code)) return err.stdout ?? "";
    throw e;
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

export async function head(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ["rev-parse", "HEAD"])).trim();
  } catch {
    return undefined;
  }
}

/** The checked-out branch; undefined on a detached HEAD (git prints "HEAD") or outside a repo. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const b = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return b && b !== "HEAD" ? b : undefined;
  } catch {
    return undefined;
  }
}

/** Why a worktree can't be cut from `project` right now, or undefined when it can. */
export async function worktreeBlocker(project: string, base?: string): Promise<string | undefined> {
  if (!(await head(project))) return `This repo has no commits yet, so there's nothing to branch from. Make a first commit (git add -A && git commit -m "Initial commit"), then start the session.`;
  // A detached checkout is fine as long as there's a branch to start from (and to merge or PR back into).
  if (!base?.trim() && !(await defaultBranch(project)))
    return "Your checkout is on a detached HEAD and there's no main or master branch to start from. Pick a base branch, or check out a branch (git switch <branch>), then start the session.";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Base branches. A worktree session starts from a base branch (default: the repo's default branch),
// freshly fetched from origin when there is one. The developer's own checkout is never touched: fetch
// only moves origin/<base>, and the worktree is cut from that commit.

export const FETCH_TIMEOUT_MS = 15_000;

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function hasOrigin(cwd: string): Promise<boolean> {
  try {
    return !!(await git(cwd, ["remote", "get-url", "origin"])).trim();
  } catch {
    return false;
  }
}

/** The repo's default branch: origin/HEAD, else main or master (local or on origin), else the checked-out branch. */
export async function defaultBranch(project: string): Promise<string | undefined> {
  try {
    const ref = (await git(project, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (ref.startsWith("origin/") && ref !== "origin/HEAD") return ref.slice("origin/".length);
  } catch {}
  for (const name of ["main", "master"]) {
    if ((await refExists(project, `refs/heads/${name}`)) || (await refExists(project, `refs/remotes/origin/${name}`))) return name;
  }
  return currentBranch(project);
}

const MAX_BRANCHES = 1000;

/** Local and origin branches by name, `origin/x` and `x` once: the default branch first, then most recently committed. */
export async function listBranches(project: string): Promise<{ repo: boolean; branches: string[]; default?: string }> {
  if (!(await isRepo(project))) return { repo: false, branches: [] };
  const out = await git(project, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]).catch(() => "");
  const names = new Set<string>();
  for (const ref of out.split("\n")) {
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : "";
    if (name && name !== "HEAD") names.add(name);
  }
  const def = await defaultBranch(project);
  const branches = [...names];
  if (def && names.has(def)) branches.splice(branches.indexOf(def), 1), branches.unshift(def);
  return { repo: true, branches: branches.slice(0, MAX_BRANCHES), ...(def ? { default: def } : {}) };
}

async function validBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-") || name.includes("@{")) return false;
  try {
    await git(cwd, ["check-ref-format", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** git fetch origin <base>, updating only origin/<base>. Never prompts; gives up after `timeoutMs`. */
async function fetchBase(project: string, base: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; missing: boolean }> {
  try {
    await exec("git", ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], {
      cwd: project,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, missing: /couldn't find remote ref/i.test((e as { stderr?: string }).stderr ?? "") };
  }
}

export interface BaseStart {
  /** Branch name the session is based on ("main"); PRs target it and Merge lands into it. */
  base: string;
  /** The commit the worktree starts from. */
  sha: string;
  /** What that commit was read from: "origin/main" or "main". */
  from: string;
  /** Set when the fresh fetch didn't happen, e.g. "Couldn't fetch origin; started from your local main." */
  notice?: string;
}

/** Resolves where a new worktree starts: fetch origin <base>, then origin/<base> when it exists, else local <base>. */
export async function resolveBase(project: string, requested?: string, opts: { fetchTimeoutMs?: number } = {}): Promise<BaseStart> {
  let base = requested?.trim() || (await defaultBranch(project));
  if (!base) throw new Error("There's no branch to start from: your checkout is on a detached HEAD and there's no main or master. Pick a base branch.");
  if (base.startsWith("refs/heads/")) base = base.slice("refs/heads/".length);
  else if (base.startsWith("origin/") && !(await refExists(project, `refs/heads/${base}`))) base = base.slice("origin/".length);
  if (!(await validBranchName(project, base))) throw new Error(`"${base}" isn't a valid branch name. Pick a base branch from the list.`);

  const remote = `refs/remotes/origin/${base}`;
  const local = `refs/heads/${base}`;
  // Another session's branch (stacking): the local branch is the truth, it may not be pushed at all.
  const stacked = isSessionBranch(base) && (await refExists(project, local));
  const fetched = !stacked && (await hasOrigin(project)) ? await fetchBase(project, base, opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS) : undefined;
  let ref: string | undefined;
  if (stacked) ref = local;
  else if (fetched?.ok && (await refExists(project, remote))) ref = remote;
  else if (await refExists(project, local)) ref = local;
  else if (await refExists(project, remote)) ref = remote;
  if (!ref) throw new Error(`There's no branch named ${base}, locally or on origin. Pick another base branch.`);

  const from = ref === remote ? `origin/${base}` : base;
  let notice: string | undefined;
  if (fetched && !fetched.ok) {
    notice = fetched.missing
      ? `${base} isn't on origin; started from your local ${base}.`
      : ref === local
        ? `Couldn't fetch origin; started from your local ${base}.`
        : `Couldn't fetch origin; started from origin/${base} as last fetched.`;
  }
  const sha = (await git(project, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  return { base, sha, from, ...(notice ? { notice } : {}) };
}

/** A branch Perzian made for a session (perzian/<slug>-<id>): a base that is another session's work. */
export const isSessionBranch = (name: string): boolean => name.startsWith("perzian/");

/** The ref a session's base lives at now: the parent session's local branch when stacked, else origin/<base> when it exists, else local <base>. */
async function baseRef(cwd: string, base: string): Promise<string | undefined> {
  const candidates = isSessionBranch(base) ? [`refs/heads/${base}`] : [`refs/remotes/origin/${base}`, `refs/heads/${base}`];
  for (const ref of candidates) if (await refExists(cwd, ref)) return ref;
  return undefined;
}

/** `git rev-list --count` output as a number; undefined for anything else. */
export function parseBehind(out: string): number | undefined {
  const t = out.trim();
  return /^\d+$/.test(t) ? Number(t) : undefined;
}

/** Moves origin/<base> forward (a fetch of just that branch); false when it can't (offline, no origin, no such branch). Never prompts. */
export async function refreshBase(cwd: string, base: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<boolean> {
  if (isSessionBranch(base) || !(await hasOrigin(cwd))) return false;
  return (await fetchBase(cwd, base, timeoutMs)).ok;
}

/** How far the base has moved: commits on it that HEAD doesn't have. Undefined when the base can't be read. */
export async function behindBase(cwd: string, base: string): Promise<number | undefined> {
  const ref = await baseRef(cwd, base);
  if (!ref) return undefined;
  const r = await gitCode(cwd, ["rev-list", "--count", `HEAD..${ref}`]);
  return r.code === 0 ? parseBehind(r.out) : undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";

export async function createWorktree(
  project: string,
  home: string,
  title: string,
  id: string,
  opts: { base?: string; fetchTimeoutMs?: number } = {},
): Promise<{ path: string; branch: string; baseBranch: string; baseSha: string; notice?: string }> {
  const blocked = await worktreeBlocker(project, opts.base);
  if (blocked) throw new Error(blocked);
  const start = await resolveBase(project, opts.base, opts);
  const branch = `perzian/${slug(title)}-${id.slice(0, 6)}`;
  const dir = join(home, "worktrees", basename(project));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug(title)}-${id.slice(0, 6)}`);
  // From the commit itself, so the new branch doesn't track origin/<base>; the checkout is left alone.
  await git(project, ["worktree", "add", "-b", branch, path, start.sha]);
  return { path, branch, baseBranch: start.base, baseSha: start.sha, ...(start.notice ? { notice: start.notice } : {}) };
}

const KIND: Record<string, ChangeKind> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified", C: "added" };

// Everything that differs between `base` and the working tree, including untracked files.
export async function changes(cwd: string, base: string): Promise<FileChange[]> {
  const files = new Map<string, FileChange>();
  const status = await git(cwd, ["diff", "--name-status", "-M", base]);
  for (const line of status.split("\n").filter(Boolean)) {
    const [code, a, b] = line.split("\t");
    const path = b ?? a;
    files.set(path, { path, kind: KIND[code[0]] ?? "modified", additions: 0, deletions: 0 });
  }
  const num = await git(cwd, ["diff", "--numstat", "-M", base]);
  for (const line of num.split("\n").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    let path = rest.join("\t");
    const m = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/) ?? path.match(/^()(.*) => (.*)()$/);
    if (m) path = `${m[1]}${m[3]}${m[4]}`.replace("//", "/");
    const f = files.get(path);
    if (f) {
      f.additions = add === "-" ? 0 : Number(add);
      f.deletions = del === "-" ? 0 : Number(del);
    }
  }
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.split("\n").filter(Boolean)) {
    let lines = 0;
    try {
      const full = join(cwd, path);
      if (statSync(full).size < 2_000_000) {
        const text = readFileSync(full, "utf8");
        lines = text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0); // match git's line count
      }
    } catch {}
    files.set(path, { path, kind: "added", additions: lines, deletions: 0 });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function inside(cwd: string, path: string): string {
  const root = resolve(cwd);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) throw new Error("path outside session");
  return full;
}

export async function fileDiff(cwd: string, base: string, path: string): Promise<string> {
  inside(cwd, path);
  const tracked = await git(cwd, ["diff", "-M", base, "--", path]);
  if (tracked.trim()) return tracked;
  return git(cwd, ["diff", "--no-index", "--", "/dev/null", path], [0, 1]);
}

export function fileContent(cwd: string, path: string): string {
  // Resolve symlinks too: a link inside the worktree must not expose files outside it.
  const full = inside(realpathSync(cwd), realpathSync(inside(cwd, path)));
  if (statSync(full).size > 1_000_000) return "(file too large to show)";
  return readFileSync(full, "utf8");
}

// ---- Observation: what the agent did to the repo on its own (see observe.ts, session.ts) ----

/** Runs git and returns its exit code and output without throwing on a non-zero exit. */
async function gitCode(cwd: string, args: string[]): Promise<{ code: number | undefined; out: string }> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string };
    return { code: typeof err.code === "number" ? err.code : undefined, out: err.stdout ?? "" };
  }
}

export interface WorktreeEntry {
  path: string;
  branch?: string;
  head?: string;
  bare?: boolean;
  prunable?: boolean;
}

/** `git worktree list --porcelain` parsed. The first entry is the repo's main working tree. */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    let cur: WorktreeEntry | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) cur = { path: line.slice("worktree ".length) };
      else if (!cur) continue;
      else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") cur.bare = true;
      else if (line.startsWith("prunable")) cur.prunable = true;
    }
    if (cur) out.push(cur);
  }
  return out;
}

export async function worktrees(cwd: string): Promise<WorktreeEntry[]> {
  const r = await gitCode(cwd, ["worktree", "list", "--porcelain"]);
  return r.code === 0 ? parseWorktrees(r.out) : [];
}

/** Commits on HEAD beyond `base`. */
export async function aheadCount(cwd: string, base: string): Promise<number | undefined> {
  const r = await gitCode(cwd, ["rev-list", "--count", `${base}..HEAD`]);
  return r.code === 0 ? Number(r.out.trim()) : undefined;
}

/** Whether the branch has an upstream, and how many commits on HEAD it doesn't have yet. */
export async function upstreamState(cwd: string): Promise<{ upstream: boolean; unpushed: number }> {
  const up = await gitCode(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.code !== 0) return { upstream: false, unpushed: 0 };
  const n = await gitCode(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
  return { upstream: true, unpushed: n.code === 0 ? Number(n.out.trim()) : 0 };
}

/** True/false when `a` is/isn't an ancestor of `b`; undefined when git can't tell (unknown commit). */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean | undefined> {
  const r = await gitCode(cwd, ["merge-base", "--is-ancestor", a, b]);
  return r.code === 0 ? true : r.code === 1 ? false : undefined;
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const r = await gitCode(cwd, ["merge-base", a, b]);
  const sha = r.out.trim();
  return r.code === 0 && sha ? sha : undefined;
}

/** The branch's pull request via gh, or undefined (no gh, no PR, not signed in: all ignored). */
export async function pullRequest(cwd: string, branch?: string): Promise<PrView | undefined> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", ...(branch ? [branch] : []), "--json", PR_FIELDS], { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return parsePrView(stdout);
  } catch {
    return undefined;
  }
}

/** A path with symlinks resolved, even when it doesn't exist yet (its nearest existing ancestor is resolved). */
export function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {}
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

export type { LeftoverWorktree };

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Branch and owning repo of a linked worktree, from its `.git` file (no git process). */
function worktreeFacts(path: string): { branch?: string; project?: string } {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"))?.[1].trim();
    if (!gitdir) return {};
    const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitdir, "HEAD"), "utf8"))?.[1].trim();
    // <repo>/.git/worktrees/<name> -> <repo>
    const common = dirname(dirname(gitdir));
    return { ...(head ? { branch: head } : {}), ...(basename(common) === ".git" ? { project: dirname(common) } : {}) };
  } catch {
    return {};
  }
}

/**
 * Removes one leftover worktree (a path from `leftoverWorktrees`) with plain `git worktree remove`: no --force,
 * so git itself also refuses on locked or dirty trees. Refuses first when there are uncommitted changes
 * (untracked files included). Never touches branches. Throws with a short reason when it refuses.
 */
export async function removeLeftoverWorktree(home: string, sessions: Parameters<typeof leftoverWorktrees>[1], path: string): Promise<void> {
  const target = realish(path);
  const w = leftoverWorktrees(home, sessions).find((l) => realish(l.path) === target);
  if (!w) throw new Error("Not a leftover worktree (it may be in use, or already gone)");
  if (!w.project) throw new Error("Can't tell which repository it belongs to");
  let dirty = "";
  try {
    dirty = await git(w.path, ["status", "--porcelain", "--untracked-files=all"]);
  } catch (e) {
    throw new Error(`Can't read its status: ${gitMessage(e)}`);
  }
  const files = dirty.split("\n").filter((l) => l.trim()).length;
  if (files) throw new Error(`Has uncommitted changes (${files} file${files === 1 ? "" : "s"}): kept. Commit or discard them first.`);
  try {
    await git(w.project, ["worktree", "remove", w.path]);
  } catch (e) {
    throw new Error(gitMessage(e));
  }
}

function gitMessage(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || String(e)).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
}

/** Folders under $PERZIAN_HOME/worktrees (<repo>/<name>) no live session works in: archived or merged sessions leave them behind. */
export function leftoverWorktrees(home: string, sessions: Pick<SessionInfo, "id" | "cwd" | "worktree" | "archived" | "ship">[]): LeftoverWorktree[] {
  const root = join(home, "worktrees");
  const owner = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) if (s.worktree) owner.set(realish(s.cwd), s);
  const dirs = (d: string) => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const out: LeftoverWorktree[] = [];
  for (const repo of dirs(root)) {
    for (const name of dirs(join(root, repo))) {
      const path = join(root, repo, name);
      const s = owner.get(realish(path));
      if (s && !s.archived && s.ship?.state !== "merged") continue; // live
      const f = worktreeFacts(path);
      let at: number | undefined;
      try {
        at = statSync(path).mtimeMs;
      } catch {}
      out.push({ path, repo, name, ...(s ? { sessionId: s.id } : {}), ...f, ...(at ? { at } : {}), ...(f.project ? { command: `git -C ${shq(f.project)} worktree remove ${shq(path)}` } : {}) });
    }
  }
  return out;
}
