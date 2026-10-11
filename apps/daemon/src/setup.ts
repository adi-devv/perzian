// Readies a fresh worktree before the agent's first message: copies the local-only files git doesn't
// carry over (gitignored .env files and a few local config files), then installs dependencies with the
// tool the lockfile names. Without this, the first test run in a new worktree fails.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { SetupState } from "@perzian/protocol";

const exec = promisify(execFile);

// Directories never searched for local files: dependencies, build output, caches, VCS internals.
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache", ".yarn", ".pnpm-store", "vendor", "coverage"]);
// Local config files copied when gitignored, besides `.env*`. Kept short on purpose.
const LOCAL_CONFIG = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", ".dev.vars"]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 50_000;
const MAX_FILE_BYTES = 1_000_000;

export const isLocalFileName = (name: string): boolean => name.startsWith(".env") || LOCAL_CONFIG.has(name);

// Candidate files by name, relative to `root`. Skips symlinks and nested repos/worktrees (a directory
// with its own .git), so another checkout's files under the project are never picked up.
function candidates(root: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== root && entries.some((e) => e.name === ".git")) return;
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && isLocalFileName(e.name)) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root, 0);
  return out.sort();
}

// `literal`: paths are matched as-is, not as globs (ls-files; check-ignore rejects the option).
async function gitLines(cwd: string, args: string[], opts: { okCodes?: number[]; sepr?: string; literal?: boolean } = {}): Promise<string[]> {
  const { okCodes = [0], sepr = "\0", literal } = opts;
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, env: literal ? { ...process.env, GIT_LITERAL_PATHSPECS: "1" } : process.env });
    return stdout.split(sepr).filter(Boolean);
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (typeof err.code === "number" && okCodes.includes(err.code)) return (err.stdout ?? "").split(sepr).filter(Boolean);
    throw e;
  }
}

/**
 * Local-only files in `source` worth copying into a worktree: `.env*` (any depth) and a few local config
 * files, only when git ignores them. Tracked files are already in the worktree, and untracked files git
 * doesn't ignore would show up as the agent's changes (and be committed when shipping), so both are left out.
 */
export async function localFiles(source: string): Promise<string[]> {
  const found = candidates(source);
  if (!found.length) return [];
  const ignored = await gitLines(source, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...found], { literal: true });
  return found.filter((p) => ignored.includes(p));
}

/** Copies `localFiles(source)` into `dest`, never overwriting. Returns the paths copied. */
export async function copyLocalFiles(source: string, dest: string): Promise<string[]> {
  const files = await localFiles(source);
  if (!files.length) return [];
  // The worktree's own ignore rules must agree, or the copy would show up as a change.
  const ignoredThere = new Set(await gitLines(dest, ["-c", "core.quotePath=false", "check-ignore", "--", ...files], { okCodes: [0, 1], sepr: "\n" }));
  const copied: string[] = [];
  for (const p of files) {
    if (!ignoredThere.has(p)) continue;
    const from = join(source, p);
    const to = join(dest, p);
    try {
      if (existsSync(to) || lstatSync(from).size > MAX_FILE_BYTES) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      copied.push(p);
    } catch {}
  }
  return copied;
}

export interface InstallStep {
  /** Shown to the developer, e.g. "npm ci". */
  label: string;
  argv: string[];
  /** Tried when `argv` fails, e.g. npm install after npm ci. `keep`: files it may rewrite that are put back
   * afterwards, so a lockfile the fallback updated doesn't show up as the session's own change. */
  fallback?: { label: string; argv: string[]; keep?: string[] };
}

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (bin.includes("/")) return isExecutable(bin);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutable(join(dir, bin))) return true;
  }
  return false;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A virtualenv in the checkout (`.venv` or `venv` with a pyvenv.cfg) is the one convention clear enough
// to install requirements.txt into; otherwise there's no telling where it should go.
function venvName(source: string): string | undefined {
  return [".venv", "venv"].find((n) => existsSync(join(source, n, "pyvenv.cfg")));
}

/**
 * Install steps for the lockfiles at `dir`'s root: at most one JavaScript and one Python install. A tool
 * that isn't on PATH is skipped with a note. `source` is the original checkout (for the venv convention).
 */
