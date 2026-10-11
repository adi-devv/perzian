// Daemon-side permission policy: what the daemon answers on its own and what goes to the developer.
//
// - The lead ("main") never edits: edit/delete/move/execute requests are rejected without a card.
// - Workers run verification commands (tests, typecheck, lint, build), and the exact commands the repo
//   declares as checks in perzian.json, without a card.
// - Destructive commands (rm -rf, force pushes, hard resets, dropping databases...) always get a card,
//   in every mode. Our "edits" and "auto" modes are enforced here rather than by the agent's own
//   accept-edits/bypass modes, because an agent in those modes doesn't ask before running rm -rf.
// - Edits, deletes and moves outside the session's folder (and its extra folders) always get a card.

import { isAbsolute, relative } from "node:path";

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other" | string;

export interface PermissionRequest {
  role: "main" | "worker";
  mode?: "ask" | "edits" | "plan" | "auto";
  toolKind?: ToolKind;
  /** The shell command that will run (the tool's raw input), for execute requests. */
  command?: string;
  /** The tool call's title; for a shell call usually the command, but only used to spot destructive ones. */
  title?: string;
  /** Our own report/orchestration MCP tools. */
  own?: boolean;
  /** Commands the repo declares as checks (perzian.json `run`); a worker runs exactly these without a card. */
  declared?: string[];
  /** For edit/delete/move: resolved target paths outside the session's folders (session.ts computes them). */
  outside?: string[];
}

export type PermissionVerdict =
  | { action: "allow"; why: "own" | "read" | "check" | "declared" | "edits" | "auto" }
  | { action: "deny"; why: "lead-edit" | "lead-exec" }
  | { action: "ask"; destructive?: string; outside?: string[] };

const LEAD_DENY = new Set(["edit", "delete", "move"]);
const LEAD_ALLOW = new Set(["read", "search", "think"]);
// What "Auto-accept edits" accepts; shell commands still ask unless they're plain checks.
const WORKER_EDITS = new Set(["edit", "delete", "move", "read", "search", "think"]);
const WRITES = new Set(["edit", "delete", "move"]);

export function permissionPolicy(req: PermissionRequest): PermissionVerdict {
  if (req.own) return { action: "allow", why: "own" };
  if (req.role === "main") {
    if (req.toolKind && LEAD_DENY.has(req.toolKind)) return { action: "deny", why: "lead-edit" };
    // Looking around (ls, cat, grep, git log) is reading; anything else in a shell is not the lead's job.
    if (req.command !== undefined && isReadOnlyCommand(req.command)) return { action: "allow", why: "read" };
    if (req.toolKind === "execute" || req.command !== undefined) return { action: "deny", why: "lead-exec" };
    if (req.toolKind && LEAD_ALLOW.has(req.toolKind)) return { action: "allow", why: "read" };
    return { action: "ask" };
  }
  const destructive = (req.command !== undefined ? destructiveReason(req.command) : null) ?? (req.toolKind === "execute" && req.title ? destructiveReason(req.title) : null);
  if (destructive) return { action: "ask", destructive };
  // An edit, delete or move outside the session's folders is a normal card in every mode, even where
  // edits are otherwise accepted. Reads outside stay allowed.
  if (req.outside?.length && req.toolKind && WRITES.has(req.toolKind)) return { action: "ask", outside: req.outside };
  if (req.toolKind === "execute" && req.command !== undefined && isVerificationCommand(req.command)) return { action: "allow", why: "check" };
  // Exactly a declared check's command (surrounding whitespace aside); anything added to it asks as usual.
  if (req.toolKind === "execute" && req.command !== undefined && req.declared?.includes(req.command.trim())) return { action: "allow", why: "declared" };
  // Claude asks about every shell command now (see session.ts), including plain looking around.
  if (req.toolKind === "execute" && req.command !== undefined && isReadOnlyCommand(req.command)) return { action: "allow", why: "read" };
  if (req.mode === "auto") return { action: "allow", why: "auto" };
  if (req.mode === "edits" && req.toolKind && WORKER_EDITS.has(req.toolKind)) return { action: "allow", why: "edits" };
  return { action: "ask" };
}

