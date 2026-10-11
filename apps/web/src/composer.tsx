import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IMAGE_TYPES, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_IMAGE_BYTES, WINDOW_NAME, usageNotice, type AgentCommand, type AttachmentInfo, type AttachmentRef, type Command, type LimitWindow, type SessionInfo, type State } from "@perzian/protocol";
import { api } from "./daemon.ts";
import { cost } from "./bits.tsx";

type Send = (c: Command) => void;

/* The composer: one rounded box with only the textarea (and attachments) in it, quiet controls below it, and a
   slim usage line above. Used by the lead and by every session. Attachments upload on add (the daemon keeps the
   bytes); the UI holds only previews and ids, and the prompt carries ids. */

interface Pending {
  key: string;
  name: string;
  image: boolean;
  /** Local preview of an image (object URL); never sent anywhere. */
  preview?: string;
  state: "uploading" | "ready" | "failed";
  info?: AttachmentInfo;
}

const extOf = (name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1].toLowerCase() ?? "";

/** Why a file can't be attached, or null. Mirrors the daemon's check (it enforces it too). */
export function attachProblem(f: { name: string; size: number }, count: number): string | null {
  if (count >= MAX_ATTACHMENTS) return `Up to ${MAX_ATTACHMENTS} attachments.`;
  if (f.size <= 0) return `${f.name} is empty.`;
  if (extOf(f.name) in IMAGE_TYPES && f.size > MAX_IMAGE_BYTES) return "Images can be up to 5 MB.";
  if (f.size > MAX_FILE_BYTES) return "Files can be up to 25 MB.";
  return null;
}

async function upload(f: File): Promise<AttachmentInfo> {
  const res = await fetch(api(`/api/attachments?name=${encodeURIComponent(f.name)}`), { method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
  if (!res.ok) throw new Error((await res.text()) || "Upload failed");
  return (await res.json()) as AttachmentInfo;
}

export interface ComposerProps {
  id: string;
  /** Accessible name: who it talks to. */
  to: string;
  placeholder: string;
  focus?: boolean;
  busy?: boolean;
  /** Why sending isn't possible yet; typing still works and the text is kept. */
  blocked?: string;
  onSubmit: (text: string, attachments: string[]) => void;
  onStop?: () => void;
  /** Slim line(s) above the box (usage). */
  above?: React.ReactNode;
  /** Controls after "+": the lead's mode picker, project chip. */
  left?: React.ReactNode;
  /** Controls at the right: the model picker. */
  right?: React.ReactNode;
  /** The context ring. */
  ring?: React.ReactNode;
  /** Slash commands offered when the text starts with "/". */
  commands?: AgentCommand[];
  /** Fills the box (suggestion chips); a new `n` replaces the text and focuses it. */
  seed?: { text: string; n: number };
}

export function Composer({ id, to, placeholder, focus, busy, blocked, onSubmit, onStop, above, left, right, ring, commands, seed }: ComposerProps) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Pending[]>([]);
  const [problem, setProblem] = useState("");
  const [over, setOver] = useState(false);
  const [menuOff, setMenuOff] = useState(false);
  const [sel, setSel] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const live = useRef(atts);
  live.current = atts;
  useEffect(() => () => live.current.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)), []);
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
    });
  }, [seed?.n]);

  const add = (files: File[]) => {
    let count = live.current.length;
    const next: Pending[] = [];
    let why = "";
    for (const f of files) {
      const p = attachProblem(f, count);
      if (p) {
        why = p;
        continue;
      }
      count++;
      const key = crypto.randomUUID();
      const image = extOf(f.name) in IMAGE_TYPES;
      next.push({ key, name: f.name, image, state: "uploading", ...(image ? { preview: URL.createObjectURL(f) } : {}) });
      upload(f).then(
        (info) => setAtts((a) => a.map((x) => (x.key === key ? { ...x, state: "ready", info } : x))),
        (e) => {
          setProblem(String((e as Error).message ?? e).slice(0, 120));
          setAtts((a) => a.map((x) => (x.key === key ? { ...x, state: "failed" } : x)));
        },
      );
    }
    setProblem(why);
    if (next.length) setAtts((a) => [...a, ...next]);
  };
  const remove = (key: string) =>
    setAtts((a) => {
      const gone = a.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return a.filter((x) => x.key !== key);
    });

  const ready = atts.filter((a) => a.state === "ready");
  const uploading = atts.some((a) => a.state === "uploading");
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !blocked;
  const submit = () => {
    if (!canSend) return;
    onSubmit(text.trim(), ready.map((a) => a.info!.id));
    atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAtts([]);
    setProblem("");
    setText("");
  };

  // "/" at the start: the agent's commands, filtered by what's typed after it.
  const q = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  const list =
    commands?.length && q !== undefined && !menuOff
      ? commands
          .filter((c) => c.name.toLowerCase().includes(q))
          .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
          .slice(0, 8)
      : [];
  const at = Math.min(sel, Math.max(0, list.length - 1));
  const insert = (c: AgentCommand) => {
    setText(`/${c.name} `);
    setMenuOff(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (list.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text.trim().slice(1) !== list[at].name)) {
        e.preventDefault();
        insert(list[at]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenuOff(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {above}
      <div className="cwrap">
        {list.length > 0 && (
          <ul className="slash" role="listbox" aria-label="Commands">
            {list.map((c, i) => (
              <li key={c.name} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); insert(c); }} onMouseEnter={() => setSel(i)}>
                <b>/{c.name}</b>
                {c.hint && <em>{c.hint}</em>}
                {c.description && <span>{c.description}</span>}
              </li>
            ))}
          </ul>
        )}
        <div
          className={`cbox${over ? " over" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setOver(false);
            add([...e.dataTransfer.files]);
          }}
        >
          {atts.length > 0 && (
            <ul className="atts" aria-label="Attachments">
              {atts.map((a) => (
                <li key={a.key} className={`att ${a.image ? "img" : "file"} ${a.state}`} title={a.name}>
                  {a.image && a.preview ? <img src={a.preview} alt={a.name} /> : <span className="att-name">{a.name}</span>}
                  <button type="button" className="att-x" aria-label={`Remove ${a.name}`} onClick={() => remove(a.key)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="cin">
            <textarea
              ref={area}
              id={id}
              aria-label={to}
              rows={1}
              autoFocus={focus}
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value);
                setMenuOff(false);
                setSel(0);
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (!files.length) return;
                e.preventDefault();
                add(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now() % 100000}-${i + 1}.${extOf(f.name) || f.type.split("/")[1] || "png"}`, { type: f.type }))));
              }}
            />
            {busy && onStop && (
              <button type="button" className="stop" aria-label="Stop" title="Stop" onClick={onStop}>
                <i aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
      {problem && <p className="att-problem" role="status">{problem}</p>}
      <div className="crow">
        <button type="button" className="cbtn" aria-label="Attach files or images" title="Attach files or images" onClick={() => picker.current?.click()}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        {left}
        <span className="grow" />
        {right}
        {ring}
        <button className="sr-only" disabled={!canSend} title={blocked}>Send</button>
      </div>
    </form>
  );
}

