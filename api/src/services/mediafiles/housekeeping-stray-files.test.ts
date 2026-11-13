import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
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
} = await import("./housekeeping-stray-files.js");

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
  fs.rmSync(stereoRoot, { recursive: true, force: true });
  fs.rmSync(atmosRoot, { recursive: true, force: true });
  fs.rmSync(videoRoot, { recursive: true, force: true });
  fs.mkdirSync(stereoRoot, { recursive: true });
  fs.mkdirSync(atmosRoot, { recursive: true });
  fs.mkdirSync(videoRoot, { recursive: true });

  resetActiveSchemaRows(db, ["history_events", "commands", "UnmappedFiles", "TrackFiles", "Libraries", "MetadataProfiles", "quality_profiles"]);
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

test("housekeeping deletes orphan lyrics, aged temp covers, empty folders, and unowned audio while preserving tracked files", async () => {
  setupRootsAndDb();

  const albumDir = path.join(stereoRoot, "Artist One", "Album One");
  const emptyDir = path.join(stereoRoot, "Artist One", "Empty Album");
  fs.mkdirSync(albumDir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });

  // Tracked audio + matching lyric (MUST survive)
  const keptAudio = path.join(albumDir, "01 - Track 1.flac");
  const keptLyric = path.join(albumDir, "01 - Track 1.lrc");
  fs.writeFileSync(keptAudio, "flac-data");
  fs.writeFileSync(keptLyric, "[00:01] lyric");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (1, 1, 1, ?, 1, 10, 1000, 100, ?, 'Artist One/Album One/01 - Track 1.flac', '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, keptAudio);

  // Orphan lyric (MUST be deleted)
  const orphanLyric = path.join(albumDir, "02 - Missing Audio.lrc");
  fs.writeFileSync(orphanLyric, "[00:01] orphan");

  // Aged temp cover (MUST be deleted) and fresh temp cover (MUST survive)
  const agedTemp = path.join(albumDir, "cover.jpg.ce0344d7.tmp");
  const freshTemp = path.join(albumDir, "cover.jpg.fresh.tmp");
  fs.writeFileSync(agedTemp, "tmp");
  fs.writeFileSync(freshTemp, "tmp");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(agedTemp, twoHoursAgo, twoHoursAgo);

  // Unowned audio file (MUST be deleted)
  const unownedAudio = path.join(albumDir, "99 - Stray.flac");
  fs.writeFileSync(unownedAudio, "stray-audio");

  let rechecked = false;
  const summary = await runHousekeepingStrayAndPlacement({
    recheckUnmapped: async () => { rechecked = true; },
  });

  assert.equal(rechecked, true);
  assert.equal(summary.orphanLyricsRemoved, 1);
  assert.equal(summary.tempFilesRemoved, 1);
  assert.equal(summary.unownedAudioRemoved, 1);
  assert.equal(summary.emptyFoldersRemoved, 1);

  assert.equal(fs.existsSync(keptAudio), true);
  assert.equal(fs.existsSync(keptLyric), true);
  assert.equal(fs.existsSync(freshTemp), true);
  assert.equal(fs.existsSync(orphanLyric), false);
  assert.equal(fs.existsSync(agedTemp), false);
  assert.equal(fs.existsSync(unownedAudio), false);
  assert.equal(fs.existsSync(emptyDir), false);
  assert.equal(fs.existsSync(stereoRoot), true, "root folder itself is never deleted");

  const historyRows = db.prepare(`SELECT event_type, data FROM history_events`).all() as Array<{ event_type: string; data: string }>;
  assert.ok(historyRows.some((r) => r.event_type === "TrackFileDeleted" && r.data.includes("orphan lyric")));
  assert.ok(historyRows.some((r) => r.event_type === "TrackFileDeleted" && r.data.includes("temporary")));
  assert.ok(historyRows.some((r) => r.event_type === "TrackFileDeleted" && r.data.includes("unowned")));
  assert.ok(historyRows.some((r) => r.event_type === "TrackFileDeleted" && r.data.includes("empty folder")));
});

