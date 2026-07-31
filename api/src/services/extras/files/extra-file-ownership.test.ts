import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-extra-ownership-"));
const sharedRoot = path.join(tempDir, "music");
fs.mkdirSync(sharedRoot, { recursive: true });
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../../database.js");
let serviceModule: typeof import("./extra-file-service.js");
let fixtures: typeof import("../../../test-support/library-fixtures.js");

const ARTIST_MBID = "artist-mbid";
const ARTIST_ID = "42";
const ALBUM_MBID = "album-mbid";

before(async () => {
  dbModule = await import("../../../database.js");
  dbModule.initDatabase();
  serviceModule = await import("./extra-file-service.js");
  fixtures = await import("../../../test-support/library-fixtures.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM Libraries").run();
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, 'Artist')
  `).run(ARTIST_MBID);
  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored) VALUES (?, ?, 'Artist', 1)
  `).run(ARTIST_ID, ARTIST_MBID);
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, 'Album', 'Album')
  `).run(ALBUM_MBID, ARTIST_MBID);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedLibraries(): { lossless: number; lossy: number } {
  return {
    lossless: fixtures.seedTestLibrary(dbModule.db, { name: "Lossless", rootPath: sharedRoot }),
    lossy: fixtures.seedTestLibrary(dbModule.db, { name: "Lossy", rootPath: sharedRoot }),
  };
}

function seedTrackFile(libraryId: number, relativePath: string): number {
  const filePath = path.join(sharedRoot, relativePath);
  return (dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, file_type, library_slot, library_root, library_id,
      file_path, relative_path, filename, extension, canonical_release_group_mbid
    ) VALUES (?, 'track', 'stereo', 'music', ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    ARTIST_ID,
    libraryId,
    filePath,
    relativePath,
    path.basename(filePath),
    path.extname(filePath).replace(".", ""),
    ALBUM_MBID,
  ) as { id: number }).id;
}

function ownership(input: Partial<Parameters<
  typeof serviceModule.ExtraFileService.resolveOwningLibraryIds
>[0]> = {}): number[] {
  return serviceModule.ExtraFileService.resolveOwningLibraryIds({
    artistId: ARTIST_ID,
    filePath: path.join(sharedRoot, "Artist", "Album", "cover.jpg"),
    libraryRoot: sharedRoot,
    fileType: "cover",
    ...input,
  });
}

test("an explicit library id wins outright", () => {
  const { lossy } = seedLibraries();
  assert.deepEqual(ownership({ libraryId: lossy }), [lossy]);
});

test("a single library sharing the root needs no further evidence", () => {
  const libraryId = fixtures.seedTestLibrary(dbModule.db, { name: "Only", rootPath: sharedRoot });
  assert.deepEqual(ownership(), [libraryId]);
});

test("a track-linked extra belongs to that track file's library alone", () => {
  const { lossless, lossy } = seedLibraries();
  seedTrackFile(lossless, path.join("Artist", "Album", "01 Track.flac"));
  const mp3 = seedTrackFile(lossy, path.join("Artist", "Album", "01 Track.mp3"));

  assert.deepEqual(
    ownership({
      trackFileId: mp3,
      filePath: path.join(sharedRoot, "Artist", "Album", "01 Track.lrc"),
      fileType: "lyrics",
    }),
    [lossy],
    "root equality must not add the lossless library to a lossy track's lyrics",
  );
});

test("a curated album associates every library that selected it", () => {
  const { lossless, lossy } = seedLibraries();
  const album = dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = ?")
    .get(ALBUM_MBID) as { id: number };
  const insert = dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked, curation_version
    ) VALUES (?, ?, 1, 'manual', 1, 1)
  `);
  insert.run(lossless, album.id);
  insert.run(lossy, album.id);

  assert.deepEqual(
    ownership({ canonicalReleaseGroupMbid: ALBUM_MBID }).sort((a, b) => a - b),
    [lossless, lossy].sort((a, b) => a - b),
  );
});

test("an album curated by one library does not associate the other", () => {
  const { lossless, lossy } = seedLibraries();
  const album = dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = ?")
    .get(ALBUM_MBID) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked, curation_version
    ) VALUES (?, ?, 1, 'manual', 1, 1)
  `).run(lossless, album.id);

  const owners = ownership({ canonicalReleaseGroupMbid: ALBUM_MBID });
  assert.deepEqual(owners, [lossless]);
  assert.ok(!owners.includes(lossy));
});

test("without curation rows, folder content decides ownership", () => {
  const { lossless, lossy } = seedLibraries();
  seedTrackFile(lossless, path.join("Artist", "Album", "01 Track.flac"));
  seedTrackFile(lossy, path.join("Artist", "Album", "01 Track.mp3"));

  assert.deepEqual(ownership().sort((a, b) => a - b), [lossless, lossy].sort((a, b) => a - b));
});

test("a folder holding only one library's media does not associate the other", () => {
  const { lossless, lossy } = seedLibraries();
  seedTrackFile(lossless, path.join("Artist", "Album", "01 Track.flac"));
  // The lossy library has content elsewhere under the same root.
  seedTrackFile(lossy, path.join("Artist", "Other Album", "01 Track.mp3"));

  assert.deepEqual(ownership(), [lossless]);
});

test("an album-level extra with no other evidence stays shared across the root", () => {
  const { lossless, lossy } = seedLibraries();
  // A cover written before any audio lands in the folder genuinely belongs to
  // every library sharing that album folder; deletion releases it per library.
  assert.deepEqual(ownership().sort((a, b) => a - b), [lossless, lossy].sort((a, b) => a - b));
});

test("a track-scoped extra with no evidence fails closed instead of guessing", () => {
  seedLibraries();
  const lyricPath = path.join(sharedRoot, "Artist", "Album", "01 Track.lrc");
  assert.deepEqual(
    ownership({
      filePath: lyricPath,
      fileType: "lyrics",
      canonicalTrackMbid: "track-mbid",
    }),
    [],
  );
  assert.throws(
    () => serviceModule.ExtraFileService.upsert({
      artistId: ARTIST_ID,
      filePath: lyricPath,
      libraryRoot: sharedRoot,
      fileType: "lyrics",
      canonicalTrackMbid: "track-mbid",
    }),
    /No library owns sidecar/,
  );
});
