import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import {
  invalidateArtistDownloadStatus,
  invalidateReleaseGroupDownloadStatus,
} from "../download/download-state.js";
import {
  captureLinkedExtras,
  emptyExtraDeletionResult,
  releaseExtrasForDeletedTrackFiles,
  type ExtraDeletionResult,
} from "../extras/files/extra-file-deletion.js";
import { AlbumCommandService } from "../music/album-command-service.js";
import {
  describeScope,
  pathIsInsideScopeRoot,
  resolveDeletionScope,
  scopeIncludesFile,
  type DeletionScope,
  type DeletionScopeInput,
} from "./library-deletion-scope.js";
import {
  LibraryFilesService,
  removeEmptyParents,
} from "./library-files.js";
import { ArtistStatisticsService } from "../music/artist-statistics-service.js";
import { syncLibraryArtistMonitoring } from "../music/managed-artists.js";
import {
  resolveLibraryRootPath,
  resolveStoredLibraryPath,
} from "./library-paths.js";

export type DeleteLibraryFilesResult = {
  deleted: number;
  missing: number;
  errors: number;
  /** Rows refused because their path could not be proven inside the target root. */
  skippedOutsideRoot: number;
  unmonitored: boolean;
  extras: ExtraDeletionResult;
};

export type DeleteLibraryFilesOptions = DeletionScopeInput;

type TrackFileDeleteRow = {
  id: number;
  artist_metadata_id: number;
  file_type: string;
  quality: string | null;
  file_path: string;
  library_root: string;
  library_id: number | null;
  canonical_release_group_mbid: string | null;
};

const TRACK_FILE_DELETE_COLUMNS = `
  id, artist_metadata_id, file_type, quality, file_path, library_root, library_id,
  canonical_release_group_mbid
`;

function notFound(message: string): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  error.status = 404;
  return error;
}

/**
 * Delete playable files for one deletion scope.
 *
 * Order matters: the filesystem operation happens first, the TrackFiles row is
 * only dropped once the file is gone (or was already absent), shared extras are
 * released afterwards, and empty parents are pruned last so a retained extra
 * still counts as folder content.
 */
