import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  seedAcceptedProviderTrackMatch,
  seedAcceptedProviderVideoMatch,
} from "../../test-support/normalized-provider-fixtures.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-import-finalize-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let importFinalizeModule: typeof import("./import-finalize-service.js");
let libraryFilesModule: typeof import("./library-files.js");

function writeTestConfig() {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.spatial_path = path.join(tempDir, "library", "spatial");
  config.path.video_path = path.join(tempDir, "library", "videos");
  config.naming.artist_folder = "{artistName}";
  config.naming.album_track_path_single = "{albumTitle}/{trackNumber00} - {trackTitle}";
  config.naming.album_track_path_multi = "{albumTitle}/Disc {volumeNumber0}/{trackNumber00} - {trackTitle}";
  configModule.writeConfig(config);
}

function seedImportedTrack(fileName = "track-one.flac") {
  const musicRoot = configModule.Config.getMusicPath();
  const incomingDir = path.join(musicRoot, "Artist One", "Incoming");
  const incomingPath = path.join(incomingDir, fileName);
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.writeFileSync(incomingPath, "test-audio");

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-one-mbid", "Artist One");
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("1", "Artist One");

  // Legacy rows retained for TrackFiles FK during the transition (dropped Phase 5).

// Canonical graph + provider availability (naming resolves from these).
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date) VALUES (?, ?, ?, ?, ?)")
    .run("rg-one", "artist-one-mbid", "Album One", "Album", "2024-01-01");
  dbModule.db.prepare(`INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, media_count, track_count, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("rel-one", "rg-one", "artist-one-mbid", "Album One", 1, 1, "2024-01-01");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, length_ms) VALUES (?, ?, ?, ?)")
    .run("rec-one", "Track One", "artist-one-mbid", 180000);
  dbModule.db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("trk-one", "rel-one", "rec-one", 1, 1, "1", "Track One");
  dbModule.db.prepare(`INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', '10', 'Album One')`).run();
  dbModule.db.prepare(`INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'track', '100', 'Track One')`).run();
  seedAcceptedProviderTrackMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "10",
    providerTrackId: "100",
    releaseMbid: "rel-one",
    trackMbid: "trk-one",
  });

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: incomingPath,
    libraryRoot: musicRoot,
    fileType: "track",
    quality: "LOSSLESS",
  });

  const libraryFileId = importFinalizeModule.resolveImportedLibraryFileId(incomingPath);
  assert.ok(libraryFileId !== null);

  return {
    incomingPath,
    libraryFileId,
    expectedPath: path.join(musicRoot, "Artist One", "Album One", "01 - Track One.flac"),
  };
}

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../../database.js");
  dbModule.initDatabase();

  configModule = await import("../config/config.js");
  importFinalizeModule = await import("./import-finalize-service.js");
  libraryFilesModule = await import("./library-files.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM RecordingRelations").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();  db.prepare("DELETE FROM Libraries").run();

  fs.rmSync(path.join(tempDir, "library"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  writeTestConfig();
  seedTestLibrary(db, { name: "Import Stereo", rootPath: configModule.Config.getMusicPath() });
  seedTestLibrary(db, { name: "Import Spatial", rootPath: configModule.Config.getSpatialPath() });
  seedTestLibrary(db, { name: "Import Video", rootPath: configModule.Config.getVideoPath() });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("finalizeImportedDirectories applies queued renames through RenameTrackFileService", async () => {
  const { incomingPath, libraryFileId, expectedPath } = seedImportedTrack();

  await importFinalizeModule.finalizeImportedDirectories({
    importedFileIds: [libraryFileId],
    dirMappings: new Map(),
    imageFileType: "cover",
  });

  assert.equal(fs.existsSync(incomingPath), false);
  assert.equal(fs.existsSync(expectedPath), true);

  const row = dbModule.db.prepare(`
    SELECT file_path as filePath, expected_path as expectedPath, needs_rename as needsRename
    FROM TrackFiles
    WHERE id = ?
  `).get(libraryFileId) as { filePath: string; expectedPath: string; needsRename: number };

  assert.equal(path.normalize(row.filePath), path.normalize(expectedPath));
  assert.equal(path.normalize(row.expectedPath), path.normalize(expectedPath));
  assert.equal(row.needsRename, 0);
});

test("finalizeImportedDirectories refuses an explicit sidecar target outside its Library root", async () => {
  const musicRoot = configModule.Config.getMusicPath();
  const incomingDir = path.join(musicRoot, "Artist One", "Incoming");
  const destinationDir = path.join(musicRoot, "Artist One", "Album One");
  const outsideDir = path.join(tempDir, "outside-sidecar-target");
  const sourceCover = path.join(incomingDir, "cover.jpg");
  const outsideCover = path.join(outsideDir, "cover.jpg");
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(sourceCover, "cover");

  await importFinalizeModule.finalizeImportedDirectories({
    importedFileIds: [],
    dirMappings: new Map([[
      incomingDir,
      {
        destDir: destinationDir,
        artistId: "missing-artist",
        albumId: null,
        libraryRootPath: musicRoot,
      },
    ]]),
    imageFileType: "cover",
    explicitSidecarTargets: new Map([[sourceCover, outsideCover]]),
  });

  assert.equal(fs.existsSync(sourceCover), true);
  assert.equal(fs.existsSync(outsideCover), false);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS count FROM MetadataFiles")
      .get() as { count: number }).count,
    0,
  );
});

