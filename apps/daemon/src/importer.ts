// Imports existing Claude Code sessions (started in the terminal or the app) from their JSONL transcripts under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, so they show up in Perzian without switching tools.
// Read-only: never writes under ~/.claude. The ids are Claude Code session ids, which the Claude ACP adapter
// accepts as-is in session/load, so an imported session can be resumed later.
import { existsSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { PerzianEvent, SessionInfo, TranscriptItem } from "@perzian/protocol";

export interface ImportedSession {
  acpSessionId: string;
  title: string;
  cwd: string;
  branch?: string;
  createdAt: number;
  updatedAt: number;
  transcript: TranscriptItem[];
  lastStatus: "done" | "idle";
}

export interface ListOptions {
  root?: string; // default ~/.claude/projects
  sinceDays?: number; // default 3, by file mtime
  limit?: number; // default 30
  perzianHome?: string; // sessions whose cwd is inside it are ours; default $PERZIAN_HOME or ~/.perzian
  excludeIds?: Iterable<string>; // acpSessionIds already known to Perzian
}

export const MAX_ITEMS = 300;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 48;

const DAY = 24 * 60 * 60 * 1000;

export async function listClaudeSessions(opts: ListOptions = {}): Promise<ImportedSession[]> {
  const root = opts.root ?? join(homedir(), ".claude", "projects");
  const since = Date.now() - (opts.sinceDays ?? 3) * DAY;
  const limit = opts.limit ?? 30;
  const home = resolve(opts.perzianHome ?? process.env.PERZIAN_HOME ?? join(homedir(), ".perzian"));
  const exclude = new Set(opts.excludeIds ?? []);

  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const files: { path: string; id: string; mtime: number; size: number }[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = await readdir(join(root, d));
    } catch {
      continue; // not a directory
    }
    for (const name of names) {
      // Top-level <sessionId>.jsonl only; agent-*.jsonl (old sidechains) and <id>/subagents/ are not sessions.
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (exclude.has(id)) continue;
      const path = join(root, d, name);
      try {
        const st = await stat(path);
        if (st.isFile() && st.mtimeMs >= since) files.push({ path, id, mtime: Math.round(st.mtimeMs), size: st.size });
      } catch {
        // vanished
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: ImportedSession[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let s: ImportedSession | undefined;
    try {
      s = await parseTranscriptFile(f.path, f.id, f.mtime, f.size);
    } catch {
      continue;
    }
    if (!s || s.transcript.length === 0) continue;
    if (inside(resolve(s.cwd), home)) continue; // started by Perzian
    if (!isDir(s.cwd)) continue; // gone (e.g. temp dir); ACP session/load would reject it anyway
    out.push(s);
  }
  return out;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function readRange(path: string, start: number, length: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

// Reads the whole file when small, otherwise the first 64KB (metadata) and the last 2MB (transcript).
export async function parseTranscriptFile(path: string, id: string, mtime?: number, size?: number): Promise<ImportedSession | undefined> {
  if (mtime === undefined || size === undefined) {
    const st = await stat(path);
    mtime = Math.round(st.mtimeMs);
    size = st.size;
  }
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    const lines = splitLines(await readRange(path, 0, size));
    return parseLines(id, lines, lines, { mtime, truncated: false });
  }
  const headText = await readRange(path, 0, HEAD_BYTES);
  const head = splitLines(headText.slice(0, headText.lastIndexOf("\n") + 1)); // drop the partial last line
  const tailText = await readRange(path, size - TAIL_BYTES, TAIL_BYTES);
  const tail = splitLines(tailText.slice(tailText.indexOf("\n") + 1)); // drop the partial first line
  return parseLines(id, head, tail, { mtime, truncated: true });
}

type Line = Record<string, any>;

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") out.push(o);
    } catch {
      // partial or corrupt line
    }
  }
  return out;
}

const ts = (l: Line): number | undefined => {
  const t = typeof l.timestamp === "string" ? Date.parse(l.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Builds an ImportedSession from parsed lines. `head` gives cwd, createdAt and the first prompt (title fallback);
 * `tail` gives the transcript, latest cwd/branch and titles. Pass the same array for both when the file is small.
 */
export function parseLines(id: string, head: Line[], tail: Line[], opts: { mtime: number; truncated?: boolean }): ImportedSession | undefined {
  let firstCwd: string | undefined;
  let createdAt: number | undefined;
  let firstPrompt: string | undefined;
  for (const l of head) {
    if (l.sessionId && l.sessionId !== id) continue;
    firstCwd ??= typeof l.cwd === "string" ? l.cwd : undefined;
    createdAt ??= ts(l);
    if (firstPrompt === undefined && isMainUser(l)) {
      const t = userText(l.message?.content);
      if (t !== INTERRUPTED) firstPrompt = t;
    }
    if (firstCwd && createdAt !== undefined && firstPrompt) break;
  }

  let cwd: string | undefined;
  let branch: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let lastAt: number | undefined;
  const items: TranscriptItem[] = [];
  const seenUuid = new Set<string>();
  const seenTool = new Set<string>();
  let fallbackAt = createdAt ?? opts.mtime;

  for (const l of tail) {
    if (l.type === "summary" && typeof l.summary === "string") summary = l.summary;
    if (l.type === "custom-title" && typeof l.customTitle === "string") customTitle = l.customTitle;
    if (l.type === "ai-title" && typeof l.aiTitle === "string") aiTitle = l.aiTitle;
    if (l.sessionId && l.sessionId !== id) continue;
    if (l.isSidechain) continue;
    if (typeof l.uuid === "string") {
      if (seenUuid.has(l.uuid)) continue;
      seenUuid.add(l.uuid);
    }
    if (typeof l.cwd === "string") cwd = l.cwd;
    if (typeof l.gitBranch === "string" && l.gitBranch) branch = l.gitBranch;
    const at = ts(l) ?? fallbackAt;
    fallbackAt = at;

    if (l.type === "system" && l.subtype === "compact_boundary") {
      items.push({ kind: "notice", text: "Conversation compacted", at });
      lastAt = at;
    } else if (l.type === "user" && isMainUser(l)) {
      const content = l.message?.content;
      const text = userText(content);
      if (text === INTERRUPTED) items.push({ kind: "notice", text: "Interrupted", at });
      else if (text) items.push({ kind: "user", text, at });
      else continue;
      if (firstPrompt === undefined && text && text !== INTERRUPTED) firstPrompt = text;
      lastAt = at;
    } else if (l.type === "assistant" && Array.isArray(l.message?.content)) {
      if (l.isApiErrorMessage) {
        const t = l.message.content.find((b: Line) => b?.type === "text")?.text;
        items.push({ kind: "notice", text: typeof t === "string" ? oneLine(t, 200) : "API error", at });
        lastAt = at;
        continue;
      }
      if (l.message.model === "<synthetic>") continue;
      for (const b of l.message.content as Line[]) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          items.push({ kind: "agent", text: b.text.trim(), at });
          lastAt = at;
        } else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          if (seenTool.has(b.id)) continue;
          seenTool.add(b.id);
          items.push({ kind: "tool", toolCallId: b.id, title: toolTitle(b.name, b.input, cwd ?? firstCwd), status: "completed", toolKind: toolKind(b.name), at });
          lastAt = at;
        }
      }
    }
  }

  cwd ??= firstCwd;
  if (!cwd) return undefined;

  let transcript = items;
  if (opts.truncated || items.length > MAX_ITEMS) {
    transcript = items.slice(-(MAX_ITEMS - 1));
    transcript.unshift({ kind: "notice", text: "Earlier conversation is in Claude Code", at: transcript[0]?.at ?? createdAt ?? opts.mtime });
  }
  const title = cleanTitle(customTitle) ?? cleanTitle(aiTitle) ?? cleanTitle(summary) ?? (firstPrompt ? truncate(firstLine(firstPrompt), TITLE_MAX) : "Claude Code session");

  return {
    acpSessionId: id,
    title,
    cwd,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    createdAt: createdAt ?? items[0]?.at ?? opts.mtime,
    updatedAt: Math.max(opts.mtime, lastAt ?? 0),
    transcript,
    lastStatus: items[items.length - 1]?.kind === "agent" ? "done" : "idle",
  };
}

