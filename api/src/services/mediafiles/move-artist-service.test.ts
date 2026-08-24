import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedAcceptedProviderTrackMatch } from "../../test-support/normalized-provider-fixtures.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";
import { stampArtistLibraryPath, resolveArtistMetadataId } from "../music/managed-artists.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-move-artist-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let libraryFilesModule: typeof import("./library-files.js");
let moveArtistServiceModule: typeof import("./move-artist-service.js");
let queueModule: typeof import("../commands/command-queue-manager.js");
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
  seedLibraryArtistMonitoring(dbModule.db, "artist-one-mbid");
  const artistMetadataId = resolveArtistMetadataId("artist-one-mbid");
  assert.ok(artistMetadataId != null);
  stampArtistLibraryPath(artistMetadataId, artistPath, true);

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
    artistId: "artist-one-mbid",
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
  queueModule = await import("../commands/command-queue-manager.js");
  validationModule = await import("../../utils/request-validation.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Libraries").run();

  fs.rmSync(path.join(tempDir, "library"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  writeTestConfig();
  seedTestLibrary(db, { name: "Move Stereo", rootPath: configModule.Config.getMusicPath() });
  seedTestLibrary(db, { name: "Move Spatial", rootPath: configModule.Config.getSpatialPath() });
  seedTestLibrary(db, { name: "Move Video", rootPath: configModule.Config.getVideoPath() });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("moveArtist changes the stored folder and produces an artist-scoped rename plan", () => {
  seedArtistTrack();

  const result = moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "artist-one-mbid",
    path: "Artist One",
    moveFiles: false,
  });

  assert.ok(result);
  assert.equal(result?.changed, true);
  assert.equal(result?.oldPath, "Old Artist");
  assert.equal(result?.path, "Artist One");
  assert.equal(result?.moveFilesQueued, false);
  assert.equal(result?.renameStatus.renameNeeded, 1);

  const artist = dbModule.db.prepare("SELECT path FROM LibraryArtists la JOIN ArtistMetadata am ON am.id = la.artist_metadata_id WHERE am.mbid = ?").get("artist-one-mbid") as { path: string };
  assert.equal(artist.path, "Artist One");

  // getRenameStatus is read-only (no expected_path writes); the plan lives on renameStatus.
  const sample = result?.renameStatus.sample[0];
  assert.ok(sample?.expected_path?.includes(path.join("Artist One", "Album One", "01 - Track One.flac")));
  assert.equal(sample?.needs_rename, true);
});

test("moveArtist queues MoveArtist when moveFiles is requested", () => {
  seedArtistTrack();

  const result = moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "artist-one-mbid",
    path: "Artist Prime",
    moveFiles: true,
  });

  assert.ok(result);
  assert.equal(result?.moveFilesQueued, true);
  assert.ok(result?.commandId);

  const job = dbModule.db.prepare(`
    SELECT name, ref_id as refId
    FROM commands
    WHERE id = ?
  `).get(result?.commandId) as { name: string; refId: string };

  assert.equal(job.name, queueModule.CommandNames.MoveArtist);
  assert.equal(job.refId, "artist-one-mbid");
});

test("moveArtist can rebuild the artist path from the current naming template", () => {
  seedArtistTrack({ artistPath: "Artist One" });
  const config = configModule.readConfig();
  config.naming.artist_folder = "{artistName} [{artistMbId}]";
  configModule.writeConfig(config);

  const result = moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "artist-one-mbid",
    applyNamingTemplate: true,
    moveFiles: true,
  });

  assert.ok(result);
  assert.equal(result?.path, "Artist One [artist-one-mbid]");
  assert.equal(result?.moveFilesQueued, true);
  assert.ok(result?.commandId);
});

