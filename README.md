# Perzian

**Manage coding agents by looking, not reading.**

Perzian is an open-source agentic development environment (ADE). You talk to one main agent, **Perzian**,
which runs a crew of coding sessions across projects and git worktrees, on whichever models you like. You see
what's happening at a glance:

- **Sessions list:** every session color-coded (working · needs you · done · failed · idle), ordered by attention
- **Main thread:** spawned sessions as live mini-tiles, outcome cards, and a needs-you dock of one-click decisions
- **Deep dive drawer:** outcome, live change map, read-only diff/file viewer, activity, full transcript

Each session can get its own git worktree, permission mode (ask · edits · plan · auto) and model. Sessions
resume after a daemon restart.

Perzian drives existing agents (Claude Code; Codex wired, untested) over the
[Agent Client Protocol](https://agentclientprotocol.com). It's the surface around the agent, not another agent.

> Status: early. Core loop, main agent and desktop shell work. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

```bash
npm install
npm run app        # desktop app: builds the UI, launches Electron (starts the daemon if needed)
npm run app:dev    # desktop app against the Vite dev server
npm run dev        # browser: daemon + web
npm test           # unit tests
```

- Browser UI: http://localhost:4318 (try it without agents: http://localhost:4318/?demo)
- Daemon: http://127.0.0.1:4317
- State lives in `$PERZIAN_HOME` (default `~/.perzian`): event log, worktrees, main-agent folder.

Claude Code sessions need the usual Claude Code authentication on your machine.

## How it works

```
desktop/web (React) ⇄ WebSocket ⇄ daemon (Node) ⇄ ACP ⇄ claude-agent-acp / codex-acp
                                        ⇡
              report-mcp (progress · decisions · outcomes · orchestration)
```

Agents report structured data through a small MCP server, so the UI draws state instead of dumping prose.
The change map comes from `git diff` against the session's starting commit.
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Why: [docs/VISION.md](docs/VISION.md)

## Author

Created by **Aadit Singal** ([@adi-devv](https://github.com/adi-devv)).

## License

MIT © 2026 Aadit Singal
