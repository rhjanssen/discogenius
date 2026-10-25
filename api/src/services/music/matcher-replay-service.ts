import { db, withSqliteWriteGate } from "../../database.js";
import { jsonList, SQL_JSON_LIST } from "../../utils/sql-id-list.js";
import { yieldToEventLoop } from "../../utils/concurrent.js";
import {
  ProviderReleaseIngestionService,
  type StoredReplayPlan,
} from "../providers/provider-release-ingestion-service.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";
import { replanMonitoredEditions, type MonitoredEditionRef } from "./acquisition-planning-service.js";

/**
 * How many provider releases one write-gate section commits.
 *
 * Matching runs outside the gate. Six releases keeps the commit, the stale
 * retire, and the replan of those editions inside one short transaction.
 */
export const MATCHER_REPLAY_BATCH_RELEASES = 6;

const MATCH_SCAN_LIMIT = 2_000;
const RETRY_MS = 5_000;

const failedReleaseIds = new Set<number>();
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
  return jsonList([...failedReleaseIds]);
}

/**
 * Monitored editions that still owe a download go first, so Download Missing
 * converges before the rest of the catalogue.
 */
function selectPriorityReleaseIds(limit: number): number[] {
  return (db.prepare(`
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
    WHERE ${staleMatchSql("")}
      AND NOT EXISTS (
        SELECT 1 FROM TrackFiles file
        WHERE file.library_id = monitored.library_id
          AND file.album_edition_id = monitored.edition_id
          AND file.track_id = track.id
          AND file.file_class = 'audio'
      )
    LIMIT ?
  `).all(
    PROVIDER_TRACK_MATCHER_VERSION,
    excludedReleaseIds(),
    limit,
  ) as Array<{ release_item_id: number }>).map((row) => row.release_item_id);
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
export async function replayMatcherVersionBatch(options?: { limit?: number }): Promise<number> {
  const limit = Math.max(1, options?.limit ?? MATCHER_REPLAY_BATCH_RELEASES);
  const priorityIds = selectPriorityReleaseIds(limit);
  const peeked = priorityIds.length > 0
    ? null
    : peekCursorReleaseIds(limit);
  const releaseIds = priorityIds.length > 0 ? priorityIds : peeked?.ids ?? [];
  if (releaseIds.length === 0) {
    if (matchCursor !== 0 && countStaleAutomaticMatches() > failedReleaseIds.size) {
      matchCursor = 0;
    }
    return 0;
  }

  const service = new ProviderReleaseIngestionService(db);
  const plans: StoredReplayPlan[] = [];
  for (const releaseId of releaseIds) {
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
    if (peeked) matchCursor = peeked.nextCursor;
    return 0;
  }

  const replan: MonitoredEditionRef[] = [];
  await withSqliteWriteGate(() => {
    const run = db.transaction(() => {
      for (const plan of plans) {
        const save = db.transaction(() => {
          const committed = service.commitStoredReplay(plan);
          replan.push(...committed.replan);
        });
        try {
          save();
        } catch (error) {
          failedReleaseIds.add(plan.providerEditionItemId);
          console.warn(
            `[matcher-replay] commit failed for provider release ${plan.providerEditionItemId}:`,
            error,
          );
        }
      }
      replanMonitoredEditions(db, replan);
    });
    run();
  }, "matcher-replay:batch");

  if (peeked) matchCursor = peeked.nextCursor;
  return plans.length - plans.filter((plan) => failedReleaseIds.has(plan.providerEditionItemId)).length;
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
  matchCursor = 0;
  started = false;
}
