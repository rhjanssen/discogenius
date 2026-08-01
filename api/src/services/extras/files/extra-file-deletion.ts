import fs from "fs";
import path from "path";
import { db } from "../../../database.js";
import {
  scopeIncludesFile,
  type DeletionScope,
} from "../../mediafiles/library-deletion-scope.js";
import { resolveStoredLibraryPath } from "../../mediafiles/library-paths.js";
import {
  comparablePathColumnSql,
  normalizeComparablePath,
} from "../../mediafiles/path-utils.js";
import { ExtraFileService, type ExtraFileTableName } from "./extra-file-service.js";

const EXTRA_TABLES: ExtraFileTableName[] = ["MetadataFiles", "LyricFiles", "ExtraFiles"];

export type ExtraDeletionResult = {
  /** Library associations released from a shared extra. */
  released: number;
  /** Physical extras removed because the last association was released. */
  deleted: number;
  /** Physical extras kept because another Library or playable file still needs them. */
  retained: number;
  missing: number;
  errors: number;
};

type ExtraRow = {
  id: number;
  file_path: string;
  library_root: string;
  track_file_id: number | null;
};

export function emptyExtraDeletionResult(): ExtraDeletionResult {
  return { released: 0, deleted: 0, retained: 0, missing: 0, errors: 0 };
}

export function mergeExtraDeletionResults(
  into: ExtraDeletionResult,
  from: ExtraDeletionResult,
): ExtraDeletionResult {
  into.released += from.released;
  into.deleted += from.deleted;
  into.retained += from.retained;
  into.missing += from.missing;
  into.errors += from.errors;
  return into;
}

function likePrefixPattern(directory: string): string {
  return `${directory.replace(/([\\%_])/g, "\\$1")}%`;
}

function storedDirectory(filePath: string): string {
  return normalizeComparablePath(path.dirname(filePath));
}

/** Playable-file rows still recorded in the same stored directory. */
function remainingSiblingTrackFiles(
  directory: string,
  excludeTrackFileIds: number[],
): Array<{ id: number; library_id: number | null; file_path: string }> {
  const rows = db.prepare(`
    SELECT id, library_id, file_path
    FROM TrackFiles
    WHERE ${comparablePathColumnSql("file_path")} LIKE ? ESCAPE '\\'
  `).all(likePrefixPattern(`${directory}/`)) as Array<{
    id: number;
    library_id: number | null;
    file_path: string;
  }>;

  const excluded = new Set(excludeTrackFileIds);
  return rows.filter((row) =>
    !excluded.has(row.id) && storedDirectory(row.file_path) === directory
  );
}

