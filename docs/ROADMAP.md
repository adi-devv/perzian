# Perzian — Roadmap

## Phase 0 — Mockup
- [ ] Clickable mockup: control tower, decision card, outcome card, main agent chat. Lock the UI language.

## Phase 1 — Core (Claude Code via ACP)
- [x] Repo, docs, monorepo scaffold
- [x] `packages/protocol` event + state types
- [x] `packages/report-mcp` skeleton
- [x] Daemon: ACP session spawn, event normalization, WS server
- [ ] Daemon: worktree per session
- [ ] Daemon: persistent event store + replay
- [ ] Web: control tower tiles + attention queue (live)
- [ ] Web: decision cards (permissions + `ask_decision`)
- [ ] Web: transcript deep dive

## Phase 2 — Main agent
- [ ] Main agent session with model picker
- [ ] Orchestration MCP: spawn / list / message / get_outcome
- [ ] Main agent summarizes into decisions

## Phase 3 — Visuals
- [ ] Change map: git diff + tree-sitter → React Flow + ELK
- [ ] Outcome cards with proof (tests, screenshots)
- [ ] Read-only code view (Shiki)

## Phase 4 — Multi-model
- [ ] Codex adapter
- [ ] Per-session agent/model picker
- [ ] Transcript-summary fallback for agents that skip report tools

## Phase 5 — Polish
- [ ] Semantic zoom: system → module → file → function
- [ ] "Where was I" cards
- [ ] Phone access
- [ ] Desktop shell
- [ ] Import existing Claude Code sessions from `~/.claude/projects`
