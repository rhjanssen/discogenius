import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-move-artist-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let configModule: typeof import("./config.js");
let libraryFilesModule: typeof import("./library-files.js");
let moveArtistServiceModule: typeof import("./move-artist-service.js");
let queueModule: typeof import("./queue.js");
let validationModule: typeof import("../utils/request-validation.js");

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

function seedArtistTrack(params?: { artistPath?: string; fileName?: string }) {
  const artistPath = params?.artistPath ?? "Old Artist";
  const fileName = params?.fileName ?? "01 - Track One.flac";
  const musicRoot = configModule.Config.getMusicPath();
  const trackDir = path.join(musicRoot, artistPath, "Album One");
  const trackPath = path.join(trackDir, fileName);

  fs.mkdirSync(trackDir, { recursive: true });
  fs.writeFileSync(trackPath, "test-audio");

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Artist One", artistPath, 1);

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
    filePath: trackPath,
    libraryRoot: musicRoot,
    fileType: "track",
  });

  return { musicRoot, trackPath };
}

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "atmos"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  libraryFilesModule = await import("./library-files.js");
  moveArtistServiceModule = await import("./move-artist-service.js");
  queueModule = await import("./queue.js");
  validationModule = await import("../utils/request-validation.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM job_queue").run();
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

test("moveArtist changes the stored folder and produces an artist-scoped rename plan", () => {
  seedArtistTrack();

  const result = moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "1",
    path: "Artist One",
    moveFiles: false,
  });

  assert.ok(result);
  assert.equal(result?.changed, true);
  assert.equal(result?.oldPath, "Old Artist");
  assert.equal(result?.path, "Artist One");
  assert.equal(result?.moveFilesQueued, false);
  assert.equal(result?.renameStatus.renameNeeded, 1);

  const artist = dbModule.db.prepare("SELECT path FROM artists WHERE id = ?").get(1) as { path: string };
  assert.equal(artist.path, "Artist One");

  const trackedFile = dbModule.db.prepare("SELECT expected_path as expectedPath FROM library_files WHERE media_id = ?").get(100) as { expectedPath: string };
  assert.ok(trackedFile.expectedPath.includes(path.join("Artist One", "Album One", "01 - Track One.flac")));
});

test("moveArtist queues MoveArtist when moveFiles is requested", () => {
  seedArtistTrack();

  const result = moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "1",
    path: "Artist Prime",
    moveFiles: true,
  });

  assert.ok(result);
  assert.equal(result?.moveFilesQueued, true);
  assert.ok(result?.jobId);

  const job = dbModule.db.prepare(`
    SELECT type, ref_id as refId
    FROM job_queue
    WHERE id = ?
  `).get(result?.jobId) as { type: string; refId: string };

  assert.equal(job.type, queueModule.JobTypes.MoveArtist);
  assert.equal(job.refId, "1");
});

test("executeMoveArtistJob moves the artist folder and rebases tracked file paths", () => {
  const seeded = seedArtistTrack();

  moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "1",
    path: "Artist Prime",
    moveFiles: true,
  });

  const result = moveArtistServiceModule.MoveArtistService.executeMoveArtistJob({
    artistId: "1",
    sourcePath: "Old Artist",
    destinationPath: "Artist Prime",
  });

  const movedTrackPath = path.join(seeded.musicRoot, "Artist Prime", "Album One", "01 - Track One.flac");
  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, relative_path as relativePath, expected_path as expectedPath, needs_rename as needsRename
    FROM library_files
    WHERE media_id = ?
  `).get(100) as {
    filePath: string;
    relativePath: string;
    expectedPath: string;
    needsRename: number;
  };

  assert.equal(result.movedRoots, 1);
  assert.equal(result.updatedFiles, 1);
  assert.equal(fs.existsSync(seeded.trackPath), false);
  assert.equal(fs.existsSync(movedTrackPath), true);
  assert.equal(trackedFile.filePath, movedTrackPath);
  assert.equal(trackedFile.relativePath, path.join("Artist Prime", "Album One", "01 - Track One.flac"));
  assert.equal(trackedFile.expectedPath, movedTrackPath);
  assert.equal(trackedFile.needsRename, 0);
});

test("executeMoveArtistJob rolls back the stored artist path when the destination already exists", () => {
  const seeded = seedArtistTrack();
  const conflictingDir = path.join(seeded.musicRoot, "Artist Prime");

  fs.mkdirSync(conflictingDir, { recursive: true });
  fs.writeFileSync(path.join(conflictingDir, "keep.txt"), "existing");

  moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "1",
    path: "Artist Prime",
    moveFiles: true,
  });

  assert.throws(
    () => moveArtistServiceModule.MoveArtistService.executeMoveArtistJob({
      artistId: "1",
      sourcePath: "Old Artist",
      destinationPath: "Artist Prime",
    }),
  );

  const artist = dbModule.db.prepare("SELECT path FROM artists WHERE id = ?").get(1) as { path: string };
  assert.equal(artist.path, "Old Artist");
  assert.equal(fs.existsSync(seeded.trackPath), true);
});

test("moveArtist rejects overlapping artist folders", () => {
  seedArtistTrack({ artistPath: "Artists/Artist One" });
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(2, "Artist Two", "Artists", 1);

  assert.throws(
    () => moveArtistServiceModule.MoveArtistService.moveArtist({
      artistId: "1",
      path: "Artists",
    }),
    validationModule.RequestValidationError,
  );
});
