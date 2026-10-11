import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangeKind, FileChange, LeftoverWorktree, SessionInfo } from "@perzian/protocol";

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
export async function worktreeBlocker(project: string): Promise<string | undefined> {
  if (!(await head(project))) return `This repo has no commits yet, so there's nothing to branch from. Make a first commit (git add -A && git commit -m "Initial commit"), then start the session.`;
  if (!(await currentBranch(project))) return "Your checkout is on a detached HEAD, so there's no branch to merge the work back into. Check out a branch (git switch <branch>), then start the session.";
  return undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";

export async function createWorktree(project: string, home: string, title: string, id: string): Promise<{ path: string; branch: string; baseBranch: string }> {
  const blocked = await worktreeBlocker(project);
  if (blocked) throw new Error(blocked);
  const baseBranch = (await currentBranch(project))!;
  const branch = `perzian/${slug(title)}-${id.slice(0, 6)}`;
  const dir = join(home, "worktrees", basename(project));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug(title)}-${id.slice(0, 6)}`);
  await git(project, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, branch, baseBranch };
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
export async function pullRequest(cwd: string): Promise<{ url: string; state: string } | undefined> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", "--json", "url,state"], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 });
    const pr = JSON.parse(stdout) as { url?: string; state?: string };
    return pr.url && pr.state ? { url: pr.url, state: pr.state } : undefined;
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
