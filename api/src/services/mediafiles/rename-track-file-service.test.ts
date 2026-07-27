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
  db.prepare("DELETE FROM RecordingRelations").run();
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

test("id-only renames avoid library-wide post-processing", () => {
  const seeded = seedTrackedFile();
  const unrelatedEmptyDir = path.join(configModule.Config.getVideoPath(), "Unrelated Artist", "Empty Album");
  fs.mkdirSync(unrelatedEmptyDir, { recursive: true });
  const trackedFile = dbModule.db.prepare("SELECT id FROM TrackFiles WHERE provider_id = ?")
    .get("100") as { id: number };

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameFiles([trackedFile.id]);

  assert.equal(result.renamed, 1);
  assert.equal(result.cleanedDirectories, 0);
  assert.equal(fs.existsSync(seeded.expectedPath), true);
  assert.equal(fs.existsSync(seeded.sourceDir), false);
  assert.equal(fs.existsSync(unrelatedEmptyDir), true);
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

test("rename preload follows the selected-release track identity for hybrid source tracks", () => {
  const musicRoot = configModule.Config.getMusicPath();
  const sourcePath = path.join(musicRoot, "Artist One", "Imports", "hybrid-source.flac");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "test-audio");

  seedCanonicalGraph({ albumTitle: "Hybrid Album", trackTitle: "Selected Track" });
  dbModule.db.prepare(`
    UPDATE Tracks
    SET position = 2, number = '2', title = 'Selected Track'
    WHERE mbid = 'track-mbid-1'
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (foreign_album_id, mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES ('source-rg', 'source-rg', 'artist-mbid-1', 'Source Single', 'Single', '2024-02-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      foreign_release_id, mbid, release_group_mbid, artist_mbid, title,
      status, country, date, media_count, track_count
    ) VALUES (
      'source-release', 'source-release', 'source-rg', 'artist-mbid-1', 'Source Single',
      'Official', '["[Worldwide]"]', '2024-02-01', 1, 1
    )
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      foreign_track_id, mbid, release_mbid, recording_mbid,
      medium_position, position, number, title
    ) VALUES (
      'source-track', 'source-track', 'source-release', 'recording-mbid-1',
      1, 1, '1', 'Source Track'
    )
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, selected_provider,
      selected_provider_id, selected_release_mbid, monitored, quality, match_status
    ) VALUES (
      'artist-mbid-1', 'release-group-mbid-1', 'stereo', 'tidal',
      'hybrid-album', 'release-mbid-1', 1, 'LOSSLESS', 'verified'
    )
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, album_id, title, quality, library_slot
    ) VALUES (
      'tidal', 'track', 'hybrid-track', 'artist-mbid-1', 'source-rg',
      'source-release', 'source-track', 'recording-mbid-1', 'hybrid-album',
      'Source Track', 'LOSSLESS', 'stereo'
    )
  `).run();

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "hybrid-album",
    mediaId: "hybrid-track",
    filePath: sourcePath,
    libraryRoot: musicRoot,
    fileType: "track",
    quality: "LOSSLESS",
    librarySlot: "stereo",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalReleaseGroupMbid: "release-group-mbid-1",
    canonicalReleaseMbid: "source-release",
    canonicalTrackMbid: "source-track",
    canonicalRecordingMbid: "recording-mbid-1",
    provider: "tidal",
    providerEntityType: "track",
    providerId: "hybrid-track",
  });

  // Reproduce a pre-remap row from a source provider album. Preview must resolve
  // it through the monitored slot before bulk-loading canonical track metadata.
  dbModule.db.prepare(`
    UPDATE TrackFiles
    SET canonical_release_mbid = 'source-release',
        canonical_track_mbid = 'source-track'
    WHERE provider_id = 'hybrid-track'
  `).run();

  const previews = renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews({ artistId: "1" });
  const expectedPath = path.join(musicRoot, "Artist One", "Hybrid Album", "02 - Selected Track.flac");

  assert.equal(previews.length, 1);
  assert.equal(path.resolve(previews[0]?.expected_path || ""), path.resolve(expectedPath));
  assert.equal(previews[0]?.reason, undefined);
});

