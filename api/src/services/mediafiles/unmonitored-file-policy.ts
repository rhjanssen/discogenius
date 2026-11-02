import type Database from "better-sqlite3";
import { PROVIDER_TRACK_MATCHER_VERSION } from "../music/provider-track-matcher.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";

/**
 * Which unmonitored library files a delete pass may remove.
 *
 * Classification (`selectUnmonitoredFileRows`) still decides the candidate
 * set. This policy decides the delete:
 * - a user unmonitor deletes that album's mapped files immediately;
 * - curation deletes a file only when the same recording already sits on a
 *   monitored edition;
 * - a stale automatic match never justifies a curation delete;
 * - a file with no edition, release group, or canonical release is never deleted.
 */

export interface UnmonitoredFileDeleteOptions {
  mode: "coverage" | "immediate";
  releaseGroupIds?: readonly number[];
  editionIds?: readonly number[];
  recordingIds?: readonly number[];
  dryRun?: boolean;
}

export interface UnmonitoredFileDecision {
  id: number;
  filePath: string;
  delete: boolean;
  reason: string;
}

interface PolicyRow {
  id: number;
  file_path: string;
  release_group_id: number | null;
  album_edition_id: number | null;
  recording_id: number | null;
  canonical_recording_mbid: string | null;
  canonical_release_mbid: string | null;
  stale: number;
  covering_title: string | null;
}

export function classifyUnmonitoredFileDeletes(
  database: Database.Database,
  fileIds: readonly number[],
  options: UnmonitoredFileDeleteOptions,
): UnmonitoredFileDecision[] {
  if (fileIds.length === 0) return [];
  const releaseGroups = options.releaseGroupIds ? new Set(options.releaseGroupIds) : null;
  const editions = options.editionIds ? new Set(options.editionIds) : null;
  const recordingIds = options.recordingIds ? new Set(options.recordingIds) : null;
  const recordingMbids = recordingIds
    ? new Set((database.prepare(`
        SELECT mbid FROM Recordings
        WHERE id IN ${SQL_JSON_LIST} AND mbid IS NOT NULL AND TRIM(mbid) != ''
      `).all(jsonList(Array.from(recordingIds))) as Array<{ mbid: string }>).map((row) => row.mbid))
    : null;

  const rows = database.prepare(`
    SELECT
      file.id,
      file.file_path,
      file.release_group_id,
      file.album_edition_id,
      file.recording_id,
      file.canonical_recording_mbid,
      file.canonical_release_mbid,
      CASE WHEN file.album_edition_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM Tracks track
        JOIN ProviderTrackMatches match
          ON match.track_id = track.id
         AND match.match_state = 'accepted'
         AND match.decision_source = 'automatic'
         AND match.matcher_version < ?
        WHERE track.album_edition_id = file.album_edition_id
      ) THEN 1 ELSE 0 END AS stale,
      (
        SELECT covering_edition.title
        FROM TrackFiles covered
        JOIN LibraryEditions monitored
          ON monitored.library_id = covered.library_id
         AND monitored.edition_id = covered.album_edition_id
        JOIN AlbumEditions covering_edition ON covering_edition.id = covered.album_edition_id
        WHERE covered.id != file.id
          AND covered.library_id = file.library_id
          AND covered.album_edition_id IS NOT NULL
          AND (
            (file.recording_id IS NOT NULL AND covered.recording_id = file.recording_id)
            OR (
              file.canonical_recording_mbid IS NOT NULL
              AND TRIM(file.canonical_recording_mbid) != ''
              AND covered.canonical_recording_mbid = file.canonical_recording_mbid
            )
          )
        LIMIT 1
      ) AS covering_title
    FROM TrackFiles file
    WHERE file.id IN ${SQL_JSON_LIST}
  `).all(PROVIDER_TRACK_MATCHER_VERSION, jsonList(fileIds)) as PolicyRow[];

  const decisions: UnmonitoredFileDecision[] = [];
  for (const row of rows) {
    if (releaseGroups && (row.release_group_id == null || !releaseGroups.has(row.release_group_id))) continue;
    if (editions && (row.album_edition_id == null || !editions.has(row.album_edition_id))) continue;
    if (recordingIds && !recordingHit(row, recordingIds, recordingMbids)) continue;

    const unmapped = row.album_edition_id == null
      && row.release_group_id == null
      && !String(row.canonical_release_mbid || "").trim();
    const hasRecording = row.recording_id != null
      || String(row.canonical_recording_mbid || "").trim() !== "";
    let decision: UnmonitoredFileDecision;
    if (unmapped) {
      decision = { id: row.id, filePath: row.file_path, delete: false, reason: "unmapped file" };
    } else if (options.mode === "coverage" && row.stale === 1) {
      decision = { id: row.id, filePath: row.file_path, delete: false, reason: "stale automatic match" };
    } else if (options.mode === "immediate") {
      decision = { id: row.id, filePath: row.file_path, delete: true, reason: "unmonitored by you" };
    } else if (!hasRecording) {
      decision = { id: row.id, filePath: row.file_path, delete: false, reason: "no recording identity" };
    } else if (!row.covering_title) {
      decision = {
        id: row.id,
        filePath: row.file_path,
        delete: false,
        reason: "recording is not in a monitored edition",
      };
    } else {
      decision = {
        id: row.id,
        filePath: row.file_path,
        delete: true,
        reason: `recording already in ${row.covering_title}`,
      };
    }
    const verb = options.dryRun ? "dry-run" : (decision.delete ? "delete" : "keep");
    console.log(`[unmonitored-files] ${verb} ${decision.filePath} — ${decision.reason}`);
    decisions.push(decision);
  }
  return decisions;
}

function recordingHit(
  row: PolicyRow,
  recordingIds: ReadonlySet<number>,
  recordingMbids: ReadonlySet<string> | null,
): boolean {
  if (row.recording_id != null && recordingIds.has(row.recording_id)) return true;
  const mbid = String(row.canonical_recording_mbid || "").trim();
  return mbid !== "" && recordingMbids != null && recordingMbids.has(mbid);
}
