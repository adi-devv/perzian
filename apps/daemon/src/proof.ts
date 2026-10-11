// Observed proof: the daemon watches the verification commands an agent actually runs (tests, builds,
// typechecks, lints) and records their real result, so an outcome's proof is not just the agent's word.
//
// How claude-agent-acp reports a Bash call (client without the terminal_output capability, as today):
//   tool_call         { kind: "execute", name: "Bash", title: "Terminal", status: "pending", rawInput: {} }
//   tool_call_update  { title: <command>, rawInput: { command, description? } }        (input complete)
//   tool_call_update  { _meta: { claudeCode: { toolResponse: { stdout, stderr, interrupted, ... } } } }
//                     (success only)
//   tool_call_update  { status: "completed", rawOutput: <stdout>, content: ["```console\n...\n```"] }
//   or                { status: "failed", rawOutput: "Exit code 3\n<output>", content: ["```\nExit code 3\n...```"] }
// "completed" means exit 0 (Claude Code only accepts a non-zero code as success for grep-like commands).
// A client declaring `_meta.terminal_output` instead gets `_meta.terminal_exit.exit_code`; both are read.
import type { Proof } from "@perzian/protocol";

export type CheckKind = "tests" | "build" | "typecheck" | "lint";
export interface Classified {
  kind: CheckKind;
  label: string;
}

const RANK: Record<CheckKind, number> = { tests: 4, build: 3, typecheck: 2, lint: 1 };
const MAX_LABEL = 80;

// ---------------------------------------------------------------------------------------------
// Shell splitting: just enough of sh to find the commands in `cd x && FOO=1 npm test 2>&1 | tail`.

type Op = "&&" | "||" | ";" | "|" | "&";
interface Segment {
  words: string[];
  op?: Op; // operator that follows this segment
}

function splitShell(src: string): Segment[] {
  const segs: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let skipNextWord = false; // the target of a redirection
  const endWord = () => {
    if (inWord) {
      if (skipNextWord) skipNextWord = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSeg = (op?: Op) => {
    endWord();
    if (words.length || op) segs.push({ words, op });
    words = [];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] !== "\n") (word += src[i + 1]), (inWord = true);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? src.length : end);
      inWord = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) i++;
        word += src[i++];
      }
      inWord = true;
      i++;
      continue;
    }
    if ((c === "$" && src[i + 1] === "(") || c === "`") {
      // Command substitution stays part of the word, verbatim.
      const start = i;
      if (c === "`") {
        const end = src.indexOf("`", i + 1);
        i = end < 0 ? src.length : end + 1;
      } else {
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")" && --depth === 0) break;
        }
        i++;
      }
      word += src.slice(start, i);
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // Redirection: drop a leading fd (`2>`), the operator, and its target (`&1`, `/dev/null`, `out.log`).
      if (/^\d+$/.test(word)) (word = ""), (inWord = false);
      else endWord();
      const m = /^(&>>?|\d*>>?&?|<<<|<<-?|<&?|>\|)/.exec(src.slice(i));
      i += m ? m[0].length : 1;
      const dup = /^(\d+|-)/.exec(src.slice(i));
      if (src[i - 1] === "&" && dup) i += dup[0].length;
      else skipNextWord = true;
      continue;
    }
    if (c === "&" && src[i + 1] === "&") (endSeg("&&"), (i += 2));
    else if (c === "|" && src[i + 1] === "|") (endSeg("||"), (i += 2));
    else if (c === "|") (endSeg("|"), (i += src[i + 1] === "&" ? 2 : 1));
    else if (c === "&") (endSeg("&"), i++);
    else if (c === ";" || c === "\n") (endSeg(";"), (i += src[i + 1] === ";" ? 2 : 1));
    else if (c === "(" || c === ")" || c === " " || c === "\t" || c === "\r") (endWord(), i++);
    else (word += c), (inWord = true), i++;
  }
  endSeg();
  return segs.map((s) => ({ ...s, words: s.words.filter((w) => w !== "{" && w !== "}") }));
}

