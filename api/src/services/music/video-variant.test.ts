import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_DURATION_MATCH_MS,
  catalogVideoDisplayTitle,
  cleanVideoGroupTitle,
  parseVideoVariant,
  preferredVideoVariant,
  resolveVideoTypeSuffix,
} from "./video-variant.js";

test("VIDEO_DURATION_MATCH_MS is a single 2s gate", () => {
  assert.equal(VIDEO_DURATION_MATCH_MS, 2_000);
});

test("parseVideoVariant classifies lyric/live/audio/visualizer/video", () => {
  assert.equal(parseVideoVariant("Oblivion (Lyric Video)"), "lyric");
  assert.equal(parseVideoVariant("Oblivion (Live From Capitol Studios)"), "live");
  assert.equal(parseVideoVariant("Don't Want You Back (Audio)"), "audio");
  assert.equal(parseVideoVariant("Pompeii (Visualizer)"), "visualizer");
  assert.equal(parseVideoVariant("Pompeii (Official Music Video)"), "official");
  assert.equal(parseVideoVariant("Pompeii"), "video");
});

test("cleanVideoGroupTitle strips marketing and live qualifiers for matching", () => {
  assert.equal(cleanVideoGroupTitle("Oblivion (Lyric Video)"), "Oblivion");
  assert.equal(cleanVideoGroupTitle("Pompeii (Official Music Video)"), "Pompeii");
  assert.equal(cleanVideoGroupTitle("Good Grief (Live From O2)"), "Good Grief");
  assert.equal(
    cleanVideoGroupTitle("Don't Want You Back (feat. Kiesza) (Official Video)"),
    "Don't Want You Back (feat. Kiesza)",
  );
});

test("catalogVideoDisplayTitle keeps venue/live/feat but drops marketing wrappers", () => {
  assert.equal(catalogVideoDisplayTitle("Pompeii (Official Music Video)"), "Pompeii");
  assert.equal(catalogVideoDisplayTitle("Oblivion (Lyric Video)"), "Oblivion");
  assert.equal(catalogVideoDisplayTitle("Good Grief (Live From O2)"), "Good Grief (Live From O2)");
  assert.equal(
    catalogVideoDisplayTitle("Don't Want You Back (feat. Kiesza) (Official Video)"),
    "Don't Want You Back (feat. Kiesza)",
  );
});

test("preferredVideoVariant keeps the more specific class", () => {
  assert.equal(preferredVideoVariant("video", "lyric"), "lyric");
  assert.equal(preferredVideoVariant("lyric", "live"), "lyric");
  assert.equal(preferredVideoVariant("video", "live"), "live");
  assert.equal(preferredVideoVariant("official", "lyric"), "lyric");
  assert.equal(preferredVideoVariant(null, "audio"), "audio");
});

test("resolveVideoTypeSuffix prefers variant column over title noise", () => {
  assert.equal(resolveVideoTypeSuffix("lyric", "Oblivion"), "-lyrics");
  assert.equal(resolveVideoTypeSuffix("live", "Oblivion"), "-live");
  assert.equal(resolveVideoTypeSuffix("official", "Oblivion"), "-video");
  assert.equal(resolveVideoTypeSuffix("video", "Oblivion"), "-video");
  assert.equal(resolveVideoTypeSuffix("video", "Interview with Dan"), "-interview");
  assert.equal(resolveVideoTypeSuffix("audio", "Track (Audio)"), "-video");
});
