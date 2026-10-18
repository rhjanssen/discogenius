import type Database from "better-sqlite3";

/**
 * Additive restart-resume columns for file checkpoints.
 *
 * Name: file-work-restart-resume
 *
 * This is not a user_version bump. Opening a schema-46 database is the live
 * contract (`assertDatabaseVersionCanStart` refuses any other version), and the
 * first deploy of this code has to open the database a running retag already
 * wrote. Fresh databases get the columns from `createCommandFileWorkSchema`.
 * Existing databases gain them here. A plan row that already exists was
 * inserted in one transaction with every work row, so it is complete.
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
    addColumn(db, "CommandFileWorkPlans", "plan_complete", "INTEGER NOT NULL DEFAULT 0", () => {
      db.prepare("UPDATE CommandFileWorkPlans SET plan_complete = 1").run();
    });
    addColumn(db, "CommandFileWork", "restart_claims", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "CommandRenamePlans", "plan_complete", "INTEGER NOT NULL DEFAULT 0", () => {
      db.prepare("UPDATE CommandRenamePlans SET plan_complete = 1").run();
    });
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