test("finalizeImportedDirectories relocates linked separated videos inline after stereo audio import", async () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const { libraryFileId } = seedImportedTrack();
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) SELECT id, (SELECT id FROM Albums WHERE mbid = 'rg-one'), 'manual', 0, 'inline_video_test', 1
    FROM Libraries
    WHERE enabled = 1
    ON CONFLICT(library_id, release_group_id) DO NOTHING
  `).run();

  const audioRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("rec-one") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-rec-one", "Track One", "artist-one-mbid");
  const videoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-one") as { id: number }).id;
  seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal", providerVideoId: "video-100",
    recordingId: videoRecId, title: "Track One",
  });
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.98)
  `).run(videoRecId, audioRecId);
  // Curation's decision: import finalisation reads the stored placement rather
  // than deriving its own destination for the same file.
  dbModule.db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, selection_mode, placement_mode,
      placement_library_id, inline_track_id, inline_slot, reason
    )
    SELECT
      (SELECT id FROM Libraries ORDER BY id LIMIT 1), ?, 'auto', 'inline',
      (SELECT library.id FROM Libraries library
       JOIN quality_profiles profile ON profile.id = library.quality_profile_id
       WHERE library.enabled = 1
         AND COALESCE(profile.allowed_source_formats, '[]') NOT LIKE '%spatial%'
         AND COALESCE(profile.allowed_source_formats, '[]') NOT LIKE '%video%'
       ORDER BY library.id LIMIT 1),
      (SELECT id FROM Tracks WHERE recording_id = ? ORDER BY id LIMIT 1),
      'video', 'test'
    ON CONFLICT(library_id, video_recording_id) DO NOTHING
  `).run(videoRecId, audioRecId);
  // The audio track offer already reaches its recording through the typed match
  // seeded above; ProviderItems carries no canonical recording id.

  const videoRoot = configModule.Config.getVideoPath();
  const separatedVideoPath = path.join(videoRoot, "Artist One", "Track One.mp4");
  fs.mkdirSync(path.dirname(separatedVideoPath), { recursive: true });
  fs.writeFileSync(separatedVideoPath, "test-video");
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: null,
    mediaId: "video-100",
    filePath: separatedVideoPath,
    libraryRoot: videoRoot,
    fileType: "video",
    quality: "MP4_1080P",
    provider: "tidal",
    providerEntityType: "video",
    providerId: "video-100",
    librarySlot: "video",
    canonicalArtistMbid: "artist-one-mbid",
    canonicalRecordingMbid: "video-rec-one",
  });

  const inlineVideoPath = path.join(
    configModule.Config.getMusicPath(),
    "Artist One",
    "Album One",
    "01 - Track One-video.mp4",
  );

  await importFinalizeModule.finalizeImportedDirectories({
    importedFileIds: [libraryFileId],
    dirMappings: new Map(),
    imageFileType: "cover",
  });

  assert.equal(fs.existsSync(separatedVideoPath), false);
  assert.equal(fs.existsSync(inlineVideoPath), true);
});

test("a file is owned by the library whose root it is actually under", () => {
  // A Library is a root plus a quality profile, so "which library" and "which
  // directory" are one fact. The organizer picks the destination root from the
  // resolved audio slot - spatial audio goes to the spatial root - while the
  // library id travels separately on the download job, and the two disagree
  // whenever a plan queued against the stereo library delivers spatial audio.
  // That used to throw "Library N does not own root /library/spatial-music" and
  // fail the whole import.
  const { db } = dbModule;
  seedImportedTrack("owner-probe.flac");
  const stereoRoot = path.join(tempDir, "own-stereo");
  const spatialRoot = path.join(tempDir, "own-spatial");
  fs.mkdirSync(stereoRoot, { recursive: true });
  fs.mkdirSync(spatialRoot, { recursive: true });
  const stereoLibraryId = seedTestLibrary(db, { name: "Owner Stereo", rootPath: stereoRoot });
  const spatialLibraryId = seedTestLibrary(db, { name: "Owner Spatial", rootPath: spatialRoot });

  const spatialFile = path.join(spatialRoot, "Artist One", "Atmos", "track-atmos.m4a");
  fs.mkdirSync(path.dirname(spatialFile), { recursive: true });
  fs.writeFileSync(spatialFile, "test-audio");

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "900",
    filePath: spatialFile,
    libraryRoot: spatialRoot,
    // The contradiction: the job says stereo, the file is in the spatial root.
    libraryId: stereoLibraryId,
    librarySlot: "spatial",
    fileType: "track",
    quality: "DOLBY_ATMOS",
  });

  assert.equal(
    (db.prepare("SELECT library_id FROM TrackFiles WHERE file_path = ?")
      .get(spatialFile) as { library_id: number } | undefined)?.library_id,
    spatialLibraryId,
    "the library that owns the root the file is in wins over the requested id",
  );

  // A requested library that does own its root is still honoured.
  const stereoFile = path.join(stereoRoot, "Artist One", "Album One", "track-stereo.flac");
  fs.mkdirSync(path.dirname(stereoFile), { recursive: true });
  fs.writeFileSync(stereoFile, "test-audio");
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "901",
    filePath: stereoFile,
    libraryRoot: stereoRoot,
    libraryId: stereoLibraryId,
    librarySlot: "stereo",
    fileType: "track",
    quality: "LOSSLESS",
  });
  assert.equal(
    (db.prepare("SELECT library_id FROM TrackFiles WHERE file_path = ?")
      .get(stereoFile) as { library_id: number }).library_id,
    stereoLibraryId,
  );
});
