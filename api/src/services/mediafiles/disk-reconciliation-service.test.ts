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
  healthModule = await import("../commands/health.js");
});

beforeEach(() => {
  pathUtils.clearCaseSensitivityCache();
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
  for (const dir of [musicDir, spatialDir]) {
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
  albumTitle?: string;
  editionTitle?: string;
  editionDisambiguation?: string | null;
}) {
  const artistId = params.artistId ?? 1;
  const albumId = params.albumId ?? 10;
  const editionId = params.editionId ?? 100;
  const recordingId = params.recordingId ?? 1000;
  const trackId = params.trackId ?? 10000;

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
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'Test Track')
  `).run(trackId, `trk-mbid-${trackId}`, editionId, `rel-mbid-${editionId}`, recordingId, `rec-mbid-${recordingId}`);
}

test("reconcileDiskAndDatabase adds untracked audio files on disk to UnmappedFiles in batches", async () => {
  const artistDir = path.join(musicDir, "Bastille");
  fs.mkdirSync(artistDir, { recursive: true });
  const untrackedA = path.join(artistDir, "01 - Pompeii.flac");
  const untrackedB = path.join(artistDir, "02 - Laura Palmer.flac");
  const sidecar = path.join(artistDir, "cover.jpg");
  fs.writeFileSync(untrackedA, "audio-a");
  fs.writeFileSync(untrackedB, "audio-b");
  fs.writeFileSync(sidecar, "image");

  const snapshot = await reconcileService.reconcileDiskAndDatabase({ batchSize: 1 });

  assert.equal(snapshot.diskAudioFiles, 2);
  assert.equal(snapshot.trackFiles, 0);
  assert.equal(snapshot.unmapped, 2);
  assert.equal(snapshot.untrackedAdded, 2);
  assert.equal(snapshot.missing, 0);
  assert.equal(snapshot.misplaced, 0);

  const rows = database.db.prepare("SELECT file_path, library_root, ignored FROM UnmappedFiles ORDER BY file_path").all() as Array<{
    file_path: string;
    library_root: string;
    ignored: number;
  }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].library_root, "music");
  assert.equal(rows[0].ignored, 0);

  const health = healthModule.collectHealthDiagnosticsSnapshot();
  assert.equal(health.reconciliation?.unmapped, 2);
  assert.equal(health.reconciliation?.diskAudioFiles, 2);
  const issue = health.issues.find((i) => i.scope === "library.reconciliation");
  assert.ok(issue);
  assert.equal(issue.status, "warning");
});

test("reconcileDiskAndDatabase deletes missing TrackFiles rows so tracks become wanted again", async () => {
  seedAlbumAndTrack({});
  const missingPath = path.join(musicDir, "Bastille", "Bad Blood", "01 - Pompeii.flac");

  database.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (1, 10, 100, 10000, 1000, ?, 'Bastille/Bad Blood/01 - Pompeii.flac', 'music', '01 - Pompeii.flac', 'flac', 'track', 'LOSSLESS')
  `).run(missingPath);

  const snapshot = await reconcileService.reconcileDiskAndDatabase();

  assert.equal(snapshot.missing, 1);
  assert.equal(snapshot.trackFiles, 0);
  assert.equal(snapshot.unmapped, 0);
  assert.equal((database.db.prepare("SELECT COUNT(*) AS c FROM TrackFiles").get() as { c: number }).c, 0);

  const history = database.db.prepare("SELECT event_type, source_title FROM history_events").all() as Array<{
    event_type: number;
    source_title: string;
  }>;
  assert.equal(history.length, 1);
  assert.equal(history[0].source_title, "01 - Pompeii.flac");

  const health = healthModule.collectHealthDiagnosticsSnapshot();
  assert.equal(health.reconciliation?.missing, 1);
  assert.ok(health.issues.some((i) => i.scope === "library.reconciliation"));
});

