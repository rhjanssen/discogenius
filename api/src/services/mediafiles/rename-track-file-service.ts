import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { Config } from "../config/config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../jobs/history-events.js";
import { getCurrentLibraryRootPath, resolveLibraryRootKey, resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import {
  LibraryFilesService,
  removeEmptyParents,
  type RenameApplyResult,
  type RenamePreviewItem,
  type RenameScopeOptions,
  type RenameStatusSummary,
} from "./library-files.js";
import { normalizeResolvedPath } from "./path-utils.js";

type TableNameType = "TrackFiles" | "MetadataFiles" | "ExtraFiles" | "LyricFiles";

function decodeSyntheticId(syntheticId: number): { id: number; tableName: TableNameType } {
  if (syntheticId >= 30000000) {
    return { id: syntheticId - 30000000, tableName: "LyricFiles" };
  }
  if (syntheticId >= 20000000) {
    return { id: syntheticId - 20000000, tableName: "ExtraFiles" };
  }
  if (syntheticId >= 10000000) {
    return { id: syntheticId - 10000000, tableName: "MetadataFiles" };
  }
  return { id: syntheticId, tableName: "TrackFiles" };
}

type RenameLibraryFileRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  canonical_artist_mbid?: string | null;
  canonical_release_group_mbid?: string | null;
  canonical_release_mbid?: string | null;
  canonical_track_mbid?: string | null;
  canonical_recording_mbid?: string | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  extension: string;
  library_slot?: string | null;
  provider?: string | null;
  provider_entity_type?: string | null;
  provider_id?: string | null;
  quality?: string | null;
  codec?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channels?: number | null;
};

type RenameFileEvent = {
  libraryFileId: number;
  artistId: number;
  albumId: number | null;
  mediaId: number | null;
  fileType: string;
  filePath: string;
  libraryRoot: string;
  previousPath: string;
};

function getLibraryRootFilterValues(libraryRoot: string | null | undefined): string[] {
  const raw = String(libraryRoot || "").trim();
  if (!raw) {
    return [];
  }

  const key = resolveLibraryRootKey(raw, raw);
  if (!key) {
    return [raw];
  }

  return Array.from(new Set([key, getCurrentLibraryRootPath(key), raw]));
}

function moveFileCrossDevice(sourcePath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    fs.renameSync(sourcePath, destPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(sourcePath, destPath, fs.constants.COPYFILE_EXCL);
    fs.rmSync(sourcePath, { force: true });
  }
}

