import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { KeepAwake, isActive } from "../src/keepawake.ts";

function fake() {
  const started: string[][] = [];
  const procs: (EventEmitter & { killed: boolean; kill(): void })[] = [];
  const start = (argv: string[]) => {
    started.push(argv);
    const p = Object.assign(new EventEmitter(), { killed: false, kill() { p.killed = true; } });
    procs.push(p);
    return p as never;
  };
  return { started, procs, start };
}

describe("KeepAwake", () => {
  test("runs caffeinate tied to the daemon pid while active, once, and stops when idle", () => {
    const f = fake();
    const k = new KeepAwake({ platform: "darwin", pid: 77, start: f.start });
    k.set(false);
    assert.equal(f.started.length, 0);
    k.set(true);
    k.set(true);
    assert.deepEqual(f.started, [["caffeinate", "-i", "-w", "77"]]);
    k.set(false);
    assert.equal(f.procs[0].killed, true);
    assert.equal(k.running, false);
    k.set(true);
    assert.equal(f.started.length, 2);
  });

  test("a no-op off macOS; restarts if caffeinate died", () => {
    const f = fake();
    new KeepAwake({ platform: "linux", start: f.start }).set(true);
    assert.equal(f.started.length, 0);
    const k = new KeepAwake({ platform: "darwin", start: f.start });
    k.set(true);
    f.procs[0].emit("exit");
    assert.equal(k.running, false);
    k.set(true);
    assert.equal(f.started.length, 2);
  });

  test("working and needs_you count as active", () => {
    assert.deepEqual((["working", "needs_you", "idle", "done", "paused", "failed"] as const).map(isActive), [true, true, false, false, false, false]);
  });
});
