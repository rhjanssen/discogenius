import assert from "node:assert/strict";
import { test } from "node:test";

import { tidalStreamingProvider } from "./providers/tidal/tidal-provider.js";

test("TIDAL capability surface matches the supported 2.0 provider contract", () => {
  assert.equal("playlists" in tidalStreamingProvider.capabilities, false);
  assert.equal(tidalStreamingProvider.capabilities.lossyStereo, false);
  assert.equal(tidalStreamingProvider.capabilities.losslessStereo, true);
  assert.equal(tidalStreamingProvider.capabilities.hiResStereo, true);
  assert.equal(tidalStreamingProvider.capabilities.spatialAudio, true);
  assert.equal(tidalStreamingProvider.capabilities.audioPreviews, true);
  assert.equal(tidalStreamingProvider.capabilities.audioDownloads, true);
  assert.equal(tidalStreamingProvider.capabilities.lyrics, true);
  assert.equal(tidalStreamingProvider.capabilities.artwork, true);
  assert.equal(tidalStreamingProvider.capabilities.editorialMetadata, true);
});

test("TIDAL URL parsing excludes unsupported provider collection URLs", () => {
  assert.deepEqual(tidalStreamingProvider.parseMediaUrl?.("https://listen.tidal.com/track/123"), {
    type: "track",
    providerId: "123",
  });
  assert.equal(tidalStreamingProvider.parseMediaUrl?.("https://listen.tidal.com/playlist/abc"), null);
});
