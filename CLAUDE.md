# Perzian

Visual-first agentic development environment. Read `docs/VISION.md` (why), `docs/ARCHITECTURE.md` (how),
`docs/ROADMAP.md` (what's next) before making product or architecture decisions.

## Non-negotiables
- Instant visual cue over text. If state needs a sentence to understand, redesign it.
- Wrap existing agents over ACP; never build our own agent loop.
- Multi-model by design; ship Claude Code first, Codex second.
- Code view is read-only.
- Diagrams come from real structure (tree-sitter/git), the model only selects and labels.

## Layout
- `packages/protocol` — shared types (UI ↔ daemon). Change here first.
- `packages/report-mcp` — MCP server agents use to report structured progress/decisions/outcomes.
- `apps/daemon` — Node daemon: ACP sessions, worktrees, event store, WebSocket on :4317.
- `apps/web` — React + Vite UI.

## Commands
- `npm install` at root (npm workspaces; no pnpm).
- `npm run dev` — daemon + web.
- `npm run typecheck`

## Conventions
- TypeScript strict, ESM, Node ≥ 22.
- UI state is a fold over `PerzianEvent`s; never add UI state the daemon can't replay.
