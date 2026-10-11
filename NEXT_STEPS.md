# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Now
1. **Try the Mac app** (`npm run app`) and note what breaks or feels off.
2. **Publish v0.0.1 as a GitHub Release.** `npm run dist`, upload the ~116 MB zip, link it from the README and site.
3. **www.perzian.dev HTTPS.** DNS is correct but the Pages certificate covers only `perzian.dev`.
   Fix: Settings → Pages → Custom domain → `www.perzian.dev` → Save, wait for HTTPS, then switch back to `perzian.dev` if preferred.

## Features
1. **Ship it.** A done session gets one click: "Merge into main" or "Open PR" (via `gh`). Show conflicts visually,
   then remove the worktree. Today finished work sits on its `perzian/<slug>` branch until merged by hand.
2. **Crew summary.** Ask the lead "what's going on?" and get a short digest of what's done, blocked and needs you,
   built from `list_sessions` and outcomes (roadmap: "Main agent summarizes crew state into decisions").
3. **Calm visuals, follow-through.** The app now keeps color only for needs you (amber) and failed (red).
   Apply the same rule to the site's feature mockups (`apps/site`), and review the app with real sessions for leftover noise.
4. **Phone access (after trying the Mac app).** QR code + one-time pairing token opens the UI on your phone,
   on the same Wi-Fi or through Tailscale. Mainly for answering decision cards. Needs token auth on the daemon.

## Known gaps
- Destructive-command cards aren't guaranteed for Codex: its own auto mode runs commands without asking.
- Pending "session finished" updates for the lead are in memory; a daemon restart drops them.
- In edits mode a worker could change a test script and run it without a card (edits are already trusted there).
- Cost per session hasn't been checked against a real paid run yet; Codex may report only context.

## Later
- Codex end-to-end test (needs an OpenAI account), notarized builds + auto-update ($99 Apple account),
  Linux/Windows builds, team/cloud layer.
