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
 * Manage → Delete files for a release group (optional slot).
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
 * Manage → Delete files for an artist across all library roots.
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

/**
 * Manage → Delete files for a single track (by track MBID).
 * Removes TrackFiles rows matching the track (and sibling extras keyed to it).
 */
export function deleteTrackLibraryFiles(
  trackMbid: string,
): DeleteLibraryFilesResult {
  const track = db.prepare(`
    SELECT mbid FROM Tracks WHERE mbid = ?
  `).get(trackMbid) as { mbid?: string } | undefined;
  if (!track?.mbid) {
    const err = new Error("Track not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const rows = db.prepare(`
    SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
    FROM TrackFiles
    WHERE canonical_track_mbid = ?
       OR CAST(provider_id AS TEXT) = CAST(? AS TEXT)
  `).all(trackMbid, trackMbid) as TrackFileDeleteRow[];

  const result = deleteTrackFileRows(rows);
  const releaseGroups = new Set(
    rows
      .map((row) => row.canonical_release_group_mbid)
      .filter((mbid): mbid is string => Boolean(mbid)),
  );
  for (const releaseGroupMbid of releaseGroups) {
    invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
  }

  return { ...result, unmonitored: false };
}

/**
 * Manage → Delete files for a canonical music-video recording.
 * Removes video + thumbnail/nfo TrackFiles; keeps the catalog Recording.
 */
export function deleteVideoLibraryFiles(
  videoId: string,
): DeleteLibraryFilesResult {
  const recording = db.prepare(`
    SELECT id, mbid
    FROM Recordings
    WHERE is_video = 1
      AND (
        CAST(id AS TEXT) = CAST(? AS TEXT)
        OR mbid = ?
      )
    LIMIT 1
  `).get(videoId, videoId) as { id?: number; mbid?: string | null } | undefined;

  const recordingId = recording?.id != null ? Number(recording.id) : null;
  const recordingMbid = recording?.mbid ? String(recording.mbid) : null;

  if (recordingId == null) {
    const err = new Error("Video not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const providerItems = db.prepare(`
    SELECT item.provider, CAST(item.provider_id AS TEXT) AS provider_id
    FROM ProviderItems item
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = item.id
     AND video_match.match_state = 'accepted'
    WHERE item.entity_type = 'video'
      AND video_match.recording_id = ?
  `).all(recordingId) as Array<{ provider: string; provider_id: string }>;

  const rows = (providerItems.length > 0
    ? db.prepare(`
        SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
        FROM TrackFiles
        WHERE file_type IN ('video', 'video_thumbnail', 'nfo')
          AND (
            recording_id = ?
            OR (? IS NOT NULL AND canonical_recording_mbid = ?)
            OR (
              provider_entity_type = 'video'
              AND (
                ${providerItems.map(() =>
                  "(provider = ? AND CAST(provider_id AS TEXT) = CAST(? AS TEXT))"
                ).join(" OR ")}
              )
            )
          )
      `).all(
        recordingId,
        recordingMbid,
        recordingMbid,
        ...providerItems.flatMap((item) => [item.provider, item.provider_id]),
      )
    : db.prepare(`
        SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
        FROM TrackFiles
        WHERE file_type IN ('video', 'video_thumbnail', 'nfo')
          AND (
            recording_id = ?
            OR (? IS NOT NULL AND canonical_recording_mbid = ?)
          )
      `).all(recordingId, recordingMbid, recordingMbid)) as TrackFileDeleteRow[];

  const result = deleteTrackFileRows(rows);
  return { ...result, unmonitored: false };
}

/**
 * Delete specific TrackFiles by id (disk + DB). Used by track/video manage UIs.
 */
export function deleteLibraryFilesByIds(
  fileIds: number[],
): DeleteLibraryFilesResult {
  const uniqueIds = Array.from(new Set(
    fileIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
  ));
  if (uniqueIds.length === 0) {
    return { deleted: 0, missing: 0, errors: 0, unmonitored: false };
  }

  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, artist_id, file_type, quality, file_path, library_root, canonical_release_group_mbid
    FROM TrackFiles
    WHERE id IN (${placeholders})
  `).all(...uniqueIds) as TrackFileDeleteRow[];

  const result = deleteTrackFileRows(rows);
  const releaseGroups = new Set(
    rows
      .map((row) => row.canonical_release_group_mbid)
      .filter((mbid): mbid is string => Boolean(mbid)),
  );
  for (const releaseGroupMbid of releaseGroups) {
    invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
  }
  return { ...result, unmonitored: false };
}

