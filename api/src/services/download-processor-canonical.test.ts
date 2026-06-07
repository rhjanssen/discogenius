import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-processor-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { DownloadProcessor } = await import("./download-processor.js");

function resetRows() {
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Artists").run();
}

beforeEach(resetRows);
afterEach(resetRows);

test("download processor resolves canonical album provider offers without legacy provider catalog rows", () => {
  const processor = new DownloadProcessor() as any;

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-bastille", "Bastille", "artist-bastille");
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-bastille", "Bastille");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run("rg-gmtf", "artist-bastille", "Give Me the Future", "album", "2022-02-04");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-gmtf", "rg-gmtf", "artist-bastille", "Give Me the Future", 1, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, IsVideo) VALUES (?, ?, ?)")
    .run("recording-gmtf", "Give Me the Future", 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-gmtf", "release-gmtf", "recording-gmtf", "Give Me the Future", 1, 1);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      title, quality, asset_id, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "tidal-gmtf-expanded",
    "artist-bastille",
    "rg-gmtf",
    "release-gmtf",
    "Give Me The Future + Dreams Of The Past",
    "HIRES_LOSSLESS",
    "provider-cover",
    "probable",
    0.91,
  );
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted,
      selected_provider, selected_provider_id, selected_release_mbid, quality, provider_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-bastille",
    "rg-gmtf",
    "stereo",
    1,
    "tidal",
    "tidal-gmtf-expanded",
    "release-gmtf",
    "HIRES_LOSSLESS",
    JSON.stringify({ cover: "slot-cover", artist: { name: "Bastille" } }),
  );

  const payload = {
    type: "album",
    provider: "tidal",
    providerId: "tidal-gmtf-expanded",
    releaseGroupMbid: "rg-gmtf",
    slot: "stereo",
  };

  assert.equal(processor.hasAlbumMetadataReady("tidal-gmtf-expanded", payload), true);
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-gmtf-expanded", "album", payload), {
    title: "Give Me the Future",
    artist: "Bastille",
    cover: "slot-cover",
  });
  assert.equal(processor.resolveDownloadQuality("tidal-gmtf-expanded", "album", payload), "HIRES_LOSSLESS");
});

test("download processor detects canonical track and video files without ProviderMedia rows", () => {
  const processor = new DownloadProcessor() as any;

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-media", "Media Artist", "artist-media");
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-media", "Media Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-media", "artist-media", "Media Album", "album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-media", "rg-media", "artist-media", "Media Album", 1, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, IsVideo) VALUES (?, ?, ?)")
    .run("recording-track", "Canonical Track", 0);
  db.prepare("INSERT INTO Recordings (mbid, title, IsVideo) VALUES (?, ?, ?)")
    .run("recording-video", "Canonical Video", 1);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-media", "release-media", "recording-track", "Canonical Track", 1, 1);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, quality, asset_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "tidal-track",
    "artist-media",
    "rg-media",
    "release-media",
    "track-media",
    "recording-track",
    "Provider Track",
    "LOSSLESS",
    "track-cover",
  );
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_mbid, title, quality, asset_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "video",
    "tidal-video",
    "artist-media",
    "recording-video",
    "Provider Video",
    "1080p",
    "video-cover",
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-media",
    "track-media",
    "recording-track",
    "tidal",
    "track",
    "tidal-track",
    "stereo",
    "C:/Music/Media Artist/track.flac",
    "Media Artist/track.flac",
    "C:/Music",
    "track.flac",
    "flac",
    "track",
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-media",
    "recording-video",
    "tidal",
    "video",
    "tidal-video",
    "video",
    "C:/Music/Media Artist/video.mp4",
    "Media Artist/video.mp4",
    "C:/Music",
    "video.mp4",
    "mp4",
    "video",
  );

  assert.equal(processor.hasTrackMetadataReady("tidal-track", { type: "track", providerId: "tidal-track" }), true);
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-track", "track", { type: "track", providerId: "tidal-track" }), {
    title: "Canonical Track",
    artist: "Media Artist",
    cover: "track-cover",
  });
  assert.equal(processor.isCanonicalProviderItemDownloaded("tidal-track", "track", { type: "track", providerId: "tidal-track" }), true);

  assert.equal(processor.hasVideoMetadataReady("tidal-video", { type: "video", providerId: "tidal-video" }), true);
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-video", "video", { type: "video", providerId: "tidal-video" }), {
    title: "Canonical Video",
    artist: "Media Artist",
    cover: "video-cover",
  });
  assert.equal(processor.isCanonicalProviderItemDownloaded("tidal-video", "video", { type: "video", providerId: "tidal-video" }), true);
});
