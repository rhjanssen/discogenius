import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-video-cover-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let tidalProviderModule: typeof import("./tidal-provider.js");
let refreshArtistModule: typeof import("../../music/refresh-artist-service.js");
let dbModule: typeof import("../../../database.js");

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  tidalProviderModule = await import("./tidal-provider.js");
  refreshArtistModule = await import("../../music/refresh-artist-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("TIDAL mapAlbum preserves videoCover from camelCase or snake_case payloads", () => {
  const fromCamel = tidalProviderModule.tidalStreamingProvider.mapAlbumForTests({
    id: 290132977,
    title: "Example",
    artist: { id: 1, name: "Artist" },
    videoCover: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.equal(fromCamel.videoCover, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

  const fromSnake = tidalProviderModule.tidalStreamingProvider.mapAlbumForTests({
    id: 290132977,
    title: "Example",
    artist_id: 1,
    artist_name: "Artist",
    video_cover: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(fromSnake.videoCover, "11111111-2222-3333-4444-555555555555");
});

test("providerAlbumToOfferRow keeps video_cover from ProviderAlbum.videoCover", () => {
  const row = refreshArtistModule.providerAlbumToOfferRow({
    providerId: "290132977",
    title: "Example",
    artist: { providerId: "1", name: "Artist" },
    cover: "cover-uuid",
    videoCover: "video-cover-uuid",
    trackCount: 3,
  }, "fallback-artist");

  assert.equal(row.video_cover, "video-cover-uuid");
  assert.equal(row.cover, "cover-uuid");
  assert.equal(row.provider_id, "290132977");
});
