import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { Config } from "../config/config.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import {
  LibraryFilesService,
  createExpectedPathCache,
  hasExpectedTrackPathConflict,
  preloadExpectedPathIdentities,
  preloadExpectedTrackPathOccupants,
  removeEmptyParents,
  type ExpectedPathCache,
  type RenameApplyResult,
  type RenamePreviewItem,
  type RenameScopeOptions,
  type RenameStatusSummary,
} from "./library-files.js";
import { allowsInlineVideoPlacement } from "./video-folder-layout.js";
import { normalizeResolvedPath } from "./path-utils.js";
import { providerUnambiguousAlbumIdSql } from "../providers/provider-item-artist-scope.js";
import {
  buildRenameFilters,
  buildRenameStatusSummary,
  decodeSyntheticId,
  encodeSyntheticId,
  isSameScopeSidecarOccupant,
  isScopedSidecar,
  tableIdColumn,
  tableTouchedAtColumn,
  type RenameFileEvent,
  type RenameLibraryFileRow,
  type RenameTableName,
} from "./rename-track-file-paths.js";

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

type RenamePhysicalMove = {
  sourcePath: string;
  destinationPath: string;
  sourceRoot: string | null;
};

type StagedRenameDeletion = {
  originalPath: string;
  stagedPath: string;
  sourceRoot: string | null;
  id: number;
};

