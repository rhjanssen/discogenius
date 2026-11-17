import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("housekeeping-stray-files");
const { db, dbModule } = await openActiveSchemaDb();
const { Config } = await import("../config/config.js");
const {
  evaluateTrackFilePlacement,
  runHousekeepingStrayAndPlacement,
  runHousekeepingStrayAndPlacementWithReport,
} = await import("./housekeeping-stray-files.js");
const destructiveSetting = await import("./destructive-cleanup-setting.js");
const pathUtils = await import("./path-utils.js");

const stereoRoot = path.join(tempDir, "music");
const atmosRoot = path.join(tempDir, "atmos");
const videoRoot = path.join(tempDir, "videos");

const origMusicPath = Config.getMusicPath;
const origSpatialPath = Config.getSpatialPath;
const origVideoPath = Config.getVideoPath;

Config.getMusicPath = () => stereoRoot;
Config.getSpatialPath = () => atmosRoot;
Config.getVideoPath = () => videoRoot;

after(() => {
  Config.getMusicPath = origMusicPath;
  Config.getSpatialPath = origSpatialPath;
  Config.getVideoPath = origVideoPath;
  closeActiveSchemaDb(dbModule, tempDir);
});

function setupRootsAndDb(): void {
  pathUtils.clearCaseSensitivityCache();
  destructiveSetting.setDestructiveCleanupEnabled(false);

  fs.rmSync(stereoRoot, { recursive: true, force: true });
  fs.rmSync(atmosRoot, { recursive: true, force: true });
  fs.rmSync(videoRoot, { recursive: true, force: true });
  fs.mkdirSync(stereoRoot, { recursive: true });
  fs.mkdirSync(atmosRoot, { recursive: true });
  fs.mkdirSync(videoRoot, { recursive: true });

  resetActiveSchemaRows(db, ["history_events", "commands", "UnmappedFiles", "TrackFiles", "Libraries", "MetadataProfiles", "quality_profiles", "runtime_controls"]);
  db.prepare(`
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (1, 'High', '["lossless"]', '["lossless"]', 'lossless', 0, 'none', '{}', 'preserve')
  `).run();
  db.prepare(`INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled) VALUES (1, 'Stereo', ?, 1, 1, 1)`).run(stereoRoot);
  db.prepare(`INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled) VALUES (2, 'Atmos', ?, 1, 1, 1)`).run(atmosRoot);
  db.prepare(`INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'art-1', 'Artist One')`).run();
  db.prepare(`INSERT INTO Albums (id, mbid, artist_mbid, title) VALUES (1, 'rg-1', 'art-1', 'Album One')`).run();
  db.prepare(`INSERT INTO Albums (id, mbid, artist_mbid, title) VALUES (2, 'rg-2', 'art-1', 'Atmos Album')`).run();
  db.prepare(`INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title) VALUES (10, 'rel-10', 1, 'rg-1', 'art-1', 'Album One')`).run();
  db.prepare(`INSERT INTO AlbumEditions (id, mbid, release_group_id, release_group_mbid, artist_mbid, title, disambiguation) VALUES (20, 'rel-20', 2, 'rg-2', 'art-1', 'Atmos Album', 'Dolby Atmos')`).run();
  db.prepare(`INSERT INTO Recordings (id, mbid, title) VALUES (100, 'rec-100', 'Track 1')`).run();
  db.prepare(`INSERT INTO Recordings (id, mbid, title) VALUES (101, 'rec-101', 'Track 2')`).run();
  db.prepare(`INSERT INTO Recordings (id, mbid, title) VALUES (102, 'rec-102', 'Interlude')`).run();
  db.prepare(`INSERT INTO Recordings (id, mbid, title) VALUES (103, 'rec-103', 'Only Atmos')`).run();
  db.prepare(`INSERT INTO Tracks (id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, title, position, medium_position) VALUES (1000, 'trk-1000', 10, 'rel-10', 100, 'rec-100', 'Track 1', 1, 1)`).run();
  db.prepare(`INSERT INTO Tracks (id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, title, position, medium_position) VALUES (1001, 'trk-1001', 10, 'rel-10', 101, 'rec-101', 'Track 2', 2, 1)`).run();
  db.prepare(`INSERT INTO Tracks (id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, title, position, medium_position) VALUES (1002, 'trk-1002', 20, 'rel-20', 102, 'rec-102', 'Interlude', 1, 1)`).run();
  db.prepare(`INSERT INTO Tracks (id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid, title, position, medium_position) VALUES (1003, 'trk-1003', 20, 'rel-20', 103, 'rec-103', 'Only Atmos', 2, 1)`).run();
}

