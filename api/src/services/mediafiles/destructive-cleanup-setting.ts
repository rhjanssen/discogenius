import { db, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";

export const DESTRUCTIVE_CLEANUP_CONTROL_KEY = "housekeeping.destructive_mode";

let overrideEnabled: boolean | null = null;

export function setDestructiveCleanupOverride(enabled: boolean | null): void {
  overrideEnabled = enabled;
}

export function isDestructiveCleanupEnabled(): boolean {
  if (overrideEnabled !== null) return overrideEnabled;
  if (process.env.DISCOGENIUS_DESTRUCTIVE_CLEANUP === "true") return true;
  if (process.env.DISCOGENIUS_DESTRUCTIVE_CLEANUP === "false") return false;

  try {
    const monitoring = getConfigSection("monitoring") as unknown as Record<string, unknown> | undefined;
    if (monitoring?.enable_destructive_cleanup === true) return true;
  } catch {
    // Config not yet initialized
  }

  try {
    const row = db.prepare(`
      SELECT value FROM runtime_controls WHERE control_key = ?
    `).get(DESTRUCTIVE_CLEANUP_CONTROL_KEY) as { value: string } | undefined;
    if (row?.value) {
      return row.value === "true" || row.value === "1";
    }
  } catch {
    // Database or table not ready
  }

  return false;
}

export async function setDestructiveCleanupEnabled(enabled: boolean): Promise<void> {
  overrideEnabled = enabled;
  await withSqliteWriteGate(() => {
    db.prepare(`
      INSERT INTO runtime_controls (control_key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(control_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(DESTRUCTIVE_CLEANUP_CONTROL_KEY, enabled ? "true" : "false");
  }, "config:destructive-cleanup-mode");
}
