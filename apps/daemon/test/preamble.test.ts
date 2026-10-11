// What the agent is told and when: the role preamble returns after /clear, the lead hears about new projects,
// and an attachment-only send reaches the agent. A real AgentSession against the scripted agent in fixtures/fake-agent.mjs.
import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_INSTRUCTIONS, REPORT_INSTRUCTIONS } from "@perzian/protocol";
import { AgentSession } from "../src/session.ts";
import { EventStore } from "../src/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgent = join(here, "fixtures/fake-agent.mjs");
const tmp = mkdtempSync(join(tmpdir(), "perzian-preamble-"));
const live: AgentSession[] = [];
const stores: EventStore[] = [];
afterEach(async () => {
  const ss = live.splice(0);
  for (const s of ss) s.dispose();
  for (let i = 0; i < 100 && ss.some((s) => s.info.live); i++) await new Promise((r) => setTimeout(r, 20));
  for (const st of stores.splice(0)) st.close();
});
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function make(role: "main" | "worker") {
  const dir = join(tmp, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "agent.log");
  const store = new EventStore(join(dir, "home"), { compact: "never" });
  const s = AgentSession.create(
    { project: dir, cwd: dir, title: "t", agent: "claude-code", role },
    { store, daemonUrl: "http://127.0.0.1:9", decisions: new Map(), adapter: { command: process.execPath, args: [fakeAgent, "fix", log] } },
  );
  live.push(s);
  stores.push(store);
  const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { prompt: string }).prompt) : []);
  return { s, store, prompts, dir };
}

describe("/clear", () => {
  test("a worker gets its role preamble again on the first prompt after /clear", async () => {
    const { s, prompts } = make("worker");
    await s.prompt("first task");
    await s.prompt("second task");
    await s.prompt("/clear");
    await s.prompt("after clear");
    const p = prompts();
    assert.ok(p[0].includes(REPORT_INSTRUCTIONS));
    assert.ok(!p[1].includes(REPORT_INSTRUCTIONS), "later turns only get the short reminder");
    assert.equal(p[2], "/clear", "the command goes through as typed");
    assert.ok(p[3].includes(REPORT_INSTRUCTIONS), "context was wiped: the preamble is back");
  });

  test("the lead gets its instructions and projects brief again after /clear", async () => {
    const { s, prompts } = make("main");
    await s.prompt("hello");
    await s.prompt("/clear");
    await s.prompt("hello again");
    const p = prompts();
    assert.ok(p[0].includes(MAIN_INSTRUCTIONS));
    assert.ok(p[2].includes(MAIN_INSTRUCTIONS) && p[2].includes("Known projects:"));
  });

  test("/compact keeps its summary, so the preamble is not repeated", async () => {
    const { s, prompts } = make("main");
    await s.prompt("hello");
    await s.prompt("/compact");
    await s.prompt("next");
    assert.equal(prompts()[2], "next");
  });
});

describe("the lead's projects brief", () => {
  test("is re-sent on a later turn only when the known projects changed", async () => {
    const { s, store, prompts, dir } = make("main");
    await s.prompt("one");
    await s.prompt("two");
    store.emit({ type: "settings.projectAdded", path: join(dir, "shop"), at: Date.now() });
    await s.prompt("three");
    await s.prompt("four");
    const p = prompts();
    assert.ok(p[0].includes("(none yet)"));
    assert.equal(p[1], "two", "nothing changed: no brief");
    assert.ok(p[2].includes(`shop: ${join(dir, "shop")}`) && p[2].endsWith("three"), "a new project: the list is sent again");
    assert.ok(!p[2].includes(MAIN_INSTRUCTIONS), "just the list, not the whole preamble");
    assert.equal(p[3], "four");
  });
});

describe("attachment-only prompt", () => {
  test("the agent receives the attachment line, not an empty message", async () => {
    const { s, prompts } = make("worker");
    const att = { id: "11111111-1111-4111-8111-111111111111", name: "spec.pdf", mime: "application/octet-stream", size: 1, path: "/x/spec.pdf" };
    await s.prompt("", { attachments: [att] });
    const [p] = prompts();
    assert.ok(p.includes("Attached file: spec.pdf at /x/spec.pdf"));
  });
});
