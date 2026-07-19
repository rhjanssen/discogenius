import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-query-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let albumQueryModule: typeof import("./album-query-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  albumQueryModule = await import("./album-query-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM AlbumLibraryProjectionState").run();
  db.prepare("DELETE FROM AlbumLibraryIndex").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM ArtistReleaseGroupCuration").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedAlbum(options: {
  mbid: string;
  title: string;
  stereoProvider: string;
  stereoQuality: string;
  spatialProvider: string;
  spatialQuality: string;
}): void {
  const { db } = dbModule;
  const artistMbid = "artist-mbid";
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Filter Artist')
  `).run(artistMbid);
  db.prepare(`
    INSERT OR IGNORE INTO Artists (id, mbid, name, monitored)
    VALUES (?, ?, 'Filter Artist', 1)
  `).run(artistMbid, artistMbid);

  const album = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, 'Album', '2026-01-01')
    RETURNING id
  `).get(options.mbid, artistMbid, options.title) as { id: number };

  db.prepare(`
    INSERT INTO ArtistReleaseGroupCuration (
      source_artist_mbid, release_group_id, release_group_mbid, included
    ) VALUES (?, ?, ?, 1)
  `).run(artistMbid, album.id, options.mbid);

  const insertSlot = db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_id, release_group_mbid, slot, monitored,
      selected_provider, selected_provider_id, quality, match_status
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'verified')
  `);
  insertSlot.run(
    artistMbid,
    album.id,
    options.mbid,
    "stereo",
    options.stereoProvider,
    `${options.mbid}-stereo`,
    options.stereoQuality,
  );
  insertSlot.run(
    artistMbid,
    album.id,
    options.mbid,
    "spatial",
    options.spatialProvider,
    `${options.mbid}-spatial`,
    options.spatialQuality,
  );
}

test("provider and quality filters must be satisfied by the same selected slot", () => {
  seedAlbum({
    mbid: "cross-slot-album",
    title: "Cross Slot",
    stereoProvider: "tidal",
    stereoQuality: "HIRES_LOSSLESS",
    spatialProvider: "apple-music",
    spatialQuality: "DOLBY_ATMOS",
  });
  seedAlbum({
    mbid: "same-slot-album",
    title: "Same Slot",
    stereoProvider: "apple-music",
    stereoQuality: "HIRES_LOSSLESS",
    spatialProvider: "tidal",
    spatialQuality: "DOLBY_ATMOS",
  });

  const result = albumQueryModule.AlbumQueryService.listAlbums({
    limit: 20,
    offset: 0,
    provider: "apple-music",
    qualityTier: "MAX",
  });

  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map((album) => album.id), ["same-slot-album"]);
});
