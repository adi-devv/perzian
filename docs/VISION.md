# Perzian — Vision

## One line

An agentic development environment (ADE) where you manage coding agents by **looking, not reading**.

## The problem

A developer running agents today:

- juggles many sessions across projects and git worktrees,
- pays a context-switch tax every time they jump between them,
- scrolls through walls of agent prose to figure out *what is happening* and *what went wrong*,
- reads raw code/diffs to verify work, which is slow and doesn't work on the go.

The Claude Code app, VS Code, Cursor, and canvas tools (AgentGrid, Maestri, Morphy) all still put the
**transcript or the file** at the center. Canvas tools arrange terminals spatially, but you still read terminals.

## The thesis

Put **state** at the center, not text:

- *What's happening?* — glanceable session tiles with color-coded status.
- *What needs me?* — an attention queue sorted by urgency.
- *What changed?* — visual change maps, not diffs-first.
- *Is it correct?* — proof (tests, screenshots, behavior diffs) is a first-class artifact.

Prose and code are the **deep-dive layer**, always available, never the default.

Think Jarvis: you talk to one main agent; it runs the crew; it surfaces decisions, not essays.

## Design principles

1. **Instant visual cue.** If a dev has to read a sentence to know a session's state, we failed. State is
   encoded in color, shape, motion, and position before words.
2. **Nothing missing vs habit.** A dev should never feel a capability they rely on is gone: transcript,
   terminal output, diff, file view, the ability to talk to any session directly — all one click away.
3. **Agents emit data, the UI draws it.** Sessions report through structured MCP tools
   (`report_progress`, `ask_decision`, `report_outcome`). Prose is the fallback.
4. **Decisions are cards, not paragraphs.** 2–3 options, one-line tradeoff each, one click.
   Permission prompts are decision cards too.
5. **Diagrams of the change, not the codebase.** Auto-generated whole-codebase graphs are hairballs. We
   compute real structure (tree-sitter + git diff) and let the model pick *which slice* matters and label it.
   The model never invents structure.
6. **Trust through proof.** Less reading must not mean less checking. Every outcome carries evidence.
7. **Read-only code.** We are not an editor. Changes go through agents or "open in your editor".
8. **Wrap, don't rebuild.** We drive existing agents (Claude Code, Codex, …) over ACP. We build the
   surface, not the agent.
9. **Multi-model.** Each session picks its agent + model; the main agent has a model picker.

## Layers (glance → deep)

1. **Control tower** — every session across every project/worktree as a tile:
   `working` · `needs you` · `done` · `failed` · `idle`. Attention queue on the side.
2. **Main agent** — the primary conversation. Spawns, monitors, and summarizes sessions. Returns decisions.
3. **Outcome cards** — intent, change map, proof, risks, open decisions.
4. **Deep dive** — raw transcript, terminal, diff, read-only code.

Plus **"where was I" cards** per project: last decision, what's pending, what moved since you left.

## Non-goals (for now)

- Editing code in-app.
- Building our own agent loop.
- Team/multi-user features (solo dev first; the daemon architecture leaves room).
