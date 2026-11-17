import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateUnmappedFileMtime } from "./unmapped-file-mtime.js";

const columnsOf = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(UnmappedFiles)").all() as Array<{ name: string }>).map((column) => column.name);

test("adds file_mtime_ms to an UnmappedFiles table created before #124, idempotently", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE UnmappedFiles (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, file_size INT)");
  db.prepare("INSERT INTO UnmappedFiles(file_path, file_size) VALUES ('/music/a.flac', 1)").run();

  migrateUnmappedFileMtime(db);
  migrateUnmappedFileMtime(db);

  assert.ok(columnsOf(db).includes("file_mtime_ms"));
  const row = db.prepare("SELECT file_size, file_mtime_ms FROM UnmappedFiles").get() as { file_size: number; file_mtime_ms: number | null };
  assert.deepEqual(row, { file_size: 1, file_mtime_ms: null });
});

test("does nothing when UnmappedFiles does not exist yet", () => {
  const db = new Database(":memory:");
  migrateUnmappedFileMtime(db);
  assert.equal(columnsOf(db).length, 0);
});