// ---------------------------------------------------------------------------------------------
// Verification commands: one simple command, no shell features at all.

// Anything that could chain, substitute, redirect, or expand into another command.
const SHELL_META = /[;&|<>`$\\()\n\r{}!]/;

/** Splits a metacharacter-free command into words, honoring simple quotes. Null when quotes don't balance. */
function words(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

const SAFE_ENV = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ)=[\w.:-]*$/;
const CHECK_SCRIPT = /^(test|tests|unit|e2e|typecheck|type-check|types|check-types|tsc|lint|build|check|verify|(format|fmt|prettier):check)([:_-][\w.-]+)*$/i;
// Any segment, not just the last: build:deploy:prod and test:reset-db aren't checks.
const NOT_A_CHECK = /[:_-](fix|watch|dev|serve|start|update|write|clean|deploy|publish|release|reset|prod|production|migrate|seed|drop|push)(?=[:_.-]|$)/i;
const isCheckScript = (s: string | undefined) => !!s && CHECK_SCRIPT.test(s) && !NOT_A_CHECK.test(s);

// Flags a package manager may take before the script without changing what runs.
const PM_FLAGS = /^(--silent|-s|--if-present|--workspaces|-ws|--recursive|-r|--workspace=[\w@./-]+|--filter=[\w@./*-]+|--parallel|--stream|--no-bail|--frozen-lockfile)$/;
const PM_VALUED = new Set(["--workspace", "-w", "--filter", "-F"]);
const NAME = /^[\w@./*-]+$/;

/** Script args after `npm test` / `npm run x`: package-manager flags must be known; after `--` anything goes. */
function scriptArgsOk(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return true;
    if (PM_VALUED.has(a)) {
      if (!NAME.test(args[++i] ?? "")) return false;
    } else if (a.startsWith("-") && !PM_FLAGS.test(a)) return false;
  }
  return true;
}

function packageManagerOk(prog: string, args: string[]): boolean {
  // Global flags before the subcommand.
  let i = 0;
  for (; i < args.length && args[i].startsWith("-"); i++) {
    if (PM_VALUED.has(args[i])) {
      if (!NAME.test(args[++i] ?? "")) return false;
    } else if (!PM_FLAGS.test(args[i])) return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return false;
  if (prog === "bun" && sub === "test") return !flagged(rest, "--watch", "--update-snapshots", "-u");
  if (sub === "test" || sub === "t" || sub === "tst") return scriptArgsOk(rest);
  if (sub === "run" || sub === "run-script") return isCheckScript(rest[0]) && scriptArgsOk(rest.slice(1));
  if (prog === "npm") return false;
  if (isCheckScript(sub)) return scriptArgsOk(rest); // pnpm lint, yarn typecheck
  // pnpm exec vitest, bun x tsc --noEmit, yarn jest: the tool must be a check runner.
  const tool = sub === "exec" || sub === "x" || sub === "dlx" ? rest : [sub, ...rest];
  if (sub === "dlx") return false; // downloads a package
  const name = tool.length ? progName(tool[0]) : null;
  return !!name && runnerOk(name, tool.slice(1));
}

const flagged = (args: string[], ...flags: string[]) => args.some((a) => flags.some((f) => a === f || a.startsWith(f + "=")));

/** Direct test/lint/typecheck runners and what makes them not a plain check. */
function runnerOk(prog: string, args: string[]): boolean {
  switch (prog) {
    case "tsc":
    case "vue-tsc":
    case "tsgo":
      return flagged(args, "--noEmit") && !flagged(args, "--watch", "-w");
    case "vitest":
      return !["watch", "dev", "bench"].includes(args[0] ?? "") && !flagged(args, "--watch", "-w", "--ui", "-u", "--update") && !args.some((a) => a.startsWith("--outputFile")); // also --outputFile.junit=...
    case "jest":
      return !flagged(args, "--watch", "--watchAll", "-u", "--updateSnapshot", "--outputFile");
    case "mocha":
    case "ava":
      return !flagged(args, "--watch", "-w", "--update-snapshots", "-u");
    case "node":
    case "tsx":
      return flagged(args, "--test") && !flagged(args, "--watch", "-e", "--eval", "-p", "--print");
    case "eslint":
    case "oxlint":
    case "stylelint":
      return !flagged(args, "--fix", "--fix-type", "--output-file", "-o");
    case "prettier":
      return flagged(args, "--check", "-c", "--list-different", "-l") && !flagged(args, "--write", "-w");
    case "biome":
      return ["check", "lint", "ci", "format"].includes(args[0] ?? "") && !flagged(args, "--write", "--apply", "--apply-unsafe", "--fix", "--unsafe") && (args[0] !== "format" || flagged(args, "--check"));
    case "playwright":
      return args[0] === "test" && !flagged(args, "--ui", "--update-snapshots", "-u");
    case "cypress":
      return args[0] === "run";
    case "pytest":
    case "py.test":
      return !flagged(args, "--basetemp"); // pytest empties --basetemp before using it
    case "mypy":
    case "pyright":
    case "flake8":
    case "pylint":
    case "rspec":
      return true;
    case "ruff":
      return (args[0] === "check" && !flagged(args, "--fix", "--unsafe-fixes", "--watch")) || (args[0] === "format" && flagged(args, "--check"));
    case "black":
      return flagged(args, "--check");
    case "python":
    case "python3":
      return args[0] === "-m" && ["pytest", "unittest", "mypy", "pyright"].includes(args[1] ?? "") && runnerOk(args[1] === "unittest" ? "pytest" : args[1], args.slice(2));
    case "cargo":
      return (
        ["test", "check", "build", "clippy", "nextest", "fmt"].includes(args[0] ?? "") &&
        (args[0] !== "fmt" || flagged(args, "--check")) &&
        (args[0] !== "nextest" || args[1] === "run") &&
        !flagged(args, "--fix", "--config", "-Z", "--allow-dirty")
      );
    case "go":
      return ["test", "vet", "build"].includes(args[0] ?? "") && !flagged(args, "-exec", "-toolexec", "-o");
    case "deno":
      return ["test", "check", "lint"].includes(args[0] ?? "") && !flagged(args, "--watch", "--fix");
    case "make":
    case "gmake":
    case "just": {
      const targets = args.filter((a) => !/^(-s|-k|--silent|--keep-going|-j\d*)$/.test(a));
      return targets.length > 0 && targets.every((t) => isCheckScript(t) && !t.includes("="));
    }
    case "gradle":
    case "gradlew":
    case "mvn":
    case "mvnw": {
      const tasks = args.filter((a) => !/^(-q|--quiet|-B|--batch-mode|--offline|--no-daemon|--console=plain)$/.test(a));
      return tasks.length > 0 && tasks.every((t) => /^(test|check|build|verify|compile|lint)$/.test(t.replace(/^.*:/, "")));
    }
    case "dotnet":
    case "swift":
      return ["test", "build"].includes(args[0] ?? "");
    case "mix":
      return args[0] === "test" || (args[0] === "format" && flagged(args, "--check-formatted")) || args[0] === "credo";
    case "rake":
      return args.length === 1 && /^(test|spec)$/.test(args[0]);
    default:
      return false;
  }
}

// Wrappers that run a project-installed tool; the wrapped tool must itself be a check.
const WRAPPERS = new Set(["npx", "bunx", "pnpx"]);
const WRAPPER_FLAGS = /^(--no-install|--no|--offline|-q|--quiet)$/;

function progName(w: string): string | null {
  // Bare names, or the project's own local binaries. Any other path could be anything.
  if (/^[\w.-]+$/.test(w)) return w;
  const m = /^(?:\.\/)?node_modules\/\.bin\/([\w.-]+)$/.exec(w) ?? /^\.\/(gradlew|mvnw)$/.exec(w);
  return m ? m[1] : null;
}

/** True for one plain verification command (tests, typecheck, lint, build), safe to run without asking. */
export function isVerificationCommand(cmd: string): boolean {
  const src = cmd.trim();
  if (!src || src.length > 400 || SHELL_META.test(src)) return false;
  let w = words(src);
  if (!w) return false;
  while (w.length && SAFE_ENV.test(w[0])) w = w.slice(1);
  if (!w.length) return false;
  return check(w, 0);
}

function check(w: string[], depth: number): boolean {
  if (!w.length || depth > 2) return false;
  const prog = progName(w[0]);
  if (!prog) return false;
  const args = w.slice(1);
  if (WRAPPERS.has(prog)) {
    let i = 0;
    while (i < args.length && WRAPPER_FLAGS.test(args[i])) i++;
    return check(args.slice(i), depth + 1);
  }
  if ((prog === "uv" || prog === "poetry" || prog === "pdm") && args[0] === "run") return check(args.slice(1), depth + 1);
  if (prog === "bundle" && args[0] === "exec") return check(args.slice(1), depth + 1);
  if (prog === "npm" || prog === "pnpm" || prog === "yarn" || prog === "bun") return packageManagerOk(prog, args);
  return runnerOk(prog, args);
}

// ---------------------------------------------------------------------------------------------
// Read-only commands the lead may run to look around: one plain command, nothing that writes or executes.

function readOnlyOk(prog: string, args: string[]): boolean {
  switch (prog) {
    case "ls":
    case "cat":
    case "head":
    case "tail":
    case "wc":
    case "pwd":
    case "file":
    case "stat":
    case "du":
    case "grep":
    case "egrep":
    case "realpath":
      return prog !== "tail" || !flagged(args, "-f", "-F", "--follow");
    case "rg":
      return !flagged(args, "--pre", "--search-zip", "-z");
    case "tree":
      return !flagged(args, "-o");
    case "find":
      return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a));
    case "git": {
      const sub = args[0];
      if (!["status", "log", "diff", "show", "ls-files", "rev-parse", "blame", "shortlog"].includes(sub ?? "")) return false;
      return !flagged(args, "--output", "-o", "--ext-diff", "--textconv");
    }
    default:
      return false;
  }
}

/** True for one plain read-only command (ls, cat, grep, git log...). */
export function isReadOnlyCommand(cmd: string): boolean {
  const src = cmd.trim();
  if (!src || src.length > 400 || SHELL_META.test(src)) return false;
  const w = words(src);
  if (!w?.length) return false;
  const prog = /^[\w.-]+$/.test(w[0]) ? w[0] : null;
  return !!prog && readOnlyOk(prog, w.slice(1));
}

// ---------------------------------------------------------------------------------------------
// Destructive commands: always a card. Deliberately loose: it looks inside chains, pipes,
// substitutions and `sh -c` strings, and a false positive only costs one click.

/** Simple commands in a shell string, including those inside $(...), backticks and sh -c '...'. */
function segments(src: string, depth = 0): string[][] {
  const out: string[][] = [];
  if (depth > 3) return out;
  // Pull substitutions out first so they're checked on their own.
  const inner: string[] = [];
  const flat = src
    .replace(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, body: string) => (inner.push(body), " SUBST "))
    .replace(/`([^`]*)`/g, (_, body: string) => (inner.push(body), " SUBST "));
  for (const body of inner) out.push(...segments(body, depth + 1));
  for (const part of flat.split(/&&|\|\||[;|&\n]/)) {
    const w = looseWords(part);
    if (!w.length) continue;
    // sh -c "...", bash -lc '...', eval "...": check the string too.
    const shIdx = w.findIndex((x, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(x) && /^(sh|bash|zsh|dash)$/.test(base(w[i - 1])));
    if (shIdx > 0 && w[shIdx + 1] !== undefined) out.push(...segments(w[shIdx + 1], depth + 1));
    if (base(w[0]) === "eval") out.push(...segments(w.slice(1).join(" "), depth + 1));
    out.push(w);
  }
  return out;
}

function looseWords(part: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(part); m; m = re.exec(part)) out.push(m[1] ?? m[2] ?? m[3]);
  // Redirection targets aren't arguments.
  return out.filter((x) => !/^\d*[<>]/.test(x));
}

// \rm skips aliases but is still rm.
const base = (w: string) => w.replace(/^\\/, "").replace(/^.*\//, "");
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIXES = new Set(["sudo", "doas", "env", "time", "nice", "nohup", "command", "exec", "xargs", "timeout", "caffeinate", "npx", "pnpx", "bunx"]);

function stripPrefixes(w: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < w.length && ASSIGN.test(w[i])) i++;
    if (i < w.length && PREFIXES.has(base(w[i]))) {
      const p = base(w[i++]);
      while (i < w.length && w[i].startsWith("-")) i += p === "xargs" && /^-[InLPEd]$/.test(w[i]) ? 2 : 1;
      if (p === "timeout" && i < w.length) i++; // duration
      continue;
    }
    return w.slice(i);
  }
}

