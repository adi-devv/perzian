// A fake ACP agent for session tests (PERZIAN_TEST_ADAPTER). FAKE_SCENARIO picks how the first prompt goes:
//   limit: the turn fails at the usage limit the way claude-agent-acp reports it (a synthetic assistant
//          message, then an internal error with the same text and errorKind "rate_limit").
//   near:  rate-limit info at 97% of the 5-hour window, then one tool call; waits for the client's cancel.
// Every later prompt (and the first in any other scenario) echoes the prompt's tail and ends the turn.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

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
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok: ${text.slice(-80)}` } });
    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
