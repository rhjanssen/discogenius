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
  parseM3u8MaxHeight,
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

test("parseM3u8MaxHeight reads the longest RESOLUTION edge", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360',
    "a.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
    "b.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x1600',
    "c.m3u8",
  ].join("\n");
  assert.equal(parseM3u8MaxHeight(master), 3840);
  assert.equal(parseM3u8MaxHeight(""), null);
});

test("configuredVideoMaxHeight maps settings tiers to pixel ceilings", async () => {
  const { configuredVideoMaxHeight, selectBestVideoQualityAtOrBelow } = await import("./provider-quality.js");
  assert.equal(configuredVideoMaxHeight("sd"), 480);
  assert.equal(configuredVideoMaxHeight("hd"), 720);
  assert.equal(configuredVideoMaxHeight("fhd"), 1080);
  assert.equal(configuredVideoMaxHeight("uhd"), 2160);
  assert.equal(configuredVideoMaxHeight(undefined), 2160);
  assert.equal(selectBestVideoQualityAtOrBelow(["uhd", "fhd", "hd"], "hd"), "hd");
  assert.equal(selectBestVideoQualityAtOrBelow(["uhd", "fhd"], "hd"), null);
  assert.equal(selectBestVideoQualityAtOrBelow(["sd", "fhd", "hd"], "fhd"), "fhd");
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

test("TIDAL catalog video quality distrusts aspirational MP4_1080P / FHD", async () => {
  const {
    tidalVideoQualityTag,
    isUntrustedTidalCatalogVideoQuality,
    parseM3u8MaxHeight,
    tidalVideoQualityTagFromProbe,
    tidalStreamVideoQualityTier,
  } = await import("./tidal/tidal-quality.js");

  assert.equal(isUntrustedTidalCatalogVideoQuality("MP4_1080P"), true);
  assert.equal(isUntrustedTidalCatalogVideoQuality("FHD"), true);
  assert.equal(isUntrustedTidalCatalogVideoQuality("MP4_720P"), false);
  assert.equal(tidalVideoQualityTag("MP4_1080P"), null);
  assert.equal(tidalVideoQualityTag("FHD"), null);
  assert.equal(tidalVideoQualityTag("MP4_720P"), "HD");
  assert.equal(tidalVideoQualityTag("MP4_480P"), "SD");

  assert.equal(tidalStreamVideoQualityTier("HIGH"), "fhd");
  assert.equal(tidalStreamVideoQualityTier("MEDIUM"), "hd");
  assert.equal(tidalStreamVideoQualityTier("LOW"), "sd");

  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360',
    "a.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=712x480',
    "b.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
    "c.m3u8",
  ].join("\n");
  assert.equal(parseM3u8MaxHeight(master), 1280);
  assert.equal(tidalVideoQualityTagFromProbe({ height: 720 }), "HD");
  assert.equal(tidalVideoQualityTagFromProbe({ height: 480 }), "SD");
  assert.equal(tidalVideoQualityTagFromProbe({ height: 1080 }), "FHD");
  // MEDIUM stream name alone would claim HD; height wins when present.
  assert.equal(tidalVideoQualityTagFromProbe({ height: 480, streamQuality: "MEDIUM" }), "SD");
  assert.equal(tidalVideoQualityTagFromProbe({ streamQuality: "MEDIUM" }), "HD");
});
