/**
 * Pure helpers extracted from RenameTrackFileService (incremental split).
 * ID/filter/status builders — no DB, FS side effects, or service state.
 */

import {
  getCurrentLibraryRootPath,
  resolveLibraryRootKey,
} from "./library-paths.js";
import {
  resolveArtistMetadataId,
  resolveArtistMbid,
} from "../music/managed-artists.js";
import type {
  RenamePreviewItem,
  RenameScopeOptions,
  RenameStatusSummary,
} from "./library-files.js";

export type RenameTableName = "TrackFiles" | "MetadataFiles" | "ExtraFiles" | "LyricFiles";

export type RenameLibraryFileRow = {
  id: number;
  artist_metadata_id: number;
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

// Sidecar tables share one id space with TrackFiles in the rename plan by adding
// a per-table offset, so a single id list can address rows across all four tables.
export const SYNTHETIC_ID_OFFSET: Record<Exclude<RenameTableName, "TrackFiles">, number> = {
  MetadataFiles: 10000000,
  ExtraFiles: 20000000,
  LyricFiles: 30000000,
};

export function decodeSyntheticId(syntheticId: number): DecodedSyntheticId {
  if (syntheticId >= SYNTHETIC_ID_OFFSET.LyricFiles) {
    return { id: syntheticId - SYNTHETIC_ID_OFFSET.LyricFiles, tableName: "LyricFiles" };
  }
  if (syntheticId >= SYNTHETIC_ID_OFFSET.ExtraFiles) {
    return { id: syntheticId - SYNTHETIC_ID_OFFSET.ExtraFiles, tableName: "ExtraFiles" };
  }
  if (syntheticId >= SYNTHETIC_ID_OFFSET.MetadataFiles) {
    return { id: syntheticId - SYNTHETIC_ID_OFFSET.MetadataFiles, tableName: "MetadataFiles" };
  }
  return { id: syntheticId, tableName: "TrackFiles" };
}

export function encodeSyntheticId(id: number, tableName: RenameTableName): number {
  return tableName === "TrackFiles" ? id : id + SYNTHETIC_ID_OFFSET[tableName];
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
    // getRenameRows aliases sidecar artist_id as artist_metadata_id; match both
    // integer metadata ids and TEXT mbids stored on sidecars.
    const key = String(options.artistId);
    const metaId = resolveArtistMetadataId(key);
    const mbid = resolveArtistMbid(key);
    const keys = Array.from(new Set(
      [key, metaId != null ? String(metaId) : null, mbid].filter(Boolean) as string[],
    ));
    where.push(`CAST(lf.artist_metadata_id AS TEXT) IN (${keys.map(() => "?").join(",")})`);
    params.push(...keys);
  }
  const editionTarget = options.releaseMbid
    ? String(options.releaseMbid).trim()
    : (options.editionId != null ? String(options.editionId).trim() : null);

  if (editionTarget) {
    where.push(`(
        lf.canonical_release_mbid = ?
        OR (
          lf.file_type = 'track' AND (
            CAST(lf.album_edition_id AS TEXT) = ?
            OR lf.album_edition_id IN (
              SELECT ed.id FROM AlbumEditions ed WHERE CAST(ed.id AS TEXT) = ? OR ed.mbid = ?
            )
          )
        )
      )`);
    params.push(editionTarget, editionTarget, editionTarget, editionTarget);
  } else if (options.albumId) {
    const albumTarget = String(options.albumId).trim();
    where.push(`(
        lf.canonical_release_group_mbid = ?
        OR lf.canonical_release_mbid = ?
        OR (
          lf.file_type = 'track' AND (
            CAST(lf.release_group_id AS TEXT) = ?
            OR lf.album_edition_id IN (
              SELECT ed.id FROM AlbumEditions ed
              JOIN Albums alb ON alb.id = ed.release_group_id
              WHERE CAST(alb.id AS TEXT) = ? OR alb.mbid = ? OR ed.mbid = ?
            )
          )
        )
      )`);
    params.push(albumTarget, albumTarget, albumTarget, albumTarget, albumTarget);
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
    artist_metadata_id?: string | number | null;
    album_id?: string | number | null;
    file_type?: string | null;
  },
  occupant: {
    artist_metadata_id?: string | number | null;
    album_id?: string | number | null;
    media_id?: string | number | null;
    file_type?: string | null;
  } | null | undefined,
): boolean {
  return Boolean(
    occupant
    && occupant.media_id == null
    && occupant.file_type === row.file_type
    && String(occupant.artist_metadata_id ?? "") === String(row.artist_metadata_id ?? "")
    && String(occupant.album_id ?? "") === String(row.album_id ?? ""),
  );
}

export function buildRenameStatusSummary(
  total: number,
  results: RenamePreviewItem[],
  sampleLimit = 10,
): RenameStatusSummary {
  const actionable = results.filter((item) => item.needs_rename || item.conflict || item.missing || item.drop_duplicate);

  return {
    total,
    scanned: results.length,
    limited: total > results.length,
    renameNeeded: results.filter((item) => item.needs_rename || item.drop_duplicate).length,
    conflicts: results.filter((item) => item.conflict).length,
    missing: results.filter((item) => item.missing).length,
    sample: actionable.slice(0, Math.max(0, sampleLimit)),
  };
}
