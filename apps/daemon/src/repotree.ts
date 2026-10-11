// The repo's real file structure for the Map (a treemap): every tracked and untracked, not ignored, file
// with its size in bytes, folded into a folder tree. Sizes come from `git ls-tree -l` (one command, no file
// reads); only files git doesn't know at HEAD are stat'ed. The UI lays it out; nothing here is invented.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { RepoTree } from "@perzian/protocol";

const exec = promisify(execFile);
/** Past this many files the rest are left out (the Map aggregates small files anyway). */
export const MAX_TREE_FILES = 200_000;
const CACHE_MS = 4000;

const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 })).stdout;

/** Fold `[path, bytes]` pairs ("/"-separated, relative) into a tree; folders sum their children, children are biggest first. */
export function buildRepoTree(entries: Iterable<[string, number]>, name = "."): RepoTree {
  type Dir = { name: string; size: number; files: number; dirs: Map<string, Dir>; leaves: RepoTree[] };
  const mk = (n: string): Dir => ({ name: n, size: 0, files: 0, dirs: new Map(), leaves: [] });
  const root = mk(name);
  for (const [path, raw] of entries) {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) continue;
    const size = Math.max(0, Number.isFinite(raw) ? raw : 0);
    let d = root;
    d.size += size;
    d.files++;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = mk(p)));
      d = next;
      d.size += size;
      d.files++;
    }
    d.leaves.push({ name: parts[parts.length - 1], size });
  }
  const out = (d: Dir): RepoTree => ({
    name: d.name,
    size: d.size,
    files: d.files,
    children: [...[...d.dirs.values()].map(out), ...d.leaves].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name)),
  });
  return out(root);
}

/** `git ls-tree -r -l -z` output → path → size (submodules and other non-blobs are skipped). */
export function parseLsTree(text: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const rec of text.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [, type, , size] = rec.slice(0, tab).trim().split(/\s+/);
    if (type === "blob") sizes.set(rec.slice(tab + 1), Number(size) || 0);
  }
  return sizes;
}

async function readTree(cwd: string): Promise<RepoTree> {
  const [listed, atHead] = await Promise.all([
    git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    git(cwd, ["ls-tree", "-r", "-l", "-z", "HEAD"]).catch(() => ""), // no commits yet
  ]);
  const sizes = parseLsTree(atHead);
  const paths = [...new Set(listed.split("\0").filter(Boolean))].slice(0, MAX_TREE_FILES);
  const unknown = paths.filter((p) => !sizes.has(p));
  // Untracked and newly added files: stat in small batches so a huge untracked folder can't stall the daemon.
  for (let i = 0; i < unknown.length; i += 256) {
    await Promise.all(
      unknown.slice(i, i + 256).map((p) =>
        stat(join(cwd, p)).then(
          (s) => void (s.isFile() && sizes.set(p, s.size)),
          () => {},
        ),
      ),
    );
  }
  return buildRepoTree(paths.filter((p) => sizes.has(p)).map((p) => [p, sizes.get(p)!]), basename(cwd));
}

const cache = new Map<string, { at: number; tree: Promise<RepoTree> }>();

/** The tree for a folder, cached a few seconds (the Map refetches as an agent adds files). */
export function repoTree(cwd: string): Promise<RepoTree> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tree;
  const tree = readTree(cwd);
  cache.set(cwd, { at: Date.now(), tree });
  tree.catch(() => cache.delete(cwd));
  return tree;
}
