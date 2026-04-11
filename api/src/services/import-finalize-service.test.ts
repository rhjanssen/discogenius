import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-import-finalize-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let configModule: typeof import("./config.js");
let importFinalizeModule: typeof import("./import-finalize-service.js");
let libraryFilesModule: typeof import("./library-files.js");

function writeTestConfig() {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.atmos_path = path.join(tempDir, "library", "atmos");
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

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Artist One", "Artist One", 1);

  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "Album One", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 180, 1);

  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, type, explicit, quality, track_number, volume_number, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(100, 1, 10, "Track One", "Track", 0, "LOSSLESS", 1, 1, 180, 1);

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
  fs.mkdirSync(path.join(tempDir, "library", "atmos"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  importFinalizeModule = await import("./import-finalize-service.js");
  libraryFilesModule = await import("./library-files.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM media_artists").run();
  db.prepare("DELETE FROM album_artists").run();
  db.prepare("DELETE FROM library_files").run();
  db.prepare("DELETE FROM media").run();
  db.prepare("DELETE FROM albums").run();
  db.prepare("DELETE FROM artists").run();

  fs.rmSync(path.join(tempDir, "library"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "atmos"), { recursive: true });
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
    FROM library_files
    WHERE id = ?
  `).get(libraryFileId) as { filePath: string; expectedPath: string; needsRename: number };

  assert.equal(path.normalize(row.filePath), path.normalize(expectedPath));
  assert.equal(path.normalize(row.expectedPath), path.normalize(expectedPath));
  assert.equal(row.needsRename, 0);
});
