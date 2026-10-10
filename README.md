# Perzian

**Manage coding agents by looking, not reading.**

Perzian is an open-source agentic development environment (ADE). You run many agent sessions across
projects and worktrees, on whichever models you like, and see what's happening at a glance:

- **Control tower:** every session as a color-coded tile (working · needs you · done · failed · idle)
- **Needs-you queue:** decisions and permission prompts as one-click cards, not paragraphs
- **Outcome cards:** what changed, proof it works, risks
- **Deep dive:** the full transcript and read-only code when you want them

Perzian drives existing agents (Claude Code first, Codex next) over the
[Agent Client Protocol](https://agentclientprotocol.com). It's the surface around the agent, not another agent.

> Status: early. Phase 1 (core loop) in progress. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

```bash
npm install
npm run dev
```

- UI: http://localhost:4318
- Daemon: http://127.0.0.1:4317
- Try the UI without agents: http://localhost:4318/?demo

Claude Code sessions need the usual Claude Code authentication on your machine.

## How it works

```
web (React) ⇄ WebSocket ⇄ daemon (Node) ⇄ ACP ⇄ claude-agent-acp / codex-acp
                                   ⇡
                     report-mcp (progress · decisions · outcomes)
```

Agents report structured data through a small MCP server, so the UI draws state instead of dumping prose.
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Why: [docs/VISION.md](docs/VISION.md)

## License

MIT
