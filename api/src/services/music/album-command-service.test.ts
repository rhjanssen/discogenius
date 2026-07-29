import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-command-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let serviceModule: typeof import("./album-command-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  serviceModule = await import("./album-command-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM LibraryReleaseGroups").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-mbid-1', 'Artist One')").run();
  db.prepare("INSERT INTO Artists (id, mbid, name, monitored) VALUES ('artist-1', 'artist-mbid-1', 'Artist One', 1)").run();
  db.prepare(`
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES (1, 'release-group-mbid-1', 1, 'artist-mbid-1', 'Album One', 'Album')
  `).run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("album monitoring is persisted independently for every enabled library", () => {
  const providerResult = serviceModule.AlbumCommandService.setAlbumMonitored("provider-album-1", true);
  assert.equal(providerResult.status, 404);

  const result = serviceModule.AlbumCommandService.setAlbumMonitored("release-group-mbid-1", true);
  assert.equal(result.success, true);
  const rows = dbModule.db.prepare(`
    SELECT library_id, monitored, selection_mode
    FROM LibraryReleaseGroups
    WHERE release_group_id = 1
    ORDER BY library_id
  `).all();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row: any) => row.monitored === 1 && row.selection_mode === "manual"));
});

test("album monitor locks are library release-group authority", () => {
  const result = serviceModule.AlbumCommandService.updateAlbum(
    "release-group-mbid-1",
    undefined,
    true,
  );
  assert.equal(result.success, true);
  const rows = dbModule.db.prepare(`
    SELECT locked FROM LibraryReleaseGroups WHERE release_group_id = 1
  `).all() as Array<{ locked: number }>;
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.locked === 1));
});

test("monitor-only album add succeeds without reconstructing a legacy provider plan", async () => {
  const result = await serviceModule.AlbumCommandService.addAlbum(
    "release-group-mbid-1",
    false,
    "stereo",
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.commandIds, []);
});
