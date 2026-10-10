# Perzian — Roadmap

## Phase 0 — Mockup
- [ ] Clickable mockup: control tower, decision card, outcome card, main agent chat. Lock the UI language.

## Phase 1 — Core (Claude Code via ACP)
- [x] Repo, docs, monorepo scaffold
- [x] `packages/protocol` event + state types, shared fold
- [x] `packages/report-mcp`: progress / decisions / outcomes
- [x] Daemon: ACP session spawn, event normalization, WS server
- [x] Daemon: worktree per session (`perzian/<slug>-<id6>`)
- [x] Daemon: persistent event store + replay
- [x] Daemon: session resume via ACP `loadSession` after restart
- [x] Web: sessions list + attention ordering (live)
- [x] Web: decision cards (permissions + `ask_decision`) in the needs-you dock
- [x] Web: transcript deep dive
- [x] Unit tests (`npm test`): protocol fold, git helpers

## Phase 2 — Main agent
- [x] Main agent "Perzian" session with model picker
- [x] Orchestration MCP: `list_sessions` / `get_session` / `spawn_session` / `send_to_session`
- [x] Main thread of live cards (spawned mini-tiles, outcomes)
- [x] Permission modes: ask / edits / plan / auto
- [ ] Main agent summarizes crew state into decisions

## Phase 3 — Visuals
- [x] Change map data: git diff vs `baseSha` (+ untracked), live
- [x] Read-only diff / file viewer
- [ ] Change map graph: tree-sitter → React Flow + ELK
- [ ] Outcome cards with proof (tests, screenshots)
- [ ] Syntax-highlighted code view (Shiki)

## Phase 4 — Multi-model
- [x] Codex adapter wired (`@agentclientprotocol/codex-acp`)
- [ ] Codex adapter tested end to end
- [x] Per-session agent/model picker
- [x] Derived outcomes when agents skip `report_outcome`
- [ ] Transcript-summary fallback (cheap model) for richer derived outcomes

## Phase 5 — Polish
- [x] Desktop shell (Electron, `apps/desktop`)
- [ ] Semantic zoom: system → module → file → function
- [ ] "Where was I" cards
- [ ] Phone access
- [ ] Desktop packaging (signed builds, bundled daemon)
- [ ] Import existing Claude Code sessions from `~/.claude/projects`
