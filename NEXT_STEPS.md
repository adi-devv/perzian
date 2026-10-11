# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md). What already works: [FEATURES.md](FEATURES.md).

## Now (no new features until these are done)
1. **Dev testing.** Drive the real app through scenarios a new dev would hit: first run, pick a folder, "add a login page",
   answer a decision card, a failing check, ship (merge and PR), a usage-limit pause, phone pairing. Note every confusing
   moment, extra click or wall of text, then fix in small batches.
2. **UI direction: crew + center is built; finish it.** Left: the crew (one live tile per session, grouped by project, urgency-sorted, answerable in place).
   Center: Perzian's chat, or one session's detail (Changes, Map, Checks, Transcript). Leftovers:
   - The Map is a simple directory-region view (regions grow with churn), not a treemap with agents as dots yet.
   - Decision inbox on the phone, and the old alternatives (subway-map timeline), are still open.
3. **Small eval set.** About 5 scripted tasks run against a real agent, scored on finished, checks passed, and an honest outcome.
4. **Try the Mac app** (`npm run app`) and **publish v0.0.1** as a GitHub Release (`npm run dist`, upload the zip, link it).

## Features
1. **Phone access, phase 2 (phase 1 is built, see FEATURES.md).** Try phase 1 on a real phone first (`Open on phone` in the sidebar).
   - Web Push: the daemon sends it itself (VAPID, straight to Apple/Google push, no servers of ours) when a session needs you, finishes or fails.
   - Keep the Mac awake while agents work.
   - Same Wi-Fi without Tailscale is a view-only fallback (no HTTPS, so no push).
   - **"No setup" mode:** bundle a Cloudflare quick tunnel so neither device installs anything; HTTPS, so push works; $0 to us;
     the pairing token is the only gate and quick tunnels have no uptime guarantee. About 1-2 days.
   - Later, if people want zero setup with guarantees: our own Cloudflare Durable Objects relay with end-to-end encryption,
     about $5-30/month per 1k active users, possibly paid. Firebase rejected (data at Google, per-event cost).
2. **Branches for teams (in progress).** Teams don't ship straight to main. Next: base picker on New session (lead can pass `base`),
   fetch and branch from `origin/<base>` (offline falls back to local with a note), PR as the default action with Merge in a menu
   (`perzian.json` `"ship"` overrides), then "Base moved" (N behind, one-click update) and stacking on another session's branch.
3. **Calm visuals, follow-through.** Review the app with real sessions for leftover noise.
4. **Ready worktrees, later:** per-repo custom setup steps.
5. **Observation UI, leftovers (the rest is drawn: chips and facts on tiles and the session header, outside-project tag on cards, nested subagent calls, default-mode picker, persisted projects).**
   Still to draw: a leftover-worktrees list (`GET /api/worktrees/leftover`) and an Extra folders field on New session (`extraDirs`).
   Not done: background processes are marked ended only from the agent's own exit/kill report, not by detecting a `kill <pid>` command;
   `createSession`'s default-mode fallback in `apps/daemon/src/index.ts` has no test (it is a script); Codex gets no `additionalDirectories`.
- **Usage card at 95%, one per account (not per session):** "Usage 95% · resets 10:15 pm · [Pause sessions] [Keep going]".
  - Keep going: run to the real limit, then auto-pause and auto-resume at reset (already built).
  - No answer: pause.
  - If extra usage is on, the card warns that it costs money.
  - Add a "don't ask again" option.
  - When one session hits the limit, pause every session together, since they share one account limit.

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
- Not yet run for real (marked ⚠️ in FEATURES.md): Open PR past its pre-push checks, auto-resume at a real limit reset.
- From dev testing, not fixed yet: a single session the lead starts works in the checkout (no worktree), so there's
  nothing to Merge or PR and the change lands uncommitted (decide: worktree by default?); the crew summary says
  "All quiet" while a session waits for Retry after a restart; the answered decision isn't in the transcript;
  the user bubble shows the full "Project folder: /path" line.
- Destructive-command cards aren't guaranteed for Codex: its own auto mode runs commands without asking.
- Pending "session finished" updates for the lead are in memory; a daemon restart drops them.
- In edits mode a worker could change a test script and run it without a card (edits are already trusted there).
- Cost per session hasn't been checked against a real paid run yet; Codex may report only context.

## Later
- Codex end-to-end test (needs an OpenAI account), notarized builds + auto-update ($99 Apple account),
  Linux/Windows builds, team/cloud layer.
