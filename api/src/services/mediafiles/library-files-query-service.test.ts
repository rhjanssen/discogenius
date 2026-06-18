import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-files-query-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { listLibraryFiles } = await import("./library-files-query-service.js");

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

function seedCanonicalTrackFileOnly() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("release-group-mbid", "artist-mbid", "Provider Limited Album", "album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-mbid", "release-group-mbid", "artist-mbid", "Provider Limited Album", 1, 1);
  db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, ?)
  `).run("recording-mbid", "Only High Quality Track", "artist-mbid", 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-mbid", "release-mbid", "recording-mbid", "Only High Quality Track", 1, 1);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, quality, library_slot,
      match_status, match_confidence, match_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "provider-track",
    "artist-mbid",
    "release-group-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    "Only High Quality Track",
    "HIGH",
    "stereo",
    "verified",
    1,
    "test",
  );

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, album_id, media_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality, codec
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    null,
    null,
    "artist-mbid",
    "release-group-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    "tidal",
    "track",
    "provider-track",
    "stereo",
    "C:/Music/Canonical Artist/Only High Quality Track.flac",
    "Canonical Artist/Only High Quality Track.flac",
    "C:/Music",
    "Only High Quality Track.flac",
    "flac",
    "track",
    "HIGH",
    "FLAC",
  );
}

test("library file listing reads source quality from canonical ProviderItems without legacy provider rows", () => {
  seedCanonicalTrackFileOnly();

  const result = listLibraryFiles({ fileType: "track" });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quality, "HIGH");
  assert.equal(result.items[0].qualityTarget, "HIGH");
  assert.equal(result.items[0].qualityChangeWanted, false);
  assert.equal(result.items[0].qualityChangeDirection, "none");
});
