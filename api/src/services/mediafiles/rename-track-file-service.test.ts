import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-rename-track-file-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let libraryFilesModule: typeof import("./library-files.js");
let renameTrackFileServiceModule: typeof import("./rename-track-file-service.js");

function assertRetiredProviderCatalogTablesAbsent() {
  const rows = dbModule.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('ProviderAlbums', 'ProviderMedia', 'ProviderAlbumArtists', 'ProviderMediaArtists')
  `).all() as Array<{ name: string }>;
  assert.deepEqual(rows, []);
}

function writeTestConfig() {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.spatial_path = path.join(tempDir, "library", "spatial");
  config.path.video_path = path.join(tempDir, "library", "videos");
  config.naming.artist_folder = "{artistName}";
  config.naming.album_track_path_single = "{albumTitle}/{trackNumber00} - {trackTitle}";
  config.naming.album_track_path_multi = "{albumTitle}/Disc {volumeNumber0}/{trackNumber00} - {trackTitle}";
  config.naming.video_file = "{artistName} - {videoTitle}";
  configModule.writeConfig(config);
}

function seedTrackedFile() {
  const musicRoot = configModule.Config.getMusicPath();
  const sourceDir = path.join(musicRoot, "Artist One", "Imports");
  const sourcePath = path.join(sourceDir, "track-one.flac");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(sourcePath, "test-audio");

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-one-mbid", "Artist One");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-one-mbid", "Artist One", 1);

  // Legacy provider rows retained only to satisfy TrackFiles.album_id/media_id
  // foreign keys during the transition (dropped in Phase 5); naming now resolves
  // from the canonical graph + ProviderItems below.

// Canonical graph + provider availability.
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date) VALUES (?, ?, ?, ?, ?)")
    .run("rg-one", "artist-one-mbid", "Album One", "Album", "2024-01-01");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("rel-one", "rg-one", "artist-one-mbid", "Album One", 1, 1, "2024-01-01");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, length_ms) VALUES (?, ?, ?, ?)")
    .run("rec-one", "Track One", "artist-one-mbid", 180000);
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("trk-one", "rel-one", "rec-one", 1, 1, "1", "Track One");
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, selected_provider, selected_provider_id, selected_release_mbid, quality, match_status
    ) VALUES (?, ?, 'stereo', 'tidal', '10', 'rel-one', 'LOSSLESS', 'verified')
  `).run("artist-one-mbid", "rg-one");
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, album_id, title, quality, library_slot)
    VALUES ('tidal', 'album', '10', 'artist-one-mbid', 'rg-one', 'rel-one', '10', 'Album One', 'LOSSLESS', 'stereo')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, track_mbid, recording_mbid, album_id, title, quality, library_slot)
    VALUES ('tidal', 'track', '100', 'artist-one-mbid', 'rg-one', 'rel-one', 'trk-one', 'rec-one', '10', 'Track One', 'LOSSLESS', 'stereo')
  `).run();

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: sourcePath,
    libraryRoot: musicRoot,
    fileType: "track",
  });

  return {
    musicRoot,
    sourceDir,
    sourcePath,
    expectedPath: path.join(musicRoot, "Artist One", "Album One", "01 - Track One.flac"),
  };
}

function seedCanonicalGraph(options: { albumTitle?: string; trackTitle?: string } = {}) {
  const albumTitle = options.albumTitle || "Canonical Album";
  const trackTitle = options.trackTitle || "Canonical Song";

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-mbid-1", "Artist One", 1);

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (foreign_artist_id, mbid, name)
    VALUES (?, ?, ?)
  `).run("artist-mbid-1", "artist-mbid-1", "Artist One");

  dbModule.db.prepare(`
    INSERT INTO Albums (foreign_album_id, mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "release-group-mbid-1", "artist-mbid-1", albumTitle, "Album", "2024-03-01");

  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (foreign_release_id, mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", albumTitle, "Official", "[\"[Worldwide]\"]", "2024-03-01", 1, 1);

  dbModule.db.prepare(`
    INSERT INTO Recordings (foreign_recording_id, mbid, artist_mbid, title)
    VALUES (?, ?, ?, ?)
  `).run("recording-mbid-1", "recording-mbid-1", "artist-mbid-1", trackTitle);

  dbModule.db.prepare(`
    INSERT INTO Tracks (foreign_track_id, mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", trackTitle);
}

function upsertCanonicalAudioFile(input: {
  filePath: string;
  libraryRoot: string;
  librarySlot: "stereo" | "spatial";
  quality?: string | null;
  albumId?: string | null;
  mediaId?: string | null;
  providerId?: string | null;
}) {
  return libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: input.albumId || null,
    mediaId: input.mediaId || null,
    filePath: input.filePath,
    libraryRoot: input.libraryRoot,
    fileType: "track",
    quality: input.quality || "LOSSLESS",
    librarySlot: input.librarySlot,
    canonicalArtistMbid: "artist-mbid-1",
    canonicalReleaseGroupMbid: "release-group-mbid-1",
    canonicalReleaseMbid: "release-mbid-1",
    canonicalTrackMbid: "track-mbid-1",
    canonicalRecordingMbid: "recording-mbid-1",
    provider: input.providerId ? "tidal" : null,
    providerEntityType: input.providerId ? "track" : null,
    providerId: input.providerId || null,
  });
}

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../../database.js");
  dbModule.initDatabase();

  configModule = await import("../config/config.js");
  libraryFilesModule = await import("./library-files.js");
  renameTrackFileServiceModule = await import("./rename-track-file-service.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM history_events").run();
  db.prepare("DELETE FROM MetadataFiles").run();
  db.prepare("DELETE FROM LyricFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Artists").run();

  fs.rmSync(path.join(tempDir, "library"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  writeTestConfig();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("RenameTrackFileService owns preview and apply flow for tracked renames", () => {
  const seeded = seedTrackedFile();

  const statusBefore = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ artistId: "1" }, 10);
  assert.equal(statusBefore.renameNeeded, 1);
  assert.equal(statusBefore.conflicts, 0);
  assert.equal(statusBefore.missing, 0);

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameArtist({ artistId: "1" });

  assert.equal(result.renamed, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(result.missing, 0);
  assert.equal(fs.existsSync(seeded.sourcePath), false);
  assert.equal(fs.existsSync(seeded.expectedPath), true);
  assert.equal(fs.existsSync(seeded.sourceDir), false);

  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, relative_path as relativePath, expected_path as expectedPath, needs_rename as needsRename
    FROM TrackFiles
    WHERE provider_id = ?
  `).get("100") as { filePath: string; relativePath: string; expectedPath: string; needsRename: number };

  assert.equal(path.resolve(trackedFile.filePath), path.resolve(seeded.expectedPath));
  assert.equal(trackedFile.relativePath, path.join("Artist One", "Album One", "01 - Track One.flac"));
  assert.equal(path.resolve(trackedFile.expectedPath), path.resolve(seeded.expectedPath));
  assert.equal(trackedFile.needsRename, 0);
});

test("RenameTrackFileService applies the same quality-token path shown in preview", () => {
  const config = configModule.readConfig();
  config.naming.album_track_path_single = "{albumTitle}/{QUALITY}/{trackNumber00} - {trackTitle}";
  configModule.writeConfig(config);

  seedTrackedFile();
  dbModule.db.prepare(`
    UPDATE TrackFiles
    SET quality = ?, codec = ?, sample_rate = ?, bit_depth = ?, channels = ?
    WHERE provider_id = ?
  `).run("HIRES_LOSSLESS", "FLAC", 96000, 24, 2, "100");

  const expectedPath = path.join(
    configModule.Config.getMusicPath(),
    "Artist One",
    "Album One",
    "HIRES_LOSSLESS",
    "01 - Track One.flac",
  );

  const statusBefore = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ artistId: "1" }, 10);
  assert.equal(statusBefore.renameNeeded, 1);
  assert.equal(path.resolve(statusBefore.sample[0]?.expected_path || ""), path.resolve(expectedPath));

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameArtist({ artistId: "1" });
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(expectedPath), true);

  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, expected_path as expectedPath, needs_rename as needsRename
    FROM TrackFiles
    WHERE provider_id = ?
  `).get("100") as { filePath: string; expectedPath: string; needsRename: number };

  assert.equal(path.resolve(trackedFile.filePath), path.resolve(expectedPath));
  assert.equal(path.resolve(trackedFile.expectedPath), path.resolve(expectedPath));
  assert.equal(trackedFile.needsRename, 0);
});

