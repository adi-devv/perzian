# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Now
1. **Try the Mac app** (`npm run app`) and note what breaks or feels off.
2. **Publish v0.0.1 as a GitHub Release.** `npm run dist`, upload the ~116 MB zip, link it from the README and site.
3. **www.perzian.dev HTTPS.** DNS is correct but the Pages certificate covers only `perzian.dev`.
   Fix: Settings → Pages → Custom domain → `www.perzian.dev` → Save, wait for HTTPS, then switch back to `perzian.dev` if preferred.

## Features
0. **Ready worktrees.** Built: before the agent's first message a new worktree gets the checkout's gitignored `.env*`
   files (any depth, not node_modules/.git/nested repos) plus `.npmrc`/`.yarnrc(.yml)`/`.dev.vars`, then the lockfile's
   install (npm ci → npm install, pnpm/yarn frozen, bun, uv sync, poetry, requirements.txt only into an existing
   `.venv`/`venv`; a tool not on PATH is skipped and noted). The session shows "Setting up…"; on failure the error tail
   with Retry / Start anyway. State lives on `SessionInfo.setup`, so it replays. Unit-tested on temp repos with fake
   tools; not yet run from the app on a real project. Later: per-repo custom setup steps.
0b. **Declared checks, always run.** A per-repo `perzian.json` lists custom checks (e.g. a team test CLI) next to the
   auto-detected ones. The daemon runs them itself when an agent says it's done, records ✓/✕ with real exit codes,
   sends failures back to the agent to fix, and allows them without a permission card. Site card: "Your checks run every time."
   Built: `perzian.json` is validated (clear error in the drawer and transcript), read once at spawn, named in the worker's
   brief and in `list_sessions`/`get_session`; after a worker turn that changed files or reported an outcome the daemon
   runs each check in the worktree (timeout, output tail), adds them to the outcome as observed proof, sends failures back
   (2 fix rounds, then the session fails: "needs you"), and allows exactly those commands without a card. Drawer shows
   ✓/✕ per check. Tested with temp repos and a scripted fake ACP agent; not yet run with a real agent.
   Next: the site card; a "Run checks" button; ready worktrees will make first runs pass.
1. **Ship it: try it for real.** Built: "Merge into <base>" / "Open PR" in the session drawer, conflicts listed with
   "Ask the agent to resolve", worktree removed after a merge. Merge commits only what the agent changed (never `.env`/keys),
   asks once first; Open PR checks origin + `gh` auth before pushing; merged sessions are closed.
   Unit-tested on temp repos; not yet run from the app on a real project.
1b. **Branches for teams (in progress).** Teams don't ship straight to main, so:
   - **Base picker:** New session picks the base branch (default: repo default branch); the lead can pass `base` to workers.
   - **Fresh start:** fetch, then branch from `origin/<base>`; offline falls back to local with a note.
   - **PR is the default action;** Merge moves to a menu. No GitHub remote → Merge stays primary. `perzian.json` `"ship"` overrides.
   Next: **"Base moved"** (N behind, one-click Update by rebase/merge) and **stacking** (start from another session's
   branch, or an existing branch/PR).
2. **Crew summary (in progress).** Ask the lead "what's going on?" and get a short digest of what's done, blocked and needs you,
   built from `list_sessions` and outcomes (roadmap: "Main agent summarizes crew state into decisions").
3. **Calm visuals, follow-through.** The app now keeps color only for needs you (amber) and failed (red).
   Apply the same rule to the site's feature mockups (`apps/site`), and review the app with real sessions for leftover noise.
4. **Runs through usage limits.** Watch each agent's plan usage (5-hour and weekly windows). As a limit nears, finish the
   current step cleanly, then pause instead of failing. When the limit resets, resume by itself: same sessions, same
   worktrees, no new prompt needed. Show it plainly: "Paused · resumes 3:40 pm" on the session.
   Needs: detect limit errors and reset times from the adapter (Claude reports rate-limit info; Codex TBD), a persisted
   resume queue in the daemon (survives restarts), and the lead told what was paused and what resumed.
   Built: limit detection from Claude's `_claude/rateLimit` usage info, its "You've hit your … · resets 5:40pm
   (Asia/Calcutta)" text and its rate-limit errors (`limits.ts`: wall clock with IANA zone/UTC/GMT, dates, weekdays,
   epochs, ISO, "in 2 hours"); a worker at ≥95% (`PERZIAN_PAUSE_AT`) finishes its current tool then pauses; status
   `paused` with `pause.resumeAt` in the event store; `ResumeQueue` (`resume.ts`) polls the wall clock and sends a short
   "continue" to the same session/worktree at reset + jitter, also after a daemon restart; the lead gets batched
   paused/resumed lines; UI shows "Paused · resumes 17:40" (no new color) and "Resume now" in the drawer.
   Merged locally. Unverified: not yet run against a real Claude limit hit; Codex detection is best-effort from its error text and
   has no early pause (its usage snapshots aren't sent over ACP), TBD.
   **Marketing:** "Hit your limit at 2 am? Perzian picks up when it resets." Lead with it on the site as a feature card.
5. **Phone access (after trying the Mac app).** QR code + one-time pairing token opens the UI on your phone,
   on the same Wi-Fi or through Tailscale. Mainly for answering decision cards. Needs token auth on the daemon.

## Brand
- **Color:** Persian turquoise (`#3ec6cf` dark, `#0b7a84` light) with a little gold (`#e0b25a`). Blue/purple dropped (overused).
- **Logo (pick pending).** Orbit/fan mark dropped (overused); minimal marks too plain. Rich options on the design board:
  Simurgh in flight, Simurgh in a tile arch, illuminated feather, thirty birds. After the pick: replace `apps/site/assets/mark.svg`,
  app icon, favicon; switch site/app accent to turquoise. Needs a simplified 16px version.
- **Thinking animation from the logo** (like Claude's spark), for the lead's "working" state and the site hero. Design after the pick.

## From competitors (Conductor, Vibe Kanban, Cursor, Zed)
- **PR + CI status on the session** after "Open PR": checks passing/failing, merged. (In progress.)
- **Run the app from a session:** start its dev server on its own port to try the change before merging.
- **Checkpoints:** roll a session back to before a given turn.
- **Sessions from issues:** pick a GitHub/Linear issue; it becomes the brief.
- **Comment on a diff line:** goes to the agent as the next task (code view stays read-only).
- **GitHub connect, not login:** first-run check shows "Connected as <user>" via `gh`, or how to run `gh auth login`. (In progress.)

## Known gaps
- Destructive-command cards aren't guaranteed for Codex: its own auto mode runs commands without asking.
- Pending "session finished" updates for the lead are in memory; a daemon restart drops them.
- In edits mode a worker could change a test script and run it without a card (edits are already trusted there).
- Cost per session hasn't been checked against a real paid run yet; Codex may report only context.

## Later
- Codex end-to-end test (needs an OpenAI account), notarized builds + auto-update ($99 Apple account),
  Linux/Windows builds, team/cloud layer.