test("dry-run mode lists what would be deleted or moved without modifying disk or DB", async () => {
  setupRootsAndDb();

  const albumDir = path.join(stereoRoot, "Artist One", "Album One");
  fs.mkdirSync(albumDir, { recursive: true });

  const orphanLrc = path.join(albumDir, "09 - Ghost.lrc");
  fs.writeFileSync(orphanLrc, "[00:01.00] Ghost lyrics");

  const unownedAudio = path.join(albumDir, "10 - Stray.flac");
  fs.writeFileSync(unownedAudio, "unowned audio bytes");

  // Default mode (destructive disabled)
  const report = await runHousekeepingStrayAndPlacementWithReport({ runUnmappedRecheck: false });
  assert.ok(report.actions.some((a) => a.action === "delete_file" && a.path === orphanLrc));
  assert.ok(report.actions.some((a) => a.action === "delete_file" && a.path === unownedAudio));

  // Files must NOT have been deleted
  assert.equal(fs.existsSync(orphanLrc), true, "dry-run must not delete orphan lyrics");
  assert.equal(fs.existsSync(unownedAudio), true, "dry-run must not delete unowned audio");
  assert.equal(report.summary.orphanLyricsRemoved, 0);
  assert.equal(report.summary.unownedAudioRemoved, 0);
});

test("destructive mode cleans orphan lyrics, aged temp files, empty folders, and unowned audio", async () => {
  setupRootsAndDb();
  destructiveSetting.setDestructiveCleanupEnabled(true);

  const albumDir = path.join(stereoRoot, "Artist One", "Album One");
  fs.mkdirSync(albumDir, { recursive: true });

  const trackedAudio = path.join(albumDir, "01 - Track 1.flac");
  fs.writeFileSync(trackedAudio, "audio-bytes");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (1, 1, 1, ?, 1, 10, 1000, 100, ?, 'Artist One/Album One/01 - Track 1.flac', '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, trackedAudio);

  const matchedLrc = path.join(albumDir, "01 - Track 1.lrc");
  fs.writeFileSync(matchedLrc, "[00:01.00] valid");

  const orphanLrc = path.join(albumDir, "99 - Orphan.lrc");
  fs.writeFileSync(orphanLrc, "[00:01.00] orphan");

  const agedTemp = path.join(albumDir, "temp.part");
  fs.writeFileSync(agedTemp, "part-bytes");
  const oldTime = (Date.now() - 7200000) / 1000;
  fs.utimesSync(agedTemp, oldTime, oldTime);

  const unownedAudio = path.join(albumDir, "99 - Stray.flac");
  fs.writeFileSync(unownedAudio, "stray-audio");

  const emptyDir = path.join(stereoRoot, "EmptyArtist", "EmptyAlbum");
  fs.mkdirSync(emptyDir, { recursive: true });

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });

  assert.equal(summary.orphanLyricsRemoved, 1);
  assert.equal(summary.tempFilesRemoved, 1);
  assert.equal(summary.emptyFoldersRemoved, 2);
  assert.equal(summary.unownedAudioRemoved, 1);

  assert.equal(fs.existsSync(trackedAudio), true, "Tracked audio must survive");
  assert.equal(fs.existsSync(matchedLrc), true, "Matching lyric must survive");
  assert.equal(fs.existsSync(orphanLrc), false, "Orphan lyric must be deleted");
  assert.equal(fs.existsSync(agedTemp), false, "Aged temp file must be deleted");
  assert.equal(fs.existsSync(unownedAudio), false, "Unowned audio must be deleted");
  assert.equal(fs.existsSync(emptyDir), false, "Empty directories must be deleted");
});

