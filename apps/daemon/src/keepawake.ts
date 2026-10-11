// Keeps a Mac awake while any session is working or needs you: `caffeinate -i -w <daemon pid>` runs while
// at least one session is active and is stopped when none are (-w also ends it if the daemon dies).
// A no-op on other platforms.
import { spawn, type ChildProcess } from "node:child_process";
import type { SessionStatus } from "@perzian/protocol";

export const isActive = (status: SessionStatus): boolean => status === "working" || status === "needs_you";

export interface KeepAwakeDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  start?: (argv: string[]) => Pick<ChildProcess, "kill" | "on">;
}

export class KeepAwake {
  private proc?: Pick<ChildProcess, "kill" | "on">;

  constructor(private deps: KeepAwakeDeps = {}) {}

  get running(): boolean {
    return !!this.proc;
  }

  /** Call whenever session statuses change, with whether any session is working or needs you. */
  set(active: boolean): void {
    if ((this.deps.platform ?? process.platform) !== "darwin") return;
    if (active && !this.proc) {
      const argv = ["caffeinate", "-i", "-w", String(this.deps.pid ?? process.pid)];
      const start = this.deps.start ?? ((a) => spawn(a[0], a.slice(1), { stdio: "ignore" }));
      try {
        const p = start(argv);
        p.on("error", () => {
          if (this.proc === p) this.proc = undefined;
        });
        p.on("exit", () => {
          if (this.proc === p) this.proc = undefined;
        });
        this.proc = p;
      } catch {}
    } else if (!active && this.proc) {
      const p = this.proc;
      this.proc = undefined;
      p.kill();
    }
  }

  stop(): void {
    this.set(false);
  }
}
