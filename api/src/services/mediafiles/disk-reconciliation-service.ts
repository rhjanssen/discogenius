import fs from "node:fs";
import path from "node:path";
import { db, withSqliteWriteGate } from "../../database.js";
import { Config } from "../config/config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import {
  findOnDiskPath,
  isCaseInsensitivePath,
  normalizeResolvedPath,
} from "./path-utils.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { isDestructiveCleanupEnabled } from "./destructive-cleanup-setting.js";

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".alac",
  ".aac",
  ".ogg",
  ".opus",
  ".wav",
  ".aiff",
  ".aif",
  ".wma",
  ".dsf",
  ".dff",
  ".wv",
]);

const EXCLUDED_DIRS = new Set([
  ".zfs",
  ".git",
  ".vs",
  ".appledouble",
  "$recycle.bin",
  "system volume information",
  "@eadir",
]);

const BATCH_SIZE = 200;
export const LAST_DISK_RECONCILIATION_CONTROL_KEY = "health.disk_reconciliation.last";

export interface DryRunAction {
  action: "delete_file" | "move_file" | "delete_track_file_row" | "mark_missing";
  path: string;
  destination?: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface DiskReconciliationSnapshot {
  checkedAt: string;
  diskAudioFiles: number;
  trackFiles: number;
  unmapped: number;
  missing: number;
  misplaced: number;
  untrackedAdded: number;
}

export interface DiskReconciliationResult {
  snapshot: DiskReconciliationSnapshot;
  actions: DryRunAction[];
}

export interface DiskReconciliationOptions {
  /** Override batch size for testing. Default: 200. */
  batchSize?: number;
  /** Cooperative yield hook between batches. */
  yieldToEventLoop?: () => Promise<void>;
  /** Cancellation check. */
  isCancelled?: () => boolean;
  /** When true, do not perform deletions or file mutations. Default: false. */
  dryRun?: boolean;
}

interface TrackFileRow {
  id: number;
  file_path: string;
  library_root: string;
  relative_path: string | null;
  release_group_id: number | null;
  album_edition_id: number | null;
  track_id: number | null;
  recording_id: number | null;
  artist_metadata_id: number | null;
  quality: string | null;
}

function ensureMissingFilesTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ReconciliationMissingFiles (
      track_file_id INTEGER PRIMARY KEY,
      first_missing_at TEXT NOT NULL,
      file_path TEXT NOT NULL
    );
  `);
}

function tableExists(tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}

function isPathUnderRoot(filePath: string, rootPath: string, caseInsensitive: boolean): boolean {
  const normFile = normalizeResolvedPath(filePath, caseInsensitive);
  const normRoot = normalizeResolvedPath(rootPath, caseInsensitive);
  if (!normFile || !normRoot) return false;
  return normFile === normRoot || normFile.startsWith(`${normRoot}/`);
}

/**
 * Shared stereo/Atmos placement rule:
 * - An Atmos track file may live in the stereo library only if it is the only version of that track.
 * - A stereo track file may live in the Atmos library only if its album is Atmos.
 */
export function isTrackFilePlacementValid(params: {
  filePath: string;
  quality: string | null;
  stereoRoot: string | null;
  atmosRoot: string | null;
  recordingFileCount: number;
  recordingHasAtmosVersion: boolean;
  albumIsAtmos: boolean;
  stereoCaseInsensitive?: boolean;
  atmosCaseInsensitive?: boolean;
}): boolean {
  const { filePath, quality, stereoRoot, atmosRoot } = params;
  if (!stereoRoot || !atmosRoot) return true;
  if (normalizeResolvedPath(stereoRoot) === normalizeResolvedPath(atmosRoot)) return true;

  const inAtmos = isPathUnderRoot(filePath, atmosRoot, params.atmosCaseInsensitive ?? false);
  const inStereo = isPathUnderRoot(filePath, stereoRoot, params.stereoCaseInsensitive ?? false);
  if (!inAtmos && !inStereo) return true;

  const isAtmosFile = isSpatialAudioQuality(quality);
  if (isAtmosFile && inStereo) {
    return params.recordingFileCount <= 1;
  }
  if (!isAtmosFile && inAtmos) {
    return params.albumIsAtmos;
  }
  return true;
}

export function readLastDiskReconciliationResult(): DiskReconciliationSnapshot | null {
  try {
    const row = db.prepare(`
      SELECT value FROM runtime_controls WHERE control_key = ?
    `).get(LAST_DISK_RECONCILIATION_CONTROL_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as Partial<DiskReconciliationSnapshot>;
    if (
      typeof parsed.checkedAt !== "string"
      || typeof parsed.diskAudioFiles !== "number"
      || typeof parsed.trackFiles !== "number"
      || typeof parsed.unmapped !== "number"
      || typeof parsed.missing !== "number"
      || typeof parsed.misplaced !== "number"
    ) {
      return null;
    }
    return {
      checkedAt: parsed.checkedAt,
      diskAudioFiles: parsed.diskAudioFiles,
      trackFiles: parsed.trackFiles,
      unmapped: parsed.unmapped,
      missing: parsed.missing,
      misplaced: parsed.misplaced,
      untrackedAdded: typeof parsed.untrackedAdded === "number" ? parsed.untrackedAdded : 0,
    };
  } catch {
    return null;
  }
}

export function persistDiskReconciliationResult(snapshot: DiskReconciliationSnapshot): void {
  try {
    db.prepare(`
      INSERT INTO runtime_controls (control_key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(control_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(LAST_DISK_RECONCILIATION_CONTROL_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("[Reconciliation] Failed to persist snapshot:", error);
  }
}

export async function reconcileDiskAndDatabase(
  options: DiskReconciliationOptions = {},
): Promise<DiskReconciliationSnapshot> {
  const result = await reconcileDiskAndDatabaseWithReport(options);
  return result.snapshot;
}

export async function reconcileDiskAndDatabaseWithReport(
  options: DiskReconciliationOptions = {},
): Promise<DiskReconciliationResult> {
  ensureMissingFilesTable();

  const isDryRun = options.dryRun === true || !isDestructiveCleanupEnabled();
  const dryRunActions: DryRunAction[] = [];
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const yieldFn = options.yieldToEventLoop ?? (() => new Promise<void>((r) => setImmediate(r)));
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error("Reconciliation cancelled");
  };

  const stereoRoot = path.resolve(Config.getMusicPath());
  const atmosRoot = path.resolve(Config.getSpatialPath());
  const videoRoot = path.resolve(Config.getVideoPath());
  const roots = [
    { slot: "music", path: stereoRoot },
    { slot: "spatial", path: atmosRoot },
    { slot: "video", path: videoRoot },
  ];

  const presentTrackFiles: TrackFileRow[] = [];
  const missingRows: TrackFileRow[] = [];
  const trackedSet = new Set<string>();

  const hasTrackFiles = tableExists("TrackFiles");
  if (hasTrackFiles) {
    const trackFiles = db.prepare(`
      SELECT id, file_path, library_root, relative_path, release_group_id, album_edition_id,
             track_id, recording_id, artist_metadata_id, quality
      FROM TrackFiles
    `).all() as TrackFileRow[];

    // Read previously marked missing files
    const previouslyMissingMap = new Map<number, string>(
      (db.prepare(`
        SELECT track_file_id, first_missing_at FROM ReconciliationMissingFiles
      `).all() as Array<{ track_file_id: number; first_missing_at: string }>).map((r) => [r.track_file_id, r.first_missing_at]),
    );

    const newlyMarkedMissing: TrackFileRow[] = [];
    const confirmedMissingToDelete: TrackFileRow[] = [];
    const unmarkIds: number[] = [];
    const pathUpdates: Array<{ id: number; onDiskPath: string }> = [];

    for (let i = 0; i < trackFiles.length; i += batchSize) {
      checkCancelled();
      const batch = trackFiles.slice(i, i + batchSize);

      for (const tf of batch) {
        // Resolve stored path (respects stored path, library_root, and relative_path)
        const resolvedPath = resolveStoredLibraryPath({
          filePath: tf.file_path,
          libraryRoot: tf.library_root,
          relativePath: tf.relative_path,
        });

        const onDiskPath = findOnDiskPath(resolvedPath);

        if (onDiskPath) {
          presentTrackFiles.push(tf);

          // If path changed due to root relocation or case/unicode normalization, record update
          if (tf.file_path !== onDiskPath) {
            pathUpdates.push({ id: tf.id, onDiskPath });
          }

          // If this file was previously marked as missing, clear that marker
          if (previouslyMissingMap.has(tf.id)) {
            unmarkIds.push(tf.id);
          }

          // Add to trackedSet with root-specific case sensitivity and NFC normalization
          const rootCaseInsensitive = isCaseInsensitivePath(onDiskPath);
          trackedSet.add(normalizeResolvedPath(onDiskPath, rootCaseInsensitive));
          trackedSet.add(normalizeResolvedPath(resolvedPath, rootCaseInsensitive));
          trackedSet.add(normalizeResolvedPath(tf.file_path, rootCaseInsensitive));
        } else {
          missingRows.push(tf);

          // Always protect missing rows in trackedSet on the current pass
          const rootCaseInsensitive = isCaseInsensitivePath(resolvedPath);
          trackedSet.add(normalizeResolvedPath(resolvedPath, rootCaseInsensitive));
          trackedSet.add(normalizeResolvedPath(tf.file_path, rootCaseInsensitive));

          if (previouslyMissingMap.has(tf.id)) {
            // Missing across multiple reconciliation runs
            confirmedMissingToDelete.push(tf);
            dryRunActions.push({
              action: "delete_track_file_row",
              path: tf.file_path,
              reason: "Track file missing from disk confirmed across multiple reconciliation runs",
              details: {
                trackFileId: tf.id,
                firstMissingAt: previouslyMissingMap.get(tf.id),
              },
            });
          } else {
            // First time seen missing -> mark for later run
            newlyMarkedMissing.push(tf);
            dryRunActions.push({
              action: "mark_missing",
              path: tf.file_path,
              reason: "Track file missing from disk; marked for subsequent verification",
              details: { trackFileId: tf.id },
            });
          }
        }
      }
      await yieldFn();
    }

    // Apply database updates
    await withSqliteWriteGate(() => {
      db.transaction(() => {
        // Unmark restored files
        if (unmarkIds.length > 0) {
          const deleteMissing = db.prepare(`DELETE FROM ReconciliationMissingFiles WHERE track_file_id = ?`);
          for (const id of unmarkIds) {
            deleteMissing.run(id);
          }
        }

        // Apply path corrections for relocated / normalized roots
        if (pathUpdates.length > 0 && !isDryRun) {
          const updateStmt = db.prepare(`
            UPDATE TrackFiles
            SET file_path = ?,
                library_root = COALESCE(?, library_root)
            WHERE id = ?
          `);
          for (const u of pathUpdates) {
            const rootPath = resolveLibraryRootPath(null, u.onDiskPath);
            updateStmt.run(u.onDiskPath, rootPath, u.id);
          }
        }

        // Mark newly missing files (even in dry-run, marking preserves audit state without destroying data)
        if (newlyMarkedMissing.length > 0) {
          const markStmt = db.prepare(`
            INSERT OR IGNORE INTO ReconciliationMissingFiles (track_file_id, first_missing_at, file_path)
            VALUES (?, datetime('now'), ?)
          `);
          for (const tf of newlyMarkedMissing) {
            markStmt.run(tf.id, tf.file_path);
          }
        }

        // Delete confirmed missing files only if NOT dry-run and destructive cleanup is enabled
        if (confirmedMissingToDelete.length > 0 && !isDryRun) {
          const deleteTrack = db.prepare(`DELETE FROM TrackFiles WHERE id = ?`);
          const deleteMissing = db.prepare(`DELETE FROM ReconciliationMissingFiles WHERE track_file_id = ?`);
          for (const tf of confirmedMissingToDelete) {
            deleteTrack.run(tf.id);
            deleteMissing.run(tf.id);
            recordHistoryEvent({
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              libraryFileId: tf.id,
              artistId: tf.artist_metadata_id,
              albumId: tf.release_group_id,
              mediaId: tf.track_id,
              quality: tf.quality,
              data: {
                deletedPath: tf.file_path,
                source: "reconciliation:missing-file",
              },
            });
          }
        }
      })();
    }, "reconcile:track-files");
  }

  // ── 2. Disk scan for unmapped/untracked audio ────────────────────────────
  const unmappedSet = new Set<string>();
  const hasUnmapped = tableExists("UnmappedFiles");
  if (hasUnmapped) {
    const unmappedRows = db.prepare(`SELECT file_path FROM UnmappedFiles`).all() as Array<{ file_path: string }>;
    for (const r of unmappedRows) {
      unmappedSet.add(normalizeResolvedPath(r.file_path));
    }
  }

  // Also protect metadata and lyric files from unmapped discovery
  if (tableExists("MetadataFiles")) {
    const metaRows = db.prepare(`SELECT file_path FROM MetadataFiles`).all() as Array<{ file_path: string }>;
    for (const r of metaRows) {
      trackedSet.add(normalizeResolvedPath(r.file_path));
    }
  }
  if (tableExists("LyricFiles")) {
    const lyricRows = db.prepare(`SELECT file_path FROM LyricFiles`).all() as Array<{ file_path: string }>;
    for (const r of lyricRows) {
      trackedSet.add(normalizeResolvedPath(r.file_path));
    }
  }
  if (tableExists("ExtraFiles")) {
    const extraRows = db.prepare(`SELECT file_path FROM ExtraFiles`).all() as Array<{ file_path: string }>;
    for (const r of extraRows) {
      trackedSet.add(normalizeResolvedPath(r.file_path));
    }
  }

  let diskAudioFiles = 0;
  let untrackedAdded = 0;
  const pendingInserts: Array<{
    filePath: string;
    relativePath: string;
    libraryRoot: string;
    filename: string;
    extension: string;
    fileSize: number;
    fileMtimeMs: number;
  }> = [];

  for (const { slot, path: rootPath } of roots) {
    checkCancelled();
    if (!fs.existsSync(rootPath)) continue;
    const caseInsensitive = isCaseInsensitivePath(rootPath);

    const walk = async (dir: string): Promise<void> => {
      checkCancelled();
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue;
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext) && ext !== ".mp4") continue;

        diskAudioFiles += 1;
        const normPath = normalizeResolvedPath(fullPath, caseInsensitive);
        if (trackedSet.has(normPath) || unmappedSet.has(normPath)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        unmappedSet.add(normPath);
        pendingInserts.push({
          filePath: fullPath,
          relativePath: path.relative(rootPath, fullPath).replace(/\\/g, "/"),
          libraryRoot: slot,
          filename: entry.name,
          extension: ext.replace(/^\./, ""),
          fileSize: stat.size,
          fileMtimeMs: stat.mtimeMs,
        });
        dryRunActions.push({
          action: "mark_missing",
          path: fullPath,
          reason: "Discovered untracked audio file on disk",
          details: { libraryRoot: slot },
        });
      }
    };

