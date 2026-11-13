import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateTrackFileSource } from "./track-file-source.js";

function setupTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE TrackFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER,
      provider TEXT,
      provider_entity_type TEXT,
      provider_id TEXT,
      provider_item_id INTEGER,
      file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT 'track'
    );
    CREATE TABLE ProviderItems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      provider_id TEXT NOT NULL
    );
    CREATE TABLE AcquisitionPlans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL
    );
    CREATE TABLE AcquisitionPlanTracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      provider_track_match_id INTEGER
    );
    CREATE TABLE ProviderTrackMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_track_item_id INTEGER NOT NULL,
      track_id INTEGER,
      recording_id INTEGER NOT NULL,
      match_state TEXT NOT NULL
    );
  `);
  return db;
}

test("migrateTrackFileSource adds source_provider and backfills from provider column", () => {
  const db = setupTestDb();
  db.prepare(`
    INSERT INTO TrackFiles (file_path, filename, provider, provider_id)
    VALUES ('/music/1.flac', '1.flac', 'tidal', '101'),
           ('/music/2.flac', '2.flac', 'apple-music', '202')
  `).run();

  migrateTrackFileSource(db);

  const row1 = db.prepare("SELECT source_provider, provider_item_id FROM TrackFiles WHERE id = 1").get() as any;
  assert.equal(row1.source_provider, "tidal");

  const row2 = db.prepare("SELECT source_provider, provider_item_id FROM TrackFiles WHERE id = 2").get() as any;
  assert.equal(row2.source_provider, "apple");
});

test("migrateTrackFileSource resolves provider_item_id from ProviderItems when known", () => {
  const db = setupTestDb();
  db.prepare(`INSERT INTO ProviderItems (id, provider, entity_type, provider_id) VALUES (55, 'tidal', 'track', '101')`).run();
  db.prepare(`INSERT INTO TrackFiles (file_path, filename, provider, provider_id) VALUES ('/music/1.flac', '1.flac', 'tidal', '101')`).run();

  migrateTrackFileSource(db);

  const row = db.prepare("SELECT source_provider, provider_item_id FROM TrackFiles WHERE id = 1").get() as any;
  assert.equal(row.source_provider, "tidal");
  assert.equal(row.provider_item_id, 55);
});

test("migrateTrackFileSource backfills source_provider from existing provider_item_id", () => {
  const db = setupTestDb();
  db.prepare(`INSERT INTO ProviderItems (id, provider, entity_type, provider_id) VALUES (77, 'deezer', 'track', '999')`).run();
  db.prepare(`INSERT INTO TrackFiles (file_path, filename, provider_item_id) VALUES ('/music/1.flac', '1.flac', 77)`).run();

  migrateTrackFileSource(db);

  const row = db.prepare("SELECT source_provider, provider_item_id FROM TrackFiles WHERE id = 1").get() as any;
  assert.equal(row.source_provider, "deezer");
  assert.equal(row.provider_item_id, 77);
});

test("migrateTrackFileSource backfills from AcquisitionPlanTracks and ProviderTrackMatches", () => {
  const db = setupTestDb();
  db.prepare(`INSERT INTO ProviderItems (id, provider, entity_type, provider_id) VALUES (88, 'spotify', 'track', 'spot-1')`).run();
  db.prepare(`INSERT INTO ProviderTrackMatches (id, provider_track_item_id, track_id, recording_id, match_state) VALUES (10, 88, 1001, 2001, 'accepted')`).run();
  db.prepare(`INSERT INTO AcquisitionPlans (id, provider) VALUES (1, 'spotify')`).run();
  db.prepare(`INSERT INTO AcquisitionPlanTracks (id, plan_id, track_id, provider_track_match_id) VALUES (1, 1, 1001, 10)`).run();

  db.prepare(`INSERT INTO TrackFiles (file_path, filename, track_id) VALUES ('/music/plan.flac', 'plan.flac', 1001)`).run();

  migrateTrackFileSource(db);

  const row = db.prepare("SELECT source_provider, provider_item_id FROM TrackFiles WHERE id = 1").get() as any;
  assert.equal(row.source_provider, "spotify");
  assert.equal(row.provider_item_id, 88);
});

test("migrateTrackFileSource sets unknown for files with no source evidence", () => {
  const db = setupTestDb();
  db.prepare(`INSERT INTO TrackFiles (file_path, filename) VALUES ('/music/mystery.flac', 'mystery.flac')`).run();

  migrateTrackFileSource(db);

  const row = db.prepare("SELECT source_provider FROM TrackFiles WHERE id = 1").get() as any;
  assert.equal(row.source_provider, "unknown");
});

test("migrateTrackFileSource preserves existing source_provider and is idempotent", () => {
  const db = setupTestDb();
  migrateTrackFileSource(db);

  db.prepare(`INSERT INTO TrackFiles (file_path, filename, source_provider) VALUES ('/music/ext.flac', 'ext.flac', 'external')`).run();

  migrateTrackFileSource(db);

  const row = db.prepare("SELECT source_provider FROM TrackFiles WHERE id = 1").get() as any;
  assert.equal(row.source_provider, "external");
});
