import fs from "fs";
import os from "os";
import path from "path";
import { db, withSqliteWriteGate } from "../../database.js";
import { Config, CONFIG_DIR } from "../config/config.js";
import { invalidateAllDownloadState } from "../download/download-state.js";
import { DownloadWaitQueue } from "../download/download-wait-queue.js";
import { LibraryFilesService, removeEmptyParents } from "../mediafiles/library-files.js";
import { deriveVideoQuality } from "../mediafiles/audioUtils.js";
import { ArtistStatisticsService } from "../music/artist-statistics-service.js";
import { buildLibraryArtistMonitoredExistsSql } from "../music/managed-artists.js";

export interface RuntimeMaintenanceSummary {
  duplicateLibraryFilesRemoved: number;
  duplicateTrackedAssetsRemoved: number;
  staleTrackedAssetsRemoved: number;
  albumStatesRefreshed: number;
  artistStatesRefreshed: number;
  /** Finished commands rows pruned (completed > 1 day) */
  historyJobsPruned: number;
  /** Orphaned /downloads job_* folders removed */
  orphanDownloadFoldersRemoved: number;
  /** Aged discogenius-* scratch dirs removed from the OS temp folder */
  staleTempDirsRemoved: number;
  /** Video files whose quality tag was corrected from stored dimensions */
  videoQualitiesCorrected: number;
  /** Files deleted because they belong to unmonitored albums/editions */
  unmonitoredFilesRemoved: number;
}

function refreshDownloadState(summary: RuntimeMaintenanceSummary) {
  summary.albumStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM Albums").get() as { count: number } | undefined)?.count || 0,
  );
  summary.artistStatesRefreshed = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM ArtistMetadata").get() as { count: number } | undefined)?.count || 0,
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

export async function runRuntimeMaintenance(): Promise<RuntimeMaintenanceSummary> {
  const summary: RuntimeMaintenanceSummary = {
    duplicateLibraryFilesRemoved: 0,
    duplicateTrackedAssetsRemoved: 0,
    staleTrackedAssetsRemoved: 0,
    albumStatesRefreshed: 0,
    artistStatesRefreshed: 0,
    historyJobsPruned: 0,
    orphanDownloadFoldersRemoved: 0,
    staleTempDirsRemoved: 0,
    videoQualitiesCorrected: 0,
    unmonitoredFilesRemoved: 0,
  };

  summary.staleTrackedAssetsRemoved = (await LibraryFilesService.pruneStaleTrackedAssets()).removed;
  // Scope deduplication to one artist at a time. An all-library pass holds the
  // shared writer across thousands of filesystem calls.
  const sidecarArtists = db.prepare(`SELECT artist_id FROM MetadataFiles
    UNION SELECT artist_id FROM ExtraFiles UNION SELECT artist_id FROM LyricFiles`).all() as Array<{ artist_id: string }>;
  for (const artist of sidecarArtists) {
    summary.duplicateTrackedAssetsRemoved += await withSqliteWriteGate(
      () => LibraryFilesService.pruneDuplicateTrackedAssets(artist.artist_id).removed,
      "housekeeping:duplicate-assets:artist",
    );
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  summary.orphanDownloadFoldersRemoved = pruneOrphanDownloadFolders();
  summary.staleTempDirsRemoved = pruneStaleTempDirectories();
  summary.videoQualitiesCorrected = await withSqliteWriteGate(correctVideoQualitiesFromDimensions, "housekeeping:video-quality");
  summary.unmonitoredFilesRemoved = (await LibraryFilesService.pruneUnmonitoredFilesForMonitoredArtists()).deleted;

  // Distinct physical paths remain distinct TrackFiles. Deleting only their
  // rows makes the next scan mint new IDs for the same files and breaks linked
  // extras and durable file plans. Acquisition/import owns quality replacement.

  await withSqliteWriteGate(() => refreshDownloadState(summary), "housekeeping:download-state");
  const monitoredArtistIds = (db.prepare(`
    SELECT CAST(a.id AS TEXT) AS id
    FROM ArtistMetadata a
    WHERE ${buildLibraryArtistMonitoredExistsSql("a")}
  `).all() as Array<{ id: string }>).map((row) => row.id);
  if (monitoredArtistIds.length > 0) {
    await ArtistStatisticsService.refreshAsync(monitoredArtistIds);
  }

  // Known-fixed video retag error from schema 46 (`file.artist_id`). Keeping
  // those rows made Activity and health look broken after the 2.13.0 join fix.
  const staleVideoRetag = await withSqliteWriteGate(() => db.prepare(`
    DELETE FROM commands
    WHERE status = 'failed'
      AND error LIKE '%no such column: file.artist_id%'
  `).run(), "housekeeping:stale-history");
  // Prune finished commands rows older than 1 day
  const pruneResult = await withSqliteWriteGate(() => db.prepare(`
    DELETE FROM commands
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND COALESCE(completed_at, updated_at) < datetime('now', '-1 day')
  `).run(), "housekeeping:history");
  summary.historyJobsPruned = pruneResult.changes + staleVideoRetag.changes;
  try {
    await withSqliteWriteGate(() => DownloadWaitQueue.recoverOrphanClaims(), "housekeeping:orphan-claims");
  } catch (orphanErr) {
    console.warn("[Maintenance] Failed to recover orphan wait queue claims:", orphanErr);
  }

  if (
    summary.duplicateTrackedAssetsRemoved > 0 ||
    summary.staleTrackedAssetsRemoved > 0 ||
    summary.duplicateLibraryFilesRemoved > 0 ||
    summary.orphanDownloadFoldersRemoved > 0 ||
    summary.staleTempDirsRemoved > 0 ||
    summary.videoQualitiesCorrected > 0 ||
    summary.unmonitoredFilesRemoved > 0
  ) {
    console.log(
      `[Maintenance] Removed ${summary.duplicateLibraryFilesRemoved} duplicate media file row(s), ` +
      `${summary.duplicateTrackedAssetsRemoved} duplicate tracked asset(s), ` +
      `${summary.staleTrackedAssetsRemoved} stale tracked asset row(s), ` +
      `${summary.orphanDownloadFoldersRemoved} orphan download folder(s), ` +
      `${summary.staleTempDirsRemoved} temp dir(s), ` +
      `${summary.unmonitoredFilesRemoved} unmonitored file(s), ` +
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
  for (const fileName of fs.readdirSync(backupsDir)) {
    if (fileName.startsWith("discogenius_backup_") && fileName.includes(".db.partial")) {
      fs.rmSync(path.join(backupsDir, fileName), { force: true });
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupsDir, `discogenius_backup_${timestamp}.db`);
  const partialPath = `${backupPath}.partial`;
  try {
    await db.backup(partialPath, {
      // Command heartbeats use another SQLite connection. The default
      // 100-page steps restart whenever that connection writes, so a large
      // live database can copy hundreds of gigabytes without finishing. Copy
      // all remaining pages in one SQLite backup step to pin one snapshot.
      progress: () => 0x7fffffff,
    });
    fs.renameSync(partialPath, backupPath);
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    fs.rmSync(`${partialPath}-journal`, { force: true });
    throw error;
  }

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

