import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-audio-tag-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let audioTagServiceModule: typeof import("./audio-tag-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  audioTagServiceModule = await import("./audio-tag-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("audio tag context derives canonical MusicBrainz tags without provider catalog rows", () => {
  const audioPath = path.join(tempDir, "library", "Artist One", "Canonical Album", "01 - Canonical Song.flac");
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, "not-a-real-audio-file");

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-mbid-1", "Artist One", 1);

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (ForeignArtistId, mbid, name)
    VALUES (?, ?, ?)
  `).run("artist-mbid-1", "artist-mbid-1", "Artist One");

  dbModule.db.prepare(`
    INSERT INTO Albums (ForeignAlbumId, mbid, artist_mbid, title, primary_type, secondary_types, first_release_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Album", "[\"Compilation\"]", "2024-03-01");

  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (ForeignReleaseId, mbid, release_group_mbid, artist_mbid, title, status, country, date, barcode, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Official", "[\"[Worldwide]\"]", "2024-03-01", "123456789012", 1, 1);

  dbModule.db.prepare(`
    INSERT INTO Recordings (ForeignRecordingId, mbid, artist_mbid, title, length_ms, isrcs)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("recording-mbid-1", "recording-mbid-1", "artist-mbid-1", "Canonical Song", 181000, "[\"TESTISRC1234\"]");

  dbModule.db.prepare(`
    INSERT INTO Tracks (ForeignTrackId, mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Canonical Song", 181000);

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, album_id, media_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'stereo', ?, ?, ?, ?, ?, 'track', ?)
  `).run(
    "1",
    "artist-mbid-1",
    "release-group-mbid-1",
    "release-mbid-1",
    "track-mbid-1",
    "recording-mbid-1",
    audioPath,
    path.relative(tempDir, audioPath),
    tempDir,
    path.basename(audioPath),
    "flac",
    "LOSSLESS",
  );

  const tags = audioTagServiceModule.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([Number(inserted.lastInsertRowid)]);
  const byKey = new Map(tags.map((tag) => [tag.key, tag.targetValue]));

  assert.equal(byKey.get("title"), "Canonical Song");
  assert.equal(byKey.get("artist"), "Artist One");
  assert.equal(byKey.get("album"), "Canonical Album");
  assert.equal(byKey.get("track"), "1/1");
  assert.equal(byKey.get("disc"), "1/1");
  assert.equal(byKey.get("date"), "2024-03-01");
  assert.equal(byKey.get("barcode"), "123456789012");
  assert.equal(byKey.get("isrc"), "TESTISRC1234");
  assert.equal(byKey.get("musicbrainz_recordingid"), "recording-mbid-1");
  assert.equal(byKey.get("musicbrainz_albumid"), "release-mbid-1");
  assert.equal(byKey.get("musicbrainz_releasegroupid"), "release-group-mbid-1");
  assert.equal(byKey.get("musicbrainz_releasetrackid"), "track-mbid-1");
  assert.equal(byKey.get("release_status"), "official");
  assert.equal(byKey.get("release_type"), "album; compilation");
});
