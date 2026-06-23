import fs from "fs";
import { db } from "../../database.js";
import { invalidateAllDownloadState } from "../download/download-state.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { LibraryFilesService } from "../mediafiles/library-files.js";
import { normalizeComparablePath } from "../mediafiles/path-utils.js";
import { ArtistStatisticsService } from "../music/artist-statistics-service.js";

interface LibraryFileRow {
  id: number;
  canonical_recording_mbid: string | null;
  canonical_track_mbid: string | null;
  track_id: number | null;
  recording_id: number | null;
  library_slot: string | null;
  file_type: string;
  file_path: string;
  library_root: string | null;
  relative_path: string | null;
  expected_path: string | null;
  verified_at: string | null;
  modified_at: string | null;
  created_at: string | null;
}

export interface RuntimeMaintenanceSummary {
  duplicateLibraryFilesRemoved: number;
  duplicateTrackedAssetsRemoved: number;
  staleTrackedAssetsRemoved: number;
  mediaMonitorRepairs: number;
  albumMonitorRepairs: number;
  artistMonitorRepairs: number;
  albumStatesRefreshed: number;
  artistStatesRefreshed: number;
  databaseOptimized: boolean;
  /** Finished commands rows pruned (Lidarr-aligned: completed > 1 day) */
  historyJobsPruned: number;
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scoreLibraryFile(row: LibraryFileRow) {
  const resolvedPath = resolveStoredLibraryPath({
    filePath: row.file_path,
    libraryRoot: row.library_root,
    relativePath: row.relative_path,
  });
  const normalizedExpected = normalizeComparablePath(row.expected_path);
  const normalizedPath = normalizeComparablePath(row.file_path);
  const normalizedResolvedPath = normalizeComparablePath(resolvedPath);
  const exists = fs.existsSync(resolvedPath);

  return {
    resolvedMatchesExpected: normalizedExpected.length > 0 && normalizedResolvedPath === normalizedExpected ? 1 : 0,
    pathMatchesExpected: normalizedExpected.length > 0 && normalizedPath === normalizedExpected ? 1 : 0,
    exists: exists ? 1 : 0,
    verified: row.verified_at ? 1 : 0,
    modifiedAt: toTimestamp(row.modified_at),
    createdAt: toTimestamp(row.created_at),
    id: row.id,
  };
}

type LibraryFileScore = ReturnType<typeof scoreLibraryFile>;

let libraryFileScoreCache: Map<number, LibraryFileScore> | null = null;

function getLibraryFileScore(row: LibraryFileRow): LibraryFileScore {
  if (!libraryFileScoreCache) {
    return scoreLibraryFile(row);
  }

  const cached = libraryFileScoreCache.get(row.id);
  if (cached) {
    return cached;
  }

  const computed = scoreLibraryFile(row);
  libraryFileScoreCache.set(row.id, computed);
  return computed;
}

function compareLibraryFileScores(leftScore: LibraryFileScore, rightScore: LibraryFileScore): number {
  return (
    rightScore.resolvedMatchesExpected - leftScore.resolvedMatchesExpected ||
    rightScore.pathMatchesExpected - leftScore.pathMatchesExpected ||
    rightScore.exists - leftScore.exists ||
    rightScore.verified - leftScore.verified ||
    rightScore.modifiedAt - leftScore.modifiedAt ||
    rightScore.createdAt - leftScore.createdAt ||
    rightScore.id - leftScore.id
  );
}

function compareLibraryFiles(left: LibraryFileRow, right: LibraryFileRow): number {
  const leftScore = getLibraryFileScore(left);
  const rightScore = getLibraryFileScore(right);
  return compareLibraryFileScores(leftScore, rightScore);
}

/**
 * A file's canonical identity is the **track** (the release↔recording mapping),
 * NOT the recording:
 * one recording legitimately appears as a track on several releases, so the same
 * recording downloaded from two different releases yields two *distinct* files
 * that must NOT be merged. So audio dedupes by `track_id`/`canonical_track_mbid`
 * (release-specific) within a slot. Videos have no release/track, so they dedupe
 * by `recording_id`/`canonical_recording_mbid`. library_slot is part of the key
 * (a track's stereo and spatial copies are distinct files). Returns "" when the
 * relevant canonical id is missing.
 */
function canonicalIdentityKey(row: LibraryFileRow): string {
  const slot = String(row.library_slot ?? "").trim().toLowerCase();
  if (row.file_type === "video") {
    const recording = row.recording_id != null
      ? `id:${row.recording_id}`
      : String(row.canonical_recording_mbid ?? "").trim();
    return recording ? `vid:${recording}:${slot}` : "";
  }
  const track = row.track_id != null
    ? `id:${row.track_id}`
    : String(row.canonical_track_mbid ?? "").trim();
  return track ? `trk:${track}:${slot}` : "";
}

function dedupeLibraryFilesByKey(
  keyFn: (row: LibraryFileRow) => string,
  summary: RuntimeMaintenanceSummary,
) {
  const rows = db.prepare(`
    SELECT
      id,
      canonical_recording_mbid,
      canonical_track_mbid,
      track_id,
      recording_id,
      library_slot,
      file_type,
      file_path,
      library_root,
      relative_path,
      expected_path,
      verified_at,
      modified_at,
      created_at
    FROM TrackFiles
    WHERE (canonical_recording_mbid IS NOT NULL OR track_id IS NOT NULL OR recording_id IS NOT NULL)
      AND file_type IN ('track', 'video')
    ORDER BY id ASC
  `).all() as LibraryFileRow[];

  const deleteRow = db.prepare("DELETE FROM TrackFiles WHERE id = ?");
  const buckets = new Map<string, LibraryFileRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) {
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.length <= 1) {
      continue;
    }