test("executeMoveArtistJob moves the artist folder and rebases tracked file paths", () => {
  const seeded = seedArtistTrack();

  moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "artist-one-mbid",
    path: "Artist Prime",
    moveFiles: true,
  });

  const result = moveArtistServiceModule.MoveArtistService.executeMoveArtistJob({
    artistId: "artist-one-mbid",
    sourcePath: "Old Artist",
    destinationPath: "Artist Prime",
  });

  const movedTrackPath = path.join(seeded.musicRoot, "Artist Prime", "Album One", "01 - Track One.flac");
  const trackedFile = dbModule.db.prepare(`
    SELECT file_path as filePath, relative_path as relativePath, expected_path as expectedPath, needs_rename as needsRename
    FROM TrackFiles
    WHERE provider = ? AND provider_entity_type = ? AND provider_id = ?
  `).get("tidal", "track", "100") as {
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
    artistId: "artist-one-mbid",
    path: "Artist Prime",
    moveFiles: true,
  });

  assert.throws(
    () => moveArtistServiceModule.MoveArtistService.executeMoveArtistJob({
      artistId: "artist-one-mbid",
      sourcePath: "Old Artist",
      destinationPath: "Artist Prime",
    }),
  );

  const artist = dbModule.db.prepare("SELECT path FROM LibraryArtists la JOIN ArtistMetadata am ON am.id = la.artist_metadata_id WHERE am.mbid = ?").get("artist-one-mbid") as { path: string };
  assert.equal(artist.path, "Old Artist");
  assert.equal(fs.existsSync(seeded.trackPath), true);
});

test("executeMoveArtistJob atomically rolls back every file row when sidecar rebasing fails", () => {
  const seeded = seedArtistTrack();
  const sourceCoverPath = path.join(seeded.musicRoot, "Old Artist", "Album One", "cover.jpg");
  fs.writeFileSync(sourceCoverPath, "cover");
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "artist-one-mbid",
    filePath: sourceCoverPath,
    libraryRoot: seeded.musicRoot,
    fileType: "cover",
  });

  moveArtistServiceModule.MoveArtistService.moveArtist({
    artistId: "artist-one-mbid",
    path: "Artist Prime",
    moveFiles: true,
  });

  dbModule.db.exec(`
    CREATE TRIGGER fail_move_sidecar_rebase
    BEFORE UPDATE OF file_path ON MetadataFiles
    BEGIN
      SELECT RAISE(ABORT, 'simulated sidecar rebase failure');
    END;
  `);

  try {
    assert.throws(
      () => moveArtistServiceModule.MoveArtistService.executeMoveArtistJob({
        artistId: "artist-one-mbid",
        sourcePath: "Old Artist",
        destinationPath: "Artist Prime",
      }),
      /simulated sidecar rebase failure/,
    );
  } finally {
    dbModule.db.exec("DROP TRIGGER IF EXISTS fail_move_sidecar_rebase");
  }

  const trackRow = dbModule.db.prepare(`
    SELECT file_path AS filePath, relative_path AS relativePath
    FROM TrackFiles
    WHERE provider_id = '100'
  `).get() as { filePath: string; relativePath: string };
  const coverRow = dbModule.db.prepare(`
    SELECT file_path AS filePath, relative_path AS relativePath
    FROM MetadataFiles
    WHERE file_path = ?
  `).get(sourceCoverPath) as { filePath: string; relativePath: string } | undefined;
  const artist = dbModule.db.prepare("SELECT path FROM LibraryArtists la JOIN ArtistMetadata am ON am.id = la.artist_metadata_id WHERE am.mbid = 'artist-one-mbid'")
    .get() as { path: string };

  assert.equal(trackRow.filePath, seeded.trackPath);
  assert.equal(trackRow.relativePath, path.join("Old Artist", "Album One", "01 - Track One.flac"));
  assert.equal(coverRow?.filePath, sourceCoverPath);
  assert.equal(coverRow?.relativePath, path.join("Old Artist", "Album One", "cover.jpg"));
  assert.equal(artist.path, "Old Artist");
  assert.equal(fs.existsSync(seeded.trackPath), true);
  assert.equal(fs.existsSync(sourceCoverPath), true);
  assert.equal(
    fs.existsSync(path.join(seeded.musicRoot, "Artist Prime")),
    false,
  );
});

test("moveArtist rejects overlapping artist folders", () => {
  seedArtistTrack({ artistPath: "Artists/Artist One" });
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
  `).run("artist-two-mbid", "Artist Two");
  seedLibraryArtistMonitoring(dbModule.db, "artist-two-mbid");
  stampArtistLibraryPath(resolveArtistMetadataId("artist-two-mbid")!, "Artists", true);

  assert.throws(
    () => moveArtistServiceModule.MoveArtistService.moveArtist({
      artistId: "artist-one-mbid",
      path: "Artists",
    }),
    validationModule.RequestValidationError,
  );
});
