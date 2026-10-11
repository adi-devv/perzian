// The lead (role "main") needs no project to start: it works from a neutral, empty folder and gets a project
// from the developer through ask_project. These helpers keep that folder and the "usable project" rule in one place.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { EventStore } from "./store.ts";
import type { PendingDecision } from "./session.ts";

export const expandPath = (p: string): string => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** $PERZIAN_HOME/lead, created empty. Leads made by earlier versions live in $PERZIAN_HOME/main and keep working. */
export function leadDir(home: string): string {
  const dir = join(home, "lead");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Why `project` can't be a session's folder, or undefined when it can. The lead's own folders are not projects. */
export function projectProblem(project: string | undefined, home: string): string | undefined {
  if (!project?.trim()) return "No project folder given";
  const path = expandPath(project.trim());
  if (!existsSync(path) || !statSync(path).isDirectory()) return `Project folder not found: ${path}`;
  if (path === join(home, "lead") || path === join(home, "main")) return "That is the lead's own empty folder, not a project";
  return undefined;
}

/** decision.answer for the "Which project?" card: any folder is a valid answer (a chip, the native picker or a typed path).
 *  It must pass projectProblem (exists, not the lead's own folder); it is persisted as a project (the same event as Add project) and the card resolves with its absolute path. */
export function answerProject(decisions: Map<string, PendingDecision>, store: EventStore, decisionId: string, answer: string | null, home: string): void {
  const pending = decisions.get(decisionId);
  if (!pending) throw new Error("Already answered");
  if (answer === null) return void pending.resolve(null);
  if (!answer.trim()) throw new Error("Choose a folder");
  // The same rule spawn_session applies. The card stays open with the reason (the developer picks another folder):
  // resolving it would hand the lead a string it takes for a path.
  const problem = projectProblem(answer, home);
  if (problem) throw new Error(problem);
  const path = expandPath(answer.trim());
  if (!store.state().settings.projects.includes(path)) store.emit({ type: "settings.projectAdded", path, at: Date.now() });
  pending.resolve(path);
}
