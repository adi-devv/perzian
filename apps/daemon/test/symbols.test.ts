import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChange, SymbolChange } from "@perzian/protocol";
import { changes } from "../src/git.ts";
import { blankLines, compare, declarations, languageFor, parseHunks, symbolChanges } from "../src/symbols.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(files: Record<string, string>): { root: string; repo: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "perzian-sym-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  run(repo, "init", "-q");
  run(repo, "config", "user.email", "test@example.com");
  run(repo, "config", "user.name", "Test");
  run(repo, "config", "commit.gpgsign", "false");
  run(repo, "config", "core.hooksPath", join(root, "no-hooks"));
  write(repo, files);
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "init");
  return { root, repo, base: run(repo, "rev-parse", "HEAD") };
}

function write(repo: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

const brief = (s: SymbolChange[] | undefined) => (s ?? []).map((x) => `${x.change} ${x.kind} ${x.name}@${x.line}`);

const STORE_TS = `import { x } from "./x";

/** A store. */
export class Store {
  items: string[] = [];

  add(item: string) {
    this.items.push(item);
  }

  remove(item: string) {
    this.items = this.items.filter((i) => i !== item);
  }

  clear() {
    this.items = [];
  }
}

export function helper(a: number) {
  return a + 1;
}

export const double = (n: number) => n * 2;

export interface Options {
  verbose: boolean;
}

export type Id = string;

function untouched() {
  return 42;
}
`;

describe("symbols: declarations", () => {
  test("languageFor maps extensions", () => {
    assert.equal(languageFor("a/b.ts"), "typescript");
    assert.equal(languageFor("a/b.d.ts"), "typescript");
    assert.equal(languageFor("App.TSX"), "tsx");
    assert.equal(languageFor("x.mjs"), "javascript");
    assert.equal(languageFor("x.jsx"), "javascript");
    assert.equal(languageFor("x.py"), "python");
    assert.equal(languageFor("main.go"), "go");
    assert.equal(languageFor("README.md"), undefined);
    assert.equal(languageFor("Makefile"), undefined);
  });

  test("typescript: classes, members, functions, arrows, interfaces, types, overloads", async () => {
    const d = await declarations("typescript", STORE_TS);
    const by = Object.fromEntries(d.map((x) => [x.name, x]));
    assert.deepEqual(
      d.map((x) => `${x.kind} ${x.name} ${x.start}-${x.end}`),
      [
        "class Store 3-18", // includes its doc comment
        "method Store.add 7-9",
        "method Store.remove 11-13",
        "method Store.clear 15-17",
        "function helper 20-22",
        "function double 24-24",
        "interface Options 26-28",
        "type Id 30-30",
        "function untouched 32-34",
      ],
    );
    assert.equal(by["Store.add"].parent, "Store");

    const more = await declarations(
      "typescript",
      "function over(a: string): void;\nfunction over(a: any) {}\nenum Color { Red }\ndeclare function amb(): void;\nconst { a, b } = obj;\nlet n = 1, m = () => 2;\nabstract class A { abstract go(): void; field = () => 1; plain = 3; }\n",
    );
    assert.deepEqual(
      more.map((x) => `${x.kind} ${x.name} ${x.start}-${x.end}`),
      ["function over 1-2", "type Color 3-3", "function amb 4-4", "variable n 6-6", "function m 6-6", "class A 7-7", "method A.go 7-7", "method A.field 7-7"],
    );
  });

  test("tsx/jsx: React components are detected", async () => {
    const src = [
      "export function Button() { return <button/>; }",
      "export const Card = ({ title }: P) => <div>{title}</div>;",
      "export const Memoed = memo(() => <span/>);",
      "export function format() { return 'x'; }",
      "export const Upper = () => 1;",
      "export default function App() { return <><Button/></>; }",
      "class Old extends React.Component { render() { return <p/>; } }",
    ].join("\n");
    const d = await declarations("tsx", src);
    assert.deepEqual(
      d.map((x) => `${x.kind} ${x.name}`),
      ["component Button", "component Card", "component Memoed", "function format", "function Upper", "component App", "component Old", "method Old.render"],
    );
    const js = await declarations("javascript", "export const App = () => <div/>;\nclass K { f = () => 1; m() {} }\n");
    assert.deepEqual(js.map((x) => `${x.kind} ${x.name}`), ["component App", "class K", "method K.f", "method K.m"]);
  });

  test("python: functions, decorated, classes, methods, module variables", async () => {
    const d = await declarations("python", "import os\nX = 1\n\n@cache\ndef f():\n    pass\n\nclass C(Base):\n    y = 2\n\n    @property\n    def m(self):\n        return 1\n\n    def n(self):\n        pass\n");
    assert.deepEqual(
      d.map((x) => `${x.kind} ${x.name} ${x.start}-${x.end}`),
      ["variable X 2-2", "function f 4-6", "class C 8-16", "method C.m 11-13", "method C.n 15-16"],
    );
  });

  test("go: functions, methods (receiver-qualified), structs, interfaces, consts", async () => {
    const d = await declarations("go", "package x\n\n// F does things.\nfunc F() {}\n\nfunc (r *Repo[T]) Save() error { return nil }\n\ntype (\n\tS struct{}\n\tI interface{}\n)\n\nconst Max = 3\n");
    assert.deepEqual(
      d.map((x) => `${x.kind} ${x.name} ${x.start}-${x.end}`),
      ["function F 3-4", "method Repo.Save 6-6", "type S 9-9", "interface I 10-10", "variable Max 13-13"],
    );
  });

  test("broken source still yields what parses", async () => {
    const d = await declarations("typescript", "export function ok() {}\nfunction broken( {\n");
    assert.ok(d.some((x) => x.name === "ok"));
  });
});

describe("symbols: hunks + compare", () => {
  test("parseHunks reads ranges, renames, deletions, and isn't fooled by '--- ' content", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3 +3 @@ x",
      "-old",
      "+new",
      "@@ -10,2 +9,0 @@",
      "--- removed line that looks like a header",
      "-+++ another",
      "@@ -20,0 +19,3 @@",
      "+a",
      "+b",
      "+c",
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 90%",
      "rename from old name.ts",
      "rename to new name.ts",
      "--- a/old name.ts\t",
      "+++ b/new name.ts\t",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      'diff --git "a/q\\"u.ts" "b/q\\"u.ts"',
      '--- "a/q\\"u.ts"',
      '+++ "b/q\\"u.ts"',
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n");
    const h = parseHunks(diff);
    assert.deepEqual([...h.keys()], ["a.ts", "new name.ts", "gone.ts", 'q"u.ts']);
    assert.deepEqual(h.get("a.ts"), { oldPath: "a.ts", newPath: "a.ts", removed: [[3, 3], [10, 11]], added: [[3, 3], [19, 21]] });
    assert.equal(h.get("new name.ts")!.oldPath, "old name.ts");
    assert.deepEqual(h.get("gone.ts"), { oldPath: "gone.ts", newPath: undefined, removed: [[1, 2]], added: [] });
  });

  test("compare: class flagged only for its own lines, not its members'", () => {
    const old = [
      { name: "C", kind: "class" as const, start: 1, end: 10 },
      { name: "C.a", kind: "method" as const, start: 3, end: 5, parent: "C" },
      { name: "C.b", kind: "method" as const, start: 7, end: 9, parent: "C" },
    ];
    // only C.a's body changed
    assert.deepEqual(brief(compare(old, old, { added: [[4, 4]], removed: [[4, 4]] })), ["modified method C.a@3"]);
    // the class header changed
    assert.deepEqual(brief(compare(old, old, { added: [[1, 1]], removed: [[1, 1]] })), ["modified class C@1"]);
    // pure deletion of lines inside C.b (old side only)
    assert.deepEqual(brief(compare(old, old, { added: [], removed: [[8, 8]] })), ["modified method C.b@7"]);
    // a blank line added between members doesn't modify the class
    const blank = { old: blankLines("\n\n\n\n\n\n"), new: blankLines("\n\n\n\n\n\n") };
    assert.deepEqual(brief(compare(old, old, { added: [[6, 6]], removed: [] }, blank)), []);
    assert.deepEqual(brief(compare(old, old, { added: [[6, 6]], removed: [] })), ["modified class C@1"]);
  });
});