const INTERRUPTED = "\u0000interrupted";

// A prompt the developer typed, not a tool result, hook/meta message, compaction summary or notification.
function isMainUser(l: Line): boolean {
  if (l.type !== "user" || l.isMeta || l.isSidechain || l.isCompactSummary || l.isVisibleInTranscriptOnly) return false;
  if (l.origin && typeof l.origin === "object" && l.origin.kind && l.origin.kind !== "human") return false;
  return l.message?.role === "user" || l.message?.content !== undefined;
}

// The visible prompt text, or undefined if the message is only tool results or wrapper tags.
function userText(content: unknown): string | undefined {
  let raw: string;
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .filter((b: Line) => b?.type === "text" && typeof b.text === "string")
      .map((b: Line) => b.text as string)
      .join("\n");
  } else return undefined;

  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text) return undefined;
  if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) return INTERRUPTED;
  const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    const name = cmd[1]!.trim();
    return (name.startsWith("/") ? name : `/${name}`) + (args ? ` ${args}` : "");
  }
  const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>$/);
  if (bash) return `!${bash[1]!.trim()}`;
  // Other harness wrappers (<local-command-stdout>, <task-notification>, <bash-stdout>, caveats…) are not prompts.
  if (/^<([a-z][a-z0-9-]*)>[\s\S]*<\/\1>$/.test(text)) return undefined;
  return text;
}

