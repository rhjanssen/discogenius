import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-provider-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../../database.js");
let tidalProviderModule: typeof import("./tidal-provider.js");

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  tidalProviderModule = await import("./tidal-provider.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM ArtistReleaseGroups").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ProviderMedia").run();
  dbModule.db.prepare("DELETE FROM ProviderAlbums").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCanonicalRelease() {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 2, 2);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Track One", "artist-mbid", 0);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-2", "Track Two", "artist-mbid", 0);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-2", "release-1", "recording-2", "Track Two", 2, 1);
}

test("TIDAL album download progress tracks are built from canonical release tracks", () => {
  seedCanonicalRelease();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      title, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album-1",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "Canonical Album",
    "verified",
    1,
  );

  const rows = tidalProviderModule.getTidalAlbumDownloadTrackInfo(["provider-album-1"]);

  assert.deepEqual(rows, [
    {
      title: "Track One",
      version: null,
      track_num: 1,
      volume_num: 1,
      artist_name: "Canonical Artist",
    },
    {
      title: "Track Two",
      version: null,
      track_num: 1,
      volume_num: 2,
      artist_name: "Canonical Artist",
    },
  ]);
  const legacyRows = dbModule.db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number };
  assert.equal(legacyRows.count, 0);
});

test("TIDAL album download progress can resolve combined selected provider offers via slots", () => {
  seedCanonicalRelease();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      title, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album-part",
    "artist-mbid",
    "release-group-1",
    "Canonical Album Part",
    "probable",
    0.9,
  );
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, selected_provider, selected_provider_id,
      selected_release_mbid, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-mbid",
    "release-group-1",
    "stereo",
    "tidal",
    "provider-album-part;provider-album-extra",
    "release-1",
    "probable",
  );

  const rows = tidalProviderModule.getTidalAlbumDownloadTrackInfo(["provider-album-part"]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.title, "Track One");
  assert.equal(rows[1]?.title, "Track Two");
});

test("TIDAL album download progress falls back to canonical provider items without legacy media rows", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      title, quality, library_slot, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album-unreleased",
    "artist-mbid",
    "release-group-unreleased",
    "Provider-Only Album",
    "LOSSLESS",
    "stereo",
    "probable",
    0.8,
  );
  const insertTrackProviderItem = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      title, version, quality, library_slot, match_status, match_confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrackProviderItem.run(
    "tidal",
    "track",
    "provider-track-b",
    "artist-mbid",
    "release-group-unreleased",
    "Provider Track B",
    null,
    "LOSSLESS",
    "stereo",
    "probable",
    0.8,
    "2026-01-02T00:00:00.000Z",
  );
  insertTrackProviderItem.run(
    "tidal",
    "track",
    "provider-track-a",
    "artist-mbid",
    "release-group-unreleased",
    "Provider Track A",
    "Radio Edit",
    "LOSSLESS",
    "stereo",
    "probable",
    0.8,
    "2026-01-01T00:00:00.000Z",
  );

  const rows = tidalProviderModule.getTidalAlbumDownloadTrackInfo(["provider-album-unreleased"]);

  assert.deepEqual(rows, [
    {
      title: "Provider Track A",
      version: "Radio Edit",
      track_num: null,
      volume_num: null,
      artist_name: "Canonical Artist",
    },
    {
      title: "Provider Track B",
      version: null,
      track_num: null,
      volume_num: null,
      artist_name: "Canonical Artist",
    },
  ]);
  const legacyMediaRows = dbModule.db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number };
  const legacyAlbumRows = dbModule.db.prepare("SELECT COUNT(*) AS count FROM ProviderAlbums").get() as { count: number };
  assert.equal(legacyMediaRows.count, 0);
  assert.equal(legacyAlbumRows.count, 0);
});
