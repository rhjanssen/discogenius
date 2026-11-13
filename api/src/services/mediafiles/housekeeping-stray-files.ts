import fs from "fs";
import path from "path";
import { db, withSqliteWriteGate } from "../../database.js";
import { Config } from "../config/config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { isCaseInsensitivePath, normalizeResolvedPath } from "./path-utils.js";
import { removeEmptyParents } from "./library-files.js";
import { UnmappedFilesService } from "./unmapped-files.js";

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

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".m4v",
  ".mov",
  ".webm",
  ".ts",
]);

const LYRIC_SIDECAR_EXTENSIONS = new Set([
  ".lrc",
  ".srt",
  ".vtt",
]);

const TEMP_PARTIAL_EXTENSIONS = new Set([
  ".tmp",
  ".part",
  ".partial",
]);

export interface StrayAndPlacementSummary {
  orphanLyricsRemoved: number;
  tempFilesRemoved: number;
  emptyFoldersRemoved: number;
  unownedAudioRemoved: number;
  misplacedDeleted: number;
  misplacedMoved: number;
}

export interface HousekeepingStrayOptions {
  /** Minimum age in ms before deleting temp/partial files. Default: 1 hour. */
  tempMaxAgeMs?: number;
  /** Whether to run unmapped re-check before pruning unowned audio. Default: true. */
  runUnmappedRecheck?: boolean;
  /** Optional override for unmapped re-check in tests. */
  recheckUnmapped?: () => Promise<unknown>;
  /** Cooperative yield hook. */
  yieldToEventLoop?: () => Promise<void>;
  /** Cancellation check. */
  isCancelled?: () => boolean;
}

export interface PlacementTrackFileRow {
  id: number;
  file_path: string;
  relative_path: string | null;
  library_root: string;
  library_id: number | null;
  release_group_id: number | null;
  album_edition_id: number | null;
  track_id: number | null;
  recording_id: number | null;
  artist_metadata_id: number | null;
  quality: string | null;
  file_type: string;
}

export type PlacementEvaluation =
  | { allowed: true }
  | { allowed: false; targetSlot: "stereo" | "atmos"; reason: string };

function isPathUnderRoot(filePath: string, rootPath: string, caseInsensitive: boolean): boolean {
  const normFile = normalizeResolvedPath(filePath, caseInsensitive);
  const normRoot = normalizeResolvedPath(rootPath, caseInsensitive);
  if (!normFile || !normRoot) return false;
  return normFile === normRoot || normFile.startsWith(`${normRoot}/`);
}

function isTempOrPartialFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);
  if (TEMP_PARTIAL_EXTENSIONS.has(ext)) return true;
  if (lower.includes(".tmp.")) return true;
  return false;
}

function tableExists(tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName) as { present: number } | undefined;
  return Boolean(row?.present);
}

/**
 * Shared stereo/Atmos placement rule (#114 & #115):
 * - An Atmos track file may live in the stereo library only if it is the only version of that track.
 * - A stereo track file may live in the Atmos library only if its album is Atmos
 *   (has spatial track files or a spatial release) and that particular track has no Atmos version.
 */
export function evaluateTrackFilePlacement(params: {
  file: Pick<PlacementTrackFileRow, "file_path" | "quality" | "recording_id" | "release_group_id">;
  stereoRoot: string | null;
  atmosRoot: string | null;
  recordingFileCount: number;
  recordingHasAtmosVersion: boolean;
  albumIsAtmos: boolean;
  stereoCaseInsensitive?: boolean;
  atmosCaseInsensitive?: boolean;
}): PlacementEvaluation {
  const { file, stereoRoot, atmosRoot } = params;
  if (!stereoRoot || !atmosRoot) return { allowed: true };
  if (normalizeResolvedPath(stereoRoot) === normalizeResolvedPath(atmosRoot)) {
    return { allowed: true };
  }

  const inAtmos = isPathUnderRoot(file.file_path, atmosRoot, params.atmosCaseInsensitive ?? false);
  const inStereo = isPathUnderRoot(file.file_path, stereoRoot, params.stereoCaseInsensitive ?? false);
  if (!inAtmos && !inStereo) return { allowed: true };

  const isAtmosFile = isSpatialAudioQuality(file.quality);

  if (isAtmosFile && inStereo) {
    if (params.recordingFileCount <= 1) {
      return { allowed: true };
    }
    return {
      allowed: false,
      targetSlot: "atmos",
      reason: "Atmos track file in stereo library when another version of the track exists",
    };
  }

  if (!isAtmosFile && inAtmos) {
    if (params.albumIsAtmos && !params.recordingHasAtmosVersion) {
      return { allowed: true };
    }
    return {
      allowed: false,
      targetSlot: "stereo",
      reason: params.albumIsAtmos
        ? "Stereo track file in Atmos library when an Atmos version of the track exists"
        : "Stereo track file in Atmos library for a non-Atmos album",
    };
  }

  return { allowed: true };
}

