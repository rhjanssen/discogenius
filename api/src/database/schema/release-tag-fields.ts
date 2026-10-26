import type Database from "better-sqlite3";

/**
 * Release fields Picard writes that the catalogue did not store: catalog
 * numbers, ASIN, script, and language. Nullable columns only. user_version
 * stays 46 so a running or queued RetagArtist is not reset.
 */
export function migrateReleaseTagFields(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'AlbumEditions'").get();
  if (!table) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(AlbumEditions)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const name of ["catalog_numbers", "asin", "script", "language"]) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE AlbumEditions ADD COLUMN ${name} TEXT`);
    }
  }
}