const shortFlag = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
const longFlag = (args: string[], ...names: string[]) => args.some((a) => names.some((n) => a === n || a.startsWith(n + "=")));
const BROAD_TARGET = /^(\/|~|~\/|\.|\.\/|\.\.|\*|\.\/\*|\/\*|~\/\*|\$HOME|\$HOME\/\*?)$/;

function gitReason(args: string[]): string | null {
  // Skip global options: -C <dir>, -c k=v, --git-dir=..., --no-pager.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  switch (sub) {
    case "push":
      if (longFlag(rest, "--force", "--force-with-lease", "--force-if-includes") || shortFlag(rest, "f")) return "git push --force";
      if (longFlag(rest, "--mirror", "--delete", "--prune") || rest.includes("-d")) return "git push deleting remote refs";
      if (rest.some((a) => /^\+/.test(a) || /^:[^/]/.test(a))) return "git push --force";
      return null;
    case "reset":
      return longFlag(rest, "--hard", "--merge") ? "git reset --hard" : null;
    case "clean":
      return longFlag(rest, "--force") || shortFlag(rest, "f") ? "git clean -f" : null;
    case "checkout":
      return longFlag(rest, "--force") || rest.includes("-f") || rest.includes(".") || (rest.includes("--") && rest.indexOf("--") < rest.length - 1) ? "git checkout discarding changes" : null;
    case "restore":
      // Only --staged alone leaves the working tree alone.
      return (longFlag(rest, "--staged") || shortFlag(rest, "S")) && !longFlag(rest, "--worktree") && !shortFlag(rest, "W") ? null : "git restore discarding changes";
    case "switch":
      return longFlag(rest, "--force", "--discard-changes") || rest.includes("-f") || rest.includes("-C") ? "git switch discarding changes" : null;
    case "branch":
      if (rest.includes("-D") || (longFlag(rest, "--delete", "-d") && longFlag(rest, "--force", "-f"))) return "git branch -D";
      return longFlag(rest, "--force") || rest.includes("-f") || rest.includes("-M") || rest.includes("-C") ? "git branch --force" : null;
    case "stash":
      return rest[0] === "clear" || rest[0] === "drop" ? `git stash ${rest[0]}` : null;
    case "filter-branch":
    case "filter-repo":
      return `git ${sub}`;
    case "update-ref":
      return rest.includes("-d") ? "git update-ref -d" : null;
    case "reflog":
      return rest[0] === "expire" || rest[0] === "delete" ? "git reflog expire" : null;
    default:
      return null;
  }
}

