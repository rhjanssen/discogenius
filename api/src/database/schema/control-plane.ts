import type Database from "better-sqlite3";

/**
 * Durable operator controls that must survive page, worker, API, and container
 * restarts. These are deliberately separate from user preference/config
 * documents: a queue pause is live control-plane state, not a startup default.
 */
export function createRuntimeControlSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE runtime_controls (
      control_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
