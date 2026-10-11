# Features

What Perzian does today. Upcoming work: [NEXT_STEPS.md](NEXT_STEPS.md). Why and how: [docs/VISION.md](docs/VISION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- ✅ shipped and tested
- ⚠️ built but not yet run for real (unit-tested or scripted only)

## Lead and crew
- ✅ One main agent (Perzian) you talk to; it starts, messages and checks on worker sessions through the report MCP.
- ✅ Each spawned session is one line in the chat (dot color and a short state, updating in place); the finish notice to the lead is never shown.
- ✅ The lead is told, in batches, when its sessions finish, pause or resume (with loop guards).
- ✅ Sessions list ordered by attention: working, needs you, done, failed, idle (small status marks carry color: blue working, amber needs you, red failed, green check done, hollow grey paused).
- ✅ Crew column: one live tile per session grouped by project, urgency-sorted (needs you, failed, working, done), with a summary line ("2 need you · 1 failed · 3 working"); decisions are answerable on the tile, and the order holds still while the pointer is over it.
- ✅ Import existing Claude Code sessions from `~/.claude` (read-only), then resume them.

## Sessions and worktrees
- ✅ Each session gets its own git worktree by default, even a single task (`worktree: false` opts out), plus a permission mode (ask, edits, plan, auto) and model; sessions resume after a daemon restart.
- ✅ Claude Code over ACP; Codex is experimental.
- ✅ Ready worktrees: before the first message, copy gitignored `.env*`/`.npmrc` files and run the lockfile's install (npm ci, falling back to npm install with the committed lockfile kept); shows "Setting up…" with Retry / Start anyway.

## Decisions and permissions
- ✅ Permission asks and agent decisions are one-click cards on the session tile (keys 1-9 answer the top one); phones get a queue.
- ✅ Subtle motion shows what changed: answered cards collapse, crew tiles slide (FLIP), status dots cross-fade, expanders animate; off with reduced-motion.
- ✅ Destructive-command and permission rules enforced by the daemon (Claude); Codex is best-effort.
- ✅ Each closed card leaves one transcript line with the answer; with the composer empty, 1-9 still answer.
- ✅ A daemon restart mid-turn, mid-decision, mid-ship or mid-setup marks the session Interrupted (counts as needs you, Retry on the tile); open cards close with "not answered" since the agent's waiting call died with it.

## Proof and checks
- ✅ Outcome cards with observed proof: the daemon records the tests, builds, typechecks and lints the agent really ran, with real exit codes.
- ✅ Honest derived outcomes: when an agent doesn't report, "success" only if checks ran and passed; otherwise "Done · not verified" (fake eval 15/15).
- ✅ Change map by symbol (tree-sitter plus `git diff`), a read-only diff/file viewer, activity and a grouped transcript in the session detail view.
- ⚠️ Map: a squarified treemap of the repo's real files (git, sized by bytes), shaded by how much this project's sessions changed each region; each active session is a dot on the file it last edited (click opens it), hover shows path and who touched it, click a folder to zoom (breadcrumb back). Small files fold into "+N" cells and drawing is capped, so big repos stay smooth.
- ✅ Declared checks: `perzian.json` lists your own checks; the daemon runs them when an agent says it's done, sends failures back (2 rounds), and allows them without a card. A broken `perzian.json` is named in the Checks tab.
- ✅ Custom setup steps: `perzian.json` `"setup": [{name, run, timeoutSec?}]` run after the built-in worktree setup; a failure offers Retry / Start anyway.
- ✅ The Mac stays awake (`caffeinate`) while any session is working or needs you. The lead's pending "session finished" updates survive a daemon restart. `kill <pid>` / `pkill` / kill-by-port marks a background process ended.
- ✅ "Run checks" in the session detail reruns the declared and detected checks (running, then ✓/✕).

## Ship
- ✅ "Open PR" leads when the repo has a GitHub origin, otherwise "Merge into <base>" does; `"ship": "pr" | "merge"` in `perzian.json` overrides.
- ✅ "Merge into <base>" from the session detail; merges only what the agent changed (never `.env`/keys), asks first (and warns when required checks fail), removes the worktree.
- ✅ Merge conflicts are listed with "Ask the agent to resolve"; a dirty checkout is refused with one plain line.
- ✅ Accounts shows "Connected as <user>" for the project's origin host (read-only `gh auth status`, cached) or a copyable `gh auth login`; never blocks local use. Accounts also lists leftover worktrees (path, branch, age) with a Remove button (a plain worktree remove: refuses with uncommitted changes, never deletes the branch); New session has an "Also edit" field for extra folders.
- ⚠️ "Open PR": checks origin and `gh` auth before pushing (a non-GitHub origin stops there, tried for real); the push and `gh pr create` haven't run against a real repo.

## Usage and limits
- ✅ Per-session usage and a running total spent across all sessions.
- ⚠️ Cost figures not yet checked against a real paid run.
- ✅ Usage limits: a worker near its limit finishes its step and pauses ("Paused · resumes 17:40"); the pause survives a daemon restart (seen for real at 98% of the 5-hour window).
- ✅ One account-level usage card ("Usage 95% · resets 10:15 pm", Pause sessions / Keep going; keys 1 and 2) per window instead of per-session early pauses. No answer in 2 minutes pauses; "Don't ask again" is a saved setting; a warning shows when extra (paid) usage is on. When any session is refused at the hard limit, the other working Claude sessions pause too (shared account limit).
- ⚠️ It then resumes itself at reset, also after a restart; "Resume now" in the session detail (not yet seen at a real reset).

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
- ✅ Phone inbox: the first screen lists everything that needs you across sessions (asks, permission cards, failed sessions, merge conflicts), most urgent then oldest, answerable in place; answered cards collapse out; "Nothing needs you" with crew counts below. Tap or swipe a card left to open a compact session view (back gesture returns). Offline shows "Reconnecting…" and disables answers; the daemon refuses an answer to an already-resolved card.
- Not yet tried with a real phone and tailnet (unit-tested over real sockets only).

## Site/demo
- ✅ Site at perzian.dev (`apps/site`) and a live demo at perzian.dev/demo.
- ✅ Site feature cards for declared checks ("Your checks run every time") and usage-limit resume ("Hit your limit at 2 am?").
- ✅ Site mockups follow the calm color rule: amber only for needs-you, red only for failed, everything else grey.
- ✅ Try the UI without agents: `http://localhost:4318/?demo`.
