import { beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { formatChildFinished, LeadNotifier, type ChildReport } from "../src/notify.ts";

const report = (id: string, over: Partial<ChildReport> = {}): ChildReport => ({
  id,
  title: `Task ${id}`,
  status: "done",
  outcome: { status: "success", intent: `Do ${id}`, proof: [{ kind: "tests", label: "npm test", passed: true, observed: true, summary: "3 passed" }] },
  changedFiles: 2,
  ...over,
});

describe("formatChildFinished", () => {
  test("one machine-readable line per child", () => {
    const text = formatChildFinished([report("a"), report("b", { status: "failed", outcome: undefined, changedFiles: 0 })]);
    const lines = text.split("\n");
    assert.match(lines[0], /^\[perzian\] Automatic update, not from the developer: 2 sessions finished\.$/);
    assert.equal(lines[1], '- id=a title="Task a" status=done outcome=success proof=tests:pass(3 passed) files=2 intent="Do a"');
    assert.equal(lines[2], '- id=b title="Task b" status=failed outcome=none files=0');
    assert.match(lines[3], /one short line/);
  });

  test("failed and unverified proof, derived outcomes, quotes and newlines are flattened", () => {
    const line = formatChildFinished([
      report("c", { title: 'Fix "x"\nnow', outcome: { status: "partial", intent: "a\nb", derived: true, proof: [{ kind: "tests", label: "t", passed: false, observed: true }, { kind: "build", label: "b", passed: true }] } }),
    ]).split("\n")[1];
    assert.equal(line, `- id=c title="Fix 'x' now" status=done outcome=partial(derived) proof=tests:fail files=2 intent="a b"`);
    const unverified = formatChildFinished([report("d", { outcome: { status: "success", intent: "x", proof: [{ kind: "tests", label: "t", passed: true }] } })]);
    assert.match(unverified, /proof=unverified/);
  });
});

describe("LeadNotifier", () => {
  let delivered: { lead: string; text: string }[];
  let notices: string[];
  let busy: boolean;
  let n: LeadNotifier;
  const reports: Record<string, ChildReport> = { a: report("a"), b: report("b"), c: report("c") };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    delivered = [];
    notices = [];
    busy = false;
    n = new LeadNotifier({
      busy: () => busy,
      report: (id) => reports[id],
      deliver: (lead, text) => delivered.push({ lead, text }),
      notice: (_lead, text) => notices.push(text),
      debounceMs: 1500,
      maxAutoTurns: 2,
    });
  });

  const settle = (id: string) => {
    n.childPrompted(id, true);
    n.childSettled("L", id);
  };

  test("batches children that finish close together", () => {
    settle("a");
    mock.timers.tick(1000);
    settle("b");
    mock.timers.tick(1000);
    assert.equal(delivered.length, 0);
    mock.timers.tick(600);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /2 sessions finished/);
    assert.match(delivered[0].text, /id=a /);
    assert.match(delivered[0].text, /id=b /);
    mock.timers.reset();
  });

  test("holds the update while the lead is mid-turn, then delivers after the turn", () => {
    busy = true;
    settle("a");
    mock.timers.tick(2000);
    assert.equal(delivered.length, 0);
    busy = false;
    n.leadIdle("L");
    assert.equal(delivered.length, 1);
    n.leadIdle("L");
    assert.equal(delivered.length, 1, "delivered once");
    mock.timers.reset();
  });

  test("an idle lead before the debounce elapses doesn't deliver early", () => {
    settle("a");
    n.leadIdle("L");
    assert.equal(delivered.length, 0);
    mock.timers.tick(1500);
    assert.equal(delivered.length, 1);
    mock.timers.reset();
  });

  test("only turns the lead started are reported", () => {
    n.childPrompted("a", false); // the developer drove this child directly
    n.childSettled("L", "a");
    mock.timers.tick(2000);
    assert.equal(delivered.length, 0);
    // A settle without a new lead prompt isn't reported twice.
    settle("b");
    mock.timers.tick(2000);
    n.childSettled("L", "b");
    mock.timers.tick(2000);
    assert.equal(delivered.length, 1);
    mock.timers.reset();
  });

  test("pauses after too many automatic turns until the developer speaks", () => {
    settle("a");
    mock.timers.tick(1500);
    settle("b");
    mock.timers.tick(1500);
    settle("c");
    mock.timers.tick(1500);
    assert.equal(delivered.length, 2);
    assert.deepEqual(notices, ["Paused automatic session updates until you reply"]);
    n.developerPrompted("L");
    n.leadIdle("L");
    assert.equal(delivered.length, 3);
    assert.match(delivered[2].text, /id=c /);
    mock.timers.reset();
  });
});
