import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDeliveredQuality } from "./delivered-quality.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ProviderItemAudioVariants (
      id INTEGER PRIMARY KEY, provider_item_id INTEGER, quality_class TEXT,
      provider_quality_label TEXT, delivered_quality_class TEXT, updated_at TEXT);
    CREATE TABLE TrackFiles (id INTEGER PRIMARY KEY, source_audio_variant_id INTEGER, provider_item_id INTEGER,
      source_quality TEXT, imported_quality TEXT, quality TEXT);
    CREATE TABLE AcquisitionPlanTracks (id INTEGER PRIMARY KEY, provider_audio_variant_id INTEGER,
      source_quality_snapshot TEXT, updated_at TEXT);
  `);
  return db;
}

test("delivered quality is stored separately and the advertised class stays as offered", () => {
  const db = setup();
  db.exec(`
    INSERT INTO ProviderItemAudioVariants(id, provider_item_id, quality_class, provider_quality_label)
      VALUES (1, 10, 'hires-lossless', 'HIRES_LOSSLESS'), (2, 20, 'lossless', 'LOSSLESS');
    INSERT INTO TrackFiles(id, source_audio_variant_id, provider_item_id, source_quality)
      VALUES (1, 1, 10, 'LOSSLESS'), (2, 2, 20, 'LOSSLESS');
    INSERT INTO AcquisitionPlanTracks(id, provider_audio_variant_id, source_quality_snapshot)
      VALUES (1, 1, '{"quality":"hires-lossless"}');
  `);
  migrateDeliveredQuality(db);
  assert.deepEqual(db.prepare("SELECT id, quality_class, delivered_quality_class FROM ProviderItemAudioVariants ORDER BY id").all(), [
    { id: 1, quality_class: "hires-lossless", delivered_quality_class: "lossless" },
    { id: 2, quality_class: "lossless", delivered_quality_class: null },
  ]);
  assert.equal((db.prepare("SELECT source_quality_snapshot AS s FROM AcquisitionPlanTracks").get() as { s: string }).s,
    '{"quality":"hires-lossless"}');
});

test("an earlier overwrite of quality_class with the measurement is repaired", () => {
  const db = setup();
  db.exec(`
    INSERT INTO ProviderItemAudioVariants(id, provider_item_id, quality_class, provider_quality_label, delivered_quality_class)
      VALUES (1, 10, 'lossless', 'HIRES_LOSSLESS', 'lossless'),
             (2, 20, 'lossy', 'LOSSLESS', 'lossy'),
             (3, 30, 'lossy', 'HIGH', 'lossy');
  `);
  migrateDeliveredQuality(db);
  migrateDeliveredQuality(db);
  assert.deepEqual(db.prepare("SELECT id, quality_class, delivered_quality_class FROM ProviderItemAudioVariants ORDER BY id").all(), [
    { id: 1, quality_class: "hires-lossless", delivered_quality_class: "lossless" },
    { id: 2, quality_class: "lossless", delivered_quality_class: "lossy" },
    { id: 3, quality_class: "lossy", delivered_quality_class: "lossy" },
  ]);
});
