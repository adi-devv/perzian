import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold } from "@perzian/protocol";
import { listClaudeSessions, MAX_ITEMS, parseTranscriptFile, repoRoot, toEvents, toolKind, toolTitle } from "../src/importer.ts";

let tmp: string;
let root: string; // fake ~/.claude/projects
let repo: string; // a git work tree
let sub: string; // a directory inside it
let home: string; // fake ~/.perzian

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const iso = (n: number) => new Date(T0 + n * 1000).toISOString();

type Line = Record<string, unknown>;
let uuid = 0;
const base = (sessionId: string, cwd: string, n: number) => ({ sessionId, cwd, gitBranch: "feat/x", timestamp: iso(n), uuid: `u${++uuid}`, isSidechain: false });
const user = (sid: string, cwd: string, n: number, content: unknown, extra: Line = {}): Line => ({ ...base(sid, cwd, n), type: "user", message: { role: "user", content }, ...extra });
const assistant = (sid: string, cwd: string, n: number, content: unknown[], extra: Line = {}): Line => ({ ...base(sid, cwd, n), type: "assistant", message: { id: `m${n}`, role: "assistant", model: "claude-test", content }, ...extra });

function writeSession(dir: string, id: string, lines: Line[], ageMs = 0): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
  return path;
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "perzian-import-"));
  root = join(tmp, "projects");
  repo = join(tmp, "repo");
  sub = join(repo, "pkg");
  home = join(tmp, "perzian-home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  mkdirSync(join(home, "main"), { recursive: true });
  mkdirSync(root, { recursive: true });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const opts = () => ({ root, perzianHome: home });

describe("importer", () => {
  test("parses a transcript: prompts, replies, tools; skips tool results, meta and wrappers", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const path = writeSession("-repo", id, [
      { type: "queue-operation", operation: "enqueue", timestamp: iso(0), sessionId: id },
      user(id, repo, 1, "<local-command-caveat>Caveat: ignore</local-command-caveat>", { isMeta: true }),
      user(id, repo, 2, "Add a multiply function\nto math.ts please", { origin: { kind: "human" } }),
      assistant(id, repo, 3, [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it." }]),
      assistant(id, repo, 4, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(repo, "src/math.ts") } }]),
      user(id, repo, 5, [{ type: "tool_result", tool_use_id: "t1", content: "export const add..." }]),
      assistant(id, repo, 6, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test\n  --watch=false", description: "Run tests" } }]),
      user(id, repo, 7, [{ type: "tool_result", tool_use_id: "t2", content: "ok" }]),
      { type: "system", subtype: "stop_hook_summary", ...base(id, repo, 8) },
      user(id, repo, 9, "<system-reminder>be nice</system-reminder>\nnow add divide", { origin: { kind: "human" } }),
      user(id, repo, 10, "<task-notification>done</task-notification>", { origin: { kind: "task-notification" } }),
      user(id, repo, 11, "<command-name>/review</command-name><command-message>review</command-message><command-args>src</command-args>"),
      user(id, repo, 12, "<local-command-stdout>output</local-command-stdout>"),
      user(id, repo, 13, "This session is being continued…", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      assistant(id, repo, 14, [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: join(repo, "src/math.ts"), old_string: "a", new_string: "b" } }, { type: "text", text: "Done: added divide." }]),
      { type: "last-prompt", lastPrompt: "now add divide", sessionId: id },
    ]);
    const s = await parseTranscriptFile(path, id);
    assert.ok(s);
    assert.equal(s.acpSessionId, id);
    assert.equal(s.cwd, repo);
    assert.equal(s.branch, "feat/x");
    assert.equal(s.createdAt, T0);
    assert.equal(s.title, "Add a multiply function");
    assert.equal(s.lastStatus, "done");
    assert.deepEqual(
      s.transcript.map((i) => (i.kind === "tool" ? `tool:${i.toolKind}:${i.title}:${i.status}` : i.kind === "spawn" ? "spawn" : `${i.kind}:${i.text}`)),
      [
        "user:Add a multiply function\nto math.ts please",
        "agent:On it.",
        "tool:read:Read src/math.ts:completed",
        "tool:execute:Bash npm test --watch=false:completed",
        "user:now add divide",
        "user:/review src",
        "tool:edit:Edit src/math.ts:completed",
        "agent:Done: added divide.",
      ],
    );
    assert.equal(s.transcript[0]!.at, T0 + 2000);
  });

  test("title prefers custom title, then AI title, then summary, then first prompt (truncated to 48)", async () => {
    const long = "Refactor the authentication middleware so that it handles expired tokens gracefully";
    const lines = (extra: Line[]) => [user("b1", repo, 1, long), assistant("b1", repo, 2, [{ type: "text", text: "ok" }]), ...extra];
    const title = async (extra: Line[]) => (await parseTranscriptFile(writeSession("-t", "b1", lines(extra)), "b1"))!.title;

    const t = await title([]);
    assert.ok(t.length <= 48 && t.length > 40, t);
    assert.ok(t.endsWith("…") && long.startsWith(t.slice(0, -1)));
    assert.equal(await title([{ type: "summary", summary: "Auth middleware refactor", leafUuid: "x" }]), "Auth middleware refactor");
    assert.equal(await title([{ type: "summary", summary: "S" }, { type: "ai-title", aiTitle: "AI title", sessionId: "b1" }]), "AI title");
    assert.equal(
      await title([{ type: "ai-title", aiTitle: "AI title", sessionId: "b1" }, { type: "custom-title", customTitle: "Mine", sessionId: "b1" }, { type: "custom-title", customTitle: "Mine v2", sessionId: "b1" }]),
      "Mine v2",
    );
  });

  test("tool kinds and titles", () => {
    assert.equal(toolKind("Read"), "read");
    assert.equal(toolKind("Write"), "edit");
    assert.equal(toolKind("MultiEdit"), "edit");
    assert.equal(toolKind("Bash"), "execute");
    assert.equal(toolKind("Grep"), "search");
    assert.equal(toolKind("Glob"), "search");
    assert.equal(toolKind("WebFetch"), "fetch");
    assert.equal(toolKind("WebSearch"), "fetch");
    assert.equal(toolKind("Agent"), "other");
    assert.equal(toolKind("mcp__github__create_pr"), "other");
    assert.equal(toolTitle("Grep", { pattern: "TODO", path: "/x" }), "Grep TODO");
    assert.equal(toolTitle("WebFetch", { url: "https://example.com", prompt: "p" }), "WebFetch https://example.com");
    assert.equal(toolTitle("Write", { file_path: "/elsewhere/a.ts" }, "/repo"), "Write /elsewhere/a.ts");
    assert.equal(toolTitle("TodoWrite", { todos: [] }), "TodoWrite");
    assert.equal(toolTitle("Bash", { command: "x".repeat(200) }).length, "Bash ".length + 80);
  });

  test("caps the transcript at the last 300 items with a leading notice; interrupted turns end idle", async () => {
    const id = "c1";
    const lines: Line[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(user(id, repo, i * 3, `prompt ${i}`));
      lines.push(assistant(id, repo, i * 3 + 1, [{ type: "text", text: `reply ${i}` }]));
    }
    lines.push(user(id, repo, 1000, [{ type: "text", text: "[Request interrupted by user]" }]));
    const s = (await parseTranscriptFile(writeSession("-cap", id, lines), id))!;
    assert.equal(s.transcript.length, MAX_ITEMS);
    assert.equal(s.transcript[0]!.kind, "notice");
    assert.deepEqual(s.transcript.at(-1), { kind: "notice", text: "Interrupted", at: T0 + 1_000_000 });
    assert.equal((s.transcript.at(-2) as { text: string }).text, "reply 199");
    assert.equal(s.title, "prompt 0");
    assert.equal(s.lastStatus, "idle");
  });

  test("large files: reads the head for metadata and only the tail for the transcript", async () => {
    const id = "d1";
    const blob = "y".repeat(10_000);
    const lines: Line[] = [user(id, repo, 0, "First prompt of a big session")];
    for (let i = 1; i <= 400; i++) lines.push(assistant(id, repo, i, [{ type: "tool_use", id: `big${i}`, name: "Write", input: { file_path: join(repo, `f${i}.ts`), content: blob } }]));
    lines.push(assistant(id, repo, 500, [{ type: "text", text: "All written." }]));
    const s = (await parseTranscriptFile(writeSession("-big", id, lines), id))!; // ~4MB
    assert.equal(s.title, "First prompt of a big session");
    assert.equal(s.createdAt, T0);
    assert.equal(s.transcript[0]!.kind, "notice");
    assert.ok(s.transcript.length < 300, "only the last ~2MB is parsed");
    assert.ok(!s.transcript.some((i) => i.kind === "user"), "the first prompt lies outside the tail");
    assert.equal(s.transcript.at(-1)!.kind, "agent");
    assert.equal(s.lastStatus, "done");
  });

  test("listing: newest first, sinceDays, limit, skip rules", async () => {
    const old = mkdtempSync(join(tmpdir(), "perzian-import-root-"));
    const savedRoot = root;
    root = old;
    try {
      const ok = (id: string, cwd: string, text: string) => [user(id, cwd, 1, text), assistant(id, cwd, 2, [{ type: "text", text: "ok" }])];
      writeSession("-repo", "s-new", ok("s-new", repo, "newest"), 1_000);
      writeSession("-repo-pkg", "s-mid", ok("s-mid", sub, "middle"), 60_000);
      writeSession("-repo", "s-old", ok("s-old", repo, "older"), 2 * 86_400_000);
      writeSession("-repo", "s-ancient", ok("s-ancient", repo, "too old"), 10 * 86_400_000);
      writeSession("-home", "s-ours", ok("s-ours", join(home, "main"), "perzian main agent"), 500);
      writeSession("-gone", "s-gone", ok("s-gone", join(tmp, "deleted-dir"), "cwd no longer exists"), 500);
      writeSession("-repo", "s-empty", [{ type: "queue-operation", operation: "enqueue", sessionId: "s-empty", timestamp: iso(0) }], 500);
      writeSession("-repo", "s-tools-only", [user("s-tools-only", repo, 1, [{ type: "tool_result", tool_use_id: "x", content: "" }])], 500);
      writeSession("-repo", "agent-sidechain", ok("agent-sidechain", repo, "subagent"), 500);
      writeSession("-repo", "s-known", ok("s-known", repo, "already in perzian"), 500);
      mkdirSync(join(root, "-repo", "s-new", "subagents"), { recursive: true });
      writeFileSync(join(root, "-repo", "s-new", "subagents", "agent-1.jsonl"), JSON.stringify(user("x", repo, 1, "sub")) + "\n");

      const all = await listClaudeSessions({ ...opts(), excludeIds: ["s-known"] });
      assert.deepEqual(all.map((s) => s.acpSessionId), ["s-new", "s-mid", "s-old"]);
      assert.deepEqual((await listClaudeSessions({ ...opts(), sinceDays: 1 })).map((s) => s.acpSessionId), ["s-known", "s-new", "s-mid"]);
      assert.deepEqual((await listClaudeSessions({ ...opts(), sinceDays: 30, limit: 2, excludeIds: ["s-known"] })).map((s) => s.acpSessionId), ["s-new", "s-mid"]);
      assert.deepEqual(await listClaudeSessions({ root: join(tmp, "missing") }), []);
    } finally {
      root = savedRoot;
      rmSync(old, { recursive: true, force: true });
    }
  });

  test("toEvents folds into an idle-then-final, non-live, already-seen worker session at the repo root", async () => {
    const id = "e1";
    const s = (await parseTranscriptFile(writeSession("-ev", id, [user(id, sub, 1, "Fix the build"), assistant(id, sub, 2, [{ type: "tool_use", id: "z1", name: "Grep", input: { pattern: "error" } }, { type: "text", text: "Fixed." }])]), id))!;
    assert.equal(repoRoot(sub), repo);
    assert.equal(repoRoot(home), home);
    const events = toEvents(s, "p1");
    assert.equal(events[0]!.type, "session.created");
    assert.equal(events.at(-1)!.type, "session.status");
    const st = fold(events);
    const info = st.sessions.p1!;
    assert.equal(info.project, repo);
    assert.equal(info.cwd, sub);
    assert.equal(info.branch, "feat/x");
    assert.equal(info.agent, "claude-code");
    assert.equal(info.role, "worker");
    assert.equal(info.live, false);
    assert.equal(info.acpSessionId, id);
    assert.equal(info.status, "done");
    assert.equal(info.title, "Fix the build");
    assert.equal(info.seenAt, info.updatedAt);
    assert.deepEqual(st.transcripts.p1!.map((i) => i.kind), ["user", "tool", "agent"]);
  });
});
