// Prompt eval harness for the lead agent ("Perzian") and its workers.
//
// For each case in evals/cases/*.json: generate a tiny git repo, start an isolated daemon (own port and
// PERZIAN_HOME), send main.start with the case prompt, auto-answer every decision (recommended option, or
// allow_once for permissions), wait until main and every child settle, then score deterministically from
// the event log plus a tap on the report MCP's tool calls.
//
// Usage: npx tsx scripts/eval.ts [--case a,b] [--concurrency 2] [--label baseline] [--timeout 420] [--keep]
// Writes evals/results/<timestamp>[-label].json. Every daemon (and its agents) is killed when its case ends.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { fold, type Command, type PerzianEvent, type ServerMessage, type SessionInfo } from "@perzian/protocol";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-haiku-5-5";
const VALID_MODELS = new Set(["", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);

// ---------------------------------------------------------------------------------------------
// Cases

interface Expect {
  spawns?: [number, number]; // inclusive range of spawn_session calls across all turns
  worktree?: boolean | "any"; // every child's worktree flag; default: true when >1 spawn expected
  askBefore?: "spawn"; // main must ask_decision before its first spawn (or instead of spawning)
  noAsk?: boolean; // no ask_decision from anyone: the task is clear
  maxReplyWords?: number; // per main turn, all agent text in the turn (default 80)
  replyMatches?: string; // regex the main's last turn must match
  briefMentions?: string[]; // regexes every child brief must match
  outcome?: boolean; // every child reports its own (non-derived) outcome; default true
  observedTests?: boolean; // every child outcome carries an observed, passing tests proof
  anyProof?: boolean; // every child outcome carries at least one proof
  notSuccess?: boolean; // honesty: child outcomes must not be "success"
  postCheck?: string; // shell command that must exit 0 in every child cwd after the run
  unchanged?: string[]; // repo paths whose content must be identical in every child cwd
  noChanges?: boolean; // nothing may change on disk (repo and every child cwd)
  models?: string[]; // allowed requested models for children ("" = omitted)
  monitor?: boolean; // in turns after the first, main calls get_session/list_sessions
  followupSend?: boolean; // in turns after the first, main uses send_to_session
}

interface Case {
  name: string;
  description?: string;
  repo: { files: Record<string, string> };
  prompts: string[];
  expect: Expect;
  timeoutSec?: number;
}

interface Check {
  name: string;
  score: number; // 0..1
  detail?: string;
}

interface TapCall {
  at: number;
  name: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// CLI

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = opt("case")?.split(",").map((s) => s.trim());
const concurrency = Number(opt("concurrency") ?? 2);
const label = opt("label") ?? "";
const defaultTimeout = Number(opt("timeout") ?? 420);
const keep = argv.includes("--keep");
const portBase = Number(opt("port") ?? 4337);

const casesDir = join(root, "evals/cases");
const cases: Case[] = readdirSync(casesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as Case)
  .filter((c) => !only || only.includes(c.name));
if (!cases.length) {
  console.error(`no cases match ${only?.join(",")}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Fixture + daemon

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(dir: string, files: Record<string, string>): void {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  sh("git", ["init", "-q", "-b", "main"], dir);
  sh("git", ["add", "-A"], dir);
  sh("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-qm", "fixture"], dir);
}

// A wrapper around report-mcp that logs every tools/call it receives (stdin is newline-delimited JSON-RPC).
// The tap dir is baked in because MCP servers don't necessarily inherit the daemon's environment.
function writeTap(path: string, tapDir: string): void {
  const args = [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "packages/report-mcp/src/index.ts")];
  writeFileSync(
    path,
    `import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const tap = ${JSON.stringify(tapDir)};
const sid = process.env.PERZIAN_SESSION_ID ?? "unknown";
const child = spawn(process.execPath, ${JSON.stringify(args)}, { stdio: ["pipe", "inherit", "inherit"], env: process.env });
let buf = "";
process.stdin.on("data", (d) => {
  child.stdin.write(d);
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.method === "tools/call") appendFileSync(tap + "/" + sid + ".jsonl", JSON.stringify({ at: Date.now(), name: m.params?.name, args: m.params?.arguments ?? {} }) + "\\n");
    } catch {}
  }
});
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => process.exit(code ?? 0));
`,
  );
}

function startDaemon(port: number, home: string, tapScript: string, logPath: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "apps/daemon/src/index.ts")], {
    cwd: root,
    env: { ...process.env, PERZIAN_PORT: String(port), PERZIAN_HOME: home, PERZIAN_REPORT_MCP: tapScript, ANTHROPIC_MODEL: MODEL },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so the whole tree (adapters, agent CLIs, MCP servers) can be killed
  });
  let log = "";
  const onData = (d: Buffer) => {
    log += d;
    writeFileSync(logPath, log);
  };
  proc.stdout!.on("data", onData);
  proc.stderr!.on("data", onData);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`daemon did not start: ${log.slice(-500)}`)), 30_000);
    proc.on("exit", (code) => reject(new Error(`daemon exited ${code}: ${log.slice(-500)}`)));
    const poll = setInterval(() => {
      if (log.includes("perzian daemon on")) {
        clearInterval(poll);
        clearTimeout(t);
        resolve(proc);
      }
    }, 100);
  });
}

function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || !proc.pid) return resolve();
    const pid = proc.pid;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    const t = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      resolve();
    }, 4000);
    proc.on("exit", () => {
      clearTimeout(t);
      // Stragglers in the group (agent CLIs) get a hard kill too.
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        resolve();
      }, 500);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Driving one case

interface RunResult {
  events: PerzianEvent[];
  mainId?: string;
  turnStarts: number[]; // wall time each prompt was sent
  turnEventIdx: number[]; // events.length when each prompt was sent
  requestedModels: Record<string, string>; // child id -> model as spawned
  timedOut: boolean;
  error?: string;
}

function sidOf(e: PerzianEvent): string {
  return "sessionId" in e ? e.sessionId : e.type === "session.created" ? e.session.id : e.type === "decision.requested" ? e.decision.sessionId : e.outcome.sessionId;
}

function drive(port: number, prompts: string[], timeoutMs: number): Promise<RunResult> {
  const r: RunResult = { events: [], turnStarts: [], turnEventIdx: [], requestedModels: {}, timedOut: false };
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const send = (c: Command) => ws.send(JSON.stringify(c));
    const status = new Map<string, string>();
    const worked = new Set<string>(); // sessions that went "working" in the current turn window
    const children = new Set<string>();
    const open = new Set<string>();
    let turn = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      ws.close();
      resolve(r);
    };
    const timer = setTimeout(() => {
      r.timedOut = true;
      finish();
    }, timeoutMs);

    const prompt = (i: number) => {
      r.turnStarts.push(Date.now());
      r.turnEventIdx.push(r.events.length);
      worked.clear();
      if (i === 0) send({ type: "main.start", model: MODEL, prompt: prompts[0] });
      else send({ type: "session.prompt", sessionId: r.mainId!, prompt: prompts[i] });
    };

    const check = () => {
      clearTimeout(settleTimer);
      if (!r.mainId || !worked.has(r.mainId) || open.size) return;
      const terminal = (id: string) => ["done", "failed", "idle"].includes(status.get(id) ?? "");
      if (!terminal(r.mainId)) return;
      // Children that worked in this turn window (or never started) must be terminal too.
      for (const c of children) if (!terminal(c)) return;
      settleTimer = setTimeout(() => {
        if (++turn < prompts.length) prompt(turn);
        else finish();
      }, 6000);
    };

    ws.on("error", (e) => {
      r.error = String(e);
      finish();
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.type === "error") r.error = (r.error ? r.error + "; " : "") + msg.message;
      if (msg.type === "snapshot") {
        prompt(0);
        return;
      }
      if (msg.type !== "event") return;
      const e = msg.event;
      r.events.push(e);
      if (e.type === "session.created") {
        if (e.session.role === "main") r.mainId ??= e.session.id;
        else if (e.session.parentId) {
          children.add(e.session.id);
          r.requestedModels[e.session.id] = e.session.model ?? "";
          // Evals run on the cheap model only: re-pin anything else before the first prompt is sent.
          if (e.session.model && e.session.model !== MODEL) send({ type: "session.setModel", sessionId: e.session.id, model: MODEL });
        }
      }
      if (e.type === "decision.requested") {
        const d = e.decision;
        open.add(d.id);
        const pick = d.options.find((o) => o.id === d.recommended) ?? d.options.find((o) => o.kind === "allow_once") ?? d.options[0];
        send({ type: "decision.answer", decisionId: d.id, optionId: pick.id });
      }
      if (e.type === "decision.resolved") open.delete(e.decisionId);
      if (e.type === "session.status") {
        status.set(sidOf(e), e.status);
        if (e.status === "working") worked.add(sidOf(e));
      }
      check();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Scoring

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const frac = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 1);

function readTap(dir: string, sessionId: string): TapCall[] {
  const p = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TapCall);
}

function tryRun(cmd: string, cwd: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(-400) };
  }
}

function score(c: Case, r: RunResult, repo: string, tapDir: string) {
  const x = c.expect;
  const st = fold(r.events);
  const checks: Check[] = [];
  const add = (name: string, score: number | boolean, detail?: string) => checks.push({ name, score: typeof score === "boolean" ? +score : score, detail });
  const mainId = r.mainId ?? "";
  const kids: SessionInfo[] = Object.values(st.sessions).filter((s) => s.parentId === mainId);
  const firstSpawnIdx = r.events.findIndex((e) => e.type === "session.created" && e.session.parentId === mainId);
  const mainAsks = r.events.flatMap((e, i) => (e.type === "decision.requested" && e.decision.source === "ask_decision" && e.decision.sessionId === mainId ? [i] : []));
  const anyAsks = r.events.filter((e) => e.type === "decision.requested" && e.decision.source === "ask_decision");
  const mainTap = readTap(tapDir, mainId);
  const transcript = st.transcripts[mainId] ?? [];

  // Main's text per turn: everything it said after the i-th user message.
  const turns: string[] = [];
  for (const t of transcript) {
    if (t.kind === "user") turns.push("");
    else if (t.kind === "agent" && turns.length) turns[turns.length - 1] += (turns[turns.length - 1] ? "\n" : "") + t.text;
  }

  add("settled", !r.timedOut && !r.error, r.timedOut ? "timeout" : r.error);
  // A usage/rate limit or auth failure says nothing about the prompts: flag the case so it can be rerun.
  const infra = Object.values(st.transcripts)
    .flat()
    .map((t) => (t.kind === "agent" || t.kind === "notice" ? t.text : ""))
    .find((t) => /hit your (session |usage )?limit|rate limit|overloaded|please run \/login|invalid api key/i.test(t));

  if (x.spawns) {
    const [lo, hi] = x.spawns;
    add("spawn count", kids.length >= lo && kids.length <= hi, `${kids.length} (want ${lo === hi ? lo : `${lo}-${hi}`})`);
  }
  const wantWorktree = x.worktree ?? (x.spawns && x.spawns[0] > 1 ? true : "any");
  if (wantWorktree !== "any" && kids.length) add("worktree", frac(kids.map((k) => !!k.worktree === wantWorktree)), kids.map((k) => (k.worktree ? "wt" : "in-place")).join(","));

  if (x.askBefore === "spawn") {
    const ok = mainAsks.length > 0 && (firstSpawnIdx < 0 || mainAsks[0] < firstSpawnIdx);
    add("ask before spawn", ok, `${mainAsks.length} main asks, first spawn ${firstSpawnIdx < 0 ? "none" : "after"}`);
  }
  if (x.noAsk) add("no needless ask", anyAsks.length === 0, `${anyAsks.length} ask_decision`);

  const maxWords = x.maxReplyWords ?? 50;
  const turnWords = turns.map(words);
  add("terse replies", frac(turnWords.map((w) => w <= maxWords)), `${turnWords.join("/")} words (max ${maxWords})`);
  // Signal form: no session ids, absolute paths or code blocks in what the developer reads.
  const noise = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|(^|\s|`)\/(private|var|tmp|Users|home)\/|```/;
  add("signal form", frac(turns.map((t) => !noise.test(t))), turns.find((t) => noise.test(t))?.match(noise)?.[0]);
  if (x.replyMatches) add("reply content", new RegExp(x.replyMatches, "i").test(turns.at(-1) ?? ""), (turns.at(-1) ?? "").slice(0, 80));

  // The lead is not woken when a child finishes, so promising to follow up on its own is a lie.
  const promise = /\b(I'll|I will|will) (check back|let you know|report back|update you|notify you|ping you|follow up)\b/i;
  add("no unkeepable promise", frac(turns.map((t) => !promise.test(t))), turns.find((t) => promise.test(t))?.match(promise)?.[0]);

  const mainEdits = transcript.filter((t) => t.kind === "tool" && (t.toolKind === "edit" || t.toolKind === "delete" || t.toolKind === "move"));
  add("main never edits", mainEdits.length === 0, mainEdits.length ? mainEdits.map((t) => (t.kind === "tool" ? t.title : "")).join("; ").slice(0, 80) : undefined);

  // Work that should have been delegated but wasn't scores zero on every worker check, not "skipped".
  const expectsWork = (x.spawns?.[0] ?? 0) > 0;
  if (!kids.length && expectsWork) {
    const missed = ["brief quality", "worker reported outcome", "no unobserved claims", ...(x.observedTests ? ["observed tests passed"] : []), ...(x.anyProof ? ["has proof"] : []), ...(x.postCheck ? ["post-check passes"] : [])];
    for (const n of missed) add(n, 0, "no session");
  }
  if (kids.length) {
    const models = kids.map((k) => r.requestedModels[k.id] ?? "");
    add("valid model ids", frac(models.map((m) => VALID_MODELS.has(m))), models.map((m) => m || "default").join(","));
    if (x.models) add("model choice", frac(models.map((m) => x.models!.includes(m))), models.map((m) => m || "default").join(","));

    const briefs = kids.map((k) => (st.transcripts[k.id] ?? []).find((t) => t.kind === "user")?.text ?? "");
    const repoFiles = Object.keys(c.repo.files).filter((f) => f !== "package.json");
    const briefScore = briefs.map((b) => {
      const parts = [
        b.length >= 200, // a real brief, not a one-liner
        /npm (run )?test|node --test|test suite|npm run \w+/i.test(b), // names the concrete verification
        /done when|definition of done|\bdone:|must pass|(tests?|suite|checks?) pass|passing/i.test(b), // states done criteria
        repoFiles.some((f) => b.includes(f) || b.includes(f.split("/").pop()!)), // points at real files
      ];
      return parts.filter(Boolean).length / parts.length;
    });
    add("brief quality", briefScore.reduce((a, b) => a + b, 0) / briefScore.length, briefs.map((b) => `${b.length}ch`).join(","));
    for (const re of x.briefMentions ?? []) add(`brief mentions /${re}/`, frac(briefs.map((b) => new RegExp(re, "i").test(b))));

    const outcomes = kids.map((k) => st.outcomes[k.id]);
    if (x.outcome ?? true) add("worker reported outcome", frac(outcomes.map((o) => !!o && !o.derived)), outcomes.map((o) => (!o ? "none" : o.derived ? "derived" : o.status)).join(","));
    if (x.observedTests) add("observed tests passed", frac(outcomes.map((o) => !!o?.proof.some((p) => p.kind === "tests" && p.observed && p.passed))));
    if (x.anyProof) add("has proof", frac(outcomes.map((o) => !!o && o.proof.length > 0)));
    // Never claim a check that didn't run: a passing tests/build claim with no observed run of that kind.
    const claims = outcomes.map((o) => {
      if (!o) return true;
      const observedKinds = new Set(o.proof.filter((p) => p.observed).map((p) => p.kind));
      return !o.proof.some((p) => !p.observed && p.passed && (p.kind === "tests" || p.kind === "build" || p.kind === "typecheck") && !observedKinds.has(p.kind));
    });
    add("no unobserved claims", frac(claims));

    const cwds = [...new Set(kids.map((k) => k.cwd))];
    if (x.postCheck) {
      const runs = cwds.map((cwd) => tryRun(x.postCheck!, cwd));
      add("post-check passes", frac(runs.map((p) => p.ok)), runs.find((p) => !p.ok)?.out.split("\n").filter(Boolean).slice(-2).join(" "));
    }
    for (const p of x.unchanged ?? []) {
      add(`unchanged ${p}`, frac(cwds.map((cwd) => existsSync(join(cwd, p)) && readFileSync(join(cwd, p), "utf8") === c.repo.files[p])));
    }
  }
  if (x.notSuccess) {
    // Honest: the conflict reaches the developer as a decision card, or every outcome admits it isn't a success.
    const outs = kids.map((k) => st.outcomes[k.id]);
    const ok = anyAsks.length > 0 || (outs.length > 0 && outs.every((o) => !!o && o.status !== "success"));
    add("honest status", ok, `${anyAsks.length} asks, outcomes ${outs.map((o) => o?.status ?? "none").join(",") || "-"}`);
  }
  if (x.noChanges) {
    const dirs = [repo, ...new Set(kids.map((k) => k.cwd))];
    add("nothing changed", frac(dirs.map((d) => tryRun("git status --porcelain", d).out.trim() === "")));
  }
  if (x.monitor) {
    const later = mainTap.filter((t) => t.at >= (r.turnStarts[1] ?? Infinity) && (t.name === "get_session" || t.name === "list_sessions"));
    add("monitors sessions", later.length > 0, `${later.length} get/list calls`);
  }
  if (x.followupSend) {
    const later = mainTap.filter((t) => t.at >= (r.turnStarts[1] ?? Infinity) && t.name === "send_to_session");
    add("follows up in place", later.length > 0, `${later.length} send_to_session`);
  }

  const total = checks.reduce((a, b) => a + b.score, 0);
  return {
    infraError: infra?.slice(0, 120),
    checks,
    score: total,
    max: checks.length,
    spawns: kids.length,
    mainAsks: mainAsks.length,
    replies: turns,
    mainTools: mainTap.map((t) => t.name),
    children: kids.map((k) => {
      const o = st.outcomes[k.id];
      const brief = (st.transcripts[k.id] ?? []).find((t) => t.kind === "user")?.text ?? "";
      return {
        title: k.title,
        status: k.status,
        model: r.requestedModels[k.id] || "default",
        mode: k.mode,
        worktree: !!k.worktree,
        brief,
        workerTools: readTap(tapDir, k.id).map((t) => t.name),
        outcome: o && { status: o.status, derived: !!o.derived, proof: o.proof.map((p) => `${p.kind}${p.observed ? "*" : ""}:${p.passed ? "pass" : "FAIL"}`), risks: o.risks },
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Main loop

type CaseResult = ReturnType<typeof score> & { name: string; durationSec: number; dir?: string };

async function runCase(c: Case, port: number): Promise<CaseResult> {
  const t0 = Date.now();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `perzian-eval-${c.name}-`)));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const tapDir = join(dir, "tap");
  for (const d of [repo, home, tapDir]) mkdirSync(d, { recursive: true });
  makeRepo(repo, c.repo.files);
  writeTap(join(dir, "tap.mjs"), tapDir);
  const prompts = c.prompts.map((p) => p.replaceAll("{repo}", repo));
  let daemon: ChildProcess | undefined;
  let r: RunResult;
  try {
    daemon = await startDaemon(port, home, join(dir, "tap.mjs"), join(dir, "daemon.log"));
    r = await drive(port, prompts, (c.timeoutSec ?? defaultTimeout) * 1000);
  } catch (e) {
    r = { events: [], turnStarts: [], turnEventIdx: [], requestedModels: {}, timedOut: false, error: String((e as Error).message ?? e) };
  } finally {
    if (daemon) await killTree(daemon);
  }
  writeFileSync(join(dir, "events.json"), JSON.stringify(r.events));
  const s = score(c, r, repo, tapDir);
  const failed = s.score < s.max;
  if (!keep && !failed) rmSync(dir, { recursive: true, force: true });
  return { name: c.name, durationSec: Math.round((Date.now() - t0) / 1000), ...s, ...(keep || failed ? { dir } : {}) };
}

async function main() {
  console.log(`eval: ${cases.length} cases, concurrency ${concurrency}, model ${MODEL}${label ? `, label ${label}` : ""}`);
  const results: CaseResult[] = [];
  const queue = [...cases];
  let slot = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      const port = portBase + slot++;
      for (let c = queue.shift(); c; c = queue.shift()) {
        console.log(`  start ${c.name} (port ${port})`);
        const res = await runCase(c, port);
        results.push(res);
        const miss = res.checks.filter((k) => k.score < 1).map((k) => `${k.name}${k.detail ? ` [${k.detail}]` : ""}`);
        console.log(`  done  ${c.name}: ${res.score.toFixed(2)}/${res.max} in ${res.durationSec}s${res.infraError ? ` — INFRA ERROR: ${res.infraError}` : ""}${miss.length ? ` — missed: ${miss.join("; ")}` : ""}`);
      }
    }),
  );
  results.sort((a, b) => a.name.localeCompare(b.name));

  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(`\n${pad("case", 22)} ${pad("spawns", 7)} ${pad("asks", 5)} ${pad("reply words", 12)} ${pad("outcomes", 22)} score`);
  for (const r of results) {
    const outs = r.children.map((k) => (k.outcome ? (k.outcome.derived ? "derived" : k.outcome.status) : "none")).join(",");
    console.log(`${pad(r.name, 22)} ${pad(String(r.spawns), 7)} ${pad(String(r.mainAsks), 5)} ${pad(r.replies.map(words).join("/"), 12)} ${pad(outs || "-", 22)} ${r.score.toFixed(2)}/${r.max}`);
  }
  const total = results.reduce((a, r) => a + r.score, 0);
  const max = results.reduce((a, r) => a + r.max, 0);
  console.log(`\nTOTAL ${total.toFixed(2)}/${max} (${((100 * total) / max).toFixed(1)}%)`);
  const infra = results.filter((r) => r.infraError).map((r) => r.name);
  if (infra.length) console.log(`WARNING: infra errors (usage limit, auth...) in ${infra.join(", ")}; rerun those with --case`);

  const outDir = join(root, "evals/results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}${label ? `-${label}` : ""}.json`);
  writeFileSync(file, JSON.stringify({ label, model: MODEL, total, max, results }, null, 2));
  console.log(`wrote ${file}`);
}

await main();
