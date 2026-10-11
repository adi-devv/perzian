# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md). What already works: [FEATURES.md](FEATURES.md).

## Now
1. **Try the Mac app** (`npm run app`) and note what breaks or feels off.
2. **Publish v0.0.1 as a GitHub Release.** `npm run dist`, upload the ~116 MB zip, link it from the README and site.

## Features
1. **Phone access via Tailscale (decided).** "Open on phone" shows a QR code with the Mac's Tailscale HTTPS address
   (`tailscale serve`, *.ts.net) and a one-time pairing token; if Tailscale is missing, a short install step.
   - Phone gets an installable PWA with only the attention queue, decision cards and tiles.
   - The daemon sends Web Push itself (VAPID, straight to Apple/Google push, no servers of ours) when a session needs you, finishes or fails.
   - Keep the Mac awake while agents work.
   - Same Wi-Fi without Tailscale is a view-only fallback (no HTTPS, so no push).
   - Later, if people want zero setup: a Cloudflare Durable Objects relay with end-to-end encryption, possibly paid. Firebase rejected (data at Google, per-event cost).
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
