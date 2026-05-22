import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseCachedAlbumArtwork,
} from "./skyhook-artwork-service.js";

test("SkyHook album artwork is preferred over provider snapshots", () => {
  const resolved = chooseCachedAlbumArtwork({
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

test("provider artwork is used when SkyHook has no image", () => {
  const resolved = chooseCachedAlbumArtwork({
    skyHookData: { Images: [] },
    providerCandidates: [
      { provider: "tidal", entityId: "provider-album-1", data: JSON.stringify({ cover: "provider-cover-id" }) },
    ],
  });

  assert.equal(resolved, "provider-cover-id");
});

test("missing SkyHook and provider artwork resolves to null instead of a direct archive guess", () => {
  const resolved = chooseCachedAlbumArtwork({
    skyHookData: { Images: [] },
    providerCandidates: [],
  });

  assert.equal(resolved, null);
});
