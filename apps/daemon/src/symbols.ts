// Symbol-level change map: which functions/classes/methods/types changed in each file.
// Structure comes from tree-sitter (old = `base:path`, new = working tree); "changed" comes from
// `git diff -U0` hunk ranges. The model never invents symbols — this is the ground truth it labels.
import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import type * as TSW from "@vscode/tree-sitter-wasm";
import type { FileChange, SymbolChange } from "@perzian/protocol";

const exec = promisify(execFile);

const MAX_FILES = 200;
const MAX_BYTES = 1_000_000;

type Kind = SymbolChange["kind"];
type Lang = "typescript" | "tsx" | "javascript" | "python" | "go";
type TSNode = TSW.Node;

const EXT: Record<string, Lang> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
};

export function languageFor(path: string): Lang | undefined {
  if (path.endsWith(".d.ts")) return "typescript";
  return EXT[extname(path).toLowerCase()];
}

// ---------- tree-sitter loading (cached for the process lifetime) ----------

const require = createRequire(import.meta.url);
let runtime: Promise<{ TS: typeof TSW; dir: string }> | undefined;
const languages = new Map<Lang, Promise<TSW.Language>>();
let parser: TSW.Parser | undefined;

function loadRuntime(): Promise<{ TS: typeof TSW; dir: string }> {
  runtime ??= (async () => {
    const entry = require.resolve("@vscode/tree-sitter-wasm");
    const dir = dirname(entry);
    const TS = require(entry) as typeof TSW;
    await TS.Parser.init({ locateFile: (file: string) => join(dir, file) });
    return { TS, dir };
  })();
  runtime.catch(() => (runtime = undefined)); // allow a retry after a failed init
  return runtime;
}

async function language(lang: Lang): Promise<TSW.Language> {
  let p = languages.get(lang);
  if (!p) {
    p = loadRuntime().then(({ TS, dir }) => TS.Language.load(join(dir, `tree-sitter-${lang}.wasm`)));
    p.catch(() => languages.delete(lang));
    languages.set(lang, p);
  }
  return p;
}

// ---------- declaration extraction ----------

export interface Decl {
  name: string; // qualified: "Class.method"
  kind: Kind;
  start: number; // 1-based, inclusive
  end: number; // 1-based, inclusive
  parent?: string;
}

const JSX = new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);
const FUNC_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const CLASS_VALUES = new Set(["class", "class_expression"]);

function containsJsx(node: TSNode): boolean {
  const c = node.walk();
  try {
    for (;;) {
      if (JSX.has(c.nodeType)) return true;
      if (c.gotoFirstChild()) continue;
      while (!c.gotoNextSibling()) if (!c.gotoParent()) return false;
    }
  } finally {
    c.delete();
  }
}

const capitalized = (s: string) => /^[A-Z]/.test(s);

class Collector {
  readonly decls = new Map<string, Decl>();
  constructor(private readonly jsx: boolean) {}

  add(name: string | undefined, kind: Kind, range: TSNode, parent?: string): string | undefined {
    if (!name) return undefined;
    const qualified = parent ? `${parent}.${name}` : name;
    const { start, end } = lines(range);
    const prev = this.decls.get(qualified);
    if (prev) {
      // overloads, getter/setter pairs, `declare` + impl: one symbol spanning all of them
      prev.start = Math.min(prev.start, start);
      prev.end = Math.max(prev.end, end);
    } else {
      this.decls.set(qualified, { name: qualified, kind, start, end, ...(parent ? { parent } : {}) });
    }
    return qualified;
  }

  // A capitalized function whose body renders JSX is a React component.
  fnKind(name: string | undefined, body: TSNode): Kind {
    return this.jsx && name && capitalized(name) && containsJsx(body) ? "component" : "function";
  }
}

