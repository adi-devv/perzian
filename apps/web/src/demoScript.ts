import type { Command, FileChange, PerzianEvent, Proof, SessionInfo, State } from "@perzian/protocol";

// A scripted run for ?demo: ask the lead for something and watch a session start, work, ask for a call,
// verify and report. Same events the daemon sends; no agent runs.

type Emit = (e: PerzianEvent) => void;

let runs = 0;
let toldScripted = false;
const waiting = new Map<string, () => void>(); // decision id → rest of the run
let touched = false; // the visitor did something; autoplay stands down

/** Plays one run by itself shortly after the demo opens, unless the visitor starts one first. */
export function demoAutoplay(getState: () => State, emit: Emit): () => void {
  const t = setTimeout(() => {
    if (!touched && runs === 0) leadRun("Add a login page with email sign-in", getState(), emit, true);
  }, 1800);
  return () => clearTimeout(t);
}

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

function titleFrom(prompt: string): string {
  const words = prompt
    .replace(/^(hey|hi|please|pls|can you|could you|i want you to|i want to|let's|lets)\b[\s,]*/i, "")
    .replace(/[.?!]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  // Stop at the first connector after the core phrase ("Add a login page | with email sign-in").
  const cut = words.findIndex((w, i) => i >= 2 && /^(with|for|that|which|using|so|and|via)$/i.test(w));
  const core = words.slice(0, cut > 0 ? Math.min(cut, 6) : 6);
  while (core.length > 1 && /^(a|an|the|of|with|for|and|to)$/i.test(core[core.length - 1])) core.pop();
  const t = core.join(" ") || "New feature";
  return t[0].toUpperCase() + t.slice(1);
}

const slugFrom = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 3)
    .join("-") || "feature";

export function demoSend(cmd: Command, s: State, emit: Emit): void {
  const at = Date.now();
  if (cmd.type === "decision.answer" || cmd.type === "session.prompt" || cmd.type === "main.start") touched = true;
  if (cmd.type === "decision.answer") {
    const d = s.decisions[cmd.decisionId];
    if (!d) return;
    emit({ type: "decision.resolved", decisionId: d.id, sessionId: d.sessionId, optionId: cmd.optionId });
    emit({ type: "session.status", sessionId: d.sessionId, status: "working", at });
    const next = waiting.get(d.id);
    waiting.delete(d.id);
    next?.();
  } else if (cmd.type === "session.seen") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { seenAt: at } });
  } else if (cmd.type === "session.prompt" || (cmd.type === "main.start" && cmd.prompt)) {
    const id = cmd.type === "session.prompt" ? cmd.sessionId : "main";
    const text = cmd.type === "session.prompt" ? cmd.prompt : cmd.prompt!;
    emit({ type: "session.transcript", sessionId: id, item: { kind: "user", text, at } });
    emit({ type: "session.status", sessionId: id, status: "working", at });
    if (id === "main") leadRun(text, s, emit);
    else workerReply(id, emit);
  } else if (cmd.type === "session.setModel") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { model: cmd.model } });
  } else if (cmd.type === "session.setMode") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { mode: cmd.mode } });
  } else if (cmd.type === "session.archive") {
    emit({ type: "session.updated", sessionId: cmd.sessionId, patch: { archived: true } });
  }
}

function workerReply(id: string, emit: Emit) {
  const tool = `demo-w-${Date.now()}`;
  later(600, () => emit({ type: "session.transcript", sessionId: id, item: { kind: "tool", toolCallId: tool, title: "Read files", status: "in_progress", toolKind: "read", at: Date.now() } }));
  later(1500, () => emit({ type: "session.transcript", sessionId: id, item: { kind: "tool", toolCallId: tool, title: "Read files", status: "completed", toolKind: "read", at: Date.now() } }));
  later(2200, () => {
    emit({ type: "session.transcript", sessionId: id, item: { kind: "agent", text: "Got it. (Demo: this reply is scripted. Ask Perzian, the lead, for something new to see a full run.)", at: Date.now() } });
    emit({ type: "session.status", sessionId: id, status: "done", at: Date.now() });
  });
}

