import assert from "node:assert/strict";
import test from "node:test";
import {
  isVideoVariantDownloadAllowed,
  resolveVideoTypeFilterKey,
} from "./video-type-filter.js";

const allOn = {
  include_video_official: true,
  include_video_lyric: true,
  include_video_live: true,
  include_video_visualizer: true,
  include_video_official_audio: true,
};

test("resolveVideoTypeFilterKey maps catalog variants to Settings buckets", () => {
  assert.equal(resolveVideoTypeFilterKey("video"), "official");
  assert.equal(resolveVideoTypeFilterKey("official"), "official");
  // Official Audio / audio-only shares the Visualiser Settings toggle.
  assert.equal(resolveVideoTypeFilterKey("audio"), "visualizer");
  assert.equal(resolveVideoTypeFilterKey("visualizer"), "visualizer");
  assert.equal(resolveVideoTypeFilterKey("lyric"), "lyric");
  assert.equal(resolveVideoTypeFilterKey("live"), "live");
});

test("isVideoVariantDownloadAllowed respects type filters", () => {
  assert.equal(isVideoVariantDownloadAllowed("lyric", allOn), true);
  assert.equal(isVideoVariantDownloadAllowed("lyric", { ...allOn, include_video_lyric: false }), false);
  assert.equal(isVideoVariantDownloadAllowed("live", { ...allOn, include_video_live: false }), false);
  assert.equal(isVideoVariantDownloadAllowed("official", { ...allOn, include_video_official: false }), false);
  assert.equal(isVideoVariantDownloadAllowed("visualizer", { ...allOn, include_video_official: false }), true);
  assert.equal(isVideoVariantDownloadAllowed("visualizer", { ...allOn, include_video_visualizer: false }), false);
  assert.equal(isVideoVariantDownloadAllowed("audio", { ...allOn, include_video_official: false }), true);
  // Visualiser off + legacy official_audio still enables Audio-only cuts.
  assert.equal(isVideoVariantDownloadAllowed("audio", {
    ...allOn,
    include_video_visualizer: false,
    include_video_official_audio: true,
  }), true);
  assert.equal(isVideoVariantDownloadAllowed("audio", {
    ...allOn,
    include_video_visualizer: false,
    include_video_official_audio: false,
  }), false);
  assert.equal(isVideoVariantDownloadAllowed("video", { ...allOn, include_video_lyric: false }), true);
});
