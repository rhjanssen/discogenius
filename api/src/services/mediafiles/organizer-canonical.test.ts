import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-organizer-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let organizerModule: typeof import("./organizer.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  organizerModule = await import("./organizer.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ProviderMedia").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("organizer resolves exact provider track ids to their linked canonical track", () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run("release-group-1", "artist-mbid", "Canonical Album");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 1, 2);
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
  `).run("track-2", "release-1", "recording-2", "Track Two", 1, 2);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-track-2",
    "artist-mbid",
    "release-group-1",
    "release-1",
    "track-2",
    "recording-2",
    "Track Two",
    "matched",
    1,
  );

  const row = (organizerModule.OrganizerService as any).resolveMatchedCanonicalAlbumTrackRow({
    provider: "tidal",
    trackId: "provider-track-2",
    releaseMbid: "release-1",
    fallbackAlbumId: "provider-album-1",
    fallbackArtistId: "artist-local",
    fallbackQuality: "LOSSLESS",
  });

  assert.equal(row?.canonical_track_mbid, "track-2");
  assert.equal(row?.canonical_recording_mbid, "recording-2");
  assert.equal(row?.title, "Track Two");
  assert.equal(row?.id, "provider-track-2");
  assert.equal(row?.album_id, "provider-album-1");
  assert.equal(row?.track_number, 2);
  assert.equal(row?.volume_number, 1);
  assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number }).count, 0);
});
