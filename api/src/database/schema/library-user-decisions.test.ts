import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateLibraryUserDecisions } from "./library-user-decisions.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE Libraries (id INTEGER PRIMARY KEY);
    CREATE TABLE Albums (id INTEGER PRIMARY KEY);
    CREATE TABLE AlbumEditions (id INTEGER PRIMARY KEY, release_group_id INTEGER);
    CREATE TABLE LibraryAlbums (library_id INTEGER, release_group_id INTEGER, selection_mode TEXT, locked INTEGER, reason TEXT, PRIMARY KEY(library_id, release_group_id));
    CREATE TABLE LibraryEditions (library_id INTEGER, edition_id INTEGER, selection_mode TEXT, reason TEXT, PRIMARY KEY(library_id, edition_id));
    INSERT INTO Libraries VALUES (1); INSERT INTO Albums VALUES (1), (2);
    INSERT INTO AlbumEditions VALUES (10, 1), (20, 2);
    INSERT INTO LibraryAlbums VALUES (1, 1, 'manual', 0, 'canonical_manual_import'), (1, 2, 'manual', 0, 'user');
    INSERT INTO LibraryEditions VALUES (1, 10, 'manual', 'canonical_manual_import'), (1, 20, 'manual', 'user');
  `);
  return d;
}

test("startup migration does not lock albums that only an import marked manual", () => {
  const d = db();
  migrateLibraryUserDecisions(d);
  migrateLibraryUserDecisions(d);
  const rows = d.prepare("SELECT release_group_id, selection_mode, locked FROM LibraryAlbums ORDER BY 1").all();
  assert.deepEqual(rows.map((r: any) => [r.release_group_id, r.selection_mode, r.locked]), [[1, "auto", 0], [2, "manual", 1]]);
  assert.equal((d.prepare("SELECT selection_mode FROM LibraryEditions WHERE edition_id = 10").get() as any).selection_mode, "auto");
});
