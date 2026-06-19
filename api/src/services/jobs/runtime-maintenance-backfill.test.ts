import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-rt-maintenance-backfill-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { backfillCanonicalTrackFiles, backfillTrackFileForeignKeys, dedupeLibraryFiles, repairMonitoringGaps } = await import("./runtime-maintenance.js");

function resetRows() {
  for (const table of [
    "TrackFiles", "ProviderItems", "ReleaseGroupSlots", "Tracks", "Recordings",
    "AlbumReleases", "Albums", "ArtistMetadata", "Artists",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(resetRows);
afterEach(resetRows);

// Seed the canonical graph plus ProviderItems. TrackFiles may still carry
// media_id/album_id shadow ids, but those shadows now resolve through provider
// offers rather than retired legacy provider catalog tables.
function seedLegacyGraph() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Legacy Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Legacy Artist");

  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("release-group-1", "artist-mbid", "Legacy Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)`).run("release-1", "release-group-1", "artist-mbid", "Legacy Album", 1, 1);
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)`)
    .run("recording-1", "Track One", "artist-mbid", 0);
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)`).run("track-1", "release-1", "recording-1", "Track One", 1, 1);

  db.prepare(`
    INSERT OR IGNORE INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, title, quality, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "album", "provider-album-1", "artist-mbid", "release-group-1", "release-1", "Legacy Album", "LOSSLESS", "stereo");
  db.prepare(`
    INSERT OR IGNORE INTO ProviderItems (
      provider, entity_type, provider_id, provider_album_id, artist_mbid,
      release_group_mbid, release_mbid, track_mbid, recording_mbid, title,
      quality, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "track", "provider-track-1", "provider-album-1", "artist-mbid", "release-group-1", "release-1", "track-1", "recording-1", "Track One", "LOSSLESS", "stereo");
}

function seedCanonicalMonitoringGraph() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Canonical Artist");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)`).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video, monitored)
    VALUES (?, ?, ?, ?, ?)`).run("video-recording-1", "Canonical Video", "artist-mbid", 1, 0);
}

function insertLegacyTrackFile(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    artist_id: "artist-local",
    album_id: "provider-album-1",
    media_id: "provider-track-1",
    canonical_artist_mbid: null,
    canonical_release_group_mbid: null,
    canonical_release_mbid: null,
    canonical_track_mbid: null,
    canonical_recording_mbid: null,
    provider: null,
    provider_entity_type: null,
    provider_id: null,
    library_slot: "stereo",
    file_path: "C:/Music/track-one.flac",
    relative_path: "track-one.flac",
    library_root: "C:/Music",
    filename: "track-one.flac",
    extension: "flac",
    file_type: "track",
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, album_id, media_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (
      @artist_id, @album_id, @media_id, @canonical_artist_mbid, @canonical_release_group_mbid,
      @canonical_release_mbid, @canonical_track_mbid, @canonical_recording_mbid,
      @provider, @provider_entity_type, @provider_id,
      @library_slot, @file_path, @relative_path, @library_root, @filename, @extension, @file_type
    )
  `).run(row);
  return Number(info.lastInsertRowid);
}

function freshSummary() {
  return {
    duplicateLibraryFilesRemoved: 0,
    duplicateTrackedAssetsRemoved: 0,
    staleTrackedAssetsRemoved: 0,
    mediaMonitorRepairs: 0,
    albumMonitorRepairs: 0,
    artistMonitorRepairs: 0,
    albumStatesRefreshed: 0,
    artistStatesRefreshed: 0,
    databaseOptimized: false,
    mediaIdentityIndexEnsured: false,
    trackedAssetIdentityIndexesEnsured: false,
    historyJobsPruned: 0,
    canonicalTrackFilesBackfilled: 0,
    trackFileForeignKeysBackfilled: 0,
  };
}

function getCanonical(id: number) {
  return db.prepare(`
    SELECT canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
           canonical_track_mbid, canonical_recording_mbid
    FROM TrackFiles WHERE id = ?
  `).get(id) as Record<string, string | null>;
}

