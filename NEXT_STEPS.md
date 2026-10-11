# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md). What already works: [FEATURES.md](FEATURES.md).

## Now (no new features until these are done)
1. **Dev testing.** Drive the real app through scenarios a new dev would hit: first run, pick a folder, "add a login page",
   answer a decision card, a failing check, ship (merge and PR), a usage-limit pause, phone pairing. Note every confusing
   moment, extra click or wall of text, then fix in small batches. Known: "Always"/"Deny" on the decision card look disabled.
2. **UI direction.** Decide on the hybrid prototype (`prototypes/hybrid.html`, not committed yet): mission-control board as
   home (tiles sized by urgency, chat becomes a ⌘K bar), codebase map inside a session (folders as regions, agents as dots,
   overlapping dots warn of conflicts), decision inbox on the phone. Alternatives considered: subway-map timeline.
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
- Not yet run for real (marked ⚠️ in FEATURES.md): ready worktrees, declared checks, ship, usage-limit pause. Try each on a real project.
- Destructive-command cards aren't guaranteed for Codex: its own auto mode runs commands without asking.
- Pending "session finished" updates for the lead are in memory; a daemon restart drops them.
- In edits mode a worker could change a test script and run it without a card (edits are already trusted there).
- Cost per session hasn't been checked against a real paid run yet; Codex may report only context.

## Later
- Codex end-to-end test (needs an OpenAI account), notarized builds + auto-update ($99 Apple account),
  Linux/Windows builds, team/cloud layer.