// ---------------------------------------------------------------------------------------------
// Classification

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = (w: string) => w.replace(/^.*\//, "").replace(/\.(cmd|exe|bat|sh)$/i, "");

// Leading words that only change how the real command runs.
function stripPrefixes(words: string[]): string[] {
  let w = words;
  for (;;) {
    while (w.length && ASSIGN.test(w[0])) w = w.slice(1);
    const p = w.length ? base(w[0]) : "";
    if (p === "env" || p === "cross-env" || p === "dotenv") {
      w = w.slice(1);
      while (w.length && (w[0].startsWith("-") || ASSIGN.test(w[0]))) w = w.slice(w[0] === "-u" ? 2 : 1);
    } else if (p === "time" || p === "command" || p === "exec" || p === "nohup" || p === "sudo" || p === "caffeinate" || p === "xvfb-run") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(1);
    } else if (p === "nice") {
      w = w.slice(w[1] === "-n" ? 3 : 1);
    } else if (p === "timeout" || p === "gtimeout") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^-(s|k)$|^--(signal|kill-after)$/.test(w[0]) ? 2 : 1);
      w = w.slice(1); // duration
    } else return w;
  }
}

// Skips flags (and the value of flags that take one) and returns the positional words.
function positionals(args: string[], valued: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (valued.has(a)) i++;
      continue;
    }
    if (ASSIGN.test(a)) continue; // make VAR=1
    out.push(a);
  }
  return out;
}

const PM_VALUED = new Set(["--prefix", "-C", "--dir", "--cwd", "-w", "--workspace", "--filter", "-F", "--scope", "--reporter"]);
const MAKE_VALUED = new Set(["-C", "-f", "--file", "--directory", "-j", "--jobs", "-l", "-o", "-W", "--justfile", "-d", "--dir", "-t", "--taskfile"]);
const GRADLE_VALUED = new Set(["-p", "--project-dir", "-x", "--exclude-task", "-D", "-P", "--settings-file", "-b", "--build-file", "-pl", "--projects", "-f", "--file", "-s", "--settings", "-P"]);

/** Script, task, or target names: `test`, `test:unit`, `typecheck`, `build:web`, nx/gradle `app:test`. */
function scriptKind(name: string | undefined, checkIs: CheckKind = "lint"): CheckKind | null {
  if (!name) return null;
  const parts = name.toLowerCase().split(":").filter(Boolean);
  if (!parts.length) return null;
  // `test:unit` is a test script; `app:test` (nx, gradle) is the test target of project `app`.
  const n = /^(test|tests|lint|build|typecheck|types|check|format|fmt|prettier|e2e)$/.test(parts[0]) ? parts.join(":") : parts[parts.length - 1];
  const head = n.split(/[:_-]/)[0];
  if (/(^|[:_-])(fix|watch|dev|serve|start)$/.test(n)) return null; // lint:fix, test:watch
  if (/^(test|tests|spec|specs|e2e|unit|integration|coverage|verify)$/.test(head) || /(^|[:_-])(test|tests|e2e|spec)$/.test(n)) return "tests";
  if (/^(typecheck|types|tsc)$/.test(head) || /^(type-check|check-types|check:types)/.test(n) || /(^|[:_-])(typecheck|types|tsc)$/.test(n)) return "typecheck";
  if (/^(lint|eslint|stylelint|clippy|credo)$/.test(head) || /^(format|fmt|prettier)[:_-]check$/.test(n) || /^check[:_-]format$/.test(n) || /(^|[:_-])lint$/.test(n)) return "lint";
  if (/^(build|compile|bundle|assemble|all)$/.test(head)) return "build";
  if (head === "check") return checkIs;
  return null;
}

function bestOf(kinds: (CheckKind | null)[]): CheckKind | null {
  let best: CheckKind | null = null;
  for (const k of kinds) if (k && (!best || RANK[k] > RANK[best])) best = k;
  return best;
}

const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(f + "=")));

