// The project's real check commands (tests, typecheck, lint, build), detected from its manifests so a
// worker's brief can name them and the lead can see them in list_sessions/get_session; plus the checks a
// repo declares in perzian.json, which the daemon runs itself (see "Declared checks" below).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import type { CheckResult, DeclaredCheck, Proof } from "@perzian/protocol";
import { destructiveReason } from "./permissions.ts";
import { classifyCommand, parseSummary } from "./proof.ts";

const SCRIPT_ORDER = ["test", "typecheck", "type-check", "check-types", "lint", "build"];
// npm init's placeholder, which always fails.
const PLACEHOLDER = /no test specified/;

function read(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

function packageManager(dir: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Check commands for the project at `dir`, most important first. Empty when nothing is detected. */
export function detectChecks(dir: string): string[] {
  const out: string[] = [];
  const pkg = read(dir, "package.json");
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const pm = packageManager(dir);
      let typecheck = false;
      for (const name of SCRIPT_ORDER) {
        const body = scripts[name];
        if (typeof body !== "string" || !body.trim() || (name === "test" && PLACEHOLDER.test(body))) continue;
        if (name !== "test" && name !== "lint" && name !== "build") {
          if (typecheck) continue;
          typecheck = true;
        }
        out.push(name === "test" ? `${pm} test` : `${pm} run ${name}`);
      }
    } catch {}
  }
  const pyproject = read(dir, "pyproject.toml") ?? "";
  if (/\bpytest\b/.test(pyproject) || existsSync(join(dir, "pytest.ini")) || /\[(tool:)?pytest\]/.test(read(dir, "setup.cfg") ?? "") || /\bpytest\b/.test(read(dir, "tox.ini") ?? "")) out.push("pytest");
  if (/\[tool\.mypy\]/.test(pyproject) || existsSync(join(dir, "mypy.ini"))) out.push("mypy .");
  if (/\[tool\.ruff/.test(pyproject) || existsSync(join(dir, "ruff.toml"))) out.push("ruff check");
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cargo test", "cargo clippy");
  if (existsSync(join(dir, "go.mod"))) out.push("go test ./...", "go vet ./...");
  // A Makefile test target, when nothing above already covers tests.
  if (!out.some((c) => / test\b|^pytest|^cargo test|^go test/.test(c)) && /^test:/m.test(read(dir, "Makefile") ?? "")) out.push("make test");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Declared checks: a repo's perzian.json lists commands that must pass, e.g. a team's own test CLI.
//   { "checks": [{ "name": "unit", "run": "npm test" }, { "name": "kodo tests", "run": "kodo test --all", "timeoutSec": 600 }] }
// The daemon runs them itself in the session's worktree when a worker finishes a turn, records the real
// exit codes, and sends failures back to the agent (at most MAX_FIX_ATTEMPTS rounds) before giving up.
// The config is read once at spawn and kept on the session, so an agent editing perzian.json can't
// change what runs or what is allowed without a permission card.

export const CONFIG_FILE = "perzian.json";
export const MAX_FIX_ATTEMPTS = 2;
export const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 4 * 3600;
const MAX_CHECKS = 20;
const CHECK_FIELDS = new Set(["name", "run", "timeoutSec"]);

/** Parses and validates perzian.json. Throws an Error whose message says what to fix. */
export const parsePerzianConfig = (text: string): DeclaredCheck[] => parseList(text, "checks");

/** The optional `"setup": [{name, run, timeoutSec?}]` steps, run after the built-in worktree setup. Same shape and rules as checks. */
export const parsePerzianSetup = (text: string): DeclaredCheck[] => parseList(text, "setup");

/** Everything perzian.json says: the declared checks and the optional "ship": "pr" | "merge" default. */
export function parseConfig(text: string): { checks: DeclaredCheck[]; ship?: "pr" | "merge" } {
  const checks = parseList(text, "checks");
  const rawShip = (JSON.parse(text) as { ship?: unknown }).ship;
  if (rawShip !== undefined && rawShip !== "pr" && rawShip !== "merge") throw new Error(`${CONFIG_FILE}: "ship" must be "pr" or "merge"`);
  return { checks, ...(rawShip ? { ship: rawShip } : {}) };
}

function parseList(text: string, key: "checks" | "setup"): DeclaredCheck[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_FILE} must be an object, like { "checks": [{ "name": "unit", "run": "npm test" }] }`);
  const list = (raw as Record<string, unknown>)[key];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${CONFIG_FILE}: "${key}" must be a list`);
  if (list.length > MAX_CHECKS) throw new Error(`${CONFIG_FILE}: at most ${MAX_CHECKS} ${key}`);
  const out: DeclaredCheck[] = [];
  const names = new Set<string>();
  list.forEach((c: unknown, i) => {
    const at = `${CONFIG_FILE}: ${key}[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${at} must be an object with "name" and "run"`);
    const o = c as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !CHECK_FIELDS.has(k));
    if (unknown) throw new Error(`${at} has an unknown field "${unknown}" (allowed: name, run, timeoutSec)`);
    if (typeof o.name !== "string" || !o.name.trim()) throw new Error(`${at}.name must be a non-empty string`);
    if (typeof o.run !== "string" || !o.run.trim()) throw new Error(`${at}.run must be a non-empty string`);
    const name = o.name.trim();
    const run = o.run.trim();
    if (name.length > 60) throw new Error(`${at}.name is longer than 60 characters`);
    if (/[\r\n]/.test(run)) throw new Error(`${at}.run must be a single line`);
    if (names.has(name)) throw new Error(`${at}: duplicate name "${name}"`);
    names.add(name);
    const destructive = destructiveReason(run);
    if (destructive) throw new Error(`${at} ("${name}") looks destructive (${destructive}); Perzian won't run it`);
    const check: DeclaredCheck = { name, run };
    if (o.timeoutSec !== undefined) {
      if (typeof o.timeoutSec !== "number" || !Number.isFinite(o.timeoutSec) || o.timeoutSec <= 0 || o.timeoutSec > MAX_TIMEOUT_SEC) {
        throw new Error(`${at}.timeoutSec must be a number of seconds between 1 and ${MAX_TIMEOUT_SEC}`);
      }
      check.timeoutSec = o.timeoutSec;
    }
    out.push(check);
  });
  return out;
}

