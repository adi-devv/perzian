# Perzian — Architecture

## Overview

```
┌──────────────────────── apps/desktop (Electron) or a browser ─────────────────────────┐
│  apps/web (React + Vite)                                                               │
│  Sessions list · Main-agent thread (live cards) · Needs-you dock · Deep-dive drawer    │
└───────────────────────────────▲───────────────────────────────────────────────────────┘
                                │ WebSocket: PerzianEvent stream + commands
                                │ HTTP: /api/diff, /api/file (read-only)
┌───────────────────────────────┴───────────────────────────────────────────────────────┐
│  apps/daemon (Node/TS) — long-running, owns all state                                  │
│                                                                                        │
│  AgentSession ──── one ACP connection per session (spawn, resume, mode, model)         │
│  git.ts ────────── worktree per session, change map + diffs vs baseSha                 │
│  EventStore ────── append-only $PERZIAN_HOME/events.jsonl, replayed on boot/reconnect  │
│  POST /report ──── report-mcp calls → PerzianEvents / orchestration actions            │
└───────┬──────────────────────────┬────────────────────────────────────────────────────┘
        │ ACP (JSON-RPC/stdio)     │
   claude-agent-acp            codex-acp (wired, untested)
```

## Packages

| Path | Purpose |
|---|---|
| `packages/protocol` | Shared types (`SessionInfo`, `PerzianEvent`, `Command`, `ReportCall`), the pure `reduce`/`fold` in `fold.ts`, `byAttention`, agent instructions. Single source of truth for UI ↔ daemon. |
| `packages/report-mcp` | Stdio MCP server injected into every session. Worker tools: `report_progress`, `ask_decision`, `report_outcome`. Main-agent tools: `list_sessions`, `get_session`, `spawn_session`, `send_to_session`. Forwards calls to the daemon's `/report`. |
| `apps/daemon` | Session lifecycle, ACP clients, worktrees, change maps, event store, WS + HTTP on `:4317`. |
| `apps/web` | The UI. |
| `apps/desktop` | Electron shell. `main.js` reuses a running daemon on `:4317` or spawns one (`tsx apps/daemon/src/index.ts` with `ELECTRON_RUN_AS_NODE=1`), then loads `apps/web/dist` — or `PERZIAN_WEB_URL` in dev. |

## Agent integration: ACP

[Agent Client Protocol](https://agentclientprotocol.com) — JSON-RPC over stdio between a client (us) and a
coding agent. Adapters: `@agentclientprotocol/claude-agent-acp` (Claude Code), `@agentclientprotocol/codex-acp`
(Codex; wired but untested).

Per session the daemon:

1. Optionally creates a worktree: branch `perzian/<slug>-<id6>` at `$PERZIAN_HOME/worktrees/<repo>/<slug>-<id6>`,
   and records `baseSha` (HEAD at start).
2. Spawns the adapter, opens an ACP `ClientSideConnection`, `initialize`.
3. `session/new` with `cwd` and `mcpServers: [report-mcp]` — or `session/load` with the saved `acpSessionId`
   when the agent supports `loadSession`, so sessions resume after a daemon restart.
4. Applies the permission mode and model, reads the agent's available modes/models into `session.config`.
5. `session/prompt`; normalizes `session/update` (chunks, tool calls) into transcript events.
6. `session/request_permission` → `decision.requested` → waits for the UI's answer.

**Permission modes** (`ask` · `edits` · `plan` · `auto`) map to each agent's own mode ids; first match wins.
**Model picker** is per session, applied through the agent's model config option.

## Structured reporting

Agents get `REPORT_INSTRUCTIONS` and the report MCP so they report **data**:

| Tool | UI renders as |
|---|---|
| `report_progress { phase, step, of, note? }` | progress ring |
| `ask_decision { question, options, recommended? }` | decision card in the needs-you dock; blocks the session |
| `report_outcome { intent, status, changed, proof, risks, followups }` | outcome card |

**Derived outcomes:** if a worker's turn ends (`end_turn`) with file changes but no `report_outcome`, the daemon
builds one (`derived: true`) from the prompt and the session's git changes.

## Change map

After each turn, and shortly after edit/delete/move/execute tool calls complete, the daemon runs `git.changes(cwd, baseSha)`: `git diff --name-status`
+ `--numstat` against `baseSha` plus untracked files → `session.changes` (`path`, `kind`, `+/-`). The UI draws
it as a change map; `/api/diff` and `/api/file` serve a per-file diff or content, read-only, confined to the
session's `cwd`. Note: a rename is only detected when both paths are tracked (e.g. `git mv`); a plain `mv`
shows as deleted + added.

## Main agent "Perzian"

A session with `role: "main"`, started by `main.start`, running in `$PERZIAN_HOME/main` with
`MAIN_INSTRUCTIONS`. It delegates through the orchestration tools; spawned sessions carry `parentId` and
appear in its thread as `spawn` transcript items.

## Session state machine

```
idle ─prompt→ working ─permission/ask_decision→ needs_you ─answer→ working
working ─end_turn→ done      working ─error→ failed      any ─cancel→ idle
```

Attention order (`byAttention`): `needs_you` → `failed` → `done` → `working` → `idle`; most recently updated
first within a status. `isUnseen`: done/failed and updated since last `session.seen`.

## Events

All UI state is a fold over `PerzianEvent`s (`packages/protocol/src/fold.ts`, shared by daemon and UI). The
daemon appends every event to the store and sends a snapshot on connect, then live events.

## UI layout

- **Left:** sessions list, ordered by attention, color-coded status.
- **Center:** the main-agent thread as live cards — spawned sessions as live mini-tiles, outcome cards, and a
  **needs-you dock** above the composer.
- **Right drawer (deep dive):** outcome, change map, read-only diff/file viewer, activity strip, transcript.

## Visual pipeline (next)

- tree-sitter over the change → module/symbol/dependency graph; model picks the slice and labels it,
  never invents nodes. React Flow + ELK; Shiki for the read-only code view.

## Platform

- Node ≥ 22, TypeScript strict, ESM, npm workspaces. Tests: `node:test` via `npm test`.
- Desktop: `npm run app` (builds web, launches Electron) · `npm run app:dev` (Vite + Electron).
- Browser: `npm run dev` → UI on `:4318`, daemon on `:4317`.