function seedProviderTrackOffer() {
  // Provider availability offer the canonical-only resolver resolves mbids from.
  db.prepare(`
    INSERT OR IGNORE INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, provider_album_id, title,
      quality, library_slot
    )
    VALUES ('tidal', 'track', 'provider-track-1', 'artist-mbid', 'release-group-1', 'release-1', 'track-1', 'recording-1', 'provider-album-1', 'Track One', 'LOSSLESS', 'stereo')
  `).run();
}

test("back-fills canonical ids for a legacy track file via the ProviderItems offer", () => {
  seedLegacyGraph();
  seedProviderTrackOffer();
  const id = insertLegacyTrackFile({ provider: "tidal", provider_entity_type: "track", provider_id: "provider-track-1" });

  const summary = freshSummary();
  backfillCanonicalTrackFiles(summary);

  assert.equal(summary.canonicalTrackFilesBackfilled, 1);
  const row = getCanonical(id);
  assert.equal(row.canonical_artist_mbid, "artist-mbid");
  assert.equal(row.canonical_release_group_mbid, "release-group-1");
  assert.equal(row.canonical_release_mbid, "release-1");
  assert.equal(row.canonical_track_mbid, "track-1");
  assert.equal(row.canonical_recording_mbid, "recording-1");
});

test("never overwrites canonical ids already present and is idempotent", () => {
  seedLegacyGraph();
  seedProviderTrackOffer();
  const id = insertLegacyTrackFile({
    provider: "tidal", provider_entity_type: "track", provider_id: "provider-track-1",
    canonical_recording_mbid: "manually-pinned-recording",
  });

  const first = freshSummary();
  backfillCanonicalTrackFiles(first);
  assert.equal(first.canonicalTrackFilesBackfilled, 1); // filled the other NULL columns

  const row = getCanonical(id);
  // Existing value preserved, not clobbered by the resolver's recording-1.
  assert.equal(row.canonical_recording_mbid, "manually-pinned-recording");
  assert.equal(row.canonical_release_group_mbid, "release-group-1");

  // Second run finds nothing to fill (release_group already set, recording set).
  const second = freshSummary();
  backfillCanonicalTrackFiles(second);
  assert.equal(second.canonicalTrackFilesBackfilled, 0);
});

test("skips rows with no legacy linkage to resolve from", () => {
  seedLegacyGraph();
  // A row with neither media_id nor album_id is not a candidate.
  const id = insertLegacyTrackFile({ media_id: null, album_id: null });

  const summary = freshSummary();
  backfillCanonicalTrackFiles(summary);
  assert.equal(summary.canonicalTrackFilesBackfilled, 0);
  assert.equal(getCanonical(id).canonical_release_group_mbid, null);
});

test("leaves a fully-populated row untouched", () => {
  seedLegacyGraph();
  insertLegacyTrackFile({
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
  });

  const summary = freshSummary();
  backfillCanonicalTrackFiles(summary);
  assert.equal(summary.canonicalTrackFilesBackfilled, 0);
});

function countTrackFiles() {
  return (db.prepare("SELECT COUNT(*) c FROM TrackFiles").get() as { c: number }).c;
}

test("canonical dedupe removes same-track/same-slot dupes with different media_ids", () => {
  seedLegacyGraph();
  // Same track (same release appearance) + slot, two different legacy media_ids —
  // the media-id key alone would keep both; the canonical track key collapses them.
  insertLegacyTrackFile({ media_id: "media-a", canonical_track_mbid: "track-1", canonical_recording_mbid: "rec-1", library_slot: "stereo", file_path: "C:/Music/a.flac", filename: "a.flac" });
  insertLegacyTrackFile({ media_id: "media-b", canonical_track_mbid: "track-1", canonical_recording_mbid: "rec-1", library_slot: "stereo", file_path: "C:/Music/b.flac", filename: "b.flac" });
  assert.equal(countTrackFiles(), 2);

  const summary = freshSummary();
  dedupeLibraryFiles(summary);

  assert.equal(summary.duplicateLibraryFilesRemoved, 1);
  assert.equal(countTrackFiles(), 1);
});

