/**
 * Pure helpers extracted from RenameTrackFileService (Lidarr-style incremental split).
 * ID/filter/status builders — no DB, FS side effects, or service state.
 */

import {
  getCurrentLibraryRootPath,
  resolveLibraryRootKey,
} from "./library-paths.js";
import type {
  RenamePreviewItem,
  RenameScopeOptions,
  RenameStatusSummary,
} from "./library-files.js";

export type RenameTableName = "TrackFiles" | "MetadataFiles" | "ExtraFiles" | "LyricFiles";

export type RenameLibraryFileRow = {
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

export type RenameFileEvent = {
  libraryFileId: number;
  artistId: number;
  albumId: number | null;
  mediaId: number | null;
  fileType: string;
  filePath: string;
  libraryRoot: string;
  previousPath: string;
};

export type DecodedSyntheticId = {
  id: number;
  tableName: RenameTableName;
};

export function decodeSyntheticId(syntheticId: number): DecodedSyntheticId {
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

/** Primary-key column name differs for TrackFiles vs sidecar tables. */
export function tableIdColumn(tableName: RenameTableName): "id" | "Id" {
  return tableName === "TrackFiles" ? "id" : "Id";
}

/** Timestamp column written after a successful rename/verify. */
export function tableTouchedAtColumn(tableName: RenameTableName): string {
  return tableName === "TrackFiles" ? "verified_at = CURRENT_TIMESTAMP" : "last_updated = CURRENT_TIMESTAMP";
}

export function getLibraryRootFilterValues(libraryRoot: string | null | undefined): string[] {
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

export function buildRenameFilters(options: RenameScopeOptions = {}): { where: string[]; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];

  if (options.artistId) {
    where.push("lf.artist_id = ?");
    params.push(options.artistId);
  }
  if (options.albumId) {
    where.push(`(
        lf.canonical_release_group_mbid = ?
        OR lf.canonical_release_mbid = ?
        OR (lf.provider_entity_type, CAST(lf.provider_id AS TEXT)) IN (
          SELECT scope_item.entity_type, CAST(scope_item.provider_id AS TEXT)
          FROM ProviderItems scope_item
          WHERE scope_item.entity_type IN ('track', 'video')
            AND (scope_item.release_group_mbid = ? OR scope_item.release_mbid = ?)
        )
      )`);
    params.push(options.albumId, options.albumId, options.albumId, options.albumId);
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

  return { where, params };
}

export function isScopedSidecar(row: {
  media_id?: string | number | null;
  file_type?: string | null;
}): boolean {
  return row.media_id == null && (row.file_type === "nfo" || row.file_type === "cover");
}

/** True when a conflicting DB row is the same artist/album-scoped sidecar artifact. */
export function isSameScopeSidecarOccupant(
  row: {
    artist_id?: string | number | null;
    album_id?: string | number | null;
    file_type?: string | null;
  },
  occupant: {
    artist_id?: string | number | null;
    album_id?: string | number | null;
    media_id?: string | number | null;
    file_type?: string | null;
  } | null | undefined,
): boolean {
  return Boolean(
    occupant
    && occupant.media_id == null
    && occupant.file_type === row.file_type
    && String(occupant.artist_id ?? "") === String(row.artist_id ?? "")
    && String(occupant.album_id ?? "") === String(row.album_id ?? ""),
  );
}

export function buildRenameStatusSummary(
  total: number,
  results: RenamePreviewItem[],
  sampleLimit = 10,
): RenameStatusSummary {
  const actionable = results.filter((item) => item.needs_rename || item.conflict || item.missing);

  return {
    total,
    scanned: results.length,
    limited: total > results.length,
    renameNeeded: results.filter((item) => item.needs_rename).length,
    conflicts: results.filter((item) => item.conflict).length,
    missing: results.filter((item) => item.missing).length,
    sample: actionable.slice(0, Math.max(0, sampleLimit)),
  };
}
