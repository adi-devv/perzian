// Files and images the developer attaches to a prompt. Uploaded once over HTTP into $PERZIAN_HOME/attachments/<id>.<ext>
// (0600) with a <id>.json beside it (name, type). Commands and transcript events carry only ids; the bytes are read from
// disk when a prompt is sent (as ACP image blocks when the agent takes images, otherwise the agent reads the path).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { IMAGE_TYPES, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_IMAGE_BYTES, type AttachmentInfo, type AttachmentRef } from "@perzian/protocol";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isAttachmentId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

/** The extension kept on disk: lowercase letters and digits only, so a name can never steer the path. */
export function safeExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.split(/[\\/]/).pop() ?? "");
  return m ? m[1].toLowerCase() : "bin";
}

/** The file name shown to the developer and the agent: no folders, no control characters, bounded. */
export function safeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return base || "file";
}

function magicOk(ext: string, b: Buffer): boolean {
  switch (IMAGE_TYPES[ext]) {
    case "image/png":
      return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"));
    case "image/webp":
      return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  }
  return true;
}

export interface UploadCheck {
  ok: boolean;
  error?: string;
  ext: string;
  image: boolean;
}

/** Whether a file of this name and size may be attached. Images must be png, jpg, gif or webp up to 5 MB; other files up to 25 MB. */
export function checkUpload(name: string, size: number): UploadCheck {
  const ext = safeExt(name);
  // A picture in a format the agent can't see (svg, heic, bmp, ...) is attached as a plain file, by path.
  const image = ext in IMAGE_TYPES;
  if (size <= 0) return { ok: false, error: "That file is empty.", ext, image };
  if (image && size > MAX_IMAGE_BYTES) return { ok: false, error: "Images can be up to 5 MB.", ext, image };
  if (size > MAX_FILE_BYTES) return { ok: false, error: "Files can be up to 25 MB.", ext, image };
  return { ok: true, ext, image };
}

/** An upload nothing refers to is removed after this long. */
export const ATTACHMENT_TTL_MS = 24 * 3600_000;

/** Every attachment id mentioned anywhere in these events (transcript items, drafts, ...). */
export function referencedAttachmentIds(events: Iterable<unknown>): Set<string> {
  const ids = new Set<string>();
  for (const e of events) for (const m of JSON.stringify(e).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) ids.add(m[0]);
  return ids;
}

export class Attachments {
  readonly dir: string;
  constructor(home: string) {
    this.dir = join(home, "attachments");
  }

  /** Stores an upload. Throws a message fit for the developer when it isn't allowed. */
  save(name: string, data: Buffer): AttachmentInfo {
    const check = checkUpload(name, data.length);
    if (!check.ok) throw new Error(check.error);
    if (check.image && !magicOk(check.ext, data)) throw new Error(`That doesn't look like a real .${check.ext} image.`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    const clean = safeName(name);
    const info: AttachmentInfo = { id, name: clean, mime: check.image ? IMAGE_TYPES[check.ext] : "application/octet-stream", size: data.length, ...(check.image ? { image: true as const } : {}) };
    writeFileSync(join(this.dir, `${id}.${check.ext}`), data, { mode: 0o600 });
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify({ ...info, ext: check.ext }), { mode: 0o600 });
    return info;
  }

  /** What is stored under this id, or undefined (unknown id, or one that isn't a plain attachment id). */
  get(id: unknown): (AttachmentInfo & { path: string }) | undefined {
    if (!isAttachmentId(id)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as AttachmentInfo & { ext: string };
      const path = join(this.dir, `${id}.${safeExt(`x.${meta.ext}`)}`);
      if (!existsSync(path)) return undefined;
      const { ext: _, ...info } = meta;
      return { ...info, path };
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes uploads (the file and its .json sidecar) older than `maxAgeMs` that no event refers to, so abandoned
   * uploads don't pile up. Only regular files directly in the attachments dir named `<uuid>.<ext>` are touched.
   * `referenced` is the set of attachment ids still in the event store. Returns how many files were removed.
   */
  sweep(referenced: ReadonlySet<string>, maxAgeMs = ATTACHMENT_TTL_MS, now = Date.now()): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const m = /^([0-9a-f-]{36})\.[a-z0-9]{1,8}$/.exec(name);
      if (!m || !isAttachmentId(m[1]) || referenced.has(m[1])) continue;
      try {
        const path = join(this.dir, name);
        const st = lstatSync(path);
        if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
        unlinkSync(path);
        removed++;
      } catch {
        // gone already, or not ours to delete: leave it
      }
    }
    return removed;
  }

  /** Looks up every id; throws for one that is unknown or when there are too many. */
  resolve(ids: unknown): (AttachmentInfo & { path: string })[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids)) throw new Error("Bad attachments");
    if (ids.length > MAX_ATTACHMENTS) throw new Error(`Up to ${MAX_ATTACHMENTS} attachments.`);
    return ids.map((id) => {
      const a = this.get(id);
      if (!a) throw new Error("An attachment is no longer available. Attach it again.");
      return a;
    });
  }
}

export const refOf = (a: AttachmentRef): AttachmentRef => ({ id: a.id, name: a.name, ...(a.image ? { image: true as const } : {}) });

export type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * The ACP prompt for `text` plus attachments. Images go as image blocks (base64 read from disk now) when the agent
 * takes images; otherwise, and for every other file, the text names the absolute path so the agent can read it.
 * Every attachment is also named with its id, so the lead can hand it to a worker (spawn_session `attachments`).
 */
export function buildPrompt(text: string, atts: (AttachmentInfo & { path: string })[], canImage: boolean, read: (path: string) => Buffer = readFileSync): PromptBlock[] {
  const lines: string[] = [];
  const images: PromptBlock[] = [];
  for (const a of atts) {
    if (a.image && canImage) {
      try {
        images.push({ type: "image", data: read(a.path).toString("base64"), mimeType: a.mime });
        lines.push(`Attached image: ${a.name} (attachment id ${a.id})`);
        continue;
      } catch {
        // unreadable now: fall back to the path
      }
    }
    lines.push(`Attached ${a.image ? "image" : "file"}: ${a.name} at ${a.path} (attachment id ${a.id})`);
  }
  // An attachment-only send has no text: the body is just the attachment lines (never a blank lead-in).
  const body = lines.length ? [text, lines.join("\n")].filter((p) => p.trim()).join("\n\n") : text;
  return [...images, { type: "text", text: body }];
}

/** Serves a stored attachment: images inline, anything else as a download; never sniffed into something executable. */
export function sendAttachment(res: ServerResponse, a: AttachmentInfo & { path: string }, extra: Record<string, string> = {}): void {
  let data: Buffer;
  try {
    data = readFileSync(a.path);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const head = res.req?.method === "HEAD";
  res
    .writeHead(200, {
      ...extra,
      "content-type": a.image ? a.mime : "application/octet-stream",
      "content-length": String(data.length),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; sandbox",
      ...(a.image ? {} : { "content-disposition": `attachment; filename="${a.name.replace(/[^\w. -]/g, "_")}"` }),
    })
    .end(head ? undefined : data);
}
