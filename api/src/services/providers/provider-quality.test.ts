import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyNeutralAudio,
  classifyNeutralQuality,
  classifyNeutralSpatial,
  classifyNeutralVideo,
  isNeutralSpatial,
  neutralVideoFromHeight,
  neutralVideoTagFromHeight,
} from "./provider-quality.js";
import { tidalQualityMapping } from "./tidal/tidal-quality.js";

test("shared heuristic classifies stereo fidelity", () => {
  assert.equal(classifyNeutralAudio("LOSSLESS"), "lossless");
  assert.equal(classifyNeutralAudio("HIRES_LOSSLESS"), "hires-lossless");
  assert.equal(classifyNeutralAudio("HIGH"), "lossy");
  assert.equal(classifyNeutralAudio("DOLBY_ATMOS"), null);
});

test("classifyNeutralVideo maps legacy MP4_* and neutral tags", () => {
  assert.equal(classifyNeutralVideo("MP4_1080P"), "fhd");
  assert.equal(classifyNeutralVideo("UHD"), "uhd");
  assert.equal(classifyNeutralVideo("FHD"), "fhd");
  assert.equal(classifyNeutralVideo("SOURCE"), null);
  assert.equal(neutralVideoFromHeight(1080), "fhd");
  assert.equal(neutralVideoTagFromHeight(2160), "UHD");
});

test("shared heuristic classifies spatial formats", () => {
  assert.equal(classifyNeutralSpatial("DOLBY_ATMOS"), "atmos");
  assert.equal(classifyNeutralSpatial("SONY_360RA"), "spatial-360");
  assert.equal(classifyNeutralSpatial("LOSSLESS"), null);
});

test("classifyNeutralQuality picks the best stereo tier and collects spatial", () => {
  const q = classifyNeutralQuality(["HIGH", "LOSSLESS", "DOLBY_ATMOS"]);
  assert.equal(q.audio, "lossless");
  assert.deepEqual(q.spatial, ["atmos"]);
  assert.equal(isNeutralSpatial(q), true);
});

test("TIDAL mapping translates raw quality strings into the neutral model", () => {
  assert.equal(tidalQualityMapping.toNeutralAudio("HIGH"), "lossy"); // 320kbps AAC
  assert.equal(tidalQualityMapping.toNeutralAudio("LOSSLESS"), "lossless");
  assert.equal(tidalQualityMapping.toNeutralAudio("HI_RES_LOSSLESS"), "hires-lossless");
  assert.equal(tidalQualityMapping.toNeutralAudio("DOLBY_ATMOS"), null);

  const neutral = tidalQualityMapping.toNeutral(["LOSSLESS", "DOLBY_ATMOS"]);
  assert.equal(neutral.audio, "lossless");
  assert.deepEqual(neutral.spatial, ["atmos"]);
});

test("TIDAL mapping round-trips neutral tiers back to raw strings", () => {
  assert.equal(tidalQualityMapping.fromNeutralAudio("lossy"), "HIGH");
  assert.equal(tidalQualityMapping.fromNeutralAudio("lossless"), "LOSSLESS");
  assert.equal(tidalQualityMapping.fromNeutralAudio("hires-lossless"), "HI_RES_LOSSLESS");
  assert.equal(tidalQualityMapping.fromNeutralVideo("fhd"), "MP4_1080P");
});
