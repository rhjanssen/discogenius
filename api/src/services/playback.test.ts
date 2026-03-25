import test from "node:test";
import assert from "node:assert/strict";
import { buildPlaybackQualityOrder } from "./playback.js";

test("buildPlaybackQualityOrder prefers the requested quality before falling back", () => {
  assert.deepEqual(buildPlaybackQualityOrder("DOLBY_ATMOS"), [
    "DOLBY_ATMOS",
    "HIRES_LOSSLESS",
    "LOSSLESS",
    "HIGH",
    "LOW",
  ]);

  assert.deepEqual(buildPlaybackQualityOrder("HIRES_LOSSLESS"), [
    "HIRES_LOSSLESS",
    "LOSSLESS",
    "HIGH",
    "LOW",
  ]);

  assert.deepEqual(buildPlaybackQualityOrder("LOSSLESS"), [
    "LOSSLESS",
    "HIGH",
    "LOW",
  ]);
});

test("buildPlaybackQualityOrder uses a deterministic default ladder when quality is missing or invalid", () => {
  const expected = ["HIRES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];

  assert.deepEqual(buildPlaybackQualityOrder(), expected);
  assert.deepEqual(buildPlaybackQualityOrder(""), expected);
  assert.deepEqual(buildPlaybackQualityOrder("not-a-quality"), expected);
});
