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

  assert.equal(userVersion, 4);
  assert.deepEqual(runtimeRows, [
    { key: "runtime.current_schema_version", value: "4" },
    { key: "runtime.schema_version_format", value: "integer" },
  ]);
  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 10000);
  assert.equal(latestHistory?.schemaTo, 4);
  assert.match(latestHistory?.migrationNotes ?? "", /baseline current schema as 1/);
  assert.match(latestHistory?.migrationNotes ?? "", /add reverse media_artists lookup index/i);
  assert.match(latestHistory?.migrationNotes ?? "", /queue ordering column/i);
  assert.match(latestHistory?.migrationNotes ?? "", /artist path column/i);
});

// ====================================================================
// MIGRATION SMOKE TESTS
// ====================================================================

test("fresh database initializes with correct schema version", () => {
  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, 4);

  const coreTables = [
    "artists", "albums", "media", "media_artists", "library_files",
    "unmapped_files", "config", "job_queue", "quality_profiles",
    "upgrade_queue", "playlists", "playlist_tracks", "history_events",
    "database_version_history",
  ];
  for (const tableName of coreTables) {
    const row = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
    assert.ok(row, `Expected table '${tableName}' to exist`);
  }
});

test("migration from integer schema v1 runs pending migrations", () => {
  dbModule.db.pragma("user_version = 1");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("runtime.schema_version_format", "integer", "Schema versioning format");

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, 4);

  // v4 migration adds artists.path
  const artistCols = dbModule.db.prepare("PRAGMA table_info(artists)").all() as Array<{ name: string }>;
  assert.ok(artistCols.some((c) => c.name === "path"), "Expected artists table to have 'path' column");

  // v3 migration adds job_queue.queue_order
  const jobCols = dbModule.db.prepare("PRAGMA table_info(job_queue)").all() as Array<{ name: string }>;
  assert.ok(jobCols.some((c) => c.name === "queue_order"), "Expected job_queue table to have 'queue_order' column");
});

test("migration from integer schema v3 runs only v4 migration", () => {
  dbModule.db.pragma("user_version = 3");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("runtime.schema_version_format", "integer", "Schema versioning format");

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, 4);

  const latestHistory = dbModule.db.prepare(`
    SELECT schema_from as schemaFrom, schema_to as schemaTo, migration_notes as migrationNotes
    FROM database_version_history
    ORDER BY id DESC
    LIMIT 1
  `).get() as { schemaFrom: number; schemaTo: number; migrationNotes: string } | undefined;

  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 3);
  assert.equal(latestHistory?.schemaTo, 4);
  assert.match(latestHistory?.migrationNotes ?? "", /artist path column/i);
});

test("unversioned database with existing data runs full migration chain", () => {
  dbModule.db.pragma("user_version = 0");
  dbModule.db.prepare("DELETE FROM config WHERE key = 'runtime.schema_version_format'").run();
  dbModule.db.prepare("INSERT OR IGNORE INTO artists (id, name) VALUES (1, 'Test Artist')").run();

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, 4);

  const latestHistory = dbModule.db.prepare(`
    SELECT schema_from as schemaFrom, schema_to as schemaTo
    FROM database_version_history
    ORDER BY id DESC
    LIMIT 1
  `).get() as { schemaFrom: number; schemaTo: number } | undefined;

  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 0);
  assert.equal(latestHistory?.schemaTo, 4);
});
