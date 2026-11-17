import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-reconcile-"));
const configDir = path.join(tempRoot, "config");
const musicDir = path.join(tempRoot, "music");
const spatialDir = path.join(tempRoot, "spatial");
const videoDir = path.join(tempRoot, "video");
const downloadDir = path.join(tempRoot, "downloads");

fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(musicDir, { recursive: true });
fs.mkdirSync(spatialDir, { recursive: true });
fs.mkdirSync(videoDir, { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });

process.env.DB_PATH = path.join(tempRoot, "active.db");
process.env.DISCOGENIUS_CONFIG_DIR = configDir;
process.env.DISCOGENIUS_DISABLE_DOWNLOADS = "1";

let database: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let pathUtils: typeof import("./path-utils.js");
let reconcileService: typeof import("./disk-reconciliation-service.js");
let destructiveSetting: typeof import("./destructive-cleanup-setting.js");
let healthModule: typeof import("../commands/health.js");

before(async () => {
  database = await import("../../database.js");
  database.initDatabase();
  configModule = await import("../config/config.js");
  configModule.updateConfig("path", {
    music_path: musicDir,
    spatial_path: spatialDir,
    video_path: videoDir,
  });
  pathUtils = await import("./path-utils.js");
  reconcileService = await import("./disk-reconciliation-service.js");
  destructiveSetting = await import("./destructive-cleanup-setting.js");
  healthModule = await import("../commands/health.js");
});

