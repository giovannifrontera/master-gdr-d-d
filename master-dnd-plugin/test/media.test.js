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
