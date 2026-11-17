import fs from "fs";
import path from "path";
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
import { removeEmptyParents } from "./library-files.js";
import { UnmappedFilesService } from "./unmapped-files.js";
import { isDestructiveCleanupEnabled } from "./destructive-cleanup-setting.js";
import type { DryRunAction } from "./disk-reconciliation-service.js";

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

export interface StrayAndPlacementResult {
  summary: StrayAndPlacementSummary;
  actions: DryRunAction[];
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
  /** When true, do not perform deletions or file mutations. Default: false. */
  dryRun?: boolean;
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
 * Shared stereo/Atmos placement rule:
 * - An Atmos track file may live in the stereo library only if it is literally the only version of that track.
 * - A stereo track file may live in the Atmos library only if its album is Atmos.
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
    if (params.albumIsAtmos) {
      return { allowed: true };
    }
    return {
      allowed: false,
      targetSlot: "stereo",
      reason: "Stereo track file in Atmos library when the album is not Atmos",
    };
  }

  return { allowed: true };
}

function resolveLibraryIdForRoot(rootPath: string): number | null {
  try {
    const row = db.prepare(`
      SELECT id FROM Libraries WHERE path = ? LIMIT 1
    `).get(rootPath) as { id: number } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function runHousekeepingStrayAndPlacement(
  options: HousekeepingStrayOptions = {},
): Promise<StrayAndPlacementSummary> {
  const result = await runHousekeepingStrayAndPlacementWithReport(options);
  return result.summary;
}

export async function runHousekeepingStrayAndPlacementWithReport(
  options: HousekeepingStrayOptions = {},
): Promise<StrayAndPlacementResult> {
  const isDryRun = options.dryRun === true || !isDestructiveCleanupEnabled();
  const dryRunActions: DryRunAction[] = [];

  const summary: StrayAndPlacementSummary = {
    orphanLyricsRemoved: 0,
    tempFilesRemoved: 0,
    emptyFoldersRemoved: 0,
    unownedAudioRemoved: 0,
    misplacedDeleted: 0,
    misplacedMoved: 0,
  };

  const tempMaxAgeMs = options.tempMaxAgeMs ?? (60 * 60 * 1000); // 1 hour
  const yieldFn = options.yieldToEventLoop ?? (() => new Promise<void>((r) => setImmediate(r)));
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new Error("Housekeeping cancellation requested");
  };

  const stereoRoot = path.resolve(Config.getMusicPath());
  const atmosRoot = path.resolve(Config.getSpatialPath());
  const videoRoot = path.resolve(Config.getVideoPath());
  const roots = [
    { slot: "stereo", path: stereoRoot },
    { slot: "atmos", path: atmosRoot },
    { slot: "video", path: videoRoot },
  ];

  const now = Date.now();

  // ── 1. Orphan Lyrics & Temp Files Sweep ──────────────────────────────────
  for (const { path: rootPath } of roots) {
    checkCancelled();
    if (!fs.existsSync(rootPath)) continue;
    const caseInsensitive = isCaseInsensitivePath(rootPath);

    const sweepDir = async (dir: string): Promise<void> => {
      checkCancelled();
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const mediaStems = new Set<string>();
      const lyricFiles: Array<{ name: string; fullPath: string }> = [];
      const subDirs: string[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const lowerName = entry.name.toLowerCase();
          if (!lowerName.startsWith(".") && lowerName !== "@eadir" && lowerName !== "$recycle.bin") {
            subDirs.push(fullPath);
          }
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        const stem = path.basename(entry.name, path.extname(entry.name)).normalize("NFC");
        const normalizedStem = caseInsensitive ? stem.toLowerCase() : stem;

        if (AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
          mediaStems.add(normalizedStem);
        } else if (LYRIC_SIDECAR_EXTENSIONS.has(ext)) {
          lyricFiles.push({ name: entry.name, fullPath });
        }

        // Temp / partial file removal
        if (isTempOrPartialFile(entry.name)) {
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > tempMaxAgeMs) {
              if (isDryRun) {
                dryRunActions.push({
                  action: "delete_file",
                  path: fullPath,
                  reason: "Aged temporary or partial download file",
                  details: { ageMs: now - stat.mtimeMs },
                });
              } else {
                fs.rmSync(fullPath, { force: true });
                summary.tempFilesRemoved += 1;
              }
            }
          } catch {
            // Ignore stat/rm errors
          }
        }
      }

      // Check orphan lyrics: sidecar has no matching audio/video stem in the directory
      for (const lyric of lyricFiles) {
        const stem = path.basename(lyric.name, path.extname(lyric.name)).normalize("NFC");
        const normalizedStem = caseInsensitive ? stem.toLowerCase() : stem;
        if (!mediaStems.has(normalizedStem)) {
          // Verify it is not tracked in LyricFiles or MetadataFiles
          let isTracked = false;
          if (tableExists("LyricFiles")) {
            const row = db.prepare(`SELECT 1 FROM LyricFiles WHERE file_path = ? LIMIT 1`).get(lyric.fullPath);
            if (row) isTracked = true;
          }
          if (!isTracked && tableExists("MetadataFiles")) {
            const row = db.prepare(`SELECT 1 FROM MetadataFiles WHERE file_path = ? LIMIT 1`).get(lyric.fullPath);
            if (row) isTracked = true;
          }
          if (!isTracked) {
            if (isDryRun) {
              dryRunActions.push({
                action: "delete_file",
                path: lyric.fullPath,
                reason: "Orphan lyric sidecar without corresponding audio file",
              });
            } else {
              try {
                fs.rmSync(lyric.fullPath, { force: true });
                summary.orphanLyricsRemoved += 1;
              } catch {
                // Ignore removal failure
              }
            }
          }
        }
      }

      for (const subDir of subDirs) {
        await sweepDir(subDir);
      }

      // Remove directory if empty (never remove root itself)
      if (dir !== rootPath) {
        try {
          const remaining = fs.readdirSync(dir);
          if (remaining.length === 0) {
            if (isDryRun) {
              dryRunActions.push({
                action: "delete_file",
                path: dir,
                reason: "Empty directory",
              });
            } else {
              fs.rmdirSync(dir);
              summary.emptyFoldersRemoved += 1;
            }
          }
        } catch {
          // Ignore rmdir failure
        }
      }
    };

    await sweepDir(rootPath);
    await yieldFn();
  }

  // ── 2. Unowned Audio Cleanup ─────────────────────────────────────────────
  if (options.runUnmappedRecheck !== false && !isDryRun) {
    if (options.recheckUnmapped) {
      await options.recheckUnmapped();
    } else {
      try {
        await new UnmappedFilesService().recheckExistingUnmappedFiles();
      } catch (err) {
        console.warn("[Housekeeping] Unmapped files recheck failed:", err);
      }
    }
  }

  const trackedAudioFiles = new Set<string>();
  if (tableExists("TrackFiles")) {
    const rows = db.prepare(`
      SELECT file_path, library_root, relative_path FROM TrackFiles
    `).all() as Array<{ file_path: string; library_root: string; relative_path: string | null }>;
    for (const r of rows) {
      const resolved = resolveStoredLibraryPath({
        filePath: r.file_path,
        libraryRoot: r.library_root,
        relativePath: r.relative_path,
      });
      const isInsensitive = isCaseInsensitivePath(resolved);
      trackedAudioFiles.add(normalizeResolvedPath(resolved, isInsensitive));
      trackedAudioFiles.add(normalizeResolvedPath(r.file_path, isInsensitive));
    }
  }

  // Protect all unmapped files: unmapped files are NOT deleted by housekeeping
  if (tableExists("UnmappedFiles")) {
    const unmappedRows = db.prepare(`SELECT file_path FROM UnmappedFiles`).all() as Array<{ file_path: string }>;
    for (const r of unmappedRows) {
      trackedAudioFiles.add(normalizeResolvedPath(r.file_path));
    }
  }

  // Protect ExtraFiles and MetadataFiles
  if (tableExists("ExtraFiles")) {
    const extraRows = db.prepare(`SELECT file_path FROM ExtraFiles`).all() as Array<{ file_path: string }>;
    for (const r of extraRows) {
      trackedAudioFiles.add(normalizeResolvedPath(r.file_path));
    }
  }
  if (tableExists("MetadataFiles")) {
    const metaRows = db.prepare(`SELECT file_path FROM MetadataFiles`).all() as Array<{ file_path: string }>;
    for (const r of metaRows) {
      trackedAudioFiles.add(normalizeResolvedPath(r.file_path));
    }
  }

  // Walk roots for unowned audio files
  for (const { path: rootPath } of roots) {
    checkCancelled();
    if (!fs.existsSync(rootPath)) continue;
    const caseInsensitive = isCaseInsensitivePath(rootPath);

    const checkUnownedAudio = async (dir: string): Promise<void> => {
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
          const lowerName = entry.name.toLowerCase();
          if (!lowerName.startsWith(".") && lowerName !== "@eadir" && lowerName !== "$recycle.bin") {
            await checkUnownedAudio(fullPath);
          }
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext)) continue;

        const normalized = normalizeResolvedPath(fullPath, caseInsensitive);
        if (!trackedAudioFiles.has(normalized)) {
          if (isDryRun) {
            dryRunActions.push({
              action: "delete_file",
              path: fullPath,
              reason: "Unowned audio file not tracked in library",
            });
          } else {
            try {
              fs.rmSync(fullPath, { force: true });
              removeEmptyParents(path.dirname(fullPath), rootPath);
              summary.unownedAudioRemoved += 1;
            } catch (err) {
              console.warn(`[Housekeeping] Failed to remove unowned audio ${fullPath}:`, err);
            }
          }
        }
      }
    };

    await checkUnownedAudio(rootPath);
    await yieldFn();
  }

  // ── 3. Stereo / Atmos Placement Enforcement ──────────────────────────────
  if (
    stereoRoot
    && atmosRoot
    && normalizeResolvedPath(stereoRoot) !== normalizeResolvedPath(atmosRoot)
    && tableExists("TrackFiles")
  ) {
    const stereoCaseInsensitive = isCaseInsensitivePath(stereoRoot);
    const atmosCaseInsensitive = isCaseInsensitivePath(atmosRoot);

    const trackFiles = db.prepare(`
      SELECT id, file_path, relative_path, library_root, library_id, release_group_id,
             album_edition_id, track_id, recording_id, artist_metadata_id, quality,
             file_type
      FROM TrackFiles
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

    if (tableExists("AlbumEditions")) {
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

      // Misplaced file: target library slot
      const targetRoot = evaluation.targetSlot === "atmos" ? atmosRoot : stereoRoot;
      const targetLibId = evaluation.targetSlot === "atmos" ? atmosLibraryId : stereoLibraryId;
      const sourceRoot = evaluation.targetSlot === "atmos" ? stereoRoot : atmosRoot;

      // Locate actual file on disk
      const resolvedSource = resolveStoredLibraryPath({
        filePath: tf.file_path,
        libraryRoot: tf.library_root,
        relativePath: tf.relative_path,
      });
      const actualSourcePath = findOnDiskPath(resolvedSource) ?? (fs.existsSync(tf.file_path) ? tf.file_path : null);
      if (!actualSourcePath) continue;

      const relPath = tf.relative_path || path.relative(sourceRoot, actualSourcePath);
      const destPath = path.join(targetRoot, relPath);

      // SAFETY: Never overwrite an existing destination
      const destExistsOnDisk = Boolean(findOnDiskPath(destPath) || fs.existsSync(destPath));
      let destOwnedInDb = false;
      if (tableExists("TrackFiles")) {
        const destRow = db.prepare(`SELECT 1 FROM TrackFiles WHERE file_path = ? LIMIT 1`).get(destPath);
        if (destRow) destOwnedInDb = true;
      }

      if (destExistsOnDisk || destOwnedInDb) {
        // Destination is occupied: do NOT move, do NOT overwrite, do NOT delete source!
        // Linked tracks are NEVER deleted, and moves never overwrite.
        continue;
      }

      // Destination is free: move file
      if (isDryRun) {
        dryRunActions.push({
          action: "move_file",
          path: actualSourcePath,
          destination: destPath,
          reason: evaluation.reason,
          details: {
            trackFileId: tf.id,
            targetSlot: evaluation.targetSlot,
          },
        });
      } else {
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          try {
            fs.renameSync(actualSourcePath, destPath);
          } catch {
            fs.copyFileSync(actualSourcePath, destPath);
            fs.rmSync(actualSourcePath, { force: true });
          }
          removeEmptyParents(path.dirname(actualSourcePath), sourceRoot);

          await withSqliteWriteGate(() => {
            db.prepare(`
              UPDATE TrackFiles
              SET file_path = ?,
                  relative_path = ?,
                  library_root = ?,
                  library_id = COALESCE(?, library_id)
              WHERE id = ?
            `).run(destPath, relPath, targetRoot, targetLibId, tf.id);
            recordHistoryEvent({
              eventType: HISTORY_EVENT_TYPES.TrackFileRenamed,
              libraryFileId: tf.id,
              artistId: tf.artist_metadata_id,
              albumId: tf.release_group_id,
              mediaId: tf.track_id,
              quality: tf.quality,
              data: {
                sourcePath: actualSourcePath,
                destPath,
                source: "housekeeping:misplaced-move",
                reason: evaluation.reason,
              },
            });
          }, "housekeeping:misplaced-move");
          summary.misplacedMoved += 1;
        } catch (error) {
          console.warn(`[Housekeeping] Failed to move misplaced file ${actualSourcePath} -> ${destPath}:`, error);
        }
      }
    }
  }

  return { summary, actions: dryRunActions };
}
