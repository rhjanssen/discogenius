import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-rename-track-file-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let configModule: typeof import("./config.js");
let libraryFilesModule: typeof import("./library-files.js");
let renameTrackFileServiceModule: typeof import("./rename-track-file-service.js");

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

function seedTrackedFile() {
  const musicRoot = configModule.Config.getMusicPath();
  const sourceDir = path.join(musicRoot, "Artist One", "Imports");
  const sourcePath = path.join(sourceDir, "track-one.flac");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(sourcePath, "test-audio");

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

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "atmos"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  libraryFilesModule = await import("./library-files.js");
  renameTrackFileServiceModule = await import("./rename-track-file-service.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM history_events").run();
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
    FROM library_files
    WHERE media_id = ?
  `).get(100) as { filePath: string; relativePath: string; expectedPath: string; needsRename: number };

  assert.equal(path.resolve(trackedFile.filePath), path.resolve(seeded.expectedPath));
  assert.equal(trackedFile.relativePath, path.join("Artist One", "Album One", "01 - Track One.flac"));
  assert.equal(path.resolve(trackedFile.expectedPath), path.resolve(seeded.expectedPath));
  assert.equal(trackedFile.needsRename, 0);
});

test("RenameTrackFileService keeps the stored artist path canonical until path updates are applied explicitly", () => {
  writeTestConfig();
  const musicRoot = configModule.Config.getMusicPath();
  const legacyPath = path.join(musicRoot, "Artist One", "Album One", "01 - Track One.flac");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, "test-audio");

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, mbid, path, monitor)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, "Artist One", "artist-mbid-1", "Artist One", 1);

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
    filePath: legacyPath,
    libraryRoot: musicRoot,
    fileType: "track",
  });

  const config = configModule.readConfig();
  config.naming.artist_folder = "{artistName} [{artistMbId}]";
  configModule.writeConfig(config);

  const status = renameTrackFileServiceModule.RenameTrackFileService.getRenameStatus({ artistId: "1" }, 10);
  const artist = dbModule.db.prepare("SELECT path FROM artists WHERE id = ?").get(1) as { path: string };

  assert.equal(artist.path, "Artist One");
  assert.equal(status.renameNeeded, 0);
  assert.equal(status.sample.length, 0);
});
