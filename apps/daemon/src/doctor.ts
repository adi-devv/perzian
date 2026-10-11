// First-run checks for GET /api/doctor. Read-only: runs `--version` / `auth status`, looks for files,
// and never reads or returns credentials.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentCheck, AgentKind, DoctorReport, ProjectCheck } from "@perzian/protocol";
import { adapterEntry, detectAgents, type AgentAvailability } from "./agents.ts";
import type { Credentials } from "./credentials.ts";
import { corsOrigin } from "./origin.ts";

const home = homedir();

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 5000, env: { ...process.env, NO_COLOR: "1", CI: "1" } }, (err, stdout) =>
      done({ ok: !err, out: String(stdout ?? "").trim() }),
    );
    child.stdin?.end();
  });
}

const version = (s: string) => s.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0];
const hasAdapter = (kind: AgentKind) => {
  try {
    adapterEntry(kind);
    return true;
  } catch {
    return false;
  }
};

/** The official installer for each agent CLI; shown in onboarding and run by POST /api/install. */
export function installCommand(kind: AgentKind): string {
  if (kind === "codex") return "npm install -g @openai/codex";
  return process.platform === "win32" ? "npm install -g @anthropic-ai/claude-code" : "curl -fsSL https://claude.ai/install.sh | bash";
}

function check(kind: AgentKind, a: AgentAvailability): AgentCheck {
  const claude = kind === "claude-code";
  return {
    kind,
    label: claude ? "Claude Code" : "Codex",
    installed: a.available,
    source: a.source,
    version: a.version,
    path: a.path,
    signedIn: null,
    adapter: hasAdapter(kind),
    installCommand: installCommand(kind),
    signInCommand: claude ? "claude auth login" : "codex login",
  };
}

async function claudeAuth(c: AgentCheck, creds?: Credentials): Promise<AgentCheck> {
  if (creds?.has("anthropic") || process.env.ANTHROPIC_API_KEY) return { ...c, signedIn: true, authMethod: "API key" };
  if (!c.installed || !c.path) return c;
  const auth = await run(c.path, ["auth", "status", "--json"]);
  try {
    // Only the boolean and the method leave this function; email/org stay here.
    const j = JSON.parse(auth.out) as { loggedIn?: unknown; authMethod?: unknown };
    return {
      ...c,
      signedIn: typeof j.loggedIn === "boolean" ? j.loggedIn : null,
      authMethod: j.loggedIn && typeof j.authMethod === "string" ? j.authMethod : undefined,
    };
  } catch {
    // Older CLI without `auth status`: a credentials file means signed in (Linux/Windows; macOS uses the keychain).
    return existsSync(join(home, ".claude/.credentials.json")) ? { ...c, signedIn: true } : c;
  }
}

function codexAuth(c: AgentCheck, creds?: Credentials): AgentCheck {
  if (creds?.has("openai") || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return { ...c, signedIn: true, authMethod: "API key" };
  if (existsSync(join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json"))) return { ...c, signedIn: true };
  return c.installed ? { ...c, signedIn: false } : c;
}

export async function checkProject(input: string): Promise<ProjectCheck> {
  const path = resolve(input.trim().replace(/^~(?=$|[/\\])/, home));
  let exists = false;
  try {
    exists = statSync(path).isDirectory();
  } catch {}
  const top = exists ? await run("git", ["rev-parse", "--show-toplevel"], { cwd: path, timeout: 3000 }) : undefined;
  const gitRoot = top?.ok && top.out ? top.out : undefined;
  if (!gitRoot) return { input, path, exists, gitRoot };
  // `git init` alone passes the check above, but worktrees need a commit to branch from.
  const [commit, branch] = await Promise.all([
    run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: path, timeout: 3000 }),
    run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: path, timeout: 3000 }),
  ]);
  return { input, path, exists, gitRoot, ...(commit.ok ? {} : { noCommits: true }), ...(commit.ok && !branch.ok ? { detached: true } : {}) };
}

// Agent/git probes spawn processes; reuse them briefly so typing a project path stays cheap.
let cached: { at: number; value: Promise<Omit<DoctorReport, "project" | "home" | "at">> } | undefined;
const TTL = 15_000;

/** Drop cached probes, e.g. after an API key changes or an agent was installed. */
export const resetDoctorCache = () => (cached = undefined);

export async function doctor(perzianHome: string, opts: { project?: string; fresh?: boolean; creds?: Credentials } = {}): Promise<DoctorReport> {
  if (!cached || opts.fresh || Date.now() - cached.at > TTL) {
    const value = Promise.all([
      detectAgents().then((m) => Promise.all([claudeAuth(check("claude-code", m["claude-code"]), opts.creds), codexAuth(check("codex", m.codex), opts.creds)])),
      run("git", ["--version"]),
    ]).then(([agents, g]) => ({
      agents,
      git: { installed: g.ok, version: version(g.out) },
      node: process.versions.node,
    }));
    cached = { at: Date.now(), value };
  }
  const [base, project] = await Promise.all([cached.value, opts.project?.trim() ? checkProject(opts.project) : undefined]);
  return { ...base, home: perzianHome, project, at: Date.now() };
}

// The desktop app loads the UI from file:// (origin "null"); dev goes through the Vite proxy (same origin).
// Only those, never arbitrary websites, may read the report.
export function doctorHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  const allow = corsOrigin(origin);
  if (allow) h["access-control-allow-origin"] = allow;
  return h;
}
