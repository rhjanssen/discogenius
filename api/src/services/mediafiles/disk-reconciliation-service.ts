import fs from "node:fs";
import path from "node:path";
import { db, withSqliteWriteGate } from "../../database.js";
import { Config } from "../config/config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { isCaseInsensitivePath, normalizeResolvedPath } from "./path-utils.js";

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

export interface DiskReconciliationSnapshot {
  checkedAt: string;
  diskAudioFiles: number;
  trackFiles: number;
  unmapped: number;
  missing: number;
  misplaced: number;
  untrackedAdded: number;
}

export interface DiskReconciliationOptions {
  /** Override batch size for testing. Default: 200. */
  batchSize?: number;
  /** Cooperative yield hook between batches. */
  yieldToEventLoop?: () => Promise<void>;
  /** Cancellation check. */
  isCancelled?: () => boolean;
}

interface TrackFileRow {
  id: number;
  file_path: string;
  library_root: string;
  release_group_id: number | null;
  track_id: number | null;
  recording_id: number | null;
  artist_metadata_id: number | null;
  quality: string | null;
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
 * - A stereo track file may live in the Atmos library only if its album is Atmos and that track has no Atmos version.
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
    return params.albumIsAtmos && !params.recordingHasAtmosVersion;
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
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(control_key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(LAST_DISK_RECONCILIATION_CONTROL_KEY, JSON.stringify(snapshot));
  } catch {
    // Non-fatal if runtime_controls is unavailable during bootstrap.
  }
}

/**
 * Two-way disk vs DB reconciliation (#115):
 * - DB -> disk: missing TrackFiles rows are removed so tracks become wanted again.
 * - disk -> DB: untracked audio files under library roots are added to UnmappedFiles in batches.
 * - Placement: reports stereo/Atmos placement violations.
 * - Persists counts for `/api/health` and `/api/system-status`.
 */
export async function reconcileDiskAndDatabase(
  options: DiskReconciliationOptions = {},
): Promise<DiskReconciliationSnapshot> {
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const yieldFn = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error("Disk reconciliation cancelled");
  };

  const stereoRootRaw = Config.getMusicPath();
  const atmosRootRaw = Config.getSpatialPath();
  const stereoRoot = stereoRootRaw ? path.resolve(stereoRootRaw) : null;
  const atmosRoot = atmosRootRaw ? path.resolve(atmosRootRaw) : null;

  const audioRoots: Array<{ slot: "music" | "spatial"; rootPath: string; caseInsensitive: boolean }> = [];
  const seenRoots = new Set<string>();
  for (const [slot, rawPath] of [
    ["music", stereoRoot],
    ["spatial", atmosRoot],
  ] as const) {
    if (!rawPath || !fs.existsSync(rawPath)) continue;
    const caseInsensitive = process.platform === "win32" || isCaseInsensitivePath(rawPath);
    const norm = normalizeResolvedPath(rawPath, caseInsensitive);
    if (!norm || seenRoots.has(norm)) continue;
    seenRoots.add(norm);
    audioRoots.push({ slot, rootPath: rawPath, caseInsensitive });
  }

  // ── 1. DB -> Disk: detect missing TrackFiles ─────────────────────────────
  const allTrackFiles = db.prepare(`
    SELECT id, file_path, library_root, release_group_id, track_id, recording_id, artist_metadata_id, quality
    FROM TrackFiles
    WHERE file_type = 'track' AND file_path IS NOT NULL
  `).all() as TrackFileRow[];

  const missingRows: TrackFileRow[] = [];
  const presentTrackFiles: TrackFileRow[] = [];
  for (let i = 0; i < allTrackFiles.length; i += 1) {
    checkCancelled();
    const tf = allTrackFiles[i];
    if (fs.existsSync(tf.file_path)) {
      presentTrackFiles.push(tf);
    } else {
      missingRows.push(tf);
    }
    if ((i + 1) % batchSize === 0) {
      await yieldFn();
    }
  }

  for (let i = 0; i < missingRows.length; i += batchSize) {
    checkCancelled();
    const batch = missingRows.slice(i, i + batchSize);
    await withSqliteWriteGate(() => {
      db.transaction(() => {
        const del = db.prepare(`DELETE FROM TrackFiles WHERE id = ?`);
        for (const row of batch) {
          del.run(row.id);
          try {
            recordHistoryEvent({
              artistId: row.artist_metadata_id,
              albumId: row.release_group_id,
              mediaId: row.track_id,
              libraryFileId: row.id,
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              quality: row.quality,
              sourceTitle: path.basename(row.file_path),
              data: {
                deletedPath: row.file_path,
                missing: true,
                reason: "Reconciliation: track file missing from disk",
              },
            });
          } catch {
            // Non-fatal.
          }
        }
      })();
    }, "reconcile:missing-track-files");
    await yieldFn();
  }

  // ── 2. Disk -> DB: detect untracked audio files ──────────────────────────
  let diskAudioFiles = 0;
  let untrackedAdded = 0;

  const extraFileRows = tableExists("ExtraFiles")
    ? (db.prepare(`SELECT file_path FROM ExtraFiles WHERE file_path IS NOT NULL`).all() as Array<{ file_path: string }>)
    : [];
  const existingUnmappedRows = db.prepare(`
    SELECT file_path, file_size, file_mtime_ms FROM UnmappedFiles WHERE file_path IS NOT NULL
  `).all() as Array<{ file_path: string; file_size: number | null; file_mtime_ms: number | null }>;

  const pendingInserts: Array<{
    filePath: string;
    relativePath: string;
    libraryRoot: string;
    filename: string;
    extension: string;
    fileSize: number;
    fileMtimeMs: number;
  }> = [];

  for (const { slot, rootPath, caseInsensitive } of audioRoots) {
    checkCancelled();

    const trackedSet = new Set<string>();
    for (const tf of presentTrackFiles) {
      trackedSet.add(normalizeResolvedPath(tf.file_path, caseInsensitive));
    }
    for (const ef of extraFileRows) {
      trackedSet.add(normalizeResolvedPath(ef.file_path, caseInsensitive));
    }
    const unmappedSet = new Set<string>();
    for (const uf of existingUnmappedRows) {
      unmappedSet.add(normalizeResolvedPath(uf.file_path, caseInsensitive));
    }

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
      }
    };

    await walk(rootPath);
  }

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

  // ── 3. Placement violations (stereo vs Atmos) ────────────────────────────
  let misplaced = 0;
  if (
    stereoRoot
    && atmosRoot
    && normalizeResolvedPath(stereoRoot) !== normalizeResolvedPath(atmosRoot)
  ) {
    const stereoCaseInsensitive = process.platform === "win32" || isCaseInsensitivePath(stereoRoot);
    const atmosCaseInsensitive = process.platform === "win32" || isCaseInsensitivePath(atmosRoot);

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
      if (!valid) misplaced += 1;
    }
  }

  const unmappedCount = Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM UnmappedFiles WHERE ignored = 0`).get() as { count: number } | undefined)?.count ?? 0,
  );

  const snapshot: DiskReconciliationSnapshot = {
    checkedAt: new Date().toISOString(),
    diskAudioFiles,
    trackFiles: presentTrackFiles.length,
    unmapped: unmappedCount,
    missing: missingRows.length,
    misplaced,
    untrackedAdded,
  };

  await withSqliteWriteGate(() => persistDiskReconciliationResult(snapshot), "reconcile:persist-snapshot");
  return snapshot;
}