function rollbackPhysicalMoves(moves: RenamePhysicalMove[]): string[] {
  const errors: string[] = [];
  for (const move of [...moves].reverse()) {
    try {
      if (!fs.existsSync(move.destinationPath)) {
        continue;
      }
      if (fs.existsSync(move.sourcePath)) {
        throw new Error(`source already exists: ${move.sourcePath}`);
      }
      moveFileCrossDevice(move.destinationPath, move.sourcePath);
    } catch (error) {
      errors.push(
        `${move.destinationPath} -> ${move.sourcePath}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

function rollbackStagedDeletions(deletions: StagedRenameDeletion[]): string[] {
  const errors: string[] = [];
  for (const deletion of [...deletions].reverse()) {
    try {
      if (!fs.existsSync(deletion.stagedPath)) {
        continue;
      }
      if (fs.existsSync(deletion.originalPath)) {
        throw new Error(`original path already exists: ${deletion.originalPath}`);
      }
      moveFileCrossDevice(deletion.stagedPath, deletion.originalPath);
    } catch (error) {
      errors.push(
        `${deletion.stagedPath} -> ${deletion.originalPath}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

function stageRenameDeletion(filePath: string, id: number): string {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stagedPath = path.join(
      directory,
      `.${basename}.discogenius-delete-${process.pid}-${Date.now()}-${id}-${attempt}`,
    );
    if (fs.existsSync(stagedPath)) {
      continue;
    }
    fs.renameSync(filePath, stagedPath);
    return stagedPath;
  }
  throw new Error(`Could not allocate a rollback path for ${filePath}`);
}

// Files the rename *preview* lists. Extras (cover/nfo/lyrics/thumbnails) are not
// shown as their own rename decisions — Lidarr's preview lists only track files and
// moves extras as a side effect (ExtraService.MoveFilesAfterRename). The apply path
// still renames extras, so this only changes what the user reviews.
const MEDIA_RENAME_FILE_TYPES = ["track", "video"] as const;

export class RenameTrackFileService {
  private static getRenameRows(
    options: RenameScopeOptions = {},
    includePaging = true,
    mediaOnly = false,
  ): RenameLibraryFileRow[] {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const { where, params } = buildRenameFilters(options);
    if (mediaOnly) {
      where.push(`lf.file_type IN (${MEDIA_RENAME_FILE_TYPES.map(() => "?").join(",")})`);
      params.push(...MEDIA_RENAME_FILE_TYPES);
    }

    const sql = `
      SELECT id, artist_id, album_id, media_id,
             canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
             file_path, relative_path, library_root, file_type, extension, library_slot,
             provider, provider_entity_type, provider_id,
             quality, codec, bitrate, sample_rate, bit_depth, channels
      FROM (
        SELECT id, artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id, provider_id AS media_id,
               canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
               file_path, relative_path, library_root, file_type, extension, library_slot,
               provider, provider_entity_type, provider_id,
               quality, codec, bitrate, sample_rate, bit_depth, channels, created_at
        FROM TrackFiles

        UNION ALL

        SELECT id + 10000000 AS id, artist_id AS artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
               CASE WHEN provider_entity_type = 'video' THEN COALESCE(provider_id, canonical_recording_mbid) ELSE COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) END AS media_id,
               canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
               file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, extension AS extension, library_slot AS library_slot,
               provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
               NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM MetadataFiles

        UNION ALL

        SELECT id + 20000000 AS id, artist_id AS artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id, COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
               canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
               file_path AS file_path, relative_path AS relative_path, library_root AS library_root, file_type AS file_type, extension AS extension, library_slot AS library_slot,
               provider AS provider, provider_entity_type AS provider_entity_type, provider_id AS provider_id,
               NULL AS quality, NULL AS codec, NULL AS bitrate, NULL AS sample_rate, NULL AS bit_depth, NULL AS channels, Added AS created_at
        FROM ExtraFiles

        UNION ALL

        SELECT id + 30000000 AS id, artist_id AS artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id, COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
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

  private static getRenameCandidateCount(options: RenameScopeOptions = {}, mediaOnly = false): number {
    const { where, params } = buildRenameFilters(options);
    if (mediaOnly) {
      where.push(`lf.file_type IN (${MEDIA_RENAME_FILE_TYPES.map(() => "?").join(",")})`);
      params.push(...MEDIA_RENAME_FILE_TYPES);
    }
    const sql = `
      SELECT COUNT(*) AS count
      FROM (
        SELECT artist_id, canonical_release_group_mbid, canonical_release_mbid, provider_entity_type, provider_id, library_root, file_type
        FROM TrackFiles

        UNION ALL

        SELECT artist_id, canonical_release_group_mbid, canonical_release_mbid, provider_entity_type, provider_id, library_root, file_type
        FROM MetadataFiles

        UNION ALL

        SELECT artist_id, canonical_release_group_mbid, canonical_release_mbid, provider_entity_type, provider_id, library_root, file_type
        FROM ExtraFiles

        UNION ALL

        SELECT artist_id, canonical_release_group_mbid, canonical_release_mbid, provider_entity_type, provider_id, library_root, 'lyrics' AS file_type
        FROM LyricFiles
      ) lf
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `;

    const row = db.prepare(sql).get(...params) as { count?: number } | undefined;
    return Number(row?.count || 0);
  }

  private static evaluateRenameRows(
    rows: RenameLibraryFileRow[],
    options: { persist?: boolean } = {},
  ): RenamePreviewItem[] {
    const persist = options.persist === true;
    const updates: Array<{ id: number; expectedPath: string | null; needsRename: number }> = [];
    const relativePathUpdates: Array<{ id: number; relativePath: string; libraryRoot: string }> = [];

    // Lidarr-style: conflict detection for a preview page is in-memory over the
    // candidate set first, then one indexed DB probe — not N prepares + FS stats.
    const expectedOccupants = new Map<string, number>();
    for (const row of rows) {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      expectedOccupants.set(normalizeResolvedPath(resolvedFilePath), row.id);
    }

    // One read cache for the whole row batch so the shared artist row + album
    // metadata are resolved once, not once per row (Lidarr "load once, reuse"),
    // including selected-release hybrid track remaps. Collision paths are
    // collected during this first pass and looked up as bounded indexed batches.
    const pathCache = createExpectedPathCache({ deferTrackCollisionLookup: true });
    preloadExpectedPathIdentities(rows, pathCache);
    const preliminary = rows.map((row) => {
      const resolvedFilePath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
        relativePath: row.relative_path,
      });
      // Preview is DB/path computation only (Lidarr). Disk existence is checked on Apply.
      const { expectedPath, reason } = LibraryFilesService.computeExpectedPath(row, pathCache);
      return { row, resolvedFilePath, expectedPath, reason };
    });

    preloadExpectedTrackPathOccupants(pathCache);
    const evaluated = preliminary.map((item) => {
      if (
        item.row.file_type !== "track"
        || !hasExpectedTrackPathConflict(pathCache, item.expectedPath, item.row.id)
      ) {
        return item;
      }
      const recomputed = LibraryFilesService.computeExpectedPath(item.row, pathCache);
      return { ...item, expectedPath: recomputed.expectedPath, reason: recomputed.reason };
    });

    // Load current/expected destination owners once per table. The previous
    // implementation ran two SELECTs for every preview row.
    const expectedPathsByTable = new Map<RenameTableName, Map<string, string>>();
    for (const { row, resolvedFilePath, expectedPath } of evaluated) {
      if (!expectedPath || normalizeResolvedPath(expectedPath) === normalizeResolvedPath(resolvedFilePath)) {
        continue;
      }
      const tableName = decodeSyntheticId(row.id).tableName;
      const paths = expectedPathsByTable.get(tableName) ?? new Map<string, string>();
      paths.set(normalizeResolvedPath(expectedPath), expectedPath);
      expectedPathsByTable.set(tableName, paths);
    }

    const conflictOwnersByTable = new Map<RenameTableName, Map<string, Set<number>>>();
    for (const [tableName, pathMap] of expectedPathsByTable) {
      const ownerMap = new Map<string, Set<number>>();
      const paths = Array.from(pathMap.values());
      const idCol = tableIdColumn(tableName);
      for (let i = 0; i < paths.length; i += 400) {
        const chunk = paths.slice(i, i + 400);
        const marks = chunk.map(() => "?").join(",");
        const owners = db.prepare(`
          SELECT ${idCol} AS id, file_path, expected_path
          FROM ${tableName}
          WHERE file_path IN (${marks})
             OR expected_path IN (${marks})
        `).all(...chunk, ...chunk) as Array<{
          id: number;
          file_path?: string | null;
          expected_path?: string | null;
        }>;
        for (const owner of owners) {
          for (const candidatePath of [owner.file_path, owner.expected_path]) {
            if (!candidatePath) continue;
            const key = normalizeResolvedPath(candidatePath);
            if (!pathMap.has(key)) continue;
            const ids = ownerMap.get(key) ?? new Set<number>();
            ids.add(Number(owner.id));
            ownerMap.set(key, ids);
          }
        }
      }
      conflictOwnersByTable.set(tableName, ownerMap);
    }

    const results: RenamePreviewItem[] = evaluated.map(({ row, resolvedFilePath, expectedPath, reason }) => {
      const missing = false;
      const needsRename = Boolean(expectedPath && normalizeResolvedPath(expectedPath) !== normalizeResolvedPath(resolvedFilePath));

      let conflict = false;
      let dropDuplicate = false;
      let conflictMessage: string | undefined;
      if (expectedPath && needsRename) {
        const decoded = decodeSyntheticId(row.id);
        const tableName = decoded.tableName;
        const normalizedExpected = normalizeResolvedPath(expectedPath);
        const pageOccupantId = expectedOccupants.get(normalizedExpected);
        const pageConflict = pageOccupantId != null && pageOccupantId !== row.id;
        const dbConflict = Array.from(
          conflictOwnersByTable.get(tableName)?.get(normalizedExpected) ?? [],
        ).some((ownerId) => ownerId !== decoded.id);

        const hasCollision = pageConflict || dbConflict;
        if (hasCollision) {
          if (row.file_type === "lyrics" && tableName === "LyricFiles") {
            // Same audio stem claimed by two lyric rows — Apply keeps the
            // destination and deletes this source (not a hard Conflict).
            dropDuplicate = true;
            conflictMessage = `Duplicate lyric for the same track stem. Apply keeps ${expectedPath} and removes this file.`;
          } else {
            conflict = true;
            conflictMessage = `Another library file already uses or targets ${expectedPath} (often a disc/track renumber collision). Apply skips this row until the destination is free.`;
          }
        }
      }

      if (persist) {
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
        needs_rename: needsRename && !dropDuplicate,
        conflict,
        drop_duplicate: dropDuplicate || undefined,
        missing,
        reason,
        conflict_message: conflictMessage,
      };
    });

    if (persist) {
      db.transaction(() => {
        for (const row of updates) {
          const decoded = decodeSyntheticId(row.id);
          const idCol = tableIdColumn(decoded.tableName);

          db.prepare(`
            UPDATE ${decoded.tableName}
            SET expected_path = ?,
                needs_rename = ?
            WHERE ${idCol} = ?
          `).run(row.expectedPath, row.needsRename, decoded.id);
        }

        for (const row of relativePathUpdates) {
          const decoded = decodeSyntheticId(row.id);
          const idCol = tableIdColumn(decoded.tableName);

          db.prepare(`
            UPDATE ${decoded.tableName}
            SET relative_path = ?,
                library_root = ?
            WHERE ${idCol} = ?
          `).run(row.relativePath, row.libraryRoot, decoded.id);
        }
      })();
    }

    return results;
  }

  static getRenamePreviews(options: RenameScopeOptions): RenamePreviewItem[] {
    // Preview lists media files only; their extras co-move silently on apply.
    return this.evaluateRenameRows(this.getRenameRows(options, true, true), { persist: false });
  }

  static getRenameStatus(options: RenameScopeOptions = {}, sampleLimit = 10): RenameStatusSummary {
    const total = this.getRenameCandidateCount(options, true);
    const scanLimit = Math.max(1, Math.min(1000, options.limit ?? 25));
    const results = this.evaluateRenameRows(this.getRenameRows({ ...options, limit: scanLimit, offset: 0 }, true, true), { persist: false });
    return buildRenameStatusSummary(total, results, sampleLimit);
  }

  /**
   * Lidarr's ExtraService.MoveFilesAfterRename: track-scoped extras (lyrics, per-track
   * metadata/images) follow their audio file. Given the media TrackFiles ids being
   * renamed, add the synthetic ids of every extra linked via track_file_id so an
   * id-based apply co-moves them — the media-only preview never listed them, so without
   * this they would be orphaned with stale names. Folder-scoped sidecars (cover.jpg /
   * folder.jpg / artist.nfo — null track_file_id) are handled by the by-query sidecar
   * reconciliation instead. Idempotent: extras already in `ids` are de-duplicated.
   */
  private static expandWithLinkedExtras(ids: number[]): number[] {
    const trackFileIds = ids
      .map((id) => decodeSyntheticId(id))
      .filter((decoded) => decoded.tableName === "TrackFiles")
      .map((decoded) => decoded.id);
    if (trackFileIds.length === 0) {
      return ids;
    }

    const placeholders = trackFileIds.map(() => "?").join(",");
    const expanded = new Set<number>(ids);
    const extraTables: Array<Exclude<RenameTableName, "TrackFiles">> = ["MetadataFiles", "ExtraFiles", "LyricFiles"];
    for (const table of extraTables) {
      const linked = db.prepare(
        `SELECT id FROM ${table} WHERE track_file_id IN (${placeholders})`,
      ).all(...trackFileIds) as Array<{ id: number }>;
      for (const row of linked) {
        expanded.add(encodeSyntheticId(row.id, table));
      }
    }
    return [...expanded];
  }

  static executeRenameFilesByQuery(options: RenameScopeOptions = {}): RenameApplyResult {
    const ids = this.evaluateRenameRows(this.getRenameRows(options, false), { persist: false })
      .filter((item) => item.needs_rename || item.drop_duplicate)
      .map((item) => item.id);

    return this.executeRenameFiles(ids, { reconcileSeparatedSidecars: true });
  }

  static executeRenameFiles(
    ids: number[],
    options: { reconcileSeparatedSidecars?: boolean } = {},
  ): RenameApplyResult {
    const result: RenameApplyResult = { renamed: 0, skipped: 0, conflicts: 0, missing: 0, cleanedDirectories: 0, errors: [] };
    if (!ids || ids.length === 0) {
      return result;
    }

    // Co-move track-linked extras so a media-only selection never orphans lyrics/nfo.
    const effectiveIds = this.expandWithLinkedExtras(ids);

    const rows: RenameLibraryFileRow[] = [];
    for (const syntheticId of effectiveIds) {
      const decoded = decodeSyntheticId(syntheticId);
      if (decoded.tableName === "TrackFiles") {
        const row = db.prepare(`
          SELECT id, artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id, provider_id AS media_id,
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
          SELECT id AS id, artist_id AS artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
                 CASE WHEN provider_entity_type = 'video' THEN COALESCE(provider_id, canonical_recording_mbid) ELSE COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) END AS media_id,
                 canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
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
          SELECT id AS id, artist_id AS artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id, COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
                 canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid, canonical_track_mbid, canonical_recording_mbid,
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
          SELECT id AS id, artist_id AS artist_id, COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id, COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
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
    const pathCache = createExpectedPathCache({ deferTrackCollisionLookup: true });
    preloadExpectedPathIdentities(rows, pathCache);
    preloadExpectedTrackPathOccupants(pathCache);

    const dbUpdates: Array<{ sql: string; args: unknown[] }> = [];
    const historyEvents: Array<Parameters<typeof recordHistoryEvent>[0]> = [];
    const fileEvents: RenameFileEvent[] = [];
    const physicalMoves: RenamePhysicalMove[] = [];
    const stagedDeletions: StagedRenameDeletion[] = [];

    for (const id of effectiveIds) {
      let pendingMove: RenamePhysicalMove | null = null;
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

        const { expectedPath } = LibraryFilesService.computeExpectedPath(row, pathCache);
        if (!expectedPath) {
          result.skipped++;
          continue;
        }

        const samePath = normalizeResolvedPath(expectedPath) === normalizeResolvedPath(resolvedFilePath);
        const decoded = decodeSyntheticId(id);
        const tableName = decoded.tableName;
        const idCol = tableIdColumn(tableName);

        if (samePath) {
          dbUpdates.push({
            sql: `UPDATE ${tableName} SET expected_path = ?, needs_rename = 0, ${tableTouchedAtColumn(tableName)} WHERE ${idCol} = ?`,
            args: [expectedPath, decoded.id],
          });
          result.skipped++;
          continue;
        }

        const dbConflict = db.prepare(`
          SELECT ${idCol} AS id
          FROM ${tableName}
          WHERE ${idCol} != ?
            AND (file_path = ? OR expected_path = ?)
          LIMIT 1
        `).get(decoded.id, expectedPath, expectedPath) as { id: number } | undefined;

        const fsConflict = fs.existsSync(expectedPath);
        if (dbConflict || fsConflict) {
          // Merged-root sidecar dedup: when library roots are combined,
          // artist/album-scoped sidecars (artist.nfo, folder.jpg, cover.jpg)
          // from the previously separate roots map to one target path. The
          // destination already holds the same logical artifact, so drop the
          // source duplicate instead of reporting an unresolvable conflict.
          let duplicateOfSameScope = false;
          if (isScopedSidecar(row)) {
            if (dbConflict) {
              const occupant = db.prepare(`
                SELECT artist_id,
                       COALESCE(canonical_release_group_mbid, canonical_release_mbid) AS album_id,
                       COALESCE(canonical_track_mbid, canonical_recording_mbid, provider_id) AS media_id,
                       file_type
                FROM ${tableName}
                WHERE ${idCol} = ?
              `).get(dbConflict.id) as {
                artist_id?: string | number | null;
                album_id?: string | number | null;
                media_id?: string | number | null;
                file_type?: string | null;
              } | undefined;
              duplicateOfSameScope = isSameScopeSidecarOccupant(row, occupant);
            } else {
              // Target exists on disk at this scope's canonical sidecar path.
              duplicateOfSameScope = true;
            }
          } else if (row.file_type === "lyrics" && tableName === "LyricFiles") {
            // Lidarr-style lyric move: when two .lrc rows claim the same audio
            // stem, keep the destination occupant and drop the duplicate source
            // instead of a permanent Rename Conflict.
            duplicateOfSameScope = true;
          }

          if (duplicateOfSameScope) {
            try {
              const stagedPath = stageRenameDeletion(resolvedFilePath, id);
              stagedDeletions.push({
                originalPath: resolvedFilePath,
                stagedPath,
                sourceRoot: resolveLibraryRootPath(row.library_root, resolvedFilePath),
                id,
              });
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
                reason: row.file_type === "lyrics"
                  ? "lyric-sidecar-duplicate"
                  : "merged-root-sidecar-duplicate",
              },
            });
            result.renamed++;
            continue;
          }

          dbUpdates.push({
            sql: `UPDATE ${tableName} SET expected_path = ?, needs_rename = 1 WHERE ${idCol} = ?`,
            args: [expectedPath, decoded.id],
          });
          result.conflicts++;
          continue;
        }

        moveFileCrossDevice(resolvedFilePath, expectedPath);
        pendingMove = {
          sourcePath: resolvedFilePath,
          destinationPath: expectedPath,
          sourceRoot: resolveLibraryRootPath(row.library_root, resolvedFilePath),
        };

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

        physicalMoves.push(pendingMove);
        pendingMove = null;
        result.renamed++;
      } catch (error) {
        const rollbackErrors = pendingMove ? rollbackPhysicalMoves([pendingMove]) : [];
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({
          id,
          error: rollbackErrors.length === 0
            ? message
            : `${message}; filesystem rollback failed: ${rollbackErrors.join("; ")}`,
        });
      }
    }

    if (dbUpdates.length > 0 || historyEvents.length > 0) {
      try {
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
      } catch (error) {
        const rollbackErrors = [
          ...rollbackPhysicalMoves(physicalMoves),
          ...rollbackStagedDeletions(stagedDeletions),
        ];
        if (rollbackErrors.length > 0) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; `
            + `filesystem rollback failed: ${rollbackErrors.join("; ")}`,
            { cause: error },
          );
        }
        throw error;
      }
    }

    for (const deletion of stagedDeletions) {
      try {
        fs.rmSync(deletion.stagedPath, { force: true });
        if (deletion.sourceRoot) {
          removeEmptyParents(path.dirname(deletion.originalPath), deletion.sourceRoot);
        }
      } catch (error) {
        result.errors.push({
          id: deletion.id,
          error: `Database committed but duplicate cleanup failed for ${deletion.stagedPath}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    for (const move of physicalMoves) {
      if (move.sourceRoot) {
        removeEmptyParents(path.dirname(move.sourcePath), move.sourceRoot);
      }
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

    // Query/artist-wide renames may change every canonical media path and need
    // a complete separated-root sidecar reconciliation. An explicit id-only
    // rename already relocates its file and cleans its source parents above;
    // running these library-wide passes made one-file jobs take minutes.
    if (result.renamed > 0 && options.reconcileSeparatedSidecars === true) {
      const artistIds = Array.from(new Set(rows.map((row) => String(row.artist_id || "")).filter(Boolean)));
      this.replicateSeparatedSidecars(artistIds, pathCache);
      result.cleanedDirectories = this.cleanEmptyDirectories();
    }

    return result;
  }

  static executeRenameArtist(options: { artistId: string }): RenameApplyResult {
    return this.executeRenameFilesByQuery({ artistId: options.artistId });
  }

  /**
   * After stereo audio lands on disk, move associated music videos from the
   * separated video library into the inline stereo album folder when
   * `video_folder_layout` is `inline` or `inline_only`. Reuses computeExpectedPath + executeRenameFiles
   * (same gate as Rename: provider_video_for + monitored stereo RG).
   *
   * Scoped to videos linked to the imported audio recordings only — not a
   * library-wide rename. No-op when layout is separated or no links exist.
   */
  static relocateRelatedInlineVideosForImportedAudio(importedFileIds: number[]): RenameApplyResult {
    const empty: RenameApplyResult = {
      renamed: 0,
      skipped: 0,
      conflicts: 0,
      missing: 0,
      cleanedDirectories: 0,
      errors: [],
    };
    if (!importedFileIds?.length) {
      return empty;
    }
    if (!allowsInlineVideoPlacement(Config.getPathConfig().video_folder_layout)) {
      return empty;
    }

    const placeholders = importedFileIds.map(() => "?").join(", ");
    const audioRows = db.prepare(`
      SELECT id, recording_id, canonical_recording_mbid, provider, provider_id
      FROM TrackFiles
      WHERE id IN (${placeholders})
        AND file_type = 'track'
        AND library_slot = 'stereo'
    `).all(...importedFileIds) as Array<{
      id: number;
      recording_id?: number | null;
      canonical_recording_mbid?: string | null;
      provider?: string | null;
      provider_id?: string | null;
    }>;

    const audioRecordingIds = new Set<number>();
    for (const row of audioRows) {
      if (row.recording_id != null) {
        audioRecordingIds.add(Number(row.recording_id));
        continue;
      }
      const recordingMbid = String(row.canonical_recording_mbid || "").trim();
      if (recordingMbid) {
        const byMbid = db.prepare(`
          SELECT id FROM Recordings WHERE mbid = ? AND is_video = 0 LIMIT 1
        `).get(recordingMbid) as { id?: number } | undefined;
        if (byMbid?.id != null) {
          audioRecordingIds.add(Number(byMbid.id));
          continue;
        }
      }
      const providerId = String(row.provider_id || "").trim();
      if (!providerId) continue;
      const provider = String(row.provider || "").trim();
      if (!provider) continue;
      const byOffer = db.prepare(`
        SELECT CASE
          WHEN COUNT(DISTINCT track_match.recording_id) = 1
          THEN MAX(track_match.recording_id)
        END AS recording_id
        FROM ProviderItems provider_track
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_track_item_id = provider_track.id
         AND track_match.match_state = 'accepted'
        WHERE provider_track.provider = ?
          AND provider_track.entity_type = 'track'
          AND CAST(provider_track.provider_id AS TEXT) = CAST(? AS TEXT)
      `).get(provider, providerId) as { recording_id?: number | null } | undefined;
      if (byOffer?.recording_id != null) {
        audioRecordingIds.add(Number(byOffer.recording_id));
      }
    }

    if (audioRecordingIds.size === 0) {
      return empty;
    }

    const recordingIds = [...audioRecordingIds];
    const recordingPlaceholders = recordingIds.map(() => "?").join(", ");
    const relatedVideoFileIds = (db.prepare(`
      SELECT DISTINCT tf.id AS id
      FROM RecordingRelations rr
      JOIN ProviderVideoMatches video_match
        ON video_match.recording_id = rr.source_recording_id
       AND video_match.match_state = 'accepted'
      JOIN ProviderItems pi
        ON pi.id = video_match.provider_video_item_id
       AND pi.entity_type = 'video'
      JOIN TrackFiles tf
        ON tf.file_type IN ('video', 'video_thumbnail', 'nfo')
       AND (
         tf.recording_id = rr.source_recording_id
         OR (
           tf.provider = pi.provider
           AND tf.provider_entity_type = 'video'
           AND CAST(tf.provider_id AS TEXT) = CAST(pi.provider_id AS TEXT)
         )
       )
      WHERE rr.target_recording_id IN (${recordingPlaceholders})
        AND rr.relation_type IN ('provider_video_for', 'music_video_for')
    `).all(...recordingIds) as Array<{ id: number }>).map((row) => Number(row.id));

    if (relatedVideoFileIds.length === 0) {
      return empty;
    }

    return this.executeRenameFiles(relatedVideoFileIds);
  }

  private static replicateSeparatedSidecars(
    artistIds: string[] = [],
    pathCache?: ExpectedPathCache,
  ) {
    const musicRoot = Config.getMusicPath();
    const spatialRoot = Config.getSpatialPath();
    const videoRoot = Config.getVideoPath();
    if (normalizeResolvedPath(musicRoot) === normalizeResolvedPath(spatialRoot) &&
        normalizeResolvedPath(musicRoot) === normalizeResolvedPath(videoRoot)) {
      return;
    }

    const artistFilter = artistIds.length > 0
      ? `AND tf.artist_id IN (${artistIds.map(() => "?").join(",")})`
      : "";
    const tracks = db.prepare(`
      SELECT tf.id, tf.artist_id,
             ${providerUnambiguousAlbumIdSql("provider_track")} AS album_id,
             tf.provider_id AS media_id, tf.library_slot, tf.quality, tf.file_type,
             tf.canonical_artist_mbid, tf.canonical_release_group_mbid, tf.canonical_release_mbid,
             tf.canonical_track_mbid, tf.canonical_recording_mbid,
             tf.provider, tf.provider_entity_type, tf.provider_id
      FROM TrackFiles tf
      LEFT JOIN ProviderItems provider_track
        ON provider_track.entity_type = tf.provider_entity_type
       AND (tf.provider IS NULL OR provider_track.provider = tf.provider)
       AND CAST(provider_track.provider_id AS TEXT) = CAST(tf.provider_id AS TEXT)
      WHERE tf.file_type IN ('track', 'video')
        AND (tf.library_slot IN ('stereo', 'spatial') OR tf.file_type = 'video')
        ${artistFilter}
    `).all(...artistIds) as Array<{
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
      }, pathCache).expectedPath;
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
        WHERE artist_id = ?
          AND canonical_release_group_mbid IS NULL
          AND canonical_release_mbid IS NULL
          AND canonical_track_mbid IS NULL
          AND canonical_recording_mbid IS NULL
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
          ON album_item.entity_type = 'release'
         AND (mf.provider IS NULL OR album_item.provider = mf.provider)
         AND CAST(album_item.provider_id AS TEXT) = CAST(mf.provider_id AS TEXT)
        LEFT JOIN ProviderEditionMatches album_match
          ON album_match.provider_edition_item_id = album_item.id
         AND album_match.match_state = 'accepted'
        LEFT JOIN AlbumEditions album_release ON album_release.id = album_match.edition_id
        LEFT JOIN Albums album_group ON album_group.id = album_release.release_group_id
        WHERE mf.artist_id = ?
          AND (mf.canonical_release_group_mbid IS NOT NULL OR mf.canonical_release_mbid IS NOT NULL OR mf.provider_id IS NOT NULL)
          AND mf.canonical_track_mbid IS NULL
          AND mf.canonical_recording_mbid IS NULL
          AND mf.file_type IN ('cover', 'nfo')
          AND (
            (? IS NOT NULL AND (mf.canonical_release_group_mbid = ? OR album_group.mbid = ?))
            OR (? IS NOT NULL AND (mf.canonical_release_mbid = ? OR album_release.mbid = ?))
            OR (? IS NULL AND ? IS NULL AND ? IS NOT NULL AND CAST(mf.provider_id AS TEXT) = CAST(? AS TEXT))
          )
      `).all(
        track.artist_id,
        track.canonical_release_group_mbid,
        track.canonical_release_group_mbid,
        track.canonical_release_group_mbid,
        track.canonical_release_mbid,
        track.canonical_release_mbid,
        track.canonical_release_mbid,
        track.canonical_release_group_mbid,
        track.canonical_release_mbid,
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
         AND CAST(lyric_item.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
        LEFT JOIN ProviderEditionMembers lyric_member
          ON lyric_member.member_item_id = lyric_item.id
        LEFT JOIN ProviderTrackMatches lyric_match
          ON lyric_match.provider_edition_member_id = lyric_member.id
         AND lyric_match.match_state = 'accepted'
        LEFT JOIN Recordings lyric_recording ON lyric_recording.id = lyric_match.recording_id
        LEFT JOIN Tracks lyric_track ON lyric_track.id = lyric_match.track_id
        WHERE lf.artist_id = ?
          AND (
            (? IS NOT NULL AND lf.canonical_recording_mbid = ?)
            OR (? IS NOT NULL AND lf.canonical_track_mbid = ?)
            OR (? IS NOT NULL AND lyric_recording.mbid = ?)
            OR (? IS NOT NULL AND lyric_track.mbid = ?)
            OR (? IS NULL AND ? IS NULL AND ? IS NOT NULL AND CAST(lf.provider_id AS TEXT) = CAST(? AS TEXT))
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