/** The kind of one simple command (prefixes already stripped), or null. */
function kindOf(words: string[], depth = 0): CheckKind | null {
  if (!words.length || depth > 4) return null;
  const prog = base(words[0]).toLowerCase();
  const args = words.slice(1);
  const pos = () => positionals(args, PM_VALUED);
  const recurse = (rest: string[]) => kindOf(stripPrefixes(rest), depth + 1);
  const skipFlags = (rest: string[], valued = new Set<string>(["-p", "--package"])) => {
    let i = 0;
    while (i < rest.length && rest[i].startsWith("-")) i += valued.has(rest[i]) ? 2 : 1;
    return rest.slice(i);
  };

  switch (prog) {
    // Runners that wrap another command.
    case "npx":
    case "pnpx":
    case "bunx":
    case "uvx":
    case "c8":
    case "nyc":
      return recurse(skipFlags(args));
    case "poetry":
    case "pipenv":
    case "pdm":
    case "rye":
    case "hatch":
    case "uv":
      return args[0] === "run" ? recurse(skipFlags(args.slice(1), new Set(["--with", "--python", "-p", "--group", "--extra", "-e", "--env"]))) : null;
    case "bundle":
      return args[0] === "exec" ? recurse(args.slice(1)) : null;
    case "coverage":
      if (args[0] !== "run") return null;
      return args[1] === "-m" ? recurse(args.slice(2)) : recurse(skipFlags(args.slice(1)));

    // Package managers and script runners.
    case "npm": {
      const p = pos();
      const sub = p[0];
      if (sub === "test" || sub === "t" || sub === "tst" || sub === "cit" || sub === "install-ci-test" || sub === "it" || sub === "install-test") return "tests";
      if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") return scriptKind(p[1]);
      if (sub === "exec" || sub === "x") return recurse(skipFlags(args.slice(args.indexOf(sub) + 1)));
      return null;
    }
    case "pnpm":
    case "yarn":
    case "bun":
    case "composer": {
      const p = pos();
      const sub = p[0];
      if (sub === "test" || sub === "t") return "tests";
      if (sub === "run" || sub === "run-script") return scriptKind(p[1]);
      if (sub === "exec" || sub === "dlx" || sub === "x") return recurse(args.slice(args.indexOf(sub) + 1));
      if (prog === "yarn" && sub === "workspace") return scriptKind(p[2] === "run" ? p[3] : p[2]);
      if (prog === "yarn" && sub === "workspaces") return scriptKind(p[p.indexOf("run") + 1] ?? undefined);
      return scriptKind(sub);
    }
    case "turbo":
    case "lerna": {
      const p = pos();
      return bestOf((p[0] === "run" ? p.slice(1) : p.slice(0, 1)).map((t) => scriptKind(t)));
    }
    case "nx": {
      const p = pos();
      if (p[0] === "run") return scriptKind(p[1]?.split(":")[1]);
      if (p[0] === "run-many" || p[0] === "affected") {
        const t = args.findIndex((a) => a === "-t" || a === "--target" || a === "--targets");
        const eq = args.find((a) => a.startsWith("--target=") || a.startsWith("--targets="));
        const v = eq ? eq.split("=")[1] : t >= 0 ? args[t + 1] : undefined;
        return bestOf((v ?? "").split(",").map((x) => scriptKind(x)));
      }
      return scriptKind(p[0]);
    }
    case "make":
    case "gmake":
    case "just":
    case "rake":
    case "task":
    case "mise": {
      const p = positionals(args, MAKE_VALUED).filter((t) => t !== "run");
      if (!p.length) return prog === "make" || prog === "gmake" ? "build" : null;
      return bestOf(p.map((t) => scriptKind(t, "tests")));
    }

    // JS / TS
    case "tsc":
    case "vue-tsc":
    case "tsgo":
      if (has(args, "--watch", "-w")) return null;
      if (has(args, "--noEmit")) return "typecheck";
      return "build";
    case "vitest":
      if (has(args, "--watch", "-w") || ["watch", "dev", "bench"].includes(args[0])) return null;
      return args[0] === "typecheck" ? "typecheck" : "tests";
    case "jest":
      return has(args, "--watch", "--watchAll") ? null : "tests";
    case "mocha":
      return has(args, "--watch", "-w") ? null : "tests";
    case "ava":
    case "tap":
    case "uvu":
    case "jasmine":
    case "karma":
    case "elm-test":
      return "tests";
    case "playwright":
      return args[0] === "test" ? "tests" : null;
    case "cypress":
      return args[0] === "run" ? "tests" : null;
    case "node":
    case "tsx":
    case "ts-node":
      return has(args, "--test") && !has(args, "--watch") ? "tests" : null;
    case "deno":
      return args[0] === "test" ? "tests" : args[0] === "check" ? "typecheck" : args[0] === "lint" ? "lint" : args[0] === "fmt" && has(args, "--check") ? "lint" : null;
    case "eslint":
    case "oxlint":
    case "stylelint":
    case "tslint":
    case "xo":
    case "standard":
    case "markdownlint":
    case "markdownlint-cli2":
    case "shellcheck":
    case "hadolint":
      return has(args, "--fix") ? null : "lint";
    case "biome":
      return ["check", "lint", "ci"].includes(args[0]) && !has(args, "--write", "--fix", "--apply") ? "lint" : null;
    case "prettier":
      return has(args, "--check", "-c", "--list-different", "-l") ? "lint" : null;

    // Python
    case "python":
    case "python3":
    case "py": {
      const m = args.indexOf("-m");
      return m >= 0 ? recurse(args.slice(m + 1)) : null;
    }
    case "pytest":
    case "py.test":
    case "tox":
    case "nox":
    case "unittest":
    case "nose2":
    case "behave":
    case "ward":
      return "tests";
    case "mypy":
    case "dmypy":
    case "pyright":
    case "basedpyright":
    case "pytype":
      return "typecheck";
    case "pyre":
      return args[0] === "check" || !args.length ? "typecheck" : null;
    case "ruff":
      if (args[0] === "format") return has(args, "--check") ? "lint" : null;
      return has(args, "--fix") ? null : "lint";
    case "flake8":
    case "pylint":
    case "pyflakes":
    case "pycodestyle":
    case "pydocstyle":
    case "bandit":
      return "lint";
    case "black":
      return has(args, "--check") ? "lint" : null;
    case "isort":
      return has(args, "--check", "--check-only", "-c") ? "lint" : null;

    // Go / Rust / JVM / Apple / .NET / others
    case "go":
      return args[0] === "test" ? "tests" : args[0] === "build" ? "build" : args[0] === "vet" ? "lint" : null;
    case "golangci-lint":
    case "staticcheck":
    case "revive":
      return "lint";
    case "cargo": {
      const a = args[0]?.startsWith("+") ? args.slice(1) : args;
      const sub = a[0];
      if (sub === "test" || sub === "t" || sub === "nextest") return "tests";
      if (sub === "build" || sub === "b") return "build";
      if (sub === "check" || sub === "c") return "typecheck";
      if (sub === "clippy") return has(a, "--fix") ? null : "lint";
      if (sub === "fmt") return has(a, "--check") ? "lint" : null;
      return null;
    }
    case "mvn":
    case "mvnw":
    case "gradle":
    case "gradlew": {
      const goals = positionals(args, GRADLE_VALUED).map((g) => g.replace(/^.*:/, ""));
      return bestOf(
        goals.map((g) =>
          /^(test|verify|integration-test|check|connectedcheck)$/i.test(g) || /^test/i.test(g)
            ? "tests"
            : /^(build|package|install|assemble|compile|bundle)/i.test(g)
              ? "build"
              : /^(lint|detekt|ktlintcheck|spotlesscheck|checkstyle)/i.test(g)
                ? "lint"
                : null,
        ),
      );
    }
    case "swift":
      return args[0] === "test" ? "tests" : args[0] === "build" ? "build" : null;
    case "xcodebuild": {
      if (args.some((a) => a === "test" || a === "test-without-building")) return "tests";
      if (has(args, "-list", "-version", "-showsdks", "-showBuildSettings")) return null;
      return "build"; // build is the default action
    }
    case "swiftlint":
    case "ktlint":
    case "detekt":
    case "rubocop":
    case "cppcheck":
    case "clang-tidy":
      return "lint";
    case "dotnet":
      return args[0] === "test" ? "tests" : args[0] === "build" ? "build" : args[0] === "format" && has(args, "--verify-no-changes") ? "lint" : null;
    case "rspec":
    case "phpunit":
    case "pest":
    case "ctest":
      return "tests";
    case "rails":
      return args[0] === "test" || args[0] === "spec" ? "tests" : null;
    case "php":
      return args[0] === "artisan" && args[1] === "test" ? "tests" : null;
    case "mix":
      return args[0] === "test" ? "tests" : args[0] === "compile" ? "build" : args[0] === "credo" ? "lint" : args[0] === "dialyzer" ? "typecheck" : args[0] === "format" && has(args, "--check-formatted") ? "lint" : null;
    case "flutter":
    case "dart":
      return args[0] === "test" ? "tests" : args[0] === "analyze" ? "lint" : args[0] === "build" && prog === "flutter" ? "build" : null;
    case "bazel":
    case "bazelisk":
    case "stack":
    case "cabal":
    case "sbt":
    case "gleam":
      return args[0] === "test" ? "tests" : args[0] === "build" || args[0] === "compile" ? "build" : null;
    case "zig":
      return args[0] === "build" ? (args[1] === "test" ? "tests" : "build") : args[0] === "test" ? "tests" : null;
    case "cmake":
      return args[0] === "--build" ? "build" : null;
    default:
      return null;
  }
}