test("rename path cache keeps provider-scoped album folders distinct across slots", () => {
  seedCanonicalGraph();
  const config = configModule.readConfig();
  config.naming.album_track_path_single = "{providerName}/{albumTitle}/{trackNumber00} - {trackTitle}";
  configModule.writeConfig(config);

  const cache = libraryFilesModule.createExpectedPathCache();
  const commonRow = {
    artist_id: "1",
    album_id: null,
    media_id: null,
    canonical_artist_mbid: "artist-mbid-1",
    canonical_release_group_mbid: "release-group-mbid-1",
    canonical_release_mbid: "release-mbid-1",
    canonical_track_mbid: null,
    canonical_recording_mbid: null,
    provider_entity_type: "album",
    file_type: "cover",
    extension: "jpg",
    relative_path: null,
  };

  const tidal = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...commonRow,
    id: 501,
    provider: "tidal",
    provider_id: "tidal-album",
    library_slot: "stereo",
    library_root: configModule.Config.getMusicPath(),
    file_path: path.join(configModule.Config.getMusicPath(), "Imports", "tidal.jpg"),
    quality: "LOSSLESS",
  }, cache);
  assert.equal(cache.albumDirs.size, 1);
  const apple = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    ...commonRow,
    id: 502,
    provider: "apple-music",
    provider_id: "apple-album",
    library_slot: "spatial",
    library_root: configModule.Config.getSpatialPath(),
    file_path: path.join(configModule.Config.getSpatialPath(), "Imports", "apple.jpg"),
    quality: "DOLBY_ATMOS",
  }, cache);

  assert.ok(tidal.expectedPath?.includes(path.join("Artist One", "TIDAL", "Canonical Album")));
  assert.ok(apple.expectedPath?.includes(path.join("Artist One", "Apple Music", "Canonical Album")));
  assert.equal(cache.albumDirs.size, 2);
});

