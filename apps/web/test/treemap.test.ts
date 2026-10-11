import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FileChange, RepoTree, TranscriptItem } from "@perzian/protocol";
import { aggregate, cellChurn, churnIndex, currentPath, heat, layout, placeDots, squarify, subtree, weight, withChanges, type Cell, type Rect } from "../src/treemap.ts";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** A folder from `{ name: size | folder }`; sizes and file counts summed like the daemon does. */
function dir(name: string, spec: Record<string, number | RepoTree>): RepoTree {
  const children = Object.entries(spec).map(([n, v]) => (typeof v === "number" ? { name: n, size: v } : { ...v, name: n }));
  return { name, size: children.reduce((s, c) => s + c.size, 0), files: children.reduce((s, c) => s + (c.children ? (c.files ?? 0) : 1), 0), children };
}

describe("squarify", () => {
  test("the paper's example: areas match, tiles the rect, no overlap", () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const r = { x: 0, y: 0, w: 6, h: 4 };
    const out = squarify(values, r);
    out.forEach((o, i) => assert.ok(near(area(o), values[i]), `area ${i}`));
    assert.ok(near(out.reduce((s, o) => s + area(o), 0), 24));
    for (const o of out) assert.ok(o.x >= -1e-9 && o.y >= -1e-9 && o.x + o.w <= 6 + 1e-9 && o.y + o.h <= 4 + 1e-9, "inside");
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) assert.ok(overlap(out[i], out[j]) < 1e-9, `${i}/${j} overlap`);
    // Squarified, so the first two (6 and 6) stack as a 3×2 column pair, not slivers.
    assert.ok(near(out[0].w, 3) && near(out[0].h, 2));
  });
  test("aspect ratios stay reasonable for many equal values", () => {
    const out = squarify(Array(100).fill(1), { x: 0, y: 0, w: 1000, h: 600 });
    const worst = Math.max(...out.map((o) => Math.max(o.w / o.h, o.h / o.w)));
    assert.ok(worst < 3, `worst ratio ${worst}`);
  });
  test("zeros get empty rects; empty input and empty rect are safe", () => {
    const out = squarify([5, 0, 5], { x: 10, y: 20, w: 10, h: 10 });
    assert.equal(area(out[1]), 0);
    assert.ok(near(area(out[0]) + area(out[2]), 100));
    assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
    assert.equal(area(squarify([1], { x: 0, y: 0, w: 0, h: 10 })[0]), 0);
  });
});

describe("aggregate", () => {
  const kids = [{ name: "big", size: 1000 }, { name: "mid", size: 100 }, { name: "s1", size: 1 }, { name: "s2", size: 1 }, { name: "s3", size: 1 }];
  const total = kids.reduce((n, c) => n + weight(c), 0);
  test("small files fold into one rest entry with their names and totals", () => {
    const { keep, rest } = aggregate(kids, 10_000, total, { minArea: 50, perDir: 80 });
    assert.deepEqual(keep.map((k) => k.name), ["big", "mid"]);
    assert.deepEqual(rest?.names, ["s1", "s2", "s3"]);
    assert.equal(rest?.files, 3);
    assert.equal(rest?.size, 3);
  });
  test("a per-folder cap folds the tail even when it would fit", () => {
    const { keep, rest } = aggregate(kids, 1e9, total, { minArea: 1, perDir: 2 });
    assert.equal(keep.length, 2);
    assert.equal(rest?.names.length, 3);
  });
  test("a single leftover is drawn, not folded", () => {
    const { keep, rest } = aggregate(kids.slice(0, 3), 10_000, total, { minArea: 50, perDir: 80 });
    assert.equal(keep.length, 3);
    assert.equal(rest, undefined);
  });
});

