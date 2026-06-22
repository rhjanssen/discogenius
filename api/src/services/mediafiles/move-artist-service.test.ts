import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-move-artist-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let libraryFilesModule: typeof import("./library-files.js");
let moveArtistServiceModule: typeof import("./move-artist-service.js");
let queueModule: typeof import("../commands/command-queue.js");
let validationModule: typeof import("../../utils/request-validation.js");

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

function seedArtistTrack(params?: { artistPath?: string; fileName?: string }) {
  const artistPath = params?.artistPath ?? "Old Artist";
  const fileName = params?.fileName ?? "01 - Track One.flac";
  const musicRoot = configModule.Config.getMusicPath();
  const trackDir = path.join(musicRoot, artistPath, "Album One");
  const trackPath = path.join(trackDir, fileName);

  fs.mkdirSync(trackDir, { recursive: true });
  fs.writeFileSync(trackPath, "test-audio");

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-one-mbid", "Artist One");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES (?, ?, ?, ?, ?)
  `).run("1", "Artist One", "artist-one-mbid", artistPath, 1);

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
    filePath: trackPath,
    libraryRoot: musicRoot,
    fileType: "track",
  });

  return { musicRoot, trackPath };
}

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../../database.js");
  dbModule.initDatabase();

  configModule = await import("../config/config.js");
  libraryFilesModule = await import("./library-files.js");
  moveArtistServiceModule = await import("./move-artist-service.js");
  queueModule = await import("../commands/command-queue.js");
  validationModule = await import("../../utils/request-validation.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
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

  const artist = dbModule.db.prepare("SELECT path FROM Artists WHERE id = ?").get("1") as { path: string };
  assert.equal(artist.path, "Artist One");

  const trackedFile = dbModule.db.prepare("SELECT expected_path as expectedPath FROM TrackFiles WHERE media_id = ?").get("100") as { expectedPath: string };
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
    SELECT name, ref_id as refId
    FROM commands
    WHERE id = ?
  `).get(result?.jobId) as { name: string; refId: string };

  assert.equal(job.name, queueModule.CommandNames.MoveArtist);
  assert.equal(job.refId, "1");
});

test("moveArtist can rebuild the artist path from the current naming template", () => {
  seedArtistTrack({ artistPath: "Artist One" });
  const config = configModule.readConfig();
  config.naming.artist_folder = "{artistName} [{artistMbId}]";
  configModule.writeConfig(config);
  dbModule.db.prepare("UPDATE Artists SET mbid = ? WHERE id = ?").run("artist-mbid-1", "1");

  const result = moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "1",
    applyNamingTemplate: true,
    moveFiles: true,
  });

  assert.ok(result);
  assert.equal(result?.path, "Artist One [artist-mbid-1]");
  assert.equal(result?.moveFilesQueued, true);
  assert.ok(result?.jobId);
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
    FROM TrackFiles
    WHERE media_id = ?
  `).get("100") as {
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

  const artist = dbModule.db.prepare("SELECT path FROM Artists WHERE id = ?").get("1") as { path: string };
  assert.equal(artist.path, "Old Artist");
  assert.equal(fs.existsSync(seeded.trackPath), true);
});

test("moveArtist rejects overlapping artist folders", () => {
  seedArtistTrack({ artistPath: "Artists/Artist One" });
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, path, monitored)
    VALUES (?, ?, ?, ?)
  `).run("2", "Artist Two", "Artists", 1);

  assert.throws(
    () => moveArtistServiceModule.MoveArtistService.moveArtist({
      artistId: "1",
      path: "Artists",
    }),
    validationModule.RequestValidationError,
  );
});
