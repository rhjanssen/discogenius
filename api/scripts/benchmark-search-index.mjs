import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const schema = await import(pathToFileURL(resolve(process.argv[2])).href);
const rows = Number(process.argv[3] || 3500000);
if (!Number.isSafeInteger(rows) || rows < 10) {
  throw new Error('rows must be an integer of at least 10');
}

const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE Tracks(id INTEGER PRIMARY KEY, mbid TEXT, recording_mbid TEXT, title TEXT)');
  schema.createTrackSearchIndex(db);
  const start = performance.now();
  db.exec(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${rows}
    )
    INSERT INTO Tracks
    SELECT n, printf('track-%d', n), printf('recording-%d', n), printf('Library track %d', n)
    FROM seq
  `);
  const seedMs = Math.round(performance.now() - start);
  const measure = (sql) => {
    const started = performance.now();
    db.exec(sql);
    return Math.round(performance.now() - started);
  };
  const unchangedTenRowsMs = measure('UPDATE Tracks SET title = title WHERE id <= 10');
  const changedTenRowsMs = measure("UPDATE Tracks SET title = title || ' changed' WHERE id <= 10");
  console.log(JSON.stringify({
    rows,
    seedMs,
    unchangedTenRowsMs,
    changedTenRowsMs,
    indexedDeletePlan: db.prepare('EXPLAIN QUERY PLAN DELETE FROM TrackSearch WHERE rowid = ?').all(1),
    unindexedDeletePlan: db.prepare('EXPLAIN QUERY PLAN DELETE FROM TrackSearch WHERE track_mbid = ?').all('track-1'),
  }));
} finally {
  db.close();
}
