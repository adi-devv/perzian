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

/** A folder under $PERZIAN_HOME/worktrees no live session works in (GET /api/worktrees/leftover). Removal is left to the developer. */
export interface LeftoverWorktree {
  path: string;
  repo: string;
  name: string;
  /** The archived or merged session that owned it, when known. */
  sessionId?: string;
  /** The branch checked out there, when readable. */
  branch?: string;
  /** Last modified (ms): how long it has been sitting there. */
  at?: number;
  /** The repo it belongs to. */
  project?: string;
  /** The command that removes it safely (git refuses when there are uncommitted changes). */
  command?: string;
}

/** GitHub through the developer's own `gh` login. Informational: local use never depends on it. */
export interface GitHubCheck {
  /** The project's origin host when it has one, else github.com. */
  host: string;
  ghInstalled: boolean;
  /** true / false for that host; null = couldn't tell. */
  signedIn: boolean | null;
  /** The account gh is signed in as on that host. */
  user?: string;
  /** Exact install command for this OS, when there is a one-liner. */
  installCommand?: string;
  installUrl: string;
  signInCommand: string;
}

export interface DoctorReport {
  agents: AgentCheck[];
  git: { installed: boolean; version?: string };
  /** PERZIAN_HOME: where the daemon keeps its event log and worktrees. */
  home: string;
  node: string;
  project?: ProjectCheck;
  github?: GitHubCheck;
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
