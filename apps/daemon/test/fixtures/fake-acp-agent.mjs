// A fake ACP agent for session tests (PERZIAN_TEST_ADAPTER). FAKE_SCENARIO picks how the first prompt goes:
//   limit: the turn fails at the usage limit the way claude-agent-acp reports it (a synthetic assistant
//          message, then an internal error with the same text and errorKind "rate_limit").
//   near:  rate-limit info at 97% of the 5-hour window, then one tool call; waits for the client's cancel.
//   observe: touches the repo and reports what an agent does on its own: a subagent with a nested call, a
//          background dev server, a commit and a second worktree made by shell commands, and an edit outside
//          the folder (asking permission first, FAKE_OUTSIDE is the path).
// Every later prompt (and the first in any other scenario) echoes the prompt's tail and ends the turn.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { execSync } from "node:child_process";

const scenario = process.env.FAKE_SCENARIO ?? "";
const LIMIT = "You've hit your session limit · resets 5:40pm (Asia/Calcutta)";

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.turn = 0;
    this.onCancel = undefined;
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession() {
    return { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } };
  }
  async authenticate() {
    return {};
  }
  async setSessionMode() {
    return {};
  }
  async cancel() {
    this.onCancel?.();
  }
  async prompt(params) {
    const n = ++this.turn;
    const text = params.prompt.map((p) => (p.type === "text" ? p.text : "")).join("");
    const send = (update) => this.conn.sessionUpdate({ sessionId: params.sessionId, update });
    if (scenario === "limit" && n === 1) {
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it." } });
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: LIMIT } });
      throw acp.RequestError.internalError({ errorKind: "rate_limit" }, LIMIT);
    }
    if (scenario === "near" && n === 1) {
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
      await send({ sessionUpdate: "usage_update", used: 1000, size: 200000, _meta: { "_claude/rateLimit": { status: "allowed_warning", resetsAt, rateLimitType: "five_hour", utilization: 0.97 } } });
      await send({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit a.ts", kind: "edit", status: "in_progress" });
      const cancelled = new Promise((resolve) => (this.onCancel = resolve));
      await send({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      const wait = Number(process.env.FAKE_CANCEL_WAIT_MS ?? 5000);
      const timedOut = await Promise.race([cancelled.then(() => false), new Promise((r) => setTimeout(() => r(true), wait))]);
      return { stopReason: timedOut ? "end_turn" : "cancelled" };
    }
    if (scenario === "observe" && n === 1) {
      const sh = (c) => execSync(c, { cwd: process.cwd(), stdio: "ignore" });
      const meta = (toolName, parentToolUseId) => ({ claudeCode: { toolName, ...(parentToolUseId ? { parentToolUseId } : {}) } });
      await send({ sessionUpdate: "tool_call", toolCallId: "sub1", title: "Explore the repo", kind: "other", status: "pending", rawInput: {}, _meta: meta("Agent") });
      await send({ sessionUpdate: "tool_call_update", toolCallId: "sub1", rawInput: { description: "Explore the repo", subagent_type: "Explore" } });
      await send({ sessionUpdate: "tool_call", toolCallId: "inner1", title: "Read a.txt", kind: "read", status: "pending", _meta: meta("Read", "sub1") });
      await send({ sessionUpdate: "tool_call_update", toolCallId: "inner1", status: "completed", _meta: meta("Read", "sub1") });
      await send({ sessionUpdate: "tool_call_update", toolCallId: "sub1", status: "completed" });
      await send({ sessionUpdate: "tool_call", toolCallId: "bg1", title: "Terminal", kind: "execute", status: "pending", rawInput: {}, _meta: meta("Bash") });
      await send({ sessionUpdate: "tool_call_update", toolCallId: "bg1", title: "npm run dev -- --port 5173", rawInput: { command: "npm run dev -- --port 5173", run_in_background: true } });
      await send({ sessionUpdate: "tool_call_update", toolCallId: "bg1", status: "completed", _meta: { claudeCode: { toolName: "Bash", toolResponse: { stdout: "started", stderr: "", backgroundTaskId: "bash_1" } } } });
      sh("git checkout -q -b agent-feature && echo more >> a.txt && git add -A && git commit -qm agent-commit");
      sh("git worktree add -q -b side ../side-" + process.pid);
      await send({ sessionUpdate: "tool_call", toolCallId: "sh1", title: "git commit", kind: "execute", status: "pending", rawInput: { command: "git commit" }, _meta: meta("Bash") });
      await send({ sessionUpdate: "tool_call_update", toolCallId: "sh1", status: "completed" });
      const outside = process.env.FAKE_OUTSIDE;
      const call = { toolCallId: "ed1", title: "Edit outside", kind: "edit", rawInput: { file_path: outside }, locations: [{ path: outside }] };
      const answer = await this.conn.requestPermission({ sessionId: params.sessionId, toolCall: call, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
      await send({ sessionUpdate: "tool_call", ...call, status: "completed", _meta: meta("Edit") });
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission: ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}` } });
      return { stopReason: "end_turn" };
    }
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok: ${text.slice(-80)}` } });
    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
