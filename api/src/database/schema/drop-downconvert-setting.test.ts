import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDropDownconvertSetting } from "./drop-downconvert-setting.js";

test("stored downconvert_existing_files key is removed and other settings kept", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO config VALUES ('settings.quality', ?)").run(
    JSON.stringify({ audio_quality: "max", downconvert_existing_files: true, upgrade_existing_files: true }),
  );
  migrateDropDownconvertSetting(db);
  migrateDropDownconvertSetting(db);
  const value = JSON.parse((db.prepare("SELECT value FROM config WHERE key='settings.quality'").get() as { value: string }).value);
  assert.deepEqual(value, { audio_quality: "max", upgrade_existing_files: true });
});

test("missing table or row is a no-op", () => {
  const db = new Database(":memory:");
  migrateDropDownconvertSetting(db);
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
  migrateDropDownconvertSetting(db);
});
