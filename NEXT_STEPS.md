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