test("A stale stored root (row with an old library_root and a correct relative_path) is neither deleted nor treated as unowned", async () => {
  setupRootsAndDb();
  destructiveSetting.setDestructiveCleanupEnabled(true);

  // File exists in current stereoRoot
  const actualPath = path.join(stereoRoot, "Artist One", "Album One", "01 - Track 1.flac");
  fs.mkdirSync(path.dirname(actualPath), { recursive: true });
  fs.writeFileSync(actualPath, "audio-bytes");

  // DB row points to a stale old root
  const stalePath = "/old/storage/Artist One/Album One/01 - Track 1.flac";
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (1, 1, 1, 'music', 1, 10, 1000, 100, ?, 'Artist One/Album One/01 - Track 1.flac', '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(stalePath);

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });

  assert.equal(summary.unownedAudioRemoved, 0, "Stale stored root file must NOT be deleted as unowned");
  assert.equal(fs.existsSync(actualPath), true, "File on disk must survive");
});

test("Two linked files that differ only in case both survive", async () => {
  setupRootsAndDb();
  destructiveSetting.setDestructiveCleanupEnabled(true);
  pathUtils.setCaseSensitivityOverride(stereoRoot, false); // case-sensitive root (ext4)

  const dir = path.join(stereoRoot, "Artist One", "Album One");
  fs.mkdirSync(dir, { recursive: true });

  const upperFile = path.join(dir, "Track.flac");
  const lowerFile = path.join(dir, "track.flac");
  fs.writeFileSync(upperFile, "audio-upper");
  fs.writeFileSync(lowerFile, "audio-lower");

  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (1, 1, 1, ?, 1, 10, 1000, 100, ?, 'Artist One/Album One/Track.flac', 'Track.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, upperFile);

  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (2, 1, 1, ?, 1, 10, 1001, 101, ?, 'Artist One/Album One/track.flac', 'track.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, lowerFile);

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });

  assert.equal(summary.unownedAudioRemoved, 0, "Neither file should be treated as unowned");
  assert.equal(fs.existsSync(upperFile), true, "Upper case file must survive");
  assert.equal(fs.existsSync(lowerFile), true, "Lower case file must survive");
  assert.ok(db.prepare("SELECT 1 FROM TrackFiles WHERE id = 1").get());
  assert.ok(db.prepare("SELECT 1 FROM TrackFiles WHERE id = 2").get());
});

test("An NFD file name with an NFC DB path survives", async () => {
  setupRootsAndDb();
  destructiveSetting.setDestructiveCleanupEnabled(true);

  const dir = path.join(stereoRoot, "Artist One", "Album One");
  fs.mkdirSync(dir, { recursive: true });

  // On disk: NFD
  const nfdPath = path.join(dir, "track_\u0065\u0301.flac");
  fs.writeFileSync(nfdPath, "nfd-bytes");

  // In DB: NFC
  const nfcPath = path.join(dir, "track_\u00e9.flac");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (1, 1, 1, ?, 1, 10, 1000, 100, ?, 'Artist One/Album One/track_\u00e9.flac', 'track_\u00e9.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, nfcPath);

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });

  assert.equal(summary.unownedAudioRemoved, 0, "NFD file on disk matching NFC DB path must NOT be deleted as unowned");
  assert.equal(fs.existsSync(nfdPath), true, "File on disk must survive");
  assert.ok(db.prepare("SELECT 1 FROM TrackFiles WHERE id = 1").get(), "DB row must survive");
});

test("Placement never deletes the only copy for an edition", async () => {
  setupRootsAndDb();
  destructiveSetting.setDestructiveCleanupEnabled(true);

  // Misplaced stereo file in Atmos for a non-Atmos album:
  // It is the ONLY copy for album edition 10, track 1000.
  const misplacedPath = path.join(atmosRoot, "Artist One", "Album One", "01 - Track 1.flac");
  fs.mkdirSync(path.dirname(misplacedPath), { recursive: true });
  fs.writeFileSync(misplacedPath, "stereo-audio");

  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (10, 1, 2, ?, 1, 10, 1000, 100, ?, 'Artist One/Album One/01 - Track 1.flac', '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(atmosRoot, misplacedPath);

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });

  // It should be moved, NEVER deleted
  assert.equal(summary.misplacedDeleted, 0, "Placement must NEVER delete the only copy for an edition");
  assert.equal(summary.misplacedMoved, 1, "Placement moves misplaced file to stereo");

  const destPath = path.join(stereoRoot, "Artist One", "Album One", "01 - Track 1.flac");
  assert.equal(fs.existsSync(destPath), true, "File moved to destination");
  assert.ok(db.prepare("SELECT 1 FROM TrackFiles WHERE id = 10").get(), "TrackFiles row must survive");
});

