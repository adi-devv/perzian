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
