import type Database from "better-sqlite3";

/**
 * Additive restart-resume columns for file checkpoints.
 *
 * Name: file-work-restart-resume
 *
 * This is not a user_version bump. Opening a schema-46 database is the live
 * contract (`assertDatabaseVersionCanStart` refuses any other version), and the
 * first deploy of this code has to open the database a running retag already
 * wrote. Fresh databases get `restart_claims` from `createCommandFileWorkSchema`.
 * Existing databases gain it here.
 *
 * A plan row is inserted in the same transaction as every work row, by this
 * code and by the process that planned retag 19285. The row's existence is the
 * complete plan. There is no `plan_complete` flag to repair: startup leaves
 * that plan untouched and continues from its cursor.
 */
export const FILE_WORK_RESTART_RESUME_MIGRATION = "file-work-restart-resume";

const FILE_WORK_TABLES = ["CommandFileWorkPlans", "CommandFileWork", "CommandRenamePlans", "CommandRenameWork"] as const;
type FileWorkTable = (typeof FILE_WORK_TABLES)[number];

function tableExists(db: Database.Database, table: FileWorkTable): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db: Database.Database, table: FileWorkTable, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some(entry => entry.name === column);
}

function addColumn(
  db: Database.Database,
  table: FileWorkTable,
  column: string,
  definition: string,
  afterAdd?: () => void,
): void {
  if (!tableExists(db, table) || columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  afterAdd?.();
}

export function migrateFileWorkRestartResume(db: Database.Database): void {
  const apply = db.transaction(() => {
    addColumn(db, "CommandFileWork", "restart_claims", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "CommandRenameWork", "restart_claims", "INTEGER NOT NULL DEFAULT 0");
    const hasConfig = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get();
    if (hasConfig) {
      db.prepare(`
        INSERT INTO config (key, value, description)
        VALUES (?, 'applied', ?)
        ON CONFLICT(key) DO NOTHING
      `).run(
        `schema.migration.${FILE_WORK_RESTART_RESUME_MIGRATION}`,
        "File-work commands resume from CommandFileWork / CommandRenameWork after a process restart",
      );
    }
  });
  apply();
}
