// The Map: a squarified treemap of the repo's real files (git, via GET /api/tree), regions shaded by how much
// this project's sessions changed them, and each active session as a dot on the file it's working on.
// Layout lives in treemap.ts (pure, tested); this file only measures, fetches and draws.
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { RepoTree, SessionInfo, SessionStatus, State } from "@perzian/protocol";
import { fetchTree } from "./daemon.ts";
import { cellChurn, churnIndex, currentPath, heat, layout, parentOf, placeDots, subtree, withChanges, type Cell, type Touch } from "./treemap.ts";

const HEADER = 16;
/** Rough bytes per added line, to size files the tree doesn't have yet. */
const BYTES_PER_LINE = 40;
const DOT_STATUSES = new Set<SessionStatus>(["working", "needs_you", "paused"]);
const trees = new Map<string, RepoTree | null>();

/** Width of an element, read once a frame at most while it resizes (a callback ref, so it works when mounted late). */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setW(el.clientWidth));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [el]);
  return [setEl, w];
}

const lines = (n: number) => `${n.toLocaleString()} line${n === 1 ? "" : "s"} changed`;

export function RepoMap({ s, state, onFile, onOpen }: { s: SessionInfo; state: State; onFile: (path: string) => void; onOpen: (id: string) => void }) {
  const files = state.changes[s.id] ?? [];
  // Every session on this project shares the map: churn from all of them, dots for the active ones.
  const crew = useMemo(
    () => Object.values(state.sessions).filter((o) => o.project === s.project && o.role === "worker" && !o.archived && (o.id === s.id || (state.changes[o.id]?.length ?? 0) > 0 || DOT_STATUSES.has(o.status))),
    [state.sessions, state.changes, s.project, s.id],
  );
  const touches = useMemo<(Touch & { size: number })[]>(
    () => crew.flatMap((o) => (state.changes[o.id] ?? []).filter((f) => f.kind !== "deleted").map((f) => ({ sessionId: o.id, path: f.path, churn: f.additions + f.deletions, size: f.additions * BYTES_PER_LINE }))),
    [crew, state.changes],
  );

  // The tree: fetched for this session's folder, again (debounced) when the set of changed paths moves.
  // The last tree per session is kept, so reopening the tab draws at once (and refreshes behind it).
  const [base, setBase] = useState<RepoTree | null | undefined>(() => trees.get(s.id));
  const pathsKey = files.map((f) => f.path).sort().join("\n");
  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        fetchTree(s.id).then((t) => {
          trees.set(s.id, t);
          if (live) setBase(t);
        }),
      base === undefined ? 0 : 1500,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id, pathsKey]);
  // Named after the project, not the worktree folder.
  const repoName = s.project.slice(s.project.lastIndexOf("/") + 1) || "repo";
  const empty: RepoTree = useMemo(() => ({ name: repoName, size: 0, files: 0, children: [] }), [repoName]);
  const root0 = base ?? empty;
  // Only paths the tree lacks change its shape; churn alone never re-lays it out.
  const missing = touches.filter((t) => !subtree(root0, t.path));
  const missingKey = missing.map((t) => t.path).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const root = useMemo(() => withChanges(root0, missing), [root0, missingKey]);

  const [zoom, setZoom] = useState("");
  const view = subtree(root, zoom) ?? root;
  const viewPath = view === root ? "" : zoom;

  const [box, width] = useWidth();
  const w = useDeferredValue(width);
  const h = Math.round(Math.min(560, Math.max(260, w * 0.6)));
  // Nothing until the real tree is in, so the map never jumps from a changed-files-only layout.
  const cells = useMemo(() => (base === undefined ? [] : layout(view, viewPath, w, h, { header: HEADER })), [base, view, viewPath, w, h]);

  const idx = useMemo(() => churnIndex(touches), [touches]);
  const shade = useMemo(() => {
    const per = cells.map((c) => cellChurn(c, idx));
    const max = Math.max(0, ...per.filter((_, i) => !cells[i].open).map((p) => p.churn));
    return per.map((p) => ({ ...p, heat: heat(p.churn, max) }));
  }, [cells, idx]);
  const mine = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  const dotSessions = crew.filter((o) => o.id === s.id || DOT_STATUSES.has(o.status));
  const dots = placeDots(
    cells,
    viewPath,
    w,
    h,
    dotSessions.map((o) => ({ id: o.id, path: currentPath(state.transcripts[o.id] ?? [], state.changes[o.id] ?? []) })),
    12,
    HEADER,
  );

  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const click = (c: Cell) => {
    if (c.kind === "dir") setZoom(c.path);
    else if (c.kind === "rest" && parentOf(c.path) !== viewPath) setZoom(parentOf(c.path));
    else if (c.kind === "file" && mine.has(c.path)) onFile(c.path);
  };

  // Cells only re-render when the layout or the shading changes, never on hover.
  const drawn = useMemo(
    () =>
      cells.map((c, i) => {
        const { heat: k } = shade[i];
        const label = c.open ? c.w > 34 : c.w > 38 && c.h > 18;
        const clickable = c.kind === "dir" || (c.kind === "rest" && parentOf(c.path) !== viewPath) || (c.kind === "file" && mine.has(c.path));
        return (
          <div
            key={c.path}
            data-i={i}
            className={`tm-cell k-${c.kind}${c.open ? " open" : ""}${k > 0 ? " hot" : ""}${clickable ? " go" : ""}`}
            style={{ left: c.x, top: c.y, width: c.w, height: c.h, "--heat": k.toFixed(3) } as React.CSSProperties}
            {...(clickable && c.depth === 0 ? { role: "button", tabIndex: 0, "aria-label": c.kind === "file" ? `Open ${c.path}` : `Zoom into ${c.path}` } : {})}
          >
            {label && <span className="tm-label">{c.kind === "rest" ? `${c.name} small` : c.name}</span>}
          </div>
        );
      }),
    [cells, shade, mine, viewPath],
  );

  const crumbs = viewPath ? viewPath.split("/") : [];
  const hc = hover ? cells[hover.i] : undefined;
  const hs = hover ? shade[hover.i] : undefined;
  // Another running session changing the same file is a merge conflict waiting to happen.
  const others = Object.values(state.sessions).filter((o) => o.id !== s.id && o.role === "worker" && o.project === s.project && !o.archived && (o.status === "working" || o.status === "needs_you"));
  const clashes = files.flatMap((f) => {
    const with_ = others.filter((o) => (state.changes[o.id] ?? []).some((x) => x.path === f.path));
    return with_.length ? [{ path: f.path, with_ }] : [];
  });

  if (base !== undefined && !base && touches.length === 0)
    return <p className="empty">{s.status === "working" ? "No files yet. The map fills in as the agent edits." : "No files changed."}</p>;

  return (
    <div className="repomap">
      <nav className="tm-crumbs" aria-label="Map folder">
        <button className={`crumb${viewPath ? "" : " here"}`} onClick={() => setZoom("")} disabled={!viewPath}>
          {repoName}
        </button>
        {crumbs.map((part, i) => {
          const p = crumbs.slice(0, i + 1).join("/");
          const here = i === crumbs.length - 1;
          return (
            <span key={p} className="tm-crumb">
              <span className="crumb-sep" aria-hidden>/</span>
              <button className={`crumb${here ? " here" : ""}`} onClick={() => setZoom(p)} disabled={here}>{part}</button>
            </span>
          );
        })}
        <span className="sp" />
        <span className="tm-count">{(view.files ?? 0).toLocaleString()} files</span>
      </nav>
      <div
        ref={box}
        className="tm"
        style={{ height: h }}
        onMouseMove={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
          const r = e.currentTarget.getBoundingClientRect();
          setHover(el ? { i: Number(el.dataset.i), x: e.clientX - r.left, y: e.clientY - r.top } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
          if (el) click(cells[Number(el.dataset.i)]);
        }}
        onKeyDown={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
          if (el && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            click(cells[Number(el.dataset.i)]);
          }
        }}
      >
        <div key={viewPath} className="tm-layer">{drawn}</div>
        {dots.map((d) => {
          const o = state.sessions[d.id];
          if (!o) return null;
          const self = o.id === s.id;
          return (
            <button
              key={d.id}
              className={`tm-dot dot s-${o.status}${self ? " self" : ""}${o.status === "paused" ? " hollow" : ""}`}
              style={{ left: d.x, top: d.y }}
              title={`${o.title}${self ? " (this session)" : ""}`}
              aria-label={self ? `${o.title}, this session` : `Open ${o.title}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!self) onOpen(o.id);
              }}
              onMouseMove={(e) => {
                e.stopPropagation();
                setHover(null);
              }}
            />
          );
        })}
        {hc && hs && hover && (
          <div className="tm-tip" role="tooltip" style={{ left: Math.min(hover.x + 12, Math.max(0, w - 260)), top: hover.y + 16 > h - 70 ? Math.max(0, hover.y - 70) : hover.y + 16 }}>
            <code>{hc.kind === "rest" ? `${parentOf(hc.path) || repoName}/ · ${hc.members?.length ?? 0} small files` : hc.path}</code>
            <span className="quiet">
              {hc.kind === "file" ? fmtBytes(hc.size) : `${hc.files.toLocaleString()} files · ${fmtBytes(hc.size)}`}
              {hs.churn > 0 && ` · ${lines(hs.churn)}`}
            </span>
            {hs.sessions.size > 0 && (
              <span className="tm-who">
                {[...hs.sessions].map((id) => state.sessions[id]).filter(Boolean).map((o) => (
                  <span key={o.id} className={`s-${o.status}`}>
                    <i className={`dot${o.status === "paused" ? " hollow" : ""}`} />
                    {o.title}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
      </div>
      {clashes.length > 0 && (
        <ul className="tm-clash">
          {clashes.map((c) => (
            <li key={c.path}>
              <button className="link-btn" onClick={() => onFile(c.path)}><code>{c.path}</code></button>
              <span className="warn">⚠ also in {c.with_.map((o) => o.title).join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
