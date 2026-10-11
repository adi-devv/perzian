import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/* Small motion helpers. The animation itself lives in styles.css (inside prefers-reduced-motion: no-preference);
   these only keep things mounted long enough to leave, and measure moves for FLIP. */

export const EXIT_MS = 200;

export const reducedMotion = () => typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Keeps the last non-null value around for `ms` after it goes null, so it can animate out. */
export function useLinger<T>(value: T | null, ms = 170): { shown: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  useEffect(() => {
    if (value) {
      setKept(value);
      return;
    }
    const t = setTimeout(() => setKept(null), reducedMotion() ? 0 : ms);
    return () => clearTimeout(t);
  }, [value]);
  const shown = value ?? kept;
  return { shown, leaving: !value && !!shown };
}

/** The list, plus items removed in the last `ms` flagged `leaving` at their old index. The ghost is added during
 *  render, so React keeps the same DOM node and the class change can transition. */
export function useExiting<T>(items: T[], key: (t: T) => string, ms = EXIT_MS): { item: T; leaving: boolean }[] {
  const prev = useRef(items);
  const ghosts = useRef(new Map<string, { item: T; index: number }>());
  const timers = useRef(new Set<string>());
  const [, bump] = useState(0);
  const live = new Set(items.map(key));
  for (const k of ghosts.current.keys()) if (live.has(k)) ghosts.current.delete(k);
  if (!reducedMotion()) {
    prev.current.forEach((item, index) => {
      const k = key(item);
      if (!live.has(k) && !ghosts.current.has(k)) ghosts.current.set(k, { item, index });
    });
  }
  useLayoutEffect(() => {
    prev.current = items;
    for (const k of ghosts.current.keys()) {
      if (timers.current.has(k)) continue;
      timers.current.add(k);
      setTimeout(() => {
        timers.current.delete(k);
        ghosts.current.delete(k);
        bump((n) => n + 1);
      }, ms);
    }
  });
  const out = items.map((item) => ({ item, leaving: false }));
  for (const g of [...ghosts.current.values()].sort((a, b) => a.index - b.index)) out.splice(Math.min(g.index, out.length), 0, { item: g.item, leaving: true });
  return out;
}

/** A card slot that collapses its height and fades when `leaving`; the siblings follow because the height shrinks. */
export function Slot({ id, leaving, className = "", children }: { id: string; leaving: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`slot ${leaving ? "leaving" : ""} ${className}`} data-flip={id}>
      <div className="slot-in">{children}</div>
    </div>
  );
}

type Pos = { el: HTMLElement; x: number; y: number };
const measure = (root: HTMLElement | null) => {
  const out = new Map<string, Pos>();
  if (!root) return out;
  const r = root.getBoundingClientRect();
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    const b = el.getBoundingClientRect();
    out.set(el.dataset.flip!, { el, x: b.left - r.left + root.scrollLeft, y: b.top - r.top + root.scrollTop });
  });
  return out;
};

/** FLIP: when `sig` (the order of the keys) changes, elements marked data-flip slide from where they were to where they are. */
export function useFlip<T extends HTMLElement>(sig: string, ms = 200) {
  const ref = useRef<T>(null);
  const first = useRef<Map<string, Pos> | null>(null);
  const seen = useRef(sig);
  // Read before React commits the change: this is where things visibly are right now (mid-flight moves included).
  if (seen.current !== sig) {
    seen.current = sig;
    first.current = measure(ref.current);
  }
  useLayoutEffect(() => {
    const before = first.current;
    first.current = null;
    if (!before || reducedMotion()) return;
    for (const [id, now] of measure(ref.current)) {
      const was = before.get(id);
      if (!was) continue;
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      now.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: ms, easing: "ease-out" });
    }
  }, [sig]);
  return ref;
}

/** A number that pulses (opacity only) when it changes, but not on first show. */
export function Count({ n }: { n: number }) {
  const prev = useRef(n);
  const touched = useRef(false);
  if (prev.current !== n) {
    touched.current = true;
    prev.current = n;
  }
  return (
    <b key={n} className={touched.current ? "pulse" : undefined}>
      {n}
    </b>
  );
}
