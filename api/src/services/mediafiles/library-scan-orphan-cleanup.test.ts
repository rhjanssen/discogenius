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
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  downloadState.invalidateAllDownloadState();
}

beforeEach(resetRows);
afterEach(resetRows);

function seedCanonicalArtistGraph() {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
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
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) SELECT library.id, (SELECT id FROM Albums WHERE mbid = 'release-group-1'), 'manual', 0, 'orphan_cleanup_test', 1
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
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    )
    SELECT library_group.library_id, release.id, 'manual', 'orphan_cleanup_test', 1
    FROM LibraryAlbums library_group
    JOIN AlbumEditions release ON release.mbid = 'release-1'
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
      artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type, file_class
    ) VALUES (
      (SELECT library_id FROM LibraryAlbums WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = 'release-group-1') ORDER BY library_id LIMIT 1),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audio'
    )
  `).run(
    (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id,
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

function writePcmWav(filePath: string): void {
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const dataSize = sampleRate * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, wav);
}

test("scan backfills file-derived quality and technical facts on relinked library files", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'")
    .get() as { id: number };
  const filePath = path.join(tempDir, "existing-library-track.wav");
  writePcmWav(filePath);
  const library = db.prepare(`
    SELECT library_id AS id FROM LibraryAlbums
    WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = 'release-group-1')
    LIMIT 1
  `).get() as { id: number };
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-1'").get() as { id: number };
  const track = db.prepare("SELECT id, recording_id FROM Tracks WHERE mbid = 'track-1'")
    .get() as { id: number; recording_id: number };
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wav', 'track', 'audio')
  `).run(
    artist.id,
    library.id,
    release.id,
    track.id,
    track.recording_id,
    filePath,
    path.basename(filePath),
    tempDir,
    path.basename(filePath),
  );

  const result = await (DiskScanService as any).backfillMissingAudioFacts(String(artist.id));
  assert.equal(result.updated, 1);
  const row = db.prepare(`
    SELECT quality, imported_quality, sample_rate, bit_depth, channels, duration
    FROM TrackFiles WHERE file_path = ?
  `).get(filePath) as Record<string, unknown>;
  assert.equal(row.quality, "LOSSLESS");
  assert.equal(row.imported_quality, "LOSSLESS");
  assert.equal(row.sample_rate, 44_100);
  assert.equal(row.bit_depth, 16);
  assert.equal(row.channels, 2);
  assert.equal(row.duration, 1);
});

test("orphan removal invalidates the cached album download status (provider-linked row)", async () => {
  seedCanonicalArtistGraph();
  insertMissingTrackFile("track-1", "recording-1", "track-one.flac", "provider-track-1");

  // Prime the album-stats cache: one of two tracks present.
  const primed = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(primed.downloadedTracks, 1);

  await DiskScanService.scan({
    artistIds: [
      String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id),
    ],
  });

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

  await DiskScanService.scan({
    artistIds: [
      String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id),
    ],
  });

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, 0);

  const afterScan = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(afterScan.downloadedTracks, 0);
});

test("fresh active-schema full scan uses LibraryArtists paths and reconciles TrackFiles by numeric identity", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'")
    .get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryArtists (library_id, artist_metadata_id, policy, credited_scope, path)
    SELECT id, ?, 'all', 'release_and_track_credit', 'Canonical/Artist'
    FROM Libraries
    WHERE enabled = 1
    ORDER BY id
    LIMIT 1
  `).run(artist.id);
  insertMissingTrackFile("track-1", "recording-1", "full-scan.flac", null);

  const result = await DiskScanService.scan({ filter: "known" });

  assert.equal(result.artists, 1);
  assert.equal(result.orphansRemoved, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n,
    0,
    "the full scan must not bind the artist MBID to TrackFiles.artist_metadata_id",
  );
});
