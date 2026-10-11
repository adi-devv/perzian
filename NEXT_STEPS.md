# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Now
1. **Try the Mac app** (`npm run app`) and note what breaks or feels off.
2. **Publish v0.0.1 as a GitHub Release.** `npm run dist`, upload the ~116 MB zip, link it from the README and site.
3. **www.perzian.dev HTTPS.** DNS is correct but the Pages certificate covers only `perzian.dev`.
   Fix: Settings → Pages → Custom domain → `www.perzian.dev` → Save, wait for HTTPS, then switch back to `perzian.dev` if preferred.

## Features
0. **Ready worktrees (do first).** Before the agent's first message: copy `.env*` and other local-only files from the
   checkout, run the install for the lockfile (npm/pnpm/yarn/bun, uv…), show "Setting up…", Retry on failure.
   Later: per-repo custom setup steps. Without this, first test runs fail in fresh worktrees.
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
   "Ask the agent to resolve", worktree removed after a merge. Unit-tested on temp repos; not yet run from the app on a real project.
2. **Crew summary.** Ask the lead "what's going on?" and get a short digest of what's done, blocked and needs you,
   built from `list_sessions` and outcomes (roadmap: "Main agent summarizes crew state into decisions").
3. **Calm visuals, follow-through.** The app now keeps color only for needs you (amber) and failed (red).
   Apply the same rule to the site's feature mockups (`apps/site`), and review the app with real sessions for leftover noise.
4. **Runs through usage limits.** Watch each agent's plan usage (5-hour and weekly windows). As a limit nears, finish the
   current step cleanly, then pause instead of failing. When the limit resets, resume by itself: same sessions, same
   worktrees, no new prompt needed. Show it plainly: "Paused · resumes 3:40 pm" on the session.
   Needs: detect limit errors and reset times from the adapter (Claude reports rate-limit info; Codex TBD), a persisted
   resume queue in the daemon (survives restarts), and the lead told what was paused and what resumed.
   **Marketing:** "Hit your limit at 2 am? Perzian picks up when it resets." Lead with it on the site as a feature card.
5. **Phone access (after trying the Mac app).** QR code + one-time pairing token opens the UI on your phone,
   on the same Wi-Fi or through Tailscale. Mainly for answering decision cards. Needs token auth on the daemon.

## Brand
- **Logo.** Direction: "one center, many orbits": a core (the lead) with a ring and two or three small satellites (the agents).
  Monochrome, Persian-blue core. Must read at 16px (tab icon, menu bar) and as the app icon. Replace `assets/mark.svg` + app icon.
- **Thinking animation from the logo** (like Claude's spark): satellites orbit the core while the lead works; one satellite
  per active session. Use it for the lead's "working" state instead of the generic spinner, and on the site hero.

## From competitors (Conductor, Vibe Kanban, Cursor, Zed)
- **PR + CI status on the session** after "Open PR": checks passing/failing, merged.
- **Run the app from a session:** start its dev server on its own port to try the change before merging.
- **Checkpoints:** roll a session back to before a given turn.
- **Sessions from issues:** pick a GitHub/Linear issue; it becomes the brief.
- **Comment on a diff line:** goes to the agent as the next task (code view stays read-only).
- **GitHub connect, not login:** first-run check shows "Connected as <user>" via `gh`, or how to run `gh auth login`.

## Known gaps
- Destructive-command cards aren't guaranteed for Codex: its own auto mode runs commands without asking.
- Pending "session finished" updates for the lead are in memory; a daemon restart drops them.
- In edits mode a worker could change a test script and run it without a card (edits are already trusted there).
- Cost per session hasn't been checked against a real paid run yet; Codex may report only context.

## Later
- Codex end-to-end test (needs an OpenAI account), notarized builds + auto-update ($99 Apple account),
  Linux/Windows builds, team/cloud layer.
