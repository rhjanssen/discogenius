import type Database from "better-sqlite3";

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
    || typeof requestedProvider !== "string" || !requestedProvider.trim()) return null;
  if (previous && (previous.library_id !== libraryId || previous.release_mbid !== releaseMbid
    || previous.provider !== requestedProvider)) return null;
  if (payload.provider != null && payload.provider !== requestedProvider) return null;

  const selected = db.prepare(`
    SELECT plan.id
    FROM SelectedAcquisitionPlans plan
    JOIN AlbumEditions edition ON edition.id = plan.edition_id
    JOIN Libraries library ON library.id = plan.library_id
    WHERE plan.library_id = ? AND edition.mbid = ? AND plan.provider = ?
      AND plan.state = 'current' AND library.enabled = 1
  `).all(libraryId, releaseMbid, requestedProvider) as Array<{ id: number }>;
  return selected.length === 1 ? selected[0].id : null;
}
