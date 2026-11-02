import type Database from "better-sqlite3";

/**
 * Remove the retired `quality.downconvert_existing_files` switch from the
 * stored settings row. The audio/video quality setting is the only target now
 * (see decideImportedQuality); the normalizer already ignores the key, this
 * makes the stored row match. Idempotent, no user_version bump.
 */
export function migrateDropDownconvertSetting(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get();
  if (!table) return;
  const row = db.prepare("SELECT value FROM config WHERE key = 'settings.quality'").get() as { value: string } | undefined;
  if (!row) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || !("downconvert_existing_files" in parsed)) return;
  delete parsed.downconvert_existing_files;
  db.prepare("UPDATE config SET value = ? WHERE key = 'settings.quality'").run(JSON.stringify(parsed));
}
