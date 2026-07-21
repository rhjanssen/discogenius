import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import {
  invalidateArtistDownloadStatus,
  invalidateReleaseGroupDownloadStatus,
} from "../download/download-state.js";
import { AlbumCommandService } from "../music/album-command-service.js";
import {
  LibraryFilesService,
  removeEmptyParents,
} from "./library-files.js";
import {
  resolveLibraryRootPath,
  resolveStoredLibraryPath,
} from "./library-paths.js";

export type DeleteLibraryFilesResult = {
  deleted: number;
  missing: number;
  errors: number;
  unmonitored: boolean;
};

type TrackFileDeleteRow = {
  id: number;
  artist_id: number;
  file_type: string;
  quality: string | null;
  file_path: string;
  library_root: string;
  canonical_release_group_mbid: string | null;
};

function deleteTrackFileRows(rows: TrackFileDeleteRow[]): Omit<DeleteLibraryFilesResult, "unmonitored"> {
  let deleted = 0;
  let missing = 0;
  let errors = 0;

  for (const row of rows) {
    let canRemove = true;
    const resolvedFilePath = resolveStoredLibraryPath({
      filePath: row.file_path,
      libraryRoot: row.library_root,
    });
    const exists = fs.existsSync(resolvedFilePath);
    if (exists) {
      try {
        fs.rmSync(resolvedFilePath, { force: true });
      } catch (error) {
        console.warn(`[LibraryDelete] Failed to delete ${resolvedFilePath}:`, error);
        canRemove = false;
        errors += 1;
      }
    } else {
      missing += 1;
    }

    if (!canRemove) continue;

    db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(row.id);

    LibraryFilesService.emitFileDeleted({
      libraryFileId: row.id,
      artistId: row.artist_id,
      albumId: null,
      mediaId: null,
      fileType: row.file_type,
      filePath: resolvedFilePath,
      libraryRoot: row.library_root,
      quality: row.quality,
      reason: "manual-delete",
      missing: !exists,
    });

    deleted += exists ? 1 : 0;

    const root = resolveLibraryRootPath(row.library_root, row.file_path);
    if (root) {
      removeEmptyParents(path.dirname(resolvedFilePath), root);
    }
  }

  return { deleted, missing, errors };
}

/**
 * Lidarr-style Manage → Delete files for a release group (optional slot).
 * Removes disk files under configured library roots and TrackFiles rows.
 * Does not delete MusicBrainz/catalog rows.
 */
export function deleteReleaseGroupLibraryFiles(
  releaseGroupMbid: string,
  options: { slot?: "stereo" | "spatial" | null; unmonitor?: boolean } = {},
): DeleteLibraryFilesResult {
  const releaseGroup = db.prepare(`
    SELECT mbid FROM Albums WHERE mbid = ?
  `).get(releaseGroupMbid) as { mbid?: string } | undefined;
  if (!releaseGroup?.mbid) {
    const err = new Error("Album not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const slot = options.slot === "spatial" || options.slot === "stereo" ? options.slot : null;
  const rows = (slot
    ? db.prepare(`
        SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
        FROM TrackFiles
        WHERE canonical_release_group_mbid = ?
          AND library_slot = ?
      `).all(releaseGroupMbid, slot)
    : db.prepare(`
        SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
        FROM TrackFiles
        WHERE canonical_release_group_mbid = ?
      `).all(releaseGroupMbid)) as TrackFileDeleteRow[];

  const result = deleteTrackFileRows(rows);
  invalidateReleaseGroupDownloadStatus(releaseGroupMbid);

  let unmonitored = false;
  if (options.unmonitor) {
    AlbumCommandService.updateAlbum(releaseGroupMbid, false, undefined);
    unmonitored = true;
  }

  return { ...result, unmonitored };
}

/**
 * Lidarr-style Manage → Delete files for an artist across all library roots.
 * Removes disk files + TrackFiles for the artist; keeps catalog/artist rows.
 */
export function deleteArtistLibraryFiles(
  artistId: string,
  options: { unmonitor?: boolean } = {},
): DeleteLibraryFilesResult {
  const artist = db.prepare(`
    SELECT id FROM Artists WHERE id = ?
  `).get(artistId) as { id?: number | string } | undefined;
  if (!artist?.id) {
    const err = new Error("Artist not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const rows = db.prepare(`
    SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
    FROM TrackFiles
    WHERE artist_id = ?
  `).all(artistId) as TrackFileDeleteRow[];

  const releaseGroups = new Set(
    rows
      .map((row) => row.canonical_release_group_mbid)
      .filter((mbid): mbid is string => Boolean(mbid)),
  );

  const result = deleteTrackFileRows(rows);
  for (const releaseGroupMbid of releaseGroups) {
    invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
  }
  invalidateArtistDownloadStatus(String(artistId));

  let unmonitored = false;
  if (options.unmonitor) {
    db.prepare(`
      UPDATE Artists SET monitored = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(artistId);
    unmonitored = true;
  }

  return { ...result, unmonitored };
}
