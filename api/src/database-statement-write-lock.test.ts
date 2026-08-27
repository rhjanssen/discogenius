import assert from "node:assert/strict";
import { after, test } from "node:test";
import { holdsSqliteWriteMutex } from "./database/sqlite-write-mutex.js";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "./test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("statement-write-lock");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

test("mutating prepared statements hold the shared writer mutex for RETURNING rows", () => {
  db.exec(`
    CREATE TABLE StatementWriteMutexProbe (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.function("discogenius_write_mutex_held", () => holdsSqliteWriteMutex() ? 1 : 0);

  const getResult = db.prepare(`
    INSERT INTO StatementWriteMutexProbe (value)
    VALUES ('get')
    RETURNING discogenius_write_mutex_held() AS mutex_held
  `).get() as { mutex_held: number };
  assert.equal(getResult.mutex_held, 1, "INSERT ... RETURNING through .get() must hold the mutex");

  const allResults = db.prepare(`
    INSERT INTO StatementWriteMutexProbe (value)
    VALUES ('all-one'), ('all-two')
    RETURNING discogenius_write_mutex_held() AS mutex_held
  `).all() as Array<{ mutex_held: number }>;
  assert.deepEqual(
    allResults.map((row) => row.mutex_held),
    [1, 1],
    "INSERT ... RETURNING through .all() must hold the mutex while every row is stepped",
  );

  const readResult = db.prepare(`
    SELECT discogenius_write_mutex_held() AS mutex_held
  `).get() as { mutex_held: number };
  assert.equal(readResult.mutex_held, 0, "readonly statements must not take the writer mutex");
});