/* ───────────── In the transcript: what was attached to a message ───────────── */

export function Attached({ items }: { items?: AttachmentRef[] }) {
  if (!items?.length) return null;
  return (
    <span className="attached">
      {items.map((a) =>
        a.image ? (
          <a key={a.id} href={api(`/api/attachments/${a.id}`)} target="_blank" rel="noreferrer" title={a.name}>
            <img src={api(`/api/attachments/${a.id}`)} alt={a.name} loading="lazy" />
          </a>
        ) : (
          <span key={a.id} className="att file" title={a.name}>
            <span className="att-name">{a.name}</span>
          </span>
        ),
      )}
    </span>
  );
}

/* ───────────── Above the box: slim, grey, informational ───────────── */

/** "Sun 2:30 AM", or just the time when it is within a day. */
export function resetText(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  return ts - now < 24 * 3_600_000 ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function UsageLine({ state, send }: { state: State; send: Send }) {
  const n = usageNotice(state.usage, Date.now());
  if (!n) return null;
  return (
    <div className="usage-line" role="status">
      <span>
        On pace to hit your {WINDOW_NAME[n.window]} limit early · {Math.round(n.utilization * 100)}% used · Resets {resetText(n.resetsAt)}
      </span>
      <button type="button" className="icon" aria-label="Dismiss" title="Dismiss for this window" onClick={() => send({ type: "usage.dismiss", key: n.key })}>
        ✕
      </button>
    </div>
  );
}

/* ───────────── The context ring and its popover ───────────── */

const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
// Claude Code auto-compacts when the window is within about this many tokens of full.
const COMPACT_BUFFER = 33_000;
const WINDOW_ORDER: LimitWindow[] = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
const WINDOW_LABEL: Partial<Record<LimitWindow, string>> = { five_hour: "Session limit", seven_day: "Weekly · all models", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet" };

function inText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h} hr ${min % 60} min` : `${min} min`;
}

const bar = (frac: number) => (
  <span className={`pbar${frac >= 0.95 ? " warn" : ""}`} aria-hidden>
    <i style={{ width: `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%` }} />
  </span>
);

/** A small circle: how full this session's context window is. Click for the numbers, the plan limits and a per-session breakdown. */
export function ContextRing({ s, state, send }: { s?: SessionInfo; state: State; send: Send }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const u = s?.usage;
  const frac = u?.contextSize && u.contextUsed !== undefined ? Math.min(1, u.contextUsed / u.contextSize) : undefined;
  const windows = WINDOW_ORDER.map((w) => state.usage.windows[w]).filter((r): r is NonNullable<typeof r> => !!r && r.resetsAt > now);
  const canCompact = !!s?.commands?.some((c) => c.name === "compact");

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) setDetail(false);
  }, [open]);

  if (frac === undefined && !windows.length) return null;
  const C = 2 * Math.PI * 6.5;
  const pct = frac === undefined ? undefined : Math.round(frac * 100);
  const toCompact = u?.contextSize && u.contextUsed !== undefined && u.contextSize > COMPACT_BUFFER * 2 && s?.agent === "claude-code" ? Math.max(0, u.contextSize - COMPACT_BUFFER - u.contextUsed) : undefined;
  const sessions = Object.values(state.sessions)
    .filter((x) => !x.archived && x.usage?.costUsd !== undefined)
    .sort((a, b) => (b.usage!.costUsd ?? 0) - (a.usage!.costUsd ?? 0));
  const total = sessions.reduce((n, x) => n + (x.usage!.costUsd ?? 0), 0);

  return (
    <div className="ring-wrap" ref={box}>
      <button type="button" className={`ring${frac !== undefined && frac >= 0.95 ? " warn" : ""}`} aria-label={pct === undefined ? "Usage" : `Context ${pct}% full`} aria-expanded={open} title={pct === undefined ? "Usage" : `Context ${pct}% full`} onClick={() => setOpen((v) => !v)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r="6.5" className="ring-track" />
          {frac !== undefined && <circle cx="9" cy="9" r="6.5" className="ring-arc" strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 9 9)" />}
        </svg>
      </button>
      {open && (
        <div className="ring-pop" role="dialog" aria-label="Context and usage">
          {frac !== undefined && u?.contextSize !== undefined && u.contextUsed !== undefined && (
            <section>
              <h4>Context window</h4>
              <p className="pline">
                <span>{k(u.contextUsed)} / {k(u.contextSize)} ({pct}%)</span>
              </p>
              {bar(frac)}
              {toCompact !== undefined && <p className="pnote" title="Estimated: Claude Code compacts shortly before the window is full">{k(toCompact)} until auto-compact</p>}
              {canCompact && s && (
                <button type="button" className="btn small" disabled={s.status === "working"} onClick={() => { send({ type: "session.prompt", sessionId: s.id, prompt: "/compact" }); setOpen(false); }}>
                  Compact session
                </button>
              )}
            </section>
          )}
          {windows.length > 0 && (
            <section>
              <h4>Usage limits</h4>
              {windows.map((r) => (
                <div key={r.window} className="plimit">
                  <p className="pline">
                    <span>{WINDOW_LABEL[r.window]} · Resets {r.window === "five_hour" ? `in ${inText(r.resetsAt - now)}` : resetText(r.resetsAt, now)}</span>
                    <b>{Math.round(r.utilization * 100)}%</b>
                  </p>
                  {bar(r.utilization)}
                </div>
              ))}
            </section>
          )}
          {sessions.length > 0 && (
            <section>
              <button type="button" className="text-link" aria-expanded={detail} onClick={() => setDetail((v) => !v)}>
                {detail ? "Hide detailed breakdown" : "See detailed breakdown"}
              </button>
              {detail && (
                <ul className="pbreak">
                  {sessions.map((x) => (
                    <li key={x.id}>
                      <span className="t">{x.role === "main" ? "Perzian" : x.title}</span>
                      <span>{cost(x.usage!.costUsd!)}</span>
                    </li>
                  ))}
                  <li className="sum">
                    <span className="t">Total</span>
                    <span>{cost(total)}</span>
                  </li>
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
