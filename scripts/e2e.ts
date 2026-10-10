// End-to-end smoke test: drives a real agent session through the daemon.
// Usage: npx tsx scripts/e2e.ts <repoPath> "<prompt>" [model]
//   env: WORKTREE=1, MODE=ask|edits|plan|auto, SESSION=<id> (send a follow-up prompt to an existing session instead)
// Auto-answers every decision with the first allow/recommended option and exits when the session settles.
import WebSocket from "ws";
import type { Command, PerzianEvent, PermissionMode, ServerMessage } from "@perzian/protocol";

const [project, prompt, model] = process.argv.slice(2);
if (!project || !prompt) {
  console.error('usage: tsx scripts/e2e.ts <repo> "<prompt>" [model]');
  process.exit(2);
}

const port = process.env.PERZIAN_PORT ?? "4317";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const send = (c: Command) => ws.send(JSON.stringify(c));
const title = `e2e-${Date.now().toString(36)}`;
let sessionId: string | undefined = process.env.SESSION;
let prompted = false;
const seen: PerzianEvent["type"][] = [];
const timeout = setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(1);
}, Number(process.env.TIMEOUT ?? 240_000));

ws.on("open", () => {
  if (sessionId) {
    send({ type: "session.prompt", sessionId, prompt });
    prompted = true;
  } else send({ type: "session.create", project, prompt, model, title, mode: process.env.MODE as PermissionMode | undefined, worktree: process.env.WORKTREE === "1" });
});
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "error") console.error("ERROR", msg.message);
  if (msg.type !== "event") return;
  const e = msg.event;
  if (e.type === "session.created" && e.session.title === title && !sessionId) sessionId = e.session.id;
  const sid = "sessionId" in e ? e.sessionId : e.type === "session.created" ? e.session.id : e.type === "decision.requested" ? e.decision.sessionId : e.type === "outcome.reported" ? e.outcome.sessionId : undefined;
  if (!sessionId || sid !== sessionId) return;
  seen.push(e.type);
  console.log(e.type === "session.config" ? JSON.stringify(e) : JSON.stringify(e).slice(0, 400));
  if (e.type === "decision.requested") {
    const d = e.decision;
    const pick = d.options.find((o) => o.id === d.recommended) ?? d.options.find((o) => o.kind === "allow_once") ?? d.options[0];
    send({ type: "decision.answer", decisionId: d.id, optionId: pick.id });
  }
  if (e.type === "session.status" && e.status === "working") prompted = true;
  if (prompted && e.type === "session.status" && (e.status === "done" || e.status === "failed" || e.status === "idle")) {
    setTimeout(() => {
      clearTimeout(timeout);
      console.log("\nSETTLED:", e.status, "| session", sessionId, "| event types:", [...new Set(seen)].join(", "));
      process.exit(e.status === "failed" ? 1 : 0);
    }, 2500);
  }
});
