# Features

What Perzian does today. Upcoming work: [NEXT_STEPS.md](NEXT_STEPS.md). Why and how: [docs/VISION.md](docs/VISION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- ✅ shipped and tested
- ⚠️ built but not yet run for real (unit-tested or scripted only)

## Lead and crew
- ✅ One main agent (Perzian) you talk to; it starts, messages and checks on worker sessions through the report MCP.
- ✅ Spawned sessions show as live mini-tiles in the main thread, with outcome cards.
- ✅ The lead is told, in batches, when its sessions finish, pause or resume (with loop guards).
- ✅ Sessions list ordered by attention: working, needs you, done, failed, idle (color only for needs-you and failed).
- ✅ Crew status strip atop the lead view ("2 working · 1 needs you · 3 done since you left"), folded from session state; each count filters the sidebar.
- ✅ Import existing Claude Code sessions from `~/.claude` (read-only), then resume them.

## Sessions and worktrees
- ✅ Each session can get its own git worktree, permission mode (ask, edits, plan, auto) and model; sessions resume after a daemon restart.
- ✅ Claude Code over ACP; Codex is experimental.
- ⚠️ Ready worktrees: before the first message, copy gitignored `.env*`/`.npmrc` files and run the lockfile's install; shows "Setting up…" with Retry / Start anyway.

## Decisions and permissions
- ✅ Needs-you dock: permission asks and agent decisions as one-click cards.
- ✅ Subtle motion shows what changed: drawer slides, answered cards collapse, sidebar rows slide (FLIP), status dots cross-fade, expanders animate; off with reduced-motion.
- ✅ Destructive-command and permission rules enforced by the daemon (Claude); Codex is best-effort.

## Proof and checks
- ✅ Outcome cards with observed proof: the daemon records the tests, builds, typechecks and lints the agent really ran, with real exit codes.
- ✅ Change map by symbol (tree-sitter plus `git diff`), a read-only diff/file viewer, activity and full transcript in the drawer.
- ⚠️ Declared checks: `perzian.json` lists your own checks; the daemon runs them when an agent says it's done, sends failures back (2 rounds), and allows them without a card.
- ✅ "Run checks" in the session drawer reruns the declared and detected checks (running, then ✓/✕).

## Ship
- ⚠️ "Merge into <base>" or "Open PR" from the drawer; merges only what the agent changed (never `.env`/keys), asks first, removes the worktree.
- ⚠️ Merge conflicts are listed with "Ask the agent to resolve"; Open PR checks origin and `gh` auth first.

## Usage and limits
- ✅ Per-session usage and a running total spent across all sessions.
- ⚠️ Cost figures not yet checked against a real paid run.
- ⚠️ Usage limits: a worker near its limit finishes its step and pauses ("Paused · resumes 17:40"), then resumes itself at reset, also after a restart; "Resume now" in the drawer.

## Desktop app
- ✅ Electron shell starts the daemon and loads the UI; desktop notifications when a session needs you.
- ✅ First-run checks and one-click install for a missing agent CLI; API keys kept in the macOS Keychain.
- ✅ Easy start: first run is folder + task + Enter and shows only what is broken (one fix each); New session is folder + task, with name, agent, model, permissions and worktree behind "Options"; last folder remembered.
- ✅ Native "Choose folder…" picker (desktop) with the last 5 projects as one-click chips; typed path stays as the small fallback and the only option in the browser; picking jumps to the task box.
- ✅ Daemon only accepts the desktop app and the local UI (origin and token checks).
- ⚠️ Packaged macOS build (`npm run dist`, unsigned, Apple Silicon); no release published yet.

## Phone access (opt-in, off by default)
- ⚠️ "Open on phone" (sidebar): turns on a token-gated listener and `tailscale serve` (https://<mac>.<tailnet>.ts.net:8443), shows a QR with a one-time code (2 min, single use). Missing or logged-out Tailscale shows install/sign-in steps instead.
- ⚠️ The phone pairs once, keeps a device token in localStorage (stored hashed on the Mac); "Forget all phones" revokes every token and cuts live connections.
- ⚠️ Under 600px the UI is just the attention queue, answerable decision cards and compact session tiles; installable as a PWA. A phone can answer, stop and resume, nothing else.
- Not yet tried with a real phone and tailnet (unit-tested over real sockets only).

## Site/demo
- ✅ Site at perzian.dev (`apps/site`) and a live demo at perzian.dev/demo.
- ✅ Site feature cards for declared checks ("Your checks run every time") and usage-limit resume ("Hit your limit at 2 am?").
- ✅ Site mockups follow the calm color rule: amber only for needs-you, red only for failed, everything else grey.
- ✅ Try the UI without agents: `http://localhost:4318/?demo`.