export function detectInstall(dir: string, source = dir, env: NodeJS.ProcessEnv = process.env): { steps: InstallStep[]; notes: string[] } {
  const has = (f: string) => existsSync(join(dir, f));
  const steps: InstallStep[] = [];
  const notes: string[] = [];
  const add = (bin: string, step: InstallStep) => {
    if (onPath(bin, env)) steps.push(step);
    else notes.push(`${bin} not on PATH: skipped ${step.label}`);
  };
  if (has("pnpm-lock.yaml")) add("pnpm", { label: "pnpm install --frozen-lockfile", argv: ["pnpm", "install", "--frozen-lockfile"] });
  else if (has("yarn.lock")) add("yarn", { label: "yarn install --frozen-lockfile", argv: ["yarn", "install", "--frozen-lockfile"] });
  else if (has("bun.lockb") || has("bun.lock")) add("bun", { label: "bun install", argv: ["bun", "install"] });
  else if (has("package-lock.json"))
    add("npm", { label: "npm ci", argv: ["npm", "ci", "--no-audit", "--no-fund"], fallback: { label: "npm install", argv: ["npm", "install", "--no-audit", "--no-fund"], keep: ["package-lock.json"] } });

  if (has("uv.lock")) add("uv", { label: "uv sync", argv: ["uv", "sync"] });
  else if (has("poetry.lock")) add("poetry", { label: "poetry install", argv: ["poetry", "install"] });
  else if (has("requirements.txt")) {
    const venv = venvName(source);
    if (!venv) notes.push("requirements.txt: no .venv or venv in the checkout, so nothing was installed");
    else if (!onPath("python3", env)) notes.push(`python3 not on PATH: skipped installing requirements.txt into ${venv}`);
    else {
      steps.push({ label: `python3 -m venv ${venv}`, argv: ["python3", "-m", "venv", venv] });
      steps.push({ label: `${venv}/bin/pip install -r requirements.txt`, argv: [join(venv, "bin", "python"), "-m", "pip", "install", "-r", "requirements.txt"] });
    }
  }
  return { steps, notes };
}

const TAIL_LINES = 20;
export const tail = (text: string, n = TAIL_LINES) =>
  text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join("\n");

/** Runs one command in `cwd`; resolves with its exit code and the end of its combined output. */
export function runCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    let output = "";
    const keep = (d: Buffer) => (output = (output + d).slice(-16_000));
    const [bin, ...args] = argv;
    const bin_ = bin.includes("/") && !bin.startsWith("/") ? join(cwd, bin) : bin;
    const proc = spawn(bin_, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      output += `\nTimed out after ${Math.round(timeoutMs / 60_000)} min`;
      proc.kill("SIGTERM");
    }, timeoutMs);
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, output: `${output}\n${e.message}` });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal ? 128 : -1), output });
    });
  });
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Called with each intermediate state (copying, then each install command). */
  onUpdate?: (s: SetupState) => void;
  now?: () => number;
  /** Custom steps from perzian.json `setup`, run after the built-in ones. */
  steps?: { name: string; run: string; timeoutSec?: number }[];
}

/** Copies local files from `source` into the worktree `dest`, then runs the installs. Never throws. */
export async function readyWorktree(source: string, dest: string, opts: SetupOptions = {}): Promise<SetupState> {
  const now = opts.now ?? Date.now;
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), CI: "1" };
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  let st: SetupState = { state: "running", copied: [], install: [], at: now() };
  const set = (patch: Partial<SetupState>) => {
    st = { ...st, ...patch, at: now() };
    if (st.state === "running") opts.onUpdate?.(st);
  };
  try {
    st.copied = await copyLocalFiles(source, dest);
  } catch (e) {
    st.notes = [`Couldn't copy local files: ${(e as Error).message ?? e}`];
  }
  const { steps, notes } = detectInstall(dest, source, env);
  set({ install: [...steps.map((s) => s.label), ...(opts.steps ?? []).map((c) => c.name)], notes: [...(st.notes ?? []), ...notes] });
  for (const step of steps) {
    set({ current: step.label });
    let r = await runCommand(step.argv, dest, env, timeoutMs);
    let label = step.label;
    if (r.code !== 0 && step.fallback) {
      const first = r;
      label = step.fallback.label;
      set({ current: label, notes: [...(st.notes ?? []), `${step.label} failed (exit ${first.code}); ran ${label}`] });
      const kept = (step.fallback.keep ?? []).map((f) => [f, readOr(join(dest, f))] as const);
      r = await runCommand(step.fallback.argv, dest, env, timeoutMs);
      for (const [f, before] of kept) if (before !== undefined && readOr(join(dest, f)) !== before) writeFileSync(join(dest, f), before);
    }
    if (r.code !== 0) {
      set({ state: "failed", current: undefined, error: { command: label, tail: tail(r.output) || `exited with code ${r.code}` } });
      return clean(st);
    }
  }
  for (const c of opts.steps ?? []) {
    set({ current: c.name });
    const r = await runCommand(["/bin/sh", "-c", c.run], dest, env, c.timeoutSec ? c.timeoutSec * 1000 : timeoutMs);
    if (r.code !== 0) {
      set({ state: "failed", current: undefined, error: { command: c.name, tail: tail(r.output) || `exited with code ${r.code}` } });
      return clean(st);
    }
  }
  set({ state: "ok", current: undefined });
  return clean(st);
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Drops empty/undefined fields so the logged state stays small.
function clean(s: SetupState): SetupState {
  const out: SetupState = { state: s.state, copied: s.copied, install: s.install, at: s.at };
  if (s.notes?.length) out.notes = s.notes;
  if (s.error) out.error = s.error;
  return out;
}

/** Holds prompts until setup is done. `wait` resolves true when they may go, false when cancelled. */
export class SetupGate {
  private waiters: ((go: boolean) => void)[] = [];

  get waiting(): number {
    return this.waiters.length;
  }

  wait(): Promise<boolean> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(go: boolean): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r(go);
  }

  open(): void {
    this.release(true);
  }

  cancel(): void {
    this.release(false);
  }
}
