import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { REPORT_INSTRUCTIONS, type AgentKind, type Decision, type SessionInfo, type SessionStatus } from "@perzian/protocol";
import type { EventStore } from "./store.ts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const reportMcpEntry = join(here, "../../../packages/report-mcp/src/index.ts");
const tsxBin = join(here, "../../../node_modules/.bin/tsx");

function adapterCommand(agent: AgentKind): { command: string; args: string[] } {
  switch (agent) {
    case "claude-code":
      return { command: process.execPath, args: [require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")] };
    case "codex":
      throw new Error("Codex adapter not wired yet (Phase 4)");
  }
}

export interface PendingDecision {
  decision: Decision;
  resolve: (optionId: string | null) => void;
}

// One agent session = one adapter process + one ACP connection.
export class AgentSession {
  readonly info: SessionInfo;
  private proc?: ChildProcess;
  private conn?: acp.ClientSideConnection;
  private acpSessionId?: string;
  private agentText = "";

  constructor(
    opts: { project: string; cwd: string; title?: string; agent: AgentKind; model?: string; branch?: string },
    private store: EventStore,
    private daemonUrl: string,
    private decisions: Map<string, PendingDecision>,
  ) {
    const now = Date.now();
    this.info = {
      id: randomUUID(),
      title: opts.title ?? basename(opts.project),
      project: opts.project,
      cwd: opts.cwd,
      branch: opts.branch,
      agent: opts.agent,
      model: opts.model,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    store.emit({ type: "session.created", session: this.info });
  }

  setStatus(status: SessionStatus): void {
    if (this.info.status === status) return;
    this.info.status = status;
    this.info.updatedAt = Date.now();
    this.store.emit({ type: "session.status", sessionId: this.info.id, status, at: this.info.updatedAt });
  }

  async start(): Promise<void> {
    const { command, args } = adapterCommand(this.info.agent);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.info.model) env.ANTHROPIC_MODEL = this.info.model;
    this.proc = spawn(command, args, { cwd: this.info.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    this.proc.on("exit", (code) => {
      if (code && this.info.status !== "done") this.setStatus("failed");
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = new acp.ClientSideConnection(() => this.client(), stream);

    await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const res = await this.conn.newSession({
      cwd: this.info.cwd,
      mcpServers: [
        {
          name: "perzian",
          command: tsxBin,
          args: [reportMcpEntry],
          env: [
            { name: "PERZIAN_SESSION_ID", value: this.info.id },
            { name: "PERZIAN_DAEMON_URL", value: this.daemonUrl },
          ],
        },
      ],
    });
    this.acpSessionId = res.sessionId;
  }

  async prompt(text: string, first = false): Promise<void> {
    if (!this.conn || !this.acpSessionId) throw new Error("session not started");
    const at = Date.now();
    this.store.emit({ type: "session.transcript", sessionId: this.info.id, item: { kind: "user", text, at } });
    this.setStatus("working");
    const body = first ? `${REPORT_INSTRUCTIONS}\n\n---\n\n${text}` : text;
    try {
      const res = await this.conn.prompt({ sessionId: this.acpSessionId, prompt: [{ type: "text", text: body }] });
      this.flushAgentText();
      this.setStatus(res.stopReason === "cancelled" ? "idle" : res.stopReason === "refusal" ? "failed" : "done");
    } catch (err) {
      this.flushAgentText();
      this.setStatus("failed");
      throw err;
    }
  }

  async cancel(): Promise<void> {
    if (this.conn && this.acpSessionId) await this.conn.cancel({ sessionId: this.acpSessionId });
  }

  dispose(): void {
    this.proc?.kill();
  }

  // Agent text arrives in chunks; collapse each run into one transcript item.
  private flushAgentText(): void {
    if (!this.agentText.trim()) return;
    this.store.emit({
      type: "session.transcript",
      sessionId: this.info.id,
      item: { kind: "agent", text: this.agentText, at: Date.now() },
    });
    this.agentText = "";
  }

  requestDecision(decision: Decision): Promise<string | null> {
    this.setStatus("needs_you");
    this.store.emit({ type: "decision.requested", decision });
    return new Promise((resolve) => {
      this.decisions.set(decision.id, {
        decision,
        resolve: (optionId) => {
          this.decisions.delete(decision.id);
          this.store.emit({ type: "decision.resolved", decisionId: decision.id, sessionId: this.info.id, optionId });
          this.setStatus("working");
          resolve(optionId);
        },
      });
    });
  }

  private client(): acp.Client {
    return {
      requestPermission: async (params) => {
        const optionId = await this.requestDecision({
          id: randomUUID(),
          sessionId: this.info.id,
          source: "permission",
          question: params.toolCall.title ?? "Allow this action?",
          options: params.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
          createdAt: Date.now(),
        });
        return optionId === null
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId } };
      },
      sessionUpdate: async ({ update }) => {
        const at = Date.now();
        const id = this.info.id;
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            if (update.content.type === "text") this.agentText += update.content.text;
            break;
          case "agent_thought_chunk":
            break;
          case "tool_call":
            this.flushAgentText();
            this.store.emit({
              type: "session.transcript",
              sessionId: id,
              item: { kind: "tool", toolCallId: update.toolCallId, title: update.title, status: update.status ?? "pending", toolKind: update.kind, at },
            });
            break;
          case "tool_call_update":
            if (update.status === "completed" || update.status === "failed") {
              this.store.emit({
                type: "session.transcript",
                sessionId: id,
                item: { kind: "tool", toolCallId: update.toolCallId, title: update.title ?? "", status: update.status, toolKind: update.kind ?? undefined, at },
              });
            }
            break;
          default:
            break;
        }
      },
    };
  }
}
