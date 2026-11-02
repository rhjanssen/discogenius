import type Database from "better-sqlite3";

/**
 * Provider login state. One row per download provider.
 *
 * Name: provider-auth-state
 *
 * This is not a user_version bump. Opening a schema-46 database is the live
 * contract (`assertDatabaseVersionCanStart` refuses any other version). A
 * running or queued RetagArtist keeps its CommandFileWork rows; this migration
 * only creates a new table and a config marker. user_version stays 46.
 */
export const PROVIDER_AUTH_STATE_MIGRATION = "provider-auth-state";

export function createProviderAuthStateSchema(
  db: Database.Database,
  options: { ifNotExists?: boolean } = {},
): void {
  const ifNotExists = options.ifNotExists ? "IF NOT EXISTS" : "";
  db.exec(`
    CREATE TABLE ${ifNotExists} ProviderAuthState (
      provider TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('ok', 'needs_reauth', 'unknown')),
      last_ok_at TEXT,
      last_error TEXT,
      since TEXT,
      notified_status TEXT,
      account_label TEXT,
      credential_saved_at TEXT,
      last_probe_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function migrateProviderAuthState(db: Database.Database): void {
  const apply = db.transaction(() => {
    createProviderAuthStateSchema(db, { ifNotExists: true });
    const hasConfig = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get();
    if (!hasConfig) return;
    db.prepare(`
      INSERT INTO config (key, value, description)
      VALUES (?, 'applied', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(
      `schema.migration.${PROVIDER_AUTH_STATE_MIGRATION}`,
      "Provider auth is ok, needs_reauth, or unknown. Downloads for a provider that needs login are held.",
    );
  });
  apply();
}
