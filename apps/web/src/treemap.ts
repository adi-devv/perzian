// The Map's layout: a squarified treemap of the repo's real file tree (RepoTree from the daemon), plus the
// pure helpers that put churn and session dots on it. No DOM, no React: unit-tested in apps/web/test.
// Big repos stay cheap: small files fold into one "+N" cell per folder, folders open only while they are
// big enough on screen, and the whole layout is capped at `maxCells`, so the cost tracks the screen, not the repo.
import type { FileChange, RepoTree, TranscriptItem } from "@perzian/protocol";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell extends Rect {
  /** Repo-relative path ("" is the repo root); a "rest" cell is `<folder>/…`. */
  path: string;
  name: string;
  kind: "dir" | "file" | "rest";
  /** 0 for the view's direct children. */
  depth: number;
  size: number;
  files: number;
  /** A folder drawn with its children inside (under a label strip of `header` px). */
  open: boolean;
  /** "rest": the paths folded into it. */
  members?: string[];
}

export interface LayoutOptions {
  /** Hard cap on cells drawn. */
  maxCells?: number;
  /** A child smaller than this (px²) folds into its folder's "+N" cell. */
  minArea?: number;
  /** A folder opens (shows its children) only at this size or more. */
  openMinW?: number;
  openMinH?: number;
  /** Folder label strip height and inner padding, px. */
  header?: number;
  pad?: number;
  /** Levels opened below the view. */
  maxDepth?: number;
  /** At most this many children per folder before the rest fold. */
  perDir?: number;
}

const DEFAULTS: Required<LayoutOptions> = { maxCells: 600, minArea: 160, openMinW: 64, openMinH: 44, header: 16, pad: 2, maxDepth: 4, perDir: 80 };

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
/** Layout weight: bytes plus one per file, so empty files still exist and a folder's weight is its children's sum. */
export const weight = (n: RepoTree) => n.size + (n.children ? (n.files ?? 0) : 1);

/** Worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(sum: number, min: number, max: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk 2000). `values` must be sorted biggest first; returns one rect per
 * value in the same order, tiling `r` exactly. Zero or negative values get an empty rect.
 */
export function squarify(values: number[], r: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }));
  const idx = values.map((v, i) => i).filter((i) => values[i] > 0);
  const total = idx.reduce((n, i) => n + values[i], 0);
  if (!idx.length || r.w <= 0 || r.h <= 0) return out;
  const scale = (r.w * r.h) / total;
  let { x, y, w, h } = r;
  let row: number[] = [];
  let rowSum = 0;
  let rowMin = Infinity;
  let rowMax = 0;

  const place = () => {
    // Lay the row along the shorter side, then shrink the free rect.
    if (w >= h) {
      const colW = rowSum / h;
      let cy = y;
      for (const i of row) {
        const ih = (values[i] * scale) / colW;
        out[i] = { x, y: cy, w: colW, h: ih };
        cy += ih;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = rowSum / w;
      let cx = x;
      for (const i of row) {
        const iw = (values[i] * scale) / rowH;
        out[i] = { x: cx, y, w: iw, h: rowH };
        cx += iw;
      }
      y += rowH;
      h -= rowH;
    }
    row = [];
    rowSum = 0;
    rowMin = Infinity;
    rowMax = 0;
  };

  for (const i of idx) {
    const a = values[i] * scale;
    const side = Math.min(w, h);
    if (row.length && worst(rowSum + a, Math.min(rowMin, a), Math.max(rowMax, a), side) > worst(rowSum, rowMin, rowMax, side)) place();
    row.push(i);
    rowSum += a;
    rowMin = Math.min(rowMin, a);
    rowMax = Math.max(rowMax, a);
  }
  if (row.length) place();
  return out;
}

/** The node at `path` ("" = root), or undefined. */
export function subtree(root: RepoTree, path: string): RepoTree | undefined {
  let n: RepoTree | undefined = root;
  for (const part of path.split("/").filter(Boolean)) {
    n = n.children?.find((c) => c.name === part);
    if (!n) return undefined;
  }
  return n;
}

/**
 * Children to draw for a folder of `area` px²: biggest first, at most `perDir`, each at least `minArea` on screen;
 * the rest become one "rest" entry carrying their total weight and paths.
 */