function selectLinkedExtras(table: ExtraFileTableName, trackFileIds: number[]): ExtraRow[] {
  if (trackFileIds.length === 0) return [];
  const placeholders = trackFileIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, file_path, library_root, track_file_id
    FROM ${table}
    WHERE track_file_id IN (${placeholders})
  `).all(...trackFileIds) as ExtraRow[];
}

function selectFolderExtras(table: ExtraFileTableName, directory: string): ExtraRow[] {
  const rows = db.prepare(`
    SELECT id, file_path, library_root, track_file_id
    FROM ${table}
    WHERE track_file_id IS NULL
      AND ${comparablePathColumnSql("file_path")} LIKE ? ESCAPE '\\'
  `).all(likePrefixPattern(`${directory}/`)) as ExtraRow[];
  return rows.filter((row) => storedDirectory(row.file_path) === directory);
}

/**
 * Release one extra from the deletion scope and remove the physical file only
 * once nothing else references it.
 *
 * `mayRemovePhysicalFile` lets a caller keep a folder-level extra on disk while
 * another Library still has playable files in that folder, even though its own
 * association list is already empty (legacy rows were written before the
 * normalized association tables existed).
 */
function releaseExtra(
  table: ExtraFileTableName,
  row: ExtraRow,
  scope: DeletionScope,
  mayRemovePhysicalFile: boolean,
  result: ExtraDeletionResult,
): void {
  const associations = ExtraFileService.libraryIds(table, row.id);
  let remaining: number[];

  if (scope.kind === "all-libraries") {
    for (const libraryId of associations) {
      ExtraFileService.releaseLibrary(table, row.id, libraryId);
    }
    result.released += associations.length;
    remaining = [];
  } else {
    if (!associations.includes(scope.libraryId)) {
      // Another Library owns this extra; the scoped deletion must not touch it.
      if (associations.length > 0) {
        result.retained += 1;
        return;
      }
      remaining = [];
    } else {
      remaining = ExtraFileService.releaseLibrary(table, row.id, scope.libraryId)
        .remainingLibraryIds;
      result.released += 1;
    }
  }

  if (remaining.length > 0) {
    result.retained += 1;
    return;
  }
  if (!mayRemovePhysicalFile) {
    result.retained += 1;
    return;
  }

  const resolvedPath = resolveStoredLibraryPath({
    filePath: row.file_path,
    libraryRoot: row.library_root,
  });

  if (fs.existsSync(resolvedPath)) {
    try {
      fs.rmSync(resolvedPath, { force: true });
      result.deleted += 1;
    } catch (error) {
      console.warn(`[LibraryDelete] Failed to delete extra ${resolvedPath}:`, error);
      result.errors += 1;
      // The physical file survives, so the row must survive with it.
      return;
    }
  } else {
    result.missing += 1;
  }

  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
}

/**
 * Release the shared extras that belonged to playable files just deleted from
 * `scope`.
 *
 * Directly linked extras (`track_file_id`) follow their playable file. Folder
 * level extras such as `cover.jpg` are released only once the scope has no
 * remaining playable file in that folder, and are physically removed only once
 * no playable file from any Library remains there.
 */
export type LinkedExtraSnapshot = Array<{ table: ExtraFileTableName; row: ExtraRow }>;

/**
 * Capture the extras linked to playable files *before* those files are deleted.
 *
 * `MetadataFiles.track_file_id`, `LyricFiles.track_file_id` and
 * `ExtraFiles.track_file_id` are all `ON DELETE SET NULL`. Reading them after
 * the TrackFiles row is gone returns nothing — the link has already been
 * erased — so a track's own lyrics and metadata silently outlived it, and worse,
 * they then looked like unowned folder-level extras to the folder sweep.
 */
export function captureLinkedExtras(trackFileIds: readonly number[]): LinkedExtraSnapshot {
  if (trackFileIds.length === 0) return [];
  const snapshot: LinkedExtraSnapshot = [];
  for (const table of EXTRA_TABLES) {
    for (const row of selectLinkedExtras(table, [...trackFileIds])) {
      snapshot.push({ table, row });
    }
  }
  return snapshot;
}

export function releaseExtrasForDeletedTrackFiles(input: {
  scope: DeletionScope;
  deletedTrackFileIds: number[];
  storedFilePaths: string[];
  /** Linked extras captured before the playable rows were deleted. */
  linkedExtras?: LinkedExtraSnapshot;
}): ExtraDeletionResult {
  const result = emptyExtraDeletionResult();
  const { scope, deletedTrackFileIds } = input;

  const deletedIds = new Set(deletedTrackFileIds);
  for (const { table, row } of input.linkedExtras ?? []) {
    // Only extras whose owner actually went away; a file whose deletion failed
    // keeps its sidecars.
    if (row.track_file_id == null || !deletedIds.has(row.track_file_id)) continue;
    releaseExtra(table, row, scope, true, result);
  }

  const directories = new Set(input.storedFilePaths.map(storedDirectory));
  for (const directory of directories) {
    if (!directory) continue;
    const siblings = remainingSiblingTrackFiles(directory, deletedTrackFileIds);
    const scopeStillHasContent = siblings.some((sibling) =>
      scopeIncludesFile(scope, sibling)
    );
    if (scopeStillHasContent) continue;

    const mayRemovePhysicalFile = siblings.length === 0;
    for (const table of EXTRA_TABLES) {
      for (const row of selectFolderExtras(table, directory)) {
        releaseExtra(table, row, scope, mayRemovePhysicalFile, result);
      }
    }
  }

  return result;
}
