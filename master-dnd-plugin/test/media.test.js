// master-dnd-plugin/test/media.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeSlug, sniffImageExt } from "../lib/media.js";

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const JPEG = Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0,0,0,0]), Buffer.from("WEBP")]);

test("safeSlug normalizes names", () => {
  assert.equal(safeSlug("Kaelen il Mago!"), "kaelen-il-mago");
  assert.equal(safeSlug("  "), "asset");
  assert.equal(safeSlug("àéì_ò"), "aei-o");
});

test("sniffImageExt detects formats", () => {
  assert.equal(sniffImageExt(PNG), "png");
  assert.equal(sniffImageExt(JPEG), "jpeg");
  assert.equal(sniffImageExt(WEBP), "webp");
  assert.equal(sniffImageExt(Buffer.from("not an image")), null);
});

// Task 2
import { decodeImageSource, resolveAssetPath } from "../lib/media.js";
import { join } from "node:path";

const PNG_B64 = "iVBORw0KGgoAAAAA"; // 12 bytes: 89504e470d0a1a0a + 4 zero

test("decodeImageSource handles data-uri and raw base64", () => {
  const a = decodeImageSource("data:image/png;base64," + PNG_B64, null);
  assert.equal(a.ext, "png");
  assert.ok(Buffer.isBuffer(a.buffer));
  const b = decodeImageSource(PNG_B64, null);
  assert.equal(b.ext, "png");
});

test("decodeImageSource reads from disk path", () => {
  const fake = () => Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0]);
  const r = decodeImageSource("C:/tmp/foo.jpg", fake);
  assert.equal(r.ext, "jpeg");
});

test("decodeImageSource rejects non-image", () => {
  assert.equal(decodeImageSource("data:text/plain;base64,aGVsbG8=", null), null);
  assert.equal(decodeImageSource("/nope.txt", () => { throw new Error("no"); }), null);
});

test("resolveAssetPath blocks traversal", () => {
  const dir = "/runs/abc/assets";
  assert.equal(resolveAssetPath(dir, "scene.png", join), join(dir, "scene.png"));
  assert.equal(resolveAssetPath(dir, "../secret", join), null);
  assert.equal(resolveAssetPath(dir, "a/b.png", join), null);
  assert.equal(resolveAssetPath(dir, "", join), null);
});

// Task 3
import { normalizeRelations } from "../lib/media.js";

test("normalizeRelations cleans entries", () => {
  const out = normalizeRelations([
    { verso: "Kaelen", tipo: "alleato", intensita: 5, nota: "x" },
    { verso: "Brunna" },
    { tipo: "nemico" },          // no verso → scartata
    "garbage",                    // → scartata
  ]);
  assert.deepEqual(out, [
    { verso: "Kaelen", tipo: "alleato", intensita: 3, nota: "x" },
    { verso: "Brunna", tipo: "conoscente", intensita: 1, nota: "" },
  ]);
  assert.deepEqual(normalizeRelations(null), []);
  assert.deepEqual(normalizeRelations("nope"), []);
});
