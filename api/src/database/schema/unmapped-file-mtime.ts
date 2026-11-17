import type Database from "better-sqlite3";

/**
 * Migration: unmapped-file-mtime
 *
 * #124 added `UnmappedFiles.file_mtime_ms` to the baseline schema only, so a
 * database created before it lacks the column and the library scan fails on
 * it. Additive nullable column, no user_version bump. Idempotent.
 */
export function migrateUnmappedFileMtime(db: Database.Database): void {
  const hasTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'UnmappedFiles'").get(),
  );
  if (!hasTable) return;
  const columns = db.prepare("PRAGMA table_info(UnmappedFiles)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "file_mtime_ms")) {
    db.exec("ALTER TABLE UnmappedFiles ADD COLUMN file_mtime_ms REAL");
  }
}
