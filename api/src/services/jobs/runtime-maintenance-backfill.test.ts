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
const { backfillCanonicalTrackFiles, backfillTrackFileForeignKeys, dedupeLibraryFiles } = await import("./runtime-maintenance.js");

function resetRows() {
  for (const table of [
    "TrackFiles", "ProviderItems", "ReleaseGroupSlots", "Tracks", "Recordings",
    "AlbumReleases", "Albums", "ArtistMetadata", "Artists", "ProviderMedia", "ProviderAlbums",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(resetRows);
afterEach(resetRows);

// Seed the canonical graph plus the LEGACY provider linkage (ProviderMedia /
// ProviderAlbums) — but NO ProviderItems — so the backfill must resolve the
// canonical ids the legacy way (the pre-canonical-columns world Phase 1 targets).
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

  // Legacy provider rows: album.mbid -> AlbumReleases.mbid, media.mbid -> Tracks.mbid.
  db.prepare(`INSERT INTO ProviderAlbums (id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration, mbid, mb_release_group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("provider-album-1", "artist-local", "Legacy Album", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 200, "release-1", "release-group-1");
  db.prepare(`INSERT INTO ProviderMedia (id, artist_id, album_id, title, type, explicit, quality, mbid, track_number, volume_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("provider-track-1", "artist-local", "provider-album-1", "Track One", "track", 0, "LOSSLESS", "track-1", 1, 1);
}

function ensureProviderMedia(mediaId: unknown, albumId: unknown) {
  if (mediaId === null || mediaId === undefined) return;
  db.prepare(`
    INSERT OR IGNORE INTO ProviderMedia (id, artist_id, album_id, title, type, explicit, quality)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(String(mediaId), "artist-local", albumId === null || albumId === undefined ? null : String(albumId), "Track", "track", 0, "LOSSLESS");
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
  ensureProviderMedia(row.media_id, row.album_id);
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

test("back-fills canonical ids for a legacy track file from media_id/album_id", () => {
  seedLegacyGraph();
  const id = insertLegacyTrackFile();

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
  const id = insertLegacyTrackFile({
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

  const summary = freshSummary();
  backfillTrackFileForeignKeys(summary);

  assert.equal(summary.trackFileForeignKeysBackfilled, 1);
  const row = db.prepare("SELECT recording_id FROM TrackFiles WHERE id = ?").get(id) as { recording_id: number | null };
  assert.equal(row.recording_id, videoRecordingId);
});