function segmentReason(raw: string[]): string | null {
  const w = stripPrefixes(raw);
  if (!w.length) return null;
  const prog = base(w[0]);
  const args = w.slice(1);
  switch (prog) {
    case "rm": {
      if (shortFlag(args, "r") || shortFlag(args, "R") || longFlag(args, "--recursive")) return "rm -rf";
      if (args.some((a) => !a.startsWith("-") && (BROAD_TARGET.test(a) || /(^|\/)\*$/.test(a)))) return "mass delete";
      return null;
    }
    case "git":
      return gitReason(args);
    case "pnpm":
    case "yarn":
    case "bun":
      // pnpm exec prisma migrate reset, yarn prisma migrate reset
      return segmentReason(["exec", "dlx", "x"].includes(args[0]) ? args.slice(1) : args);
    case "find":
      return args.includes("-delete") || args.some((a, i) => (a === "-exec" || a === "-execdir" || a === "-ok") && base(args[i + 1] ?? "") === "rm") ? "find -delete" : null;
    case "rsync":
      return args.some((a) => a.startsWith("--delete") || a === "--remove-source-files") ? "rsync --delete" : null;
    case "dd":
      return args.some((a) => /^of=\/dev\//.test(a)) ? "dd to a device" : null;
    case "shred":
    case "wipefs":
    case "dropdb":
      return prog;
    case "mysqladmin":
      return args.includes("drop") ? "drops a database" : null;
    case "redis-cli":
      return args.some((a) => /^flush(all|db)$/i.test(a)) ? "redis flush" : null;
    case "prisma":
      return (args[0] === "migrate" && args[1] === "reset") || (args.includes("push") && longFlag(args, "--force-reset")) ? "prisma reset (drops data)" : null;
    case "rails":
    case "rake":
    case "bin/rails":
      return args.some((a) => /^db:(drop|reset|purge|schema:load)/.test(a)) ? "drops a database" : null;
    case "docker":
    case "podman":
      if ((args[1] === "prune" && ["system", "volume", "image", "container", "builder"].includes(args[0])) || (args[0] === "volume" && args[1] === "rm")) return `${prog} ${args[0]} ${args[1]}`;
      return null;
    case "kubectl":
      return args[0] === "delete" ? "kubectl delete" : null;
    case "terraform":
    case "tofu":
      return args[0] === "destroy" || (args[0] === "apply" && longFlag(args, "-destroy")) ? "terraform destroy" : null;
    case "gh":
      return args[1] === "delete" && ["repo", "release"].includes(args[0]) ? `gh ${args[0]} delete` : null;
    case "diskutil":
      return args.some((a) => /^erase/i.test(a)) ? "erases a disk" : null;
    default:
      if (/^mkfs(\.|$)/.test(prog)) return "mkfs";
      return null;
  }
}

const SQL: [RegExp, string][] = [
  // Downloaded scripts piped into an interpreter, and deletes written as inline code.
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(\S*\/)?(sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i, "runs a downloaded script"],
  [/\b(sh|bash|zsh)\s+<\(\s*(curl|wget)\b/i, "runs a downloaded script"],
  [/\b(shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)|rmSync|rmdirSync|unlinkSync|fs\.(rm|rmdir|unlink)\b|fs\.promises\.(rm|rmdir|unlink)|FileUtils\.rm_r|rimraf)/, "deletes files from code"],
  [/\bdrop\s+(database|schema|table|collection)\b/i, "drops a database"],
  [/\btruncate\s+(table\s+)?[\w"`.]+/i, "truncates a table"],
  [/\.drop(Database|Collection)\s*\(/i, "drops a database"],
  [/\bflushall\b/i, "redis flush"],
  [/\bmanage\.py\s+flush\b/i, "drops a database"],
];

/** Why a shell command is destructive (short, for the card), or null. */
export function destructiveReason(cmd: string): string | null {
  for (const seg of segments(cmd)) {
    const r = segmentReason(seg);
    if (r) return r;
  }
  for (const [re, why] of SQL) if (re.test(cmd)) return why;
  // DELETE FROM without a WHERE clause.
  const del = /\bdelete\s+from\s+[\w"`.]+([^;]*)/i.exec(cmd);
  if (del && !/\bwhere\b/i.test(del[1])) return "deletes every row";
  return null;
}

/**
 * The second line of a permission card: the command, the paths outside the project, or the file. A file
 * inside the session's folder is shown relative to it (a worktree's absolute path is long noise), and
 * nothing is shown when the title already says it.
 */
export function permissionDetail(p: { title: string; command?: string; outside: string[]; filePath?: string; cwd: string }): string | undefined {
  let detail = p.command ?? (p.outside.length ? p.outside.join(", ") : p.filePath);
  if (detail === undefined) return undefined;
  if (p.command === undefined && !p.outside.length && isAbsolute(detail)) {
    const rel = relative(p.cwd, detail);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) detail = rel;
  }
  const names = (x: string) => p.title === x || p.title.endsWith(` ${x}`) || p.title.endsWith(`/${x}`);
  if (names(detail) || (p.command === undefined && p.filePath && names(p.filePath))) return undefined;
  return detail;
}
