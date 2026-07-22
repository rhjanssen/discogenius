import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

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
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-one-mbid", "Artist One", 1);

  // Legacy rows retained for TrackFiles FK during the transition (dropped Phase 5).

// Canonical graph + provider availability (naming resolves from these).
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date) VALUES (?, ?, ?, ?, ?)")
    .run("rg-one", "artist-one-mbid", "Album One", "Album", "2024-01-01");
  dbModule.db.prepare(`INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, media_count, track_count, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("rel-one", "rg-one", "artist-one-mbid", "Album One", 1, 1, "2024-01-01");
  dbModule.db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, length_ms) VALUES (?, ?, ?, ?)")
    .run("rec-one", "Track One", "artist-one-mbid", 180000);
  dbModule.db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("trk-one", "rel-one", "rec-one", 1, 1, "1", "Track One");
  dbModule.db.prepare(`INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, selected_provider, selected_provider_id, selected_release_mbid, quality, match_status)
    VALUES (?, ?, 'stereo', 'tidal', '10', 'rel-one', 'LOSSLESS', 'verified')`).run("artist-one-mbid", "rg-one");
  dbModule.db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, album_id, title, quality, library_slot)
    VALUES ('tidal', 'album', '10', 'artist-one-mbid', 'rg-one', 'rel-one', '10', 'Album One', 'LOSSLESS', 'stereo')`).run();
  dbModule.db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, track_mbid, recording_mbid, album_id, title, quality, library_slot)
    VALUES ('tidal', 'track', '100', 'artist-one-mbid', 'rg-one', 'rel-one', 'trk-one', 'rec-one', '10', 'Track One', 'LOSSLESS', 'stereo')`).run();

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

test("finalizeImportedDirectories relocates linked separated videos inline after stereo audio import", async () => {
  const config = configModule.readConfig();
  config.path.video_folder_layout = "inline";
  configModule.writeConfig(config);

  const { libraryFileId } = seedImportedTrack();
  // seedImportedTrack leaves RG slot unmonitored by default — enable for inline gate.
  dbModule.db.prepare(`
    UPDATE ReleaseGroupSlots SET monitored = 1 WHERE release_group_mbid = 'rg-one' AND slot = 'stereo'
  `).run();

  const audioRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("rec-one") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES (?, ?, ?, 1)
  `).run("video-rec-one", "Track One", "artist-one-mbid");
  const videoRecId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get("video-rec-one") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_mbid, recording_id, title, library_slot
    ) VALUES ('tidal', 'video', 'video-100', 'artist-one-mbid', 'video-rec-one', ?, 'Track One', 'video')
  `).run(videoRecId);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (source_recording_id, target_recording_id, relation_type, confidence)
    VALUES (?, ?, 'provider_video_for', 0.98)
  `).run(videoRecId, audioRecId);
  dbModule.db.prepare(`
    UPDATE ProviderItems SET recording_id = ? WHERE entity_type = 'track' AND provider_id = '100'
  `).run(audioRecId);

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
