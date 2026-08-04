import assert from "node:assert/strict";
import test from "node:test";
import { parseMediaFormats } from "./media-formats.js";

test("reads every shape AlbumEditions.media is written in", () => {
  assert.deepEqual(parseMediaFormats('["CD", "Digital Media"]'), ["CD", "Digital Media"]);
  assert.deepEqual(
    parseMediaFormats('[{"Format": "Digital Media"}, {"format": "CD"}]'),
    ["Digital Media", "CD"],
  );
  assert.deepEqual(parseMediaFormats('[{"name": "Vinyl"}]'), ["Vinyl"]);
  assert.deepEqual(parseMediaFormats('"CD"'), ["CD"]);
  assert.deepEqual(parseMediaFormats("CD"), ["CD"]);
});

test("a multi-disc edition reports its format once", () => {
  // Two CDs are one kind of product; the medium count is carried separately.
  assert.deepEqual(
    parseMediaFormats('[{"Format": "Digital Media"}, {"Format": "Digital Media"}]'),
    ["Digital Media"],
  );
  assert.deepEqual(parseMediaFormats('["CD", "CD", "DVD"]'), ["CD", "DVD"]);
});

test("blank and missing payloads yield no formats", () => {
  assert.deepEqual(parseMediaFormats(null), []);
  assert.deepEqual(parseMediaFormats(undefined), []);
  assert.deepEqual(parseMediaFormats(""), []);
  assert.deepEqual(parseMediaFormats("   "), []);
  assert.deepEqual(parseMediaFormats("[]"), []);
  assert.deepEqual(parseMediaFormats('[""]'), []);
  assert.deepEqual(parseMediaFormats('[{"Format": ""}]'), []);
  assert.deepEqual(parseMediaFormats('[{"Format": "  "}]'), []);
});

test("malformed payloads never become a format name", () => {
  // The failure a caller must never see is a format called "[object Object]" or
  // a raw JSON blob rendered as a product type in the Editions list.
  assert.deepEqual(parseMediaFormats('[{"position": 1}]'), []);
  assert.deepEqual(parseMediaFormats("{not json"), []);
  assert.deepEqual(parseMediaFormats('[{"Format": {"nested": true}}]'), []);
  for (const formats of [
    parseMediaFormats('[{"position": 1}]'),
    parseMediaFormats("{not json"),
  ]) {
    assert.equal(formats.some((format) => format.includes("object Object")), false);
  }
});
