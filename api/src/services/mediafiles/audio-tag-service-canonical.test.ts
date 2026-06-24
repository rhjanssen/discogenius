import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-audio-tag-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let audioTagServiceModule: typeof import("./audio-tag-service.js");

before(async () => {
  dbModule = await import("../../database.js");
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
    INSERT INTO ArtistMetadata (foreign_artist_id, mbid, name)
    VALUES (?, ?, ?)
  `).run("artist-mbid-1", "artist-mbid-1", "Artist One");

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (foreign_artist_id, mbid, name)
    VALUES (?, ?, ?)
  `).run("album-artist-mbid-1", "album-artist-mbid-1", "Album Artist One");

  dbModule.db.prepare(`
    INSERT INTO Albums (foreign_album_id, mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, review_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Album", "[\"Compilation\"]", "2024-03-01", "Canonical review text");

  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (foreign_release_id, mbid, release_group_mbid, artist_mbid, title, status, country, date, barcode, copyright, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Official", "[\"[Worldwide]\"]", "2024-03-01", null, "(P) 2024 Canonical Release", 1, 1);

  dbModule.db.prepare(`
    INSERT INTO AlbumArtists (release_group_mbid, artist_mbid, ord, credited_name, is_primary)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "album-artist-mbid-1", 0, "Album Artist One", 1);

  dbModule.db.prepare(`
    INSERT INTO Recordings (foreign_recording_id, mbid, artist_mbid, title, artist_credit, length_ms, copyright, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "recording-mbid-1",
    "recording-mbid-1",
    "artist-mbid-1",
    "Canonical Song",
    "Artist One",
    181000,
    "(P) 2024 Canonical Recording",
    JSON.stringify({
      "artist-credit": [
        { name: "Artist One", artist: { id: "artist-mbid-1", name: "Artist One" } },
        { name: "Guest One", artist: { id: "guest-mbid-1", name: "Guest One" } },
      ],
    }),
  );

  dbModule.db.prepare(`
    INSERT INTO Tracks (foreign_track_id, mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Canonical Song", 181000);

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      album_id, title, quality, upc, release_date, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "provider-album-1",
    "artist-mbid-1",
    "release-group-mbid-1",
    "release-mbid-1",
    "provider-album-1",
    "Canonical Album",
    "LOSSLESS",
    "987654321000",
    "2024-03-01",
    "stereo",
  );

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, album_id, title, explicit, quality, isrc, duration, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-track-1",
    "artist-mbid-1",
    "release-group-mbid-1",
    "release-mbid-1",
    "track-mbid-1",
    "recording-mbid-1",
    "provider-album-1",
    "Canonical Song",
    1,
    "LOSSLESS",
    "TESTISRC1234",
    181,
    "stereo",
  );

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, 'tidal', 'track', 'provider-track-1', 'stereo', ?, ?, ?, ?, ?, 'track', ?)
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

  const tags = audioTagServiceModule.AudioTagService.buildDesiredTagsForTrackFileIdsForTest(
    [Number(inserted.lastInsertRowid)],
    { write_tidal_url: true, embed_album_review: true },
  );
  const byKey = new Map(tags.map((tag) => [tag.key, tag.targetValue]));

  assert.equal(byKey.get("title"), "Canonical Song");
  assert.equal(byKey.get("artist"), "Artist One, Guest One");
  assert.equal(byKey.get("album_artist"), "Album Artist One");
  assert.equal(byKey.get("album"), "Canonical Album");
  assert.equal(byKey.get("track"), "1/1");
  assert.equal(byKey.get("disc"), "1/1");
  assert.equal(byKey.get("date"), "2024-03-01");
  assert.equal(byKey.get("barcode"), "987654321000");
  assert.equal(byKey.get("isrc"), "TESTISRC1234");
  assert.equal(byKey.get("copyright"), "(P) 2024 Canonical Recording");
  assert.equal(byKey.get("comment"), "Canonical review text");
  assert.equal(byKey.get("provider_url"), "https://tidal.com/browse/track/provider-track-1");
  assert.equal(byKey.get("musicbrainz_recordingid"), "recording-mbid-1");
  assert.equal(byKey.get("musicbrainz_albumid"), "release-mbid-1");
  assert.equal(byKey.get("musicbrainz_releasegroupid"), "release-group-mbid-1");
  assert.equal(byKey.get("musicbrainz_releasetrackid"), "track-mbid-1");
  assert.equal(byKey.get("release_status"), "official");
  assert.equal(byKey.get("release_type"), "album; compilation");
  assert.equal(byKey.get("itunesadvisory"), "1");

  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});