/** Declared checks from the first of `dirs` that has a perzian.json. No file: no checks, no error. */
export function loadDeclaredChecks(...dirs: string[]): { checks: DeclaredCheck[]; ship?: "pr" | "merge"; error?: string } {
  for (const dir of dirs) {
    const text = read(dir, CONFIG_FILE);
    if (text === undefined) continue;
    try {
      return parseConfig(text);
    } catch (e) {
      return { checks: [], error: (e as Error).message };
    }
  }
  return { checks: [] };
}

/** Custom setup steps from the first of `dirs` that has a perzian.json. */
export function loadDeclaredSetup(...dirs: string[]): { steps: DeclaredCheck[]; error?: string } {
  for (const dir of dirs) {
    const text = read(dir, CONFIG_FILE);
    if (text === undefined) continue;
    try {
      return { steps: parsePerzianSetup(text) };
    } catch (e) {
      return { steps: [], error: (e as Error).message };
    }
  }
  return { steps: [] };
}

/** Detected commands plus the declared ones not already among them: what the brief and the lead see. */
export function allChecks(detected: string[], declared: DeclaredCheck[]): string[] {
  return [...new Set([...detected, ...declared.map((c) => c.run)])];
}

/** The brief line telling a worker about the declared checks. Empty when there are none. */
export function declaredBrief(declared: DeclaredCheck[] | undefined): string {
  if (!declared?.length) return "";
  const list = declared.map((c) => `${c.name}: \`${c.run}\``).join("; ");
  return `Required checks (Perzian runs these itself in this worktree when you finish and sends failures back to you to fix; run them yourself first, these exact commands need no permission prompt): ${list}`;
}

const TAIL_LINES = 15;
const TAIL_CHARS = 1500;
const BUFFER_CHARS = 64 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function tailOf(output: string, lines = TAIL_LINES, chars = TAIL_CHARS): string | undefined {
  const t = output.replace(ANSI, "").replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).join("\n");
  if (!t) return undefined;
  return t.length > chars ? `…${t.slice(-(chars - 1))}` : t;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Overrides each check's timeout, in ms (tests). */
  timeoutMs?: number;
}

/** Runs one declared check through the shell in `cwd`; the result has its real exit code. */
export function runCheck(check: DeclaredCheck, cwd: string, opts: RunOptions = {}): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? (check.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<CheckResult, "name" | "run" | "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ name: check.name, run: check.run, durationMs: Date.now() - started, ...r });
    };
    // Its own process group, so a timeout or cancel also stops whatever the command started.
    const child = spawn(check.run, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    function kill() {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });
    const collect = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-BUFFER_CHARS);
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.on("error", (e) => finish({ state: "failed", tail: `Could not start: ${e.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ state: "failed", timedOut: true, summary: `timed out after ${Math.round(timeoutMs / 1000)}s`, ...optional("tail", tailOf(output)) });
      const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
      const passed = exitCode === 0;
      finish({ state: passed ? "passed" : "failed", exitCode, ...optional("summary", parseSummary(output).summary), ...(passed ? {} : optional("tail", tailOf(output))) });
    });
  });
}

const optional = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));

/** Runs the declared checks one after another; `onUpdate` sees every state change. Stops early when aborted. */
export async function runDeclaredChecks(checks: DeclaredCheck[], cwd: string, onUpdate?: (results: CheckResult[]) => void, opts: RunOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = checks.map((c) => ({ name: c.name, run: c.run, state: "pending" }));
  const publish = () => onUpdate?.(results.map((r) => ({ ...r })));
  for (let i = 0; i < checks.length; i++) {
    if (opts.signal?.aborted) break;
    results[i] = { ...results[i], state: "running" };
    publish();
    results[i] = await runCheck(checks[i], cwd, opts);
    publish();
  }
  return results;
}

/** The message that sends failed checks back to the agent. */
export function fixPrompt(failed: CheckResult[], attempt: number, max: number): string {
  const lines = [`Perzian ran the required checks after your last turn and ${failed.length === 1 ? "one failed" : `${failed.length} failed`} (fix attempt ${attempt} of ${max}):`];
  for (const r of failed) {
    const why = r.timedOut ? (r.summary ?? "timed out") : `exit ${r.exitCode ?? "?"}${r.summary ? `, ${r.summary}` : ""}`;
    lines.push("", `✕ ${r.name}: \`${r.run}\` (${why})`);
    if (r.tail) lines.push("```", r.tail, "```");
  }
  lines.push("", "Fix the cause in the code, not the check or perzian.json, then end your turn with report_outcome. Perzian runs the checks again.");
  return lines.join("\n");
}

/** Declared-check results as observed proof for the outcome card. */
export function declaredProofs(results: CheckResult[]): Proof[] {
  return results
    .filter((r) => r.state === "passed" || r.state === "failed")
    .map((r) => ({
      kind: classifyCommand(r.run)?.kind ?? "command",
      label: r.name,
      passed: r.state === "passed",
      observed: true,
      command: r.run,
      ...optional("exitCode", r.exitCode),
      ...optional("durationMs", r.durationMs),
      ...optional("summary", r.summary),
      ...(r.state === "failed" ? optional("detail", r.tail && tailOf(r.tail, 4, 300)) : {}),
    }));
}
