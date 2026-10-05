import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-statistics-gate-"));
process.env.DB_PATH = path.join(root, "test.db");
process.env.DISCOGENIUS_CONFIG_DIR = root;
const database = await import("../../database.js");
database.initDatabase();
const { db, withSqliteWriteGate } = database;
const { ArtistStatisticsService } = await import("./artist-statistics-service.js");
const { seedTestLibrary } = await import("../../test-support/library-fixtures.js");
const libraryId = seedTestLibrary(db, { name: "Statistics test", rootPath: root });

beforeEach(() => {
  db.prepare("DELETE FROM ArtistStatistics").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});
after(() => { database.closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

function artist(mbid: string): number {
  const id = Number(db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES(?,?)").run(mbid, mbid).lastInsertRowid);
  db.prepare("INSERT INTO LibraryArtists(library_id,artist_metadata_id,policy) VALUES(?,?,'all')").run(libraryId, id);
  return id;
}

for (const change of ["album", "deleted artist"] as const) test(`async statistics waits for writer admission and replans after a competing ${change}`, async () => {
  const id = artist("artist");
  db.prepare("INSERT INTO Albums(mbid,artist_mbid,title) VALUES('album-one','artist','One')").run();
  let acquired!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = withSqliteWriteGate(async () => {
    acquired(); await new Promise<void>(resolve => { release = resolve; });
    if (change === "album") db.prepare("INSERT INTO Albums(mbid,artist_mbid,title) VALUES('album-two','artist','Two')").run();
    else db.prepare("DELETE FROM ArtistMetadata WHERE id=?").run(id);
  }, "test:statistics-competing-writer");
  await ready;
  let settled = false;
  const work = ArtistStatisticsService.refreshAsync(["artist"]).then(rows => { settled = true; return rows; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false);
    assert.equal((db.prepare("SELECT count(*) AS n FROM ArtistStatistics").get() as { n: number }).n, 0);
    release(); await blocker;
    const rows = await work;
    if (change === "album") {
      assert.equal(rows[0].album_count, 2);
      assert.equal((db.prepare("SELECT album_count FROM ArtistStatistics WHERE artist_metadata_id=?").get(id) as { album_count: number }).album_count, 2);
    } else { assert.deepEqual(rows, []); assert.equal((db.prepare("SELECT count(*) AS n FROM ArtistStatistics").get() as { n: number }).n, 0); }
  } finally { release(); await blocker; await work; }
});

test("full async statistics yields writer admission between bounded projection batches", async () => {
  for (let index=0; index<205; index+=1) artist(`artist-${index}`);
  const work = ArtistStatisticsService.refreshAsync();
  const observed = await withSqliteWriteGate(() => (db.prepare("SELECT count(*) AS n FROM ArtistStatistics").get() as { n: number }).n, "test:statistics-fair-writer");
  assert.equal(observed, 200, "another admitted task must run before the final projection batch");
  const rows = await work;
  assert.equal(rows.length, 205);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ArtistStatistics").get() as { n: number }).n, 205);
});