// Line span of a node, extended upward over directly attached comments (doc comments count as the symbol).
function lines(node: TSNode): { start: number; end: number } {
  let startRow = node.startPosition.row;
  let prev = node.previousNamedSibling;
  while (prev && prev.type === "comment" && prev.endPosition.row >= startRow - 1) {
    startRow = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  let endRow = node.endPosition.row;
  if (node.endPosition.column === 0 && endRow > node.startPosition.row) endRow--;
  return { start: startRow + 1, end: endRow + 1 };
}

const field = (n: TSNode, name: string) => n.childForFieldName(name);
const nameOf = (n: TSNode) => field(n, "name")?.text;
const named = (n: TSNode) => n.namedChildren.filter((c): c is TSNode => !!c);

// --- TypeScript / JavaScript ---

function jsTop(c: Collector, node: TSNode, range: TSNode = node): void {
  switch (node.type) {
    case "export_statement": {
      const decl = field(node, "declaration");
      if (decl) return jsTop(c, decl, node);
      const value = field(node, "value"); // export default <expr>
      if (value && FUNC_VALUES.has(value.type)) c.add(value.childForFieldName("name")?.text ?? "default", c.fnKind("Default", value), node);
      else if (value && CLASS_VALUES.has(value.type)) jsClass(c, value, node, value.childForFieldName("name")?.text ?? "default");
      else for (const child of named(node)) if (child.type.endsWith("declaration")) jsTop(c, child, node); // export default function f() {}
      return;
    }
    case "ambient_declaration": // declare function / declare class
      for (const child of named(node)) jsTop(c, child, range);
      return;
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature": {
      const name = nameOf(node);
      c.add(name, c.fnKind(name, node), range);
      return;
    }
    case "class_declaration":
    case "abstract_class_declaration":
      return jsClass(c, node, range, nameOf(node));
    case "interface_declaration":
      c.add(nameOf(node), "interface", range);
      return;
    case "type_alias_declaration":
    case "enum_declaration":
      c.add(nameOf(node), "type", range);
      return;
    case "lexical_declaration":
    case "variable_declaration": {
      const declarators = named(node).filter((d) => d.type === "variable_declarator");
      for (const d of declarators) {
        const id = field(d, "name");
        if (!id || id.type !== "identifier") continue; // skip destructuring patterns
        const value = field(d, "value");
        const span = declarators.length === 1 ? range : d;
        if (value && FUNC_VALUES.has(value.type)) c.add(id.text, c.fnKind(id.text, value), span);
        else if (value && CLASS_VALUES.has(value.type)) jsClass(c, value, span, id.text);
        else if (value && value.type === "call_expression" && capitalized(id.text) && c.fnKind(id.text, value) === "component")
          c.add(id.text, "component", span); // memo(() => <X/>), forwardRef(...)
        else c.add(id.text, "variable", span);
      }
      return;
    }
  }
}

function jsClass(c: Collector, node: TSNode, range: TSNode, name: string | undefined): void {
  const body = field(node, "body");
  const kind: Kind = c.fnKind(name, node) === "component" ? "component" : "class";
  const cls = c.add(name, kind, range);
  if (!cls || !body) return;
  for (const m of named(body)) {
    switch (m.type) {
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature":
        c.add(nameOf(m), "method", m, cls);
        break;
      case "public_field_definition": // TS
      case "field_definition": {
        // JS: `property` field
        const value = field(m, "value");
        const key = (field(m, "name") ?? field(m, "property"))?.text;
        if (value && FUNC_VALUES.has(value.type)) c.add(key, "method", m, cls);
        break;
      }
    }
  }
}

// --- Python ---