test("rename preview batches canonical metadata and collision-owner lookups", () => {
  const seeded = seedTrackedFile();
  for (let index = 2; index <= 4; index += 1) {
    const providerId = String(index * 100);
    const recordingMbid = `rec-${index}`;
    const trackMbid = `trk-${index}`;
    const trackTitle = `Track ${index}`;
    const sourcePath = path.join(seeded.musicRoot, "Artist One", "Imports", `track-${index}.flac`);
    fs.writeFileSync(sourcePath, `test-audio-${index}`);

    dbModule.db.prepare(
      "INSERT INTO Recordings (mbid, title, artist_mbid, length_ms) VALUES (?, ?, ?, ?)",
    ).run(recordingMbid, trackTitle, "artist-one-mbid", 180000);
    dbModule.db.prepare(`
      INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
      VALUES (?, 'rel-one', ?, 1, ?, ?, ?)
    `).run(trackMbid, recordingMbid, index, String(index), trackTitle);
    dbModule.db.prepare(`
      INSERT INTO ProviderItems (
        provider, entity_type, provider_id, artist_mbid, release_group_mbid,
        release_mbid, track_mbid, recording_mbid, album_id, title, quality, library_slot
      ) VALUES (
        'tidal', 'track', ?, 'artist-one-mbid', 'rg-one',
        'rel-one', ?, ?, '10', ?, 'LOSSLESS', 'stereo'
      )
    `).run(providerId, trackMbid, recordingMbid, trackTitle);
    libraryFilesModule.LibraryFilesService.upsertLibraryFile({
      artistId: "1",
      albumId: "10",
      mediaId: providerId,
      filePath: sourcePath,
      libraryRoot: seeded.musicRoot,
      fileType: "track",
      canonicalArtistMbid: "artist-one-mbid",
      canonicalReleaseGroupMbid: "rg-one",
      canonicalReleaseMbid: "rel-one",
      canonicalTrackMbid: trackMbid,
      canonicalRecordingMbid: recordingMbid,
      provider: "tidal",
      providerEntityType: "track",
      providerId,
    });
  }

  const observedSql: string[] = [];
  const database = (dbModule.db.prepare("SELECT 1") as any).database as typeof dbModule.db;
  const originalPrepare = database.prepare;
  (database as any).prepare = function instrumentedPrepare(sql: string) {
    observedSql.push(sql.replace(/\s+/g, " ").trim());
    return originalPrepare.call(this, sql);
  };

  let previews: ReturnType<typeof renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews>;
  try {
    previews = renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews({ artistId: "1" });
  } finally {
    delete (database as any).prepare;
  }

  assert.equal(previews.length, 4);
  assert.equal(previews.every((preview) => preview.needs_rename && !preview.conflict), true);
  assert.equal(
    observedSql.filter((sql) =>
      /WHERE file_type = 'track' AND file_path = \? AND id != \?/i.test(sql)
    ).length,
    0,
  );
  assert.equal(
    observedSql.filter((sql) =>
      /SELECT id, file_path FROM TrackFiles WHERE file_type = 'track' AND file_path IN \(/i.test(sql)
    ).length,
    1,
  );
  assert.equal(
    observedSql.filter((sql) =>
      /FROM Tracks t LEFT JOIN Recordings r ON r\.mbid = t\.recording_mbid WHERE t\.mbid = \?/i.test(sql)
    ).length,
    0,
  );
});

test("benchmark: 200-row rename preview statement shape", () => {
  seedCanonicalGraph();
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, selected_provider,
      selected_provider_id, selected_release_mbid, quality, match_status
    ) VALUES (
      'artist-mbid-1', 'release-group-mbid-1', 'stereo', 'tidal',
      'album-1', 'release-mbid-1', 'LOSSLESS', 'verified'
    )
  `).run();

  const insertRecording = dbModule.db.prepare(`
    INSERT INTO Recordings (foreign_recording_id, mbid, artist_mbid, title)
    VALUES (?, ?, 'artist-mbid-1', ?)
  `);
  const insertTrack = dbModule.db.prepare(`
    INSERT INTO Tracks (
      foreign_track_id, mbid, release_mbid, recording_mbid,
      medium_position, position, number, title
    ) VALUES (?, ?, 'release-mbid-1', ?, 1, ?, ?, ?)
  `);
  const insertOffer = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      release_mbid, track_mbid, recording_mbid, album_id, title, quality, library_slot
    ) VALUES (
      'tidal', 'track', ?, 'artist-mbid-1', 'release-group-mbid-1',
      'release-mbid-1', ?, ?, 'album-1', ?, 'LOSSLESS', 'stereo'
    )
  `);
  const insertFile = dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid,
      canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES (
      '1', 'artist-mbid-1', 'release-group-mbid-1',
      'release-mbid-1', ?, ?, 'tidal', 'track', ?, 'stereo',
      ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS'
    )
  `);
  const musicRoot = configModule.Config.getMusicPath();
  dbModule.db.transaction(() => {
    for (let index = 1; index <= 200; index += 1) {
      const recordingMbid = index === 1 ? "recording-mbid-1" : `recording-mbid-${index}`;
      const trackMbid = index === 1 ? "track-mbid-1" : `track-mbid-${index}`;
      const title = `Canonical Song ${index}`;
      const providerId = `provider-track-${index}`;
      if (index > 1) {
        insertRecording.run(recordingMbid, recordingMbid, title);
        insertTrack.run(trackMbid, trackMbid, recordingMbid, index, String(index), title);
      }
      insertOffer.run(providerId, trackMbid, recordingMbid, title);
      const relativePath = path.join("Artist One", "Imports", `${index}.flac`);
      insertFile.run(
        trackMbid,
        recordingMbid,
        providerId,
        path.join(musicRoot, relativePath),
        relativePath,
        musicRoot,
        `${index}.flac`,
      );
    }
  })();

  let statementCount = 0;
  const statementsBySql = new Map<string, number>();
  const database = (dbModule.db.prepare("SELECT 1") as any).database as typeof dbModule.db;
  const originalPrepare = database.prepare;
  (database as any).prepare = function instrumentedPrepare(sql: string) {
    statementCount += 1;
    const normalized = sql.replace(/\s+/g, " ").trim();
    statementsBySql.set(normalized, (statementsBySql.get(normalized) || 0) + 1);
    return originalPrepare.call(this, sql);
  };

  let previews: ReturnType<typeof renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews>;
  const startedAt = performance.now();
  try {
    previews = renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews({
      artistId: "1",
      limit: 200,
    });
  } finally {
    delete (database as any).prepare;
  }
  const elapsedMs = performance.now() - startedAt;

  assert.equal(previews.length, 200);
  console.log(`[rename benchmark] rows=200 statements=${statementCount} elapsedMs=${elapsedMs.toFixed(1)}`);
  console.log(
    [...statementsBySql.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([sql, count]) => `${count}x ${sql}`)
      .join("\n"),
  );
});

test("batched collision preload still disambiguates spatial audio in a shared root", () => {
  seedCanonicalGraph();
  const musicRoot = configModule.Config.getMusicPath();
  const config = configModule.readConfig();
  config.path.spatial_path = musicRoot;
  configModule.writeConfig(config);

  const stereoPath = path.join(musicRoot, "Artist One", "Canonical Album", "01 - Canonical Song.m4a");
  const spatialSource = path.join(musicRoot, "Artist One", "Imports", "canonical-song-atmos.m4a");
  fs.mkdirSync(path.dirname(stereoPath), { recursive: true });
  fs.mkdirSync(path.dirname(spatialSource), { recursive: true });
  fs.writeFileSync(stereoPath, "stereo-audio");
  fs.writeFileSync(spatialSource, "spatial-audio");

  upsertCanonicalAudioFile({
    filePath: stereoPath,
    libraryRoot: musicRoot,
    librarySlot: "stereo",
    quality: "LOSSLESS",
  });
  upsertCanonicalAudioFile({
    filePath: spatialSource,
    libraryRoot: musicRoot,
    librarySlot: "spatial",
    quality: "DOLBY_ATMOS",
  });

  const previews = renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews({ artistId: "1" });
  const spatial = previews.find((preview) => preview.file_path === spatialSource);
  const expectedSpatialPath = path.join(
    musicRoot,
    "Artist One",
    "Canonical Album",
    "01 - Canonical Song [DOLBY_ATMOS].m4a",
  );

  assert.ok(spatial);
  assert.equal(path.resolve(spatial.expected_path || ""), path.resolve(expectedSpatialPath));
  assert.equal(spatial.conflict, false);
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

  const expectedPath = path.join(videoRoot, "Artist One", "Artist One - Canonical Video.mp4");
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
    SELECT track_file_id AS trackFileId,
           canonical_release_group_mbid AS canonicalReleaseGroupMbid,
           canonical_track_mbid AS canonicalTrackMbid,
           canonical_recording_mbid AS canonicalRecordingMbid,
           library_slot AS librarySlot
    FROM LyricFiles
    WHERE file_path = ?
  `).get(expectedSpatialLyricPath) as {
    trackFileId: number | null;
    canonicalReleaseGroupMbid: string | null;
    canonicalTrackMbid: string | null;
    canonicalRecordingMbid: string | null;
    librarySlot: string;
  };

  assert.equal(replicatedLyric.canonicalReleaseGroupMbid, "release-group-mbid-1");
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
    SELECT canonical_release_group_mbid AS canonicalReleaseGroupMbid,
           canonical_release_mbid AS canonicalReleaseMbid,
           canonical_track_mbid AS canonicalTrackMbid,
           canonical_recording_mbid AS canonicalRecordingMbid,
           provider, provider_entity_type AS providerEntityType,
           provider_id AS providerId, library_slot AS librarySlot
    FROM MetadataFiles
    WHERE file_path = ?
  `).get(expectedSpatialCoverPath) as {
    canonicalReleaseGroupMbid: string | null;
    canonicalReleaseMbid: string | null;
    canonicalTrackMbid: string | null;
    canonicalRecordingMbid: string | null;
    provider: string | null;
    providerEntityType: string | null;
    providerId: string | null;
    librarySlot: string;
  };

  assert.equal(replicatedCover.canonicalReleaseGroupMbid, "release-group-mbid-1");
  assert.equal(replicatedCover.canonicalReleaseMbid, "release-mbid-1");
  assert.equal(replicatedCover.canonicalTrackMbid, null);
  assert.equal(replicatedCover.canonicalRecordingMbid, null);
  assert.equal(replicatedCover.provider, "tidal");
  assert.equal(replicatedCover.providerEntityType, "album");
  assert.equal(replicatedCover.providerId, "20");
  assert.equal(replicatedCover.librarySlot, "spatial");
});

function seedInlineVideoTransferFixture(options: { stereoMonitored?: boolean } = {}) {
  const stereoMonitored = options.stereoMonitored !== false;
  const musicRoot = configModule.Config.getMusicPath();
  const videoRoot = configModule.Config.getVideoPath();

  seedCanonicalGraph({ albumTitle: "Bad Blood", trackTitle: "Pompeii" });
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES (?, ?, 'stereo', ?, ?)
  `).run("artist-mbid-1", "release-group-mbid-1", stereoMonitored ? 1 : 0, "release-mbid-1");

  const audioRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("recording-mbid-1") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-rec-pompeii", "Pompeii", "artist-mbid-1");
  const videoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-pompeii") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_mbid, recording_id, title, library_slot
    ) VALUES ('tidal', 'video', 'video-pompeii', 'artist-mbid-1', 'video-rec-pompeii', ?, 'Pompeii', 'video')
  `).run(videoRecId);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, recording_id, album_id, title, quality, library_slot
    ) VALUES (
      'tidal', 'track', 'track-pompeii', 'artist-mbid-1', 'release-group-mbid-1', 'release-mbid-1',
      'track-mbid-1', 'recording-mbid-1', ?, '10', 'Pompeii', 'LOSSLESS', 'stereo'
    )
  `).run(audioRecId);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.98)
  `).run(videoRecId, audioRecId);

  const separatedVideoPath = path.join(videoRoot, "Artist One", "Pompeii.mp4");
  fs.mkdirSync(path.dirname(separatedVideoPath), { recursive: true });
  fs.writeFileSync(separatedVideoPath, "test-video");

  const videoFileId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: "video-pompeii",
    filePath: separatedVideoPath,
    libraryRoot: videoRoot,
    fileType: "video",
    quality: "MP4_1080P",
    provider: "tidal",
    providerEntityType: "video",
    providerId: "video-pompeii",
    librarySlot: "video",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalRecordingMbid: "video-rec-pompeii",
  });

  const audioPath = path.join(musicRoot, "Artist One", "Bad Blood", "01 - Pompeii.flac");
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, "test-audio");
  const audioFileId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: "track-pompeii",
    filePath: audioPath,
    libraryRoot: musicRoot,
    fileType: "track",
    quality: "LOSSLESS",
    provider: "tidal",
    providerEntityType: "track",
    providerId: "track-pompeii",
    librarySlot: "stereo",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalReleaseGroupMbid: "release-group-mbid-1",
    canonicalReleaseMbid: "release-mbid-1",
    canonicalTrackMbid: "track-mbid-1",
    canonicalRecordingMbid: "recording-mbid-1",
  });

  return {
    audioFileId,
    videoFileId,
    separatedVideoPath,
    inlineVideoPath: path.join(musicRoot, "Artist One", "Bad Blood", "01 - Pompeii-video.mp4"),
  };
}

test("RenameTrackFileService moves separated video to inline when association and stereo RG are ready", () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const fixture = seedInlineVideoTransferFixture();
  const videoRow = dbModule.db.prepare(`
    SELECT id, artist_id, NULL AS album_id, provider_id AS media_id,
           file_path, relative_path, library_root, file_type, extension
    FROM TrackFiles WHERE id = ?
  `).get(fixture.videoFileId) as any;

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath(videoRow);
  assert.equal(path.resolve(expected.expectedPath || ""), path.resolve(fixture.inlineVideoPath));

  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameFiles([fixture.videoFileId]);
  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(fixture.separatedVideoPath), false);
  assert.equal(fs.existsSync(fixture.inlineVideoPath), true);

  const moved = dbModule.db.prepare(`
    SELECT file_path AS filePath, library_root AS libraryRoot, needs_rename AS needsRename
    FROM TrackFiles WHERE id = ?
  `).get(fixture.videoFileId) as { filePath: string; libraryRoot: string; needsRename: number };
  assert.equal(path.resolve(moved.filePath), path.resolve(fixture.inlineVideoPath));
  assert.equal(moved.needsRename, 0);
});

test("relocateRelatedInlineVideosForImportedAudio moves linked videos when stereo audio is imported", () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const fixture = seedInlineVideoTransferFixture();
  const result = renameTrackFileServiceModule.RenameTrackFileService
    .relocateRelatedInlineVideosForImportedAudio([fixture.audioFileId]);

  assert.equal(result.renamed, 1);
  assert.equal(fs.existsSync(fixture.separatedVideoPath), false);
  assert.equal(fs.existsSync(fixture.inlineVideoPath), true);
});

test("relocateRelatedInlineVideosForImportedAudio is a no-op when layout is separated", () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "separated";
  configModule.writeConfig(config);

  const fixture = seedInlineVideoTransferFixture();
  const result = renameTrackFileServiceModule.RenameTrackFileService
    .relocateRelatedInlineVideosForImportedAudio([fixture.audioFileId]);

  assert.equal(result.renamed, 0);
  assert.equal(fs.existsSync(fixture.separatedVideoPath), true);
  assert.equal(fs.existsSync(fixture.inlineVideoPath), false);
});

test("relocateRelatedInlineVideosForImportedAudio does not move to inline when stereo RG is unmonitored", () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const fixture = seedInlineVideoTransferFixture({ stereoMonitored: false });
  renameTrackFileServiceModule.RenameTrackFileService
    .relocateRelatedInlineVideosForImportedAudio([fixture.audioFileId]);

  assert.equal(fs.existsSync(fixture.inlineVideoPath), false);
  const videoRow = dbModule.db.prepare(`
    SELECT file_path AS filePath FROM TrackFiles WHERE id = ?
  `).get(fixture.videoFileId) as { filePath: string };
  const videoRoot = path.resolve(configModule.Config.getVideoPath());
  assert.ok(
    path.resolve(videoRow.filePath).toLowerCase().startsWith(videoRoot.toLowerCase()),
    `expected video to remain under videos root, got ${videoRow.filePath}`,
  );
});
test("relocateRelatedInlineVideosForImportedAudio ignores unrelated imported audio", () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const fixture = seedInlineVideoTransferFixture();
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid)
    VALUES (?, ?, ?)
  `).run("recording-mbid-other", "Other Song", "artist-mbid-1");
  const otherAudioPath = path.join(configModule.Config.getMusicPath(), "Artist One", "Other.flac");
  fs.mkdirSync(path.dirname(otherAudioPath), { recursive: true });
  fs.writeFileSync(otherAudioPath, "other-audio");
  const otherAudioId = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: "track-other",
    filePath: otherAudioPath,
    libraryRoot: configModule.Config.getMusicPath(),
    fileType: "track",
    quality: "LOSSLESS",
    provider: "tidal",
    providerEntityType: "track",
    providerId: "track-other",
    librarySlot: "stereo",
    canonicalArtistMbid: "artist-mbid-1",
    canonicalRecordingMbid: "recording-mbid-other",
  });

  const result = renameTrackFileServiceModule.RenameTrackFileService
    .relocateRelatedInlineVideosForImportedAudio([otherAudioId]);

  assert.equal(result.renamed, 0);
  assert.equal(fs.existsSync(fixture.separatedVideoPath), true);
});

