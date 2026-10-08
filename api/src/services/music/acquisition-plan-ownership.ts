import type Database from "better-sqlite3";
import { persistedResourceAcquisitionPlanKey } from "./acquisition-plan-identity.js";

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

/** Preserve the exact waiting request before derived plan rows can disappear. */
export function prepareAcquisitionPlanMutation(db: Database.Database, planIds: readonly number[]): void {
  assertAcquisitionPlansQuiescent(db, planIds);
  const intent = db.prepare(`SELECT plan.library_id, plan.provider, edition.mbid AS release_mbid
    FROM AcquisitionPlans plan JOIN AlbumEditions edition ON edition.id=plan.edition_id WHERE plan.id=?`);
  const waiting = db.prepare("SELECT id,provider,payload FROM DownloadQueue WHERE plan_id=?");
  const sameIntent = db.prepare(`SELECT id,provider,payload FROM DownloadQueue
    WHERE command_id IS NULL AND json_valid(payload)
      AND json_extract(payload,'$.libraryId')=? AND json_extract(payload,'$.releaseMbid')=?
      AND COALESCE(provider,json_extract(payload,'$.provider'))=?`);
  const update = db.prepare("UPDATE DownloadQueue SET payload=?,updated_at=CURRENT_TIMESTAMP WHERE id=?");
  for (const planId of new Set(planIds)) {
    const plan = intent.get(planId) as { library_id: number; provider: string; release_mbid: string } | undefined;
    if (!plan) throw new Error(`Missing acquisition plan ${planId}`);
    const rows = [...waiting.all(planId), ...sameIntent.all(plan.library_id, plan.release_mbid, plan.provider)] as
      Array<{ id: number; provider: string | null; payload: string }>;
    for (const row of new Map(rows.map(row => [row.id, row])).values()) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || (row.provider != null && row.provider !== plan.provider)
        || (payload.libraryId != null && payload.libraryId !== plan.library_id)
        || (payload.releaseMbid != null && payload.releaseMbid !== plan.release_mbid)
        || (payload.provider != null && payload.provider !== plan.provider)) {
        throw new Error(`Conflicting acquisition intent for waiting request ${row.id}`);
      }
      const refreshedIntent = { ...payload, libraryId: plan.library_id,
        releaseMbid: plan.release_mbid, provider: plan.provider };
      // A dependency reason describes the previous evaluation. Changed source
      // facts require admission to evaluate it again, including while paused.
      delete (refreshedIntent as Record<string, unknown>).acquisitionWaitReason;
      update.run(JSON.stringify(refreshedIntent), row.id);
    }
    const key = persistedResourceAcquisitionPlanKey(db,planId);
    if (key) {
      const previous = db.prepare("SELECT library_id,edition_id,plan_key FROM AcquisitionPlans WHERE id=?").get(planId) as {library_id:number;edition_id:number;plan_key:string};
      db.prepare("UPDATE AcquisitionPlans SET plan_key=? WHERE id=?").run(key,planId);
      db.prepare("UPDATE LibraryEditions SET preferred_plan_key=? WHERE library_id=? AND edition_id=? AND preferred_plan_key=?")
        .run(key,previous.library_id,previous.edition_id,previous.plan_key);
    }
  }
}

/** Coverage is derived; plan/source identity and selected choice are durable. */
export function invalidateAcquisitionPlans(db: Database.Database, planIds: readonly number[]): void {
  prepareAcquisitionPlanMutation(db, planIds);
  const remove = db.prepare("DELETE FROM AcquisitionPlanTracks WHERE plan_id=?");
  const stale = db.prepare("UPDATE AcquisitionPlans SET state='stale',coverage=0,updated_at=CURRENT_TIMESTAMP WHERE id=?");
  for (const planId of new Set(planIds)) { remove.run(planId); stale.run(planId); }
}