function pyTop(c: Collector, node: TSNode, range: TSNode = node, parent?: string): void {
  switch (node.type) {
    case "decorated_definition": {
      const def = field(node, "definition");
      if (def) pyTop(c, def, node, parent);
      return;
    }
    case "function_definition":
      c.add(nameOf(node), parent ? "method" : "function", range, parent);
      return;
    case "class_definition": {
      if (parent) return; // nested classes: covered by the outer class
      const cls = c.add(nameOf(node), "class", range);
      const body = field(node, "body");
      if (cls && body) for (const m of named(body)) if (m.type === "function_definition" || m.type === "decorated_definition") pyTop(c, m, m, cls);
      return;
    }
    case "type_alias_statement":
      c.add(field(node, "left")?.text, "type", range);
      return;
    case "expression_statement": {
      if (parent) return;
      const a = node.firstNamedChild;
      const left = a && a.type === "assignment" ? field(a, "left") : null;
      if (left?.type === "identifier") c.add(left.text, "variable", range);
      return;
    }
  }
}

// --- Go ---

function goTop(c: Collector, node: TSNode): void {
  switch (node.type) {
    case "function_declaration":
      c.add(nameOf(node), "function", node);
      return;
    case "method_declaration": {
      const recv = field(node, "receiver")?.descendantsOfType("type_identifier")[0]?.text;
      c.add(nameOf(node), recv ? "method" : "function", node, recv);
      return;
    }
    case "type_declaration": {
      const specs = named(node).filter((s) => s.type === "type_spec" || s.type === "type_alias");
      for (const s of specs) {
        const t = field(s, "type")?.type;
        c.add(nameOf(s), t === "interface_type" ? "interface" : "type", specs.length === 1 ? node : s);
      }
      return;
    }
    case "const_declaration":
    case "var_declaration": {
      const specs = named(node).flatMap((s) => (s.type === "var_spec_list" ? named(s) : [s]));
      const filtered = specs.filter((s) => s.type === "const_spec" || s.type === "var_spec");
      for (const s of filtered)
        for (const id of s.childrenForFieldName("name")) if (id) c.add(id.text, "variable", filtered.length === 1 ? node : s);
      return;
    }
  }
}

/** Parse `source` and return its top-level and class-member declarations. */
export async function declarations(lang: Lang, source: string): Promise<Decl[]> {
  const language_ = await language(lang);
  const { TS } = await loadRuntime();
  parser ??= new TS.Parser();
  parser.setLanguage(language_);
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    const c = new Collector(lang !== "python" && lang !== "go" && lang !== "typescript");
    for (const node of named(tree.rootNode)) {
      if (lang === "python") pyTop(c, node);
      else if (lang === "go") goTop(c, node);
      else jsTop(c, node);
    }
    return [...c.decls.values()];
  } finally {
    tree.delete();
  }
}

// ---------- git: hunks and base contents ----------

type Range = [number, number]; // 1-based inclusive

