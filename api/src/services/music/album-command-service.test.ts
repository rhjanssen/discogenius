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
  db.prepare("DELETE FROM LibraryAlbums").run();
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

function libraryId(name: string): number {
  return (dbModule.db.prepare("SELECT id FROM Libraries WHERE name = ?")
    .get(name) as { id: number }).id;
}

function monitoredLibraryIds(): number[] {
  return (dbModule.db.prepare(`
    SELECT library_id FROM LibraryAlbums WHERE release_group_id = 1 ORDER BY library_id
  `).all() as Array<{ library_id: number }>).map((row) => row.library_id);
}

test("an explicit all-libraries monitor reaches every audio library and no video library", () => {
  const providerResult = serviceModule.AlbumCommandService.setAlbumMonitored(
    "provider-album-1", true, { kind: "all-audio-libraries" },
  );
  assert.equal(providerResult.status, 404);

  const result = serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "all-audio-libraries" },
  );
  assert.equal(result.success, true);

  const rows = dbModule.db.prepare(`
    SELECT library.name, library_album.selection_mode
    FROM LibraryAlbums library_album
    JOIN Libraries library ON library.id = library_album.library_id
    WHERE library_album.release_group_id = 1
    ORDER BY library.name
  `).all() as Array<{ name: string; selection_mode: string }>;
  assert.deepEqual(rows.map((row) => row.name), ["Spatial", "Stereo"]);
  assert.ok(rows.every((row) => row.selection_mode === "manual"));
});

test("monitoring one library leaves the others exactly as they were", () => {
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "library", libraryId: libraryId("Stereo") },
  );
  assert.deepEqual(monitoredLibraryIds(), [libraryId("Stereo")]);

  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "library", libraryId: libraryId("Spatial") },
  );
  assert.deepEqual(
    monitoredLibraryIds().sort((a, b) => a - b),
    [libraryId("Stereo"), libraryId("Spatial")].sort((a, b) => a - b),
  );

  // Unmonitoring Stereo must not withdraw Spatial.
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", false, { kind: "library", libraryId: libraryId("Stereo") },
  );
  assert.deepEqual(monitoredLibraryIds(), [libraryId("Spatial")]);
});

test("locking an unmonitored album creates no library album row", () => {
  const result = serviceModule.AlbumCommandService.updateAlbum(
    "release-group-mbid-1", undefined, true, { kind: "all-audio-libraries" },
  );
  assert.equal(result.success, true);
  // A lock protects a monitored Album. With nothing monitored there is nothing
  // to protect, and a row created to hold the lock would claim otherwise.
  assert.deepEqual(monitoredLibraryIds(), []);
});

test("locking one library does not touch another library's row", () => {
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "all-audio-libraries" },
  );
  serviceModule.AlbumCommandService.updateAlbum(
    "release-group-mbid-1", undefined, true, { kind: "library", libraryId: libraryId("Stereo") },
  );

  const locks = dbModule.db.prepare(`
    SELECT library.name, library_album.locked
    FROM LibraryAlbums library_album
    JOIN Libraries library ON library.id = library_album.library_id
    WHERE library_album.release_group_id = 1
    ORDER BY library.name
  `).all() as Array<{ name: string; locked: number }>;
  assert.deepEqual(locks, [
    { name: "Spatial", locked: 0 },
    { name: "Stereo", locked: 1 },
  ]);
});

test("unmonitoring an album withdraws the editions monitored under it", () => {
  const stereo = libraryId("Stereo");
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title
    )
    VALUES (10, 'edition-mbid-1', 1, 'release-group-mbid-1', 'artist-mbid-1', 'Album One')
  `).run();
  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", true, { kind: "library", libraryId: stereo },
  );
  dbModule.db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, curation_version)
    VALUES (?, 10, 'manual', 1)
  `).run(stereo);

  serviceModule.AlbumCommandService.setAlbumMonitored(
    "release-group-mbid-1", false, { kind: "library", libraryId: stereo },
  );

  // An Edition monitored inside an unmonitored Album is the contradiction row
  // existence exists to prevent.
  assert.deepEqual(monitoredLibraryIds(), []);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS n FROM LibraryEditions WHERE edition_id = 10")
      .get() as { n: number }).n,
    0,
  );
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