test("RenameTrackFileService accepts library root aliases for rename status and apply", () => {
  const seeded = seedTrackedFile();

  const statusByAlias = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ libraryRoot: "music" }, 10);
  assert.equal(statusByAlias.total, 1);
  assert.equal(statusByAlias.renameNeeded, 1);

  const statusByPath = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ libraryRoot: configModule.Config.getMusicPath() }, 10);
  assert.equal(statusByPath.total, 1);
  assert.equal(statusByPath.renameNeeded, 1);

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameFilesByQuery({ libraryRoot: "music" });
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(seeded.expectedPath), true);

  const statusAfter = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ libraryRoot: "music" }, 10);
  assert.equal(statusAfter.total, 1);
  assert.equal(statusAfter.renameNeeded, 0);
});

test("RenameTrackFileService stores the destination root after a configured root change", () => {
  seedTrackedFile();
  const nextMusicRoot = path.join(tempDir, "library", "music-next");
  const config = configModule.readConfig();
  config.path.music_path = nextMusicRoot;
  configModule.writeConfig(config);

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameArtist({ artistId: "1" });
  assert.equal(result.renamed, 1);

  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, relative_path as relativePath, library_root as libraryRoot
    FROM TrackFiles
    WHERE provider_id = ?
  `).get("100") as { filePath: string; relativePath: string; libraryRoot: string };
  const expectedPath = path.join(nextMusicRoot, "Artist One", "Album One", "01 - Track One.flac");

  assert.equal(path.resolve(trackedFile.filePath), path.resolve(expectedPath));
  assert.equal(path.resolve(trackedFile.libraryRoot), path.resolve(nextMusicRoot));
  assert.equal(trackedFile.relativePath, path.join("Artist One", "Album One", "01 - Track One.flac"));
});

test("RenameTrackFileService keeps the stored artist path canonical until path updates are applied explicitly", () => {
  writeTestConfig();
  const musicRoot = configModule.Config.getMusicPath();
  const legacyPath = path.join(musicRoot, "Artist One", "Album One", "01 - Track One.flac");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, "test-audio");

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-mbid-1", "Artist One", 1);

libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: legacyPath,
    libraryRoot: musicRoot,
    fileType: "track",
  });

  const config = configModule.readConfig();
  config.naming.artist_folder = "{artistName} [{artistMbId}]";
  configModule.writeConfig(config);

  const status = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ artistId: "1" }, 10);
  const artist = dbModule.db.prepare("SELECT path FROM Artists WHERE id = ?").get("1") as { path: string };

  assert.equal(artist.path, "Artist One");
  assert.equal(status.renameNeeded, 0);
  assert.equal(status.sample.length, 0);
});

test("RenameTrackFileService derives track paths from canonical MusicBrainz rows without provider catalog rows", () => {
  const musicRoot = configModule.Config.getMusicPath();
  const sourceDir = path.join(musicRoot, "Artist One", "Imports");
  const sourcePath = path.join(sourceDir, "providerless-track.flac");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(sourcePath, "test-audio");

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-mbid-1", "artist-one", 1);

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (foreign_artist_id, mbid, name)
    VALUES (?, ?, ?)
  `).run("artist-mbid-1", "artist-mbid-1", "Artist One");

  dbModule.db.prepare(`
    INSERT INTO Albums (foreign_album_id, mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Album", "2024-03-01");

  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (foreign_release_id, mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Official", "[\"[Worldwide]\"]", "2024-03-01", 1, 1);

  dbModule.db.prepare(`
    INSERT INTO Recordings (foreign_recording_id, mbid, artist_mbid, title)
    VALUES (?, ?, ?, ?)
  `).run("recording-mbid-1", "recording-mbid-1", "artist-mbid-1", "Canonical Song");

  dbModule.db.prepare(`
    INSERT INTO Tracks (foreign_track_id, mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Canonical Song");

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: null,
    filePath: sourcePath,
    libraryRoot: musicRoot,
    fileType: "track",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalReleaseGroupMbid: "release-group-mbid-1",
    canonicalReleaseMbid: "release-mbid-1",
    canonicalTrackMbid: "track-mbid-1",
    canonicalRecordingMbid: "recording-mbid-1",
  });

  const expectedPath = path.join(musicRoot, "artist-one", "Canonical Album", "01 - Canonical Song.flac");
  const statusBefore = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ artistId: "1" }, 10);
  assert.equal(statusBefore.renameNeeded, 1);
  assert.equal(path.resolve(statusBefore.sample[0]?.expected_path || ""), path.resolve(expectedPath));

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameArtist({ artistId: "1" });
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(expectedPath), true);

  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, canonical_track_mbid as canonicalTrackMbid
    FROM TrackFiles
    WHERE canonical_track_mbid = ?
  `).get("track-mbid-1") as { filePath: string; canonicalTrackMbid: string };

  assert.equal(path.resolve(trackedFile.filePath), path.resolve(expectedPath));
  assert.equal(trackedFile.canonicalTrackMbid, "track-mbid-1");
});

test("RenameTrackFileService derives video paths from canonical provider-only recordings without provider media rows", () => {
  const videoRoot = configModule.Config.getVideoPath();
  const sourceDir = path.join(videoRoot, "Artist One", "Imports");
  const sourcePath = path.join(sourceDir, "provider-video.mp4");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(sourcePath, "test-video");

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-mbid-1", "Artist One", 1);

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (foreign_artist_id, mbid, name)
    VALUES (?, ?, ?)
  `).run("artist-mbid-1", "artist-mbid-1", "Artist One");

  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (foreign_recording_id, mbid, artist_mbid, title, is_video, metadata_status)
    VALUES (?, NULL, ?, ?, 1, 'provider_only')
    RETURNING Id
  `).get("tidal:video:123", "artist-mbid-1", "Canonical Video") as { id: number };

  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, library_slot, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "video", "tidal-video-123", "artist-mbid-1", recording.id, "provider Video Title", "video", "verified", 1);

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: null,
    filePath: sourcePath,
    libraryRoot: videoRoot,
    fileType: "video",
    provider: "tidal",
    providerEntityType: "video",
    providerId: "tidal-video-123",
    librarySlot: "video",
    canonicalArtistMbid: "artist-mbid-1",
  });

  const expectedPath = path.join(videoRoot, "Artist One", "Artist One - Canonical Video-video.mp4");
  const statusBefore = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ artistId: "1", libraryRoot: "videos" }, 10);
  assert.equal(statusBefore.renameNeeded, 1);
  assert.equal(path.resolve(statusBefore.sample[0]?.expected_path || ""), path.resolve(expectedPath));

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameFilesByQuery({ artistId: "1", libraryRoot: "videos" });
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(expectedPath), true);

  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, provider, provider_entity_type as providerEntityType, provider_id as providerId
    FROM TrackFiles
    WHERE provider_id = ?
  `).get("tidal-video-123") as { filePath: string; provider: string; providerEntityType: string; providerId: string };

  assert.equal(path.resolve(trackedFile.filePath), path.resolve(expectedPath));
  assert.equal(trackedFile.provider, "tidal");
  assert.equal(trackedFile.providerEntityType, "video");
  assert.equal(trackedFile.providerId, "tidal-video-123");
});

