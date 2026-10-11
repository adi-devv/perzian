// The lead starts without a project and asks for one (ask_project): the card, the answer, persistence across a restart.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadProjectsBrief, recentProjects, type Decision } from "@perzian/protocol";
import { EventStore } from "../src/store.ts";
import { AgentSession, type SessionDeps } from "../src/session.ts";
import { answerProject, leadDir, projectProblem } from "../src/lead.ts";
import { interruptions } from "../src/boot.ts";

const tmp = mkdtempSync(join(tmpdir(), "perzian-lead-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const fresh = () => {
  const home = join(tmp, `home-${Math.random().toString(36).slice(2)}`);
  const store = new EventStore(home, { compact: "never" });
  const deps: SessionDeps = { store, daemonUrl: "http://127.0.0.1:1", decisions: new Map() };
  return { home, store, deps };
};
const folder = (name: string) => {
  const p = join(tmp, name);
  mkdirSync(p, { recursive: true });
  return p;
};
// What handleReport("ask_project") raises.
const askProject = (s: AgentSession, projects: string[]) =>
  s.requestDecision({ source: "ask_project", question: "Which project?", detail: "To fix the login bug", options: projects.map((p) => ({ id: p, label: p.split("/").pop()!, tradeoff: p, kind: "choice" as const })) });

test("the lead is created without a project, in an empty folder of its own", () => {
  const { home, store, deps } = fresh();
  const dir = leadDir(home);
  assert.equal(dir, join(home, "lead"));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(leadDir(home), dir, "idempotent");
  const lead = AgentSession.create({ project: dir, cwd: dir, title: "Perzian", agent: "claude-code", role: "main", mode: "ask" }, deps);
  assert.equal(store.state().sessions[lead.info.id].role, "main");
  assert.deepEqual(recentProjects(store.state()), [], "the lead's folder is not a project");
  store.close();
});

test("ask_project: the card lists the projects; an answer returns the absolute path and persists the project", async () => {
  const { home, store, deps } = fresh();
  const known = folder("known");
  store.emit({ type: "settings.projectAdded", path: known, at: 1 });
  const lead = AgentSession.create({ project: leadDir(home), cwd: leadDir(home), title: "Perzian", agent: "claude-code", role: "main" }, deps);
  const answer = askProject(lead, [known]);
  const [id] = deps.decisions.keys();
  const card: Decision = store.state().decisions[id];
  assert.equal(card.source, "ask_project");
  assert.equal(card.question, "Which project?");
  assert.equal(card.detail, "To fix the login bug");
  assert.equal(card.options[0].id, known);
  assert.equal(lead.info.status, "needs_you");

  // "Choose folder…" / a typed path: any existing folder, not just a listed one.
  const picked = folder("picked");
  answerProject(deps.decisions, store, id, picked, home);
  assert.equal(await answer, picked, "the lead gets the absolute path");
  assert.deepEqual(store.state().settings.projects, [known, picked], "persisted through the add-project event");
  assert.equal(store.state().decisions[id], undefined);
  assert.throws(() => answerProject(deps.decisions, store, id, picked, home), /Already answered/);
  store.close();

  // Restart: the project is still there.
  const again = new EventStore(home, { compact: "never" });
  assert.deepEqual(again.state().settings.projects, [known, picked]);
  again.close();
});

test("ask_project: a missing folder is refused and the card stays open; dismissing resolves null", async () => {
  const { home, store, deps } = fresh();
  const lead = AgentSession.create({ project: leadDir(home), cwd: leadDir(home), title: "Perzian", agent: "claude-code", role: "main" }, deps);
  const answer = askProject(lead, []);
  const [id] = deps.decisions.keys();
  assert.throws(() => answerProject(deps.decisions, store, id, join(tmp, "nope"), home), /not found/);
  assert.throws(() => answerProject(deps.decisions, store, id, "  ", home), /Choose a folder/);
  // The lead's own folders are not projects, here as in spawn_session.
  mkdirSync(join(home, "main"), { recursive: true });
  assert.throws(() => answerProject(deps.decisions, store, id, leadDir(home), home), /lead's own empty folder/);
  assert.throws(() => answerProject(deps.decisions, store, id, join(home, "main"), home), /lead's own empty folder/);
  assert.ok(deps.decisions.has(id), "still waiting");
  assert.deepEqual(store.state().settings.projects, []);
  answerProject(deps.decisions, store, id, null, home);
  assert.equal(await answer, null);
  store.close();
});

test("a daemon restart closes a pending ask_project card with a line in the lead's transcript", () => {
  const { home, store, deps } = fresh();
  const lead = AgentSession.create({ project: leadDir(home), cwd: leadDir(home), title: "Perzian", agent: "claude-code", role: "main" }, deps);
  void askProject(lead, []);
  const events = interruptions(store.state(), 5);
  assert.ok(events.some((e) => e.type === "decision.resolved" && e.optionId === null));
  assert.ok(events.some((e) => e.type === "session.transcript" && e.item.kind === "decision" && e.item.source === "ask_project" && e.item.restarted));
  store.close();
});

test("spawn_session needs a usable project: empty, missing or the lead's own folder are refused", () => {
  const { home } = fresh();
  const real = folder("real");
  assert.match(projectProblem("", home) ?? "", /No project folder/);
  assert.match(projectProblem(undefined, home) ?? "", /No project folder/);
  assert.match(projectProblem(join(tmp, "gone"), home) ?? "", /not found/);
  assert.match(projectProblem(leadDir(home), home) ?? "", /lead's own/);
  const old = join(home, "main");
  mkdirSync(old, { recursive: true });
  assert.match(projectProblem(old, home) ?? "", /lead's own/, "earlier versions' lead folder is not a project either");
  writeFileSync(join(real, "a.txt"), "x");
  assert.equal(projectProblem(real, home), undefined);
});

test("the lead's brief names each known project, or says there are none", () => {
  assert.match(leadProjectsBrief([]), /no repo yet[\s\S]*\(none yet\)/);
  const brief = leadProjectsBrief(["/code/api", "/code/web"]);
  assert.match(brief, /- api: \/code\/api\n- web: \/code\/web/);
});
