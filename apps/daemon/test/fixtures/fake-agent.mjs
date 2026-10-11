// A scripted ACP agent for session tests: no model, just file writes in its cwd.
//   node fake-agent.mjs <mode> <log>
// A task prompt: adds a line to work.txt. A "required checks" fix prompt: in mode "fix" writes fixed.txt, in mode
// "never" changes nothing. Mode "perm": the first prompt also asks permission to run each command listed
// in $FAKE_AGENT_COMMANDS (JSON array) and logs the answers. Every prompt and answer is appended to <log>.
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const [mode = "fix", log] = process.argv.slice(2);
const record = (entry) => log && appendFileSync(log, JSON.stringify(entry) + "\n");

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
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
  async cancel() {}
  async prompt(params) {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    record({ prompt: text });
    if (/ran the required checks/.test(text)) {
      if (mode === "fix") writeFileSync("fixed.txt", "ok\n");
    } else {
      appendFileSync("work.txt", "done\n"); // grows every task, so each one changes the diff
      if (mode === "perm") {
        for (const command of JSON.parse(process.env.FAKE_AGENT_COMMANDS ?? "[]")) {
          const res = await this.conn.requestPermission({
            sessionId: params.sessionId,
            toolCall: { toolCallId: `perm-${command}`, title: command, kind: "execute", status: "pending", rawInput: { command } },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          });
          record({ command, outcome: res.outcome.outcome === "selected" ? res.outcome.optionId : res.outcome.outcome });
        }
      }
    }
    return { stopReason: "end_turn" };
  }
}

new acp.AgentSideConnection((conn) => new FakeAgent(conn), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
