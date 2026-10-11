import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GhLogin, parseDeviceFlow, type Spawner } from "../src/ghlogin.ts";

const OUT = `! First copy your one-time code: 1A2B-3C4D
- Press Enter to open github.com in your browser...
! Open this URL to continue in your web browser: https://github.com/login/device
`;

test("parses the one-time code and URL from gh's output", () => {
  assert.deepEqual(parseDeviceFlow(OUT), { code: "1A2B-3C4D", url: "https://github.com/login/device" });
  assert.deepEqual(parseDeviceFlow("! First copy your one-time code: abcd-1234"), { code: "ABCD-1234" });
  assert.deepEqual(parseDeviceFlow("Logging in..."), {});
  assert.deepEqual(parseDeviceFlow("Open https://ghe.example.com/login/device now"), { url: "https://ghe.example.com/login/device" });
});

function fake() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { this.killed = true; return true; } });
  const spawner = (() => child) as unknown as Spawner;
  return { child, spawner };
}

test("the login shows the code while waiting and is done when gh exits cleanly", async () => {
  const { child, spawner } = fake();
  const login = new GhLogin(spawner);
  const started = login.start(1000);
  setTimeout(() => child.stderr.emit("data", Buffer.from(OUT)), 10);
  const s = await started;
  assert.deepEqual(s, { state: "waiting", code: "1A2B-3C4D", url: "https://github.com/login/device" });
  child.emit("close", 0);
  assert.equal(login.get().state, "done");
});

test("a failed or cancelled login never stays waiting", async () => {
  const a = fake();
  const failing = new GhLogin(a.spawner);
  void failing.start(10);
  a.child.stderr.emit("data", "error: authorization expired\n");
  a.child.emit("close", 1);
  assert.deepEqual(failing.get(), { state: "failed", error: "error: authorization expired" });

  const b = fake();
  const cancelled = new GhLogin(b.spawner);
  await cancelled.start(10);
  assert.equal(cancelled.cancel().state, "idle");
  assert.equal(b.child.killed, true);

  const c = fake();
  const missing = new GhLogin(c.spawner);
  void missing.start(10);
  c.child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(missing.get(), { state: "failed", error: "GitHub CLI not installed" });
});
