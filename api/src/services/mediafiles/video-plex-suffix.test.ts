/**
 * Plex extras suffixes: the canonical type says what a video IS, the placement
 * says what role it plays, and only the second decides the suffix.
 *
 * Inline, a file sits beside one audio track and fills that track's regular or
 * lyrics extra slot; Plex reads `-video` and `-lyrics` for those. A live cut
 * occupying the regular slot is therefore `-video` — the same file stored on its
 * own has no track to be beside, so the suffix names the video itself and
 * `-live` is right. Getting this backwards puts a live video in a slot Plex will
 * not show, or names two different files identically.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveVideoTypeSuffix } from "./video-naming.js";
import {
  canonicalVideoType,
  inlineVideoSlot,
  videoTypeSuffix,
} from "../music/canonical-video-type.js";

test("inline: video and live both fill the regular slot, lyrics its own", () => {
  assert.equal(resolveVideoTypeSuffix("Pompeii", "official", "inline"), "-video");
  assert.equal(resolveVideoTypeSuffix("Pompeii", "video", "inline"), "-video");
  assert.equal(resolveVideoTypeSuffix("Pompeii (live)", "live", "inline"), "-video");
  assert.equal(resolveVideoTypeSuffix("Pompeii (Lyric Video)", "lyric", "inline"), "-lyrics");
});

test("separated: the suffix names the video itself, so live is -live", () => {
  assert.equal(resolveVideoTypeSuffix("Pompeii", "official", "separated"), "-video");
  assert.equal(resolveVideoTypeSuffix("Pompeii", "video", "separated"), "-video");
  assert.equal(resolveVideoTypeSuffix("Pompeii (live)", "live", "separated"), "-live");
  assert.equal(resolveVideoTypeSuffix("Pompeii (Lyric Video)", "lyric", "separated"), "-lyrics");
});

test("separated is the default when no placement is stated", () => {
  assert.equal(resolveVideoTypeSuffix("Pompeii (live)", "live"), "-live");
});

test("visualizer and official audio are ordinary videos in both placements", () => {
  for (const variant of ["visualizer", "audio"]) {
    assert.equal(canonicalVideoType(variant), "video");
    assert.equal(resolveVideoTypeSuffix("Pompeii", variant, "inline"), "-video");
    assert.equal(resolveVideoTypeSuffix("Pompeii", variant, "separated"), "-video");
  }
});

test("the canonical helper and the naming helper agree, both ways", () => {
  const cases: Array<[string, "video" | "live" | "lyrics"]> = [
    ["official", "video"],
    ["video", "video"],
    ["visualizer", "video"],
    ["audio", "video"],
    ["live", "live"],
    ["lyric", "lyrics"],
  ];
  for (const [variant, expectedType] of cases) {
    assert.equal(canonicalVideoType(variant), expectedType);
    for (const placement of ["inline", "separated"] as const) {
      assert.equal(
        resolveVideoTypeSuffix("Song", variant, placement),
        videoTypeSuffix(expectedType, placement),
        `${variant} / ${placement}`,
      );
    }
  }
});

test("slot mapping matches the suffix a slot occupant gets", () => {
  assert.equal(inlineVideoSlot("video"), "video");
  assert.equal(inlineVideoSlot("live"), "video");
  assert.equal(inlineVideoSlot("lyrics"), "lyrics");
  // Whatever fills the regular slot is named for the slot, not for itself.
  assert.equal(videoTypeSuffix("video", "inline"), "-video");
  assert.equal(videoTypeSuffix("live", "inline"), "-video");
  assert.equal(videoTypeSuffix("lyrics", "inline"), "-lyrics");
});

test("a plain title with no variant still classifies from the title", () => {
  assert.equal(resolveVideoTypeSuffix("Pompeii (Lyric Video)", null, "separated"), "-lyrics");
  assert.equal(resolveVideoTypeSuffix("Pompeii (Live at KOKO)", null, "separated"), "-live");
  assert.equal(resolveVideoTypeSuffix("Pompeii (Live at KOKO)", null, "inline"), "-video");
});
