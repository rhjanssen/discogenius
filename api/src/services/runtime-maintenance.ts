import fs from "fs";
import { db } from "../database.js";
import { invalidateAllDownloadState } from "./download-state.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { LibraryFilesService } from "./library-files.js";
import { normalizeComparablePath } from "./path-utils.js";

interface LibraryFileRow {
  id: number;
  media_id: number;
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
  mediaIdentityIndexEnsured: boolean;
  trackedAssetIdentityIndexesEnsured: boolean;
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

function dedupeLibraryFiles(summary: RuntimeMaintenanceSummary) {
  const rows = db.prepare(`
    SELECT
      id,
      media_id,
      file_type,
      file_path,
      library_root,
      relative_path,
      expected_path,
      verified_at,
      modified_at,
      created_at
    FROM library_files
    WHERE media_id IS NOT NULL
      AND file_type IN ('track', 'video')
    ORDER BY media_id ASC, file_type ASC, id ASC
  `).all() as LibraryFileRow[];

  const deleteRow = db.prepare("DELETE FROM library_files WHERE id = ?");
  let currentKey = "";
  let bucket: LibraryFileRow[] = [];

  const flushBucket = () => {
    if (bucket.length <= 1) {
      bucket = [];
      return;
    }

    libraryFileScoreCache = new Map<number, LibraryFileScore>();
    const [keep, ...remove] = [...bucket].sort(compareLibraryFiles);
    libraryFileScoreCache = null;

    for (const row of remove) {
      if (row.id === keep.id) continue;
      deleteRow.run(row.id);
      summary.duplicateLibraryFilesRemoved++;
    }

    bucket = [];
  };

  for (const row of rows) {
    const key = `${row.media_id}:${row.file_type}`;
    if (currentKey && key !== currentKey) {
      flushBucket();
    }

    currentKey = key;
    bucket.push(row);
  }

  flushBucket();
}

function repairMonitoringGaps(summary: RuntimeMaintenanceSummary) {
  summary.mediaMonitorRepairs += Number(db.prepare(`
    UPDATE media
    SET monitor = 1,
        monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
    WHERE monitor = 0
      AND monitored_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM library_files lf
        WHERE lf.media_id = media.id
          AND lf.file_type IN ('track', 'video')
      )
  `).run().changes || 0);

  summary.albumMonitorRepairs += Number(db.prepare(`
    UPDATE albums
    SET monitor = 1,
        monitored_at = COALESCE(monitored_at, CURRENT_TIMESTAMP)
    WHERE monitor = 0
      AND EXISTS (
        SELECT 1
        FROM media m
        WHERE m.album_id = albums.id
          AND m.type != 'Music Video'
          AND m.monitor = 1
      )
  `).run().changes || 0);

  // Artist monitoring is explicit user state. Do not auto-promote artists to monitored
  // just because related albums or tracks are monitored/downloaded.
}

function refreshDownloadState(summary: RuntimeMaintenanceSummary) {
  summary.albumStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM albums").get() as { count: number } | undefined)?.count || 0,
  );
  summary.artistStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM artists").get() as { count: number } | undefined)?.count || 0,
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
    mediaIdentityIndexEnsured: false,
    trackedAssetIdentityIndexesEnsured: false,
  };

  summary.staleTrackedAssetsRemoved = LibraryFilesService.pruneStaleTrackedAssets().removed;
  summary.duplicateTrackedAssetsRemoved = LibraryFilesService.pruneDuplicateTrackedAssets().removed;

  db.transaction(() => {
    dedupeLibraryFiles(summary);
    repairMonitoringGaps(summary);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_files_media_identity
      ON library_files(media_id, file_type)
      WHERE media_id IS NOT NULL
        AND file_type IN ('track', 'video')
    `);
    summary.mediaIdentityIndexEnsured = true;

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_files_media_sidecar_identity
      ON library_files(media_id, file_type)
      WHERE media_id IS NOT NULL
        AND file_type IN ('lyrics', 'video_thumbnail')
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_files_album_sidecar_identity
      ON library_files(album_id, file_type, library_root)
      WHERE album_id IS NOT NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'video_cover', 'review')
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_files_artist_sidecar_identity
      ON library_files(artist_id, file_type, library_root)
      WHERE album_id IS NULL
        AND media_id IS NULL
        AND file_type IN ('cover', 'bio')
    `);
    summary.trackedAssetIdentityIndexesEnsured = true;
  })();

  refreshDownloadState(summary);

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
