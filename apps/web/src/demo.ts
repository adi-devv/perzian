import type { PerzianEvent, SessionInfo } from "@perzian/protocol";

// Sample events used when the daemon isn't running (open with ?demo). Doubles as the Phase 0 mockup.
const t = Date.now();
const s = (id: string, title: string, project: string, branch: string, status: SessionInfo["status"], agent: SessionInfo["agent"], ago: number): SessionInfo => ({
  id, title, project, cwd: project, branch, agent, status, createdAt: t - ago, updatedAt: t - ago / 3,
  model: agent === "codex" ? "gpt-5-codex" : "claude-opus-5-5",
});

export const demoEvents: PerzianEvent[] = [
  { type: "session.created", session: s("a", "Stripe webhook retries", "~/code/billing", "fix/webhook-retry", "needs_you", "claude-code", 1_200_000) },
  { type: "session.created", session: s("b", "Migrate auth to sessions", "~/code/api", "feat/session-auth", "working", "claude-code", 900_000) },
  { type: "session.created", session: s("c", "Flaky e2e on checkout", "~/code/web", "fix/e2e-checkout", "failed", "codex", 2_400_000) },
  { type: "session.created", session: s("d", "Dark mode tokens", "~/code/web", "feat/dark-tokens", "done", "claude-code", 3_000_000) },
  { type: "session.created", session: s("e", "Rate limiter for /search", "~/code/api", "feat/rate-limit", "working", "codex", 400_000) },
  { type: "session.created", session: s("f", "Bump deps", "~/code/billing", "chore/deps", "idle", "claude-code", 6_000_000) },
  { type: "session.progress", sessionId: "b", progress: { phase: "Implement", step: 3, of: 5, note: "middleware" } },
  { type: "session.progress", sessionId: "e", progress: { phase: "Test", step: 4, of: 5 } },
  { type: "session.progress", sessionId: "a", progress: { phase: "Implement", step: 2, of: 4 } },
  {
    type: "decision.requested",
    decision: {
      id: "d1", sessionId: "a", source: "ask_decision", createdAt: t - 300_000,
      question: "How should failed webhooks retry?",
      recommended: "exp",
      options: [
        { id: "exp", label: "Exponential backoff", tradeoff: "Standard, 6 tries over ~1h", kind: "choice" },
        { id: "queue", label: "Dead-letter queue", tradeoff: "Durable, needs a new table", kind: "choice" },
        { id: "none", label: "Rely on Stripe", tradeoff: "Zero code, 3-day retry window", kind: "choice" },
      ],
    },
  },
  {
    type: "decision.requested",
    decision: {
      id: "d2", sessionId: "e", source: "permission", createdAt: t - 60_000,
      question: "npm install express-rate-limit",
      options: [
        { id: "y", label: "Allow", kind: "allow_once" },
        { id: "a", label: "Always", kind: "allow_always" },
        { id: "n", label: "Deny", kind: "reject_once" },
      ],
    },
  },
  {
    type: "outcome.reported",
    outcome: {
      sessionId: "d", intent: "Move colors to semantic tokens with dark variants", status: "success", createdAt: t - 1_000_000,
      changed: [
        { path: "src/styles/tokens.css", kind: "added" },
        { path: "src/styles/global.css", kind: "modified" },
        { path: "src/components/Button.tsx", kind: "modified" },
        { path: "src/components/Card.tsx", kind: "modified" },
        { path: "src/legacy/colors.ts", kind: "deleted" },
      ],
      proof: [
        { kind: "tests", label: "142 unit tests", passed: true },
        { kind: "build", label: "vite build", passed: true },
        { kind: "screenshot", label: "Light + dark snapshots", passed: true },
      ],
      risks: ["Third-party date picker still hardcodes #fff"],
      followups: ["Theme the date picker"],
    },
  },
  {
    type: "outcome.reported",
    outcome: {
      sessionId: "c", intent: "Stabilize checkout e2e", status: "failed", createdAt: t - 500_000,
      changed: [{ path: "e2e/checkout.spec.ts", kind: "modified" }],
      proof: [
        { kind: "tests", label: "checkout.spec 3/5 runs", passed: false, detail: "Timeout waiting for #pay-button" },
      ],
      risks: ["Root cause looks like a race in the payment iframe, not the test"],
      followups: ["Investigate iframe load event"],
    },
  },
  { type: "session.transcript", sessionId: "b", item: { kind: "user", text: "Replace JWT auth with server sessions backed by Redis.", at: t - 900_000 } },
  { type: "session.transcript", sessionId: "b", item: { kind: "tool", toolCallId: "1", title: "Read src/auth/jwt.ts", status: "completed", toolKind: "read", at: t - 880_000 } },
  { type: "session.transcript", sessionId: "b", item: { kind: "tool", toolCallId: "2", title: "Edit src/auth/session.ts", status: "completed", toolKind: "edit", at: t - 700_000 } },
  { type: "session.transcript", sessionId: "b", item: { kind: "agent", text: "Session store wired. Moving the middleware over now.", at: t - 650_000 } },
  { type: "session.transcript", sessionId: "b", item: { kind: "tool", toolCallId: "3", title: "Edit src/middleware/auth.ts", status: "in_progress", toolKind: "edit", at: t - 100_000 } },
];