test("placement rule enforces stereo/Atmos rules both ways (keep allowed, move unique misplaced, delete duplicate misplaced)", async () => {
  setupRootsAndDb();

  // Pure placement unit checks (both ways + case-insensitive)
  assert.equal(
    evaluateTrackFilePlacement({
      file: { file_path: path.join(stereoRoot, "Artist", "OnlyAtmos.m4a"), quality: "DOLBY_ATMOS", recording_id: 103, release_group_id: 2 },
      stereoRoot,
      atmosRoot,
      recordingFileCount: 1,
      recordingHasAtmosVersion: true,
      albumIsAtmos: true,
    }).allowed,
    true,
    "Atmos track in stereo library is allowed when it is the only version",
  );
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
    "Stereo track in Atmos library is allowed when album is Atmos and track has no Atmos version",
  );

  // 1. Misplaced stereo file in Atmos for a non-Atmos album with no stereo copy -> MOVED to stereo
  const misplacedStereoRel = path.join("Artist One", "Album One", "01 - Track 1.flac");
  const misplacedStereoPath = path.join(atmosRoot, misplacedStereoRel);
  fs.mkdirSync(path.dirname(misplacedStereoPath), { recursive: true });
  fs.writeFileSync(misplacedStereoPath, "stereo-in-atmos");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (10, 1, 2, ?, 1, 10, 1000, 100, ?, ?, '01 - Track 1.flac', 'flac', 'track', 'FLAC')
  `).run(atmosRoot, misplacedStereoPath, misplacedStereoRel.replace(/\\/g, "/"));

  // 2. Misplaced stereo file in Atmos when stereo copy ALREADY exists -> DELETED
  const dupStereoInStereo = path.join(stereoRoot, "Artist One", "Album One", "02 - Track 2.flac");
  const dupStereoInAtmos = path.join(atmosRoot, "Artist One", "Album One", "02 - Track 2.flac");
  fs.mkdirSync(path.dirname(dupStereoInStereo), { recursive: true });
  fs.mkdirSync(path.dirname(dupStereoInAtmos), { recursive: true });
  fs.writeFileSync(dupStereoInStereo, "stereo-ok");
  fs.writeFileSync(dupStereoInAtmos, "stereo-dup-in-atmos");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (11, 1, 1, ?, 1, 10, 1001, 101, ?, 'Artist One/Album One/02 - Track 2.flac', '02 - Track 2.flac', 'flac', 'track', 'FLAC')
  `).run(stereoRoot, dupStereoInStereo);
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (12, 1, 2, ?, 1, 10, 1001, 101, ?, 'Artist One/Album One/02 - Track 2.flac', '02 - Track 2.flac', 'flac', 'track', 'FLAC')
  `).run(atmosRoot, dupStereoInAtmos);

  // 3. Allowed stereo interlude in Atmos album (no Atmos version of rec-102) -> KEPT
  const allowedInterlude = path.join(atmosRoot, "Artist One", "Atmos Album", "01 - Interlude.flac");
  fs.mkdirSync(path.dirname(allowedInterlude), { recursive: true });
  fs.writeFileSync(allowedInterlude, "interlude");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (13, 1, 2, ?, 2, 20, 1002, 102, ?, 'Artist One/Atmos Album/01 - Interlude.flac', '01 - Interlude.flac', 'flac', 'track', 'FLAC')
  `).run(atmosRoot, allowedInterlude);

  // 4. Allowed Atmos-only track in stereo library (only version of rec-103) -> KEPT
  const allowedAtmosInStereo = path.join(stereoRoot, "Artist One", "Atmos Album", "02 - Only Atmos.m4a");
  fs.mkdirSync(path.dirname(allowedAtmosInStereo), { recursive: true });
  fs.writeFileSync(allowedAtmosInStereo, "atmos-only");
  db.prepare(`
    INSERT INTO TrackFiles (id, artist_metadata_id, library_id, library_root, release_group_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, filename, extension, file_type, quality)
    VALUES (14, 1, 1, ?, 2, 20, 1003, 103, ?, 'Artist One/Atmos Album/02 - Only Atmos.m4a', '02 - Only Atmos.m4a', 'm4a', 'track', 'DOLBY_ATMOS')
  `).run(stereoRoot, allowedAtmosInStereo);

  const summary = await runHousekeepingStrayAndPlacement({ runUnmappedRecheck: false });
  assert.equal(summary.misplacedMoved, 1);
  assert.equal(summary.misplacedDeleted, 1);

  const movedDest = path.join(stereoRoot, misplacedStereoRel);
  assert.equal(fs.existsSync(movedDest), true);
  assert.equal(fs.existsSync(misplacedStereoPath), false);
  const movedRow = db.prepare(`SELECT library_id, file_path FROM TrackFiles WHERE id = 10`).get() as { library_id: number; file_path: string };
  assert.equal(movedRow.library_id, 1);
  assert.equal(movedRow.file_path, movedDest);

  assert.equal(fs.existsSync(dupStereoInStereo), true);
  assert.equal(fs.existsSync(dupStereoInAtmos), false);
  assert.equal(db.prepare(`SELECT 1 FROM TrackFiles WHERE id = 12`).get(), undefined);

  assert.equal(fs.existsSync(allowedInterlude), true);
  assert.equal(fs.existsSync(allowedAtmosInStereo), true);
});
