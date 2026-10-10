import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { DAEMON_PORT, type Command, type ReportCall, type ServerMessage } from "@perzian/protocol";
import { EventStore } from "./store.ts";
import { AgentSession, type PendingDecision } from "./session.ts";

const port = Number(process.env.PERZIAN_PORT ?? DAEMON_PORT);
const daemonUrl = `http://127.0.0.1:${port}`;
const store = new EventStore();
const sessions = new Map<string, AgentSession>();
const decisions = new Map<string, PendingDecision>();

async function handleCommand(cmd: Command): Promise<void> {
  switch (cmd.type) {
    case "session.create": {
      // TODO(phase1): create a git worktree when cmd.worktree is set.
      const s = new AgentSession(
        { project: cmd.project, cwd: cmd.project, title: cmd.title, agent: cmd.agent ?? "claude-code", model: cmd.model },
        store,
        daemonUrl,
        decisions,
      );
      sessions.set(s.info.id, s);
      await s.start();
      void s.prompt(cmd.prompt, true).catch((e) => console.error(`[${s.info.id}]`, e));
      break;
    }
    case "session.prompt":
      void sessions.get(cmd.sessionId)?.prompt(cmd.prompt).catch((e) => console.error(e));
      break;
    case "session.cancel":
      await sessions.get(cmd.sessionId)?.cancel();
      break;
    case "decision.answer":
      decisions.get(cmd.decisionId)?.resolve(cmd.optionId);
      break;
  }
}

async function handleReport(call: ReportCall): Promise<string> {
  const s = sessions.get(call.sessionId);
  if (!s) throw new Error(`unknown session ${call.sessionId}`);
  switch (call.tool) {
    case "report_progress":
      s.info.progress = call.args;
      store.emit({ type: "session.progress", sessionId: s.info.id, progress: call.args });
      return "ok";
    case "ask_decision": {
      const optionId = await s.requestDecision({
        id: randomUUID(),
        sessionId: s.info.id,
        source: "ask_decision",
        question: call.args.question,
        options: call.args.options.map((o) => ({ ...o, kind: "choice" as const })),
        recommended: call.args.recommended,
        createdAt: Date.now(),
      });
      return optionId ?? "cancelled";
    }
    case "report_outcome":
      store.emit({ type: "outcome.reported", outcome: { ...call.args, sessionId: s.info.id, createdAt: Date.now() } });
      return "ok";
  }
}

const http = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const text = await handleReport(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/plain" }).end(text);
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" }).end("perzian daemon");
});

const wss = new WebSocketServer({ server: http, path: "/ws" });
const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));

wss.on("connection", (ws) => {
  send(ws, { type: "snapshot", events: store.all() });
  const unsubscribe = store.subscribe((event) => send(ws, { type: "event", event }));
  ws.on("message", (raw) => {
    handleCommand(JSON.parse(String(raw)) as Command).catch((e) => send(ws, { type: "error", message: String(e) }));
  });
  ws.on("close", unsubscribe);
});

http.listen(port, "127.0.0.1", () => console.log(`perzian daemon on ${daemonUrl}`));

process.on("SIGINT", () => {
  for (const s of sessions.values()) s.dispose();
  process.exit(0);
});