test("The move never overwrites an existing destination", async () => {
  setupRootsAndDb();
  destructiveSetting.setDestructiveCleanupEnabled(true);

  // Misplaced file in Atmos root:
  const sourceRel = path.join("Artist One", "Album One", "01 - Track 1.flac");
  const sourcePath = path.join(atmosRoot, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "source-content");

  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (10, 1, 2, ?, 1, 10, 1000, 100, ?, ?, '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(atmosRoot, sourcePath, sourceRel.replace(/\\/g, "/"));

  // Destination path in stereoRoot is ALREADY occupied by another tracked file:
  const destPath = path.join(stereoRoot, sourceRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, "original-destination-content");

  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (11, 1, 1, ?, 1, 10, 1001, 101, ?, ?, '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, destPath, sourceRel.replace(/\\/g, "/"));

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });

  // Move must be aborted: neither overwritten nor deleted
  assert.equal(summary.misplacedMoved, 0, "Must not move onto an occupied path");
  assert.equal(summary.misplacedDeleted, 0, "Must not delete source when destination is occupied");

  // Destination file remains completely unchanged:
  assert.equal(fs.readFileSync(destPath, "utf-8"), "original-destination-content", "Destination file must not be overwritten");
  // Source file remains intact:
  assert.equal(fs.readFileSync(sourcePath, "utf-8"), "source-content", "Source file must remain untouched");
  assert.ok(db.prepare("SELECT 1 FROM TrackFiles WHERE id = 10").get(), "Source DB row must remain intact");
});

test("product rule: An Atmos file may sit in the stereo library only if it is literally the only version", () => {
  // Only version -> allowed
  assert.equal(
    evaluateTrackFilePlacement({
      file: { file_path: path.join(stereoRoot, "Artist", "Track.m4a"), quality: "DOLBY_ATMOS", recording_id: 100, release_group_id: 1 },
      stereoRoot,
      atmosRoot,
      recordingFileCount: 1,
      recordingHasAtmosVersion: true,
      albumIsAtmos: false,
    }).allowed,
    true,
  );

  // Another version exists -> NOT allowed (misplaced)
  assert.equal(
    evaluateTrackFilePlacement({
      file: { file_path: path.join(stereoRoot, "Artist", "Track.m4a"), quality: "DOLBY_ATMOS", recording_id: 100, release_group_id: 1 },
      stereoRoot,
      atmosRoot,
      recordingFileCount: 2,
      recordingHasAtmosVersion: true,
      albumIsAtmos: false,
    }).allowed,
    false,
  );
});

test("product rule: A stereo track may sit in the Atmos library if its album is Atmos", () => {
  // Album is Atmos -> allowed
  assert.equal(
    evaluateTrackFilePlacement({
      file: { file_path: path.join(atmosRoot, "Artist", "Interlude.flac"), quality: "FLAC", recording_id: 102, release_group_id: 2 },
      stereoRoot,
      atmosRoot,
      recordingFileCount: 1,
      recordingHasAtmosVersion: false,
      albumIsAtmos: true,
    }).allowed,
    true,
  );

  // Album is NOT Atmos -> NOT allowed (misplaced)
  assert.equal(
    evaluateTrackFilePlacement({
      file: { file_path: path.join(atmosRoot, "Artist", "Track.flac"), quality: "FLAC", recording_id: 100, release_group_id: 1 },
      stereoRoot,
      atmosRoot,
      recordingFileCount: 1,
      recordingHasAtmosVersion: false,
      albumIsAtmos: false,
    }).allowed,
    false,
  );
});
