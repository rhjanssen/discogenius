import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-leftover-folders-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const configModule = await import("../config/config.js");
const { LibraryFilesService } = await import("./library-files.js");

function writeLibraryPaths() {
  const config = configModule.readConfig();
  config.path.music_path = path.join(tempDir, "library", "music");
  config.path.spatial_path = path.join(tempDir, "library", "spatial");
  config.path.video_path = path.join(tempDir, "library", "videos");
  config.naming.artist_folder = "{Artist Name} {mbid-{Artist MbId}}";
  configModule.writeConfig(config);
  fs.mkdirSync(config.path.music_path, { recursive: true });
}

function reset() {
  for (const table of ["UnmappedFiles", "TrackFiles", "LibraryArtists", "ArtistMetadata"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(() => {
  reset();
  writeLibraryPaths();
});
afterEach(reset);

test("remove-unmonitored wipes leftover Title (year) folders after a {mbid} rename", () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("7808accb-6395-4b25-858c-678bbb73896b", "Bastille");
  seedLibraryArtistMonitoring(db, "7808accb-6395-4b25-858c-678bbb73896b");
  const artistId = (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
    .get("7808accb-6395-4b25-858c-678bbb73896b") as { id: number }).id;

  const musicRoot = configModule.Config.getMusicPath();
  const artistDir = path.join(musicRoot, "Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}");
  const importedDir = path.join(artistDir, "Bad Blood (2012) {mbid-5bca186e-3dfb-4191-a3b1-8876d454c53c}");
  const leftoverDir = path.join(artistDir, "Bad Blood (2012)");
  fs.mkdirSync(importedDir, { recursive: true });
  fs.mkdirSync(leftoverDir, { recursive: true });
  const importedPath = path.join(importedDir, "01 - Pompeii.flac");
  const leftoverPath = path.join(leftoverDir, "01 - Pompeii.flac");
  fs.writeFileSync(importedPath, "imported");
  fs.writeFileSync(leftoverPath, "leftover");

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_slot, file_path, relative_path, library_root,
      filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artistId,
    "stereo",
    importedPath,
    path.relative(musicRoot, importedPath),
    musicRoot,
    "01 - Pompeii.flac",
    "flac",
    "track",
  );
  db.prepare(`
    INSERT INTO UnmappedFiles (
      file_path, relative_path, library_root, filename, extension, reason
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    leftoverPath,
    path.relative(musicRoot, leftoverPath),
    "music",
    "01 - Pompeii.flac",
    "flac",
    "No matching release found in catalog",
  );

  const result = LibraryFilesService.pruneUnmonitoredFiles("7808accb-6395-4b25-858c-678bbb73896b");
  assert.equal(fs.existsSync(importedPath), true, "imported {mbid} copy stays");
  assert.equal(fs.existsSync(leftoverPath), false, "leftover Title (year) copy is deleted");
  assert.equal(fs.existsSync(leftoverDir), false, "empty leftover folder is removed");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM UnmappedFiles").get() as { n: number }).n,
    0,
  );
  assert.ok(result.deleted >= 1);
});

test("remove-unmonitored never wipes a non-MBID album folder that still contains tracked TrackFiles", () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("7808accb-6395-4b25-858c-678bbb73896b", "Bastille");
  seedLibraryArtistMonitoring(db, "7808accb-6395-4b25-858c-678bbb73896b");
  const artistId = (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
    .get("7808accb-6395-4b25-858c-678bbb73896b") as { id: number }).id;

  const musicRoot = configModule.Config.getMusicPath();
  const artistDir = path.join(musicRoot, "Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}");
  const withMbidDir = path.join(artistDir, "Bad Blood (2013) {mbid-5bca186e-3dfb-4191-a3b1-8876d454c53c}");
  const plainDir = path.join(artistDir, "Bad Blood (2012)");
  fs.mkdirSync(withMbidDir, { recursive: true });
  fs.mkdirSync(plainDir, { recursive: true });
  const withMbidTrack = path.join(withMbidDir, "01 - Pompeii.flac");
  const plainTrack = path.join(plainDir, "01 - Pompeii.flac");
  fs.writeFileSync(withMbidTrack, "edition-a");
  fs.writeFileSync(plainTrack, "edition-b");

  for (const filePath of [withMbidTrack, plainTrack]) {
    db.prepare(`
      INSERT INTO TrackFiles (
        artist_metadata_id, library_slot, file_path, relative_path, library_root,
        filename, extension, file_type
      ) VALUES (?, 'stereo', ?, ?, ?, '01 - Pompeii.flac', 'flac', 'track')
    `).run(artistId, filePath, path.relative(musicRoot, filePath), musicRoot);
  }

  LibraryFilesService.pruneUnmonitoredFiles("7808accb-6395-4b25-858c-678bbb73896b");
  assert.equal(fs.existsSync(withMbidTrack), true);
  assert.equal(fs.existsSync(plainTrack), true, "tracked non-MBID folder must never be wiped");
});

test("case-insensitive Linux mount preserves monitored and retained tracks in mixed-case album folders during prune", async () => {
  const { setCaseSensitivityOverride, clearCaseSensitivityCache } = await import("./path-utils.js");
  const { librariesOwningPath, pathIsInsideScopeRoot } = await import("./library-deletion-scope.js");

  const musicRoot = configModule.Config.getMusicPath();
  setCaseSensitivityOverride(musicRoot, true);
  try {
    db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
      .run("case-artist-mbid", "Bastille");
    seedLibraryArtistMonitoring(db, "case-artist-mbid");
    const artistId = (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
      .get("case-artist-mbid") as { id: number }).id;

    const metaProfileId = (db.prepare("SELECT id FROM MetadataProfiles LIMIT 1").get() as { id: number }).id;
    const qualityProfileId = (db.prepare("SELECT id FROM quality_profiles LIMIT 1").get() as { id: number }).id;
    const libId = Number(db.prepare(`
      INSERT INTO Libraries (name, root_path, metadata_profile_id, quality_profile_id, enabled)
      VALUES ('ZFS Case Test', ?, ?, ?, 1)
    `).run(musicRoot, metaProfileId, qualityProfileId).lastInsertRowid);

    // Case-aware deletion scope must match a differing-case path under a case-insensitive Linux root.
    const mixedCaseSubpath = path.join(musicRoot.toUpperCase(), "Bastille", "Bad Blood", "01 - Pompeii.flac");
    assert.deepEqual(librariesOwningPath(mixedCaseSubpath), [libId]);
    assert.equal(pathIsInsideScopeRoot({ kind: "library", libraryId: libId }, mixedCaseSubpath), true);

    const rgMonId = (db.prepare(`
      INSERT INTO Albums (mbid, artist_mbid, artist_metadata_id, title, primary_type)
      VALUES ('rg-mon', 'case-artist-mbid', ?, 'Bad Blood', 'Album') RETURNING id
    `).get(artistId) as { id: number }).id;
    const rgUnmonId = (db.prepare(`
      INSERT INTO Albums (mbid, artist_mbid, artist_metadata_id, title, primary_type)
      VALUES ('rg-unmon', 'case-artist-mbid', ?, 'Bad Blood Bonus', 'Album') RETURNING id
    `).get(artistId) as { id: number }).id;

    const edMonId = (db.prepare(`
      INSERT INTO AlbumEditions (mbid, release_group_mbid, release_group_id, artist_mbid, artist_metadata_id, title)
      VALUES ('ed-mon', 'rg-mon', ?, 'case-artist-mbid', ?, 'Bad Blood') RETURNING id
    `).get(rgMonId, artistId) as { id: number }).id;
    const edUnmonId = (db.prepare(`
      INSERT INTO AlbumEditions (mbid, release_group_mbid, release_group_id, artist_mbid, artist_metadata_id, title)
      VALUES ('ed-unmon', 'rg-unmon', ?, 'case-artist-mbid', ?, 'Bad Blood Bonus') RETURNING id
    `).get(rgUnmonId, artistId) as { id: number }).id;

    db.prepare(`
      INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, curation_version)
      VALUES (?, ?, 'auto', 0, 1)
    `).run(libId, rgMonId);
    db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, curation_version, reason)
      VALUES (?, ?, 'auto', 1, 'curation')
    `).run(libId, edMonId);

    const sharedRecId = (db.prepare(`
      INSERT INTO Recordings (mbid, artist_mbid, artist_metadata_id, title, is_video)
      VALUES ('rec-shared', 'case-artist-mbid', ?, 'Pompeii', 0) RETURNING id
    `).get(artistId) as { id: number }).id;
    const uniqueRecId = (db.prepare(`
      INSERT INTO Recordings (mbid, artist_mbid, artist_metadata_id, title, is_video)
      VALUES ('rec-unique', 'case-artist-mbid', ?, 'Bonus Track', 0) RETURNING id
    `).get(artistId) as { id: number }).id;

    const sharedDir = path.join(musicRoot, "Bastille", "Bad Blood");
    fs.mkdirSync(sharedDir, { recursive: true });
    const monitoredTrack = path.join(sharedDir, "01 - Pompeii (Monitored).flac");
    const unmonitoredRedundant = path.join(sharedDir, "01 - Pompeii (Old).flac");
    const unmonitoredRetained = path.join(sharedDir, "02 - Bonus Track.flac");
    fs.writeFileSync(monitoredTrack, "monitored");
    fs.writeFileSync(unmonitoredRedundant, "redundant");
    fs.writeFileSync(unmonitoredRetained, "retained");

    const insertRow = (
      rgId: number,
      edId: number,
      recId: number,
      rgMbid: string,
      edMbid: string,
      recMbid: string,
      filePath: string,
    ) => {
      db.prepare(`
        INSERT INTO TrackFiles (
          artist_metadata_id, library_id, release_group_id, album_edition_id, recording_id,
          canonical_release_group_mbid, canonical_release_mbid, canonical_recording_mbid,
          library_slot, file_path, relative_path, library_root, filename, extension, file_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stereo', ?, ?, ?, ?, 'flac', 'track')
      `).run(
        artistId, libId, rgId, edId, recId, rgMbid, edMbid, recMbid,
        filePath, path.relative(musicRoot, filePath), musicRoot, path.basename(filePath),
      );
    };

    insertRow(rgMonId, edMonId, sharedRecId, "rg-mon", "ed-mon", "rec-shared", monitoredTrack);
    insertRow(rgUnmonId, edUnmonId, sharedRecId, "rg-unmon", "ed-unmon", "rec-shared", unmonitoredRedundant);
    insertRow(rgUnmonId, edUnmonId, uniqueRecId, "rg-unmon", "ed-unmon", "rec-unique", unmonitoredRetained);

    const res = LibraryFilesService.pruneUnmonitoredFiles("case-artist-mbid", { mode: "immediate", releaseGroupIds: [rgUnmonId] });
    assert.ok(res.deleted >= 1);
    assert.equal(fs.existsSync(unmonitoredRedundant), false, "explicitly unmonitored file should be removed");
    assert.equal(fs.existsSync(monitoredTrack), true, "monitored track in mixed-case folder must survive on case-insensitive ZFS");
    assert.equal(
      Boolean(db.prepare("SELECT 1 FROM TrackFiles WHERE file_path = ?").get(monitoredTrack)),
      true,
      "monitored TrackFiles row must remain intact",
    );
  } finally {
    clearCaseSensitivityCache();
    db.prepare("DELETE FROM Libraries WHERE name = 'ZFS Case Test'").run();
  }
});

