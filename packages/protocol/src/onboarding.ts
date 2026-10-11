// First-run checks: the daemon answers GET /api/doctor[?project=<path>][&fresh=1] with a DoctorReport.
// Read-only and secret-free: versions, booleans and paths only.
import type { AgentKind } from "./index.ts";

export interface AgentCheck {
  kind: AgentKind;
  label: string;
  /** Something Perzian can run: the developer's CLI, or the binary bundled with the adapter. */
  installed: boolean;
  /** "system" = the developer's own CLI; "bundled" = shipped with the ACP adapter. */
  source: "system" | "bundled" | "missing";
  version?: string;
  /** Where the CLI lives. */
  path?: string;
  /** true / false when we could tell cheaply; null = couldn't tell (the agent will ask if needed). */
  signedIn: boolean | null;
  /** e.g. "claude.ai", "API key". Never an account id or token. */
  authMethod?: string;
  /** The ACP adapter Perzian drives is installed with the daemon. */
  adapter: boolean;
  /** Exact commands to show when something is missing. */
  installCommand: string;
  signInCommand: string;
}

export interface ProjectCheck {
  /** As typed. */
  input: string;
  /** Absolute, with ~ expanded. */
  path: string;
  exists: boolean;
  /** Repo root when the folder is inside a git work tree. */
  gitRoot?: string;
  /** A git repo with no commits yet: sessions can't branch a worktree from it. */
  noCommits?: boolean;
  /** The checkout is on a detached HEAD: there's no branch to merge sessions back into. */
  detached?: boolean;
}

export interface DoctorReport {
  agents: AgentCheck[];
  git: { installed: boolean; version?: string };
  /** PERZIAN_HOME: where the daemon keeps its event log and worktrees. */
  home: string;
  node: string;
  project?: ProjectCheck;
  at: number;
}

// API keys: GET /api/credentials -> CredentialStatus[]; POST /api/credentials {provider, key};
// DELETE /api/credentials?provider=. A set key is passed to that agent's CLI instead of its subscription login.
export type ApiKeyProvider = "anthropic" | "openai";

export interface CredentialStatus {
  provider: ApiKeyProvider;
  /** The agent this key is used for. */
  agent: AgentKind;
  set: boolean;
  /** Last four characters, to recognise the key. The key itself never leaves the daemon. */
  last4?: string;
}

// POST /api/install {agent}: runs that agent's official installer.
export interface InstallResult {
  ok: boolean;
  /** Last lines of the installer's output. */
  output: string;
}
