import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-database-migration-"));
const dbPath = path.join(tempDir, "discogenius.test.db");
process.env.DB_PATH = dbPath;
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("./database.js");

before(async () => {
  dbModule = await import("./database.js");
  // 1. Initialize a baseline database
  dbModule.initDatabase();

  // 2. Simulate a schema 39 state by dropping the schema 40 tables and columns
  dbModule.db.exec(`
    DROP TABLE IF EXISTS ReleaseGroupSlotTrackAssignments;
    DROP TABLE IF EXISTS ReleaseGroupSlotSources;
    DROP TABLE IF EXISTS ReleaseGroupSlotTargets;
    ALTER TABLE ReleaseGroupSlots DROP COLUMN plan_status;
    ALTER TABLE ReleaseGroupSlots DROP COLUMN plan_matcher_version;
  `);

  // 3. Insert required foreign key parent records and a legacy selected slot row
  dbModule.db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid-1', 'Test Artist');
  `).run();

  dbModule.db.prepare(`
    INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title)
    VALUES ('rg-mbid-1', 'artist-mbid-1', 'Test Album');
  `).run();

  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, selected_provider, selected_provider_id)
    VALUES ('artist-mbid-1', 'rg-mbid-1', 'stereo', 'spotify', 'sp-album-1');
  `).run();

  // 4. Reset user_version to 39
  dbModule.db.pragma("user_version = 39");
});

after(() => {
  if (dbModule) {
    dbModule.closeDatabase();
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("migrating an existing schema-39 database upgrades it to schema-40 and marks selected slots as stale", () => {
  // Call initDatabase again to trigger the schema 39 -> 40 migration path
  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, 40, "Expected PRAGMA user_version to be updated to 40");

  const columns = (dbModule.db.prepare("PRAGMA table_info(ReleaseGroupSlots)").all() as Array<{ name: string }>)
    .map((col) => col.name);
  assert.ok(columns.includes("plan_status"), "Expected ReleaseGroupSlots to have plan_status column");
  assert.ok(columns.includes("plan_matcher_version"), "Expected ReleaseGroupSlots to have plan_matcher_version column");

  const slot = dbModule.db.prepare("SELECT * FROM ReleaseGroupSlots WHERE release_group_mbid = 'rg-mbid-1'").get() as any;
  assert.equal(slot.plan_status, "stale", "Expected existing selected slot to be marked stale");
  assert.equal(slot.plan_matcher_version, 0, "Expected existing selected slot matcher version to be 0");

  for (const tableName of ["ReleaseGroupSlotTargets", "ReleaseGroupSlotSources", "ReleaseGroupSlotTrackAssignments"]) {
    const row = dbModule.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName);
    assert.ok(row, `Expected table '${tableName}' to exist after migration`);
  }
});
