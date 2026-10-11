// Attachments: what an upload may be, where it lands, and how a prompt carries it (image block or path).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attachments, buildPrompt, checkUpload, isAttachmentId, safeExt, safeName } from "../src/attachments.ts";
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES } from "@perzian/protocol";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const store = () => new Attachments(mkdtempSync(join(tmpdir(), "pz-att-")));

describe("upload validation", () => {
  test("images: png, jpg, gif and webp up to 5 MB", () => {
    for (const n of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp"]) assert.ok(checkUpload(n, 100).ok && checkUpload(n, 100).image, n);
    assert.equal(checkUpload("a.png", MAX_IMAGE_BYTES).ok, true);
    assert.equal(checkUpload("a.png", MAX_IMAGE_BYTES + 1).ok, false);
    assert.equal(checkUpload("a.png", 0).ok, false);
  });
  test("other formats are plain files, not images", () => {
    assert.deepEqual([checkUpload("a.svg", 10).ok, checkUpload("a.svg", 10).image], [true, false]);
    assert.equal(checkUpload("notes.txt", MAX_IMAGE_BYTES + 1).ok, true, "files have their own, larger limit");
    assert.equal(checkUpload("big.zip", 26 * 1024 * 1024).ok, false);
  });
  test("a fake image is refused by its bytes", () => {
    assert.throws(() => store().save("evil.png", Buffer.from("<html>not a png</html>")), /real \.png/);
  });
});

describe("storage", () => {
  test("lands in attachments/<id>.<ext> with mode 0600 and reads back", () => {
    const a = new Attachments(mkdtempSync(join(tmpdir(), "pz-att-")));
    const info = a.save("Shot 1.png", PNG);
    assert.ok(isAttachmentId(info.id));
    assert.deepEqual([info.name, info.mime, info.image], ["Shot 1.png", "image/png", true]);
    const got = a.get(info.id)!;
    assert.equal(got.path, join(a.dir, `${info.id}.png`));
    assert.equal(statSync(got.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(a.dir, `${info.id}.json`)).mode & 0o777, 0o600);
  });

  test("path traversal: names never steer the path, ids must be uuids", () => {
    const a = store();
    const info = a.save("../../../etc/passwd.txt", Buffer.from("hi"));
    assert.equal(info.name, "passwd.txt");
    assert.deepEqual(readdirSync(a.dir).sort(), [`${info.id}.json`, `${info.id}.txt`].sort());
    assert.equal(safeExt("x.png/../../a"), "bin");
    assert.equal(safeExt("evil.p/ng"), "bin");
    assert.equal(safeExt("a.tar.gz"), "gz");
    assert.equal(safeName("..\\..\\win\\name.txt"), "name.txt");
    for (const bad of ["../x", "..", `${info.id}/../../x`, "", "x".repeat(36), undefined, 7]) assert.equal(a.get(bad), undefined, String(bad));
    writeFileSync(join(a.dir, "secret.txt"), "s");
    assert.equal(a.get("secret"), undefined);
  });

  test("resolve: unknown ids and too many are refused", () => {
    const a = store();
    const one = a.save("a.txt", Buffer.from("x"));
    assert.equal(a.resolve([one.id]).length, 1);
    assert.deepEqual(a.resolve(undefined), []);
    assert.throws(() => a.resolve(["11111111-1111-1111-1111-111111111111"]), /no longer available/);
    assert.throws(() => a.resolve(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => one.id)), /Up to 10/);
  });
});

describe("prompt building", () => {
  const a = store();
  const img = a.resolve([a.save("shot.png", PNG).id])[0];
  const file = a.resolve([a.save("log.txt", Buffer.from("boom")).id])[0];

  test("image block when the agent takes images; the text names it and its id", () => {
    const blocks = buildPrompt("fix this", [img], true);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    const text = blocks[1] as { type: "text"; text: string };
    assert.match(text.text, /^fix this\n\nAttached image: shot\.png \(attachment id /);
    assert.ok(!text.text.includes(img.path), "no path when the agent sees the image");
  });

  test("path in the text when the agent can't take images, and for any file", () => {
    const blocks = buildPrompt("fix this", [img, file], false);
    assert.equal(blocks.length, 1);
    const t = (blocks[0] as { type: "text"; text: string }).text;
    assert.ok(t.includes(img.path) && t.includes(file.path));
    const withImg = buildPrompt("x", [img, file], true);
    assert.equal(withImg.length, 2, "the file is still a path, not a block");
    assert.ok((withImg[1] as { text: string }).text.includes(file.path));
  });

  test("an unreadable image falls back to its path; no attachments leaves the text alone", () => {
    const blocks = buildPrompt("x", [img], true, () => {
      throw new Error("gone");
    });
    assert.equal(blocks.length, 1);
    assert.ok((blocks[0] as { text: string }).text.includes(img.path));
    assert.deepEqual(buildPrompt("plain", [], true), [{ type: "text", text: "plain" }]);
  });
});