function buildTrackedPathsSet(caseInsensitive: boolean): Set<string> {
  const tracked = new Set<string>();
  const trackRows = db.prepare(`
    SELECT file_path FROM TrackFiles WHERE file_path IS NOT NULL
  `).all() as Array<{ file_path: string }>;
  for (const row of trackRows) {
    if (row.file_path) tracked.add(normalizeResolvedPath(row.file_path, caseInsensitive));
  }
  if (tableExists("ExtraFiles")) {
    const extraRows = db.prepare(`
      SELECT file_path FROM ExtraFiles WHERE file_path IS NOT NULL
    `).all() as Array<{ file_path: string }>;
    for (const row of extraRows) {
      if (row.file_path) tracked.add(normalizeResolvedPath(row.file_path, caseInsensitive));
    }
  }
  return tracked;
}

function collectActiveImportPaths(caseInsensitive: boolean): Set<string> {
  const active = new Set<string>();
  const rows = db.prepare(`
    SELECT payload FROM commands
    WHERE name = 'ImportUnmappedFiles' AND status IN ('queued', 'started')
  `).all() as Array<{ payload: string | null }>;
  const unmappedIds: number[] = [];
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const parsed = JSON.parse(row.payload) as {
        canonical?: { mappings?: Array<{ unmappedFileId?: number }> };
      };
      for (const mapping of parsed.canonical?.mappings ?? []) {
        if (typeof mapping.unmappedFileId === "number") {
          unmappedIds.push(mapping.unmappedFileId);
        }
      }
    } catch {
      // Ignore malformed payloads.
    }
  }
  if (unmappedIds.length > 0) {
    const placeholders = unmappedIds.map(() => "?").join(",");
    const files = db.prepare(`
      SELECT file_path FROM UnmappedFiles WHERE id IN (${placeholders})
    `).all(...unmappedIds) as Array<{ file_path: string }>;
    for (const file of files) {
      if (file.file_path) active.add(normalizeResolvedPath(file.file_path, caseInsensitive));
    }
  }
  return active;
}

function collectActiveJobHints(): string[] {
  const rows = db.prepare(`
    SELECT payload FROM commands WHERE status IN ('queued', 'started')
  `).all() as Array<{ payload: string | null }>;
  return rows.map((row) => String(row.payload || "").toLowerCase()).filter(Boolean);
}

function isOwnedByRunningJob(filePath: string, activeJobPayloads: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(normalized);
  const dir = path.dirname(normalized);
  return activeJobPayloads.some((payload) =>
    payload.includes(normalized) || payload.includes(dir) || payload.includes(base),
  );
}

function recordDeletionHistory(filePath: string, reason: string, extra?: {
  artistId?: number | null;
  albumId?: number | null;
  mediaId?: number | null;
  libraryFileId?: number | null;
  quality?: string | null;
}): void {
  try {
    recordHistoryEvent({
      artistId: extra?.artistId ?? null,
      albumId: extra?.albumId ?? null,
      mediaId: extra?.mediaId ?? null,
      libraryFileId: extra?.libraryFileId ?? null,
      eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
      quality: extra?.quality ?? null,
      sourceTitle: path.basename(filePath),
      data: {
        deletedPath: filePath,
        reason,
      },
    });
  } catch {
    // Non-fatal if history insert fails.
  }
}

function recordMoveHistory(sourcePath: string, destinationPath: string, reason: string, row: PlacementTrackFileRow): void {
  try {
    recordHistoryEvent({
      artistId: row.artist_metadata_id,
      albumId: row.release_group_id,
      mediaId: row.track_id,
      libraryFileId: row.id,
      eventType: HISTORY_EVENT_TYPES.TrackFileRenamed,
      quality: row.quality,
      sourceTitle: path.basename(sourcePath),
      data: {
        sourcePath,
        destinationPath,
        reason,
      },
    });
  } catch {
    // Non-fatal if history insert fails.
  }
}