test("canonical dedupe KEEPS the same recording on different releases (different tracks)", () => {
  seedLegacyGraph();
  // The same recording appears as a track on two different releases — both files
  // are legitimate and must NOT be merged (one recording -> many files).
  insertLegacyTrackFile({ media_id: "media-album", canonical_track_mbid: "track-onAlbum", canonical_recording_mbid: "rec-1", library_slot: "stereo", file_path: "C:/Music/album.flac", filename: "album.flac" });
  insertLegacyTrackFile({ media_id: "media-compilation", canonical_track_mbid: "track-onComp", canonical_recording_mbid: "rec-1", library_slot: "stereo", file_path: "C:/Music/comp.flac", filename: "comp.flac" });

  const summary = freshSummary();
  dedupeLibraryFiles(summary);

  assert.equal(summary.duplicateLibraryFilesRemoved, 0);
  assert.equal(countTrackFiles(), 2);
});

test("canonical dedupe keeps the same track across different library slots", () => {
  seedLegacyGraph();
  // Stereo and spatial copies of the same track are NOT duplicates.
  insertLegacyTrackFile({ media_id: "media-stereo", canonical_track_mbid: "track-1", library_slot: "stereo", file_path: "C:/Music/s.flac", filename: "s.flac" });
  insertLegacyTrackFile({ media_id: "media-spatial", canonical_track_mbid: "track-1", library_slot: "spatial", file_path: "C:/Atmos/s.m4a", filename: "s.m4a", extension: "m4a" });

  const summary = freshSummary();
  dedupeLibraryFiles(summary);

  assert.equal(summary.duplicateLibraryFilesRemoved, 0);
  assert.equal(countTrackFiles(), 2);
});

test("canonical dedupe merges duplicate videos by recording within a slot", () => {
  seedLegacyGraph();
  // Videos have no release/track — identity is the recording.
  insertLegacyTrackFile({ media_id: "vid-a", canonical_recording_mbid: "video-rec-1", file_type: "video", library_slot: "video", file_path: "C:/Videos/v1.mp4", filename: "v1.mp4", extension: "mp4" });
  insertLegacyTrackFile({ media_id: "vid-b", canonical_recording_mbid: "video-rec-1", file_type: "video", library_slot: "video", file_path: "C:/Videos/v2.mp4", filename: "v2.mp4", extension: "mp4" });

  const summary = freshSummary();
  dedupeLibraryFiles(summary);

  assert.equal(summary.duplicateLibraryFilesRemoved, 1);
  assert.equal(countTrackFiles(), 1);
});

test("dedupe still collapses legacy rows sharing media_id with no canonical recording", () => {
  seedLegacyGraph();
  insertLegacyTrackFile({ media_id: "media-x", canonical_recording_mbid: null, library_slot: "stereo", file_path: "C:/Music/x1.flac", filename: "x1.flac" });
  insertLegacyTrackFile({ media_id: "media-x", canonical_recording_mbid: null, library_slot: "stereo", file_path: "C:/Music/x2.flac", filename: "x2.flac" });

  const summary = freshSummary();
  dedupeLibraryFiles(summary);

  assert.equal(summary.duplicateLibraryFilesRemoved, 1);
  assert.equal(countTrackFiles(), 1);
});

function idByMbid(table: string, mbid: string): number {
  return (db.prepare(`SELECT id FROM ${table} WHERE mbid = ?`).get(mbid) as { id: number }).id;
}

