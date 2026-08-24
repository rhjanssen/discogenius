import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectVideoInVideoLibraries, seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-state-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const configModule = await import("../config/config.js");
const downloadState = await import("./download-state.js");
const { buildTrackFileCompletionExistsPredicate } = await import("./track-file-completion.js");

function writeFilteringConfig(includeSpatial: boolean, includeVideos: boolean) {
  const config = configModule.readConfig();
  config.filtering.include_spatial = includeSpatial;
  config.filtering.include_videos = includeVideos;
  configModule.writeConfig(config);
  // Download stats gate on Libraries.enabled as well as filtering.include_spatial.
  // Mirror Settings apply so toggling include_spatial actually enables Spatial.
  db.prepare(`
    UPDATE Libraries SET enabled = ? WHERE name = 'Spatial'
  `).run(includeSpatial ? 1 : 0);
}

function resetRows() {
  db.prepare("DELETE FROM TrackFiles").run();
  // Release the deferred plan reference before its rows go.
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  writeFilteringConfig(false, false);
  downloadState.invalidateAllDownloadState();
}

beforeEach(resetRows);
afterEach(resetRows);

function seedCanonicalArtistGraph() {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  const artistMetadata = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
    .get("artist-mbid") as { id: number };

  const releaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "release-group-1",
    "artist-mbid",
    "Canonical Album",
    "album",
    "2024-01-01",
  ) as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title, track_count, media_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "release-1",
    releaseGroup.id,
    "release-group-1",
    artistMetadata.id,
    "artist-mbid",
    "Canonical Album",
    2,
    1,
  ) as { id: number };
  const recording1 = db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, artist_metadata_id, is_video)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get("recording-1", "Track One", "artist-mbid", artistMetadata.id, 0) as { id: number };
  const recording2 = db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, artist_metadata_id, is_video)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get("recording-2", "Track Two", "artist-mbid", artistMetadata.id, 0) as { id: number };
  const track1 = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      title, medium_position, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "track-1",
    release.id,
    "release-1",
    recording1.id,
    "recording-1",
    "Track One",
    1,
    1,
  ) as { id: number };
  const track2 = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      title, medium_position, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "track-2",
    release.id,
    "release-1",
    recording2.id,
    "recording-2",
    "Track Two",
    1,
    2,
  ) as { id: number };
  const stereoLibrary = db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(stereoLibrary.id, releaseGroup.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(stereoLibrary.id, release.id);

  seedLibraryArtistMonitoring(db, "artist-mbid");

  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, artist_metadata_id, is_video) VALUES (?, ?, ?, ?, ?)")
    .run("video-recording-1", "Track One", "artist-mbid", artistMetadata.id, 1);
  const videoRecording = db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-recording-1") as { id: number };
  selectVideoInVideoLibraries(db, videoRecording.id);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
  `).run( "tidal", "track", "provider-track-1", "Track One" );
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
  `).run( "tidal", "video", "provider-video-1", "Track One" );

  return {
    releaseGroupId: releaseGroup.id,
    editionId: release.id,
    stereoLibraryId: stereoLibrary.id,
    track1Id: track1.id,
    track2Id: track2.id,
    recording1Id: recording1.id,
    recording2Id: recording2.id,
    videoRecordingId: String(videoRecording.id),
  };
}

function insertTrackFile(
  trackMbid: string,
  recordingMbid: string,
  providerId: string,
  filename: string,
  libraryName = "Stereo",
) {
  const track = db.prepare(`
    SELECT
      track.id AS track_id,
      track.recording_id,
      track.album_edition_id,
      release.release_group_id
    FROM Tracks track
    JOIN AlbumEditions release ON release.id = track.album_edition_id
    WHERE track.mbid = ?
  `).get(trackMbid) as {
    track_id: number;
    recording_id: number;
    album_edition_id: number;
    release_group_id: number;
  };
  const library = db.prepare(`
    SELECT id, root_path FROM Libraries WHERE name = ?
  `).get(libraryName) as { id: number; root_path: string };
  const artistMetadataId = (db.prepare(
    "SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'",
  ).get() as { id: number }).id;
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id,
      release_group_id, album_edition_id, track_id, recording_id, library_slot, library_id,
      file_path, relative_path, library_root, filename, extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artistMetadataId,
    "artist-mbid",
    "release-group-1",
    "release-1",
    trackMbid,
    recordingMbid,
    "tidal",
    "track",
    providerId,
    track.release_group_id,
    track.album_edition_id,
    track.track_id,
    track.recording_id,
    libraryName === "Spatial" ? "spatial" : "stereo",
    library.id,
    `C:/Music/${filename}`,
    filename,
    library.root_path,
    filename,
    "flac",
    "track",
    "audio",
  );
}

