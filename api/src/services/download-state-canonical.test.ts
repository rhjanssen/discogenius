import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-state-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const downloadState = await import("./download-state.js");

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
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  downloadState.invalidateAllDownloadState();
}

beforeEach(resetRows);
afterEach(resetRows);

function seedCanonicalArtistGraph() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitor) VALUES (?, ?, ?, ?)")
    .run("artist-local", "Canonical Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  const artistMetadata = db.prepare("SELECT Id FROM ArtistMetadata WHERE mbid = ?")
    .get("artist-mbid") as { Id: number };

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 2, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, ArtistMetadataId, IsVideo) VALUES (?, ?, ?, ?, ?)")
    .run("recording-1", "Track One", "artist-mbid", artistMetadata.Id, 0);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, ArtistMetadataId, IsVideo) VALUES (?, ?, ?, ?, ?)")
    .run("recording-2", "Track Two", "artist-mbid", artistMetadata.Id, 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-2", "release-1", "recording-2", "Track Two", 1, 2);
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted,
      selected_provider, selected_provider_id, selected_release_mbid, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid", "release-group-1", "stereo", 1, "tidal", "provider-album-1", "release-1", "LOSSLESS");

  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, ArtistMetadataId, IsVideo, Monitor) VALUES (?, ?, ?, ?, ?, ?)")
    .run("video-recording-1", "Track One", "artist-mbid", artistMetadata.Id, 1, 1);
  const videoRecording = db.prepare("SELECT Id FROM Recordings WHERE mbid = ?")
    .get("video-recording-1") as { Id: number };
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, title, library_slot, recording_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "track", "provider-track-1", "artist-mbid", "release-group-1", "release-1", "track-1", "recording-1", "Track One", "stereo", null);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_mbid, title, library_slot, recording_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "video", "provider-video-1", "artist-mbid", "video-recording-1", "Track One", "video", videoRecording.Id);

  return { videoRecordingId: String(videoRecording.Id) };
}

function insertTrackFile(trackMbid: string, recordingMbid: string, providerId: string, filename: string) {
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "artist-mbid",
    "release-group-1",
    "release-1",
    trackMbid,
    recordingMbid,
    "tidal",
    "track",
    providerId,
    "stereo",
    `C:/Music/${filename}`,
    filename,
    "C:/Music",
    filename,
    "flac",
    "track",
  );
}

function insertVideoFile(videoRecordingMbid: string, providerId: string, filename: string) {
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "artist-mbid",
    videoRecordingMbid,
    "tidal",
    "video",
    providerId,
    "video",
    `C:/Videos/${filename}`,
    filename,
    "C:/Videos",
    filename,
    "mp4",
    "video",
  );
}

test("downloaded media state resolves canonical and provider identifiers without ProviderMedia rows", () => {
  const { videoRecordingId } = seedCanonicalArtistGraph();
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertVideoFile("video-recording-1", "provider-video-1", "track-one-video.mp4");

  const trackStates = downloadState.getMediaDownloadStateMap(
    ["track-1", "recording-1", "provider-track-1", "missing-track"],
    "track",
  );
  assert.equal(trackStates.get("track-1"), true);
  assert.equal(trackStates.get("recording-1"), true);
  assert.equal(trackStates.get("provider-track-1"), true);
  assert.equal(trackStates.get("missing-track"), false);

  const videoStates = downloadState.getMediaDownloadStateMap(
    ["video-recording-1", videoRecordingId, "provider-video-1", "missing-video"],
    "video",
  );
  assert.equal(videoStates.get("video-recording-1"), true);
  assert.equal(videoStates.get(videoRecordingId), true);
  assert.equal(videoStates.get("provider-video-1"), true);
  assert.equal(videoStates.get("missing-video"), false);

  const legacyMediaRows = db.prepare("SELECT COUNT(*) AS count FROM ProviderMedia").get() as { count: number };
  const legacyAlbumRows = db.prepare("SELECT COUNT(*) AS count FROM ProviderAlbums").get() as { count: number };
  assert.equal(legacyMediaRows.count, 0);
  assert.equal(legacyAlbumRows.count, 0);
});

test("artist and release-group download stats use canonical slots, recordings, and TrackFiles", () => {
  seedCanonicalArtistGraph();
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertVideoFile("video-recording-1", "provider-video-1", "track-one-video.mp4");

  const partialAlbum = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(partialAlbum.totalTracks, 2);
  assert.equal(partialAlbum.downloadedTracks, 1);
  assert.equal(partialAlbum.isDownloaded, false);

  const partialArtist = downloadState.getArtistDownloadStats("artist-local");
  assert.equal(partialArtist.totalItems, 2);
  assert.equal(partialArtist.downloadedItems, 1);
  assert.equal(partialArtist.isDownloaded, false);
  assert.equal(downloadState.countDownloadedManagedArtists(), 0);

  insertTrackFile("track-2", "recording-2", "provider-track-2", "track-two.flac");
  downloadState.invalidateAllDownloadState();

  const completeAlbum = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(completeAlbum.totalTracks, 2);
  assert.equal(completeAlbum.downloadedTracks, 2);
  assert.equal(completeAlbum.isDownloaded, true);

  const completeArtist = downloadState.getArtistDownloadStats("artist-local");
  assert.equal(completeArtist.totalItems, 2);
  assert.equal(completeArtist.downloadedItems, 2);
  assert.equal(completeArtist.isDownloaded, true);
  assert.equal(downloadState.countDownloadedManagedArtists(), 1);
});
