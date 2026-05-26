import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseCachedAlbumArtwork,
  getSkyHookAlbumImageUrl,
  getRegisteredMediaCoverProxyUrl,
  resolveMediaCoverProxyUrl,
} from "./media-cover-service.js";

test("SkyHook album artwork is registered through the media cover proxy", () => {
  const remoteUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/cover.jpg";
  const artworkUrl = chooseCachedAlbumArtwork({
    skyHookData: {
      Images: [
        {
          CoverType: "Cover",
          Url: remoteUrl,
          Width: 1200,
          Height: 1200,
        },
      ],
    },
    providerCandidates: [
      {
        provider: "tidal",
        imageId: "00000000-0000-0000-0000-000000000000",
      },
    ],
  });

  assert.match(artworkUrl ?? "", /^\/MediaCoverProxy\/[a-f0-9]{64}\/cover\.jpg$/);

  const hash = artworkUrl?.split("/")[2] ?? "";
  assert.equal(getRegisteredMediaCoverProxyUrl(hash), remoteUrl);
  assert.equal(resolveMediaCoverProxyUrl(artworkUrl), remoteUrl);
});

test("SkyHook selectors return raw URLs for durable storage", () => {
  const remoteUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/storage-cover.jpg";

  assert.equal(getSkyHookAlbumImageUrl({
    Images: [
      {
        CoverType: "Cover",
        Url: remoteUrl,
        Width: 1200,
        Height: 1200,
      },
    ],
  }), remoteUrl);
});

test("provider artwork is used when SkyHook has no usable image URL", () => {
  const artworkUrl = chooseCachedAlbumArtwork({
    skyHookData: {
      Images: [
        {
          CoverType: "Cover",
          Url: null,
        },
      ],
    },
    providerCandidates: [
      {
        provider: "tidal",
        imageId: "11111111-1111-1111-1111-111111111111",
      },
    ],
  });

  assert.equal(artworkUrl, "11111111-1111-1111-1111-111111111111");
});
