#!/usr/bin/env -S npx tsx
// Stdio MCP server injected into every agent session. Forwards structured reports to the daemon.
// Env: PERZIAN_SESSION_ID, PERZIAN_DAEMON_URL
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { request } from "node:http";
import { z } from "zod";
import type { ReportCall } from "@perzian/protocol";

const sessionId = process.env.PERZIAN_SESSION_ID ?? "unknown";
const daemonUrl = process.env.PERZIAN_DAEMON_URL ?? "http://127.0.0.1:4317";

// node:http instead of fetch: fetch (undici) aborts after 300s without response headers, and ask_decision
// can legitimately wait much longer for the developer.
function send(call: ReportCall): Promise<string> {
  const body = JSON.stringify(call);
  return new Promise((resolve, reject) => {
    const req = request(
      `${daemonUrl}/report`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(text) : reject(new Error(text || `daemon returned ${res.statusCode}`))));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const role = process.env.PERZIAN_ROLE ?? "worker";
const server = new McpServer({ name: "perzian", version: "0.0.1" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

server.tool(
  "report_progress",
  "Show your current phase as a progress ring on your tile. Call at each phase change (e.g. explore 1/3, implement 2/3, verify 3/3), not for every tool call.",
  {
    phase: z.string().describe("1-3 words, e.g. \"implement\""),
    step: z.number().int(),
    of: z.number().int(),
    note: z.string().optional().describe("Optional, under 10 words"),
  },
  async (args) => {
    await send({ tool: "report_progress", sessionId, args });
    return { content: [{ type: "text", text: "ok" }] };
  },
);

server.tool(
  "ask_decision",
  "Put a decision card in front of the developer and block until they pick; returns the chosen option id (or \"dismissed\"). " +
    "Only for genuine forks: an ambiguous or risky request (deleting files, data loss, public API breaks), conflicting requirements, irreversible steps. " +
    "Not for things the code or brief already settles. Give 2-3 concrete options, a one-line tradeoff each, and set recommended. Never ask in plain text instead.",
  {
    question: z.string().describe("One short question"),
    options: z
      .array(z.object({ id: z.string(), label: z.string().describe("2-6 words"), tradeoff: z.string().optional().describe("One line: what you gain and lose") }))
      .min(2)
      .max(4),
    recommended: z.string().optional().describe("id of the option you recommend"),
  },
  async (args) => {
    const chosen = JSON.parse(await send({ tool: "ask_decision", sessionId, args })) as string;
    return { content: [{ type: "text", text: `Developer chose: ${chosen}` }] };
  },
);

server.tool(
  "report_outcome",
  "Your outcome card. Call once per task as your last action (and again after each follow-up message), after running the project's real checks (tests, typecheck, build). " +
    "status: success only if the task is done and checks pass; partial if anything is unfinished or failing; failed if blocked. " +
    "proof: only checks you actually ran, with their real result; Perzian also records the commands it saw run, and those win.",
  {
    intent: z.string(),
    status: z.enum(["success", "partial", "failed"]),
    changed: z.array(z.object({ path: z.string(), kind: z.enum(["added", "modified", "deleted", "renamed"]) })),
    proof: z.array(
      z.object({
        kind: z.enum(["tests", "build", "typecheck", "lint", "screenshot", "command", "manual"]),
        label: z.string(),
        passed: z.boolean(),
        detail: z.string().optional(),
      }),
    ),
    risks: z.array(z.string()).describe("Short lines: what could break, defaults you chose, what you didn't verify"),
    followups: z.array(z.string()).describe("Short lines: work left for later"),
  },
  async (args) => {
    await send({ tool: "report_outcome", sessionId, args });
    return { content: [{ type: "text", text: "ok" }] };
  },
);

server.tool(
  "spawn_session",
  "Start a worker coding session in a project folder; returns its id. The worker has not seen this conversation, so prompt must be a complete brief: " +
    "Goal (the request restated in full), Context (relevant files), Constraints (the developer's don'ts, verbatim), Done when (criteria + checks that must pass). " +
    "Spawn independent units in the same turn so they run in parallel; keep coupled work in one session. " +
    "Sessions nest at most 2 levels below the lead; you are told when a session you start finishes.",
  {
    project: z.string().describe("Absolute path (or ~/...) of the project folder"),
    prompt: z.string().describe("Complete brief: Goal, Context, Constraints, Done when (including which checks must pass)"),
    title: z.string().optional().describe("Short tile title, 2-5 words"),
    agent: z.enum(["claude-code", "codex"]).optional(),
    model: z
      .string()
      .optional()
      .describe("Omit for the default. Exact ids only: claude-haiku-5-5 (mechanical), claude-sonnet-5-5, claude-opus-5-5 (hard design/algorithms/debugging)"),
    mode: z.enum(["ask", "edits", "plan", "auto"]).optional().describe("Omit for the developer's default. plan = analysis only, no edits; auto = only if the developer asked for hands-off"),
    worktree: z.boolean().optional().describe("Omit: every session gets its own git worktree and branch by default. false only when the developer asks to work directly on their branch"),
    extraDirs: z.array(z.string()).optional().describe("Absolute paths of extra folders (besides project) the session may edit without asking, e.g. a sibling package"),
  },
  async (args) => text(await send({ tool: "spawn_session", sessionId, args })),
);
if (role === "main") {
  server.tool("list_sessions", "List the developer's coding sessions with status, progress, changed files, outcomes and detected check commands.", {}, async () =>
    text(await send({ tool: "list_sessions", sessionId, args: {} })),
  );
  server.tool("get_session", "Get one session's status, progress, changed files, outcome (with observed proof), detected check commands and last message. Call this before reporting status or results the developer asks for.", { id: z.string() }, async (args) =>
    text(await send({ tool: "get_session", sessionId, args })),
  );
  server.tool("send_to_session", "Send a follow-up to an existing session; it keeps its context, branch and worktree. Use this, not a new spawn, for changes to work that session already did.", { id: z.string(), prompt: z.string() }, async (args) =>
    text(await send({ tool: "send_to_session", sessionId, args })),
  );
}

await server.connect(new StdioServerTransport());
