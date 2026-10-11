import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionInfo, ShipState } from "@perzian/protocol";

// "Ship it": land a worktree session's work. Merge commits whatever the agent left, merges the branch
// into the developer's checkout (which must be on the branch the session started from, and clean),
// then removes the worktree. A conflict aborts the merge and reports the files; nothing is left half-done.
// PR pushes the branch and opens a pull request with gh, keeping the worktree for follow-ups.

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

const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 300);

export async function ship(info: SessionInfo, how: "merge" | "pr", stop: () => void): Promise<ShipState> {
  const fail = (detail: string): ShipState => ({ state: "error", how, detail, at: Date.now() });
  if (!info.worktree || !info.branch) return fail("This session worked in your checkout directly, so there's no branch to ship.");
  const wt = info.cwd;
  const branch = info.branch;

  // What the agent left uncommitted becomes one commit named after the session.
  await run(wt, "git", ["add", "-A"]);
  if (!(await run(wt, "git", ["diff", "--cached", "--quiet"])).ok) {
    const c = await run(wt, "git", ["commit", "-m", info.title]);
    if (!c.ok) return fail(`Couldn't commit the session's changes: ${tail(c.err || c.out)}`);
  }

  if (how === "pr") {
    const push = await run(wt, "git", ["push", "-u", "origin", branch]);
    if (!push.ok) return fail(`Push failed: ${tail(push.err)}`);
    const args = ["pr", "create", "--head", branch, "--fill", ...(info.baseBranch ? ["--base", info.baseBranch] : [])];
    const pr = await run(wt, "gh", args);
    if (pr.ok) return { state: "pr", how, url: pr.out.trim().split("\n").pop(), at: Date.now() };
    if (pr.err.startsWith("ENOENT")) return fail("The GitHub CLI isn't installed. Install gh and run gh auth login, then try again.");
    const existing = await run(wt, "gh", ["pr", "view", branch, "--json", "url", "-q", ".url"]);
    if (existing.ok && existing.out.trim()) return { state: "pr", how, url: existing.out.trim(), at: Date.now() };
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
  const rm = await run(project, "git", ["worktree", "remove", wt]);
  if (rm.ok) await run(project, "git", ["branch", "-d", branch]);
  return { state: "merged", how, into, ...(rm.ok ? {} : { detail: "Merged. The worktree folder was left in place." }), at: Date.now() };
}