function quote(w: string): string {
  return /^[\w@%+=:,./~^-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface Analysis extends Classified {
  masked?: string; // the part of the command that hides the verification's exit code, e.g. "| tail -20"
}

function analyze(cmd: string): Analysis | null {
  const segs = splitShell(cmd);
  const dirs: string[] = [];
  const found: { kind: CheckKind; text: string; index: number }[] = [];
  segs.forEach((seg, index) => {
    const words = stripPrefixes(seg.words);
    if (!words.length) return;
    const prog = base(words[0]);
    if ((prog === "cd" || prog === "pushd") && !found.length) {
      if (words[1] && words[1] !== "-") dirs.push(words[1]);
      return;
    }
    // A command fed by a pipe (`... | tail`) is never the verification itself.
    if (index > 0 && segs[index - 1].op === "|") return;
    const kind = kindOf(words);
    if (kind) found.push({ kind, text: words.map(quote).join(" "), index });
  });
  if (!found.length) return null;
  const kind = bestOf(found.map((f) => f.kind))!;
  const dir = dirs.length ? ` (in ${dirs.join("/")})` : "";
  const label = truncate(found.map((f) => f.text).join(" && "), MAX_LABEL - dir.length) + dir;

  // `a && b`: the exit code is the first failure, so a failing check still fails the whole command.
  // `check | tail`, `check; echo`, `check || true`: the check's own exit code is lost.
  let masked: string | undefined;
  for (let i = found[0].index; i < segs.length; i++) {
    const op = segs[i].op;
    if (!op || op === "&&") continue;
    const rest = segs.slice(i + 1).filter((x) => x.words.length);
    if (!rest.length) break; // a trailing `;`
    masked = `${op} ${rest[0].words.map(quote).join(" ")}`;
    break;
  }
  return { kind, label, masked };
}

/**
 * Recognises verification commands (tests, builds, typechecks, lints) across ecosystems, looking through
 * `cd dir &&`, env prefixes, wrappers (npx, uv run, python -m, ...), pipes and redirections.
 * Returns null for anything else.
 */
export function classifyCommand(cmd: string): Classified | null {
  if (!cmd || typeof cmd !== "string") return null;
  const a = analyze(cmd);
  return a ? { kind: a.kind, label: a.label } : null;
}

// ---------------------------------------------------------------------------------------------
// Result parsing: cheap, best-effort summaries from the common runners' final lines.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

interface Parsed {
  summary?: string;
  failed?: boolean; // the output itself shows failures (catches exit codes hidden by a pipe)
}

function counts(c: { passed?: number; failed?: number; skipped?: number }): Parsed {
  const parts: string[] = [];
  if (c.failed) parts.push(`${c.failed} failed`);
  parts.push(`${c.passed ?? 0} passed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return { summary: parts.join(", "), failed: (c.failed ?? 0) > 0 };
}

function sumAll(text: string, re: RegExp, group = 1): number | undefined {
  let total: number | undefined;
  for (const m of text.matchAll(re)) total = (total ?? 0) + Number(m[group]);
  return total;
}

export function parseSummary(output: string): Parsed {
  const t = output.replace(ANSI, "").replace(/\r/g, "");

  // node:test (spec reporter "ℹ pass 45", TAP "# pass 45")
  const nodePass = sumAll(t, /^[ℹ#] pass (\d+)$/gm);
  if (nodePass !== undefined) return counts({ passed: nodePass, failed: sumAll(t, /^[ℹ#] fail (\d+)$/gm), skipped: sumAll(t, /^[ℹ#] skipped (\d+)$/gm) });

  // jest "Tests:       1 failed, 2 skipped, 44 passed, 47 total" / vitest "      Tests  3 failed | 42 passed (45)"
  const testLines = [...t.matchAll(/^\s*Tests:?\s+(\d+ (?:failed|passed|skipped|todo)[^\n]*)$/gm)].map((m) => m[1]);
  if (testLines.length) {
    const n = (w: string) => testLines.reduce((s, l) => s + Number(new RegExp(`(\\d+) ${w}`).exec(l)?.[1] ?? 0), 0);
    return counts({ passed: n("passed"), failed: n("failed"), skipped: n("skipped") });
  }

  // cargo "test result: FAILED. 10 passed; 2 failed; 0 ignored"
  const cargoPass = sumAll(t, /^test result: \w+\. (\d+) passed; \d+ failed/gm);
  if (cargoPass !== undefined) return counts({ passed: cargoPass, failed: sumAll(t, /^test result: \w+\. \d+ passed; (\d+) failed/gm), skipped: sumAll(t, /; (\d+) ignored/gm) });

  // pytest "===== 3 failed, 42 passed, 1 skipped in 1.23s =====" (also -q without the rules)
  const py = [...t.matchAll(/^(?:=+ )?((?:\d+ (?:failed|passed|skipped|errors?|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s/gm)].pop();
  if (py) {
    const n = (w: string) => Number(new RegExp(`(\\d+) ${w}`).exec(py[1])?.[1] ?? 0);
    return counts({ passed: n("passed"), failed: n("failed") + n("errors?"), skipped: n("skipped") });
  }
  if (/^=+ no tests ran/m.test(t)) return { summary: "no tests ran" };

  // mocha "45 passing (2s)" / "3 failing"
  const mochaPass = /^\s*(\d+) passing\b/m.exec(t);
  if (mochaPass) return counts({ passed: Number(mochaPass[1]), failed: Number(/^\s*(\d+) failing\b/m.exec(t)?.[1] ?? 0), skipped: Number(/^\s*(\d+) pending\b/m.exec(t)?.[1] ?? 0) });

  // rspec "45 examples, 2 failures"
  const rspec = /(\d+) examples?, (\d+) failures?/.exec(t);
  if (rspec) return counts({ passed: Number(rspec[1]) - Number(rspec[2]), failed: Number(rspec[2]) });

  // XCTest / swift test "Executed 12 tests, with 1 failure"
  const xc = [...t.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].pop();
  if (xc) return counts({ passed: Number(xc[1]) - Number(xc[2]), failed: Number(xc[2]) });

  // dotnet "Failed!  - Failed:     2, Passed:    10, Skipped:     0"
  const dn = /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+)/.exec(t);
  if (dn) return counts({ passed: Number(dn[2]), failed: Number(dn[1]) });

  // go test: one "ok  pkg 0.1s" / "FAIL pkg" line per package
  const goOk = (t.match(/^ok\s+\S+/gm) ?? []).length;
  const goFail = (t.match(/^FAIL\s+\S+/gm) ?? []).length;
  if (goOk || goFail) {
    const pk = (n: number) => `${n} package${n === 1 ? "" : "s"}`;
    return { summary: goFail ? `${pk(goFail)} failed, ${goOk} ok` : `${pk(goOk)} ok`, failed: goFail > 0 };
  }

  // eslint "✖ 5 problems (3 errors, 2 warnings)"
  const es = /✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)/.exec(t);
  if (es) {
    const e = Number(es[1]);
    const w = Number(es[2]);
    return { summary: [e && `${e} error${e === 1 ? "" : "s"}`, w && `${w} warning${w === 1 ? "" : "s"}`].filter(Boolean).join(", ") || "clean", failed: e > 0 };
  }

  // tsc / mypy / ruff "Found 3 errors"; tsc without the footer: "file.ts(1,2): error TS2322"
  const found = /Found (\d+) errors?\b/.exec(t);
  const tsErrors = (t.match(/error TS\d+:/g) ?? []).length;
  const errors = found ? Number(found[1]) : tsErrors;
  if (errors) return { summary: `${errors} error${errors === 1 ? "" : "s"}`, failed: true };
  if (/^Success: no issues found/m.test(t)) return { summary: "no issues" };
  if (/^All checks passed!?$/m.test(t)) return { summary: "all checks passed" };

  return {};
}

// ---------------------------------------------------------------------------------------------
// Tracker over raw ACP tool_call / tool_call_update notifications.

/** The fields of an ACP tool_call / tool_call_update this module reads. Extra fields are ignored. */
export interface ToolUpdateLike {
  toolCallId: string;
  sessionUpdate?: string;
  kind?: string | null;
  title?: string | null;
  status?: string | null;
  name?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  _meta?: Record<string, unknown> | null;
}

interface Pending {
  command?: string;
  startedAt: number;
  structured?: { stdout?: string; stderr?: string; interrupted?: boolean; backgrounded?: boolean };
  terminal: string;
  terminalExit?: number | null;
  background: boolean;
}

const EXEC_TOOLS = new Set(["Bash", "PowerShell", "shell", "exec_command", "local_shell"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toolNameOf(u: ToolUpdateLike): string | undefined {
  if (typeof u.name === "string") return u.name;
  const cc = isObj(u._meta) && isObj(u._meta.claudeCode) ? u._meta.claudeCode : undefined;
  return typeof cc?.toolName === "string" ? cc.toolName : undefined;
}

function commandOf(rawInput: unknown): string | undefined {
  if (!isObj(rawInput)) return undefined;
  const c = rawInput.command ?? rawInput.cmd;
  if (typeof c === "string") return c.trim() || undefined;
  // Codex-style argv: ["bash", "-lc", "npm test"]
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const argv = c as string[];
    if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1])) return argv[2];
    return argv.map(quote).join(" ") || undefined;
  }
  return undefined;
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  if (isObj(v)) {
    if (typeof v.text === "string") return v.text;
    if (v.type === "content") return textOf(v.content);
    if (typeof v.stdout === "string" || typeof v.stderr === "string") return [v.stdout, v.stderr].filter((s) => typeof s === "string" && s).join("\n");
    if (typeof v.output === "string") return v.output;
    if (typeof v.formatted_output === "string") return v.formatted_output;
  }
  return "";
}

const unfence = (s: string) => s.replace(/^```[\w-]*\n([\s\S]*?)\n?```$/gm, "$1");

function numberField(v: unknown, ...keys: string[]): number | undefined {
  if (!isObj(v)) return undefined;
  for (const k of keys) if (typeof v[k] === "number") return v[k] as number;
  return undefined;
}

function tailLines(text: string, n: number, max: number): string | undefined {
  const lines = text.replace(ANSI, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const s = lines.slice(-n).join("\n");
  return s ? truncate(s, max) : undefined;
}

export interface ProofTrackerOptions {
  now?: () => number;
}

/**
 * Watches execute tool calls; when one whose command is a verification finishes, records a Proof with
 * its real result. Keeps only the latest result per label (re-running `npm test` replaces the old run).
 */
export class ProofTracker {
  private pending = new Map<string, Pending>();
  private results = new Map<string, Proof>();
  private now: () => number;

  constructor(opts: ProofTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private isExec(u: ToolUpdateLike): boolean {
    const name = toolNameOf(u);
    return u.kind === "execute" || (name !== undefined && EXEC_TOOLS.has(name));
  }

  onToolCall(update: ToolUpdateLike): Proof | undefined {
    if (!this.isExec(update)) return undefined;
    this.pending.set(update.toolCallId, { startedAt: this.now(), terminal: "", background: false });
    return this.absorb(update);
  }

  /** Returns the Proof recorded when this update finished a verification command. */
  onToolUpdate(update: ToolUpdateLike): Proof | undefined {
    if (!this.pending.has(update.toolCallId)) {
      // A call first seen here (reattach): track it only if it is clearly a command.
      if (!this.isExec(update)) return undefined;
      this.pending.set(update.toolCallId, { startedAt: this.now(), terminal: "", background: false });
    }
    return this.absorb(update);
  }

  /** Observed proofs, oldest first. */
  proofs(): Proof[] {
    return [...this.results.values()];
  }

  /** Forget recorded results (call when a new turn starts). Commands still running stay tracked. */
  reset(): void {
    this.results.clear();
  }

  private absorb(u: ToolUpdateLike): Proof | undefined {
    const p = this.pending.get(u.toolCallId)!;
    const cmd = commandOf(u.rawInput);
    if (cmd && cmd !== p.command) {
      // The input is complete only now (the first tool_call carries `{}`), so time from here.
      if (!p.command) p.startedAt = this.now();
      p.command = cmd;
    }
    if (isObj(u.rawInput) && u.rawInput.run_in_background === true) p.background = true;

    const meta = isObj(u._meta) ? u._meta : undefined;
    const cc = meta && isObj(meta.claudeCode) ? meta.claudeCode : undefined;
    const tr = cc && isObj(cc.toolResponse) ? cc.toolResponse : undefined;
    if (tr && (typeof tr.stdout === "string" || typeof tr.stderr === "string")) {
      p.structured = {
        stdout: typeof tr.stdout === "string" ? tr.stdout : undefined,
        stderr: typeof tr.stderr === "string" ? tr.stderr : undefined,
        interrupted: tr.interrupted === true,
        backgrounded: tr.backgroundTaskId !== undefined,
      };
      if (p.structured.backgrounded) p.background = true;
    }
    const air = meta && isObj(meta["jetbrains.air"]) ? meta["jetbrains.air"] : undefined;
    if (air && JSON.stringify(air).includes('"backgrounded":true')) p.background = true;
    if (meta && isObj(meta.terminal_output) && typeof meta.terminal_output.data === "string") p.terminal = meta.terminal_output.data;
    if (meta && isObj(meta.terminal_output_delta) && typeof meta.terminal_output_delta.data === "string") p.terminal += meta.terminal_output_delta.data;
    if (meta && isObj(meta.terminal_exit)) {
      const code = meta.terminal_exit.exit_code;
      p.terminalExit = typeof code === "number" ? code : null;
    }

    const status = u.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return undefined;
    this.pending.delete(u.toolCallId);
    if (status === "cancelled" || p.background || p.structured?.interrupted || !p.command) return undefined;

    const a = analyze(p.command);
    if (!a) return undefined;

    const raw = typeof u.rawOutput === "string" ? u.rawOutput : textOf(u.rawOutput);
    const contentText = unfence(textOf(u.content));
    const failText = raw || contentText;
    let exitCode: number | undefined = typeof p.terminalExit === "number" ? p.terminalExit : numberField(u.rawOutput, "exit_code", "exitCode", "returncode", "return_code");
    if (exitCode === undefined) {
      const m = /^Exit code (\d+)(?:\n|$)/.exec(failText);
      if (m) exitCode = Number(m[1]);
      else if (status === "completed") exitCode = 0;
    }

    let output = p.structured ? [p.structured.stdout, p.structured.stderr].filter(Boolean).join("\n") : p.terminal || raw || contentText;
    output = output.replace(/^Exit code \d+\n?/, "");
    const timedOut = exitCode === undefined && /timed out|timeout/i.test(failText);
    // A failure without an exit code is a command that never ran (denied, could not start): no proof.
    if (exitCode === undefined && !timedOut) return undefined;

    const parsed = parseSummary(output);
    const passed = exitCode === 0 && !parsed.failed;
    const summary = timedOut ? "timed out" : parsed.summary;
    let detail: string | undefined;
    if (!passed) detail = tailLines(output, 4, 300);
    else if (a.masked && !parsed.summary) detail = `exit code hidden by \`${truncate(a.masked, 40)}\``;

    const proof: Proof = {
      kind: a.kind,
      label: a.label,
      passed,
      observed: true,
      command: p.command,
      durationMs: Math.max(0, this.now() - p.startedAt),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(summary ? { summary } : {}),
      ...(detail ? { detail } : {}),
    };
    this.results.delete(a.label); // re-insert so the order stays "latest last"
    this.results.set(a.label, proof);
    return proof;
  }
}

// ---------------------------------------------------------------------------------------------
// Merging with what the agent reported.

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

// Which observed kinds settle an agent-reported kind. report_outcome only offers tests/build/command/...,
// so agents file a tsc run under "build".
const SUPERSEDES: Partial<Record<Proof["kind"], Proof["kind"][]>> = {
  tests: ["tests"],
  build: ["build", "typecheck"],
  typecheck: ["typecheck"],
  lint: ["lint"],
};

/**
 * Status of an outcome the daemon builds itself (the agent didn't report one): success only when at least
 * one observed check ran and all of them passed; any observed failure is partial; nothing observed is unverified.
 */
export function derivedStatus(proof: Proof[]): "success" | "partial" | "unverified" {
  const seen = proof.filter((p) => p.observed);
  if (!seen.length) return "unverified";
  return seen.every((p) => p.passed) ? "success" : "partial";
}

/**
 * Observed proofs first; then the agent's own claims that no observation settles. A reported proof is
 * dropped when an observed proof has a superseding kind, or when its label is (or classifies like) an
 * observed command.
 */
export function mergeProofs(observed: Proof[], reported: Proof[] = []): Proof[] {
  if (!observed.length) return reported;
  const kinds = new Set(observed.map((p) => p.kind));
  const labels = new Set(observed.flatMap((p) => [norm(p.label), ...(p.command ? [norm(p.command)] : [])]));
  const kept = reported.filter((r) => {
    if (r.observed) return false; // already in `observed`, or a stale copy of it
    if ((SUPERSEDES[r.kind] ?? []).some((k) => kinds.has(k))) return false;
    if (labels.has(norm(r.label))) return false;
    const c = classifyCommand(r.label);
    if (c && (labels.has(norm(c.label)) || kinds.has(c.kind))) return false;
    return true;
  });
  return [...observed, ...kept];
}
