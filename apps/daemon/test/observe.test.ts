import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolObserver, isBackground, outsideOf, pathInside, portOf, spawnBlocker, spawnDepth, touchedPaths } from "../src/observe.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pz-observe-")));
const cwd = join(tmp, "proj");
const extra = join(tmp, "extra");
const elsewhere = join(tmp, "elsewhere");
for (const d of [cwd, extra, elsewhere]) mkdirSync(d);
symlinkSync(elsewhere, join(cwd, "link"));

describe("outsideOf", () => {
  test("inside, extra folders, and not-yet-existing files are inside", () => {
    assert.deepEqual(outsideOf([join(cwd, "a.ts"), join(cwd, "new/dir/b.ts"), join(extra, "c.ts"), cwd], [cwd, extra]), []);
  });
  test("outside paths are resolved, `..` and symlinks included", () => {
    assert.deepEqual(outsideOf([join(elsewhere, "x.ts")], [cwd]), [join(elsewhere, "x.ts")]);
    assert.deepEqual(outsideOf([join(cwd, "..", "elsewhere", "x.ts")], [cwd]), [join(elsewhere, "x.ts")]);
    assert.deepEqual(outsideOf([join(cwd, "link", "x.ts")], [cwd]), [join(elsewhere, "x.ts")], "a link inside pointing out is outside");
  });
  test("a sibling with the same prefix is not inside", () => {
    mkdirSync(join(tmp, "proj-two"), { recursive: true });
    assert.equal(outsideOf([join(tmp, "proj-two", "a.ts")], [cwd]).length, 1);
  });
  test("an extra folder makes its files inside", () => {
    assert.equal(outsideOf([join(extra, "a.ts")], [cwd]).length, 1);
    assert.equal(outsideOf([join(extra, "a.ts")], [cwd, extra]).length, 0);
  });
});

describe("touchedPaths", () => {
  test("reads locations and raw input fields, relative paths against cwd", () => {
    const got = touchedPaths({ locations: [{ path: "/x/a.ts" }], rawInput: { file_path: "src/b.ts", destination: "/y/c.ts" } }, cwd);
    assert.deepEqual(got.sort(), ["/x/a.ts", "/y/c.ts", `${cwd}/src/b.ts`].sort());
  });
  test("nothing for a call without paths", () => assert.deepEqual(touchedPaths({ rawInput: { command: "ls" } }, cwd), []));
});

describe("background commands", () => {
  test("detects run_in_background and a trailing &", () => {
    assert.ok(isBackground({ command: "npm run dev", run_in_background: true }));
    assert.ok(isBackground({ command: "node server.js > log 2>&1 &" }));
    assert.ok(!isBackground({ command: "npm test && echo done" }));
    assert.ok(!isBackground({ command: "npm test" }));
  });
  test("ports", () => {
    assert.equal(portOf("vite --port 5173"), 5173);
    assert.equal(portOf("vite --port=5173"), 5173);
    assert.equal(portOf("PORT=8080 node app.js"), 8080);
    assert.equal(portOf("ready on http://localhost:3000"), 3000);
    assert.equal(portOf("python -m http.server --bind 0.0.0.0:9000"), 9000);
    assert.equal(portOf("npm run dev"), undefined);
    assert.equal(portOf("--port 99999"), undefined);
  });
});

