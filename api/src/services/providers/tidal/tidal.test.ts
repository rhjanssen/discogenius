import assert from "node:assert/strict";
import test from "node:test";
import { deriveQuality } from "./tidal.js";

test("deriveQuality checks mediaMetadata.tags priority", () => {
  assert.equal(deriveQuality({ mediaMetadata: { tags: ["LOSSLESS", "HIRES_LOSSLESS", "DOLBY_ATMOS"] } }), "DOLBY_ATMOS");
  assert.equal(deriveQuality({ mediaMetadata: { tags: ["LOSSLESS", "HIRES_LOSSLESS"] } }), "HIRES_LOSSLESS");
  assert.equal(deriveQuality({ mediaMetadata: { tags: ["LOSSLESS"] } }), "LOSSLESS");
  assert.equal(deriveQuality({ mediaMetadata: { tags: [] } }), "LOSSLESS");
  assert.equal(deriveQuality(null), "LOSSLESS");
  assert.equal(deriveQuality(undefined), "LOSSLESS");
});