test("backfills canonical integer FKs from the canonical mbids", () => {
  seedLegacyGraph();
  const id = insertLegacyTrackFile({
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
  });
  // Simulate a pre-trigger row (FKs not yet populated). Updating FK columns does
  // NOT fire the populate-on-write trigger (it watches the mbid/provider_id cols).
  db.prepare("UPDATE TrackFiles SET release_group_id=NULL, album_release_id=NULL, track_id=NULL, recording_id=NULL WHERE id=?").run(id);

  const summary = freshSummary();
  backfillTrackFileForeignKeys(summary);

  assert.equal(summary.trackFileForeignKeysBackfilled, 1);
  const row = db.prepare(`
    SELECT release_group_id, album_release_id, track_id, recording_id FROM TrackFiles WHERE id = ?
  `).get(id) as Record<string, number | null>;
  assert.equal(row.release_group_id, idByMbid("Albums", "release-group-1"));
  assert.equal(row.album_release_id, idByMbid("AlbumReleases", "release-1"));
  assert.equal(row.track_id, idByMbid("Tracks", "track-1"));
  assert.equal(row.recording_id, idByMbid("Recordings", "recording-1"));

  // Idempotent: a second run fills nothing.
  const second = freshSummary();
  backfillTrackFileForeignKeys(second);
  assert.equal(second.trackFileForeignKeysBackfilled, 0);
});

test("backfills recording_id for mbid-less provider videos via the video ProviderItems offer", () => {
  seedLegacyGraph();
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)`)
    .run(null, "Some Video", "artist-mbid", 1);
  const videoRecordingId = (db.prepare(
    "SELECT id FROM Recordings WHERE title = 'Some Video' AND is_video = 1",
  ).get() as { id: number }).id;
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, recording_id, title, library_slot)
    VALUES (?, ?, ?, ?, ?, ?)`).run("tidal", "video", "vid-999", videoRecordingId, "Some Video", "video");

  const id = insertLegacyTrackFile({
    media_id: null, album_id: null,
    file_type: "video", library_slot: "video",
    provider: "tidal", provider_entity_type: "video", provider_id: "vid-999",
    file_path: "C:/Videos/some-video.mp4", filename: "some-video.mp4", extension: "mp4",
  });
  // Simulate a pre-trigger row.
  db.prepare("UPDATE TrackFiles SET recording_id=NULL WHERE id=?").run(id);

  const summary = freshSummary();
  backfillTrackFileForeignKeys(summary);

  assert.equal(summary.trackFileForeignKeysBackfilled, 1);
  const row = db.prepare("SELECT recording_id FROM TrackFiles WHERE id = ?").get(id) as { recording_id: number | null };
  assert.equal(row.recording_id, videoRecordingId);
});

