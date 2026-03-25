import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-database-versioning-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("./database.js");

before(async () => {
  dbModule = await import("./database.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("initDatabase normalizes legacy semver schema baseline to integer versioning", () => {
  dbModule.db.pragma("user_version = 10000");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    "runtime.current_schema_version",
    "1.0.0",
    "Legacy semver-encoded schema baseline"
  );
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    "runtime.current_schema_user_version",
    "10000",
    "Legacy semver-encoded PRAGMA user_version"
  );
  dbModule.db.prepare("DELETE FROM config WHERE key = 'runtime.schema_version_format'").run();

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  const runtimeRows = dbModule.db.prepare(`
    SELECT key, value
    FROM config
    WHERE key IN (
      'runtime.current_schema_version',
      'runtime.current_schema_user_version',
      'runtime.schema_version_format'
    )
    ORDER BY key
  `).all() as Array<{ key: string; value: string }>;
  const latestHistory = dbModule.db.prepare(`
    SELECT schema_from as schemaFrom, schema_to as schemaTo, migration_notes as migrationNotes
    FROM database_version_history
    ORDER BY id DESC
    LIMIT 1
  `).get() as { schemaFrom: number; schemaTo: number; migrationNotes: string } | undefined;

  assert.equal(userVersion, 3);
  assert.deepEqual(runtimeRows, [
    { key: "runtime.current_schema_version", value: "3" },
    { key: "runtime.schema_version_format", value: "integer" },
  ]);
  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 10000);
  assert.equal(latestHistory?.schemaTo, 3);
  assert.match(latestHistory?.migrationNotes ?? "", /baseline current schema as 1/);
  assert.match(latestHistory?.migrationNotes ?? "", /add reverse media_artists lookup index/i);
  assert.match(latestHistory?.migrationNotes ?? "", /queue ordering column/i);
});
