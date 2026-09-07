import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { ensureSearchIndexes, rebuildSearchIndex } from "./search.js";

const { tempDir } = prepareActiveSchemaEnv("search-index");
const { db, dbModule } = await openActiveSchemaDb();
after(() => closeActiveSchemaDb(dbModule, tempDir));
function count(sql: string): number { return (db.prepare(sql).get() as { n: number }).n; }

db.exec(`
  INSERT INTO ArtistMetadata(id, mbid, name) VALUES(1, 'artist', 'Bastille');
  INSERT INTO Albums(id, mbid, artist_mbid, title) VALUES(1, 'album', 'artist', 'Bad Blood');
  INSERT INTO AlbumEditions(id, mbid, release_group_mbid, artist_mbid, title)
    VALUES(1, 'edition', 'album', 'artist', 'Bad Blood');
  INSERT INTO Recordings(id, mbid, title, is_video) VALUES(1, 'recording', 'Pompeii', 1);
  INSERT INTO Tracks(id, mbid, release_mbid, recording_mbid, medium_position, position, title)
    VALUES(1, 'track', 'edition', 'recording', 1, 1, 'Pompeii');
`);

test("active search indexes keep identities distinct and follow edits and deletion", () => {
  assert.deepEqual(db.prepare("SELECT entity_type, entity_id FROM CatalogSearch ORDER BY rowid").all(), [
    { entity_type: "artist", entity_id: "1" },
    { entity_type: "album", entity_id: "album" },
    { entity_type: "video", entity_id: "1" },
  ]);
  db.prepare("UPDATE Tracks SET title = 'Oblivion' WHERE id = 1").run();
  assert.equal(count("SELECT COUNT(*) AS n FROM TrackSearch WHERE TrackSearch MATCH 'Pompeii'"), 0);
  assert.deepEqual(db.prepare("SELECT track_mbid FROM TrackSearch WHERE TrackSearch MATCH 'Oblivion'").all(), [{ track_mbid: "track" }]);
  db.prepare("UPDATE Recordings SET is_video = 0 WHERE id = 1").run();
  assert.equal(count("SELECT COUNT(*) AS n FROM CatalogSearch WHERE entity_type = 'video'"), 0);
  db.prepare("UPDATE Recordings SET is_video = 1 WHERE id = 1").run();
  db.prepare("DELETE FROM Tracks WHERE id = 1").run();
  assert.equal(count("SELECT COUNT(*) AS n FROM TrackSearch"), 0);
  db.exec(`INSERT INTO Tracks(id, mbid, release_mbid, recording_mbid, medium_position, position, title)
    VALUES(1, 'track', 'edition', 'recording', 1, 1, 'Pompeii')`);
});

test("unchanged catalog writes do not rewrite search index pages", () => {
  const searchPages = () => ["TrackSearch", "CatalogSearch", "CatalogSubstringSearch"].flatMap(table =>
    db.prepare(`SELECT id, hex(block) AS data FROM ${table}_data ORDER BY id`).all());
  const before = searchPages();
  db.prepare("UPDATE Tracks SET title = title, recording_mbid = recording_mbid WHERE id = 1").run();
  db.prepare("UPDATE Albums SET title = title WHERE id = 1").run();
  db.prepare("UPDATE ArtistMetadata SET name = name WHERE id = 1").run();
  db.prepare("UPDATE Recordings SET title = title, is_video = is_video WHERE id = 1").run();
  assert.deepEqual(searchPages(), before, "other runtime triggers may run, but FTS pages must stay unchanged");
});

test("derived search reconstruction discards stale content and preserves canonical rows", () => {
  db.exec("DELETE FROM TrackSearch; INSERT INTO TrackSearch(title) VALUES('Ghost'); DELETE FROM CatalogSearch");
  rebuildSearchIndex(db, "TrackSearch");
  rebuildSearchIndex(db, "CatalogSearch");
  assert.deepEqual(db.prepare("SELECT track_mbid, title FROM TrackSearch").all(), [{ track_mbid: "track", title: "Pompeii" }]);
  assert.equal(count("SELECT COUNT(*) AS n FROM CatalogSearch"), 3);
  assert.equal(count("SELECT COUNT(*) AS n FROM Tracks"), 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("startup upgrades the obsolete derived index once without a catalog migration", () => {
  db.exec(`DROP TRIGGER tracks_search_delete;
    CREATE TRIGGER tracks_search_delete AFTER DELETE ON Tracks BEGIN
      DELETE FROM TrackSearch WHERE track_mbid = OLD.mbid;
    END`);
  assert.deepEqual(ensureSearchIndexes(db), ["TrackSearch"]);
  assert.deepEqual(ensureSearchIndexes(db), []);
  assert.deepEqual(db.prepare("SELECT track_mbid FROM TrackSearch WHERE TrackSearch MATCH 'Pompeii'").all(), [{ track_mbid: "track" }]);
});

test("a failed search reconstruction rolls back its table and triggers", () => {
  // SQLite authorizer is unavailable in better-sqlite3. A missing source column
  // makes the canonical copy fail after DROP/CREATE, exercising real rollback.
  db.exec("ALTER TABLE Tracks RENAME COLUMN recording_mbid TO unavailable_recording_mbid");
  try {
    assert.throws(() => rebuildSearchIndex(db, "TrackSearch"), /recording_mbid/);
    assert.deepEqual(db.prepare("SELECT track_mbid FROM TrackSearch WHERE TrackSearch MATCH 'Pompeii'").all(), [{ track_mbid: "track" }]);
  } finally {
    db.exec("ALTER TABLE Tracks RENAME COLUMN unavailable_recording_mbid TO recording_mbid");
  }
  db.prepare("UPDATE Tracks SET title = 'Restored' WHERE id = 1").run();
  assert.deepEqual(db.prepare("SELECT track_mbid FROM TrackSearch WHERE TrackSearch MATCH 'Restored'").all(), [{ track_mbid: "track" }]);
});


test("substring search rebuild uses canonical rows and retains infix matches", () => {
  db.exec("DELETE FROM CatalogSubstringSearch");
  rebuildSearchIndex(db, "CatalogSubstringSearch");
  assert.deepEqual(db.prepare("SELECT entity_id FROM CatalogSubstringSearch WHERE title LIKE '%lood%'").all(), [{ entity_id: "album" }]);
  assert.equal(count("SELECT COUNT(*) AS n FROM CatalogSubstringSearch"), 3);
  assert.deepEqual(ensureSearchIndexes(db), []);
});
