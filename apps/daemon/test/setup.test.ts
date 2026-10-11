import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fold, type SetupState } from "@perzian/protocol";
import { createWorktree } from "../src/git.ts";
import { SetupGate, copyLocalFiles, copyProjectSkills, detectInstall, localFiles, readyWorktree } from "../src/setup.ts";
import { EventStore } from "../src/store.ts";
import { AgentSession } from "../src/session.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function write(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

// A repo with `tracked` committed, then `local` written after the commit (so only what git ignores stays out).
async function repo(tracked: Record<string, string>, local: Record<string, string> = {}) {
  const project = mkdtempSync(join(tmpdir(), "pz-setup-"));
  git(project, "init", "-q", "-b", "main");
  write(project, tracked);
  git(project, "add", "-A", "-f");
  git(project, "commit", "-qm", "init");
  write(project, local);
  const home = mkdtempSync(join(tmpdir(), "pz-home-"));
  const wt = await createWorktree(project, home, "Ready", "abcdef123");
  return { project, wt: wt.path };
}

// A directory of fake tools: name -> shell script body.
function fakeBin(tools: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pz-bin-"));
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}
const pathWith = (bin: string) => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin` });

describe("local files", () => {
  test("copies gitignored .env* and local config at any depth; skips tracked, unignored, node_modules, nested repos, symlinks", async () => {
    const { project, wt } = await repo(
      { ".gitignore": ".env*\n!.envrc\n.npmrc\nnode_modules/\n", ".env.example": "EXAMPLE=1\n", "apps/web/index.ts": "" },
      {
        ".env": "SECRET=1\n",
        ".env.local": "LOCAL=1\n",
        ".npmrc": "registry=https://example.test\n",
        "apps/web/.env.development": "DEV=1\n",
        ".envrc": "use node\n", // untracked but not ignored: would show up as a change
        "node_modules/pkg/.env": "NO=1\n",
        "sub/.git/HEAD": "ref: refs/heads/main\n", // a nested repo
        "sub/.env": "NO=1\n",
      },
    );
    symlinkSync(join(project, ".env"), join(project, ".env.link"));

    assert.deepEqual(await localFiles(project), [".env", ".env.local", ".npmrc", "apps/web/.env.development"]);
    const copied = await copyLocalFiles(project, wt);
    assert.deepEqual(copied, [".env", ".env.local", ".npmrc", "apps/web/.env.development"]);
    assert.equal(readFileSync(join(wt, "apps/web/.env.development"), "utf8"), "DEV=1\n");
    assert.ok(!existsSync(join(wt, ".envrc")) && !existsSync(join(wt, "sub/.env")) && !existsSync(join(wt, ".env.link")));
    assert.equal(readFileSync(join(wt, ".env.example"), "utf8"), "EXAMPLE=1\n", "tracked file left as committed");
    assert.equal(git(wt, "status", "--porcelain"), "", "copies don't show up as the agent's changes");
  });

  test("never overwrites a file already in the worktree", async () => {
    const { wt, project } = await repo({ ".gitignore": ".env\n" }, { ".env": "FROM_CHECKOUT=1\n" });
    writeFileSync(join(wt, ".env"), "ALREADY=1\n");
    assert.deepEqual(await copyLocalFiles(project, wt), []);
    assert.equal(readFileSync(join(wt, ".env"), "utf8"), "ALREADY=1\n");
  });
});

describe("install detection", () => {
  const all = fakeBin({ npm: "", pnpm: "", yarn: "", bun: "", uv: "", poetry: "", python3: "" });
  const labels = (files: Record<string, string>, env = pathWith(all), source?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "pz-lock-"));
    write(dir, files);
    return detectInstall(dir, source ?? dir, env);
  };

  test("each lockfile maps to its install", () => {
    const cases: [string, string[]][] = [
      ["package-lock.json", ["npm ci"]],
      ["pnpm-lock.yaml", ["pnpm install --frozen-lockfile"]],
      ["yarn.lock", ["yarn install --frozen-lockfile"]],
      ["bun.lockb", ["bun install"]],
      ["bun.lock", ["bun install"]],
      ["uv.lock", ["uv sync"]],
      ["poetry.lock", ["poetry install"]],
    ];
    for (const [file, want] of cases) assert.deepEqual(labels({ [file]: "" }).steps.map((s) => s.label), want, file);
    const npm = labels({ "package-lock.json": "" }).steps[0];
    assert.equal(npm.fallback?.label, "npm install");
    assert.deepEqual(labels({ "package-lock.json": "", "uv.lock": "" }).steps.map((s) => s.label), ["npm ci", "uv sync"], "one JS and one Python install");
    assert.deepEqual(labels({ "README.md": "" }), { steps: [], notes: [] });
  });

  test("a tool missing from PATH is skipped with a note", () => {
    const r = labels({ "pnpm-lock.yaml": "" }, pathWith(fakeBin({ npm: "" })));
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.notes, ["pnpm not on PATH: skipped pnpm install --frozen-lockfile"]);
  });

  test("requirements.txt installs only into an obvious venv", () => {
    const none = labels({ "requirements.txt": "requests\n" });
    assert.deepEqual(none.steps, []);
    assert.match(none.notes[0], /no \.venv or venv/);
    const source = mkdtempSync(join(tmpdir(), "pz-src-"));
    write(source, { ".venv/pyvenv.cfg": "home = /usr/bin\n" });
    const withVenv = labels({ "requirements.txt": "requests\n" }, pathWith(all), source);
    assert.deepEqual(withVenv.steps.map((s) => s.label), ["python3 -m venv .venv", ".venv/bin/pip install -r requirements.txt"]);
  });
});

describe("readyWorktree", () => {
  test("copies, runs the install, and falls back from npm ci to npm install", async () => {
    const { project, wt } = await repo({ ".gitignore": ".env\n", "package-lock.json": "{}\n" }, { ".env": "A=1\n" });
    // npm install also rewrites the lockfile, as it does when package.json and the lock disagree.
    const bin = fakeBin({ npm: 'if [ "$1" = ci ]; then echo "npm ERR! ci broke" >&2; exit 1; fi\necho "$1 CI=$CI" > installed.txt; echo rewritten > package-lock.json' });
    const seen: SetupState[] = [];
    const st = await readyWorktree(project, wt, { env: pathWith(bin), onUpdate: (s) => seen.push(s) });
    assert.equal(st.state, "ok");
    assert.deepEqual(st.copied, [".env"]);
    assert.deepEqual(st.install, ["npm ci"]);
    assert.deepEqual(st.notes, ["npm ci failed (exit 1); ran npm install"]);
    assert.equal(readFileSync(join(wt, "installed.txt"), "utf8"), "install CI=1\n");
    // The committed lockfile is put back: setup never shows up as a change of the session's own.
    assert.equal(readFileSync(join(wt, "package-lock.json"), "utf8"), "{}\n");
    assert.equal(git(wt, "status", "--porcelain", "--untracked-files=no"), "");
    assert.deepEqual(seen.map((s) => s.current).filter(Boolean), ["npm ci", "npm install"]);
    assert.ok(seen.every((s) => s.state === "running"));
  });

  test("a failing install reports the command and the tail of its output", async () => {
    const { project, wt } = await repo({ "pnpm-lock.yaml": "" });
    const bin = fakeBin({ pnpm: 'i=1; while [ $i -le 30 ]; do echo "line $i"; i=$((i+1)); done; echo "ERR_PNPM_OUTDATED_LOCKFILE" >&2; exit 2' });
    const st = await readyWorktree(project, wt, { env: pathWith(bin) });
    assert.equal(st.state, "failed");
    assert.equal(st.error?.command, "pnpm install --frozen-lockfile");
    const lines = st.error!.tail.split("\n");
    assert.equal(lines.length, 20);
    assert.equal(lines.at(-1), "ERR_PNPM_OUTDATED_LOCKFILE");
    assert.ok(!lines.includes("line 10"));
  });

  test("nothing to install, or the tool missing, is still ready", async () => {
    const { project, wt } = await repo({ "yarn.lock": "" });
    const st = await readyWorktree(project, wt, { env: pathWith(fakeBin({})) });
    assert.equal(st.state, "ok");
    assert.deepEqual(st.install, []);
    assert.deepEqual(st.notes, ["yarn not on PATH: skipped yarn install --frozen-lockfile"]);
  });
});

describe("custom setup steps", () => {
  test("run after the built-in steps, in the worktree; a failure stops with the step's name", async () => {
    const { project, wt } = await repo({ "yarn.lock": "" });
    const env = pathWith(fakeBin({}));
    const ok = await readyWorktree(project, wt, { env, steps: [{ name: "seed", run: "echo $CI > seeded.txt" }] });
    assert.equal(ok.state, "ok");
    assert.deepEqual(ok.install, ["seed"]);
    assert.equal(readFileSync(join(wt, "seeded.txt"), "utf8"), "1\n");
    const bad = await readyWorktree(project, wt, { env, steps: [{ name: "db", run: "echo boom >&2; exit 3" }, { name: "after", run: "touch after.txt" }] });
    assert.equal(bad.state, "failed");
    assert.deepEqual(bad.error, { command: "db", tail: "boom" });
    assert.ok(!existsSync(join(wt, "after.txt")));
  });

  test("perzian.json setup is validated like checks", async () => {
    const { parsePerzianSetup, parsePerzianConfig } = await import("../src/checks.ts");
    assert.deepEqual(parsePerzianSetup(JSON.stringify({ setup: [{ name: "db", run: "make db", timeoutSec: 60 }], checks: [{ name: "u", run: "npm test" }] })), [{ name: "db", run: "make db", timeoutSec: 60 }]);
    assert.deepEqual(parsePerzianConfig(JSON.stringify({ setup: [{ name: "db", run: "make db" }] })), []);
    assert.deepEqual(parsePerzianSetup("{}"), []);
    assert.throws(() => parsePerzianSetup(JSON.stringify({ setup: [{ name: "x" }] })), /setup\[0\]\.run/);
    assert.throws(() => parsePerzianSetup(JSON.stringify({ setup: "x" })), /"setup" must be a list/);
  });
});

describe("setup gate", () => {
  test("holds waiters until opened or cancelled", async () => {
    const g = new SetupGate();
    const a = g.wait();
    const b = g.wait();
    assert.equal(g.waiting, 2);
    g.open();
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    const c = g.wait();
    g.cancel();
    assert.equal(await c, false);
    assert.equal(g.waiting, 0);
  });
});

describe("session setup", () => {
  const ok = (): SetupState => ({ state: "ok", copied: [".env"], install: ["npm ci"], at: 1 });
  const failed = (): SetupState => ({ state: "failed", copied: [], install: ["npm ci"], error: { command: "npm ci", tail: "npm ERR! boom" }, at: 1 });

  function session(results: SetupState[]) {
    const store = new EventStore(mkdtempSync(join(tmpdir(), "pz-store-")));
    let runs = 0;
    const s = AgentSession.create(
      { project: "/p", cwd: "/p/wt", title: "T", agent: "claude-code", worktree: true },
      { store, daemonUrl: "http://127.0.0.1:0", decisions: new Map(), setup: async () => results[Math.min(runs++, results.length - 1)] },
    );
    // Stand-in for the adapter: proves a prompt got past setup without spawning an agent.
    const started: string[] = [];
    s.ensureStarted = async () => {
      started.push(s.info.setup?.state ?? "none");
      throw new Error("adapter stub");
    };
    return { s, store, started, runs: () => runs };
  }

  test("the first prompt waits for setup, then goes", async () => {
    const { s, store, started } = session([ok()]);
    const setup = s.runSetup();
    assert.equal(s.info.setup?.state, "running");
    const prompt = s.prompt("do it");
    assert.equal(s.info.status, "working");
    assert.deepEqual(started, []);
    await setup;
    await prompt;
    assert.deepEqual(started, ["ok"]);
    assert.deepEqual(fold(store.all()).sessions[s.info.id].setup, ok(), "setup state replays from the log");
  });

  test("a failed setup holds the prompt and shows failed; Retry runs it again and lets it go", async () => {
    const { s, store, started, runs } = session([failed(), ok()]);
    await s.runSetup();
    const prompt = s.prompt("do it");
    await new Promise((r) => setImmediate(r));
    assert.equal(s.info.status, "failed");
    assert.deepEqual(started, []);
    assert.equal(fold(store.all()).sessions[s.info.id].setup?.error?.tail, "npm ERR! boom");
    await s.retrySetup();
    await prompt;
    assert.equal(runs(), 2);
    assert.deepEqual(started, ["ok"]);
  });

  test("Start anyway releases the prompt without setup", async () => {
    const { s, started } = session([failed()]);
    await s.runSetup();
    const prompt = s.prompt("do it");
    await new Promise((r) => setImmediate(r));
    s.skipSetup();
    await prompt;
    assert.equal(s.info.setup?.state, "skipped");
    assert.deepEqual(started, ["skipped"]);
  });

  test("Stop while setting up releases the prompt as idle; a later Retry resends the held first prompt", async () => {
    const { s, store, started } = session([failed(), ok()]);
    await s.runSetup();
    const prompt = s.prompt("do it");
    await new Promise((r) => setImmediate(r));
    await s.cancel();
    await prompt;
    assert.equal(s.info.status, "idle");
    assert.deepEqual(started, []);
    await s.retrySetup();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(started, ["ok"]);
    const users = (fold(store.all()).transcripts[s.info.id] ?? []).filter((t) => t.kind === "user");
    assert.equal(users.length, 1, "the resent prompt isn't added to the transcript twice");
  });
});

describe("project skills and commands", () => {
  test("untracked and gitignored ones are copied into the worktree; tracked ones are never overwritten", async () => {
    const { project, wt } = await repo(
      { ".gitignore": ".claude/skills/private/\n", ".claude/skills/tracked/SKILL.md": "committed\n", ".claude/commands/old.md": "committed\n" },
      { ".claude/skills/private/SKILL.md": "ignored\n", ".claude/skills/fresh/SKILL.md": "untracked\n", ".claude/commands/deploy.md": "cmd\n", ".claude/settings.local.json": "{}" },
    );
    // The checkout edited a tracked command after the commit: the worktree keeps its own copy.
    writeFileSync(join(project, ".claude/commands/old.md"), "edited in checkout\n");
    const copied = await copyProjectSkills(project, wt);
    assert.deepEqual(copied, [".claude/commands/deploy.md", ".claude/skills/fresh/SKILL.md", ".claude/skills/private/SKILL.md"]);
    assert.equal(readFileSync(join(wt, ".claude/skills/private/SKILL.md"), "utf8"), "ignored\n");
    assert.equal(readFileSync(join(wt, ".claude/commands/old.md"), "utf8"), "committed\n");
    assert.ok(!existsSync(join(wt, ".claude/settings.local.json")), "only skills and commands");
    assert.deepEqual(await copyProjectSkills(project, wt), [], "a second run copies nothing");
  });
});
