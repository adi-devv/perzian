# Next steps

Short, ordered list of what's next. Longer-term plan: [docs/ROADMAP.md](docs/ROADMAP.md). What already works: [FEATURES.md](FEATURES.md).

## Now (no new features until these are done)
1. **Dev testing.** Drive the real app through scenarios a new dev would hit: first run, pick a folder, "add a login page",
   answer a decision card, a failing check, ship (merge and PR), a usage-limit pause, phone pairing. Note every confusing
   moment, extra click or wall of text, then fix in small batches.
   Round 1 done (2026-10-11): 16 + 6 fixes merged. Round 2: a real PR to GitHub (`gh`), auto-resume at a real limit reset, phone on a real device.
2. **UI direction: crew + center is built; finish it.** Left: the crew (one live tile per session, grouped by project, urgency-sorted, answerable in place).
   Center: Perzian's chat, or one session's detail (Changes, Map, Checks, Transcript). Leftovers:
   - The Map (treemap with session dots) lives only in a session's detail; there's no project-wide center view to put it in yet.
     Not tried with a real running agent (tool `path` placement) or on a 10k-file repo in the browser (unit-tested only).
   - The old alternatives (subway-map timeline) are still open. The phone decision inbox is built; try it on a real phone.
3. **Small eval set.** Built (`evals/README.md`, verified with `--fake`); run it once against the real agent and record the baseline.
4. **Try the Mac app** (`npm run app`) and **publish v0.0.1** as a GitHub Release (`npm run dist`, upload the zip, link it).

## Features
1. **Phone access, try phases 1 and 2 on a real phone** (`Open on phone` in the sidebar): Tailscale and the Cloudflare quick tunnel, then Web Push on an iPhone (Home Screen app) and Android.
   Confirm a real push arrives and tapping opens the session. The account usage card pushes too (while unanswered).
   Same Wi-Fi without Tailscale is a view-only fallback (no HTTPS, so no push), only if people ask.
3. **Calm visuals, follow-through.** Review the app with real sessions for leftover noise.
5. **Observation UI, leftovers (the rest is drawn: chips and facts on tiles and the session header, outside-project tag on cards, nested subagent calls, default-mode picker, persisted projects).**
   Not done: Codex gets no `additionalDirectories`. The usage card is unit-tested only: try it against a real account near its limit; the phone inbox doesn't show it yet.
6. **Built-in browser.** A browser pane per session, like Claude Code's: the agent can open, read and click pages (dev server previews, docs, staging), and the developer sees the same tab and can take over.
7. **Built-in terminal.** A real terminal (pty) per session in its worktree, like Claude Code's: the developer runs their own commands, and the agent can read what's on screen ("the error I just got").
   Both open like Claude Code's: in a side panel beside the session (a resizable half of the window), as tabs, closed by default and opened on demand by the developer or the agent.
8. **Rewind.** Each turn is a checkpoint on the timeline. Click one to roll the session back (worktree and conversation) to that point.
9. **Plan approval card.** In plan mode the agent's plan shows as a card (steps as a list) with Approve / Edit. No code changes until approved.
10. **Comment on the diff.** Click a line in the diff, leave a note, send the notes to the agent as one message. The code view stays read-only.
11. **Live todo list.** The agent's checklist (TodoWrite) as progress on the tile and in the session header: 3/7 with the current step.
12. **Fork from a turn.** "Try another way" from any turn: a sibling session in its own worktree, starting from that checkpoint.
13. **Effort and fast mode per session**, next to the model picker.
14. **Open in editor.** One button opens the session's worktree in VS Code / Cursor / Zed.
15. **Smart model allocation (saves usage and context).** Never switch a running chat's model: that drops the prompt cache and costs more. Instead pick the model when work starts:
   - a fresh chat gets a model matched to the ask (hard planning or debugging on Opus, simple asks on Sonnet);
   - a new, separable task that comes up mid-chat goes to its own sub-session with the right model and a fresh, small context (searches, reads, mechanical edits on Sonnet/Haiku), and the lead keeps its model and its cache.
   Suggest, don't force: a small inline card ("Sonnet can do this · saves ~X% usage") with [Use Sonnet] [Keep Opus]. Calm, one line, never blocks sending.
   Auto mode (a toggle, per session or global): Perzian picks without asking and just shows the chosen model on the tile; one click changes it.
   Show the model on each tile and the saving in the usage popover. The developer can pin a model to override.

## Brand
- **Color:** Persian turquoise (`#3ec6cf` dark, `#0b7a84` light) with a little gold (`#e0b25a`). Blue/purple dropped (overused).
- **Logo (pick pending).** Orbit/fan mark dropped (overused); minimal marks too plain. Rich options on the design board:
  Simurgh in flight, Simurgh in a tile arch, illuminated feather, thirty birds. After the pick: replace `apps/site/assets/mark.svg`,
  app icon, favicon; switch site/app accent to turquoise. Needs a simplified 16px version.
- **Thinking animation from the logo** (like Claude's spark), for the lead's "working" state and the site hero. Design after the pick.

## From competitors (Conductor, Vibe Kanban, Cursor, Zed)
- **Run the app from a session:** start its dev server on its own port to try the change before merging.
- **Checkpoints:** roll a session back to before a given turn.
- **Sessions from issues:** pick a GitHub/Linear issue; it becomes the brief.
- **Comment on a diff line:** goes to the agent as the next task (code view stays read-only).

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
- **Search across sessions** (transcripts, decisions, outcomes): "where did we fix X".
- Codex end-to-end test (needs an OpenAI account), notarized builds + auto-update ($99 Apple account),
  Linux/Windows builds, team/cloud layer.
- Phone relay, if people want zero setup with guarantees: our own Cloudflare Durable Objects relay with end-to-end
  encryption, about $5-30/month per 1k active users, possibly paid. Firebase rejected (data at Google, per-event cost).