test("reconcileDiskAndDatabase ignores case-only path differences on case-insensitive roots", async () => {
  pathUtils.setCaseSensitivityOverride(musicDir, true);

  const actualDir = path.join(musicDir, "Bastille");
  fs.mkdirSync(actualDir, { recursive: true });
  const actualFile = path.join(actualDir, "01 - Pompeii.flac");
  fs.writeFileSync(actualFile, "audio");

  const dbCaseVariant = path.join(musicDir, "bastille", "01 - pompeii.flac");
  database.db.prepare(`
    INSERT INTO ExtraFiles (
      artist_id, file_path, relative_path, library_root, extension, file_type
    ) VALUES ('artist-mbid-1', ?, 'bastille/01 - pompeii.flac', 'music', 'flac', 'audio')
  `).run(dbCaseVariant);

  const snapshot = await reconcileService.reconcileDiskAndDatabase();
  assert.equal(snapshot.diskAudioFiles, 1);
  assert.equal(snapshot.unmapped, 0);
  assert.equal(snapshot.untrackedAdded, 0);
  assert.equal(snapshot.missing, 0);
  assert.equal(snapshot.misplaced, 0);

  const health = healthModule.collectHealthDiagnosticsSnapshot();
  assert.equal(health.reconciliation?.unmapped, 0);
  assert.equal(health.issues.some((i) => i.scope === "library.reconciliation"), false);
});

test("placement rule enforces stereo vs Atmos placement both ways", async () => {
  // 1. Atmos file in stereo library: allowed only when it is the only version of the track.
  assert.equal(
    reconcileService.isTrackFilePlacementValid({
      filePath: path.join(musicDir, "Artist", "Track.m4a"),
      quality: "DOLBY_ATMOS",
      stereoRoot: musicDir,
      atmosRoot: spatialDir,
      recordingFileCount: 1,
      recordingHasAtmosVersion: true,
      albumIsAtmos: true,
    }),
    true,
  );
  assert.equal(
    reconcileService.isTrackFilePlacementValid({
      filePath: path.join(musicDir, "Artist", "Track.m4a"),
      quality: "DOLBY_ATMOS",
      stereoRoot: musicDir,
      atmosRoot: spatialDir,
      recordingFileCount: 2,
      recordingHasAtmosVersion: true,
      albumIsAtmos: true,
    }),
    false,
  );

  // 2. Stereo file in Atmos library: allowed only when album is Atmos and track has no Atmos version.
  assert.equal(
    reconcileService.isTrackFilePlacementValid({
      filePath: path.join(spatialDir, "Artist", "Track.flac"),
      quality: "LOSSLESS",
      stereoRoot: musicDir,
      atmosRoot: spatialDir,
      recordingFileCount: 1,
      recordingHasAtmosVersion: false,
      albumIsAtmos: true,
    }),
    true,
  );
  assert.equal(
    reconcileService.isTrackFilePlacementValid({
      filePath: path.join(spatialDir, "Artist", "Track.flac"),
      quality: "LOSSLESS",
      stereoRoot: musicDir,
      atmosRoot: spatialDir,
      recordingFileCount: 1,
      recordingHasAtmosVersion: false,
      albumIsAtmos: false,
    }),
    false,
  );
  assert.equal(
    reconcileService.isTrackFilePlacementValid({
      filePath: path.join(spatialDir, "Artist", "Track.flac"),
      quality: "LOSSLESS",
      stereoRoot: musicDir,
      atmosRoot: spatialDir,
      recordingFileCount: 2,
      recordingHasAtmosVersion: true,
      albumIsAtmos: true,
    }),
    false,
  );

  // End-to-end DB check: stereo file in Atmos root on a non-Atmos album -> misplaced = 1
  seedAlbumAndTrack({ albumId: 20, editionId: 200, recordingId: 2000, trackId: 20000 });
  const misplacedDir = path.join(spatialDir, "Artist");
  fs.mkdirSync(misplacedDir, { recursive: true });
  const misplacedPath = path.join(misplacedDir, "01 - Stereo In Atmos.flac");
  fs.writeFileSync(misplacedPath, "audio");

  database.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, quality
    ) VALUES (1, 20, 200, 20000, 2000, ?, 'Artist/01 - Stereo In Atmos.flac', 'spatial', '01 - Stereo In Atmos.flac', 'flac', 'track', 'LOSSLESS')
  `).run(misplacedPath);

  const snapshot = await reconcileService.reconcileDiskAndDatabase();
  assert.equal(snapshot.misplaced, 1);

  const health = healthModule.collectHealthDiagnosticsSnapshot();
  assert.equal(health.reconciliation?.misplaced, 1);
  assert.ok(health.issues.some((i) => i.scope === "library.reconciliation"));
});
