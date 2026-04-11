import fs from "fs";
import path from "path";
import { db } from "../database.js";
import { Config } from "./config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import {
  LibraryFilesService,
  removeEmptyParents,
  type RenameApplyResult,
  type RenamePreviewItem,
  type RenameScopeOptions,
  type RenameStatusSummary,
} from "./library-files.js";
import { normalizeResolvedPath } from "./path-utils.js";

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

function moveFileCrossDevice(sourcePath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    fs.renameSync(sourcePath, destPath);
  } catch {
    fs.copyFileSync(sourcePath, destPath);
    fs.rmSync(sourcePath, { force: true });
  }
}

export class RenameTrackFileService {
  private static getRenameRows(options: RenameScopeOptions = {}, includePaging = true): RenameLibraryFileRow[] {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;

    const where: string[] = [];
    const params: unknown[] = [];

    if (options.artistId) {
      where.push("artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push("album_id = ?");
      params.push(options.albumId);
    }
    if (options.libraryRoot) {
      where.push("library_root = ?");
      params.push(options.libraryRoot);
    }
    if (options.fileTypes && options.fileTypes.length > 0) {
      where.push(`file_type IN (${options.fileTypes.map(() => "?").join(",")})`);
      params.push(...options.fileTypes);
    }

    const sql = `
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension, quality, codec, bitrate, sample_rate, bit_depth, channels
      FROM library_files
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      ${includePaging ? "LIMIT ? OFFSET ?" : ""}
    `;

    if (includePaging) {
      params.push(limit, offset);
    }

    return db.prepare(sql).all(...params) as RenameLibraryFileRow[];
  }

  private static evaluateRenameRows(rows: RenameLibraryFileRow[]): RenamePreviewItem[] {
    const updates: Array<{ id: number; expectedPath: string | null; needsRename: number }> = [];
    const relativePathUpdates: Array<{ id: number; relativePath: string }> = [];
    const findConflict = db.prepare(`
      SELECT id
      FROM library_files
      WHERE id != ?
        AND (file_path = ? OR expected_path = ?)
      LIMIT 1
    `);

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
        conflict = normalizeResolvedPath(expectedPath) !== normalizeResolvedPath(resolvedFilePath)
          && (fs.existsSync(expectedPath) || Boolean(findConflict.get(row.id, expectedPath, expectedPath)));
      }

      updates.push({ id: row.id, expectedPath, needsRename: needsRename ? 1 : 0 });

      try {
        const root = resolveLibraryRootPath(row.library_root, resolvedFilePath);
        if (root) {
          relativePathUpdates.push({
            id: row.id,
            relativePath: path.relative(root, resolvedFilePath),
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
      const update = db.prepare("UPDATE library_files SET expected_path = ?, needs_rename = ? WHERE id = ?");
      for (const row of updates) {
        update.run(row.expectedPath, row.needsRename, row.id);
      }

      const relUpdate = db.prepare(`
        UPDATE library_files
        SET relative_path = ?
        WHERE id = ?
      `);
      for (const row of relativePathUpdates) {
        relUpdate.run(row.relativePath, row.id);
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

    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT id, artist_id, album_id, media_id, file_path, relative_path, library_root, file_type, extension
      FROM library_files
      WHERE id IN (${placeholders})
    `).all(...ids) as RenameLibraryFileRow[];
    const rowMap = new Map(rows.map((row) => [row.id, row]));

    const findConflict = db.prepare(`
      SELECT id
      FROM library_files
      WHERE id != ?
        AND (file_path = ? OR expected_path = ?)
      LIMIT 1
    `);

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
        if (samePath) {
          dbUpdates.push({
            sql: "UPDATE library_files SET expected_path = ?, needs_rename = 0, verified_at = CURRENT_TIMESTAMP WHERE id = ?",
            args: [expectedPath, id],
          });
          result.skipped++;
          continue;
        }

        const dbConflict = findConflict.get(id, expectedPath, expectedPath) as { id: number } | undefined;
        const fsConflict = fs.existsSync(expectedPath);
        if (dbConflict || fsConflict) {
          dbUpdates.push({
            sql: "UPDATE library_files SET expected_path = ?, needs_rename = 1 WHERE id = ?",
            args: [expectedPath, id],
          });
          result.conflicts++;
          continue;
        }

        const oldDir = path.dirname(resolvedFilePath);
        moveFileCrossDevice(resolvedFilePath, expectedPath);

        const root = resolveLibraryRootPath(row.library_root, resolvedFilePath) || path.dirname(expectedPath);
        const relativePath = root ? path.relative(root, expectedPath) : path.basename(expectedPath);
        const filename = path.basename(expectedPath);
        const extension = path.extname(expectedPath).replace(".", "");
        const stats = fs.statSync(expectedPath);

        dbUpdates.push({
          sql: `UPDATE library_files
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
          args: [expectedPath, relativePath, root, filename, extension, expectedPath, stats.mtime.toISOString(), id],
        });

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
      result.cleanedDirectories = this.cleanEmptyDirectories();
    }

    return result;
  }

  static executeRenameArtist(options: { artistId: string }): RenameApplyResult {
    return this.executeRenameFilesByQuery({ artistId: options.artistId });
  }

  private static cleanEmptyDirectories(): number {
    const roots = [Config.getMusicPath(), Config.getVideoPath()].filter(Boolean);

    try {
      const atmosPath = Config.getAtmosPath();
      if (atmosPath) {
        roots.push(atmosPath);
      }
    } catch {
      // Atmos path may not be configured.
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