    libraryFileScoreCache = new Map<number, LibraryFileScore>();
    const [keep, ...remove] = [...bucket].sort(compareLibraryFiles);
    libraryFileScoreCache = null;

    for (const row of remove) {
      if (row.id === keep.id) continue;
      deleteRow.run(row.id);
      summary.duplicateLibraryFilesRemoved++;
    }
  }
}

export function dedupeLibraryFiles(summary: RuntimeMaintenanceSummary) {
  dedupeLibraryFilesByKey(canonicalIdentityKey, summary);
}

export function repairMonitoringGaps(summary: RuntimeMaintenanceSummary) {
  const installedAudioSlots = `
    SELECT DISTINCT
      COALESCE(NULLIF(lf.canonical_artist_mbid, ''), NULLIF(artist.mbid, ''), NULLIF(rg.artist_mbid, '')) AS artist_mbid,
      lf.canonical_release_group_mbid AS release_group_mbid,
      COALESCE(NULLIF(lf.library_slot, ''), 'stereo') AS slot
    FROM TrackFiles lf
    JOIN Albums rg ON rg.mbid = lf.canonical_release_group_mbid
    LEFT JOIN Artists artist ON CAST(artist.id AS TEXT) = CAST(lf.artist_id AS TEXT)
    JOIN ArtistMetadata metadata
      ON metadata.mbid = COALESCE(NULLIF(lf.canonical_artist_mbid, ''), NULLIF(artist.mbid, ''), NULLIF(rg.artist_mbid, ''))
    WHERE lf.file_type = 'track'
      AND lf.canonical_release_group_mbid IS NOT NULL
  `;

  summary.albumMonitorRepairs += Number(db.prepare(`
    UPDATE ReleaseGroupSlots
    SET monitored = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE COALESCE(monitored, 0) = 0
      AND COALESCE(monitored_lock, 0) = 0
      AND id IN (
        SELECT slot_row.id
        FROM ReleaseGroupSlots slot_row
        JOIN (${installedAudioSlots}) installed
          ON installed.release_group_mbid = slot_row.release_group_mbid
         AND installed.slot = slot_row.slot
      )
  `).run().changes || 0);

  summary.albumMonitorRepairs += Number(db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, updated_at
    )
    SELECT installed.artist_mbid, installed.release_group_mbid, installed.slot, 1, CURRENT_TIMESTAMP
    FROM (${installedAudioSlots}) installed
    WHERE NOT EXISTS (
      SELECT 1
      FROM ReleaseGroupSlots slot_row
      WHERE slot_row.release_group_mbid = installed.release_group_mbid
        AND slot_row.slot = installed.slot
    )
  `).run().changes || 0);

  summary.mediaMonitorRepairs += Number(db.prepare(`
    UPDATE Recordings
    SET monitored = 1,
        monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE is_video = 1
      AND COALESCE(monitored, 0) = 0
      AND COALESCE(monitored_lock, 0) = 0
      AND EXISTS (
        SELECT 1
        FROM TrackFiles lf
        LEFT JOIN ProviderItems pi
          ON lf.provider_entity_type = 'video'
         AND pi.entity_type = 'video'
         AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
         AND (lf.provider IS NULL OR pi.provider = lf.provider)
        WHERE lf.file_type = 'video'
          AND (
            lf.recording_id = Recordings.id
            OR (lf.canonical_recording_mbid IS NOT NULL AND lf.canonical_recording_mbid = Recordings.mbid)
            OR pi.recording_id = Recordings.id
          )
      )
  `).run().changes || 0);

  // Artist monitoring is explicit user state. Do not auto-promote artists to monitored
  // just because related albums or tracks are monitored/downloaded.
}

function refreshDownloadState(summary: RuntimeMaintenanceSummary) {
  summary.albumStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Albums").get() as { count: number } | undefined)?.count || 0,
  );
  summary.artistStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Artists").get() as { count: number } | undefined)?.count || 0,
  );

  invalidateAllDownloadState();
}

export function runRuntimeMaintenance(): RuntimeMaintenanceSummary {
  const summary: RuntimeMaintenanceSummary = {
    duplicateLibraryFilesRemoved: 0,
    duplicateTrackedAssetsRemoved: 0,
    staleTrackedAssetsRemoved: 0,
    mediaMonitorRepairs: 0,
    albumMonitorRepairs: 0,
    artistMonitorRepairs: 0,
    albumStatesRefreshed: 0,
    artistStatesRefreshed: 0,
    databaseOptimized: false,
    historyJobsPruned: 0,
  };

  summary.staleTrackedAssetsRemoved = LibraryFilesService.pruneStaleTrackedAssets().removed;
  summary.duplicateTrackedAssetsRemoved = LibraryFilesService.pruneDuplicateTrackedAssets().removed;

  db.transaction(() => {
    dedupeLibraryFiles(summary);
    repairMonitoringGaps(summary);
  })();

  refreshDownloadState(summary);
  ArtistStatisticsService.refresh();

  // Prune finished commands rows older than 1 day (Lidarr keeps completed commands
  // 5 min in-memory and trims DB records older than 1 day via CommandRepository.Trim())
  const pruneResult = db.prepare(`
    DELETE FROM commands
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND COALESCE(completed_at, updated_at) < datetime('now', '-1 day')
  `).run();
  summary.historyJobsPruned = pruneResult.changes;

  db.exec(`PRAGMA optimize;`);
  db.prepare(`ANALYZE;`).run();
  db.prepare(`VACUUM;`).run();
  summary.databaseOptimized = true;

  if (
    summary.duplicateTrackedAssetsRemoved > 0 ||
    summary.staleTrackedAssetsRemoved > 0 ||
    summary.duplicateLibraryFilesRemoved > 0 ||
    summary.mediaMonitorRepairs > 0 ||
    summary.albumMonitorRepairs > 0 ||
    summary.artistMonitorRepairs > 0
  ) {
    console.log(
      `[Maintenance] Removed ${summary.duplicateLibraryFilesRemoved} duplicate media file row(s), ` +
      `${summary.duplicateTrackedAssetsRemoved} duplicate tracked asset(s), ` +
      `${summary.staleTrackedAssetsRemoved} stale tracked asset row(s), ` +
      `repaired ${summary.mediaMonitorRepairs} media, ${summary.albumMonitorRepairs} albums, ` +
      `${summary.artistMonitorRepairs} artists, refreshed ${summary.albumStatesRefreshed} albums and ` +
      `${summary.artistStatesRefreshed} artists.`,
    );
  } else {
    console.log(
      `[Maintenance] Download state refreshed for ${summary.albumStatesRefreshed} albums and ` +
      `${summary.artistStatesRefreshed} artists.`,
    );
  }

  return summary;
}