function leadRun(prompt: string, s: State, emit: Emit, auto = false) {
  const n = ++runs;
  const id = `demo-${n}`;
  const title = titleFrom(prompt);
  const slug = slugFrom(title);
  const now = () => Date.now();
  const tr = (sessionId: string, item: Parameters<typeof transcript>[1]) => emit(transcript(sessionId, item));
  const project = "~/code/web";
  const lead = s.sessions.main;

  if (auto) {
    tr("main", { kind: "notice", text: "Demo: a sample run plays by itself. Type your own request to try one.", at: now() });
  } else if (!toldScripted) {
    toldScripted = true;
    tr("main", { kind: "notice", text: "Demo: this run is scripted. Install Perzian to run real agents.", at: now() });
  }
  if (auto) {
    emit({ type: "session.transcript", sessionId: "main", item: { kind: "user", text: prompt, at: now() } });
    emit({ type: "session.status", sessionId: "main", status: "working", at: now() });
  }

  const files: FileChange[] = [
    { path: `src/${slug}/index.ts`, kind: "added", additions: 64, deletions: 0, symbols: [{ name: camel(slug), kind: "function", change: "added", line: 12 }, { name: `${pascal(slug)}Options`, kind: "interface", change: "added", line: 3 }] },
    { path: "src/routes.ts", kind: "modified", additions: 4, deletions: 1, symbols: [{ name: "routes", kind: "variable", change: "modified", line: 8 }] },
    { path: `src/${slug}/index.test.ts`, kind: "added", additions: 38, deletions: 0 },
  ];
  const usage = (costUsd: number, contextUsed: number) => emit({ type: "session.updated", sessionId: id, patch: { usage: { costUsd, contextUsed, contextSize: 200_000 } } });
  const progress = (phase: string, step: number) => emit({ type: "session.progress", sessionId: id, progress: { phase, step, of: 4 } });
  const tool = (key: string, title: string, toolKind: string, status = "completed") => tr(id, { kind: "tool", toolCallId: `${id}-${key}`, title, status, toolKind, at: now() });

  later(900, () => {
    tr("main", { kind: "agent", text: `On it. One session in its own worktree for "${title}". I'll come back only if it needs your call.`, at: now() });
    const session: SessionInfo = {
      id, role: "worker", parentId: "main", title, project, cwd: `~/.perzian/worktrees/${slug}`, branch: `perzian/${slug}`, worktree: true,
      agent: "claude-code", model: "claude-sonnet-5-5", mode: "ask", status: "working", live: true, createdAt: now(), updatedAt: now(),
    };
    emit({ type: "session.created", session });
    tr("main", { kind: "spawn", childId: id, title, at: now() });
    emit({ type: "session.status", sessionId: "main", status: "done", at: now() });
    if (lead) emit({ type: "session.updated", sessionId: "main", patch: { usage: { ...lead.usage, costUsd: (lead.usage?.costUsd ?? 0) + 0.02 } } });
    progress("Plan", 1);
    tr(id, { kind: "user", text: prompt, at: now() });
  });
  later(1800, () => { tool("read", "Read src/routes.ts", "read"); usage(0.04, 18_000); });
  later(2600, () => tool("search", `Search "${slug.split("-")[0]}"`, "search"));
  later(3400, () => { progress("Implement", 2); tool("edit1", `Write src/${slug}/index.ts`, "edit"); emit({ type: "session.changes", sessionId: id, files: files.slice(0, 1), at: now() }); usage(0.11, 34_000); });
  later(4300, () => { tool("edit2", "Edit src/routes.ts", "edit"); emit({ type: "session.changes", sessionId: id, files: files.slice(0, 2), at: now() }); usage(0.16, 41_000); });
  later(5400, () => {
    const decisionId = `${id}-ask`;
    emit({
      type: "decision.requested",
      decision: {
        id: decisionId, sessionId: id, source: "ask_decision", createdAt: now(), recommended: "small",
        question: `How far should "${title}" go?`,
        options: [
          { id: "small", label: "Smallest change", tradeoff: "Fits the existing routes, ships today", kind: "choice" },
          { id: "module", label: "Standalone module", tradeoff: "Cleaner boundary, about twice the code", kind: "choice" },
        ],
      },
    });
    emit({ type: "session.status", sessionId: id, status: "needs_you", at: now() });
    waiting.set(decisionId, finish);
    // Autoplay makes the call itself if the visitor doesn't, so the run always finishes.
    if (auto)
      later(4500, () => {
        if (!waiting.has(decisionId)) return;
        waiting.delete(decisionId);
        emit({ type: "decision.resolved", decisionId, sessionId: id, optionId: "small" });
        emit({ type: "session.status", sessionId: id, status: "working", at: now() });
        finish();
      });
  });

  function finish() {
    later(700, () => { progress("Verify", 3); tool("edit3", `Write src/${slug}/index.test.ts`, "edit"); emit({ type: "session.changes", sessionId: id, files, at: now() }); usage(0.24, 52_000); });
    later(1500, () => tool("test", "npm test", "execute", "in_progress"));
    later(3300, () => { tool("test", "npm test", "execute"); tool("tsc", "npm run typecheck", "execute"); });
    later(3900, () => {
      progress("Report", 4);
      usage(0.29, 58_000);
      const proof: Proof[] = [
        { kind: "tests", label: "npm test", passed: true, observed: true, command: "npm test", exitCode: 0, summary: "24 passed", durationMs: 1800 },
        { kind: "typecheck", label: "npm run typecheck", passed: true, observed: true, command: "npm run typecheck", exitCode: 0, durationMs: 2100 },
      ];
      emit({
        type: "outcome.reported",
        outcome: {
          sessionId: id, intent: title, status: "success", createdAt: now(), proof,
          changed: files.map((f) => ({ path: f.path, kind: f.kind })),
          risks: [], followups: ["Add it to the docs"],
        },
      });
      emit({ type: "session.status", sessionId: id, status: "done", at: now() });
    });
    later(4600, () => {
      tr("main", { kind: "user", system: true, text: `[perzian] A session you started finished.\n- id="${id}" title="${title}" status="done" outcome="success" proof="2 passed"`, at: now() });
      emit({ type: "session.status", sessionId: "main", status: "working", at: now() });
    });
    later(5600, () => {
      tr("main", { kind: "agent", text: `"${title}" is done: 3 files, tests and typecheck pass (exit 0). Open it to see what changed.`, at: now() });
      emit({ type: "session.status", sessionId: "main", status: "done", at: now() });
    });
  }
}

function transcript(sessionId: string, item: Extract<PerzianEvent, { type: "session.transcript" }>["item"]): PerzianEvent {
  return { type: "session.transcript", sessionId, item };
}

const pascal = (slug: string) => slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const camel = (slug: string) => {
  const p = pascal(slug);
  return p[0].toLowerCase() + p.slice(1);
};