export interface FileHunks {
  oldPath?: string;
  newPath?: string;
  removed: Range[]; // old-side lines
  added: Range[]; // new-side lines
}

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 1; i < p.length - 1; i++) {
    const ch = p[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = p[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(p.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(esc[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

const headerPath = (s: string, prefix: string): string | undefined => {
  const p = unquote(s.replace(/\t$/, "")); // git appends a tab to names containing spaces
  if (p === "/dev/null") return undefined;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
};

/** Parse `git diff -U0` output into per-file changed line ranges, keyed by new path (old path for deletions). */
export function parseHunks(diff: string): Map<string, FileHunks> {
  const out = new Map<string, FileHunks>();
  let cur: FileHunks | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  const flush = () => {
    const key = cur?.newPath ?? cur?.oldPath;
    if (cur && key) out.set(key, cur);
  };
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // hunk body: count lines so content like "--- x" is never mistaken for a header
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { removed: [], added: [] };
    } else if (!cur) continue;
    else if (line.startsWith("rename from ")) cur.oldPath = unquote(line.slice(12));
    else if (line.startsWith("rename to ")) cur.newPath = unquote(line.slice(10));
    else if (line.startsWith("--- ")) cur.oldPath = headerPath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) cur.newPath = headerPath(line.slice(4), "b/");
    else if (line.startsWith("@@ ")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const [os, oc, ns, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      if (oc > 0) cur.removed.push([os, os + oc - 1]);
      if (nc > 0) cur.added.push([ns, ns + nc - 1]);
      oldLeft = oc;
      newLeft = nc;
    }
  }
  flush();
  return out;
}

async function diffHunks(cwd: string, base: string): Promise<Map<string, FileHunks>> {
  const globs = Object.keys(EXT).map((e) => `*${e}`);
  const { stdout } = await exec(
    "git",
    ["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", base, "--", ...globs],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );
  return parseHunks(stdout);
}

/** Read many `rev:path` blobs with one `git cat-file --batch`. Missing objects come back as null. */
function catFiles(cwd: string, specs: string[]): Promise<(Buffer | null)[]> {
  if (specs.length === 0) return Promise.resolve([]);
  return new Promise((resolveP, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.stdin.on("error", () => {}); // EPIPE if git dies early; handled by "close"
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const buf = Buffer.concat(chunks);
      const result: (Buffer | null)[] = [];
      let pos = 0;
      for (let i = 0; i < specs.length && pos < buf.length; i++) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString("utf8");
        pos = nl + 1;
        const m = header.match(/^\S+ (\S+) (\d+)$/);
        if (!m) {
          result.push(null); // "<spec> missing" / "ambiguous"
          continue;
        }
        const size = Number(m[2]);
        result.push(m[1] === "blob" ? buf.subarray(pos, pos + size) : null);
        pos += size + 1;
      }
      while (result.length < specs.length) result.push(null);
      resolveP(result);
    });
    child.stdin.end(specs.map((s) => s.replace(/\n/g, "")).join("\n") + "\n");
  });
}

function text(buf: Buffer | null | undefined): string | undefined {
  if (!buf || buf.length > MAX_BYTES) return undefined;
  if (buf.subarray(0, 8000).includes(0)) return undefined; // binary
  return buf.toString("utf8");
}

function readWorking(cwd: string, path: string): string | undefined {
  try {
    const full = join(cwd, path);
    if (statSync(full).size > MAX_BYTES) return undefined;
    return text(readFileSync(full));
  } catch {
    return undefined;
  }
}

// ---------- comparison ----------

const intersects = (a: Range, b: Range) => a[0] <= b[1] && b[0] <= a[1];

// Does any changed, non-blank line touch `span` outside the `exclude` spans (a class's own lines, not its methods')?
function touched(span: Range, changed: Range[], exclude: Range[], blank?: Set<number>): boolean {
  for (const r of changed) {
    if (!intersects(span, r)) continue;
    for (let line = Math.max(span[0], r[0]); line <= Math.min(span[1], r[1]); line++)
      if (!blank?.has(line) && !exclude.some((e) => line >= e[0] && line <= e[1])) return true;
  }
  return false;
}

/** 1-based numbers of whitespace-only lines; edits that only add/remove blank lines don't modify a symbol. */
export function blankLines(source: string): Set<number> {
  const out = new Set<number>();
  source.split("\n").forEach((l, i) => {
    if (l.trim() === "") out.add(i + 1);
  });
  return out;
}

/** Compare old/new declarations against the hunks. Members of an added/deleted class are folded into it. */
export function compare(
  oldDecls: Decl[],
  newDecls: Decl[],
  hunks: Pick<FileHunks, "added" | "removed">,
  blank?: { old: Set<number>; new: Set<number> },
): SymbolChange[] {
  const oldBy = new Map(oldDecls.map((d) => [d.name, d]));
  const newBy = new Map(newDecls.map((d) => [d.name, d]));
  const children = (decls: Decl[], name: string): Range[] => decls.filter((d) => d.parent === name).map((d) => [d.start, d.end]);
  const out: SymbolChange[] = [];

  for (const n of newDecls) {
    const o = oldBy.get(n.name);
    if (!o) {
      if (n.parent && newBy.has(n.parent) && !oldBy.has(n.parent)) continue; // whole class is new
      out.push({ name: n.name, kind: n.kind, change: "added", line: n.start });
    } else if (
      touched([n.start, n.end], hunks.added, children(newDecls, n.name), blank?.new) ||
      touched([o.start, o.end], hunks.removed, children(oldDecls, o.name), blank?.old)
    ) {
      out.push({ name: n.name, kind: n.kind, change: "modified", line: n.start });
    }
  }
  for (const o of oldDecls) {
    if (newBy.has(o.name)) continue;
    if (o.parent && oldBy.has(o.parent) && !newBy.has(o.parent)) continue; // whole class is gone
    out.push({ name: o.name, kind: o.kind, change: "deleted", line: o.start });
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

// Whole-file add/delete: list top-level symbols; members are folded into their class when it's in the file
// (Go methods on a type declared elsewhere are still listed).
function all(decls: Decl[], change: "added" | "deleted"): SymbolChange[] {
  const names = new Set(decls.map((d) => d.name));
  return decls.filter((d) => !d.parent || !names.has(d.parent)).map((d) => ({ name: d.name, kind: d.kind, change, line: d.start }));
}

// ---------- entry point ----------

/**
 * Fill `symbols` on each supported file (TS/TSX/JS/JSX/Python/Go). Unsupported, oversized, binary or
 * failing files come back unchanged. Never throws.
 */
export async function symbolChanges(cwd: string, base: string, files: FileChange[]): Promise<FileChange[]> {
  try {
    const targets = files.filter((f) => languageFor(f.path)).slice(0, MAX_FILES);
    if (targets.length === 0) return files;
    const needsDiff = targets.some((f) => f.kind === "modified" || f.kind === "renamed");
    const hunks = needsDiff ? await diffHunks(cwd, base).catch(() => new Map<string, FileHunks>()) : new Map<string, FileHunks>();

    // Old contents, batched. Added files have none; renames read from their old path.
    const oldPathOf = (f: FileChange) => (f.kind === "renamed" ? (hunks.get(f.path)?.oldPath ?? f.path) : f.path);
    const withOld = targets.filter((f) => f.kind !== "added");
    const blobs = await catFiles(cwd, withOld.map((f) => `${base}:${oldPathOf(f)}`)).catch(() => withOld.map(() => null));
    const oldText = new Map(withOld.map((f, i) => [f.path, text(blobs[i])]));

    const result = new Map<string, SymbolChange[]>();
    for (const f of targets) {
      try {
        const lang = languageFor(f.path)!;
        if (f.kind === "added") {
          const src = readWorking(cwd, f.path);
          if (src !== undefined) result.set(f.path, all(await declarations(lang, src), "added"));
        } else if (f.kind === "deleted") {
          const src = oldText.get(f.path);
          if (src !== undefined) result.set(f.path, all(await declarations(lang, src), "deleted"));
        } else {
          const newSrc = readWorking(cwd, f.path);
          if (newSrc === undefined) continue;
          const h = hunks.get(f.path);
          const oldSrc = oldText.get(f.path);
          const oldLang = languageFor(oldPathOf(f));
          if (oldSrc === undefined || !oldLang) {
            // no usable base version (e.g. renamed from an unsupported/oversized file): everything is new
            result.set(f.path, all(await declarations(lang, newSrc), "added"));
            continue;
          }
          const [oldDecls, newDecls] = [await declarations(oldLang, oldSrc), await declarations(lang, newSrc)];
          result.set(f.path, compare(oldDecls, newDecls, h ?? { added: [], removed: [] }, { old: blankLines(oldSrc), new: blankLines(newSrc) }));
        }
      } catch {
        // leave this file without symbols
      }
    }
    return files.map((f) => (result.has(f.path) ? { ...f, symbols: result.get(f.path)! } : f));
  } catch {
    return files;
  }
}
