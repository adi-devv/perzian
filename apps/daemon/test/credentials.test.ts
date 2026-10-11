import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// File storage, never the developer's real Keychain.
process.env.PERZIAN_NO_KEYCHAIN = "1";
const { Credentials } = await import("../src/credentials.ts");

const ANT = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
const OAI = "sk-proj-" + "b".repeat(40) + "1234";

describe("Credentials", () => {
  test("stores keys 0600, reports only last4, and survives a reload", async () => {
    const home = mkdtempSync(join(tmpdir(), "pz-creds-"));
    const c = new Credentials(home);
    await c.load();
    assert.deepEqual(c.status().map((s) => s.set), [false, false]);

    await c.set("anthropic", `  ${ANT}\n`);
    const st = c.status().find((s) => s.provider === "anthropic")!;
    assert.equal(st.set, true);
    assert.equal(st.last4, "WXYZ");
    assert.ok(!JSON.stringify(c.status()).includes(ANT), "status never contains the key");

    const file = join(home, "credentials.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).anthropic, ANT);

    const again = new Credentials(home);
    await again.load();
    assert.equal(again.has("anthropic"), true);
  });

  test("passes each key only to its own agent", async () => {
    const c = new Credentials(mkdtempSync(join(tmpdir(), "pz-creds-")));
    await c.set("anthropic", ANT);
    await c.set("openai", OAI);
    assert.deepEqual(c.envFor("claude-code"), { ANTHROPIC_API_KEY: ANT });
    assert.deepEqual(c.envFor("codex"), { OPENAI_API_KEY: OAI, CODEX_API_KEY: OAI });
  });

  test("rejects malformed keys and removes keys", async () => {
    const c = new Credentials(mkdtempSync(join(tmpdir(), "pz-creds-")));
    await assert.rejects(c.set("anthropic", "sk-proj-nope"), /Anthropic key/);
    await assert.rejects(c.set("openai", "hello"), /OpenAI key/);
    await c.set("openai", OAI);
    await c.remove("openai");
    assert.equal(c.has("openai"), false);
    assert.deepEqual(c.envFor("codex"), {});
  });
});