function deleteTrackFileRows(
  rows: TrackFileDeleteRow[],
  scope: DeletionScope,
): Omit<DeleteLibraryFilesResult, "unmonitored"> {
  let deleted = 0;
  let missing = 0;
  let errors = 0;
  let skippedOutsideRoot = 0;

  const deletedTrackFileIds: number[] = [];
  const affectedArtistIds = new Set<string>();
  const storedFilePaths: string[] = [];
  const parentsToPrune: Array<{ directory: string; root: string }> = [];

  // The FK from every extra table to TrackFiles is ON DELETE SET NULL, so the
  // links have to be read while the playable rows still exist.
  const linkedExtras = captureLinkedExtras(rows.map((row) => row.id));

  for (const row of rows) {
    let canRemove = true;
    const resolvedFilePath = resolveStoredLibraryPath({
      filePath: row.file_path,
      libraryRoot: row.library_root,
    });

    // Owning the row is not permission to delete the path it names. Prove the
    // resolved path is inside the target Library's configured root first.
    if (!pathIsInsideScopeRoot(scope, resolvedFilePath)) {
      console.warn(
        `[LibraryDelete] Deletion skipped outside managed root for ${describeScope(scope)}: `
        + `${resolvedFilePath}`,
      );
      skippedOutsideRoot += 1;
      continue;
    }

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
    deletedTrackFileIds.push(row.id);
    affectedArtistIds.add(String(row.artist_metadata_id));
    storedFilePaths.push(row.file_path);

    LibraryFilesService.emitFileDeleted({
      libraryFileId: row.id,
      artistId: row.artist_metadata_id,
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
      parentsToPrune.push({ directory: path.dirname(resolvedFilePath), root });
    }
  }

  const extras = deletedTrackFileIds.length > 0
    ? releaseExtrasForDeletedTrackFiles({
      scope,
      deletedTrackFileIds,
      storedFilePaths,
      linkedExtras,
    })
    : emptyExtraDeletionResult();

  for (const parent of parentsToPrune) {
    removeEmptyParents(parent.directory, parent.root);
  }

  // FILE_DELETED invalidates the global snapshot and the browser query, but
  // Artist list counts come from the persisted ArtistStatistics projection.
  // Refresh the bounded affected set before the route returns so the immediate
  // browser refetch cannot observe a stale numerator or size-on-disk value.
  if (affectedArtistIds.size > 0) {
    ArtistStatisticsService.refresh([...affectedArtistIds]);
  }

  return { deleted, missing, errors, skippedOutsideRoot, extras };
}

function selectScopedRows(sql: string, values: unknown[], scope: DeletionScope): TrackFileDeleteRow[] {
  const rows = db.prepare(sql).all(...values) as TrackFileDeleteRow[];
  return rows.filter((row) => scopeIncludesFile(scope, row));
}

/**
 * Manage → Delete files for an Album (optional legacy stereo/spatial slot).
 * Removes disk files and TrackFiles rows owned by the target Library only.
 * Does not delete MusicBrainz/catalog rows.
 */
export function deleteReleaseGroupLibraryFiles(
  releaseGroupMbid: string,
  options: DeleteLibraryFilesOptions & {
    slot?: "stereo" | "spatial" | null;
    unmonitor?: boolean;
  } = {},
): DeleteLibraryFilesResult {
  const scope = resolveDeletionScope(options);
  const releaseGroup = db.prepare(`
    SELECT mbid FROM Albums WHERE mbid = ?
  `).get(releaseGroupMbid) as { mbid?: string } | undefined;
  if (!releaseGroup?.mbid) {
    throw notFound("Album not found");
  }

  const slot = options.slot === "spatial" || options.slot === "stereo" ? options.slot : null;
  const rows = selectScopedRows(
    slot
      ? `SELECT ${TRACK_FILE_DELETE_COLUMNS}
         FROM TrackFiles
         WHERE canonical_release_group_mbid = ?
           AND library_slot = ?`
      : `SELECT ${TRACK_FILE_DELETE_COLUMNS}
         FROM TrackFiles
         WHERE canonical_release_group_mbid = ?`,
    slot ? [releaseGroupMbid, slot] : [releaseGroupMbid],
    scope,
  );

  const result = deleteTrackFileRows(rows, scope);
  invalidateReleaseGroupDownloadStatus(releaseGroupMbid);

  let unmonitored = false;
  if (options.unmonitor) {
    // Unmonitor exactly the Library whose files were just deleted. Deleting
    // Stereo's files says nothing about whether Spatial still wants the Album.
    AlbumCommandService.updateAlbum(
      releaseGroupMbid,
      false,
      undefined,
      scope.kind === "library"
        ? { kind: "library", libraryId: scope.libraryId }
        : { kind: "all-audio-libraries" },
    );
    unmonitored = true;
  }

  return { ...result, unmonitored };
}

/**
 * Manage → Delete files for an Artist within one Library.
 * Removes disk files + TrackFiles for the artist; keeps catalog/artist rows.
 */
export function deleteArtistLibraryFiles(
  artistId: string,
  options: DeleteLibraryFilesOptions & { unmonitor?: boolean } = {},
): DeleteLibraryFilesResult {
  const scope = resolveDeletionScope(options);
  const artist = db.prepare(`
    SELECT id FROM ArtistMetadata WHERE id = ?
  `).get(artistId) as { id?: number | string } | undefined;
  if (!artist?.id) {
    throw notFound("Artist not found");
  }

  const rows = selectScopedRows(
    `SELECT ${TRACK_FILE_DELETE_COLUMNS} FROM TrackFiles WHERE artist_metadata_id = ?`,
    [artistId],
    scope,
  );

  const releaseGroups = new Set(
    rows
      .map((row) => row.canonical_release_group_mbid)
      .filter((mbid): mbid is string => Boolean(mbid)),
  );

  const result = deleteTrackFileRows(rows, scope);
  for (const releaseGroupMbid of releaseGroups) {
    invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
  }
  invalidateArtistDownloadStatus(String(artistId));

  let unmonitored = false;
  if (options.unmonitor) {
    syncLibraryArtistMonitoring(artistId, false);
    unmonitored = true;
  }

  return { ...result, unmonitored };
}

/**
 * Manage → Delete files for a single canonical Track within one Library.
 *
 * Resolution is canonical only. The previous implementation also matched
 * `provider_id = <track mbid>`, which let an unrelated provider-native id
 * collide with a canonical Track MBID and delete another file entirely.
 */
export function deleteTrackLibraryFiles(
  trackMbid: string,
  options: DeleteLibraryFilesOptions = {},
): DeleteLibraryFilesResult {
  const scope = resolveDeletionScope(options);
  const track = db.prepare(`
    SELECT id, mbid FROM Tracks WHERE mbid = ?
  `).get(trackMbid) as { id?: number; mbid?: string } | undefined;
  if (!track?.mbid) {
    throw notFound("Track not found");
  }

  const rows = selectScopedRows(
    `SELECT ${TRACK_FILE_DELETE_COLUMNS}
     FROM TrackFiles
     WHERE canonical_track_mbid = ?
        OR (? IS NOT NULL AND track_id = ?)`,
    [trackMbid, track.id ?? null, track.id ?? null],
    scope,
  );

  const result = deleteTrackFileRows(rows, scope);
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
 * Manage → Delete files for a canonical music-video Recording within one Library.
 * Removes video + thumbnail/nfo TrackFiles; keeps the catalog Recording.
 */
export function deleteVideoLibraryFiles(
  videoId: string,
  options: DeleteLibraryFilesOptions = {},
): DeleteLibraryFilesResult {
  const scope = resolveDeletionScope(options);
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
    throw notFound("Video not found");
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

  const rows = providerItems.length > 0
    ? selectScopedRows(
      `SELECT ${TRACK_FILE_DELETE_COLUMNS}
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
         )`,
      [
        recordingId,
        recordingMbid,
        recordingMbid,
        ...providerItems.flatMap((item) => [item.provider, item.provider_id]),
      ],
      scope,
    )
    : selectScopedRows(
      `SELECT ${TRACK_FILE_DELETE_COLUMNS}
       FROM TrackFiles
       WHERE file_type IN ('video', 'video_thumbnail', 'nfo')
         AND (
           recording_id = ?
           OR (? IS NOT NULL AND canonical_recording_mbid = ?)
         )`,
      [recordingId, recordingMbid, recordingMbid],
      scope,
    );

  const result = deleteTrackFileRows(rows, scope);
  return { ...result, unmonitored: false };
}

/**
 * Delete specific TrackFiles by id (disk + DB). Used by track/video manage UIs.
 *
 * Exact row identity already names one Library per file, so the scope is only
 * used to release the right shared-extra associations.
 */
export function deleteLibraryFilesByIds(
  fileIds: number[],
  options: DeleteLibraryFilesOptions = {},
): DeleteLibraryFilesResult {
  const uniqueIds = Array.from(new Set(
    fileIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
  ));
  if (uniqueIds.length === 0) {
    return {
      deleted: 0,
      missing: 0,
      errors: 0,
      skippedOutsideRoot: 0,
      unmonitored: false,
      extras: emptyExtraDeletionResult(),
    };
  }

  const scope = resolveDeletionScope(options);
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = selectScopedRows(
    `SELECT ${TRACK_FILE_DELETE_COLUMNS} FROM TrackFiles WHERE id IN (${placeholders})`,
    uniqueIds,
    scope,
  );

  const result = deleteTrackFileRows(rows, scope);
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
