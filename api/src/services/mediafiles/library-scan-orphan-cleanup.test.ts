import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-orphan-cleanup-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const downloadState = await import("../download/download-state.js");
const { DiskScanService } = await import("./library-scan.js");

function resetRows() {
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Artists").run();
  downloadState.invalidateAllDownloadState();
}

beforeEach(resetRows);
afterEach(resetRows);

function seedCanonicalArtistGraph() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 2, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Track One", "artist-mbid", 0);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-2", "Track Two", "artist-mbid", 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-2", "release-1", "recording-2", "Track Two", 1, 2);
  db.prepare(`
    INSERT INTO LibraryReleaseGroups (
      library_id, release_group_id, monitored, selection_mode, locked, reason, curation_version
    )
    SELECT library.id, (SELECT id FROM Albums WHERE mbid = 'release-group-1'), 1, 'manual', 0, 'orphan_cleanup_test', 1
    FROM Libraries library
    JOIN quality_profiles profile ON profile.id = library.quality_profile_id
    WHERE library.enabled = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      )
    ORDER BY library.id
    LIMIT 1
  `).run();
  db.prepare(`
    INSERT INTO LibraryReleases (
      library_id, release_id, selection_mode, locked, reason, curation_version
    )
    SELECT library_group.library_id, release.id, 'manual', 0, 'orphan_cleanup_test', 1
    FROM LibraryReleaseGroups library_group
    JOIN AlbumReleases release ON release.mbid = 'release-1'
    WHERE library_group.release_group_id = release.release_group_id
  `).run();
}

/**
 * Insert a canonical-linked TrackFiles row whose file does NOT exist on disk, so
 * a scan treats it as an orphan. providerId is optional: a provider-free
 * (canonical-only) row has a null provider_id, the exact case the old
 * NULL-AS-album_id bug never invalidated.
 */
function insertMissingTrackFile(
  trackMbid: string,
  recordingMbid: string,
  filename: string,
  providerId: string | null,
) {
  db.prepare(`
    INSERT INTO TrackFiles (
      library_id,
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type, file_class
    ) VALUES (
      (SELECT library_id FROM LibraryReleaseGroups WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = 'release-group-1') ORDER BY library_id LIMIT 1),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audio'
    )
  `).run(
    "artist-local",
    "artist-mbid",
    "release-group-1",
    "release-1",
    trackMbid,
    recordingMbid,
    providerId ? "tidal" : null,
    providerId ? "track" : null,
    providerId,
    "stereo",
    `C:/Nonexistent/${filename}`,
    filename,
    "C:/Nonexistent",
    filename,
    "flac",
    "track",
  );
}

test("orphan removal invalidates the cached album download status (provider-linked row)", async () => {
  seedCanonicalArtistGraph();
  insertMissingTrackFile("track-1", "recording-1", "track-one.flac", "provider-track-1");

  // Prime the album-stats cache: one of two tracks present.
  const primed = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(primed.downloadedTracks, 1);

  await DiskScanService.scan({ artistIds: ["artist-local"] });

  // Row is gone from the file table.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, 0);

  // Without invalidation this returns the stale cached "1"; the fix must flip it
  // to 0 with NO manual invalidateAllDownloadState() call.
  const afterScan = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(afterScan.downloadedTracks, 0);
});

test("orphan removal invalidates status for a provider-free canonical-only row", async () => {
  seedCanonicalArtistGraph();
  // provider_id null — the case the old NULL-as-album_id code never invalidated.
  insertMissingTrackFile("track-1", "recording-1", "track-one.flac", null);

  const primed = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(primed.downloadedTracks, 1);

  await DiskScanService.scan({ artistIds: ["artist-local"] });

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, 0);

  const afterScan = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(afterScan.downloadedTracks, 0);
});
