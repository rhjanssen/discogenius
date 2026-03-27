import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_PLAYBACK_MANIFEST_TYPES, buildBrowserPlaybackQualityOrder, buildPlaybackQualityOrder } from "./playback.js";

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

test("buildBrowserPlaybackQualityOrder keeps browser preview on a stereo-safe ladder", () => {
  assert.deepEqual(buildBrowserPlaybackQualityOrder(), ["LOSSLESS", "HIGH", "LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder(""), ["LOSSLESS", "HIGH", "LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder("LOSSLESS"), ["LOSSLESS", "HIGH", "LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder("HIRES_LOSSLESS"), ["LOSSLESS", "HIGH", "LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder("DOLBY_ATMOS"), ["LOSSLESS", "HIGH", "LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder("HIGH"), ["HIGH", "LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder("LOW"), ["LOW"]);
  assert.deepEqual(buildBrowserPlaybackQualityOrder("not-a-quality"), ["LOSSLESS", "HIGH", "LOW"]);
});

test("browser playback accepts both progressive BTS and DASH manifests", () => {
  assert.deepEqual([...BROWSER_PLAYBACK_MANIFEST_TYPES], ["bts", "dash"]);
});
