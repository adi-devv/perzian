// "Connect GitHub" on the welcome splash: run gh's own browser device flow, non-interactively, and hand the
// one-time code and URL to the UI. The developer finishes in their own browser; we never see a token (gh keeps it).
import { spawn, type ChildProcess } from "node:child_process";
import type { GitHubLogin } from "@perzian/protocol";

export const GH_LOGIN_ARGS = ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"];

/** "! First copy your one-time code: ABCD-1234" and "Open this URL to continue in your web browser: https://github.com/login/device". */
export function parseDeviceFlow(text: string): { code?: string; url?: string } {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)?.[1]?.toUpperCase();
  const url = /(https:\/\/[^\s]+\/login\/device[^\s]*)/i.exec(text)?.[1];
  return { ...(code ? { code } : {}), ...(url ? { url } : {}) };
}

export type Spawner = () => Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

const realSpawn: Spawner = () =>
  spawn("gh", GH_LOGIN_ARGS, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" } });

const TIMEOUT_MS = 10 * 60_000;

export class GhLogin {
  private child?: ReturnType<Spawner>;
  private timer?: NodeJS.Timeout;
  private status: GitHubLogin = { state: "idle" };
  private text = "";

  constructor(private readonly spawner: Spawner = realSpawn) {}

  get(): GitHubLogin {
    return this.status;
  }

  /** Starts the flow (or returns the one running) and waits briefly for the code to appear. */
  async start(waitMs = 8000): Promise<GitHubLogin> {
    if (this.status.state !== "waiting") this.launch();
    const until = Date.now() + waitMs;
    while (this.status.state === "waiting" && !this.status.code && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return this.status;
  }

  cancel(): GitHubLogin {
    this.finish({ state: "idle" });
    return this.status;
  }

  private launch(): void {
    this.text = "";
    this.status = { state: "waiting" };
    let child: ReturnType<Spawner>;
    try {
      child = this.spawner();
    } catch (e) {
      this.status = { state: "failed", error: (e as Error).message };
      return;
    }
    this.child = child;
    const onData = (chunk: Buffer | string) => {
      if (this.child !== child) return;
      this.text += String(chunk);
      const { code, url } = parseDeviceFlow(this.text);
      if (code && this.status.state === "waiting") this.status = { state: "waiting", code, url: url ?? "https://github.com/login/device" };
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e: Error & { code?: string }) => {
      if (this.child === child) this.finish({ state: "failed", error: e.code === "ENOENT" ? "GitHub CLI not installed" : e.message });
    });
    child.on("close", (code: number | null) => {
      if (this.child !== child) return;
      this.finish(code === 0 ? { state: "done" } : { state: "failed", error: this.text.trim().split("\n").slice(-1)[0] || "GitHub sign-in did not finish" });
    });
    this.timer = setTimeout(() => this.finish({ state: "failed", error: "Timed out waiting for GitHub" }), TIMEOUT_MS);
    this.timer.unref?.();
  }

  private finish(status: GitHubLogin): void {
    const child = this.child;
    this.child = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.status = status;
    child?.kill();
  }
}
