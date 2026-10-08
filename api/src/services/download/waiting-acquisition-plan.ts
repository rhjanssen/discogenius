import type Database from "better-sqlite3";
import type { AcquisitionWaitReason } from "../music/acquisition-download-command.js";

interface PlanIntent {
  library_id: number;
  release_mbid: string;
  provider: string;
}

/** A regenerated plan may replace a waiting plan only within its exact request.
 * Album identity and stereo/spatial slot do not identify a library or edition. */
export function resolveWaitingAcquisitionPlan(
  db: Database.Database,
  planId: number,
  payload: Record<string, unknown>,
  provider: string | null,
): number | null {
  const result = evaluateWaitingAcquisitionPlan(db, planId, payload, provider);
  return result.status === "ready" ? result.planId : null;
}

export function evaluateWaitingAcquisitionPlan(
  db: Database.Database,
  planId: number,
  payload: Record<string, unknown>,
  provider: string | null,
): { status: "ready"; planId: number } | { status: "blocked"; reason: AcquisitionWaitReason } {
  const previous = db.prepare(`
    SELECT plan.library_id, edition.mbid AS release_mbid, plan.provider
    FROM AcquisitionPlans plan
    JOIN AlbumEditions edition ON edition.id = plan.edition_id
    WHERE plan.id = ?
  `).get(planId) as PlanIntent | undefined;
  const libraryId = payload.libraryId ?? previous?.library_id;
  const releaseMbid = payload.releaseMbid ?? previous?.release_mbid;
  const requestedProvider = provider ?? payload.provider ?? previous?.provider;
  if (typeof libraryId !== "number" || !Number.isSafeInteger(libraryId) || libraryId <= 0
    || typeof releaseMbid !== "string" || !releaseMbid.trim()
    || typeof requestedProvider !== "string" || !requestedProvider.trim()) return { status: "blocked", reason: "request_identity_conflict" };
  if (previous && (previous.library_id !== libraryId || previous.release_mbid !== releaseMbid
    || previous.provider !== requestedProvider)) return { status: "blocked", reason: "request_identity_conflict" };
  if (payload.provider != null && payload.provider !== requestedProvider) return { status: "blocked", reason: "request_identity_conflict" };
  const library = db.prepare("SELECT enabled FROM Libraries WHERE id=?").get(libraryId) as {enabled:number}|undefined;
  if (!library) return { status: "blocked", reason: "request_identity_conflict" };
  if (!library.enabled) return { status: "blocked", reason: "library_disabled" };

  const selected = db.prepare(`
    SELECT plan.id, plan.state
    FROM SelectedAcquisitionPlans plan
    JOIN AlbumEditions edition ON edition.id = plan.edition_id
    JOIN Libraries library ON library.id = plan.library_id
    WHERE plan.library_id = ? AND edition.mbid = ? AND plan.provider = ?
      AND library.enabled = 1
  `).all(libraryId, releaseMbid, requestedProvider) as Array<{ id: number; state:string }>;
  if (selected.length > 1) return { status: "blocked", reason: "ambiguous_offer" };
  if (selected.length === 0) return { status: "blocked", reason: "offer_unavailable" };
  if (selected[0].state !== 'current') return { status: "blocked", reason: selected[0].state === 'stale' ? "offer_refresh_required" : "offer_unavailable" };
  return { status: "ready", planId: selected[0].id };
}
