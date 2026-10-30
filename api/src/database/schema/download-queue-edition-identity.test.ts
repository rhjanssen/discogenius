import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDownloadQueueEditionIdentity } from "./download-queue-edition-identity.js";

function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE AcquisitionPlans (id INTEGER PRIMARY KEY, library_id INTEGER, edition_id INTEGER);
    CREATE TABLE DownloadQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref_key TEXT NOT NULL, media_kind TEXT NOT NULL,
      command_name TEXT NOT NULL, plan_id INTEGER, track_ids TEXT, payload TEXT NOT NULL DEFAULT '{}',
      queue_order REAL NOT NULL, command_id INTEGER
    );
  `);
  return db;
}

test("migration collapses waiting duplicates per library+edition and enforces uniqueness", () => {
  const db = legacyDb();
  db.exec(`
    INSERT INTO AcquisitionPlans VALUES (1, 1, 10), (2, 1, 10), (3, 1, 11), (4, 2, 10);
    INSERT INTO DownloadQueue (ref_key, media_kind, command_name, plan_id, track_ids, queue_order, command_id) VALUES
      ('a', 'album', 'DownloadAlbum', 1, NULL, 5, NULL),
      ('b', 'album', 'DownloadAlbum', 2, NULL, 1, NULL),
      ('c', 'album', 'DownloadAlbum', 3, NULL, 9, 77),
      ('d', 'album', 'DownloadAlbum', 3, NULL, 2, NULL),
      ('e', 'album', 'DownloadAlbum', 4, NULL, 3, NULL),
      ('f', 'album', 'DownloadAlbum', 1, '[1]', 4, NULL),
      ('g', 'album', 'DownloadAlbum', 99, NULL, 6, NULL);
  `);
  const result = migrateDownloadQueueEditionIdentity(db);
  assert.deepEqual(result, { removed: 2, backfilled: 3 });
  const rows = db.prepare("SELECT ref_key, library_id, edition_id FROM DownloadQueue ORDER BY ref_key").all();
  assert.deepEqual(rows, [
    { ref_key: "b", library_id: 1, edition_id: 10 },
    { ref_key: "c", library_id: 1, edition_id: 11 },
    { ref_key: "e", library_id: 2, edition_id: 10 },
    { ref_key: "f", library_id: null, edition_id: null },
    { ref_key: "g", library_id: null, edition_id: null },
  ]);
  assert.throws(() => db.prepare(`INSERT INTO DownloadQueue (ref_key, media_kind, command_name, library_id, edition_id, queue_order)
    VALUES ('x', 'album', 'DownloadAlbum', 1, 10, 0)`).run(), /UNIQUE/);
  assert.deepEqual(migrateDownloadQueueEditionIdentity(db), { removed: 0, backfilled: 0 }, "idempotent");
});

test("two running rows for one edition do not fail the migration", () => {
  const db = legacyDb();
  db.exec(`
    INSERT INTO AcquisitionPlans VALUES (1, 1, 10);
    INSERT INTO DownloadQueue (ref_key, media_kind, command_name, plan_id, queue_order, command_id) VALUES
      ('a', 'album', 'DownloadAlbum', 1, 1, 5), ('b', 'album', 'DownloadAlbum', 1, 2, 6);
  `);
  assert.deepEqual(migrateDownloadQueueEditionIdentity(db), { removed: 0, backfilled: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM DownloadQueue").get() as { n: number }).n, 2);
});

test("migration on a large queue stays fast", () => {
  const db = legacyDb();
  const plan = db.prepare("INSERT INTO AcquisitionPlans VALUES (?, 1, ?)");
  const row = db.prepare("INSERT INTO DownloadQueue (ref_key, media_kind, command_name, plan_id, queue_order) VALUES (?, 'album', 'DownloadAlbum', ?, ?)");
  db.transaction(() => {
    for (let i = 1; i <= 150_000; i += 1) {
      plan.run(i, Math.ceil(i / 2));
      row.run(`r${i}`, i, i);
    }
  })();
  const started = performance.now();
  const result = migrateDownloadQueueEditionIdentity(db);
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { removed: 75_000, backfilled: 75_000 });
  console.log(`edition-identity migration on 150k rows: ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 10_000);
});
