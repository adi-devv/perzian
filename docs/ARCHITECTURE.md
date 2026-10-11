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
| `packages/report-mcp` | Stdio MCP server injected into every session. Worker tools: `report_progress`, `ask_decision`, `report_outcome`. `spawn_session` is for workers too (2 levels below the lead at most). Main-agent-only tools: `list_sessions`, `get_session`, `send_to_session`. Forwards calls to the daemon's `/report`. |
| `apps/daemon` | Session lifecycle, ACP clients, worktrees, change maps, event store, WS + HTTP on `:4317`. |
| `apps/web` | The UI. |
| `apps/desktop` | Electron shell. `main.js` reuses a running daemon on `:4317` or spawns one (`tsx apps/daemon/src/index.ts` with `ELECTRON_RUN_AS_NODE=1`), then loads `apps/web/dist` — or `PERZIAN_WEB_URL` in dev. |

## Agent integration: ACP

[Agent Client Protocol](https://agentclientprotocol.com) — JSON-RPC over stdio between a client (us) and a
coding agent. Adapters: `@agentclientprotocol/claude-agent-acp` (Claude Code), `@agentclientprotocol/codex-acp`
(Codex; wired but untested).

Per session the daemon:

1. Creates a worktree (every session in a repo, unless `worktree: false`): branch `perzian/<slug>-<id6>` at `$PERZIAN_HOME/worktrees/<repo>/<slug>-<id6>`,
   and records `baseSha` (HEAD at start). Then readies it (`setup.ts`): copies the checkout's gitignored `.env*` and
   local config files, runs the lockfile's install, and records progress in `SessionInfo.setup`. Prompts wait for
   it; a failure holds them until the developer picks Retry or Start anyway (`session.setup`).
2. Spawns the adapter, opens an ACP `ClientSideConnection`, `initialize`.
3. `session/new` with `cwd` and `mcpServers: [report-mcp]` — or `session/load` with the saved `acpSessionId`
   when the agent supports `loadSession`, so sessions resume after a daemon restart.
4. Applies the permission mode and model, reads the agent's available modes/models into `session.config`.
5. `session/prompt`; normalizes `session/update` (chunks, tool calls) into transcript events.
6. `session/request_permission` → the daemon's policy (`permissions.ts`) answers, or `decision.requested` →
   waits for the UI's answer.

**Permission modes** (`ask` · `edits` · `plan` · `auto`) map to each agent's own mode ids; first match wins.
For Claude, `edits` and `auto` run the agent in its asking mode and the daemon answers, so every request
passes through one policy:

| Request | Answer |
|---|---|
| perzian MCP tools | allowed |
| lead: edit/delete/move/execute | rejected, with a `Blocked: …` notice (no card) |
| lead: read/search | allowed |
| worker: destructive command (`rm -rf`, force push, `reset --hard`, `clean -f`, dropping a database…) | always a card, flagged `destructive`, no "always allow" option |
| worker: one plain check command (`npm test`, `npm run typecheck`, `tsc --noEmit`, `pytest`, `cargo test`, `go test`…; no `;` `&&` `\|` `$(` redirects) | allowed once |
| worker: exactly a `run` command declared in `perzian.json` (read at spawn) | allowed once |
| worker: edit/delete/move whose target resolves (symlinks, `..`) outside the session folder and its `extraDirs` | always a card in every mode, with the `outside` paths; reads outside stay allowed |
| worker in `edits`: edits and reads | allowed once |
| worker in `auto`: anything else | allowed once |
| otherwise | a card |
**Model picker** is per session, applied through the agent's model config option.

## Structured reporting

Agents get `REPORT_INSTRUCTIONS` and the report MCP so they report **data**:

| Tool | UI renders as |
|---|---|
| `report_progress { phase, step, of, note? }` | progress ring |
| `ask_decision { question, options, recommended? }` | decision card in the needs-you dock; blocks the session |
| `report_outcome { intent, status, changed, proof, risks, followups }` | outcome card |

**Derived outcomes:** if a worker's turn ends (`end_turn`) with file changes but no `report_outcome`, the daemon
builds one (`derived: true`) from the prompt and the session's git changes. Its status is `success` only when at least
one observed check ran and all passed, `partial` when one failed, and `unverified` ("Done · not verified") when none ran.

**Checks:** at spawn the daemon detects the project's check commands (`checks.ts`: package.json scripts
test/typecheck/lint/build with the lockfile's package manager, pytest/mypy/ruff, Cargo, go.mod, a Makefile
`test` target) into `SessionInfo.checks`, appends `Checks available: …` to the worker's first prompt, and
returns them from `list_sessions`/`get_session`. Later worker prompts get a one-line rules reminder
(`FOLLOWUP_REMINDER`).

