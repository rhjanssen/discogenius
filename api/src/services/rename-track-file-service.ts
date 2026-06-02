import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { Config } from "./config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";
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
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  file_type: string;
  extension: string;
  library_slot?: string | null;
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
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension, library_slot, quality, codec, bitrate, sample_rate, bit_depth, channels
      FROM (
        SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension, library_slot, quality, codec, bitrate, sample_rate, bit_depth, channels, created_at
        FROM TrackFiles

        UNION ALL

        SELECT Id + 10000000 AS id, ArtistId AS artist_id, AlbumId AS album_id, MediaId AS media_id, FilePath AS file_path, RelativePath AS relative_path, LibraryRoot AS library_root, FileType AS file_type, Extension AS extension, LibrarySlot AS library_slot, NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM MetadataFiles

        UNION ALL

        SELECT Id + 20000000 AS id, ArtistId AS artist_id, AlbumId AS album_id, MediaId AS media_id, FilePath AS file_path, RelativePath AS relative_path, LibraryRoot AS library_root, FileType AS file_type, Extension AS extension, LibrarySlot AS library_slot, NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM ExtraFiles

        UNION ALL

        SELECT Id + 30000000 AS id, ArtistId AS artist_id, AlbumId AS album_id, MediaId AS media_id, FilePath AS file_path, RelativePath AS relative_path, LibraryRoot AS library_root, 'lyrics' AS file_type, Extension AS extension, LibrarySlot AS library_slot, Quality AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
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
        const filePathCol = tableName === "TrackFiles" ? "file_path" : "FilePath";
        const expectedPathCol = tableName === "TrackFiles" ? "expected_path" : "ExpectedPath";

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
        const expectedPathCol = decoded.tableName === "TrackFiles" ? "expected_path" : "ExpectedPath";
        const needsRenameCol = decoded.tableName === "TrackFiles" ? "needs_rename" : "NeedsRename";
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
        const relPathCol = decoded.tableName === "TrackFiles" ? "relative_path" : "RelativePath";
        const libraryRootCol = decoded.tableName === "TrackFiles" ? "library_root" : "LibraryRoot";
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
          SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension, library_slot, quality, codec, bitrate, sample_rate, bit_depth, channels
          FROM TrackFiles
          WHERE id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      } else if (decoded.tableName === "MetadataFiles") {
        const row = db.prepare(`
          SELECT Id AS id, ArtistId AS artist_id, AlbumId AS album_id, MediaId AS media_id, FilePath AS file_path, RelativePath AS relative_path, LibraryRoot AS library_root, FileType AS file_type, Extension AS extension, LibrarySlot AS library_slot, NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels
          FROM MetadataFiles
          WHERE Id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      } else if (decoded.tableName === "ExtraFiles") {
        const row = db.prepare(`
          SELECT Id AS id, ArtistId AS artist_id, AlbumId AS album_id, MediaId AS media_id, FilePath AS file_path, RelativePath AS relative_path, LibraryRoot AS library_root, FileType AS file_type, Extension AS extension, LibrarySlot AS library_slot, NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels
          FROM ExtraFiles
          WHERE Id = ?
        `).get(decoded.id) as RenameLibraryFileRow | undefined;
        if (row) {
          rows.push({ ...row, id: syntheticId });
        }
      } else if (decoded.tableName === "LyricFiles") {
        const row = db.prepare(`
          SELECT Id AS id, ArtistId AS artist_id, AlbumId AS album_id, MediaId AS media_id, FilePath AS file_path, RelativePath AS relative_path, LibraryRoot AS library_root, 'lyrics' AS file_type, Extension AS extension, LibrarySlot AS library_slot, Quality AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels
          FROM LyricFiles
          WHERE Id = ?
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
        const expectedPathCol = tableName === "TrackFiles" ? "expected_path" : "ExpectedPath";
        const needsRenameCol = tableName === "TrackFiles" ? "needs_rename" : "NeedsRename";

        if (samePath) {
          dbUpdates.push({
            sql: `UPDATE ${tableName} SET ${expectedPathCol} = ?, ${needsRenameCol} = 0, ${tableName === "TrackFiles" ? "verified_at = CURRENT_TIMESTAMP" : "LastUpdated = CURRENT_TIMESTAMP"} WHERE ${idCol} = ?`,
            args: [expectedPath, decoded.id],
          });
          result.skipped++;
          continue;
        }

        const filePathCol = tableName === "TrackFiles" ? "file_path" : "FilePath";
        const dbConflict = db.prepare(`
          SELECT ${idCol} AS id
          FROM ${tableName}
          WHERE ${idCol} != ?
            AND (${filePathCol} = ? OR ${expectedPathCol} = ?)
          LIMIT 1
        `).get(decoded.id, expectedPath, expectedPath) as { id: number } | undefined;

        const fsConflict = fs.existsSync(expectedPath);
        if (dbConflict || fsConflict) {
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
              SET FilePath = ?,
                  RelativePath = ?,
                  LibraryRoot = ?,
                  Extension = ?,
                  ExpectedPath = ?,
                  NeedsRename = 0,
                  LastUpdated = CURRENT_TIMESTAMP
              WHERE Id = ?`,
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
      this.replicateSeparatedAudioSidecars();
    }

    if (result.renamed > 0) {
      result.cleanedDirectories = this.cleanEmptyDirectories();
    }

    return result;
  }

  static executeRenameArtist(options: { artistId: string }): RenameApplyResult {
    return this.executeRenameFilesByQuery({ artistId: options.artistId });
  }

  private static replicateSeparatedAudioSidecars() {
    const musicRoot = Config.getMusicPath();
    const spatialRoot = Config.getSpatialPath();
    if (normalizeResolvedPath(musicRoot) === normalizeResolvedPath(spatialRoot)) {
      return;
    }

    const tracks = db.prepare(`
      SELECT tf.artist_id, tf.album_id, tf.media_id, tf.library_slot, tf.quality,
             pa.title AS album_title, pm.title AS track_title
      FROM TrackFiles tf
      JOIN ProviderAlbums pa ON pa.id = tf.album_id
      JOIN ProviderMedia pm ON pm.id = tf.media_id
      WHERE tf.file_type = 'track'
        AND tf.library_slot IN ('stereo', 'spatial')
    `).all() as Array<{
      artist_id: string;
      album_id: string;
      media_id: string;
      library_slot: "stereo" | "spatial";
      quality: string | null;
      album_title: string;
      track_title: string;
    }>;

    const copyTrackedAsset = (source: any, target: {
      artistId: string;
      albumId?: string | null;
      mediaId?: string | null;
      librarySlot: "stereo" | "spatial";
      libraryRoot: string;
      quality?: string | null;
      fileType: string;
    }) => {
      const sourcePath = resolveStoredLibraryPath({
        filePath: source.FilePath,
        libraryRoot: source.LibraryRoot,
        relativePath: source.RelativePath,
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
        extension: source.Extension || path.extname(sourcePath).replace(".", ""),
        quality: target.quality || null,
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
        filePath: expectedPath,
        libraryRoot: target.libraryRoot,
        fileType: target.fileType,
        quality: target.quality,
        librarySlot: target.librarySlot,
      });
    };

    for (const track of tracks) {
      const targetRoot = track.library_slot === "spatial" ? spatialRoot : musicRoot;
      const artistAssets = db.prepare(`
        SELECT * FROM MetadataFiles
        WHERE ArtistId = ? AND AlbumId IS NULL AND MediaId IS NULL
          AND FileType IN ('cover', 'nfo')
      `).all(track.artist_id) as any[];
      for (const asset of artistAssets) {
        copyTrackedAsset(asset, {
          artistId: track.artist_id,
          librarySlot: track.library_slot,
          libraryRoot: targetRoot,
          fileType: asset.FileType,
        });
      }

      const albumAssets = db.prepare(`
        SELECT mf.*
        FROM MetadataFiles mf
        JOIN ProviderAlbums pa ON pa.id = mf.AlbumId
        WHERE mf.ArtistId = ? AND mf.AlbumId IS NOT NULL AND mf.MediaId IS NULL
          AND mf.FileType IN ('cover', 'nfo') AND pa.title = ?
      `).all(track.artist_id, track.album_title) as any[];
      for (const asset of albumAssets) {
        copyTrackedAsset(asset, {
          artistId: track.artist_id,
          albumId: track.album_id,
          librarySlot: track.library_slot,
          libraryRoot: targetRoot,
          fileType: asset.FileType,
        });
      }

      const lyrics = db.prepare(`
        SELECT lf.*
        FROM LyricFiles lf
        JOIN ProviderMedia pm ON pm.id = lf.MediaId
        WHERE lf.ArtistId = ? AND pm.title = ?
      `).all(track.artist_id, track.track_title) as any[];
      for (const lyric of lyrics) {
        copyTrackedAsset(lyric, {
          artistId: track.artist_id,
          albumId: track.album_id,
          mediaId: track.media_id,
          librarySlot: track.library_slot,
          libraryRoot: targetRoot,
          quality: track.quality,
          fileType: "lyrics",
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
