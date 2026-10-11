// PERZIAN_TEST_ADAPTER for `evals/run.mjs --fake`: a thin wrapper around the scripted fake agent
// (apps/daemon/test/fixtures/fake-agent.mjs). The daemon starts adapters without arguments, so the mode comes
// from env. FAKE_AGENT_SOLVE (JSON path -> content) is written into the agent's cwd first, as if it had solved
// the task; the fake agent itself then just appends to work.txt (and, in "perm" mode, asks permission for each
// command in FAKE_AGENT_COMMANDS).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (const [path, content] of Object.entries(JSON.parse(process.env.FAKE_AGENT_SOLVE ?? "{}"))) {
  mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
  writeFileSync(join(process.cwd(), path), content);
}
process.argv[2] = process.env.FAKE_AGENT_MODE ?? "fix";
process.argv[3] = process.env.FAKE_AGENT_LOG ?? "";
await import(join(dirname(fileURLToPath(import.meta.url)), "../apps/daemon/test/fixtures/fake-agent.mjs"));
