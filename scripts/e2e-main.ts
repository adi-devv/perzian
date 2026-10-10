// End-to-end test of the main (orchestrator) agent: starts/prompts the main session and follows every
// session it spawns. Auto-answers all decisions; exits once the main session and all its children settle.
// Usage: npx tsx scripts/e2e-main.ts "<prompt>" [model]
import WebSocket from "ws";
import type { Command, PerzianEvent, ServerMessage } from "@perzian/protocol";

const [prompt, model = "claude-haiku-5-5"] = process.argv.slice(2);
if (!prompt) {
  console.error('usage: tsx scripts/e2e-main.ts "<prompt>" [model]');
  process.exit(2);
}

const port = process.env.PERZIAN_PORT ?? "4317";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const send = (c: Command) => ws.send(JSON.stringify(c));
let mainId: string | undefined;
const children = new Set<string>();
const status = new Map<string, string>();
const worked = new Set<string>();
const timeout = setTimeout(() => {
  console.error("TIMEOUT", Object.fromEntries(status));
  process.exit(1);
}, Number(process.env.TIMEOUT ?? 420_000));

const sidOf = (e: PerzianEvent) =>
  "sessionId" in e ? e.sessionId : e.type === "session.created" ? e.session.id : e.type === "decision.requested" ? e.decision.sessionId : e.outcome.sessionId;

let settleTimer: ReturnType<typeof setTimeout> | undefined;
function checkSettled() {
  clearTimeout(settleTimer);
  const ids = [mainId!, ...children];
  const settled = ids.every((id) => worked.has(id) && ["done", "failed", "idle"].includes(status.get(id) ?? ""));
  if (!mainId || !settled) return;
  settleTimer = setTimeout(() => {
    clearTimeout(timeout);
    console.log("\nSETTLED main", mainId, status.get(mainId!), "children", [...children].map((c) => `${c}:${status.get(c)}`).join(" "));
    process.exit(0);
  }, 4000);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "error") console.error("ERROR", msg.message);
  if (msg.type === "snapshot") {
    // Reuse an existing main session if there is one; main.start then just prompts it.
    for (const e of msg.events) if (e.type === "session.created" && e.session.role === "main") mainId = e.session.id;
    send({ type: "main.start", model, prompt });
    return;
  }
  if (msg.type !== "event") return;
  const e = msg.event;
  if (e.type === "session.created" && e.session.role === "main") mainId ??= e.session.id;
  if (e.type === "session.created" && e.session.parentId && e.session.parentId === mainId) children.add(e.session.id);
  const sid = sidOf(e);
  if (sid !== mainId && !children.has(sid)) return;
  const who = sid === mainId ? "MAIN " : `child ${sid.slice(0, 6)}`;
  console.log(who, JSON.stringify(e).slice(0, 350));
  if (e.type === "decision.requested") {
    const d = e.decision;
    const pick = d.options.find((o) => o.id === d.recommended) ?? d.options.find((o) => o.kind === "allow_once") ?? d.options[0];
    send({ type: "decision.answer", decisionId: d.id, optionId: pick.id });
  }
  if (e.type === "session.status") {
    status.set(sid, e.status);
    if (e.status === "working") worked.add(sid);
    checkSettled();
  }
});
