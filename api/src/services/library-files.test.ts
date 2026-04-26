import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-files-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let configModule: typeof import("./config.js");
let libraryFilesModule: typeof import("./library-files.js");
let artistPathsModule: typeof import("./artist-paths.js");

function writeTestConfig(overrides?: {
  artistFolder?: string;
  albumTrackPathSingle?: string;
}) {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.atmos_path = path.join(tempDir, "library", "atmos");
  config.path.video_path = path.join(tempDir, "library", "videos");
  if (overrides?.artistFolder) {
    config.naming.artist_folder = overrides.artistFolder;
  }
  if (overrides?.albumTrackPathSingle) {
    config.naming.album_track_path_single = overrides.albumTrackPathSingle;
  }
  configModule.writeConfig(config);
}

before(async () => {
  fs.mkdirSync(path.join(tempDir, "library", "music"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "atmos"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  libraryFilesModule = await import("./library-files.js");
  artistPathsModule = await import("./artist-paths.js");

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

  writeTestConfig();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("computeExpectedPath keeps the stored artist folder canonical when naming changes", () => {
  writeTestConfig({
    artistFolder: "{artistName} [{artistMbId}]",
    albumTrackPathSingle: "{albumTitle}/{trackNumber00} - {trackTitle}",
  });

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, mbid, path, monitor)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, "Queen", "artist-mbid-1", "Queen (legacy-folder)", 1);

  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1);

  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(100, 1, 10, "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1);

  const expected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 500,
    artist_id: 1,
    album_id: 10,
    media_id: 100,
    file_path: path.join(tempDir, "legacy", "Queen", "old.flac"),
    relative_path: null,
    library_root: "music",
    file_type: "track",
    extension: "flac",
  });

  const expectedRoot = path.join(configModule.Config.getMusicPath(), "Queen (legacy-folder)");
  assert.ok(expected.expectedPath);
  assert.ok(expected.expectedPath?.startsWith(expectedRoot));
  assert.ok(!expected.expectedPath?.includes("Queen [artist-mbid-1]"));
});

test("NFO sidecars resolve to artist and album metadata paths and stay singleton-tracked", () => {
  writeTestConfig({
    artistFolder: "{artistName}",
    albumTrackPathSingle: "{albumTitle} ({releaseYear})/{trackNumber00} - {trackTitle}",
  });

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, mbid, path, monitor)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, "Queen", "artist-mbid-1", "Queen", 1);

  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1);

  const musicRoot = configModule.Config.getMusicPath();
  const artistNfoPath = path.join(musicRoot, "Queen", "artist.nfo");
  const albumNfoPath = path.join(musicRoot, "Queen", "A Night at the Opera (1975)", "album.nfo");

  const artistNfoExpected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 501,
    artist_id: 1,
    album_id: null,
    media_id: null,
    file_path: path.join(tempDir, "legacy", "artist.nfo"),
    relative_path: null,
    library_root: "music",
    file_type: "nfo",
    extension: "nfo",
  });

  const albumNfoExpected = libraryFilesModule.LibraryFilesService.computeExpectedPath({
    id: 502,
    artist_id: 1,
    album_id: 10,
    media_id: null,
    file_path: path.join(tempDir, "legacy", "album.nfo"),
    relative_path: null,
    library_root: "music",
    file_type: "nfo",
    extension: "nfo",
  });

  assert.equal(artistNfoExpected.expectedPath, artistNfoPath);
  assert.equal(albumNfoExpected.expectedPath, albumNfoPath);

  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    filePath: path.join(tempDir, "legacy", "old-artist.nfo"),
    libraryRoot: musicRoot,
    fileType: "nfo",
  });
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    filePath: artistNfoPath,
    libraryRoot: musicRoot,
    fileType: "nfo",
  });
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    filePath: path.join(tempDir, "legacy", "old-album.nfo"),
    libraryRoot: musicRoot,
    fileType: "nfo",
  });
  libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    filePath: albumNfoPath,
    libraryRoot: musicRoot,
    fileType: "nfo",
  });

  const rows = dbModule.db.prepare(`
    SELECT album_id, file_path
    FROM library_files
    WHERE file_type = 'nfo'
    ORDER BY album_id IS NOT NULL, album_id
  `).all() as Array<{ album_id: number | null; file_path: string }>;

  assert.deepEqual(rows, [
    { album_id: null, file_path: artistNfoPath },
    { album_id: 10, file_path: albumNfoPath },
  ]);
});

test("resolveArtistFolderForPersistence disambiguates same-name artists outside the repository layer", () => {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Phoenix", "Phoenix", 1);

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: 2,
    artistName: "Phoenix",
  });

  assert.equal(resolved, "Phoenix (2)");
});

test("resolveArtistFolderForPersistence avoids nested folder collisions for generated artist paths", () => {
  writeTestConfig({ artistFolder: "Artists/{artistName}" });

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Air", "Artists", 1);

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: 2,
    artistName: "Air",
  });

  assert.equal(resolved, path.join("Artists (2)", "Air"));
});

test("shouldReapplyArtistPathTemplate detects legacy generated folders once artist MBIDs exist", () => {
  writeTestConfig({ artistFolder: "{artistName} [{artistMbId}]" });

  const shouldReapply = artistPathsModule.shouldReapplyArtistPathTemplate({
    artistId: 1,
    artistName: "Queen",
    artistMbId: "artist-mbid-1",
    existingPath: "Queen",
  });

  assert.equal(shouldReapply, true);
});

test("backfillArtistPaths assigns unique folders when multiple legacy artists are missing paths", () => {
  writeTestConfig({ artistFolder: "{artistName}" });

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, monitor, path)
    VALUES (?, ?, ?, NULL), (?, ?, ?, NULL)
  `).run(1, "Air", 1, 2, "Air", 1);

  const updated = dbModule.backfillArtistPaths();
  const rows = dbModule.db.prepare(`
    SELECT id, path
    FROM artists
    ORDER BY id ASC
  `).all() as Array<{ id: number; path: string }>;

  assert.equal(updated, 2);
  assert.deepEqual(rows, [
    { id: 1, path: "Air" },
    { id: 2, path: "Air (2)" },
  ]);
});
