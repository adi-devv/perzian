import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ChangeKind, FileChange } from "@perzian/protocol";

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