beforeEach(async () => {
  pathUtils.clearCaseSensitivityCache();
  destructiveSetting.setDestructiveCleanupOverride(null);
  await destructiveSetting.setDestructiveCleanupEnabled(false);
  database.db.prepare("DELETE FROM TrackFiles").run();
  database.db.prepare("DELETE FROM ExtraFiles").run();
  database.db.prepare("DELETE FROM UnmappedFiles").run();
  database.db.prepare("DELETE FROM Tracks").run();
  database.db.prepare("DELETE FROM Recordings").run();
  database.db.prepare("DELETE FROM AlbumEditions").run();
  database.db.prepare("DELETE FROM Albums").run();
  database.db.prepare("DELETE FROM ArtistMetadata").run();
  database.db.prepare("DELETE FROM history_events").run();
  database.db.prepare("DELETE FROM runtime_controls").run();
  try {
    database.db.prepare("DELETE FROM ReconciliationMissingFiles").run();
  } catch {
    // table might not exist before first run
  }
  for (const dir of [musicDir, spatialDir, videoDir]) {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
});

after(() => {
  pathUtils.clearCaseSensitivityCache();
  database.closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedAlbumAndTrack(params: {
  artistId?: number;
  albumId?: number;
  editionId?: number;
  recordingId?: number;
  trackId?: number;
  position?: number;
  albumTitle?: string;
  editionTitle?: string;
  editionDisambiguation?: string | null;
}) {
  const artistId = params.artistId ?? 1;
  const albumId = params.albumId ?? 10;
  const editionId = params.editionId ?? 100;
  const recordingId = params.recordingId ?? 1000;
  const trackId = params.trackId ?? 10000;
  const position = params.position ?? 1;

  database.db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (id, mbid, name) VALUES (?, ?, 'Test Artist')
  `).run(artistId, `artist-mbid-${artistId}`);
  database.db.prepare(`
    INSERT OR IGNORE INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
    VALUES (?, ?, ?, ?, ?)
  `).run(albumId, `rg-mbid-${albumId}`, artistId, `artist-mbid-${artistId}`, params.albumTitle ?? "Test Album");
  database.db.prepare(`
    INSERT OR IGNORE INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title, disambiguation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    editionId,
    `rel-mbid-${editionId}`,
    albumId,
    `rg-mbid-${albumId}`,
    artistId,
    `artist-mbid-${artistId}`,
    params.editionTitle ?? "Test Album",
    params.editionDisambiguation ?? null,
  );
  database.db.prepare(`
    INSERT OR IGNORE INTO Recordings (id, mbid, title) VALUES (?, ?, 'Test Track')
  `).run(recordingId, `rec-mbid-${recordingId}`);
  database.db.prepare(`
    INSERT OR IGNORE INTO Tracks (id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'Test Track')
  `).run(trackId, `trk-mbid-${trackId}`, editionId, `rel-mbid-${editionId}`, recordingId, `rec-mbid-${recordingId}`, position);
}

test("destructive mode defaults to off and can be toggled", async () => {
  assert.equal(destructiveSetting.isDestructiveCleanupEnabled(), false);
  await destructiveSetting.setDestructiveCleanupEnabled(true);
  assert.equal(destructiveSetting.isDestructiveCleanupEnabled(), true);
  await destructiveSetting.setDestructiveCleanupEnabled(false);
  assert.equal(destructiveSetting.isDestructiveCleanupEnabled(), false);
});

test("reconciliation discovers untracked audio files and dryRun reports actions without mutating", async () => {
  const artistDir = path.join(musicDir, "Bastille");
  fs.mkdirSync(artistDir, { recursive: true });
  const untrackedFile = path.join(artistDir, "01 - Pompeii.flac");
  fs.writeFileSync(untrackedFile, "audio-bytes");

  // Run dry run
  const result = await reconcileService.reconcileDiskAndDatabaseWithReport({ dryRun: true });
  assert.equal(result.snapshot.diskAudioFiles, 1);
  assert.equal(result.snapshot.untrackedAdded, 0, "dryRun should not insert into UnmappedFiles");
  assert.ok(result.actions.some((a) => a.action === "mark_missing" && a.path === untrackedFile));

  // Run in destructive mode: adds to UnmappedFiles
  await destructiveSetting.setDestructiveCleanupEnabled(true);
  const realSnapshot = await reconcileService.reconcileDiskAndDatabase();
  assert.equal(realSnapshot.untrackedAdded, 1);
  assert.equal(realSnapshot.unmapped, 1);
});

test("reconciliation marks missing files first and only deletes on subsequent run when destructive mode is on", async () => {
  seedAlbumAndTrack({ albumId: 10, editionId: 100, recordingId: 1000, trackId: 10000 });
  const missingPath = path.join(musicDir, "Artist", "Album", "missing.flac");

  database.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (42, 1, 10, 100, 10000, 1000, ?, 'Artist/Album/missing.flac', 'music', 'missing.flac', 'flac', 'track', 'FLAC')
  `).run(missingPath);

  // Run 1: file is missing from disk. Even with destructive mode enabled, it must ONLY mark it, NOT delete!
  await destructiveSetting.setDestructiveCleanupEnabled(true);
  const snap1 = await reconcileService.reconcileDiskAndDatabase();
  assert.equal(snap1.missing, 1);
  const rowAfterRun1 = database.db.prepare(`SELECT id FROM TrackFiles WHERE id = 42`).get();
  assert.ok(rowAfterRun1, "TrackFiles row must NOT be deleted on the first run where it goes missing");

  // Check it was marked in ReconciliationMissingFiles
  const mark = database.db.prepare(`SELECT track_file_id FROM ReconciliationMissingFiles WHERE track_file_id = 42`).get() as { track_file_id: number };
  assert.equal(mark?.track_file_id, 42);

  // Run 2 in dry-run mode: should still NOT delete
  const dryResult = await reconcileService.reconcileDiskAndDatabaseWithReport({ dryRun: true });
  assert.ok(dryResult.actions.some((a) => a.action === "delete_track_file_row" && a.path === missingPath));
  assert.ok(database.db.prepare(`SELECT id FROM TrackFiles WHERE id = 42`).get(), "Dry run must not delete");

  // Run 3 with destructive mode enabled: row is now deleted on subsequent run
  const snap3 = await reconcileService.reconcileDiskAndDatabase();
  assert.equal(snap3.missing, 1);
  assert.equal(database.db.prepare(`SELECT 1 FROM TrackFiles WHERE id = 42`).get(), undefined, "Row deleted on subsequent run");
});

test("reconciliation restores a missing file marker if the file reappears on disk", async () => {
  seedAlbumAndTrack({ albumId: 10, editionId: 100, recordingId: 1000, trackId: 10000 });
  const trackPath = path.join(musicDir, "Artist", "reappearing.flac");

  database.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (99, 1, 10, 100, 10000, 1000, ?, 'Artist/reappearing.flac', 'music', 'reappearing.flac', 'flac', 'track', 'FLAC')
  `).run(trackPath);

  // Run 1: missing
  await reconcileService.reconcileDiskAndDatabase();
  assert.ok(database.db.prepare(`SELECT track_file_id FROM ReconciliationMissingFiles WHERE track_file_id = 99`).get());

  // Now create the file on disk
  fs.mkdirSync(path.dirname(trackPath), { recursive: true });
  fs.writeFileSync(trackPath, "audio");

  // Run 2: file is back!
  const snap2 = await reconcileService.reconcileDiskAndDatabase();
  assert.equal(snap2.missing, 0);
  assert.equal(database.db.prepare(`SELECT track_file_id FROM ReconciliationMissingFiles WHERE track_file_id = 99`).get(), undefined);
  assert.ok(database.db.prepare(`SELECT id FROM TrackFiles WHERE id = 99`).get(), "TrackFiles row preserved");
});

test("A stale stored root (row with an old library_root and a correct relative_path) is neither deleted nor treated as unowned", async () => {
  seedAlbumAndTrack({ albumId: 10, editionId: 100, recordingId: 1000, trackId: 10000 });

  // On disk, file is in the current musicDir:
  const actualPath = path.join(musicDir, "Artist", "Album", "track.flac");
  fs.mkdirSync(path.dirname(actualPath), { recursive: true });
  fs.writeFileSync(actualPath, "audio-bytes");

  // In DB, row has a stale old root path:
  const stalePath = "/old/unmounted/root/Artist/Album/track.flac";
  database.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (55, 1, 10, 100, 10000, 1000, ?, 'Artist/Album/track.flac', 'music', 'track.flac', 'flac', 'track', 'FLAC')
  `).run(stalePath);

  await destructiveSetting.setDestructiveCleanupEnabled(true);
  const snapshot = await reconcileService.reconcileDiskAndDatabase();

  assert.equal(snapshot.missing, 0, "Stale stored root must not be marked missing when relative_path exists");
  assert.equal(snapshot.untrackedAdded, 0, "File on disk must not be treated as untracked unmapped audio");

  // Row should have its file_path updated to actual on-disk path
  const updatedRow = database.db.prepare(`SELECT file_path FROM TrackFiles WHERE id = 55`).get() as { file_path: string };
  assert.equal(path.resolve(updatedRow.file_path), path.resolve(actualPath));
});

test("Two linked files that differ only in case both survive", async () => {
  seedAlbumAndTrack({ albumId: 10, editionId: 100, recordingId: 1000, trackId: 10000, position: 1 });
  seedAlbumAndTrack({ albumId: 10, editionId: 100, recordingId: 1001, trackId: 10001, position: 2 });

  pathUtils.setCaseSensitivityOverride(musicDir, false); // case-sensitive root (ext4)

  const dir = path.join(musicDir, "Artist");
  fs.mkdirSync(dir, { recursive: true });

  const upperFile = path.join(dir, "Track.flac");
  const lowerFile = path.join(dir, "track.flac");
  fs.writeFileSync(upperFile, "audio-upper");
  fs.writeFileSync(lowerFile, "audio-lower");

  database.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (101, 1, 10, 100, 10000, 1000, ?, 'Artist/Track.flac', 'music', 'Track.flac', 'flac', 'track', 'FLAC')
  `).run(upperFile);

  database.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (102, 1, 10, 100, 10001, 1001, ?, 'Artist/track.flac', 'music', 'track.flac', 'flac', 'track', 'FLAC')
  `).run(lowerFile);

  await destructiveSetting.setDestructiveCleanupEnabled(true);
  const snapshot = await reconcileService.reconcileDiskAndDatabase();

  assert.equal(snapshot.missing, 0, "Neither file should be missing");
  assert.equal(snapshot.untrackedAdded, 0, "Neither file should be untracked");
  assert.equal(snapshot.diskAudioFiles, 2);

  // Both DB rows survive
  assert.ok(database.db.prepare(`SELECT 1 FROM TrackFiles WHERE id = 101`).get());
  assert.ok(database.db.prepare(`SELECT 1 FROM TrackFiles WHERE id = 102`).get());

  // Both files on disk survive
  assert.equal(fs.existsSync(upperFile), true);
  assert.equal(fs.existsSync(lowerFile), true);
});

test("An NFD file name with an NFC DB path survives", async () => {
  seedAlbumAndTrack({ albumId: 10, editionId: 100, recordingId: 1000, trackId: 10000 });

  const dir = path.join(musicDir, "Beyonc\u0065\u0301"); // NFD on disk
  fs.mkdirSync(dir, { recursive: true });
  const nfdDiskPath = path.join(dir, "track_\u0065\u0301.flac"); // NFD on disk
  fs.writeFileSync(nfdDiskPath, "audio-bytes");

  // DB path has NFC:
  const nfcDbPath = path.join(musicDir, "Beyonc\u00e9", "track_\u00e9.flac"); // NFC in DB
  database.db.prepare(`
    INSERT INTO TrackFiles (
      id, artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (77, 1, 10, 100, 10000, 1000, ?, 'Beyonc\u00e9/track_\u00e9.flac', 'music', 'track_\u00e9.flac', 'flac', 'track', 'FLAC')
  `).run(nfcDbPath);

  await destructiveSetting.setDestructiveCleanupEnabled(true);
  const snapshot = await reconcileService.reconcileDiskAndDatabase();

  assert.equal(snapshot.missing, 0, "NFD file on disk must match NFC DB path and not be reported missing");
  assert.equal(snapshot.untrackedAdded, 0, "NFD file on disk must not be discovered as untracked unmapped audio");
  assert.ok(database.db.prepare(`SELECT 1 FROM TrackFiles WHERE id = 77`).get(), "TrackFiles row must survive");
  assert.equal(fs.existsSync(nfdDiskPath), true, "File on disk must survive");
});
