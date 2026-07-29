import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../../database.js";
import { Config, CONFIG_DIR } from "../config/config.js";
import { invalidateAllDownloadState } from "../download/download-state.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { LibraryFilesService, removeEmptyParents } from "../mediafiles/library-files.js";
import { normalizeComparablePath } from "../mediafiles/path-utils.js";
import { deriveVideoQuality } from "../mediafiles/audioUtils.js";
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
  albumStatesRefreshed: number;
  artistStatesRefreshed: number;
  databaseOptimized: boolean;
  /** Finished commands rows pruned (completed > 1 day) */
  historyJobsPruned: number;
  /** Orphaned /downloads job_* folders removed */
  orphanDownloadFoldersRemoved: number;
  /** Aged discogenius-* scratch dirs removed from the OS temp folder */
  staleTempDirsRemoved: number;
  /** Video files whose quality tag was corrected from stored dimensions */
  videoQualitiesCorrected: number;
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

function refreshDownloadState(summary: RuntimeMaintenanceSummary) {
  summary.albumStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Albums").get() as { count: number } | undefined)?.count || 0,
  );
  summary.artistStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Artists").get() as { count: number } | undefined)?.count || 0,
  );

  invalidateAllDownloadState();
}

/**
 * Remove orphaned job_<id> folders under the downloads root that are not
 * referenced by an active queued/started command. Failed and completed jobs
 * leave leftovers when cleanup was skipped or partial — Lidarr-style
 * housekeeping keeps the staging tree from growing forever.
 */
export function pruneOrphanDownloadFolders(): number {
  const downloadRoot = path.resolve(Config.getDownloadPath());
  if (!fs.existsSync(downloadRoot)) return 0;

  const activeJobIds = new Set(
    (db.prepare(`
      SELECT id FROM commands
      WHERE status IN ('queued', 'started')
    `).all() as Array<{ id: number }>).map((row) => Number(row.id)),
  );

  let removed = 0;
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      const jobMatch = /^job_(\d+)$/u.exec(entry.name);
      if (jobMatch) {
        const jobId = Number(jobMatch[1]);
        if (!Number.isFinite(jobId) || activeJobIds.has(jobId)) continue;
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed += 1;
          removeEmptyParents(path.dirname(fullPath), downloadRoot);
        } catch {
          // Ignore locked/in-use folders; next housekeeping pass retries.
        }
        continue;
      }
      visit(fullPath);
    }
  };
  visit(downloadRoot);
  return removed;
}

/**
 * Remove aged Discogenius scratch directories under the OS temp folder. Retag
 * cover renders and other transient work create `discogenius-*` temp dirs and
 * normally clean up after themselves, but a crash mid-run can leak them —
 * Lidarr-style temp housekeeping keeps the temp tree from growing forever.
 */
export function pruneStaleTempDirectories(maxAgeMs = 6 * 60 * 60 * 1000): number {
  const tempRoot = os.tmpdir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("discogenius-")) continue;
    const fullPath = path.join(tempRoot, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      if (now - stats.mtimeMs < maxAgeMs) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Ignore locked/in-use temp dirs; the next pass retries.
    }
  }
  return removed;
}

/** Re-tag on-disk videos whose quality drifted from stored width/height. */
export function correctVideoQualitiesFromDimensions(): number {
  const rows = db.prepare(`
    SELECT id, quality, width, height
    FROM TrackFiles
    WHERE file_type = 'video'
      AND width IS NOT NULL
      AND height IS NOT NULL
      AND width > 0
      AND height > 0
  `).all() as Array<{ id: number; quality: string | null; width: number; height: number }>;

  const update = db.prepare("UPDATE TrackFiles SET quality = ? WHERE id = ?");
  let corrected = 0;
  for (const row of rows) {
    const derived = deriveVideoQuality({ width: row.width, height: row.height });
    if (!derived) continue;
    const current = String(row.quality || "").trim().toUpperCase();
    if (current === derived) continue;
    update.run(derived, row.id);
    corrected += 1;
  }
  return corrected;
}

export function runRuntimeMaintenance(): RuntimeMaintenanceSummary {
  const summary: RuntimeMaintenanceSummary = {
    duplicateLibraryFilesRemoved: 0,
    duplicateTrackedAssetsRemoved: 0,
    staleTrackedAssetsRemoved: 0,
    albumStatesRefreshed: 0,
    artistStatesRefreshed: 0,
    databaseOptimized: false,
    historyJobsPruned: 0,
    orphanDownloadFoldersRemoved: 0,
    staleTempDirsRemoved: 0,
    videoQualitiesCorrected: 0,
  };

  summary.staleTrackedAssetsRemoved = LibraryFilesService.pruneStaleTrackedAssets().removed;
  summary.duplicateTrackedAssetsRemoved = LibraryFilesService.pruneDuplicateTrackedAssets().removed;
  summary.orphanDownloadFoldersRemoved = pruneOrphanDownloadFolders();
  summary.staleTempDirsRemoved = pruneStaleTempDirectories();
  summary.videoQualitiesCorrected = correctVideoQualitiesFromDimensions();

  db.transaction(() => {
    dedupeLibraryFiles(summary);
  })();

  refreshDownloadState(summary);
  ArtistStatisticsService.refresh();

  // Prune finished commands rows older than 1 day
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
    summary.orphanDownloadFoldersRemoved > 0 ||
    summary.staleTempDirsRemoved > 0 ||
    summary.videoQualitiesCorrected > 0
  ) {
    console.log(
      `[Maintenance] Removed ${summary.duplicateLibraryFilesRemoved} duplicate media file row(s), ` +
      `${summary.duplicateTrackedAssetsRemoved} duplicate tracked asset(s), ` +
      `${summary.staleTrackedAssetsRemoved} stale tracked asset row(s), ` +
      `${summary.orphanDownloadFoldersRemoved} orphan download folder(s), ` +
      `${summary.staleTempDirsRemoved} temp dir(s), ` +
      `corrected ${summary.videoQualitiesCorrected} video quality tag(s), refreshed ${summary.albumStatesRefreshed} albums and ` +
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

export async function executeDatabaseBackup(): Promise<{ backupPath: string; prunedCount: number }> {
  const backupsDir = path.join(CONFIG_DIR, "Backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupsDir, `discogenius_backup_${timestamp}.db`);
  await db.backup(backupPath);

  const files = fs.readdirSync(backupsDir)
    .filter((f) => f.startsWith("discogenius_backup_") && f.endsWith(".db"))
    .map((f) => ({
      filePath: path.join(backupsDir, f),
      mtime: fs.statSync(path.join(backupsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  let prunedCount = 0;
  if (files.length > 7) {
    for (const oldFile of files.slice(7)) {
      try {
        fs.rmSync(oldFile.filePath, { force: true });
        prunedCount += 1;
      } catch {
        // ignore
      }
    }
  }

  console.log(`[Backup] Created database backup at ${backupPath} (${prunedCount} old backup(s) pruned).`);
  return { backupPath, prunedCount };
}

