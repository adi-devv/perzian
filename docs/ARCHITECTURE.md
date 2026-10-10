# Perzian — Architecture

## Overview

```
┌──────────────────────────── Browser / desktop shell ────────────────────────────┐
│  apps/web (React + Vite)                                                         │
│  Control tower · Attention queue · Main agent chat · Outcome cards · Deep dive   │
└───────────────────────────────▲─────────────────────────────────────────────────┘
                                │ WebSocket: normalized PerzianEvent stream + commands
┌───────────────────────────────┴─────────────────────────────────────────────────┐
│  apps/daemon (Node/TS) — long-running, owns all state                            │
│                                                                                  │
│  SessionManager ── one ACP client connection per session                         │
│  WorktreeManager ─ git worktree add/remove per session                           │
│  EventStore ────── append-only log (JSONL → SQLite later), replay on reconnect   │
│  Normalizer ────── ACP updates + report tools → PerzianEvent                     │
│  Report MCP ────── report_progress / ask_decision / report_outcome               │
└───────┬───────────────────────┬───────────────────────┬─────────────────────────┘
        │ ACP (JSON-RPC/stdio)  │                       │
   claude-agent-acp        codex-acp            (future adapters)
        │                       │
   Claude Code SDK            Codex
```

## Packages

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared types: `SessionState`, `PerzianEvent`, decision/outcome schemas, WS command types. Single source of truth for UI ↔ daemon. |
| `packages/report-mcp` | Stdio MCP server injected into every agent session. Tools: `report_progress`, `ask_decision`, `report_outcome`. Forwards calls to the daemon. |
| `apps/daemon` | Session lifecycle, ACP clients, worktrees, event store, WS server. |
| `apps/web` | The UI. |

## Agent integration: ACP

[Agent Client Protocol](https://agentclientprotocol.com) — JSON-RPC over stdio between a client (us) and a
coding agent. Like LSP, for agents.

- SDK: `@agentclientprotocol/sdk`
- Claude Code adapter: `@agentclientprotocol/claude-agent-acp`
- Codex adapter: `@agentclientprotocol/codex-acp`

Per session the daemon:

1. Creates a worktree (optional) → `cwd`.
2. Spawns the adapter process, opens an ACP `ClientSideConnection`.
3. `initialize` → `session/new` with `cwd` and `mcpServers: [report-mcp]`.
4. Sends `session/prompt`; consumes `session/update` notifications (message chunks, tool calls, plans, diffs).
5. Handles `session/request_permission` → emits a `decision` event → waits for the UI's answer.
6. Implements client fs methods read-only-safe (agents write via their own tools; we observe).

## Structured reporting (the core trick)

Agents output English by default. We append a system instruction and inject `report-mcp` so agents
report **data**:

| Tool | Payload | UI renders as |
|---|---|---|
| `report_progress` | `{ phase, step, of, note? }` | progress ring on tile |
| `ask_decision` | `{ question, options: [{ id, label, tradeoff }], recommended? }` | decision card, blocks session |
| `report_outcome` | `{ intent, status, changed: [{path, kind}], proof: [...], risks: [...], followups: [...] }` | outcome card |

Fallback: if an agent skips the tools (weaker models), the daemon derives state from ACP signals
(tool calls, stop reasons, diffs) and can ask a cheap model to summarize the transcript.

## Session state machine

```
idle ─prompt→ working ─permission/ask_decision→ needs_you ─answer→ working
working ─end_turn→ done      working ─error→ failed      any ─cancel→ idle
```

`needs_you` is the attention queue. Ordering: `needs_you` (oldest first) → `failed` → `done` (unseen) → rest.

## Events

All UI state is a fold over `PerzianEvent`s (see `packages/protocol`). The daemon persists every event;
the UI reconnects and replays. This makes the "where was I" card a query over events since last-seen.

## Visual pipeline (Phase 3)

- `git diff` + tree-sitter → module/symbol/dependency graph of **the change**.
- Model picks the slice and labels it; never invents nodes.
- Render with React Flow + ELK. Code view with Shiki (read-only).

## Main agent (Phase 2)

A regular ACP session with a model picker, plus an orchestration MCP (`spawn_session`, `list_sessions`,
`send_to_session`, `get_outcome`) so it can run the crew.

## Platform

- Daemon: Node ≥ 22, TypeScript, npm workspaces.
- UI: browser at `http://localhost:4317` (reachable from phone via Tailscale). Desktop shell (Tauri/Electron) later.