export function aggregate(children: RepoTree[], area: number, total: number, o: Pick<Required<LayoutOptions>, "minArea" | "perDir">): { keep: RepoTree[]; rest?: { weight: number; files: number; size: number; names: string[] } } {
  const sorted = [...children].sort((a, b) => weight(b) - weight(a));
  const keep: RepoTree[] = [];
  let i = 0;
  for (; i < sorted.length && keep.length < o.perDir; i++) {
    if (total > 0 && (weight(sorted[i]) / total) * area < o.minArea) break;
    keep.push(sorted[i]);
  }
  if (i >= sorted.length) return { keep };
  const left = sorted.slice(i);
  // One leftover alone is just drawn (a "+1" cell would hide a name for nothing).
  if (left.length === 1) return { keep: [...keep, left[0]] };
  return {
    keep,
    rest: {
      weight: left.reduce((n, c) => n + weight(c), 0),
      size: left.reduce((n, c) => n + c.size, 0),
      files: left.reduce((n, c) => n + (c.children ? (c.files ?? 0) : 1), 0),
      names: left.map((c) => c.name),
    },
  };
}

/**
 * Lay out `view` (the node at `viewPath`) in `w`×`h`. Breadth-first, so shallow levels win the cell budget:
 * a folder opens only when it is big enough and its children still fit under `maxCells`.
 */
export function layout(view: RepoTree, viewPath: string, w: number, h: number, opts: LayoutOptions = {}): Cell[] {
  const o = { ...DEFAULTS, ...opts };
  const cells: Cell[] = [];
  if (w <= 0 || h <= 0 || !view.children?.length) return cells;
  // cell: index of the folder's own cell, marked open once its children are placed.
  type Job = { node: RepoTree; path: string; rect: Rect; depth: number; cell?: number };
  const queue: Job[] = [{ node: view, path: viewPath, rect: { x: 0, y: 0, w, h }, depth: 0 }];

  for (let q = 0; q < queue.length; q++) {
    const { node, path, rect, depth } = queue[q];
    const kids = node.children ?? [];
    const area = rect.w * rect.h;
    const { keep, rest } = aggregate(kids, area, weight(node), o);
    const count = keep.length + (rest ? 1 : 0);
    // The view itself always opens; deeper folders only if their children fit the budget.
    if (q > 0 && cells.length + count > o.maxCells) continue;
    const own = queue[q].cell;
    if (own !== undefined) cells[own].open = true;
    const values = [...keep.map(weight), ...(rest ? [rest.weight] : [])];
    const rects = squarify(values, rect);
    keep.forEach((c, i) => {
      const r = rects[i];
      if (r.w <= 0 || r.h <= 0) return;
      const p = join(path, c.name);
      const isDir = !!c.children;
      cells.push({ ...r, path: p, name: c.name, kind: isDir ? "dir" : "file", depth, size: c.size, files: isDir ? (c.files ?? 0) : 1, open: false });
      if (isDir && c.children!.length && depth + 1 < o.maxDepth && r.w >= o.openMinW && r.h >= o.openMinH) {
        const inner = { x: r.x + o.pad, y: r.y + o.header, w: r.w - o.pad * 2, h: r.h - o.header - o.pad };
        if (inner.w > 0 && inner.h > 0) queue.push({ node: c, path: p, rect: inner, depth: depth + 1, cell: cells.length - 1 });
      }
    });
    if (rest) {
      const r = rects[keep.length];
      if (r.w > 0 && r.h > 0)
        cells.push({ ...r, path: join(path, "…"), name: `+${rest.names.length}`, kind: "rest", depth, size: rest.size, files: rest.files, open: false, members: rest.names.map((n) => join(path, n)) });
    }
  }
  return cells;
}

/** The tree with each missing changed path added as a file (new files an agent just wrote, or another worktree's). */
export function withChanges(root: RepoTree, files: { path: string; size: number }[]): RepoTree {
  let out = root;
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    if (!parts.length || subtree(out, f.path)) continue;
    const size = Math.max(0, f.size);
    const add = (n: RepoTree, i: number): RepoTree => {
      const kids = n.children ?? [];
      const name = parts[i];
      const last = i === parts.length - 1;
      const cur = kids.find((c) => c.name === name);
      const next: RepoTree = last ? { name, size } : add(cur && cur.children ? cur : { name, size: 0, files: 0, children: [] }, i + 1);
      return { ...n, size: n.size + size, files: (n.files ?? 0) + 1, children: cur ? kids.map((c) => (c === cur ? next : c)) : [...kids, next] };
    };
    out = add(out, 0);
  }
  return out;
}

