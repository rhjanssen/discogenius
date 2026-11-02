import { db, withSqliteWriteGate } from "../../database.js";
import { jsonList, SQL_JSON_LIST } from "../../utils/sql-id-list.js";
import { yieldToEventLoop } from "../../utils/concurrent.js";
import {
  ProviderReleaseIngestionService,
  type StoredReplayPlan,
} from "../providers/provider-release-ingestion-service.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";
import {
  ACQUISITION_PLANNER_VERSION,
  getAcquisitionProviderPriority,
  previewEditionPolicyHashes,
  replanMonitoredEditions,
  type MonitoredEditionRef,
} from "./acquisition-planning-service.js";
import {
  AcquisitionPlanInUseError,
  assertAcquisitionPlansQuiescent,
} from "./acquisition-plan-ownership.js";

/**
 * How many provider releases one scheduling pass prepares.
 *
 * Each release then commits in its own write-gate transaction. One plan owned
 * by a download defers that release only, and a version-only bump does not
 * rebuild the plan inside the gate.
 */
export const MATCHER_REPLAY_BATCH_RELEASES = 6;

const MATCH_SCAN_LIMIT = 2_000;
const RETRY_MS = 5_000;

const failedReleaseIds = new Set<number>();
/** In-use plans retry after the rest of the walk, not for the process lifetime. */
const deferredInUseReleaseIds = new Set<number>();
/** Priority ids already committed. The cached list is not re-queried. */
const consumedPriorityReleaseIds = new Set<number>();
let cachedPriorityReleaseIds: number[] | null = null;
let matchCursor = 0;
let started = false;

function staleMatchSql(extra: string): string {
  return `
    track_match.decision_source = 'automatic'
    AND track_match.matcher_version < ?
    AND edition_match.provider_edition_item_id NOT IN ${SQL_JSON_LIST}
    ${extra}
  `;
}

