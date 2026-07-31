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
    "TrackFiles", "ProviderItems", "Tracks", "Recordings",
    "AlbumEditions", "Albums", "ArtistMetadata", "Artists",
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
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
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    RETURNING id
  `).get( "tidal", "track", "provider-track", "Only High Quality Track" ) as { id: number };
  const sourceVariant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, 'high', 'lossy', 'HIGH', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      provider_item_id, source_audio_variant_id,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality, codec
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "artist-mbid",
    "release-group-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    providerTrack.id,
    sourceVariant.id,
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

test("library file listing resolves downloaded videos by canonical recording row id", () => {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  const artistMetadata = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
    RETURNING id
  `).get("artist-mbid", "Canonical Artist") as { id: number };
  db.prepare(`
    INSERT INTO Recordings (id, artist_metadata_id, artist_mbid, title, is_video)
    VALUES (?, ?, ?, ?, ?)
  `).run(501, artistMetadata.id, "artist-mbid", "Canonical Video", 1);
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, recording_id, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension,
      file_type, quality, codec, video_codec, width, height, bitrate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    501,
    "tidal",
    "video",
    "provider-video-1",
    "video",
    "C:/Videos/Canonical Artist/Canonical Video.mp4",
    "Canonical Artist/Canonical Video.mp4",
    "C:/Videos",
    "Canonical Video.mp4",
    "mp4",
    "video",
    "FHD",
    "aac",
    "h264",
    1920,
    1080,
    320000,
  );

  const result = listLibraryFiles({ mediaId: "501" });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].file_type, "video");
  assert.equal(result.items[0].media_id, "provider-video-1");
  assert.equal(result.items[0].codec, "aac");
  assert.equal(result.items[0].video_codec, "h264");
  assert.equal(result.items[0].width, 1920);
  assert.equal(result.items[0].height, 1080);
  assert.equal(result.items[0].bitrate, 320000);
});