test("monitoring gap repair promotes installed audio slots canonically without provider rows", () => {
  seedCanonicalMonitoringGraph();
  insertLegacyTrackFile({
    album_id: null,
    media_id: null,
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    file_path: "C:/Music/canonical-audio.flac",
    filename: "canonical-audio.flac",
  });

  const summary = freshSummary();
  repairMonitoringGaps(summary);

  assert.equal(summary.albumMonitorRepairs, 1);
  assert.equal(summary.mediaMonitorRepairs, 0);
  const slot = db.prepare(`
    SELECT monitored, monitored_lock
    FROM ReleaseGroupSlots
    WHERE artist_mbid = ? AND release_group_mbid = ? AND slot = ?
  `).get("artist-mbid", "release-group-1", "stereo") as { monitored: number; monitored_lock: number };
  assert.equal(slot.monitored, 1);
  assert.equal(slot.monitored_lock, 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});

test("monitoring gap repair respects locked canonical audio slots", () => {
  seedCanonicalMonitoringGraph();
  db.prepare(`INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, monitored_lock)
    VALUES (?, ?, ?, ?, ?)`).run("artist-mbid", "release-group-1", "stereo", 0, 1);
  insertLegacyTrackFile({
    album_id: null,
    media_id: null,
    canonical_artist_mbid: "artist-mbid",
    canonical_release_group_mbid: "release-group-1",
    file_path: "C:/Music/locked-audio.flac",
    filename: "locked-audio.flac",
  });

  const summary = freshSummary();
  repairMonitoringGaps(summary);

  assert.equal(summary.albumMonitorRepairs, 0);
  const slot = db.prepare(`
    SELECT monitored, monitored_lock
    FROM ReleaseGroupSlots
    WHERE artist_mbid = ? AND release_group_mbid = ? AND slot = ?
  `).get("artist-mbid", "release-group-1", "stereo") as { monitored: number; monitored_lock: number };
  assert.equal(slot.monitored, 0);
  assert.equal(slot.monitored_lock, 1);
});

test("monitoring gap repair promotes installed canonical videos without provider rows", () => {
  seedCanonicalMonitoringGraph();
  insertLegacyTrackFile({
    album_id: null,
    media_id: null,
    file_type: "video",
    library_slot: "video",
    canonical_artist_mbid: "artist-mbid",
    canonical_recording_mbid: "video-recording-1",
    file_path: "C:/Videos/canonical-video.mp4",
    filename: "canonical-video.mp4",
    extension: "mp4",
  });

  const summary = freshSummary();
  repairMonitoringGaps(summary);

  assert.equal(summary.mediaMonitorRepairs, 1);
  const recording = db.prepare("SELECT monitored, monitored_at FROM Recordings WHERE mbid = ?")
    .get("video-recording-1") as { monitored: number; monitored_at: string | null };
  assert.equal(recording.monitored, 1);
  assert.ok(recording.monitored_at);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});

test("monitoring gap repair resolves mbid-less provider video files through ProviderItems", () => {
  seedCanonicalMonitoringGraph();
  db.prepare(`INSERT INTO Recordings (mbid, title, artist_mbid, is_video, monitored)
    VALUES (?, ?, ?, ?, ?)`).run(null, "Provider Video", "artist-mbid", 1, 0);
  const recordingId = (db.prepare("SELECT id FROM Recordings WHERE title = ?").get("Provider Video") as { id: number }).id;
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, recording_id, title, library_slot)
    VALUES (?, ?, ?, ?, ?, ?)`).run("tidal", "video", "provider-video-1", recordingId, "Provider Video", "video");
  insertLegacyTrackFile({
    album_id: null,
    media_id: null,
    file_type: "video",
    library_slot: "video",
    provider: "tidal",
    provider_entity_type: "video",
    provider_id: "provider-video-1",
    file_path: "C:/Videos/provider-video.mp4",
    filename: "provider-video.mp4",
    extension: "mp4",
  });

  const summary = freshSummary();
  repairMonitoringGaps(summary);

  assert.equal(summary.mediaMonitorRepairs, 1);
  const providerRecording = db.prepare("SELECT monitored FROM Recordings WHERE id = ?")
    .get(recordingId) as { monitored: number };
  assert.equal(providerRecording.monitored, 1);
});

test("populate-on-write trigger fills canonical integer FKs on INSERT", () => {
  seedLegacyGraph();
  // No backfill call — the production trigger should fill the FKs at insert time.
  const id = insertLegacyTrackFile({
    canonical_release_group_mbid: "release-group-1",
    canonical_release_mbid: "release-1",
    canonical_track_mbid: "track-1",
    canonical_recording_mbid: "recording-1",
  });

  const row = db.prepare(`
    SELECT release_group_id, album_release_id, track_id, recording_id FROM TrackFiles WHERE id = ?
  `).get(id) as Record<string, number | null>;
  assert.equal(row.release_group_id, idByMbid("Albums", "release-group-1"));
  assert.equal(row.album_release_id, idByMbid("AlbumReleases", "release-1"));
  assert.equal(row.track_id, idByMbid("Tracks", "track-1"));
  assert.equal(row.recording_id, idByMbid("Recordings", "recording-1"));
});

test("populate-on-write trigger fills recording_id when mbids are set later (UPDATE)", () => {
  seedLegacyGraph();
  const id = insertLegacyTrackFile({ canonical_recording_mbid: null });
  // Initially no recording mbid -> recording_id stays null.
  assert.equal((db.prepare("SELECT recording_id FROM TrackFiles WHERE id = ?").get(id) as { recording_id: number | null }).recording_id, null);

  // Setting the canonical recording mbid should trigger FK fill.
  db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = ? WHERE id = ?").run("recording-1", id);
  assert.equal((db.prepare("SELECT recording_id FROM TrackFiles WHERE id = ?").get(id) as { recording_id: number | null }).recording_id, idByMbid("Recordings", "recording-1"));
});
