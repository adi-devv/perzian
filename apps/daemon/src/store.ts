import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PerzianEvent } from "@perzian/protocol";

// Append-only event log. Everything the UI shows is a fold over these events.
export class EventStore {
  private events: PerzianEvent[] = [];
  private listeners = new Set<(e: PerzianEvent) => void>();
  private file: string;

  constructor(dir = join(homedir(), ".perzian")) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "events.jsonl");
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (line.trim()) this.events.push(JSON.parse(line));
      }
    }
  }

  emit(event: PerzianEvent): void {
    this.events.push(event);
    appendFileSync(this.file, JSON.stringify(event) + "\n");
    for (const l of this.listeners) l(event);
  }

  all(): PerzianEvent[] {
    return this.events;
  }

  subscribe(listener: (e: PerzianEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