describe("symbols: symbolChanges against a real repo", () => {
  let root: string;
  let repo: string;
  let base: string;

  before(() => {
    ({ root, repo, base } = makeRepo({
      "src/store.ts": STORE_TS,
      "src/gone.ts": "export function bye() {}\nexport class Old { m() {} }\n",
      "src/rename-me.ts": "export function stays() {\n  return 1;\n}\n\nexport function edited() {\n  return 1;\n}\n",
      "src/ui/App.tsx": "export function App() {\n  return <div>hi</div>;\n}\n",
      "py/mod.py": "def keep():\n    return 1\n\ndef change():\n    return 1\n\nclass K:\n    def m(self):\n        return 1\n",
      "go/main.go": "package main\n\nfunc A() int {\n\treturn 1\n}\n\nfunc B() int {\n\treturn 2\n}\n",
      "notes.md": "# notes\n",
      "data.json": "{}\n",
    }));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("clean tree: nothing to do", async () => {
    assert.deepEqual(await symbolChanges(repo, base, []), []);
  });

  test("modified / added / deleted / renamed files across languages", async () => {
    // store.ts: edit Store.add, delete Store.clear, add Store.size, change helper, add newFn, rename Id->Key
    write(repo, {
      "src/store.ts": STORE_TS.replace("this.items.push(item);", "this.items.push(item.trim());")
        .replace("  clear() {\n    this.items = [];\n  }\n", "  size() {\n    return this.items.length;\n  }\n")
        .replace("return a + 1;", "return a + 2;")
        .replace("export type Id = string;", "export type Key = string;\n\nexport function newFn() {}"),
      "src/ui/App.tsx": "export function App() {\n  return <div>hello</div>;\n}\n\nexport const Badge = () => <span/>;\n",
      "src/ui/New.tsx": "export function New() { return <i/>; }\nexport class Widget { go() {} }\n",
      "py/mod.py": "def keep():\n    return 1\n\ndef change():\n    return 2\n\nclass K:\n    def m(self):\n        return 1\n\n    def added(self):\n        pass\n",
      "go/main.go": "package main\n\nfunc A() int {\n\treturn 1\n}\n\nfunc B() int {\n\treturn 3\n}\n\nfunc (s *Srv) Run() {}\n",
      "notes.md": "# notes\nmore\n",
    });
    unlinkSync(join(repo, "src/gone.ts"));
    run(repo, "mv", "src/rename-me.ts", "src/renamed.ts");
    write(repo, { "src/renamed.ts": "export function stays() {\n  return 1;\n}\n\nexport function edited() {\n  return 2;\n}\n" });

    const files = await changes(repo, base);
    const out = await symbolChanges(repo, base, files);
    const by = Object.fromEntries(out.map((f) => [f.path, f]));

    assert.deepEqual(brief(by["src/store.ts"].symbols), [
      "modified method Store.add@7",
      "deleted method Store.clear@15",
      "added method Store.size@15",
      "modified function helper@20",
      "deleted type Id@30",
      "added type Key@30",
      "added function newFn@32",
    ]);
    assert.deepEqual(brief(by["src/ui/App.tsx"].symbols), ["modified component App@1", "added component Badge@5"]);
    // whole new file: members folded into their class
    assert.deepEqual(brief(by["src/ui/New.tsx"].symbols), ["added component New@1", "added class Widget@2"]);
    assert.deepEqual(brief(by["src/gone.ts"].symbols), ["deleted function bye@1", "deleted class Old@2"]);
    assert.equal(by["src/renamed.ts"].kind, "renamed");
    assert.deepEqual(brief(by["src/renamed.ts"].symbols), ["modified function edited@5"]);
    assert.deepEqual(brief(by["py/mod.py"].symbols), ["modified function change@4", "added method K.added@11"]);
    // Go method on a type declared elsewhere is still reported
    assert.deepEqual(brief(by["go/main.go"].symbols), ["modified function B@7", "added method Srv.Run@11"]);
    // unsupported languages pass through untouched
    assert.equal(by["notes.md"].symbols, undefined);
    assert.deepEqual(by["notes.md"], files.find((f) => f.path === "notes.md"));
    // other fields are preserved
    assert.equal(by["src/store.ts"].additions, files.find((f) => f.path === "src/store.ts")!.additions);
  });

  test("a supported file with only non-symbol edits gets an empty list", async () => {
    const { root: r2, repo: rp, base: b } = makeRepo({ "a.ts": "import x from 'x';\n\nexport function f() {}\n" });
    try {
      write(rp, { "a.ts": "import x from 'y';\n\nexport function f() {}\n" });
      const out = await symbolChanges(rp, b, await changes(rp, b));
      assert.deepEqual(out[0].symbols, []);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });

  test("committed work after base and pure deletions inside a function", async () => {
    const { root: r2, repo: rp, base: b } = makeRepo({ "a.ts": "export function f() {\n  one();\n  two();\n}\n\nexport function g() {}\n" });
    try {
      write(rp, { "a.ts": "export function f() {\n  one();\n}\n\nexport function g() {}\n" });
      run(rp, "commit", "-q", "-am", "work");
      const out = await symbolChanges(rp, b, await changes(rp, b));
      assert.deepEqual(brief(out[0].symbols), ["modified function f@1"]);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });

  test("never throws: bad cwd, bad base, oversized and binary files", async () => {
    const files: FileChange[] = [{ path: "x.ts", kind: "modified", additions: 1, deletions: 1 }];
    assert.deepEqual(await symbolChanges(join(root, "nope"), "HEAD", files), files);
    assert.deepEqual(await symbolChanges(repo, "deadbeef", files), files);

    const { root: r2, repo: rp, base: b } = makeRepo({ "small.ts": "export const a = 1;\n" });
    try {
      write(rp, { "big.ts": "export const x = 1;\n" + "// pad\n".repeat(200_000), "bin.ts": "export const a\u0000 = 1;\n" });
      const out = await symbolChanges(rp, b, await changes(rp, b));
      const by = Object.fromEntries(out.map((f) => [f.path, f]));
      assert.equal(by["big.ts"].symbols, undefined);
      assert.equal(by["bin.ts"].symbols, undefined);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });

  test("caps the number of analyzed files", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 205; i++) many[`f${String(i).padStart(3, "0")}.ts`] = `export const v${i} = ${i};\n`;
    const { root: r2, repo: rp } = makeRepo({ "seed.txt": "x\n" });
    try {
      const b = run(rp, "rev-parse", "HEAD");
      write(rp, many);
      const files = await changes(rp, b);
      const t0 = Date.now();
      const out = await symbolChanges(rp, b, files);
      const elapsed = Date.now() - t0;
      assert.equal(out.filter((f) => f.symbols).length, 200);
      assert.equal(out.length, 205);
      assert.ok(elapsed < 5000, `took ${elapsed}ms`);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });
});
