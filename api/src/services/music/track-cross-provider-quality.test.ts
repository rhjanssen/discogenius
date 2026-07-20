import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-track-cross-provider-quality-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let trackQuery: typeof import("./track-query-service.js");
let configModule: typeof import("../config/config.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  trackQuery = await import("./track-query-service.js");
});

beforeEach(() => {
  for (const table of [
    "TrackFiles",
    "ReleaseGroupSlots",
    "Tracks",
    "Recordings",
    "AlbumReleases",
    "Albums",
    "Artists",
    "ArtistMetadata",
    "ProviderItems",
  ]) {
    try {
      dbModule.db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // ignore missing tables in fresh schemas
    }
  }
  const config = configModule.readConfig();
  config.filtering = {
    ...config.filtering,
    include_spatial: true,
  };
  configModule.writeConfig(config);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tracklist remoteOffers include stereo and spatial from different providers/releases", () => {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-1", "Artist");
  db.prepare(`INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)`).run("1", "Artist", "artist-1");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'Album')`)
    .run("rg-1", "artist-1", "Album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, 'Official', '2020-01-01', 1, 1)
  `).run("rel-stereo", "rg-1", "artist-1", "Stereo");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, 'Official', '2020-01-01', 1, 1)
  `).run("rel-atmos", "rg-1", "artist-1", "Atmos");
  db.prepare(`INSERT INTO Recordings (mbid, title) VALUES (?, ?)`).run("rec-1", "Song");
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, 1, 1, 180000)
  `).run("track-1", "rel-stereo", "rec-1", "Song");

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id,
      selected_release_mbid, quality, match_status
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'verified')
  `).run("artist-1", "rg-1", "stereo", "tidal", "tidal-album", "rel-stereo", "HIRES_LOSSLESS");
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id,
      selected_release_mbid, quality, match_status
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'verified')
  `).run("artist-1", "rg-1", "spatial", "apple-music", "apple-atmos", "rel-atmos", "DOLBY_ATMOS");

  const detail = trackQuery.getTrackDetail("track-1");
  assert.ok(detail);
  assert.deepEqual(
    (detail.remoteOffers || []).map((offer) => `${offer.slot}:${offer.provider}:${offer.quality}`).sort(),
    ["spatial:apple-music:DOLBY_ATMOS", "stereo:tidal:HIRES_LOSSLESS"],
  );
  assert.ok(detail.qualityTags?.includes("HIRES_LOSSLESS"));
  assert.ok(detail.qualityTags?.includes("DOLBY_ATMOS"));
});
