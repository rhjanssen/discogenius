import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-command-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let serviceModule: typeof import("./album-command-service.js");
let queueModule: typeof import("../jobs/queue.js");

function assertRetiredProviderCatalogTablesAbsent() {
  const rows = dbModule.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('ProviderAlbums', 'ProviderMedia', 'ProviderAlbumArtists', 'ProviderMediaArtists')
  `).all() as Array<{ name: string }>;
  assert.deepEqual(rows, []);
}

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  serviceModule = await import("./album-command-service.js");
  queueModule = await import("../jobs/queue.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM job_queue").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedAlbum() {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid-1", "Artist One");
  db.prepare("INSERT INTO Artists (id, mbid, name, monitored) VALUES (?, ?, ?, ?)").run("artist-1", "artist-mbid-1", "Artist One", 1);
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)")
    .run("release-group-mbid-1", "artist-mbid-1", "Album One", "Album");
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "release-group-mbid-1", "stereo", 0, "tidal", "provider-album-1");
db.prepare(`
    INSERT INTO AlbumReleases (id, foreign_release_id, mbid, release_group_mbid, artist_mbid, title, status, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(201, "release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Album One", "Official", 1, 1);
  db.prepare(`
    INSERT INTO Recordings (id, foreign_recording_id, mbid, artist_mbid, title, is_video)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(301, "recording-mbid-1", "recording-mbid-1", "artist-mbid-1", "Track One", 0);
  db.prepare(`
    INSERT INTO Tracks (id, foreign_track_id, foreign_recording_id, mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(401, "track-mbid-1", "recording-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Track One");
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, track_mbid, recording_mbid,
      title, quality, album_release_id, track_id, recording_id, match_status, match_confidence, match_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal", "track", "provider-track-1", "artist-mbid-1", "release-group-mbid-1", "release-mbid-1", "track-mbid-1", "recording-mbid-1",
    "Track One", "LOSSLESS", 201, 401, 301, "verified", 1, "test",
  );
}

test("album monitor command writes release-group slots and ignores provider album IDs", () => {
  seedAlbum();

  const providerResult = serviceModule.AlbumCommandService.setAlbumMonitored("provider-album-1", true);
  assert.equal(providerResult.success, false);
  assert.equal(providerResult.status, 404);

  const canonicalResult = serviceModule.AlbumCommandService.setAlbumMonitored("release-group-mbid-1", true);
  assert.equal(canonicalResult.success, true);

  const slot = dbModule.db.prepare("SELECT monitored AS wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'")
    .get("release-group-mbid-1") as { wanted: number };

  assert.equal(slot.wanted, 1);
  assertRetiredProviderCatalogTablesAbsent();
});

test("album update command stores monitor lock on release-group slots", () => {
  seedAlbum();

  const result = serviceModule.AlbumCommandService.updateAlbum("release-group-mbid-1", undefined, true);
  assert.equal(result.success, true);

  const slot = dbModule.db.prepare("SELECT monitored_lock FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'")
    .get("release-group-mbid-1") as { monitored_lock: number };

  assert.equal(slot.monitored_lock, 1);
  assertRetiredProviderCatalogTablesAbsent();
});

test("track monitor command uses canonical tracks and selected provider offers", async () => {
  seedAlbum();

  const providerOnly = await serviceModule.AlbumCommandService.monitorTrack("provider-track-1", true);
  assert.equal(providerOnly.success, false);
  assert.equal(providerOnly.status, 404);

  const result = await serviceModule.AlbumCommandService.monitorTrack("track-mbid-1", true);
  assert.equal(result.success, true);
  assert.equal(result.albumId, "release-group-mbid-1");

  const slot = dbModule.db.prepare("SELECT monitored AS wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'")
    .get("release-group-mbid-1") as { wanted: number };
  assert.equal(slot.wanted, 1);

  const job = dbModule.db.prepare("SELECT type, ref_id AS refId, payload FROM job_queue WHERE type = ?")
    .get(queueModule.JobTypes.DownloadTrack) as { type: string; refId: string; payload: string } | undefined;
  assert.ok(job);
  assert.equal(job?.refId, "401");
  const payload = JSON.parse(job?.payload || "{}") as { providerId?: string; canonicalTrackId?: string; canonicalTrackMbid?: string };
  assert.equal(payload.providerId, "provider-track-1");
  assert.equal(payload.canonicalTrackId, "401");
  assert.equal(payload.canonicalTrackMbid, "track-mbid-1");
});