describe("layout", () => {
  const tree = dir("repo", {
    src: dir("src", { "a.ts": 4000, "b.ts": 3000, lib: dir("lib", { "c.ts": 2000, "d.ts": 1000 }) }),
    docs: dir("docs", { "x.md": 1500 }),
    "README.md": 500,
  });
  const cells = layout(tree, "", 800, 500);
  const at = (p: string) => cells.find((c) => c.path === p);

  test("the view's children tile it; open folders hold their children", () => {
    const top = cells.filter((c) => c.depth === 0);
    assert.deepEqual(top.map((c) => c.path).sort(), ["README.md", "docs", "src"]);
    assert.ok(near(top.reduce((s, c) => s + area(c), 0), 800 * 500, 1e-3));
    const src = at("src")!;
    assert.equal(src.open, true);
    for (const p of ["src/a.ts", "src/b.ts", "src/lib", "src/lib/c.ts"]) {
      const c = at(p)!;
      assert.ok(c, p);
      const parent = at(p.slice(0, p.lastIndexOf("/")))!;
      assert.ok(c.x >= parent.x - 1e-6 && c.y >= parent.y - 1e-6 && c.x + c.w <= parent.x + parent.w + 1e-6 && c.y + c.h <= parent.y + parent.h + 1e-6, `${p} inside its folder`);
    }
    // Bigger file, bigger cell.
    assert.ok(area(at("src/a.ts")!) > area(at("src/b.ts")!));
  });
  test("drill-down: laying out a subtree uses full paths", () => {
    const sub = layout(subtree(tree, "src/lib")!, "src/lib", 400, 300);
    assert.deepEqual(sub.map((c) => c.path).sort(), ["src/lib/c.ts", "src/lib/d.ts"]);
    assert.equal(subtree(tree, "nope/x"), undefined);
  });
  test("maxDepth and size gates keep folders closed", () => {
    const flat = layout(tree, "", 800, 500, { maxDepth: 1 });
    assert.ok(flat.every((c) => c.depth === 0 && !c.open));
    const tiny = layout(tree, "", 60, 40);
    assert.ok(tiny.every((c) => !c.open), "too small to open anything");
  });
  test("10k+ files stay under the cell cap, fast", () => {
    const big: Record<string, RepoTree> = {};
    for (let d = 0; d < 120; d++) {
      const files: Record<string, number> = {};
      for (let f = 0; f < 100; f++) files[`f${f}.ts`] = 200 + ((d * 7919 + f * 104729) % 9000);
      big[`pkg${d}`] = dir(`pkg${d}`, { src: dir("src", files) });
    }
    const huge = dir("repo", big);
    assert.equal(huge.files, 12_000);
    const t0 = performance.now();
    const out = layout(huge, "", 1200, 800, { maxCells: 600 });
    const ms = performance.now() - t0;
    assert.ok(out.length <= 600, `${out.length} cells`);
    assert.ok(out.length > 100, "still draws a useful amount");
    assert.ok(out.some((c) => c.kind === "rest"), "small files folded");
    assert.ok(ms < 100, `layout took ${ms.toFixed(1)}ms`);
  });
});

describe("withChanges", () => {
  test("adds missing changed files along the path, leaves known ones and the input alone", () => {
    const tree = dir("repo", { src: dir("src", { "a.ts": 10 }) });
    const out = withChanges(tree, [{ path: "src/a.ts", size: 999 }, { path: "src/new/b.ts", size: 40 }, { path: "top.ts", size: 5 }]);
    assert.equal(subtree(out, "src/a.ts")?.size, 10);
    assert.equal(subtree(out, "src/new/b.ts")?.size, 40);
    assert.equal(subtree(out, "src")?.size, 50);
    assert.equal(out.size, 55);
    assert.equal(out.files, 3);
    assert.equal(subtree(tree, "src/new"), undefined, "input untouched");
  });
});

describe("churn", () => {
  const idx = churnIndex([
    { sessionId: "s1", path: "src/a.ts", churn: 10 },
    { sessionId: "s2", path: "src/lib/c.ts", churn: 5 },
    { sessionId: "s1", path: "README.md", churn: 1 },
  ]);
  test("rolls up to every folder and the root, with the sessions behind it", () => {
    assert.equal(idx.get("src")?.churn, 15);
    assert.deepEqual([...idx.get("src")!.sessions].sort(), ["s1", "s2"]);
    assert.equal(idx.get("")?.churn, 16);
    assert.equal(idx.get("docs"), undefined);
  });
  test("a rest cell sums its members", () => {
    const rest: Cell = { x: 0, y: 0, w: 1, h: 1, path: "src/…", name: "+2", kind: "rest", depth: 0, size: 0, files: 2, open: false, members: ["src/a.ts", "src/zzz.ts"] };
    assert.equal(cellChurn(rest, idx).churn, 10);
  });
  test("heat is 0 untouched, 1 at the max, log-scaled between", () => {
    assert.equal(heat(0, 100), 0);
    assert.equal(heat(100, 100), 1);
    assert.ok(heat(10, 100) > 0.4, "small churn still visible");
  });
});

