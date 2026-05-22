import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseCachedAlbumArtwork,
  coverArtArchiveReleaseGroupUrl,
} from "./skyhook-artwork-service.js";

test("SkyHook album artwork is preferred over provider snapshots and direct Cover Art Archive fallback", () => {
  const resolved = chooseCachedAlbumArtwork({
    releaseGroupMbid: "release-group-mbid-1",
    skyHookData: {
      Images: [
        { CoverType: "Cover", Url: "https://skyhook.example/cover.jpg", Width: 1000, Height: 1000 },
      ],
    },
    providerCandidates: [
      { provider: "tidal", entityId: "provider-album-1", imageId: "provider-cover-id" },
    ],
  });

  assert.equal(resolved, "https://skyhook.example/cover.jpg");
});

test("provider artwork is used before a direct Cover Art Archive URL when SkyHook has no image", () => {
  const resolved = chooseCachedAlbumArtwork({
    releaseGroupMbid: "release-group-mbid-1",
    skyHookData: { Images: [] },
    providerCandidates: [
      { provider: "tidal", entityId: "provider-album-1", data: JSON.stringify({ cover: "provider-cover-id" }) },
    ],
  });

  assert.equal(resolved, "provider-cover-id");
});

test("Cover Art Archive release-group fallback maps configured sizes to supported endpoints", () => {
  assert.equal(
    coverArtArchiveReleaseGroupUrl("release-group-mbid-1", 1280),
    "https://coverartarchive.org/release-group/release-group-mbid-1/front-1200",
  );
  assert.equal(
    coverArtArchiveReleaseGroupUrl("release-group-mbid-1", 640),
    "https://coverartarchive.org/release-group/release-group-mbid-1/front-500",
  );
});