    await walk(rootPath);
  }

  if (!isDryRun) {
    for (let i = 0; i < pendingInserts.length; i += batchSize) {
      checkCancelled();
      const batch = pendingInserts.slice(i, i + batchSize);
      await withSqliteWriteGate(() => {
        db.transaction(() => {
          const insert = db.prepare(`
            INSERT OR IGNORE INTO UnmappedFiles (
              file_path, relative_path, library_root, filename, extension,
              file_size, file_mtime_ms, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Discovered by disk reconciliation')
          `);
          for (const item of batch) {
            const info = insert.run(
              item.filePath,
              item.relativePath,
              item.libraryRoot,
              item.filename,
              item.extension,
              item.fileSize,
              item.fileMtimeMs,
            );
            if (info.changes > 0) untrackedAdded += 1;
          }
        })();
      }, "reconcile:untracked-audio");
      await yieldFn();
    }
  }

  // ── 3. Placement violations (stereo vs Atmos) ────────────────────────────
  let misplaced = 0;
  if (
    stereoRoot
    && atmosRoot
    && normalizeResolvedPath(stereoRoot) !== normalizeResolvedPath(atmosRoot)
  ) {
    const stereoCaseInsensitive = isCaseInsensitivePath(stereoRoot);
    const atmosCaseInsensitive = isCaseInsensitivePath(atmosRoot);

    const byRecording = new Map<number, TrackFileRow[]>();
    const atmosAlbums = new Set<number>();
    for (const tf of presentTrackFiles) {
      if (tf.recording_id != null) {
        const list = byRecording.get(tf.recording_id) ?? [];
        list.push(tf);
        byRecording.set(tf.recording_id, list);
      }
      if (tf.release_group_id != null && isSpatialAudioQuality(tf.quality)) {
        atmosAlbums.add(tf.release_group_id);
      }
    }

    if (tableExists("AlbumEditions")) {
      const spatialAlbumRows = db.prepare(`
        SELECT DISTINCT ae.release_group_id
        FROM AlbumEditions ae
        WHERE ae.release_group_id IS NOT NULL
          AND (
            LOWER(COALESCE(ae.disambiguation, '')) LIKE '%atmos%'
            OR LOWER(COALESCE(ae.title, '')) LIKE '%atmos%'
          )
      `).all() as Array<{ release_group_id: number }>;
      for (const row of spatialAlbumRows) {
        atmosAlbums.add(row.release_group_id);
      }
    }

    for (const tf of presentTrackFiles) {
      if (tf.recording_id == null) continue;
      const peers = byRecording.get(tf.recording_id) ?? [tf];
      const valid = isTrackFilePlacementValid({
        filePath: tf.file_path,
        quality: tf.quality,
        stereoRoot,
        atmosRoot,
        recordingFileCount: peers.length,
        recordingHasAtmosVersion: peers.some((p) => isSpatialAudioQuality(p.quality)),
        albumIsAtmos: tf.release_group_id != null && atmosAlbums.has(tf.release_group_id),
        stereoCaseInsensitive,
        atmosCaseInsensitive,
      });
      if (!valid) {
        misplaced += 1;
        dryRunActions.push({
          action: "move_file",
          path: tf.file_path,
          reason: isSpatialAudioQuality(tf.quality)
            ? "Atmos file in stereo library when another version exists"
            : "Stereo file in Atmos library when album is not Atmos",
          details: {
            trackFileId: tf.id,
            quality: tf.quality,
            releaseGroupId: tf.release_group_id,
          },
        });
      }
    }
  }

  const unmappedCount = hasUnmapped
    ? Number((db.prepare(`SELECT COUNT(*) AS count FROM UnmappedFiles WHERE ignored = 0`).get() as { count: number } | undefined)?.count ?? 0)
    : 0;

  const snapshot: DiskReconciliationSnapshot = {
    checkedAt: new Date().toISOString(),
    diskAudioFiles,
    trackFiles: presentTrackFiles.length,
    unmapped: unmappedCount,
    missing: missingRows.length,
    misplaced,
    untrackedAdded,
  };

  if (!isDryRun) {
    await withSqliteWriteGate(() => persistDiskReconciliationResult(snapshot), "reconcile:persist-snapshot");
  }

  return { snapshot, actions: dryRunActions };
}