function insertVideoFile(videoRecordingMbid: string, providerId: string, filename: string) {
  const recording = db.prepare(`
    SELECT id FROM Recordings WHERE mbid = ?
  `).get(videoRecordingMbid) as { id: number };
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, canonical_artist_mbid, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, recording_id, library_slot, file_path, relative_path, library_root,
      filename, extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id,
    "artist-mbid",
    videoRecordingMbid,
    "tidal",
    "video",
    providerId,
    recording.id,
    "video",
    `C:/Videos/${filename}`,
    filename,
    "C:/Videos",
    filename,
    "mp4",
    "video",
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

  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
});
test("artist and release-group download stats use canonical slots, recordings, and TrackFiles", () => {
  writeFilteringConfig(false, true);
  seedCanonicalArtistGraph();
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertVideoFile("video-recording-1", "provider-video-1", "track-one-video.mp4");

  const partialAlbum = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(partialAlbum.totalTracks, 2);
  assert.equal(partialAlbum.downloadedTracks, 1);
  assert.equal(partialAlbum.isDownloaded, false);

  const partialArtist = downloadState.getArtistDownloadStats("artist-mbid");
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

  const completeArtist = downloadState.getArtistDownloadStats("artist-mbid");
  assert.equal(completeArtist.totalItems, 2);
  assert.equal(completeArtist.downloadedItems, 2);
  assert.equal(completeArtist.isDownloaded, true);
  assert.equal(downloadState.countDownloadedManagedArtists(), 1);
});

test("legacy MBID shadows do not complete tracks without exact catalog links", () => {
  seedCanonicalArtistGraph();
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertTrackFile("track-2", "recording-2", "provider-track-2", "track-two.flac");

  // First file is identified by release-specific track MBID only.
  db.prepare(`
    UPDATE TrackFiles
    SET canonical_recording_mbid = NULL
    WHERE provider_id = 'provider-track-1'
  `).run();
  db.prepare(`
    UPDATE TrackFiles
    SET track_id = NULL, recording_id = NULL
    WHERE provider_id = 'provider-track-1'
  `).run();

  // Second file has no track identity and therefore uses recording fallback.
  db.prepare(`
    UPDATE TrackFiles
    SET canonical_track_mbid = NULL
    WHERE provider_id = 'provider-track-2'
  `).run();
  db.prepare(`
    UPDATE TrackFiles
    SET track_id = NULL, recording_id = NULL
    WHERE provider_id = 'provider-track-2'
  `).run();

  const album = downloadState.getReleaseGroupDownloadStatsMap(["release-group-1"])
    .get("release-group-1");
  assert.deepEqual(
    {
      totalTracks: album?.totalTracks,
      downloadedTracks: album?.downloadedTracks,
      isDownloaded: album?.isDownloaded,
    },
    { totalTracks: 2, downloadedTracks: 0, isDownloaded: false },
  );
  assert.equal(downloadState.countDownloadedTracks(), 0);
  assert.equal(downloadState.countDownloadedAlbums(), 0);
});