describe("currentPath (which file a session's dot sits on)", () => {
  const tool = (path: string | undefined, toolKind: string, at: number): TranscriptItem => ({ kind: "tool", toolCallId: `t${at}`, title: "", status: "completed", toolKind, ...(path ? { path } : {}), at });
  const change = (path: string, additions: number, kind: FileChange["kind"] = "modified"): FileChange => ({ path, kind, additions, deletions: 0 });
  test("the latest edit wins over later reads and over churn", () => {
    assert.equal(currentPath([tool("a.ts", "edit", 1), tool("b.ts", "edit", 2), tool("c.ts", "read", 3)], [change("z.ts", 500)]), "b.ts");
  });
  test("no edit with a path: the most-changed file, skipping deletions; then the latest file read", () => {
    assert.equal(currentPath([tool("c.ts", "read", 1), tool(undefined, "edit", 2)], [change("x.ts", 3), change("y.ts", 9), change("gone.ts", 99, "deleted")]), "y.ts");
    assert.equal(currentPath([tool("c.ts", "read", 1), tool("d.ts", "read", 2)], []), "d.ts");
    assert.equal(currentPath([], []), undefined);
  });
});

describe("placeDots", () => {
  const tree = dir("repo", {
    src: dir("src", { "a.ts": 4000, "b.ts": 3000, lib: dir("lib", { "c.ts": 2000, "d.ts": 1000 }) }),
    docs: dir("docs", { "x.md": 1500 }),
  });
  const cells = layout(tree, "", 800, 500);
  const inside = (d: { x: number; y: number }, c: Rect) => d.x >= c.x && d.x <= c.x + c.w && d.y >= c.y && d.y <= c.y + c.h;

  test("a dot sits in its file's cell", () => {
    const [d] = placeDots(cells, "", 800, 500, [{ id: "s1", path: "src/b.ts" }]);
    assert.equal(d.cell, "src/b.ts");
    assert.ok(inside(d, cells.find((c) => c.path === "src/b.ts")!));
  });
  test("an unknown or hidden file falls back to the deepest folder drawn; no path or out of view is left out", () => {
    const dots = placeDots(cells, "", 800, 500, [{ id: "a", path: "src/lib/zzz.ts" }, { id: "b", path: "elsewhere/q.ts" }, { id: "c" }]);
    assert.deepEqual(dots.map((d) => [d.id, d.cell]), [["a", "src/lib"], ["b", ""]]);
    const zoomed = layout(subtree(tree, "docs")!, "docs", 400, 300);
    assert.deepEqual(placeDots(zoomed, "docs", 400, 300, [{ id: "a", path: "src/a.ts" }, { id: "b", path: "docs/x.md" }]).map((d) => d.id), ["b"]);
  });
  test("a file folded into a +N cell puts its dot there", () => {
    const rest: Cell = { x: 10, y: 10, w: 40, h: 40, path: "src/…", name: "+2", kind: "rest", depth: 0, size: 2, files: 2, open: false, members: ["src/s1", "src/s2"] };
    const [d] = placeDots([rest], "", 100, 100, [{ id: "x", path: "src/s2" }]);
    assert.equal(d.cell, "src/…");
    assert.ok(inside(d, rest));
  });
  test("several dots in one cell sit side by side, not on top of each other", () => {
    const dots = placeDots(cells, "", 800, 500, [{ id: "a", path: "src/a.ts" }, { id: "b", path: "src/a.ts" }, { id: "c", path: "src/a.ts" }]);
    const xs = dots.map((d) => d.x);
    assert.equal(new Set(xs).size, 3);
    assert.ok(dots.every((d) => d.y === dots[0].y));
  });
});
