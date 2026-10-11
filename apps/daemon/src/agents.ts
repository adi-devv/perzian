// Which agent CLI each ACP adapter runs. Order: an explicit env override, then the CLI the developer
// already installed (PATH, plus the usual install dirs a Finder-launched app might miss), then the
// native binary bundled with the adapter's npm package (absent in the slim app build).
// The adapters take the path from CLAUDE_CODE_EXECUTABLE (claude-agent-acp) and CODEX_PATH (codex-acp).
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import type { AgentKind } from "@perzian/protocol";

export type AgentSource = "system" | "bundled" | "missing";
export interface AgentAvailability {
  available: boolean;
  source: AgentSource;
  path?: string;
  version?: string;
}
export type AgentAvailabilityMap = Record<AgentKind, AgentAvailability>;

interface AgentSpec {
  bin: string;
  /** Env var the adapter reads for the executable; also accepted as the user's override. */
  envVar: string;
  adapter: string;
  bundled: (adapterEntry: string) => string | undefined;
  installHint: string;
}

const require = createRequire(import.meta.url);
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function bundledClaude(adapterEntry: string): string | undefined {
  // Mirrors claude-agent-acp's claudeCliPath(): the SDK's platform package, resolved from the SDK.
  const sdk = createRequire(createRequire(adapterEntry).resolve("@anthropic-ai/claude-agent-sdk"));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of process.platform === "linux" ? [base, `${base}-musl`] : [base]) {
    try {
      return sdk.resolve(`${pkg}/${exe("claude")}`);
    } catch {}
  }
  return undefined;
}

const CODEX_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
function bundledCodex(adapterEntry: string): string | undefined {
  // Mirrors @openai/codex/bin/codex.js: <platform package>/vendor/<triple>/bin/codex.
  const key = `${process.platform}-${process.arch}`;
  const triple = CODEX_TRIPLES[key];
  if (!triple) return undefined;
  const codexJs = createRequire(adapterEntry).resolve("@openai/codex/bin/codex.js");
  const pkgJson = createRequire(codexJs).resolve(`@openai/codex-${key}/package.json`);
  return join(dirname(pkgJson), "vendor", triple, "bin", exe("codex"));
}

const SPECS: Record<AgentKind, AgentSpec> = {
  "claude-code": {
    bin: "claude",
    envVar: "CLAUDE_CODE_EXECUTABLE",
    adapter: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    bundled: bundledClaude,
    installHint: "Install Claude Code (https://claude.com/claude-code) or set CLAUDE_CODE_EXECUTABLE.",
  },
  codex: {
    bin: "codex",
    envVar: "CODEX_PATH",
    adapter: "@agentclientprotocol/codex-acp/dist/index.js",
    bundled: bundledCodex,
    installHint: "Install the Codex CLI (npm i -g @openai/codex or brew install codex) or set CODEX_PATH.",
  },
};

export const AGENT_KINDS = Object.keys(SPECS) as AgentKind[];

export function adapterEntry(kind: AgentKind): string {
  return require.resolve(SPECS[kind].adapter);
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Desktop builds adopt the login-shell PATH; these catch installs it still misses.
const EXTRA_DIRS = [join(homedir(), ".local/bin"), join(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"];

function findOnPath(bin: string): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_DIRS];
  for (const dir of new Set(dirs)) {
    // npm puts node_modules/.bin first on PATH; those are our own bundled shims, not the user's CLI.
    if (!dir || dir.endsWith(`node_modules${sep}.bin`)) continue;
    const cand = join(dir, exe(bin));
    if (isExecutable(cand)) return cand;
  }
  return undefined;
}

export interface ResolvedAgent {
  source: AgentSource;
  path?: string;
}

/** Where the executable for `kind` comes from. Cheap (a few stat calls); safe to call per session start. */
export function resolveAgent(kind: AgentKind): ResolvedAgent {
  const spec = SPECS[kind];
  const override = process.env[spec.envVar];
  if (override) {
    const p = override.includes(sep) ? override : (findOnPath(override) ?? override); // a bare name is looked up on PATH
    return { source: isExecutable(p) ? "system" : "missing", path: p };
  }
  const system = findOnPath(spec.bin);
  if (system) return { source: "system", path: system };
  try {
    const bundled = spec.bundled(adapterEntry(kind));
    if (bundled && isExecutable(bundled)) return { source: "bundled", path: bundled };
  } catch {}
  return { source: "missing" };
}

/**
 * Env for the adapter process so it runs the resolved executable. Bundled binaries need nothing:
 * each adapter finds its own (codex-acp via @openai/codex/bin/codex.js, which also sets up its PATH).
 * Throws a readable error when there is nothing to run.
 */
export function agentEnv(kind: AgentKind): { env: Record<string, string>; resolved: ResolvedAgent } {
  const spec = SPECS[kind];
  const resolved = resolveAgent(kind);
  if (resolved.source === "missing") {
    const why = resolved.path ? `${spec.envVar}=${resolved.path} is not an executable file.` : `No \`${spec.bin}\` found on PATH.`;
    throw new Error(`${kind} CLI not found. ${why} ${spec.installHint}`);
  }
  return { env: resolved.source === "system" ? { [spec.envVar]: resolved.path! } : {}, resolved };
}

function version(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: 5000 }, (_err, stdout) => {
      resolve(/\d+\.\d+\.\d+[^\s)]*/.exec(String(stdout ?? ""))?.[0]);
    });
  });
}

/** Availability of every supported agent CLI, with its version when it can be run. */
export async function detectAgents(): Promise<AgentAvailabilityMap> {
  const entries = await Promise.all(
    AGENT_KINDS.map(async (kind): Promise<[AgentKind, AgentAvailability]> => {
      const r = resolveAgent(kind);
      if (r.source === "missing") return [kind, { available: false, source: "missing", ...(r.path ? { path: r.path } : {}) }];
      const v = await version(r.path!);
      return [kind, { available: true, source: r.source, path: r.path, ...(v ? { version: v } : {}) }];
    }),
  );
  return Object.fromEntries(entries) as AgentAvailabilityMap;
}
