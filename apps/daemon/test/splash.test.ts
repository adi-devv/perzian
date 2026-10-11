import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fold, type PerzianEvent } from "@perzian/protocol";
import { compact, replay } from "../src/store.ts";

const NOW = Date.now();

describe("settings.splash (Show on startup)", () => {
  const set = (show: boolean, at = 1): PerzianEvent => ({ type: "settings.splash", show, at });

  test("defaults to on; the latest event wins in fold and replay", () => {
    assert.equal(fold([]).settings.splash, true);
    assert.equal(replay([]).settings.splash, true);
    assert.equal(fold([set(false)]).settings.splash, false);
    assert.equal(replay([set(false), set(true, 2)]).settings.splash, true);
    assert.equal(replay([set(false)]).settings.splash, false);
  });

  test("survives compaction (only the non-default is written)", () => {
    assert.equal(compact(fold([set(true)]), { now: NOW }).length, 0);
    assert.equal(fold(compact(fold([set(false)]), { now: NOW })).settings.splash, false);
  });
});