function resolveLibraryIdForRoot(rootPath: string): number | null {
  const caseInsensitive = process.platform === "win32" || isCaseInsensitivePath(rootPath);
  const normTarget = normalizeResolvedPath(rootPath, caseInsensitive);
  const libraries = db.prepare(`SELECT id, root_path FROM Libraries WHERE enabled = 1`).all() as Array<{
    id: number;
    root_path: string;
  }>;
  for (const lib of libraries) {
    if (normalizeResolvedPath(lib.root_path, caseInsensitive) === normTarget) {
      return lib.id;
    }
  }
  return null;
}

/**
 * Clean up stray files (orphan lyrics/sidecars, aged temp/partial files, empty folders,
 * unowned non-importable audio) across library roots and enforce stereo/Atmos placement.
 */
export async function runHousekeepingStrayAndPlacement(
  options: HousekeepingStrayOptions = {},
): Promise<StrayAndPlacementSummary> {
  const summary: StrayAndPlacementSummary = {
    orphanLyricsRemoved: 0,
    tempFilesRemoved: 0,
    emptyFoldersRemoved: 0,
    unownedAudioRemoved: 0,
    misplacedDeleted: 0,
    misplacedMoved: 0,
  };

  const tempMaxAgeMs = options.tempMaxAgeMs ?? 60 * 60 * 1000;
  const yieldFn = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error("Housekeeping cancelled");
  };

  // Step 1: Unmapped re-check (#113) before evaluating unowned audio files
  if (options.runUnmappedRecheck !== false) {
    try {
      if (options.recheckUnmapped) {
        await options.recheckUnmapped();
      } else {
        await new UnmappedFilesService().recheckExistingUnmappedFiles();
      }
    } catch (error) {
      console.warn("[Housekeeping] Unmapped re-check failed before stray cleanup:", error);
    }
  }

  checkCancelled();
  await yieldFn();

  // Step 2: Walk each configured library root
  const stereoRootRaw = Config.getMusicPath();
  const atmosRootRaw = Config.getSpatialPath();
  const videoRootRaw = Config.getVideoPath();
  const rootEntries: Array<{ slot: "music" | "spatial" | "videos"; rootPath: string }> = [];
  const seenRoots = new Set<string>();
  for (const [slot, rawPath] of [
    ["music", stereoRootRaw],
    ["spatial", atmosRootRaw],
    ["videos", videoRootRaw],
  ] as const) {
    if (!rawPath) continue;
    const resolved = path.resolve(rawPath);
    const norm = normalizeResolvedPath(resolved, process.platform === "win32" || isCaseInsensitivePath(resolved));
    if (!norm || seenRoots.has(norm) || !fs.existsSync(resolved)) continue;
    seenRoots.add(norm);
    rootEntries.push({ slot, rootPath: resolved });
  }

  const activeJobPayloads = collectActiveJobHints();
  const now = Date.now();

  for (const { slot, rootPath } of rootEntries) {
    checkCancelled();
    const caseInsensitive = process.platform === "win32" || isCaseInsensitivePath(rootPath);
    const trackedPaths = buildTrackedPathsSet(caseInsensitive);
    const activeImportPaths = collectActiveImportPaths(caseInsensitive);

    const visitDir = async (dir: string, isRoot: boolean): Promise<void> => {
      checkCancelled();
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const subdirs: string[] = [];
      const filesInDir: Array<{ name: string; fullPath: string }> = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          subdirs.push(fullPath);
        } else if (entry.isFile()) {
          filesInDir.push({ name: entry.name, fullPath });
        }
      }

      for (const subdir of subdirs) {
        await visitDir(subdir, false);
      }

      // Track stems of media files present in this folder for orphan lyric detection
      const mediaStems = new Set<string>();
      for (const { name } of filesInDir) {
        const ext = path.extname(name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || ext === ".mp4") {
          const stem = path.basename(name, ext);
          mediaStems.add(caseInsensitive ? stem.toLowerCase() : stem);
        }
      }

      for (const { name, fullPath } of filesInDir) {
        const normPath = normalizeResolvedPath(fullPath, caseInsensitive);
        if (trackedPaths.has(normPath)) continue;

        const ext = path.extname(name).toLowerCase();

        // 1. Stale temp/partial files
        if (isTempOrPartialFile(name)) {
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs >= tempMaxAgeMs && !isOwnedByRunningJob(fullPath, activeJobPayloads)) {
              fs.rmSync(fullPath, { force: true });
              summary.tempFilesRemoved += 1;
              await withSqliteWriteGate(
                () => recordDeletionHistory(fullPath, "Housekeeping: removed stale temporary/partial file"),
                "housekeeping:history-temp",
              );
            }
          } catch {
            // Ignore transient stat/unlink errors.
          }
          continue;
        }

        // 2. Orphan lyric/sidecar files without matching media file
        if (LYRIC_SIDECAR_EXTENSIONS.has(ext)) {
          const stem = path.basename(name, ext);
          const stemKey = caseInsensitive ? stem.toLowerCase() : stem;
          if (!mediaStems.has(stemKey)) {
            try {
              fs.rmSync(fullPath, { force: true });
              summary.orphanLyricsRemoved += 1;
              await withSqliteWriteGate(
                () => recordDeletionHistory(fullPath, "Housekeeping: removed orphan lyric/sidecar file without matching media file"),
                "housekeeping:history-lyric",
              );
            } catch {
              // Ignore unlink errors.
            }
          }
          continue;
        }

        // 3. Unowned audio files (not in TrackFiles/ExtraFiles and not queued for import)
        const isAudioCandidate = AUDIO_EXTENSIONS.has(ext) || (slot !== "videos" && ext === ".mp4");
        if (isAudioCandidate && !activeImportPaths.has(normPath)) {
          try {
            fs.rmSync(fullPath, { force: true });
            summary.unownedAudioRemoved += 1;
            await withSqliteWriteGate(() => {
              db.prepare(`DELETE FROM UnmappedFiles WHERE file_path = ?`).run(fullPath);
              recordDeletionHistory(fullPath, "Housekeeping: removed unowned non-importable audio file");
            }, "housekeeping:unowned-audio");
          } catch {
            // Ignore unlink errors.
          }
        }
      }

      // 4. Remove empty folders (never the root folder itself)
      if (!isRoot) {
        try {
          if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            summary.emptyFoldersRemoved += 1;
            await withSqliteWriteGate(
              () => recordDeletionHistory(dir, "Housekeeping: removed empty folder"),
              "housekeeping:history-empty-dir",
            );
          }
        } catch {
          // Ignore non-empty or locked dirs.
        }
      }
    };

    await visitDir(rootPath, true);
  }

  // Step 3: Enforce stereo vs Atmos placement on TrackFiles
  checkCancelled();
  await yieldFn();

  const stereoRoot = stereoRootRaw ? path.resolve(stereoRootRaw) : null;
  const atmosRoot = atmosRootRaw ? path.resolve(atmosRootRaw) : null;
  if (
    stereoRoot
    && atmosRoot
    && normalizeResolvedPath(stereoRoot) !== normalizeResolvedPath(atmosRoot)
  ) {
    const stereoCaseInsensitive = process.platform === "win32" || isCaseInsensitivePath(stereoRoot);
    const atmosCaseInsensitive = process.platform === "win32" || isCaseInsensitivePath(atmosRoot);

    const trackFiles = db.prepare(`
      SELECT id, file_path, relative_path, library_root, library_id, release_group_id,
             album_edition_id, track_id, recording_id, artist_metadata_id, quality, file_type
      FROM TrackFiles
      WHERE file_type = 'track' AND recording_id IS NOT NULL
    `).all() as PlacementTrackFileRow[];

    const filesByRecording = new Map<number, PlacementTrackFileRow[]>();
    const atmosAlbums = new Set<number>();
    for (const tf of trackFiles) {
      if (tf.recording_id != null) {
        const list = filesByRecording.get(tf.recording_id) ?? [];
        list.push(tf);
        filesByRecording.set(tf.recording_id, list);
      }
      if (tf.release_group_id != null && isSpatialAudioQuality(tf.quality)) {
        atmosAlbums.add(tf.release_group_id);
      }
    }

    // Also treat albums with a spatial edition / spatial acquisition plan as Atmos albums
    const spatialAlbumRows = db.prepare(`
      SELECT DISTINCT ae.release_group_id
      FROM AlbumEditions ae
      WHERE ae.release_group_id IS NOT NULL
        AND (
          LOWER(COALESCE(ae.disambiguation, '')) LIKE '%atmos%'
          OR LOWER(COALESCE(ae.title, '')) LIKE '%atmos%'
          OR EXISTS (
            SELECT 1 FROM AcquisitionPlans ap
            WHERE ap.edition_id = ae.id AND ap.state = 'current'
              AND ap.library_id = ?
          )
        )
    `).all(resolveLibraryIdForRoot(atmosRoot) ?? -1) as Array<{ release_group_id: number }>;
    for (const row of spatialAlbumRows) {
      atmosAlbums.add(row.release_group_id);
    }

    const stereoLibraryId = resolveLibraryIdForRoot(stereoRoot);
    const atmosLibraryId = resolveLibraryIdForRoot(atmosRoot);

    for (const tf of trackFiles) {
      checkCancelled();
      if (tf.recording_id == null) continue;
      const peers = filesByRecording.get(tf.recording_id) ?? [tf];
      const evaluation = evaluateTrackFilePlacement({
        file: tf,
        stereoRoot,
        atmosRoot,
        recordingFileCount: peers.length,
        recordingHasAtmosVersion: peers.some((p) => isSpatialAudioQuality(p.quality)),
        albumIsAtmos: tf.release_group_id != null && atmosAlbums.has(tf.release_group_id),
        stereoCaseInsensitive,
        atmosCaseInsensitive,
      });
      if (evaluation.allowed) continue;

      const targetRoot = evaluation.targetSlot === "atmos" ? atmosRoot : stereoRoot;
      const targetCaseInsensitive = evaluation.targetSlot === "atmos" ? atmosCaseInsensitive : stereoCaseInsensitive;
      const targetLibId = evaluation.targetSlot === "atmos" ? atmosLibraryId : stereoLibraryId;

      const copyExistsInTarget = peers.some(
        (peer) => peer.id !== tf.id && isPathUnderRoot(peer.file_path, targetRoot, targetCaseInsensitive),
      );

      if (copyExistsInTarget) {
        try {
          if (fs.existsSync(tf.file_path)) {
            fs.rmSync(tf.file_path, { force: true });
            const sourceRoot = evaluation.targetSlot === "atmos" ? stereoRoot : atmosRoot;
            removeEmptyParents(path.dirname(tf.file_path), sourceRoot);
          }
          await withSqliteWriteGate(() => {
            db.prepare(`DELETE FROM TrackFiles WHERE id = ?`).run(tf.id);
            recordDeletionHistory(tf.file_path, `Housekeeping: ${evaluation.reason} (copy already exists in ${evaluation.targetSlot} library)`, {
              artistId: tf.artist_metadata_id,
              albumId: tf.release_group_id,
              mediaId: tf.track_id,
              libraryFileId: tf.id,
              quality: tf.quality,
            });
          }, "housekeeping:misplaced-delete");
          summary.misplacedDeleted += 1;
        } catch (error) {
          console.warn(`[Housekeeping] Failed to delete misplaced file ${tf.file_path}:`, error);
        }
      } else {
        const sourceRoot = evaluation.targetSlot === "atmos" ? stereoRoot : atmosRoot;
        const relPath = tf.relative_path || path.relative(sourceRoot, tf.file_path);
        const destPath = path.join(targetRoot, relPath);
        try {
          if (fs.existsSync(tf.file_path)) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            try {
              fs.renameSync(tf.file_path, destPath);
            } catch {
              fs.copyFileSync(tf.file_path, destPath);
              fs.rmSync(tf.file_path, { force: true });
            }
            removeEmptyParents(path.dirname(tf.file_path), sourceRoot);
          }
          await withSqliteWriteGate(() => {
            db.prepare(`
              UPDATE TrackFiles
              SET file_path = ?,
                  relative_path = ?,
                  library_root = ?,
                  library_id = COALESCE(?, library_id)
              WHERE id = ?
            `).run(destPath, relPath, targetRoot, targetLibId, tf.id);
            recordMoveHistory(tf.file_path, destPath, `Housekeeping: ${evaluation.reason}`, tf);
          }, "housekeeping:misplaced-move");
          summary.misplacedMoved += 1;
        } catch (error) {
          console.warn(`[Housekeeping] Failed to move misplaced file ${tf.file_path} -> ${destPath}:`, error);
        }
      }
    }
  }

  return summary;
}