export function countStaleAutomaticMatches(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ProviderTrackMatches
    WHERE decision_source = 'automatic'
      AND matcher_version < ?
  `).get(PROVIDER_TRACK_MATCHER_VERSION) as { n: number };
  return row.n;
}

function excludedReleaseIds(): string {
  return jsonList([...failedReleaseIds, ...deferredInUseReleaseIds]);
}

/**
 * Monitored editions that still owe a download go first, so Download Missing
 * converges before the rest of the catalogue.
 *
 * The join is cached for the process. It also matched when nothing was
 * prioritised, and repeating it on every batch kept the event loop busy for
 * the whole walk. Filtering deferred, failed, and already committed ids is
 * in memory. A `(decision_source, matcher_version)` index would be built at
 * startup against the track-match table, which is the cost this avoids.
 */
function loadPriorityReleaseIds(): number[] {
  if (cachedPriorityReleaseIds != null) return cachedPriorityReleaseIds;
  cachedPriorityReleaseIds = (db.prepare(`
    SELECT DISTINCT edition_match.provider_edition_item_id AS release_item_id
    FROM LibraryEditions monitored
    JOIN Tracks track ON track.album_edition_id = monitored.edition_id
    JOIN Recordings recording
      ON recording.id = track.recording_id
     AND recording.is_video = 0
    JOIN ProviderEditionMatches edition_match
      ON edition_match.edition_id = monitored.edition_id
     AND edition_match.match_state = 'accepted'
    JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_match_id = edition_match.id
    WHERE track_match.decision_source = 'automatic'
      AND track_match.matcher_version < ?
      AND NOT EXISTS (
        SELECT 1 FROM TrackFiles file
        WHERE file.library_id = monitored.library_id
          AND file.album_edition_id = monitored.edition_id
          AND file.track_id = track.id
          AND file.file_class = 'audio'
      )
  `).all(PROVIDER_TRACK_MATCHER_VERSION) as Array<{ release_item_id: number }>)
    .map((row) => row.release_item_id);
  return cachedPriorityReleaseIds;
}

function takePriorityReleaseIds(limit: number): number[] {
  const excluded = new Set<number>([
    ...failedReleaseIds,
    ...deferredInUseReleaseIds,
    ...consumedPriorityReleaseIds,
  ]);
  const ids: number[] = [];
  for (const id of loadPriorityReleaseIds()) {
    if (excluded.has(id)) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function acquisitionPlanIdsTouchedByRelease(releaseItemId: number): number[] {
  return (db.prepare(`
    SELECT plan.id AS id
    FROM AcquisitionPlans plan
    JOIN LibraryEditions monitored
      ON monitored.library_id = plan.library_id
     AND monitored.edition_id = plan.edition_id
    JOIN ProviderEditionMatches edition_match
      ON edition_match.edition_id = plan.edition_id
     AND edition_match.provider_edition_item_id = ?
    UNION
    SELECT source.plan_id AS id
    FROM AcquisitionPlanSources source
    JOIN ProviderEditionMatches edition_match
      ON edition_match.id = source.provider_edition_match_id
    WHERE edition_match.provider_edition_item_id = ?
    UNION
    SELECT plan_track.plan_id AS id
    FROM AcquisitionPlanTracks plan_track
    JOIN ProviderTrackMatches track_match
      ON track_match.id = plan_track.provider_track_match_id
    JOIN ProviderEditionMatches edition_match
      ON edition_match.id = track_match.provider_edition_match_id
    WHERE edition_match.provider_edition_item_id = ?
  `).all(releaseItemId, releaseItemId, releaseItemId) as Array<{ id: number }>)
    .map((row) => row.id);
}

function monitoredEditionsForReplay(releaseItemId: number): MonitoredEditionRef[] {
  return db.prepare(`
    SELECT DISTINCT library_edition.library_id AS libraryId,
      library_edition.edition_id AS editionId
    FROM LibraryEditions library_edition
    JOIN ProviderEditionMatches edition_match
      ON edition_match.edition_id = library_edition.edition_id
    WHERE edition_match.provider_edition_item_id = ?
  `).all(releaseItemId) as MonitoredEditionRef[];
}

function plansAcceptHash(libraryId: number, editionId: number, hashBefore: string): boolean {
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN planner_version = ? AND policy_hash = ? AND state = 'current' THEN 1 ELSE 0 END) AS matching
    FROM AcquisitionPlans
    WHERE library_id = ? AND edition_id = ?
  `).get(ACQUISITION_PLANNER_VERSION, hashBefore, libraryId, editionId) as {
    total: number;
    matching: number | null;
  };
  if (!summary || summary.total === 0) return true;
  return Number(summary.matching ?? 0) === summary.total;
}

/**
 * One release, one transaction. An in-use plan throws before any write so the
 * caller can defer that release without rolling back its neighbours.
 * Unchanged assignments bump `matcher_version` and the plan hash only.
 */
