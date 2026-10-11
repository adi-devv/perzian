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
   cut from a base branch (`base` on `spawn_session` / `CreateSessionArgs`, default the repo's default branch; `GET /api/branches` feeds the picker):
   `resolveBase` runs `git fetch origin <base>` (only `origin/<base>` moves, never the developer's checkout) and cuts from `origin/<base>`;
   offline, a missing remote ref or no origin falls back to the local branch (or the last-fetched `origin/<base>`) and posts a notice on the session.
   `base` may be another session's `perzian/…` branch (stacking): used as the local branch, never fetched; the tile shows "on <parent title>".
   Records `baseSha` (the commit it started from) and `baseBranch`. Then readies it (`setup.ts`): copies the checkout's gitignored `.env*` and
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
execute calls and turns), `git` (`ahead`, `pushed`, `prUrl`, plus `behind` and `pr`, below).
`GitState.behind` is how far the base moved: commits on `origin/<base>` (or the parent session's local branch) that HEAD lacks.
It is re-read after every observed turn; `origin/<base>` is fetched at most every 2 minutes. The header's "Base moved · N behind"
has an Update button: `session.updateBase` prompts the agent to fetch and merge or rebase the base, so conflicts are the agent's.
`GitState.pr` (`PrStatus`) folds `gh pr view <branch> --json url,state,mergeable,statusCheckRollup,reviewDecision` (`prstatus.ts`):
state open/merged/closed, checks passing/failing/pending/none with the failing names, review decision, conflicts. Read at most once a
minute, after an agent push or Open PR, and by a timer while the PR is open; merged and closed stop it; gh failures change nothing.
The detail's "Ask agent to fix CI" is `session.fixCi`: a prompt with the failing check names and `gh run view --log-failed`. After a branch switch or rebase that drops `baseSha` from HEAD, the base is recomputed with merge-base
against the original base branch. Merging removes the session's worktree (no `--force`) but keeps the branch
(`ShipState.worktreeRemoved`); `GET /api/worktrees/leftover` lists worktree folders under `$PERZIAN_HOME/worktrees`
with no live session. The global default permission mode is the `settings.setDefaultMode` command and
`settings.defaultMode` event (`State.settings.defaultMode`, default `ask`); sessions created without a mode use it.

The welcome splash's "Show on startup" is `settings.splash` (command `settings.setSplash`, default on). Its "Connect GitHub"
is `GET/POST/DELETE /api/github/login` (`ghlogin.ts`): the daemon runs `gh auth login --web --hostname github.com
--git-protocol https`, parses the one-time code and URL from its output, and the UI polls until gh exits; gh keeps the token.

## Main agent "Perzian"

A session with `role: "main"`, started by `main.start`, running in the empty `$PERZIAN_HOME/lead` (leads made
earlier in `$PERZIAN_HOME/main` keep working) with `MAIN_INSTRUCTIONS` plus a brief of the known projects
(`State.settings.projects` and worker projects, names and paths). It has no project of its own: `ask_project { reason }`
(lead-only report-mcp tool) raises a `Decision` with `source: "ask_project"` ("Which project?", recent projects as options,
the reason as `detail`); `decision.answer` carries a folder path (option id or free path from the picker / typed), `lead.ts`
checks it exists, emits `settings.projectAdded` and returns the absolute path to the lead. `spawn_session` from the lead
errors without a usable project (empty, missing, or its own folder) and tells it to call `ask_project`. After a restart an
open `ask_project` card is closed like any decision (`boot.ts`), and Retry makes the lead ask again. It delegates through the orchestration tools; spawned sessions carry `parentId` and
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

**Usage card and shared limit** (`usagecard.ts`): all Claude sessions share one plan limit, so nearing it (PERZIAN_PAUSE_AT,
default 95%) is one account-level question, not per-session pauses. The first near reading per window + reset emits
`usage.card` (the lead can raise it, but is never paused by it); the answer is `usage.answered` (command `usage.answer`).
Workers keep running while it is open; Pause stops every working Claude worker after its current step with one shared
`resumeAt`, Keep going means no early pause for that window (the real limit still pauses and auto-resumes), and no answer
within 2 minutes counts as Pause. `settings.usageCard` (`ask | keep_going | pause`, "Don't ask again") skips the card.
`_claude/rateLimit` overage fields (`isUsingOverage`, `overageStatus`) set `card.overage`: "keeping going may cost money".
When a session is refused at the hard limit, every other working Claude worker pauses at once with the same `resumeAt`.
Leftover worktrees are removed with a plain `worktree remove` (`POST /api/worktrees/remove`): refused when dirty, branches kept.

## Events

All UI state is a fold over `PerzianEvent`s (`packages/protocol/src/fold.ts`, shared by daemon and UI). The
daemon appends every event to the store and sends a snapshot on connect, then live events.

## Phone access (opt-in, off by default)

`apps/daemon/src/phone.ts` runs a SEPARATE listener (127.0.0.1:4319) only while Phone access is on. The main
listener trusts loopback and "no Origin"; anything arriving through a proxy would inherit that, so the phone
listener has no such tier: every request but the static shell and `/pair` needs a device token, Host and Origin
must be on a one-name allowlist, no CORS, and the API is an allowlist (ping, `/api/push/*`, four commands).
Pairing codes are in-memory, 2 min, single use, with a global lockout after repeated misses. Device tokens are
stored as SHA-256 hashes (`phones.json`, 0600).

Two ways in, same listener, same tokens:
- **Tailscale:** `tailscale serve` proxies `https://<mac>.<tailnet>.ts.net:8443`; the allowlist is that MagicDNS name.
- **No setup:** `tunnel.ts` runs the user's own `cloudflared tunnel --url http://127.0.0.1:4319` (never downloaded or
  bundled; missing shows `brew install cloudflared`), parses the `https://*.trycloudflare.com` URL from its log and
  adds that one name to the allowlist (it starts empty, so nothing is served before the tunnel exists). The URL is
  public and changes every run, so every run needs a fresh QR; paired devices keep their tokens. The tunnel dies
  with phone access or the daemon (`killTunnel` on exit). No uptime guarantee.

**Web Push** (`push.ts`): the daemon sends it itself with the `web-push` package and VAPID keys generated once
(`vapid.json`, 0600), straight to the browser vendor's push service. The PWA's service worker (`public/sw.js`)
subscribes after a tap on "Turn on notifications" (iOS: installed PWA only; the UI says "Add to Home Screen first"
otherwise) and posts the subscription to `/api/push/subscribe` with its device token. It is stored on that
device's record, so revoking a device deletes it; 404/410 from the push service drops it. Endpoints must be https on a
known push host (a stolen token can't aim the daemon elsewhere). A push goes out when a session becomes
needs-you, failed or done; a burst within 5 s is one notification. The payload is a status word and the session
title only (never code, diffs or agent text); tapping opens that session. Pushes are skipped while Phone access is
off and while the Mac UI reports itself focused (`ui.presence`, 10 s heartbeat, 30 s expiry; a phone can't send it).

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
