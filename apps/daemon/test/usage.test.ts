import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { UsageMeter } from "../src/usage.ts";

const usd = (amount: number) => ({ cost: { amount, currency: "USD" }, used: 1000, size: 200_000 });

describe("UsageMeter", () => {
  test("takes the adapter's running total within one process", () => {
    const m = new UsageMeter();
    m.restart();
    assert.equal(m.read(usd(0.1))?.costUsd, 0.1);
    assert.equal(m.read(usd(0.25))?.costUsd, 0.25);
  });

  test("a reading that drops means the adapter started over", () => {
    const m = new UsageMeter();
    m.restart();
    m.read(usd(0.4));
    assert.equal(m.read(usd(0.05))?.costUsd, 0.45);
    assert.equal(m.read(usd(0.1))?.costUsd, 0.5);
  });

  test("after a restart, a fresh process adds to the stored total", () => {
    const m = new UsageMeter({ costUsd: 1 });
    m.restart();
    assert.equal(m.read(usd(0.2))?.costUsd, 1.2);
    m.restart();
    assert.equal(m.read(usd(0.3))?.costUsd, 1.5);
  });

  test("a resumed process whose first reading includes history isn't counted twice", () => {
    const m = new UsageMeter({ costUsd: 1 });
    m.restart();
    assert.equal(m.read(usd(1.3))?.costUsd, 1.3);
  });

  test("ignores non-USD and bad amounts, keeps context, and skips tiny moves", () => {
    const m = new UsageMeter({ costUsd: 0.5 });
    m.restart();
    const u = m.read({ cost: { amount: 9, currency: "EUR" }, used: 50_000, size: 200_000 });
    assert.deepEqual(u, { costUsd: 0.5, contextUsed: 50_000, contextSize: 200_000 });
    assert.equal(m.read({ used: 50_500 }), null, "a quarter-percent context move isn't an event");
    assert.equal(m.read({ used: 60_000 })?.contextUsed, 60_000);
    assert.equal(m.read({ cost: { amount: Number.NaN, currency: "USD" } }), null);
  });
});
