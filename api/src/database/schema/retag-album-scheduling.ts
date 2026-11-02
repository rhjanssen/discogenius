import type Database from "better-sqlite3";

/**
 * Streaming retag/rename plans and the managed-tag fingerprint.
 *
 * Name: retag-album-scheduling
 *
 * This is not a user_version bump. Opening a schema-46 database is the live
 * contract, and this deploy has to open a database where RetagArtist 19285
 * (or any other file-checkpoint command) is queued or already checkpointed.
 *
 * `plan_complete` defaults to 1. The previous process inserted the plan row
 * and every work row in one transaction, so an existing plan is complete and
 * resume continues from its cursor. A fresh streaming plan sets the flag to 0
 * and appends one album at a time. Nothing here rewrites cursor, generation,
 * or work-row status.
 *
 * `managed_tag_fingerprint` copies a `retag:v1:` stamp out of `file_hash`
 * once, when the new column is empty. Later retags write the column and stop
 * writing that stamp into `file_hash`. A null fingerprint means "open the
 * file once"; it is not an error.
 */
export const RETAG_ALBUM_SCHEDULING_MIGRATION = "retag-album-scheduling";

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some(entry => entry.name === column);
}

function addColumn(db: Database.Database, table: string, column: string, definition: string): void {
  if (!tableExists(db, table) || columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateRetagAlbumScheduling(db: Database.Database): void {
  const apply = db.transaction(() => {
    addColumn(db, "CommandFileWorkPlans", "plan_complete", "INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "CommandRenamePlans", "plan_complete", "INTEGER NOT NULL DEFAULT 1");
    addColumn(db, "TrackFiles", "managed_tag_fingerprint", "TEXT");
    if (columnExists(db, "TrackFiles", "managed_tag_fingerprint") && columnExists(db, "TrackFiles", "file_hash")) {
      db.prepare(`
        UPDATE TrackFiles
        SET managed_tag_fingerprint = file_hash
        WHERE managed_tag_fingerprint IS NULL
          AND file_hash LIKE 'retag:v1:%'
      `).run();
    }
    const hasConfig = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get();
    if (hasConfig) {
      db.prepare(`
        INSERT INTO config (key, value, description)
        VALUES (?, 'applied', ?)
        ON CONFLICT(key) DO NOTHING
      `).run(
        `schema.migration.${RETAG_ALBUM_SCHEDULING_MIGRATION}`,
        "Retag and rename plans stream one album at a time; managed tag fingerprints skip unchanged files",
      );
    }
  });
  apply();
}
