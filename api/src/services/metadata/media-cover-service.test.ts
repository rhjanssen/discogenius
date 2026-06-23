import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-media-cover-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let mediaCoverServiceModule: typeof import("./media-cover-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  mediaCoverServiceModule = await import("./media-cover-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Servarr Metadata Server album artwork is registered through the media cover proxy", () => {
  const remoteUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/cover.jpg";
  const artworkUrl = mediaCoverServiceModule.chooseCachedAlbumArtwork({
    servarrMetadataData: {
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
  assert.equal(mediaCoverServiceModule.getRegisteredMediaCoverProxyUrl(hash), remoteUrl);
  assert.equal(mediaCoverServiceModule.resolveMediaCoverProxyUrl(artworkUrl), remoteUrl);
});

test("Servarr Metadata Server selectors return raw URLs for durable storage", () => {
  const remoteUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/storage-cover.jpg";

  assert.equal(mediaCoverServiceModule.getServarrMetadataAlbumImageUrl({
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

test("provider artwork is used when Servarr Metadata Server has no usable image URL", () => {
  const artworkUrl = mediaCoverServiceModule.chooseCachedAlbumArtwork({
    servarrMetadataData: {
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

  assert.match(artworkUrl ?? "", /^\/MediaCoverProxy\/[a-f0-9]{64}\/750x750\.jpg$/);
});

test("Servarr Metadata Server album artwork wins over cached provider fallback artwork", () => {
  const albumMbid = "album-with-provider-fallback";
  const servarrMetadataUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/Servarr Metadata Server-cover.jpg";
  const providerUrl = "https://resources.tidal.com/images/11111111/1111/1111/1111/111111111111/750x750.jpg";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      "artist-mbid",
      "provider Fallback Album",
      JSON.stringify([{ coverType: "Cover", url: providerUrl, source: "provider-fallback" }]),
    );

  const artworkUrl = mediaCoverServiceModule.chooseCachedAlbumArtwork({
    albumMbid,
    servarrMetadataData: {
      Images: [
        {
          CoverType: "Cover",
          Url: servarrMetadataUrl,
          Width: 1200,
          Height: 1200,
        },
      ],
    },
    providerCandidates: [],
  });

  const hash = artworkUrl?.split("/")[2] ?? "";
  assert.equal(mediaCoverServiceModule.getRegisteredMediaCoverProxyUrl(hash), servarrMetadataUrl);
});
