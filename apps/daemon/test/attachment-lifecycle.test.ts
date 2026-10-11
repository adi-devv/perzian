// Attachment edge cases: attachment-only prompts, HEAD requests, and the sweep of abandoned uploads.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attachments, buildPrompt, referencedAttachmentIds, sendAttachment } from "../src/attachments.ts";

const store = () => new Attachments(mkdtempSync(join(tmpdir(), "pz-att-")));
const DAY = 24 * 3600_000;

describe("attachment-only prompts", () => {
  test("no text: the body is just the attachment lines, with no blank lead-in", () => {
    const info = { id: "11111111-1111-4111-8111-111111111111", name: "a.txt", mime: "application/octet-stream", size: 1, path: "/x/a.txt" };
    const blocks = buildPrompt("", [info], true);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type === "text" && blocks[0].text, `Attached file: a.txt at /x/a.txt (attachment id ${info.id})`);
  });
});

describe("HEAD", () => {
  test("sendAttachment sends the headers and length but no body for HEAD", async () => {
    const a = store();
    const att = a.get(a.save("note.txt", Buffer.from("hello world")).id)!;
    const server = createServer((_req, res) => sendAttachment(res, att));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const head = await fetch(url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-length"), "11");
      assert.equal((await head.text()).length, 0);
      const get = await fetch(url);
      assert.equal(get.headers.get("content-length"), "11");
      assert.equal(await get.text(), "hello world");
    } finally {
      server.close();
    }
  });
});

describe("sweep", () => {
  const age = (a: Attachments, id: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    for (const f of readdirSync(a.dir).filter((n) => n.startsWith(id))) utimesSync(join(a.dir, f), t, t);
  };

  test("removes old unreferenced uploads and their sidecars; keeps referenced and recent ones", () => {
    const a = store();
    const oldUnused = a.save("a.txt", Buffer.from("1")).id;
    const oldUsed = a.save("b.txt", Buffer.from("2")).id;
    const fresh = a.save("c.txt", Buffer.from("3")).id;
    age(a, oldUnused, 2 * DAY);
    age(a, oldUsed, 2 * DAY);
    age(a, fresh, DAY / 2);
    const event = { type: "session.transcript", sessionId: "s", item: { kind: "user", text: "x", at: 1, attachments: [{ id: oldUsed, name: "b.txt" }] } };
    assert.deepEqual([...referencedAttachmentIds([event])], [oldUsed]);
    assert.equal(a.sweep(referencedAttachmentIds([event])), 2);
    assert.deepEqual(readdirSync(a.dir).sort(), [`${oldUsed}.json`, `${oldUsed}.txt`, `${fresh}.json`, `${fresh}.txt`].sort());
  });

  test("only uuid-named regular files in the attachments dir are touched", () => {
    const a = store();
    a.save("a.txt", Buffer.from("1"));
    const old = new Date(Date.now() - 3 * DAY);
    const stray = join(a.dir, "notes.txt");
    writeFileSync(stray, "mine");
    utimesSync(stray, old, old);
    mkdirSync(join(a.dir, "11111111-1111-4111-8111-111111111111.d"));
    assert.equal(a.sweep(new Set(), DAY, Date.now() + 3 * DAY), 2, "just the upload and its sidecar");
    assert.deepEqual(readdirSync(a.dir).sort(), ["11111111-1111-4111-8111-111111111111.d", "notes.txt"]);
    assert.equal(new Attachments(join(a.dir, "missing")).sweep(new Set()), 0, "no attachments dir yet");
  });
});