async function commitReplayRelease(
  service: ProviderReleaseIngestionService,
  plan: StoredReplayPlan,
): Promise<void> {
  const unchanged = service.storedReplayAssignmentsUnchanged(plan);
  const bumpedIds = unchanged ? service.staleAutomaticMatchIds(plan) : [];
  const bumped = new Set(bumpedIds);
  const providerPriority = unchanged ? getAcquisitionProviderPriority() : [];
  const previews = unchanged
    ? monitoredEditionsForReplay(plan.providerEditionItemId).map((edition) => ({
      edition,
      preview: previewEditionPolicyHashes(db, {
        libraryId: edition.libraryId,
        editionId: edition.editionId,
        providerPriority,
        bumpedTrackMatchIds: bumped,
        nextMatcherVersion: plan.matcherVersion,
      }),
    }))
    : null;
  const fastPathReady = previews != null && previews.every((entry) => entry.preview != null);

  await withSqliteWriteGate(() => {
    const run = db.transaction(() => {
      assertAcquisitionPlansQuiescent(db, acquisitionPlanIdsTouchedByRelease(plan.providerEditionItemId));
      const stillUnchanged = service.storedReplayAssignmentsUnchanged(plan);
      const insideIds = stillUnchanged ? service.staleAutomaticMatchIds(plan) : [];
      const sameIds = insideIds.length === bumpedIds.length
        && insideIds.every((id, index) => id === bumpedIds[index]);
      const hashesMatch = fastPathReady && previews != null && previews.every((entry) =>
        entry.preview != null
        && plansAcceptHash(entry.edition.libraryId, entry.edition.editionId, entry.preview.hashBefore),
      );
      if (stillUnchanged && sameIds && hashesMatch && previews) {
        service.bumpStoredReplayVersion(plan);
        const updateHash = db.prepare(`
          UPDATE AcquisitionPlans
          SET policy_hash = ?, updated_at = CURRENT_TIMESTAMP
          WHERE library_id = ? AND edition_id = ? AND state = 'current'
        `);
        for (const entry of previews) {
          if (!entry.preview || entry.preview.hashBefore === entry.preview.hashAfter) continue;
          const existing = db.prepare(`
            SELECT COUNT(*) AS n FROM AcquisitionPlans
            WHERE library_id = ? AND edition_id = ?
          `).get(entry.edition.libraryId, entry.edition.editionId) as { n: number };
          if (existing.n === 0) continue;
          updateHash.run(entry.preview.hashAfter, entry.edition.libraryId, entry.edition.editionId);
        }
        return;
      }
      const committed = service.commitStoredReplay(plan);
      replanMonitoredEditions(db, committed.replan);
    });
    run();
  }, "matcher-replay:release");
}

function peekCursorReleaseIds(limit: number): { ids: number[]; nextCursor: number } {
  const rows = db.prepare(`
    SELECT track_match.id AS match_id,
           edition_match.provider_edition_item_id AS release_item_id
    FROM ProviderTrackMatches track_match
    JOIN ProviderEditionMatches edition_match
      ON edition_match.id = track_match.provider_edition_match_id
    WHERE track_match.id > ?
      AND ${staleMatchSql("")}
    ORDER BY track_match.id
    LIMIT ?
  `).all(
    matchCursor,
    PROVIDER_TRACK_MATCHER_VERSION,
    excludedReleaseIds(),
    MATCH_SCAN_LIMIT,
  ) as Array<{ match_id: number; release_item_id: number }>;

  const ids: number[] = [];
  const seen = new Set<number>();
  let nextCursor = matchCursor;
  for (const row of rows) {
    if (!seen.has(row.release_item_id)) {
      if (seen.size >= limit) break;
      seen.add(row.release_item_id);
      ids.push(row.release_item_id);
    }
    nextCursor = row.match_id;
  }
  if (rows.length > 0 && ids.length === 0) {
    nextCursor = rows[rows.length - 1].match_id;
  }
  return { ids, nextCursor };
}

/**
 * Replay one batch of stored automatic matches at the current matcher version.
 *
 * Restart-safe: the cursor is the set of automatic rows still older than the
 * current version, walked by primary key. A second pass is a no-op. One
 * failure is remembered for this process and skipped; the next boot tries it
 * again. Returns how many releases were committed.
 */
function selectReplayReleaseIds(limit: number): {
  ids: number[];
  peeked: { ids: number[]; nextCursor: number } | null;
} {
  const priorityIds = takePriorityReleaseIds(limit);
  if (priorityIds.length > 0) return { ids: priorityIds, peeked: null };
  const peeked = peekCursorReleaseIds(limit);
  return { ids: peeked.ids, peeked };
}

