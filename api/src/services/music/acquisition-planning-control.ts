import { randomUUID } from "node:crypto";
import { db } from "../../database.js";

const PROVIDER_PRIORITY_REVISION_KEY = "acquisition_provider_priority_revision";

export function getPendingAcquisitionPlanningRevision(): string | null {
  const row = db.prepare(`
    SELECT value
    FROM runtime_controls
    WHERE control_key = ?
  `).get(PROVIDER_PRIORITY_REVISION_KEY) as { value: string } | undefined;
  const value = String(row?.value || "").trim();
  return value || null;
}

/**
 * Record that acquisition plans should be rebuilt by the next curation pass.
 * Saving a preference must stay cheap even for a very large library.
 */
export function markAcquisitionPlanningStale(): string {
  const revision = randomUUID();
  db.prepare(`
    INSERT INTO runtime_controls (control_key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(control_key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(PROVIDER_PRIORITY_REVISION_KEY, revision);
  return revision;
}

/** Clear only the revision this curation run actually processed. */
export function clearAcquisitionPlanningRevision(revision: string): boolean {
  if (!revision) return false;
  return db.prepare(`
    DELETE FROM runtime_controls
    WHERE control_key = ? AND value = ?
  `).run(PROVIDER_PRIORITY_REVISION_KEY, revision).changes > 0;
}
