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