export class RenameTrackFileService {
  private static getRenameRows(options: RenameScopeOptions = {}, includePaging = true): RenameLibraryFileRow[] {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;

    const where: string[] = [];
    const params: any[] = [];

    if (options.artistId) {
      where.push("lf.artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push("lf.album_id = ?");
      params.push(options.albumId);
    }
    if (options.libraryRoot) {
      const rootValues = getLibraryRootFilterValues(options.libraryRoot);
      if (rootValues.length > 0) {
        where.push(`lf.library_root IN (${rootValues.map(() => "?").join(",")})`);
        params.push(...rootValues);
      }
    }
    if (options.fileTypes && options.fileTypes.length > 0) {
      where.push(`lf.file_type IN (${options.fileTypes.map(() => "?").join(",")})`);
      params.push(...options.fileTypes);
    }

    const sql = `
      SELECT id, artist_id, album_id, media_id,
             canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
             file_path, relative_path, library_root, file_type, extension, library_slot,
             provider, provider_entity_type, provider_id,
             quality, codec, bitrate, sample_rate, bit_depth, channels
      FROM (
        SELECT id, artist_id, album_id, media_id,
               canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
               file_path, relative_path, library_root, file_type, extension, library_slot,
               provider, provider_entity_type, provider_id,
               quality, codec, bitrate, sample_rate, bit_depth, channels, created_at
        FROM TrackFiles

        UNION ALL

        SELECT id + 10000000 AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id,
               NULL AS canonical_artist_mbid, NULL AS canonical_release_group_mbid, NULL AS canonical_release_mbid, NULL AS canonical_track_mbid, NULL AS canonical_recording_mbid,
               file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, extension AS extension, library_slot AS library_slot,
               provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
               NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM MetadataFiles

        UNION ALL

        SELECT id + 20000000 AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id,
               NULL AS canonical_artist_mbid, NULL AS canonical_release_group_mbid, NULL AS canonical_release_mbid, NULL AS canonical_track_mbid, NULL AS canonical_recording_mbid,
               file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, extension AS extension, library_slot AS library_slot,
               provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
               NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM ExtraFiles

        UNION ALL

        SELECT id + 30000000 AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id,
               canonical_artist_mbid AS canonical_artist_mbid, canonical_release_group_mbid AS canonical_release_group_mbid, canonical_release_mbid AS canonical_release_mbid, canonical_track_mbid AS canonical_track_mbid, canonical_recording_mbid AS canonical_recording_mbid,
               file_path AS file_path, relative_path AS relative_path, library_root AS library_root, 'lyrics' AS file_type, extension AS extension, library_slot AS library_slot,
               provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
               Quality AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM LyricFiles
      ) lf
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY lf.created_at DESC
      ${includePaging ? "LIMIT ? OFFSET ?" : ""}
    `;

    if (includePaging) {
      params.push(limit, offset);
    }

    return db.prepare(sql).all(...params) as RenameLibraryFileRow[];
  }

  private static evaluateRenameRows(rows: RenameLibraryFileRow[]): RenamePreviewItem[] {
    const updates: Array<{ id: number; expectedPath: string | null; needsRename: number }> = [];
    const relativePathUpdates: Array<{ id: number; relativePath: string; libraryRoot: string }> = [];

    const results: RenamePreviewItem[] = rows.map((row) => {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      const missing = !fs.existsSync(resolvedFilePath);

      const { expectedPath, reason } = LibraryFilesService.computeExpectedPath(row);
      const needsRename = Boolean(expectedPath && normalizeResolvedPath(expectedPath) !== normalizeResolvedPath(resolvedFilePath));

      let conflict = false;
      if (expectedPath) {
        const decoded = decodeSyntheticId(row.id);
        const tableName = decoded.tableName;
        const idCol = tableName === "TrackFiles" ? "id" : "Id";
        const filePathCol = tableName === "TrackFiles" ? "file_path" : "file_path";
        const expectedPathCol = tableName === "TrackFiles" ? "expected_path" : "expected_path";

        const dbConflict = db.prepare(`
          SELECT ${idCol} AS id
          FROM ${tableName}
          WHERE ${idCol} != ?
            AND (${filePathCol} = ? OR ${expectedPathCol} = ?)
          LIMIT 1
        `).get(decoded.id, expectedPath, expectedPath);

        conflict = normalizeResolvedPath(expectedPath) !== normalizeResolvedPath(resolvedFilePath)
          && (fs.existsSync(expectedPath) || Boolean(dbConflict));
      }

      updates.push({ id: row.id, expectedPath, needsRename: needsRename ? 1 : 0 });

      try {
        const root = resolveLibraryRootPath(null, resolvedFilePath)
          || resolveLibraryRootPath(row.library_root, resolvedFilePath);
        if (root) {
          relativePathUpdates.push({
            id: row.id,
            relativePath: path.relative(root, resolvedFilePath),
            libraryRoot: root,
          });
        }
      } catch {
        // Ignore relative path drift until the next successful scan.
      }

      return {
        id: row.id,
        file_type: row.file_type,
        library_root: row.library_root || "",
        artist_id: row.artist_id,
        album_id: row.album_id,
        media_id: row.media_id,
        file_path: resolvedFilePath,
        expected_path: expectedPath,
        needs_rename: needsRename,
        conflict,
        missing,
        reason,
      };
    });

    db.transaction(() => {
      for (const row of updates) {
        const decoded = decodeSyntheticId(row.id);
        const expectedPathCol = decoded.tableName === "TrackFiles" ? "expected_path" : "expected_path";
        const needsRenameCol = decoded.tableName === "TrackFiles" ? "needs_rename" : "needs_rename";
        const idCol = decoded.tableName === "TrackFiles" ? "id" : "Id";

        db.prepare(`
          UPDATE ${decoded.tableName}
          SET ${expectedPathCol} = ?,
              ${needsRenameCol} = ?
          WHERE ${idCol} = ?
        `).run(row.expectedPath, row.needsRename, decoded.id);
      }

      for (const row of relativePathUpdates) {
        const decoded = decodeSyntheticId(row.id);
        const relPathCol = decoded.tableName === "TrackFiles" ? "relative_path" : "relative_path";
        const libraryRootCol = decoded.tableName === "TrackFiles" ? "library_root" : "library_root";
        const idCol = decoded.tableName === "TrackFiles" ? "id" : "Id";

        db.prepare(`
          UPDATE ${decoded.tableName}
          SET ${relPathCol} = ?,
              ${libraryRootCol} = ?
          WHERE ${idCol} = ?
        `).run(row.relativePath, row.libraryRoot, decoded.id);
      }
    })();

    return results;
  }

  static getRenamePreviews(options: RenameScopeOptions): RenamePreviewItem[] {
    return this.evaluateRenameRows(this.getRenameRows(options, true));
  }

  static getRenameStatus(options: RenameScopeOptions = {}, sampleLimit = 10): RenameStatusSummary {
    const results = this.evaluateRenameRows(this.getRenameRows(options, false));
    const actionable = results.filter((item) => item.needs_rename || item.conflict || item.missing);

    return {
      total: results.length,
      renameNeeded: results.filter((item) => item.needs_rename).length,
      conflicts: results.filter((item) => item.conflict).length,
      missing: results.filter((item) => item.missing).length,
      sample: actionable.slice(0, Math.max(0, sampleLimit)),
    };
  }

  static executeRenameFilesByQuery(options: RenameScopeOptions = {}): RenameApplyResult {
    const ids = this.evaluateRenameRows(this.getRenameRows(options, false))
      .filter((item) => item.needs_rename)
      .map((item) => item.id);

    return this.executeRenameFiles(ids);
  }

  static executeRenameFiles(ids: number[]): RenameApplyResult {
    const result: RenameApplyResult = { renamed: 0, skipped: 0, conflicts: 0, missing: 0, cleanedDirectories: 0, errors: [] };
    if (!ids || ids.length === 0) {
      return result;
    }

    const rows: RenameLibraryFileRow[] = [];
    for (const syntheticId of ids) {
      const decoded = decodeSyntheticId(syntheticId);
      if (decoded.tableName === "TrackFiles") {
        const row = db.prepare(`
          SELECT id, artist_id, album_id, media_id,
                 canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
                 file_path, relative_path, library_root, file_type, extension, library_slot,
                 provider, provider_entity_type, provider_id,
                 quality, codec, bitrate, sample_rate, bit_depth, channels
          FROM TrackFiles
          WHERE id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      } else if (decoded.tableName === "MetadataFiles") {
        const row = db.prepare(`
          SELECT id AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id,
                 NULL AS canonical_artist_mbid, NULL AS canonical_release_group_mbid, NULL AS canonical_release_mbid, NULL AS canonical_track_mbid, NULL AS canonical_recording_mbid,
                 file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, extension AS extension, library_slot AS library_slot,
                 provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
                 NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels
          FROM MetadataFiles
          WHERE id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      } else if (decoded.tableName === "ExtraFiles") {
        const row = db.prepare(`
          SELECT id AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id,
                 NULL AS canonical_artist_mbid, NULL AS canonical_release_group_mbid, NULL AS canonical_release_mbid, NULL AS canonical_track_mbid, NULL AS canonical_recording_mbid,
                 file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, extension AS extension, library_slot AS library_slot,
                 provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
                 NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels
          FROM ExtraFiles
          WHERE id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      } else if (decoded.tableName === "LyricFiles") {
        const row = db.prepare(`
          SELECT id AS id, artist_id AS artist_id, album_id AS album_id, media_id AS media_id,
                 canonical_artist_mbid AS canonical_artist_mbid, canonical_release_group_mbid AS canonical_release_group_mbid, canonical_release_mbid AS canonical_release_mbid, canonical_track_mbid AS canonical_track_mbid, canonical_recording_mbid AS canonical_recording_mbid,
                 file_path AS file_path, relative_path AS relative_path, library_root AS library_root, 'lyrics' AS file_type, extension AS extension, library_slot AS library_slot,
                 provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
                 Quality AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels
          FROM LyricFiles
          WHERE id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      }
    }

    const rowMap = new Map(rows.map((row) => [row.id, row]));

    const dbUpdates: Array<{ sql: string; args: unknown[] }> = [];
    const historyEvents: Array<Parameters<typeof recordHistoryEvent>[0]> = [];
    const fileEvents: RenameFileEvent[] = [];

    for (const id of ids) {
      try {
        const row = rowMap.get(id);
        if (!row) {
          result.skipped++;
          continue;
        }

        const resolvedFilePath = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });

        if (!fs.existsSync(resolvedFilePath)) {
          result.missing++;
          continue;
        }

        const { expectedPath } = LibraryFilesService.computeExpectedPath(row);
        if (!expectedPath) {
          result.skipped++;
          continue;
        }

        const samePath = normalizeResolvedPath(expectedPath) === normalizeResolvedPath(resolvedFilePath);
        const decoded = decodeSyntheticId(id);
        const tableName = decoded.tableName;
        const idCol = tableName === "TrackFiles" ? "id" : "Id";
        const expectedPathCol = tableName === "TrackFiles" ? "expected_path" : "expected_path";
        const needsRenameCol = tableName === "TrackFiles" ? "needs_rename" : "needs_rename";

        if (samePath) {
          dbUpdates.push({
            sql: `UPDATE ${tableName} SET ${expectedPathCol} = ?, ${needsRenameCol} = 0, ${tableName === "TrackFiles" ? "verified_at = CURRENT_TIMESTAMP" : "last_updated = CURRENT_TIMESTAMP"} WHERE ${idCol} = ?`,
            args: [expectedPath, decoded.id],
          });
          result.skipped++;
          continue;
        }

        const filePathCol = tableName === "TrackFiles" ? "file_path" : "file_path";
        const dbConflict = db.prepare(`
          SELECT ${idCol} AS id
          FROM ${tableName}
          WHERE ${idCol} != ?
            AND (${filePathCol} = ? OR ${expectedPathCol} = ?)
          LIMIT 1
        `).get(decoded.id, expectedPath, expectedPath) as { id: number } | undefined;

        const fsConflict = fs.existsSync(expectedPath);
        if (dbConflict || fsConflict) {
          // Merged-root sidecar dedup: when library roots are combined,
          // artist/album-scoped sidecars (artist.nfo, folder.jpg, cover.jpg)
          // from the previously separate roots map to one target path. The
          // destination already holds the same logical artifact, so drop the
          // source duplicate instead of reporting an unresolvable conflict.
          const isScopedSidecar = row.media_id == null && (row.file_type === "nfo" || row.file_type === "cover");
          let duplicateOfSameScope = false;
          if (isScopedSidecar) {
            if (dbConflict) {
              const occupant = db.prepare(`
                SELECT artist_id, album_id, media_id, file_type
                FROM ${tableName}
                WHERE ${idCol} = ?
              `).get(dbConflict.id) as {
                artist_id?: string | number | null;
                album_id?: string | number | null;
                media_id?: string | number | null;
                file_type?: string | null;
              } | undefined;
              duplicateOfSameScope = Boolean(
                occupant
                && occupant.media_id == null
                && occupant.file_type === row.file_type
                && String(occupant.artist_id ?? "") === String(row.artist_id ?? "")
                && String(occupant.album_id ?? "") === String(row.album_id ?? ""),
              );
            } else {
              // Target exists on disk at this scope's canonical sidecar path.
              duplicateOfSameScope = true;
            }
          }

          if (duplicateOfSameScope) {
            const sourceDir = path.dirname(resolvedFilePath);
            try {
              fs.rmSync(resolvedFilePath, { force: true });
            } catch (removeError) {
              result.errors.push({ id, error: removeError instanceof Error ? removeError.message : String(removeError) });
              continue;
            }
            dbUpdates.push({
              sql: `DELETE FROM ${tableName} WHERE ${idCol} = ?`,
              args: [decoded.id],
            });
            historyEvents.push({
              artistId: row.artist_id,
              albumId: row.album_id,
              mediaId: row.media_id,
              libraryFileId: row.id,
              eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
              data: {
                deletedPath: resolvedFilePath,
                replacementPath: expectedPath,
                fileType: row.file_type,
                reason: "merged-root-sidecar-duplicate",
              },
            });
            const sourceRoot = resolveLibraryRootPath(row.library_root, resolvedFilePath);
            if (sourceRoot) {
              removeEmptyParents(sourceDir, sourceRoot);
            }
            result.renamed++;
            continue;
          }

          dbUpdates.push({
            sql: `UPDATE ${tableName} SET ${expectedPathCol} = ?, ${needsRenameCol} = 1 WHERE ${idCol} = ?`,
            args: [expectedPath, decoded.id],
          });
          result.conflicts++;
          continue;
        }

        const oldDir = path.dirname(resolvedFilePath);
        moveFileCrossDevice(resolvedFilePath, expectedPath);

        const root = resolveLibraryRootPath(null, expectedPath)
          || resolveLibraryRootPath(row.library_root, resolvedFilePath)
          || path.dirname(expectedPath);
        const relativePath = root ? path.relative(root, expectedPath) : path.basename(expectedPath);
        const filename = path.basename(expectedPath);
        const extension = path.extname(expectedPath).replace(".", "");
        const stats = fs.statSync(expectedPath);

        if (tableName === "TrackFiles") {
          dbUpdates.push({
            sql: `UPDATE TrackFiles
              SET file_path = ?,
                  relative_path = ?,
                  library_root = ?,
                  filename = ?,
                  extension = ?,
                  expected_path = ?,
                  needs_rename = 0,
                  modified_at = ?,
                  verified_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            args: [expectedPath, relativePath, root, filename, extension, expectedPath, stats.mtime.toISOString(), decoded.id],
          });
        } else {
          dbUpdates.push({
            sql: `UPDATE ${tableName}
              SET file_path = ?,
                  relative_path = ?,
                  library_root = ?,
                  extension = ?,
                  expected_path = ?,
                  needs_rename = 0,
                  last_updated = CURRENT_TIMESTAMP
              WHERE id = ?`,
            args: [expectedPath, relativePath, root, extension, expectedPath, decoded.id],
          });
        }

        historyEvents.push({
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          libraryFileId: row.id,
          eventType: HISTORY_EVENT_TYPES.TrackFileRenamed,
          data: {
            fromPath: resolvedFilePath,
            toPath: expectedPath,
            fileType: row.file_type,
          },
        });
        fileEvents.push({
          libraryFileId: row.id,
          artistId: row.artist_id,
          albumId: row.album_id,
          mediaId: row.media_id,
          fileType: row.file_type,
          filePath: expectedPath,
          libraryRoot: root,
          previousPath: resolvedFilePath,
        });

        removeEmptyParents(oldDir, root);
        result.renamed++;
      } catch (error) {
        result.errors.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (dbUpdates.length > 0 || historyEvents.length > 0) {
      db.transaction(() => {
        for (const update of dbUpdates) {
          db.prepare(update.sql).run(...update.args);
        }
        for (const event of historyEvents) {
          try {
            recordHistoryEvent(event);
          } catch (historyError) {
            console.warn("[RenameTrackFileService] Failed to record rename history:", historyError);
          }
        }
      })();
    }

    for (const event of fileEvents) {
      LibraryFilesService.emitFileUpgraded({
        libraryFileId: event.libraryFileId,
        artistId: event.artistId,
        albumId: event.albumId,
        mediaId: event.mediaId,
        fileType: event.fileType,
        filePath: event.filePath,
        libraryRoot: event.libraryRoot,
        previousPath: event.previousPath,
      });
    }

    if (result.renamed > 0) {
      this.replicateSeparatedSidecars();
    }

    if (result.renamed > 0) {
      result.cleanedDirectories = this.cleanEmptyDirectories();
    }

    return result;
  }

  static executeRenameArtist(options: { artistId: string }): RenameApplyResult {
    return this.executeRenameFilesByQuery({ artistId: options.artistId });
  }

  private static replicateSeparatedSidecars() {
    const musicRoot = Config.getMusicPath();
    const spatialRoot = Config.getSpatialPath();
    const videoRoot = Config.getVideoPath();
    if (normalizeResolvedPath(musicRoot) === normalizeResolvedPath(spatialRoot) &&
        normalizeResolvedPath(musicRoot) === normalizeResolvedPath(videoRoot)) {
      return;
    }

    const tracks = db.prepare(`
      SELECT tf.id, tf.artist_id, tf.album_id, tf.media_id, tf.library_slot, tf.quality, tf.file_type,
             tf.canonical_artist_mbid, tf.canonical_release_group_mbid, tf.canonical_release_mbid,
             tf.canonical_track_mbid, tf.canonical_recording_mbid,
             tf.provider, tf.provider_entity_type, tf.provider_id
      FROM TrackFiles tf
      WHERE tf.file_type IN ('track', 'video')
        AND (tf.library_slot IN ('stereo', 'spatial') OR tf.file_type = 'video')
    `).all() as Array<{
      id: number;
      artist_id: string;
      album_id: string | null;
      media_id: string | null;
      library_slot: "stereo" | "spatial" | null;
      file_type: string;
      quality: string | null;
      canonical_artist_mbid: string | null;
      canonical_release_group_mbid: string | null;
      canonical_release_mbid: string | null;
      canonical_track_mbid: string | null;
      canonical_recording_mbid: string | null;
      provider: string | null;
      provider_entity_type: string | null;
      provider_id: string | null;
    }>;

    const copyTrackedAsset = (source: any, target: {
      artistId: string;
      albumId?: string | null;
      mediaId?: string | null;
      trackFileId?: number | null;
      librarySlot?: "stereo" | "spatial" | string | null;
      libraryRoot: string;
      quality?: string | null;
      fileType: string;
      canonicalArtistMbid?: string | null;
      canonicalReleaseGroupMbid?: string | null;
      canonicalReleaseMbid?: string | null;
      canonicalTrackMbid?: string | null;
      canonicalRecordingMbid?: string | null;
      provider?: string | null;
      providerEntityType?: string | null;
      providerId?: string | null;
    }) => {
      const sourcePath = resolveStoredLibraryPath({
        filePath: source.file_path,
        libraryRoot: source.library_root,
        relativePath: source.relative_path,
      });
      if (!fs.existsSync(sourcePath)) return;

      const expectedPath = LibraryFilesService.computeExpectedPath({
        id: -1,
        artist_id: target.artistId as unknown as number,
        album_id: target.albumId ? target.albumId as unknown as number : null,
        media_id: target.mediaId ? target.mediaId as unknown as number : null,
        file_path: sourcePath,
        relative_path: null,
        library_root: target.libraryRoot,
        library_slot: target.librarySlot,
        file_type: target.fileType,
        extension: source.extension || path.extname(sourcePath).replace(".", ""),
        quality: target.quality || null,
        canonical_artist_mbid: target.canonicalArtistMbid || null,
        canonical_release_group_mbid: target.canonicalReleaseGroupMbid || null,
        canonical_release_mbid: target.canonicalReleaseMbid || null,
        canonical_track_mbid: target.canonicalTrackMbid || null,
        canonical_recording_mbid: target.canonicalRecordingMbid || null,
        provider: target.provider || null,
        provider_entity_type: target.providerEntityType || null,
        provider_id: target.providerId || null,
      }).expectedPath;
      if (!expectedPath) return;

      if (normalizeResolvedPath(sourcePath) !== normalizeResolvedPath(expectedPath) && !fs.existsSync(expectedPath)) {
        fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
        fs.copyFileSync(sourcePath, expectedPath);
      }
      LibraryFilesService.upsertLibraryFile({
        artistId: target.artistId,
        albumId: target.albumId,
        mediaId: target.mediaId,
        trackFileId: target.trackFileId,
        filePath: expectedPath,
        libraryRoot: target.libraryRoot,
        fileType: target.fileType,
        quality: target.quality,
        librarySlot: target.librarySlot,
        canonicalArtistMbid: target.canonicalArtistMbid,
        canonicalReleaseGroupMbid: target.canonicalReleaseGroupMbid,
        canonicalReleaseMbid: target.canonicalReleaseMbid,
        canonicalTrackMbid: target.canonicalTrackMbid,
        canonicalRecordingMbid: target.canonicalRecordingMbid,
        provider: target.provider,
        providerEntityType: target.providerEntityType,
        providerId: target.providerId,
      });
    };

    for (const track of tracks) {
      let targetRoot = musicRoot;
      if (track.file_type === 'video') targetRoot = videoRoot;
      else if (track.library_slot === "spatial") targetRoot = spatialRoot;
      const artistAssets = db.prepare(`
        SELECT * FROM MetadataFiles
        WHERE artist_id = ? AND album_id IS NULL AND media_id IS NULL
          AND file_type IN ('cover', 'nfo')
      `).all(track.artist_id) as any[];
      for (const asset of artistAssets) {
        copyTrackedAsset(asset, {
          artistId: track.artist_id,
          librarySlot: track.library_slot,
          libraryRoot: targetRoot,
          fileType: asset.file_type,
          canonicalArtistMbid: track.canonical_artist_mbid,
        });
      }

      const albumAssets = db.prepare(`
        SELECT mf.*
        FROM MetadataFiles mf
        LEFT JOIN ProviderItems album_item
          ON album_item.entity_type = 'album'
         AND (mf.provider IS NULL OR album_item.provider = mf.provider)
         AND CAST(album_item.provider_id AS TEXT) = CAST(COALESCE(mf.provider_id, mf.album_id) AS TEXT)
        WHERE mf.artist_id = ? AND mf.album_id IS NOT NULL AND mf.media_id IS NULL
          AND mf.file_type IN ('cover', 'nfo')
          AND (
            (? IS NOT NULL AND album_item.release_group_mbid = ?)
            OR (? IS NULL AND ? IS NOT NULL AND CAST(mf.album_id AS TEXT) = CAST(? AS TEXT))
          )
      `).all(
        track.artist_id,
        track.canonical_release_group_mbid,
        track.canonical_release_group_mbid,
        track.canonical_release_group_mbid,
        track.album_id,
        track.album_id,
      ) as any[];
      for (const asset of albumAssets) {
        copyTrackedAsset(asset, {
          artistId: track.artist_id,
          albumId: track.album_id,
          librarySlot: track.library_slot,
          libraryRoot: targetRoot,
          fileType: asset.file_type,
          canonicalArtistMbid: track.canonical_artist_mbid,
          canonicalReleaseGroupMbid: track.canonical_release_group_mbid,
          canonicalReleaseMbid: track.canonical_release_mbid,
          provider: asset.provider || track.provider || null,
          providerEntityType: (track.album_id || asset.provider_id) ? "album" : (asset.provider_entity_type || null),
          providerId: track.album_id || asset.provider_id || null,
        });
      }

      const lyrics = db.prepare(`
        SELECT lf.*
        FROM LyricFiles lf
        LEFT JOIN ProviderItems lyric_item
          ON lyric_item.entity_type = 'track'
         AND (lf.provider IS NULL OR lyric_item.provider = lf.provider)
         AND CAST(lyric_item.provider_id AS TEXT) = CAST(COALESCE(lf.provider_id, lf.media_id) AS TEXT)
        WHERE lf.artist_id = ?
          AND (
            (? IS NOT NULL AND lf.canonical_recording_mbid = ?)
            OR (? IS NOT NULL AND lf.canonical_track_mbid = ?)
            OR (? IS NOT NULL AND lyric_item.recording_mbid = ?)
            OR (? IS NOT NULL AND lyric_item.track_mbid = ?)
            OR (
              ? IS NULL AND ? IS NULL
              AND ? IS NOT NULL
              AND CAST(lf.media_id AS TEXT) = CAST(? AS TEXT)
            )
          )
      `).all(
        track.artist_id,
        track.canonical_recording_mbid,
        track.canonical_recording_mbid,
        track.canonical_track_mbid,
        track.canonical_track_mbid,
        track.canonical_recording_mbid,
        track.canonical_recording_mbid,
        track.canonical_track_mbid,
        track.canonical_track_mbid,
        track.canonical_recording_mbid,
        track.canonical_track_mbid,
        track.media_id,
        track.media_id,
      ) as any[];
      for (const lyric of lyrics) {
        copyTrackedAsset(lyric, {
          artistId: track.artist_id,
          albumId: track.album_id,
          mediaId: track.media_id,
          trackFileId: track.id,
          librarySlot: track.library_slot,
          libraryRoot: targetRoot,
          quality: track.quality,
          fileType: "lyrics",
          canonicalArtistMbid: track.canonical_artist_mbid,
          canonicalReleaseGroupMbid: track.canonical_release_group_mbid,
          canonicalReleaseMbid: track.canonical_release_mbid,
          canonicalTrackMbid: track.canonical_track_mbid,
          canonicalRecordingMbid: track.canonical_recording_mbid,
          provider: track.provider || lyric.provider || null,
          providerEntityType: (track.provider_id || track.media_id || lyric.provider_id)
            ? (track.provider_entity_type === "track" ? "track" : (lyric.provider_entity_type || "track"))
            : (lyric.provider_entity_type || null),
          providerId: track.provider_id || track.media_id || lyric.provider_id || null,
        });
      }
    }
  }

  private static cleanEmptyDirectories(): number {
    const roots = [Config.getMusicPath(), Config.getVideoPath()].filter(Boolean);

    try {
      const spatialPath = Config.getSpatialPath();
      if (spatialPath) {
        roots.push(spatialPath);
      }
    } catch {
      // Spatial path may not be configured.
    }

    let removed = 0;
    for (const root of roots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      removed += this.removeEmptyDirsRecursive(root, root);
    }

    if (removed > 0) {
      console.log(`[RenameTrackFileService] Cleaned ${removed} empty director${removed === 1 ? "y" : "ies"}`);
    }

    return removed;
  }

  private static removeEmptyDirsRecursive(dir: string, root: string): number {
    let removed = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          removed += this.removeEmptyDirsRecursive(path.join(dir, entry.name), root);
        }
      }

      if (dir !== root) {
        const remaining = fs.readdirSync(dir);
        if (remaining.length === 0) {
          fs.rmdirSync(dir);
          removed += 1;
        }
      }
    } catch {
      // Permission error or race, skip.
    }

    return removed;
  }
}