test("RenameTrackFileService replicates canonical lyrics across separated roots without provider catalog rows", () => {
  seedCanonicalGraph();

  const musicRoot = configModule.Config.getMusicPath();
  const spatialRoot = configModule.Config.getSpatialPath();
  const sourceTrackPath = path.join(musicRoot, "Artist One", "Imports", "canonical-song.flac");
  const expectedMusicTrackPath = path.join(musicRoot, "Artist One", "Canonical Album", "01 - Canonical Song.flac");
  const spatialTrackPath = path.join(spatialRoot, "Artist One", "Canonical Album", "01 - Canonical Song.flac");
  const sourceLyricPath = path.join(musicRoot, "Artist One", "Canonical Album", "01 - Canonical Song.lrc");
  const expectedSpatialLyricPath = path.join(spatialRoot, "Artist One", "Canonical Album", "01 - Canonical Song.lrc");

  fs.mkdirSync(path.dirname(sourceTrackPath), { recursive: true });
  fs.writeFileSync(sourceTrackPath, "test-audio");
  fs.mkdirSync(path.dirname(sourceLyricPath), { recursive: true });
  fs.writeFileSync(sourceLyricPath, "[00:00.00]Canonical lyric");

  upsertCanonicalAudioFile({
    filePath: sourceTrackPath,
    libraryRoot: musicRoot,
    librarySlot: "stereo",
  });
  upsertCanonicalAudioFile({
    filePath: spatialTrackPath,
    libraryRoot: spatialRoot,
    librarySlot: "spatial",
    quality: "DOLBY_ATMOS",
  });
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: null,
    filePath: sourceLyricPath,
    libraryRoot: musicRoot,
    fileType: "lyrics",
    quality: "LOSSLESS",
    librarySlot: "stereo",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalReleaseGroupMbid: "release-group-mbid-1",
    canonicalReleaseMbid: "release-mbid-1",
    canonicalTrackMbid: "track-mbid-1",
    canonicalRecordingMbid: "recording-mbid-1",
  });

  assertRetiredProviderCatalogTablesAbsent();

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameArtist({ artistId: "1" });

  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(expectedMusicTrackPath), true);
  assert.equal(fs.existsSync(expectedSpatialLyricPath), true);
  assert.equal(fs.readFileSync(expectedSpatialLyricPath, "utf8"), "[00:00.00]Canonical lyric");

  const replicatedLyric = dbModule.db.prepare(`
    SELECT album_id AS albumId, media_id AS mediaId, track_file_id AS trackFileId,
           canonical_track_mbid AS canonicalTrackMbid,
           canonical_recording_mbid AS canonicalRecordingMbid,
           library_slot AS librarySlot
    FROM LyricFiles
    WHERE file_path = ?
  `).get(expectedSpatialLyricPath) as {
    albumId: string | null;
    mediaId: string | null;
    trackFileId: number | null;
    canonicalTrackMbid: string | null;
    canonicalRecordingMbid: string | null;
    librarySlot: string;
  };

  assert.equal(replicatedLyric.albumId, null);
  assert.equal(replicatedLyric.mediaId, null);
  assert.equal(replicatedLyric.canonicalTrackMbid, "track-mbid-1");
  assert.equal(replicatedLyric.canonicalRecordingMbid, "recording-mbid-1");
  assert.equal(replicatedLyric.librarySlot, "spatial");
  assert.ok(replicatedLyric.trackFileId);
});