describe("ToolObserver", () => {
  const make = () => new ToolObserver(cwd, () => [cwd, extra]);

  test("records an outside edit once", () => {
    const o = make();
    const p1 = o.onTool({ toolCallId: "e1", kind: "edit", locations: [{ path: join(elsewhere, "a.ts") }] });
    assert.deepEqual(p1?.outsidePaths, [join(elsewhere, "a.ts")]);
    assert.equal(o.onTool({ toolCallId: "e1", kind: "edit", status: "completed", rawInput: { file_path: join(elsewhere, "a.ts") } }), undefined);
    assert.equal(o.onTool({ toolCallId: "e2", kind: "edit", rawInput: { file_path: join(extra, "ok.ts") } }), undefined, "extra folder is inside");
    assert.equal(o.onTool({ toolCallId: "r1", kind: "read", locations: [{ path: join(elsewhere, "a.ts") }] }), undefined, "reads outside aren't recorded");
  });

  test("tracks a subagent from running to done, picking the description up from the input", () => {
    const o = make();
    assert.deepEqual(o.onTool({ toolCallId: "t1", title: "Task", _meta: { claudeCode: { toolName: "Task" } } })?.subagents, [{ id: "t1", description: "Task", status: "running" }]);
    assert.equal(o.onTool({ toolCallId: "t1", rawInput: { description: "Find callers" } })?.subagents?.[0].description, "Find callers");
    assert.equal(o.onTool({ toolCallId: "t1", status: "completed" })?.subagents?.[0].status, "done");
    const f = make();
    f.onTool({ toolCallId: "t2", name: "Agent", rawInput: { description: "x" } });
    assert.equal(f.onTool({ toolCallId: "t2", name: "Agent", status: "failed" })?.subagents?.[0].status, "failed");
  });

  test("an unfinished subagent is closed with the turn", () => {
    const o = make();
    o.onTool({ toolCallId: "t1", name: "Agent", rawInput: { description: "x" } });
    assert.equal(o.closeOpen("cancelled")?.subagents?.[0].status, "failed");
    assert.equal(o.closeOpen("cancelled"), undefined);
  });

  test("a background command gets its port and task id, and ends when killed", () => {
    const o = make();
    const meta = { claudeCode: { toolName: "Bash", toolResponse: { stdout: "", backgroundTaskId: "bash_7" } } };
    const p = o.onTool({ toolCallId: "b1", kind: "execute", rawInput: { command: "npm run dev -- --port 4000", run_in_background: true } });
    assert.deepEqual(p?.background, [{ id: "b1", command: "npm run dev -- --port 4000", port: 4000 }]);
    const q = o.onTool({ toolCallId: "b1", kind: "execute", status: "completed", _meta: meta });
    assert.equal(q?.background?.[0].taskId, "bash_7");
    assert.equal(o.onTool({ toolCallId: "k1", name: "KillShell", rawInput: { shell_id: "nope" } }), undefined);
    assert.equal(o.onTool({ toolCallId: "k2", name: "KillShell", rawInput: { shell_id: "bash_7" } })?.background?.[0].ended, true);
  });

  test("a port from the output when the command doesn't say", () => {
    const o = make();
    o.onTool({ toolCallId: "b1", kind: "execute", rawInput: { command: "npm start &" } });
    const p = o.onTool({ toolCallId: "b1", kind: "execute", rawInput: { command: "npm start &" }, rawOutput: "Listening on http://localhost:3001" });
    assert.equal(p?.background?.[0].port, 3001);
  });

  test("a foreground command is not a background process", () => {
    assert.equal(make().onTool({ toolCallId: "x", kind: "execute", rawInput: { command: "npm test" } }), undefined);
  });
});

describe("spawn depth", () => {
  const tree: Record<string, { parentId?: string }> = { lead: {}, w1: { parentId: "lead" }, w2: { parentId: "w1" }, w3: { parentId: "w2" }, solo: {} };
  const get = (id: string) => tree[id];
  test("depth counts parents", () => {
    assert.deepEqual(["lead", "w1", "w2", "w3"].map((id) => spawnDepth(id, get)), [0, 1, 2, 3]);
  });
  test("the lead and its workers may spawn, two levels down is the limit", () => {
    assert.equal(spawnBlocker("lead", get), undefined);
    assert.equal(spawnBlocker("w1", get), undefined);
    assert.equal(spawnBlocker("solo", get), undefined);
    assert.match(spawnBlocker("w2", get) ?? "", /at most 2 levels/);
    assert.match(spawnBlocker("w3", get) ?? "", /level 3/);
  });
  test("a parent cycle can't loop forever", () => {
    assert.equal(spawnDepth("a", (id) => ({ parentId: id === "a" ? "b" : "a" })), 2);
  });
});

describe("pathInside (the Map's session dot)", () => {
  test("first location inside the folder, relative with / separators", () => {
    assert.equal(pathInside({ locations: [{ path: join(cwd, "src", "a.ts") }] }, cwd), "src/a.ts");
    assert.equal(pathInside({ rawInput: { file_path: "lib/b.ts" } }, cwd), "lib/b.ts");
  });
  test("skips paths outside, and the folder itself", () => {
    assert.equal(pathInside({ locations: [{ path: join(elsewhere, "x.ts") }, { path: join(cwd, "y.ts") }] }, cwd), "y.ts");
    assert.equal(pathInside({ locations: [{ path: cwd }] }, cwd), undefined);
    assert.equal(pathInside({ locations: [{ path: join(extra, "z.ts") }] }, cwd), undefined);
    assert.equal(pathInside({}, cwd), undefined);
  });
});