export async function replayMatcherVersionBatch(options?: { limit?: number }): Promise<number> {
  const limit = Math.max(1, options?.limit ?? MATCHER_REPLAY_BATCH_RELEASES);
  let selection = selectReplayReleaseIds(limit);
  if (
    selection.ids.length === 0
    && deferredInUseReleaseIds.size > 0
    && countStaleAutomaticMatches() > failedReleaseIds.size
  ) {
    // The walk passed every release that was free to commit. Try the ones a
    // download was holding, once. Do not loop inside this pass.
    deferredInUseReleaseIds.clear();
    matchCursor = 0;
    selection = selectReplayReleaseIds(limit);
  }
  if (selection.ids.length === 0) {
    if (matchCursor !== 0 && countStaleAutomaticMatches() > failedReleaseIds.size) {
      matchCursor = 0;
    }
    return 0;
  }

  const service = new ProviderReleaseIngestionService(db);
  const plans: StoredReplayPlan[] = [];
  for (const releaseId of selection.ids) {
    await yieldToEventLoop();
    try {
      const plan = service.prepareStoredReplay(releaseId);
      if (plan) {
        plans.push(plan);
      } else {
        // Not a stored release. Remember it so a bad id cannot pin the
        // priority walk and starve the rest of the catalogue.
        failedReleaseIds.add(releaseId);
      }
    } catch (error) {
      failedReleaseIds.add(releaseId);
      console.warn(`[matcher-replay] prepare failed for provider release ${releaseId}:`, error);
    }
  }
  if (plans.length === 0) {
    if (selection.peeked) matchCursor = selection.peeked.nextCursor;
    return 0;
  }

  let committed = 0;
  for (const plan of plans) {
    await yieldToEventLoop();
    try {
      await commitReplayRelease(service, plan);
      consumedPriorityReleaseIds.add(plan.providerEditionItemId);
      committed += 1;
    } catch (error) {
      if (error instanceof AcquisitionPlanInUseError) {
        deferredInUseReleaseIds.add(plan.providerEditionItemId);
        console.warn(
          `[matcher-replay] deferring provider release ${plan.providerEditionItemId}:`,
          error.message,
        );
        continue;
      }
      failedReleaseIds.add(plan.providerEditionItemId);
      console.warn(
        `[matcher-replay] commit failed for provider release ${plan.providerEditionItemId}:`,
        error,
      );
    }
  }

  if (selection.peeked) matchCursor = selection.peeked.nextCursor;
  return committed;
}

function schedule(delayMs: number): void {
  const timer = setTimeout(() => {
    void runStoredMatcherReplay();
  }, delayMs);
  timer.unref?.();
}

async function runStoredMatcherReplay(): Promise<void> {
  try {
    const committed = await replayMatcherVersionBatch();
    if (committed === 0 && countStaleAutomaticMatches() === 0) {
      console.log(
        `[matcher-replay] stored automatic matches are at matcher version ${PROVIDER_TRACK_MATCHER_VERSION}`,
      );
      return;
    }
    schedule(committed > 0 ? 0 : RETRY_MS);
  } catch (error) {
    console.warn("[matcher-replay] batch failed; retrying:", error);
    schedule(RETRY_MS);
  }
}

/**
 * Start the local matcher replay after listen. Does not block startup.
 * Set DISCOGENIUS_MATCHER_REPLAY=0 to leave stored rows for artist refresh.
 */
export function startStoredMatcherReplay(): void {
  if (started) return;
  if (process.env.DISCOGENIUS_MATCHER_REPLAY === "0") {
    console.log("[matcher-replay] disabled via DISCOGENIUS_MATCHER_REPLAY=0");
    return;
  }
  started = true;
  schedule(0);
}

/** Test hook. Production replay is process-lifetime and does not reset. */
export function resetStoredMatcherReplayForTests(): void {
  failedReleaseIds.clear();
  deferredInUseReleaseIds.clear();
  consumedPriorityReleaseIds.clear();
  cachedPriorityReleaseIds = null;
  matchCursor = 0;
  started = false;
}