test("rename preview lists media files only; id-based apply co-moves the linked lyric", () => {
  seedCanonicalGraph({ albumTitle: "Album One", trackTitle: "Track One" });
  const musicRoot = configModule.Config.getMusicPath();
  const importDir = path.join(musicRoot, "Artist One", "Imports");
  fs.mkdirSync(importDir, { recursive: true });
  const audioPath = path.join(importDir, "track-one.flac");
  const lyricPath = path.join(importDir, "track-one.lrc");
  fs.writeFileSync(audioPath, "audio-bytes");
  fs.writeFileSync(lyricPath, "[00:01.00] la la la");

  const audioId = upsertCanonicalAudioFile({
    filePath: audioPath,
    libraryRoot: musicRoot,
    librarySlot: "stereo",
  });

  // Lidarr's ExtraFile.TrackFileId link: this .lrc belongs to the audio file above.
  dbModule.db.prepare(`
    INSERT INTO LyricFiles (
      artist_id, track_file_id, relative_path, file_path, library_root, extension, library_slot,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, needs_rename
    ) VALUES ('1', ?, ?, ?, ?, 'lrc', 'stereo',
      'artist-mbid-1', 'release-group-mbid-1', 'release-mbid-1',
      'track-mbid-1', 'recording-mbid-1', 0)
  `).run(audioId, path.relative(musicRoot, lyricPath), lyricPath, musicRoot);

  // Preview shows the media file only — the lyric is not its own rename decision.
  const previews = renameTrackFileServiceModule.RenameTrackFileService.getRenamePreviews({ artistId: "1" });
  assert.equal(previews.length, 1);
  assert.equal(previews[0].file_type, "track");

  // Applying by the media id alone must still move the linked lyric alongside it.
  const result = renameTrackFileServiceModule.RenameTrackFileService.executeRenameFiles([audioId]);
  assert.equal(result.renamed >= 1, true);

  const expectedAudio = path.join(musicRoot, "Artist One", "Album One", "01 - Track One.flac");
  const expectedLyric = path.join(musicRoot, "Artist One", "Album One", "01 - Track One.lrc");
  assert.equal(fs.existsSync(expectedAudio), true, "audio moved to expected path");
  assert.equal(fs.existsSync(expectedLyric), true, "linked lyric co-moved to expected path");
  assert.equal(fs.existsSync(lyricPath), false, "lyric no longer at old path");

  const lyricRow = dbModule.db.prepare(
    "SELECT file_path FROM LyricFiles WHERE track_file_id = ?",
  ).get(audioId) as { file_path: string };
  assert.equal(path.resolve(lyricRow.file_path), path.resolve(expectedLyric));
});
