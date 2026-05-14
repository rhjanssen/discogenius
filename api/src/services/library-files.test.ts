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
let downloadStateModule: typeof import("./download-state.js");

function writeTestConfig(overrides?: {
  artistFolder?: string;
  albumTrackPathSingle?: string;
}) {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.spatial_path = path.join(tempDir, "library", "spatial");
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
  fs.mkdirSync(path.join(tempDir, "library", "spatial"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "library", "videos"), { recursive: true });

  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  libraryFilesModule = await import("./library-files.js");
  artistPathsModule = await import("./artist-paths.js");
  downloadStateModule = await import("./download-state.js");

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

test("resolveArtistFolderForPersistence reuses the canonical folder for provider rows with the same MusicBrainz artist", () => {
  writeTestConfig({ artistFolder: "{artistName} {mbid-{artistMbId}}" });

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, mbid, path, monitor)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "artist-mbid-1",
    "Bastille",
    "artist-mbid-1",
    "Bastille {mbid-artist-mbid-1}",
    1,
  );

  const resolved = artistPathsModule.resolveArtistFolderForPersistence({
    artistId: 4526830,
    artistName: "Bastille",
    artistMbId: "artist-mbid-1",
  });

  assert.equal(resolved, "Bastille {mbid-artist-mbid-1}");
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

test("shouldReapplyArtistPathTemplate detects obsolete provider-id disambiguators for canonical artists", () => {
  writeTestConfig({ artistFolder: "{artistName} {mbid-{artistMbId}}" });

  const shouldReapply = artistPathsModule.shouldReapplyArtistPathTemplate({
    artistId: 4526830,
    artistName: "Bastille",
    artistMbId: "artist-mbid-1",
    existingPath: "Bastille {mbid-artist-mbid-1} (4526830)",
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

test("upsertLibraryFile stores canonical MusicBrainz and provider identity for imported tracks", () => {
  dbModule.db.prepare(`
    INSERT INTO mb_artists (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");
  dbModule.db.prepare(`
    INSERT INTO mb_release_groups (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album");
  dbModule.db.prepare(`
    INSERT INTO mb_releases (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", 1);
  dbModule.db.prepare(`
    INSERT INTO mb_recordings (mbid, title)
    VALUES (?, ?)
  `).run("recording-mbid-1", "Bohemian Rhapsody");
  dbModule.db.prepare(`
    INSERT INTO mb_tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Bohemian Rhapsody");

  dbModule.db.prepare(`
    INSERT INTO artists (id, name, mbid, path, monitor)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, "Queen", "artist-mbid-1", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1, "release-mbid-1", "rg-mbid-1");
  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor, mbid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(100, 1, 10, "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1, "track-mbid-1");

  const filePath = path.join(configModule.Config.getMusicPath(), "Queen", "01 - Bohemian Rhapsody.flac");
  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath,
    libraryRoot: configModule.Config.getMusicPath(),
    fileType: "track",
    quality: "LOSSLESS",
  });

  const row = dbModule.db.prepare(`
    SELECT
      canonical_artist_mbid,
      canonical_release_group_mbid,
      canonical_release_mbid,
      canonical_track_mbid,
      canonical_recording_mbid,
      provider,
      provider_entity_type,
      provider_id,
      library_slot
    FROM library_files
    WHERE id = ?
  `).get(id) as Record<string, string | null>;

  assert.deepEqual(row, {
    canonical_artist_mbid: "artist-mbid-1",
    canonical_release_group_mbid: "rg-mbid-1",
    canonical_release_mbid: "release-mbid-1",
    canonical_track_mbid: "track-mbid-1",
    canonical_recording_mbid: "recording-mbid-1",
    provider: "tidal",
    provider_entity_type: "track",
    provider_id: "100",
    library_slot: "stereo",
  });

  const stats = downloadStateModule.getReleaseGroupDownloadStatsMap(["rg-mbid-1"]).get("rg-mbid-1");
  assert.equal(stats?.totalTracks, 1);
  assert.equal(stats?.downloadedTracks, 1);
  assert.equal(stats?.isDownloaded, true);
});

test("upsertLibraryFile merges duplicate path and media identity rows during rescan", () => {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Queen", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 2, 1, 0, 3551, 1);
  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    100, 1, 10, "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1,
    101, 1, 10, "Love of My Life", 2, 1, 0, "Track", "LOSSLESS", 219, 1,
  );

  const root = configModule.Config.getMusicPath();
  const targetPath = path.join(root, "Queen", "01 - Bohemian Rhapsody.flac");
  const stalePath = path.join(root, "Queen", "old.flac");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "audio");
  fs.writeFileSync(stalePath, "audio");

  dbModule.db.prepare(`
    INSERT INTO library_files (
      artist_id, album_id, media_id, file_path, relative_path, library_root,
      filename, extension, file_size, file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 10, 101, targetPath, path.relative(root, targetPath), root, path.basename(targetPath), "flac", 5, "track", "LOSSLESS",
    1, 10, 100, stalePath, path.relative(root, stalePath), root, path.basename(stalePath), "flac", 5, "track", "LOSSLESS",
  );

  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: "100",
    filePath: targetPath,
    libraryRoot: root,
    fileType: "track",
    quality: "LOSSLESS",
  });

  const rows = dbModule.db.prepare(`
    SELECT id, media_id, file_path
    FROM library_files
    ORDER BY id
  `).all() as Array<{ id: number; media_id: number; file_path: string }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.media_id, 100);
  assert.equal(rows[0]?.file_path, targetPath);
});

test("upsertLibraryFile merges duplicate path and tracked asset identity rows during rescan", () => {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, path, monitor)
    VALUES (?, ?, ?, ?)
  `).run(1, "Queen", "Queen", 1);
  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    10, 1, "A Night at the Opera", "1975-11-21", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1,
    11, 1, "Sheer Heart Attack", "1974-11-08", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1,
  );

  const root = configModule.Config.getMusicPath();
  const targetPath = path.join(root, "Queen", "A Night at the Opera", "cover.jpg");
  const stalePath = path.join(root, "Queen", "old-cover.jpg");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "cover");
  fs.writeFileSync(stalePath, "cover");

  dbModule.db.prepare(`
    INSERT INTO library_files (
      artist_id, album_id, media_id, file_path, relative_path, library_root,
      filename, extension, file_size, file_type, quality
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL), (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    1, 11, targetPath, path.relative(root, targetPath), root, path.basename(targetPath), "jpg", 5, "cover",
    1, 10, stalePath, path.relative(root, stalePath), root, path.basename(stalePath), "jpg", 5, "cover",
  );

  const id = libraryFilesModule.LibraryFilesService.upsertLibraryFile({
    artistId: "1",
    albumId: "10",
    mediaId: null,
    filePath: targetPath,
    libraryRoot: root,
    fileType: "cover",
    quality: null,
  });

  const rows = dbModule.db.prepare(`
    SELECT id, album_id, file_type, file_path
    FROM library_files
    ORDER BY id
  `).all() as Array<{ id: number; album_id: number; file_type: string; file_path: string }>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, id);
  assert.equal(rows[0]?.album_id, 10);
  assert.equal(rows[0]?.file_type, "cover");
  assert.equal(rows[0]?.file_path, targetPath);
});