**Declared checks:** a repo's `perzian.json` (`{ "checks": [{ name, run, timeoutSec? }] }`) is validated and read
once at spawn (worktree first, then the checkout) into `SessionInfo.declaredChecks`, or `checksError` when
malformed. The brief adds a `Required checks: …` line. When a worker turn ends (`end_turn`) having changed files
or reported an outcome, the daemon runs each check through the shell in the session's cwd (own process group,
timeout, output tail), publishes `SessionInfo.checkRun` as it goes, and merges the results into the outcome as
observed proof. Failures go back to the agent as a system prompt; after `MAX_FIX_ATTEMPTS` (2) rounds the session
is set `failed` with a notice. A fix round always re-runs the checks. Stop kills a running check.

## Change map

After each turn, and shortly after edit/delete/move/execute tool calls complete, the daemon runs `git.changes(cwd, baseSha)`: `git diff --name-status`
+ `--numstat` against `baseSha` plus untracked files → `session.changes` (`path`, `kind`, `+/-`). The UI draws
it as a change map; `/api/diff` and `/api/file` serve a per-file diff or content, read-only, confined to the
session's `cwd`. Note: a rename is only detected when both paths are tracked (e.g. `git mv`); a plain `mv`
shows as deleted + added.

## Observation

Agents are never restricted, but the daemon records what they do as events so the UI can replay it. Tool calls
and git state are observed (`observe.ts`, `SessionInfo` fields): `outsidePaths` (edits outside the folders),
`extraDirs` (extra folders, passed to Claude as `additionalDirectories`), `subagents` (Task/Agent calls; nested
tool items carry `parentToolCallId`), `background` (`run_in_background` or trailing `&`, with a `--port`/`:N`
port), `extraWorktrees` (worktrees the agent made itself, found with `git worktree list --porcelain` after
execute calls and turns), `git` (`ahead`, `pushed`, `prUrl` from `gh pr view`, at most once a minute, failures
ignored). After a branch switch or rebase that drops `baseSha` from HEAD, the base is recomputed with merge-base
against the original base branch. Merging removes the session's worktree (no `--force`) but keeps the branch
(`ShipState.worktreeRemoved`); `GET /api/worktrees/leftover` lists worktree folders under `$PERZIAN_HOME/worktrees`
with no live session. The global default permission mode is the `settings.setDefaultMode` command and
`settings.defaultMode` event (`State.settings.defaultMode`, default `ask`); sessions created without a mode use it.

## Main agent "Perzian"

A session with `role: "main"`, started by `main.start`, running in `$PERZIAN_HOME/main` with
`MAIN_INSTRUCTIONS`. It delegates through the orchestration tools; spawned sessions carry `parentId` and
appear in its thread as `spawn` transcript items. It always runs in Ask mode and can't edit or run commands
(see the policy above).

**Child-finished updates** (`notify.ts`): when a turn the lead started (spawn or `send_to_session`) ends
done/failed, the daemon batches it with others finishing within ~1.5 s and, once the lead is between turns,
prompts the lead with one machine-readable line per child (`id`, `title`, `status`, `outcome`, observed
`proof`, `files`, `intent`). These are `user` transcript items with `system: true`, drawn as a notice, not a
developer bubble. Turns the developer drove in a child aren't reported, and after 6 automatic lead turns
without a developer message, updates pause until the developer speaks.

## Session state machine

```
idle ─prompt→ working ─permission/ask_decision→ needs_you ─answer→ working
working ─end_turn→ done      working ─error→ failed      any ─cancel→ idle
working ─usage limit (or worker ≥95%, after the current tool)→ paused ─reset/Resume now/prompt→ working
```

Attention order (`byAttention`): `needs_you` → `failed` → `done` → `working` → `paused` → `idle`; most recently
updated first within a status. `isUnseen`: done/failed and updated since last `session.seen`.

**Usage limits** (`limits.ts`, `resume.ts`): a limit hit (Claude's `_claude/rateLimit` usage info, its "You've hit
your … · resets …" text, or a rate-limit error) emits `session.paused { resumeAt }` instead of failing. The event
store is the resume queue: `ResumeQueue` rebuilds from state on start, polls the wall clock (timers stall in sleep),
and at `resumeAt` + jitter sends a short system "continue" prompt to the same session. `session.resumed` clears it.
The lead gets paused/resumed lines through the same batched updates as finished children.

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
