# Perzian

**Talk to one. Command them all.**

*Perzian* is pronounced like "Persian".

[perzian.dev](https://perzian.dev) · [live demo](https://perzian.dev/demo/)

Perzian is an open-source agentic development environment (ADE). You talk to one main agent, **Perzian**,
which runs a crew of coding sessions across projects and git worktrees, on whichever models you like. You see
what's happening at a glance:

- **Sessions list:** every session color-coded (working · needs you · done · failed · idle), ordered by attention
- **Main thread:** spawned sessions as live mini-tiles, outcome cards, and a needs-you dock of one-click decisions
- **Deep dive drawer:** outcome, live change map, read-only diff/file viewer, activity, full transcript

Each session can get its own git worktree, permission mode (ask · edits · plan · auto) and model. Sessions
resume after a daemon restart.

Perzian drives existing agents (Claude Code; Codex is experimental) over the
[Agent Client Protocol](https://agentclientprotocol.com). It's the surface around the agent, not another agent.

What works today: [FEATURES.md](FEATURES.md).

> Status: early. Core loop, main agent and desktop shell work. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Install

**From source** (recommended for now; no macOS warnings):

```bash
git clone https://github.com/adi-devv/perzian && cd perzian && npm install && npm run app
```

**Prebuilt macOS app** (Apple Silicon): download the zip from
[Releases](https://github.com/adi-devv/perzian/releases) (first release coming soon), unzip, and move Perzian to Applications.
The app isn't notarized yet, so macOS blocks the first launch ("can't be verified"). To open it:

1. Double-click Perzian, then click **Done** on the warning.
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Perzian.

Or, in a terminal: `xattr -dr com.apple.quarantine /Applications/Perzian.app`

You need [Claude Code](https://claude.com/claude-code) installed and signed in, or an Anthropic API key.
If it's missing, Perzian's first-run screen installs it for you.

## Develop

```bash
npm install
npm run app        # desktop app: builds the UI, launches Electron (starts the daemon if needed)
npm run app:dev    # desktop app against the Vite dev server
npm run dev        # browser: daemon + web
npm test           # unit tests
```

- Browser UI: http://localhost:4318 (try it without agents: http://localhost:4318/?demo)
- Daemon: http://127.0.0.1:4317. Both ports are fixed: if one is taken, the command stops and says so
  (set `PERZIAN_PORT` to move the daemon).
- npm 11 skips dependency install scripts unless allowed; `allowScripts` in `package.json` allows Electron's
  and esbuild's. If `npm run app` says Electron failed to install, delete `node_modules/electron` and run
  `npm install` again.
- State lives in `$PERZIAN_HOME` (default `~/.perzian`): event log, worktrees, main-agent folder.

Agents sign in the usual way (`claude auth login`, `codex login`), or add an Anthropic / OpenAI API key under
**Accounts & API keys**; keys are kept in the macOS Keychain and passed only to that agent's CLI.

Perzian runs the agent CLIs you already have: `claude` (Claude Code) and `codex` (Codex CLI), found on your PATH,
or set `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`. In a source checkout it falls back to the binaries npm installed.
`npm run dist` builds the macOS app (~116 MB download). It doesn't bundle the agent CLIs: if one is missing,
onboarding installs it with the official installer in one click.

## Required checks: `perzian.json`

Put a `perzian.json` at the repo root to name checks that must pass, next to the ones Perzian detects
(`npm test`, `pytest`, `cargo test`…):

```json
{
  "checks": [
    { "name": "unit", "run": "npm test" },
    { "name": "kodo tests", "run": "kodo test --all", "timeoutSec": 600 }
  ]
}
```

When an agent finishes, Perzian runs each `run` command itself in the session's worktree (default timeout 300 s)
and shows ✓/✕ with the real exit code in the session drawer. Failures go back to the agent to fix, up to 2 times;
then the session is marked failed for you to look at. Agents see the checks in their brief and can run exactly
these commands without a permission card. The file is read when a session starts; a malformed one shows an error
and its checks don't run.

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

[AGPL-3.0](LICENSE) © 2026 Aadit Singal. Contributions are accepted under the [CLA](CLA.md), so the project can also be offered under other terms (e.g. a commercial license).
