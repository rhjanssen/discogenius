import type Database from "better-sqlite3";

export class AcquisitionPlanInUseError extends Error {
  constructor(readonly planId: number) {
    super(`Acquisition plan ${planId} is owned by a download or import; defer source mutation until it finishes`);
    this.name = "AcquisitionPlanInUseError";
  }
}

/** A workflow owns its exact plan until its download/import claim is released.
 * Call inside the transaction that replaces derived plan rows or source matches. */
export function assertAcquisitionPlansQuiescent(db: Database.Database, planIds: readonly number[]): void {
  if (!db.inTransaction) throw new Error("Acquisition plan mutation requires an active transaction");
  const executing = db.prepare(`
    SELECT id FROM commands WHERE status IN ('queued','started')
      AND CAST(json_extract(payload,'$.acquisitionPlanId') AS INTEGER)=? LIMIT 1
  `);
  const claimed = db.prepare("SELECT id FROM DownloadQueue WHERE plan_id=? AND command_id IS NOT NULL LIMIT 1");
  for (const planId of new Set(planIds)) {
    if (!Number.isSafeInteger(planId) || planId <= 0) throw new Error("Invalid acquisition plan identity");
    if (executing.get(planId) || claimed.get(planId)) {
      throw new AcquisitionPlanInUseError(planId);
    }
  }
}
