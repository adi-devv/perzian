// Observation: the daemon never limits what an agent does, but it records what the agent does so the UI
// can show it. This module turns ACP tool calls into observed facts on SessionInfo (outside paths,
// subagents, background processes) and holds the pure helpers behind them. Repo facts (worktrees,
// commits, branch) live in git.ts and session.ts.
import { isAbsolute, relative, sep } from "node:path";
import type { BackgroundProc, SessionInfo, Subagent } from "@perzian/protocol";
import { realish } from "./git.ts";

export interface ToolUpdateLike {
  toolCallId: string;
  kind?: string | null;
  title?: string | null;
  status?: string | null;
  name?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  locations?: { path?: unknown }[] | null;
  _meta?: Record<string, unknown> | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function toolNameOf(u: ToolUpdateLike): string | undefined {
  if (typeof u.name === "string") return u.name;
  const cc = isObj(u._meta) && isObj(u._meta.claudeCode) ? u._meta.claudeCode : undefined;
  return typeof cc?.toolName === "string" ? cc.toolName : undefined;
}

/** The Task/Agent call this tool call ran inside, when the adapter says so. */
export function parentToolCallId(u: { _meta?: Record<string, unknown> | null }): string | undefined {
  const cc = isObj(u._meta) && isObj(u._meta.claudeCode) ? u._meta.claudeCode : undefined;
  return str(cc?.parentToolUseId);
}

// ---------------------------------------------------------------------------------------------
// Paths outside the session's folders

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath", "destination", "source", "old_path", "new_path", "from", "to"];
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const isWriteCall = (kind: string | null | undefined, name?: string) => kind === "edit" || kind === "delete" || kind === "move" || (name !== undefined && WRITE_TOOLS.has(name));

/** Absolute paths a tool call targets: its `locations` and path-like raw input fields, relative ones against `cwd`. */
export function touchedPaths(u: Pick<ToolUpdateLike, "locations" | "rawInput">, cwd: string): string[] {
  const found: string[] = [];
  for (const l of u.locations ?? []) if (str(l?.path)) found.push(str(l.path)!);
  if (isObj(u.rawInput)) for (const k of PATH_KEYS) if (str(u.rawInput[k])) found.push(str(u.rawInput[k])!);
  return [...new Set(found.map((p) => (isAbsolute(p) ? p : `${cwd}${sep}${p}`)))];
}

/** The first file a tool call targets inside `cwd`, relative with "/" separators (for the Map's session dot); undefined when none. */
export function pathInside(u: Pick<ToolUpdateLike, "locations" | "rawInput">, cwd: string): string | undefined {
  const inside = (p: string, root: string) => {
    const r = relative(root, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : undefined;
  };
  for (const p of touchedPaths(u, cwd)) {
    const r = inside(p, cwd) ?? inside(realish(p), realish(cwd));
    if (r) return r;
  }
  return undefined;
}

/** The paths outside every root, resolved through symlinks and `..` (so a link inside the folder pointing out counts as out). */
export function outsideOf(paths: string[], roots: string[]): string[] {
  const real = roots.map((r) => realish(r));
  const out: string[] = [];
  for (const p of paths) {
    const full = realish(p);
    if (!real.some((r) => full === r || full.startsWith(r.endsWith(sep) ? r : r + sep))) out.push(full);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------
// Subagents, background processes

export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const EXEC_TOOLS = new Set(["Bash", "PowerShell", "shell", "exec_command", "local_shell"]);
const KILL_TOOLS = new Set(["KillShell", "KillBash", "TaskStop"]);

/** A port the text makes obvious: `--port 3000`, `--port=3000`, `PORT=3000`, `localhost:3000`, `http://0.0.0.0:3000`, `:3000`. */
export function portOf(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /(?:--port[ =]|\bPORT=|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):|(?:^|[\s"'=]):)(\d{2,5})\b/i.exec(text);
  const n = m ? Number(m[1]) : undefined;
  return n !== undefined && n >= 1 && n <= 65535 ? n : undefined;
}

/** A shell command that keeps running after the tool call returns: `run_in_background`, or a trailing `&`. */
export function isBackground(rawInput: unknown): boolean {
  if (!isObj(rawInput)) return false;
  if (rawInput.run_in_background === true) return true;
  const cmd = str(rawInput.command);
  return !!cmd && /(?:^|[^&])&\s*$/.test(cmd);
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  if (isObj(v)) {
    if (typeof v.text === "string") return v.text;
    if (v.type === "content") return textOf(v.content);
    if (typeof v.stdout === "string" || typeof v.stderr === "string") return [v.stdout, v.stderr].filter((s) => typeof s === "string" && s).join("\n");
    if (typeof v.output === "string") return v.output;
  }
  return "";
}

function backgroundTaskId(u: ToolUpdateLike, output: string): string | undefined {
  const cc = isObj(u._meta) && isObj(u._meta.claudeCode) ? u._meta.claudeCode : undefined;
  const tr = cc && isObj(cc.toolResponse) ? cc.toolResponse : undefined;
  return str(tr?.backgroundTaskId) ?? /background (?:with )?(?:shell )?ID:?\s*([\w-]+)/i.exec(output)?.[1];
}

const MAX_SUBAGENTS = 50;
const MAX_BACKGROUND = 20;
const MAX_OUTSIDE = 50;

export interface ObserverState {
  outsidePaths?: string[];
  subagents?: Subagent[];
  background?: BackgroundProc[];
}

/**
 * Folds tool calls into observed session facts. Feed it every tool_call and tool_call_update; it returns
 * a SessionInfo patch when something changed.
 */
export class ToolObserver {
  private outside: string[];
  private subagents: Subagent[];
  private background: BackgroundProc[];
  // What each open call is, from its first update: later updates often carry neither `kind` nor a tool name.
  private classes = new Map<string, { write?: boolean; sub?: boolean; exec?: boolean; kill?: boolean }>();

  constructor(private cwd: string, private roots: () => string[], seed: ObserverState = {}) {
    this.outside = [...(seed.outsidePaths ?? [])];
    this.subagents = (seed.subagents ?? []).map((s) => ({ ...s }));
    this.background = (seed.background ?? []).map((b) => ({ ...b }));
  }

  onTool(u: ToolUpdateLike): Pick<SessionInfo, "outsidePaths" | "subagents" | "background"> | undefined {
    const patch: Pick<SessionInfo, "outsidePaths" | "subagents" | "background"> = {};
    const name = toolNameOf(u);
    const raw = isObj(u.rawInput) ? u.rawInput : {};
    const known = this.classes.get(u.toolCallId);
    const cls = {
      write: known?.write || isWriteCall(u.kind, name),
      sub: known?.sub || (name !== undefined && SUBAGENT_TOOLS.has(name)),
      exec: known?.exec || u.kind === "execute" || (name !== undefined && EXEC_TOOLS.has(name)),
      kill: known?.kill || (name !== undefined && KILL_TOOLS.has(name)),
    };
    if (u.status === "completed" || u.status === "failed" || u.status === "cancelled") this.classes.delete(u.toolCallId);
    else this.classes.set(u.toolCallId, cls);

    if (cls.write) {
      const out = outsideOf(touchedPaths(u, this.cwd), this.roots()).filter((p) => !this.outside.includes(p));
      if (out.length) {
        this.outside = [...this.outside, ...out].slice(-MAX_OUTSIDE);
        patch.outsidePaths = this.outside;
      }
    }

    if (cls.sub) {
      const description = str(raw.description) ?? str(raw.subagent_type) ?? str(u.title) ?? "Subagent";
      const status: Subagent["status"] = u.status === "completed" ? "done" : u.status === "failed" || u.status === "cancelled" ? "failed" : "running";
      const i = this.subagents.findIndex((s) => s.id === u.toolCallId);
      if (i === -1) {
        this.subagents = [...this.subagents, { id: u.toolCallId, description, status }].slice(-MAX_SUBAGENTS);
        patch.subagents = this.subagents;
      } else {
        const cur = this.subagents[i];
        const next = { ...cur, description: str(raw.description) ?? str(raw.subagent_type) ?? cur.description, status: cur.status === "running" ? status : cur.status };
        if (next.description !== cur.description || next.status !== cur.status) {
          this.subagents = this.subagents.map((s, j) => (j === i ? next : s));
          patch.subagents = this.subagents;
        }
      }
    }

    if (cls.exec && (isBackground(raw) || this.background.some((b) => b.id === u.toolCallId))) {
      const command = str(raw.command) ?? "";
      const output = textOf(u.rawOutput) || textOf(u.content);
      const i = this.background.findIndex((b) => b.id === u.toolCallId);
      const cur = i === -1 ? undefined : this.background[i];
      const port = cur?.port ?? portOf(command) ?? portOf(output);
      const taskId = cur?.taskId ?? backgroundTaskId(u, output);
      const next: BackgroundProc = {
        id: u.toolCallId,
        command: command || cur?.command || "",
        ...(port !== undefined ? { port } : {}),
        ...(taskId ? { taskId } : {}),
        ...(cur?.ended || u.status === "failed" ? { ended: true } : {}),
      };
      if (next.command && JSON.stringify(next) !== JSON.stringify(cur)) {
        this.background = i === -1 ? [...this.background, next].slice(-MAX_BACKGROUND) : this.background.map((b, j) => (j === i ? next : b));
        patch.background = this.background;
      }
    }

    if (cls.kill) {
      const id = str(raw.shell_id) ?? str(raw.bash_id) ?? str(raw.task_id) ?? str(raw.id);
      if (id && this.background.some((b) => b.taskId === id && !b.ended)) {
        this.background = this.background.map((b) => (b.taskId === id ? { ...b, ended: true } : b));
        patch.background = this.background;
      }
    }
    return Object.keys(patch).length ? patch : undefined;
  }

  /** Tool calls were closed without an answer (turn ended, cancelled, crashed): running subagents are over. */
  closeOpen(status: string): Pick<SessionInfo, "subagents"> | undefined {
    if (!this.subagents.some((s) => s.status === "running")) return undefined;
    const to = status === "completed" ? "done" : "failed";
    this.subagents = this.subagents.map((s) => (s.status === "running" ? { ...s, status: to } : s));
    return { subagents: this.subagents };
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions that start sessions

/** How many levels below the lead a session sits: the lead is 0, a session it started 1, and so on. */
export const MAX_SPAWN_DEPTH = 2;

export function spawnDepth(id: string, get: (id: string) => Pick<SessionInfo, "parentId"> | undefined): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let cur = get(id); cur?.parentId && !seen.has(cur.parentId); cur = get(cur.parentId)) {
    seen.add(cur.parentId);
    depth++;
  }
  return depth;
}

/** An error message when `spawner` may not start another session, else undefined. */
export function spawnBlocker(spawnerId: string, get: (id: string) => Pick<SessionInfo, "parentId"> | undefined): string | undefined {
  const depth = spawnDepth(spawnerId, get);
  if (depth + 1 <= MAX_SPAWN_DEPTH) return undefined;
  return `Can't start a session: sessions nest at most ${MAX_SPAWN_DEPTH} levels below the lead, and this one is already at level ${depth}. Do the work in this session, or ask the developer.`;
}
