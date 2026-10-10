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
  "Report the current phase of work so the developer can see progress at a glance.",
  { phase: z.string(), step: z.number().int(), of: z.number().int(), note: z.string().optional() },
  async (args) => {
    await send({ tool: "report_progress", sessionId, args });
    return { content: [{ type: "text", text: "ok" }] };
  },
);

server.tool(
  "ask_decision",
  "Ask the developer to choose between 2-3 options. Blocks until they answer; returns the chosen option id.",
  {
    question: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), tradeoff: z.string().optional() })).min(2).max(4),
    recommended: z.string().optional(),
  },
  async (args) => {
    const chosen = JSON.parse(await send({ tool: "ask_decision", sessionId, args })) as string;
    return { content: [{ type: "text", text: `Developer chose: ${chosen}` }] };
  },
);

server.tool(
  "report_outcome",
  "Report the final outcome of the task: what changed, proof it works, risks, follow-ups. Call once at the end.",
  {
    intent: z.string(),
    status: z.enum(["success", "partial", "failed"]),
    changed: z.array(z.object({ path: z.string(), kind: z.enum(["added", "modified", "deleted", "renamed"]) })),
    proof: z.array(
      z.object({
        kind: z.enum(["tests", "build", "screenshot", "command", "manual"]),
        label: z.string(),
        passed: z.boolean(),
        detail: z.string().optional(),
      }),
    ),
    risks: z.array(z.string()),
    followups: z.array(z.string()),
  },
  async (args) => {
    await send({ tool: "report_outcome", sessionId, args });
    return { content: [{ type: "text", text: "ok" }] };
  },
);

if (role === "main") {
  server.tool("list_sessions", "List the developer's coding sessions with status, progress, changed files and outcomes.", {}, async () =>
    text(await send({ tool: "list_sessions", sessionId, args: {} })),
  );
  server.tool("get_session", "Get one session's status, progress, changed files, outcome and last message.", { id: z.string() }, async (args) =>
    text(await send({ tool: "get_session", sessionId, args })),
  );
  server.tool(
    "spawn_session",
    "Start a coding agent session in a project folder. Returns its id. Use worktree: true to run in an isolated git worktree.",
    {
      project: z.string().describe("Absolute path (or ~/...) of the project folder"),
      prompt: z.string().describe("The full task for the agent"),
      title: z.string().optional().describe("Short tile title, 2-5 words"),
      agent: z.enum(["claude-code", "codex"]).optional(),
      model: z.string().optional(),
      mode: z.enum(["ask", "edits", "plan", "auto"]).optional(),
      worktree: z.boolean().optional(),
    },
    async (args) => text(await send({ tool: "spawn_session", sessionId, args })),
  );
  server.tool("send_to_session", "Send a follow-up message to a session.", { id: z.string(), prompt: z.string() }, async (args) =>
    text(await send({ tool: "send_to_session", sessionId, args })),
  );
}

await server.connect(new StdioServerTransport());