const READ = new Set(["Read", "NotebookRead"]);
const EDIT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const EXECUTE = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"]);
const SEARCH = new Set(["Grep", "Glob", "LS", "ToolSearch"]);
const FETCH = new Set(["WebFetch", "WebSearch"]);

export function toolKind(name: string): "read" | "edit" | "execute" | "search" | "fetch" | "other" {
  if (READ.has(name)) return "read";
  if (EDIT.has(name)) return "edit";
  if (EXECUTE.has(name)) return "execute";
  if (SEARCH.has(name)) return "search";
  if (FETCH.has(name)) return "fetch";
  return "other";
}

const ARG_KEYS = ["file_path", "notebook_path", "command", "pattern", "url", "query", "path", "description", "skill", "subagent_type", "prompt"];

export function toolTitle(name: string, input: unknown, cwd?: string): string {
  if (!input || typeof input !== "object") return name;
  const rec = input as Record<string, unknown>;
  const key = ARG_KEYS.find((k) => typeof rec[k] === "string" && (rec[k] as string).trim());
  if (!key) return name;
  let arg = (rec[key] as string).trim();
  if ((key === "file_path" || key === "notebook_path" || key === "path") && cwd && arg.startsWith(cwd + sep)) arg = arg.slice(cwd.length + 1);
  return `${name} ${oneLine(arg, 80)}`;
}

const firstLine = (s: string) => s.trim().split("\n")[0]!.trim();
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const oneLine = (s: string, n: number) => truncate(s.replace(/\s+/g, " ").trim(), n);
const cleanTitle = (s: string | undefined) => (s && s.trim() ? truncate(firstLine(s), 80) : undefined);

// Nearest enclosing git work tree (a directory holding .git, a dir or a worktree file); else the cwd itself.
export function repoRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

/**
 * Events that recreate an imported session in Perzian's fold. `id` is the Perzian session id; `extra` overrides
 * fields of the created SessionInfo (e.g. `baseSha` so later turns get a change map).
 */
export function toEvents(s: ImportedSession, id: string, extra: Partial<SessionInfo> = {}): PerzianEvent[] {
  const session: SessionInfo = {
    role: "worker",
    title: s.title,
    project: repoRoot(s.cwd),
    cwd: s.cwd,
    branch: s.branch,
    agent: "claude-code",
    status: "idle",
    live: false,
    acpSessionId: s.acpSessionId,
    seenAt: s.updatedAt, // already seen in Claude Code; don't flag as unseen
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...extra,
    id,
  };
  return [
    { type: "session.created", session },
    ...s.transcript.map((item): PerzianEvent => ({ type: "session.transcript", sessionId: id, item })),
    { type: "session.status", sessionId: id, status: s.lastStatus, at: s.updatedAt },
  ];
}
