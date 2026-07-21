import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-delete-"));
const musicRoot = path.join(tempDir, "music");
fs.mkdirSync(musicRoot, { recursive: true });
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let deleteModule: typeof import("./library-file-delete-service.js");
let configModule: typeof import("../config/config.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  // Point the music library root at our temp folder for path resolution.
  const current = configModule.readConfig();
  configModule.writeConfig({
    ...current,
    path: {
      ...current.path,
      music_path: musicRoot,
    },
  });
  deleteModule = await import("./library-file-delete-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("deleteReleaseGroupLibraryFiles removes disk files and TrackFiles rows", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-delete-1";
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Artist')
  `).run();
  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored) VALUES (42, 'artist-mbid', 'Artist', 1)
  `).run();
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, 'artist-mbid', 'Album', 'Album')
  `).run(releaseGroupMbid);

  const albumDir = path.join(musicRoot, "Artist", "Album");
  fs.mkdirSync(albumDir, { recursive: true });
  const filePath = path.join(albumDir, "01 Track.flac");
  fs.writeFileSync(filePath, "audio");

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, file_type, library_slot, library_root, file_path, relative_path, filename, extension,
      canonical_release_group_mbid
    ) VALUES (42, 'track', 'stereo', 'music', ?, 'Artist/Album/01 Track.flac', '01 Track.flac', 'flac', ?)
  `).run(filePath, releaseGroupMbid);

  const result = deleteModule.deleteReleaseGroupLibraryFiles(releaseGroupMbid);
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM TrackFiles WHERE canonical_release_group_mbid = ?")
      .get(releaseGroupMbid) as { c: number }).c,
    0,
  );
});