test("download completion follows enabled libraries and keeps their track identities separate", () => {
  const graph = seedCanonicalArtistGraph();
  const spatialLibrary = db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Spatial'
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(spatialLibrary.id, graph.releaseGroupId);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(spatialLibrary.id, graph.editionId);
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertTrackFile("track-2", "recording-2", "provider-track-2", "track-two.flac");

  writeFilteringConfig(false, false);
  const stereoOnly = downloadState.getReleaseGroupDownloadStatsMap(["release-group-1"]).get("release-group-1");
  assert.deepEqual(
    {
      totalTracks: stereoOnly?.totalTracks,
      downloadedTracks: stereoOnly?.downloadedTracks,
      isDownloaded: stereoOnly?.isDownloaded,
    },
    { totalTracks: 2, downloadedTracks: 2, isDownloaded: true },
  );
  assert.equal(downloadState.getArtistDownloadStats("artist-mbid").totalItems, 1);
  assert.equal(downloadState.getArtistDownloadStats("artist-mbid").downloadedItems, 1);
  assert.equal(downloadState.countDownloadedTracks(), 2);
  assert.equal(downloadState.countDownloadedAlbums(), 1);

  writeFilteringConfig(true, false);
  const stereoAndSpatial = downloadState.getReleaseGroupDownloadStatsMap(["release-group-1"]).get("release-group-1");
  assert.deepEqual(
    {
      totalTracks: stereoAndSpatial?.totalTracks,
      downloadedTracks: stereoAndSpatial?.downloadedTracks,
      isDownloaded: stereoAndSpatial?.isDownloaded,
    },
    { totalTracks: 4, downloadedTracks: 2, isDownloaded: false },
  );
  assert.equal(downloadState.getArtistDownloadStats("artist-mbid").totalItems, 2);
  assert.equal(downloadState.getArtistDownloadStats("artist-mbid").downloadedItems, 1);
  assert.equal(downloadState.countDownloadedTracks(), 2);
  assert.equal(downloadState.countDownloadedAlbums(), 1);
});

test("disabled video monitoring does not make an otherwise complete artist incomplete", () => {
  seedCanonicalArtistGraph();
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertTrackFile("track-2", "recording-2", "provider-track-2", "track-two.flac");

  writeFilteringConfig(false, false);
  const stats = downloadState.getArtistDownloadStats("artist-mbid");
  assert.deepEqual(
    {
      totalItems: stats.totalItems,
      downloadedItems: stats.downloadedItems,
      isDownloaded: stats.isDownloaded,
    },
    { totalItems: 1, downloadedItems: 1, isDownloaded: true },
  );
});

test("audio completion ignores video recordings embedded in the selected release", () => {
  seedCanonicalArtistGraph();
  db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      title, medium_position, position
    ) VALUES (
      ?, (SELECT id FROM AlbumEditions WHERE mbid = ?), ?,
      (SELECT id FROM Recordings WHERE mbid = ?), ?, ?, ?, ?
    )
  `).run(
    "video-track-1",
    "release-1",
    "release-1",
    "video-recording-1",
    "video-recording-1",
    "Track One (Music Video)",
    1,
    3,
  );
  insertTrackFile("track-1", "recording-1", "provider-track-1", "track-one.flac");
  insertTrackFile("track-2", "recording-2", "provider-track-2", "track-two.flac");

  writeFilteringConfig(false, false);
  const stats = downloadState.getReleaseGroupDownloadStatsMap(["release-group-1"]).get("release-group-1");
  assert.deepEqual(
    {
      totalTracks: stats?.totalTracks,
      downloadedTracks: stats?.downloadedTracks,
      isDownloaded: stats?.isDownloaded,
    },
    { totalTracks: 2, downloadedTracks: 2, isDownloaded: true },
  );
  assert.equal(downloadState.countDownloadedTracks(), 2);
  assert.equal(downloadState.countDownloadedAlbums(), 1);

  // A malformed/legacy audio-file row linked to a canonical video must not
  // inflate any audio completion counter either.
  insertTrackFile("video-track-1", "video-recording-1", "legacy-video-as-track", "legacy-video.flac");
  const afterLegacyRow = downloadState.getReleaseGroupDownloadStatsMap(["release-group-1"]).get("release-group-1");
  assert.equal(afterLegacyRow?.totalTracks, 2);
  assert.equal(afterLegacyRow?.downloadedTracks, 2);
  assert.equal(downloadState.countDownloadedTracks(), 2);
  assert.equal(downloadState.countDownloadedAlbums(), 1);
});

test("completion lookups use the library-and-track covering index", () => {
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT track.id
    FROM Tracks track
    JOIN LibraryEditions library_release
      ON library_release.edition_id = track.album_edition_id
    WHERE ${buildTrackFileCompletionExistsPredicate("track", "library_release.library_id", "plan_file")}
  `).all() as Array<{ detail: string }>;
  const details = plan.map((row) => row.detail).join("\n");

  assert.match(details, /USING INDEX idx_track_files_library_track/);
  assert.doesNotMatch(details, /SCAN plan_file/);
});
