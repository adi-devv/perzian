// API keys the developer chose over a subscription sign-in. Stored in the macOS Keychain (service
// "dev.perzian"); elsewhere in <PERZIAN_HOME>/credentials.json with 0600 permissions. Kept in memory so
// session starts stay synchronous. Keys only ever leave the daemon as env for the agent CLI they belong
// to; the HTTP API reports whether one is set and its last four characters, never the key.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, ApiKeyProvider, CredentialStatus } from "@perzian/protocol";

const SERVICE = "dev.perzian";
export const PROVIDERS: ApiKeyProvider[] = ["anthropic", "openai"];

/** Which agent each provider's key is for, and the env vars that agent's CLI reads. */
const ENV: Record<ApiKeyProvider, { agent: AgentKind; vars: string[] }> = {
  anthropic: { agent: "claude-code", vars: ["ANTHROPIC_API_KEY"] },
  openai: { agent: "codex", vars: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
};

const SHAPE: Record<ApiKeyProvider, RegExp> = {
  anthropic: /^sk-ant-[\w-]{20,}$/,
  openai: /^sk-[\w-]{20,}$/,
};

const keychain = process.platform === "darwin" && !process.env.PERZIAN_NO_KEYCHAIN;

function security(args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const child = execFile("/usr/bin/security", args, { timeout: 5000 }, (err, stdout) => done({ ok: !err, out: String(stdout ?? "").trim() }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

export class Credentials {
  private keys = new Map<ApiKeyProvider, string>();
  private file: string;

  constructor(home: string) {
    this.file = join(home, "credentials.json");
  }

  async load(): Promise<void> {
    if (keychain) {
      for (const p of PROVIDERS) {
        const r = await security(["find-generic-password", "-s", SERVICE, "-a", p, "-w"]);
        if (r.ok && r.out) this.keys.set(p, r.out);
      }
      return;
    }
    if (!existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Record<ApiKeyProvider, string>>;
      for (const p of PROVIDERS) if (typeof j[p] === "string" && j[p]) this.keys.set(p, j[p]!);
    } catch {
      console.warn(`[credentials] could not read ${this.file}`);
    }
  }

  status(): CredentialStatus[] {
    return PROVIDERS.map((provider) => {
      const k = this.keys.get(provider);
      return { provider, agent: ENV[provider].agent, set: !!k, ...(k ? { last4: k.slice(-4) } : {}) };
    });
  }

  has(provider: ApiKeyProvider): boolean {
    return this.keys.has(provider);
  }

  async set(provider: ApiKeyProvider, key: string): Promise<void> {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
    key = key.trim();
    if (!SHAPE[provider].test(key)) throw new Error(provider === "anthropic" ? "That doesn't look like an Anthropic key (sk-ant-…)." : "That doesn't look like an OpenAI key (sk-…).");
    if (keychain) {
      // -U updates an existing item. The key goes on argv briefly; `security` has no stdin form for -w.
      const r = await security(["add-generic-password", "-U", "-s", SERVICE, "-a", provider, "-l", `Perzian ${provider} API key`, "-w", key]);
      if (!r.ok) throw new Error("Couldn't save the key to the Keychain.");
    }
    this.keys.set(provider, key);
    if (!keychain) this.persist();
  }

  async remove(provider: ApiKeyProvider): Promise<void> {
    if (keychain) await security(["delete-generic-password", "-s", SERVICE, "-a", provider]);
    this.keys.delete(provider);
    if (!keychain) this.persist();
  }

  /** Env for `agent`'s CLI: its provider key when one is set, so it is used instead of a subscription login. */
  envFor(agent: AgentKind): Record<string, string> {
    const env: Record<string, string> = {};
    for (const p of PROVIDERS) {
      const k = this.keys.get(p);
      if (k && ENV[p].agent === agent) for (const v of ENV[p].vars) env[v] = k;
    }
    return env;
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.keys), null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}