test("RenameTrackFileService replicates album sidecars by ProviderItems release group, not provider titles", () => {
  seedCanonicalGraph();

  const musicRoot = configModule.Config.getMusicPath();
  const spatialRoot = configModule.Config.getSpatialPath();
  const sourceTrackPath = path.join(musicRoot, "Artist One", "Imports", "canonical-song.flac");
  const spatialTrackPath = path.join(spatialRoot, "Artist One", "Canonical Album", "01 - Canonical Song.flac");
  const sourceCoverPath = path.join(musicRoot, "Artist One", "Canonical Album", "cover.jpg");
  const expectedSpatialCoverPath = path.join(spatialRoot, "Artist One", "Canonical Album", "cover.jpg");

  fs.mkdirSync(path.dirname(sourceTrackPath), { recursive: true });
  fs.writeFileSync(sourceTrackPath, "test-audio");
  fs.mkdirSync(path.dirname(sourceCoverPath), { recursive: true });
  fs.writeFileSync(sourceCoverPath, "cover-bytes");

  // Legacy rows exist only for TrackFiles foreign keys and deliberately have
  // different titles. Replication should use ProviderItems release-group links.

dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, album_id, title, quality, library_slot)
    VALUES
      ('tidal', 'album', '10', 'artist-mbid-1', 'release-group-mbid-1', 'release-mbid-1', '10', 'Canonical Album', 'LOSSLESS', 'stereo'),
      ('tidal', 'album', '20', 'artist-mbid-1', 'release-group-mbid-1', 'release-mbid-1', '20', 'Canonical Album', 'DOLBY_ATMOS', 'spatial')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, track_mbid, recording_mbid, album_id, title, quality, library_slot)
    VALUES
      ('tidal', 'track', '100', 'artist-mbid-1', 'release-group-mbid-1', 'release-mbid-1', 'track-mbid-1', 'recording-mbid-1', '10', 'Canonical Song', 'LOSSLESS', 'stereo'),
      ('tidal', 'track', '200', 'artist-mbid-1', 'release-group-mbid-1', 'release-mbid-1', 'track-mbid-1', 'recording-mbid-1', '20', 'Canonical Song', 'DOLBY_ATMOS', 'spatial')
  `).run();

  upsertCanonicalAudioFile({
    filePath: sourceTrackPath,
    libraryRoot: musicRoot,
    librarySlot: "stereo",
    albumId: "10",
    mediaId: "100",
    providerId: "100",
  });
  upsertCanonicalAudioFile({
    filePath: spatialTrackPath,
    libraryRoot: spatialRoot,
    librarySlot: "spatial",
    quality: "DOLBY_ATMOS",
    albumId: "20",
    mediaId: "200",
    providerId: "200",
  });
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: null,
    filePath: sourceCoverPath,
    libraryRoot: musicRoot,
    fileType: "cover",
    librarySlot: "stereo",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalReleaseGroupMbid: "release-group-mbid-1",
    canonicalReleaseMbid: "release-mbid-1",
    provider: "tidal",
    providerEntityType: "album",
    providerId: "10",
  });

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameArtist({ artistId: "1" });

  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(expectedSpatialCoverPath), true);
  assert.equal(fs.readFileSync(expectedSpatialCoverPath, "utf8"), "cover-bytes");

  const replicatedCover = dbModule.db.prepare(`
    SELECT album_id AS albumId, media_id AS mediaId, provider, provider_entity_type AS providerEntityType,
           provider_id AS providerId, library_slot AS librarySlot
    FROM MetadataFiles
    WHERE file_path = ?
  `).get(expectedSpatialCoverPath) as {
    albumId: string | null;
    mediaId: string | null;
    provider: string | null;
    providerEntityType: string | null;
    providerId: string | null;
    librarySlot: string;
  };

  assert.equal(replicatedCover.albumId, "20");
  assert.equal(replicatedCover.mediaId, null);
  assert.equal(replicatedCover.provider, "tidal");
  assert.equal(replicatedCover.providerEntityType, "album");
  assert.equal(replicatedCover.providerId, "20");
  assert.equal(replicatedCover.librarySlot, "spatial");
});