export interface Touch {
  sessionId: string;
  path: string;
  churn: number;
}

/** Churn and the sessions behind it, for every file and every folder above it ("" = repo). */
export type ChurnIndex = Map<string, { churn: number; sessions: Set<string> }>;

export function churnIndex(touches: Touch[]): ChurnIndex {
  const idx: ChurnIndex = new Map();
  for (const t of touches) {
    let p = t.path;
    for (;;) {
      const e = idx.get(p) ?? { churn: 0, sessions: new Set<string>() };
      e.churn += t.churn;
      e.sessions.add(t.sessionId);
      idx.set(p, e);
      if (!p) break;
      p = parentOf(p);
    }
  }
  return idx;
}

/** A cell's churn and sessions; a "rest" cell sums its members. */
export function cellChurn(c: Cell, idx: ChurnIndex): { churn: number; sessions: Set<string> } {
  if (c.kind !== "rest") return idx.get(c.path) ?? { churn: 0, sessions: new Set() };
  const sessions = new Set<string>();
  let churn = 0;
  for (const m of c.members ?? []) {
    const e = idx.get(m);
    if (!e) continue;
    churn += e.churn;
    for (const s of e.sessions) sessions.add(s);
  }
  return { churn, sessions };
}

/** 0..1 heat for a churn amount relative to the view's biggest; log-scaled so one huge file doesn't wash out the rest. */
export const heat = (churn: number, max: number) => (churn <= 0 || max <= 0 ? 0 : Math.min(1, Math.log1p(churn) / Math.log1p(max)));

const EDIT_KINDS = new Set(["edit", "delete", "move"]);

/** Where a session is working: the file of its latest edit, else its most-changed file, else the latest file it touched at all. */
export function currentPath(items: TranscriptItem[], files: FileChange[]): string | undefined {
  let other: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i];
    if (t.kind !== "tool" || !t.path) continue;
    if (EDIT_KINDS.has(t.toolKind ?? "")) return t.path;
    other ??= t.path;
  }
  let top: FileChange | undefined;
  for (const f of files) if (f.kind !== "deleted" && (!top || f.additions + f.deletions > top.additions + top.deletions)) top = f;
  return top?.path ?? other;
}

export interface Dot {
  id: string;
  x: number;
  y: number;
  /** The cell it sits in ("" = the view itself, when nothing deeper holds its path). */
  cell: string;
}

/**
 * Put each session's dot in the deepest drawn cell holding its path (the file, a folder above it, or the "+N" cell it
 * folded into). Paths outside the view are left out. Several dots in one cell sit side by side, `gap` px apart.
 */
export function placeDots(cells: Cell[], viewPath: string, w: number, h: number, sessions: { id: string; path?: string }[], gap = 12, header = DEFAULTS.header): Dot[] {
  const byPath = new Map<string, Cell>();
  for (const c of cells) {
    if (c.kind === "rest") for (const m of c.members ?? []) byPath.set(m, c);
    else byPath.set(c.path, c);
  }
  const inView = (p: string) => !viewPath || p === viewPath || p.startsWith(`${viewPath}/`);
  const groups = new Map<string, { cell?: Cell; ids: string[] }>();
  for (const s of sessions) {
    if (s.path === undefined || !inView(s.path)) continue;
    let p = s.path;
    let cell: Cell | undefined;
    while (p && p !== viewPath && !(cell = byPath.get(p))) p = parentOf(p);
    const key = cell?.path ?? "";
    const g = groups.get(key) ?? { cell, ids: [] };
    g.ids.push(s.id);
    groups.set(key, g);
  }
  const dots: Dot[] = [];
  for (const [key, { cell, ids }] of groups) {
    const r: Rect = cell ?? { x: 0, y: 0, w, h };
    // An open folder is covered by its children: sit in its label strip, right-aligned. Otherwise the middle.
    const strip = !cell || cell.open;
    const cy = strip ? r.y + Math.min(header, r.h) / 2 : r.y + r.h / 2;
    const span = (ids.length - 1) * gap;
    const right = r.x + r.w - 8;
    const start = strip ? right - span : r.x + r.w / 2 - span / 2;
    ids.forEach((id, i) => {
      const x = Math.max(r.x + 4, Math.min(r.x + r.w - 4, start + i * gap));
      dots.push({ id, x, y: cy, cell: key });
    });
  }
  return dots;
}
