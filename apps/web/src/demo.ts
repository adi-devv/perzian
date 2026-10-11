import type { FileChange, PerzianEvent, SessionInfo } from "@perzian/protocol";

// Sample events used with ?demo. Shows every surface without running agents.
const t = Date.now();
const s = (id: string, title: string, project: string, branch: string, status: SessionInfo["status"], agent: SessionInfo["agent"], ago: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, role: "worker", title, project, cwd: project, branch, agent, status, createdAt: t - ago, updatedAt: t - ago / 3, live: true,
  model: agent === "codex" ? undefined : "claude-sonnet-5-5", mode: "ask", worktree: true, parentId: "main", ...extra,
});
type Sym = NonNullable<FileChange["symbols"]>[number];
const f = (path: string, kind: FileChange["kind"], additions: number, deletions: number, symbols?: [string, Sym["kind"], Sym["change"]][]): FileChange => ({
  path, kind, additions, deletions, symbols: symbols?.map(([name, k, change], i) => ({ name, kind: k, change, line: i * 10 + 1 })),
});

export const demoEvents: PerzianEvent[] = [
  { type: "session.created", session: { ...s("main", "Perzian", "~/.perzian/main", "", "done", "claude-code", 3_600_000), role: "main", parentId: undefined, model: "claude-opus-5-5", worktree: false } },
  { type: "session.created", session: s("b", "Session auth", "~/code/api", "perzian/session-auth", "working", "claude-code", 900_000) },
  { type: "session.created", session: s("e", "Rate limit /search", "~/code/api", "perzian/rate-limit", "needs_you", "codex", 400_000) },
  { type: "session.created", session: s("a", "Webhook retries", "~/code/billing", "perzian/webhook-retry", "needs_you", "claude-code", 1_200_000) },
  { type: "session.created", session: s("c", "Flaky checkout e2e", "~/code/web", "perzian/e2e-checkout", "failed", "codex", 2_400_000) },
  { type: "session.created", session: s("d", "Dark mode tokens", "~/code/web", "perzian/dark-tokens", "done", "claude-code", 3_000_000) },
  { type: "session.created", session: s("g", "Bump deps", "~/code/billing", "main", "idle", "claude-code", 6_000_000, { parentId: undefined, worktree: false, live: false }) },

  { type: "session.updated", sessionId: "main", patch: { usage: { costUsd: 0.38, contextUsed: 41_000, contextSize: 200_000 } } },
  { type: "session.updated", sessionId: "b", patch: { usage: { costUsd: 1.12, contextUsed: 92_000, contextSize: 200_000 } } },
  { type: "session.updated", sessionId: "a", patch: { usage: { costUsd: 0.41, contextUsed: 38_000, contextSize: 200_000 } } },
  { type: "session.updated", sessionId: "d", patch: { usage: { costUsd: 0.87, contextUsed: 168_000, contextSize: 200_000 } } },
  { type: "session.updated", sessionId: "e", patch: { usage: { contextUsed: 61_000, contextSize: 258_000 } } },

  { type: "session.progress", sessionId: "b", progress: { phase: "Implement", step: 3, of: 5, note: "middleware" } },
  { type: "session.progress", sessionId: "e", progress: { phase: "Implement", step: 2, of: 4 } },
  { type: "session.progress", sessionId: "a", progress: { phase: "Design", step: 1, of: 4 } },

  { type: "session.transcript", sessionId: "main", item: { kind: "user", text: "Morning. Billing webhooks are dropping on Stripe retries, auth should move off JWT, and checkout e2e keeps flaking. Split it up.", at: t - 3_500_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "agent", text: "Three independent jobs, so three sessions in their own worktrees. I'll flag anything that needs a call from you.", at: t - 3_490_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "a", title: "Webhook retries", at: t - 3_480_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "b", title: "Session auth", at: t - 3_470_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "c", title: "Flaky checkout e2e", at: t - 3_460_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "user", text: "Also do the dark mode token cleanup and add rate limiting on /search with Codex.", at: t - 3_100_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "d", title: "Dark mode tokens", at: t - 3_090_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "spawn", childId: "e", title: "Rate limit /search", at: t - 3_080_000 } },
  { type: "session.transcript", sessionId: "main", item: { kind: "agent", text: "Dark mode landed with tests and snapshots green. Checkout e2e failed: it looks like a real race in the payment iframe, not a test problem. Want me to chase it?", at: t - 600_000 } },

  {
    type: "decision.requested",
    decision: {
      id: "d1", sessionId: "a", source: "ask_decision", createdAt: t - 300_000,
      question: "How should failed webhooks retry?", recommended: "exp",
      options: [
        { id: "exp", label: "Exponential backoff", tradeoff: "Standard, 6 tries over ~1h", kind: "choice" },
        { id: "queue", label: "Dead-letter queue", tradeoff: "Durable, needs a new table", kind: "choice" },
        { id: "none", label: "Rely on Stripe", tradeoff: "Zero code, 3-day window", kind: "choice" },
      ],
    },
  },
  {
    type: "decision.requested",
    decision: {
      id: "d2", sessionId: "e", source: "permission", createdAt: t - 60_000, question: "Terminal", detail: "npm install express-rate-limit",
      options: [
        { id: "y", label: "Allow", kind: "allow_once" },
        { id: "a", label: "Always", kind: "allow_always" },
        { id: "n", label: "Deny", kind: "reject_once" },
      ],
    },
  },

  { type: "session.changes", sessionId: "b", at: t, files: [
    f("src/auth/session.ts", "added", 48, 0, [["issue", "function", "added"], ["revoke", "function", "added"], ["SessionStore", "class", "added"]]),
    f("src/auth/jwt.ts", "deleted", 0, 61, [["sign", "function", "deleted"], ["verify", "function", "deleted"]]),
    f("src/middleware/auth.ts", "modified", 22, 17, [["requireUser", "function", "modified"], ["readSessionCookie", "function", "added"]]),
    f("src/routes/login.ts", "modified", 9, 4, [["LoginRoute.post", "method", "modified"]]),
    f("test/auth.test.ts", "modified", 31, 8, [["describe:sessions", "function", "added"]]),
  ] },
  { type: "session.changes", sessionId: "e", at: t, files: [f("src/routes/search.ts", "modified", 6, 1), f("src/middleware/rateLimit.ts", "added", 24, 0)] },
  { type: "session.changes", sessionId: "c", at: t, files: [f("e2e/checkout.spec.ts", "modified", 14, 6)] },
  { type: "session.changes", sessionId: "d", at: t, files: [f("src/styles/tokens.css", "added", 88, 0), f("src/styles/global.css", "modified", 12, 40), f("src/components/Button.tsx", "modified", 6, 6), f("src/components/Card.tsx", "modified", 4, 4), f("src/legacy/colors.ts", "deleted", 0, 32)] },

  {
    type: "outcome.reported",
    outcome: {
      sessionId: "d", intent: "Move colors to semantic tokens with dark variants", status: "success", createdAt: t - 1_000_000,
      changed: [], proof: [
        { kind: "tests", label: "npm test", summary: "142 passed", passed: true, observed: true, command: "npm test", exitCode: 0, durationMs: 8400 },
        { kind: "build", label: "vite build", passed: true, observed: true, command: "npx vite build", exitCode: 0, durationMs: 2100 },
        { kind: "screenshot", label: "Light + dark snapshots", passed: true },
      ],
      risks: ["Date picker still hardcodes #fff"], followups: ["Theme the date picker"],
    },
  },
  {
    type: "outcome.reported",
    outcome: {
      sessionId: "c", intent: "Stabilize checkout e2e", status: "failed", createdAt: t - 500_000, changed: [],
      proof: [{ kind: "tests", label: "playwright test checkout", summary: "2 failed", passed: false, observed: true, command: "npx playwright test e2e/checkout.spec.ts", exitCode: 1, durationMs: 41000, detail: "Timeout waiting for #pay-button" }],
      risks: ["Race in the payment iframe load, not the test"], followups: ["Investigate iframe load event"],
    },
  },

  { type: "session.transcript", sessionId: "b", item: { kind: "user", text: "Replace JWT auth with server sessions backed by Redis.", at: t - 900_000 } },
  ...["read", "read", "search", "read", "edit", "edit", "execute", "edit", "read", "edit"].map((k, i): PerzianEvent => ({
    type: "session.transcript", sessionId: "b",
    item: { kind: "tool", toolCallId: `b${i}`, title: `${k === "edit" ? "Edit" : k === "execute" ? "Run" : "Read"} src/auth/${["jwt", "session", "index", "types"][i % 4]}.ts`, status: i === 9 ? "in_progress" : "completed", toolKind: k, at: t - 880_000 + i * 60_000 },
  })),
  { type: "session.transcript", sessionId: "b", item: { kind: "agent", text: "Session store wired. Moving the middleware over now.", at: t - 300_000 } },
  { type: "session.config", sessionId: "b", config: { models: [], modes: [] } },
];
