import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import { resolveLibraryRootPath, resolveStoredLibraryPath } from "./library-paths.js";
import { normalizeResolvedPath, resolvedPathIsInsideRoot } from "./path-utils.js";

/**
 * The only audio file an import may retire.
 *
 * `trackId` is `Tracks.id`: one row is one medium and position on one release.
 * A recording MBID and a provider track id are not fields. Both are shared by
 * other releases (a box set and the studio album that first issued the take),
 * so a signature that accepted them could name the wrong album's file.
 */
export type ReleaseTrackReplacement = {
  trackId: number;
  librarySlot: "stereo" | "spatial";
  newFilePath: string;
};

/**
 * The only video file an import may retire: the previous copy of this
 * provider video. `file_type = 'video'` is fixed in the query, so the target
 * cannot be an album track that happens to share a recording.
 */
export type VideoResourceReplacement = {
  provider: string;
  providerVideoId: string;
  newFilePath: string;
};

export type RetiredLibraryFile = {
  id: number;
  artistId: number | string | null;
  mediaId: string | null;
  quality: string | null;
  filePath: string;
  libraryRoot: string | null;
  resolvedPath: string;
};

type RetiredRow = {
  id: number;
  artist_id: number | string | null;
  media_id: string | null;
  quality: string | null;
  file_path: string;
  library_root: string | null;
};

function removeEmptyParents(startDir: string, stopDir: string): void {
  const stop = path.resolve(stopDir);
  const stopKey = normalizeResolvedPath(stop);
  let current = path.resolve(startDir);
  while (resolvedPathIsInsideRoot(current, stop) && normalizeResolvedPath(current) !== stopKey) {
    try {
      let ancestor = current;
      while (true) {
        const stat = fs.lstatSync(ancestor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return;
        if (normalizeResolvedPath(ancestor) === stopKey) break;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return;
        ancestor = parent;
      }
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function toRetired(row: RetiredRow, newFilePath: string): RetiredLibraryFile | null {
  const resolvedPath = resolveStoredLibraryPath({
    filePath: row.file_path,
    libraryRoot: row.library_root,
  });
  if (samePath(resolvedPath, newFilePath)) return null;
  return {
    id: row.id,
    artistId: row.artist_id,
    mediaId: row.media_id,
    quality: row.quality,
    filePath: row.file_path,
    libraryRoot: row.library_root,
    resolvedPath,
  };
}

/**
 * Name the release track the new file belongs to.
 * A track MBID is one `Tracks` row. Medium and position are the same row
 * when the MBID is absent (`UNIQUE(release_mbid, medium_position, position)`).
 * Neither input can name a different release's track.
 */
export function resolveReleaseTrackId(input: {
  trackMbid?: string | null;
  releaseMbid?: string | null;
  mediumPosition?: number | null;
  position?: number | null;
}): number | null {
  const trackMbid = String(input.trackMbid || "").trim();
  if (trackMbid) {
    const byMbid = db.prepare("SELECT id FROM Tracks WHERE mbid = ?").get(trackMbid) as { id: number } | undefined;
    if (byMbid) return byMbid.id;
  }

  const releaseMbid = String(input.releaseMbid || "").trim();
  const mediumPosition = Number(input.mediumPosition);
  const position = Number(input.position);
  if (
    !releaseMbid
    || !Number.isInteger(mediumPosition)
    || mediumPosition <= 0
    || !Number.isInteger(position)
    || position <= 0
  ) {
    return null;
  }

  const byPosition = db.prepare(`
    SELECT id
    FROM Tracks
    WHERE release_mbid = ?
      AND medium_position = ?
      AND position = ?
  `).get(releaseMbid, mediumPosition, position) as { id: number } | undefined;
  return byPosition?.id ?? null;
}

export function listPreviousReleaseTrackFiles(target: ReleaseTrackReplacement): RetiredLibraryFile[] {
  if (!Number.isInteger(target.trackId) || target.trackId <= 0) return [];
  if (target.librarySlot !== "stereo" && target.librarySlot !== "spatial") return [];
  const rows = db.prepare(`
    SELECT
      tf.id,
      tf.artist_metadata_id AS artist_id,
      CAST(tf.provider_id AS TEXT) AS media_id,
      tf.quality,
      tf.file_path,
      tf.library_root
    FROM TrackFiles tf
    WHERE tf.file_type = 'track'
      AND tf.library_slot = ?
      AND tf.file_path != ?
      AND (
        tf.track_id = ?
        OR tf.canonical_track_mbid = (SELECT mbid FROM Tracks WHERE id = ?)
      )
  `).all(target.librarySlot, target.newFilePath, target.trackId, target.trackId) as RetiredRow[];
  return rows.flatMap((row) => {
    const retired = toRetired(row, target.newFilePath);
    return retired ? [retired] : [];
  });
}

export function listPreviousVideoFiles(target: VideoResourceReplacement): RetiredLibraryFile[] {
  const provider = String(target.provider || "").trim();
  const providerVideoId = String(target.providerVideoId || "").trim();
  if (!provider || !providerVideoId) return [];
  const rows = db.prepare(`
    SELECT
      tf.id,
      tf.artist_metadata_id AS artist_id,
      CAST(tf.provider_id AS TEXT) AS media_id,
      tf.quality,
      tf.file_path,
      tf.library_root
    FROM TrackFiles tf
    WHERE tf.file_type = 'video'
      AND tf.library_slot = 'video'
      AND tf.provider = ?
      AND tf.provider_entity_type = 'video'
      AND tf.provider_id = ?
      AND tf.file_path != ?
  `).all(provider, providerVideoId, target.newFilePath) as RetiredRow[];
  return rows.flatMap((row) => {
    const retired = toRetired(row, target.newFilePath);
    return retired ? [retired] : [];
  });
}

/** Delete the bytes. Database rows stay until `forgetRetiredLibraryFileRows`. */
export function unlinkRetiredLibraryFiles(
  rows: readonly RetiredLibraryFile[],
  newFilePath: string,
  fileType: "track" | "video",
): RetiredLibraryFile[] {
  const unlinked: RetiredLibraryFile[] = [];
  for (const row of rows) {
    if (samePath(row.resolvedPath, newFilePath)) continue;
    try {
      if (fs.existsSync(row.resolvedPath)) {
        fs.rmSync(row.resolvedPath, { force: true });
        console.log(`[Organizer] Deleted old ${fileType} file (replaced by upgrade): ${row.resolvedPath}`);
        const libraryRoot = resolveLibraryRootPath(row.libraryRoot, row.resolvedPath);
        if (libraryRoot) {
          removeEmptyParents(path.dirname(row.resolvedPath), libraryRoot);
        }
      }
      unlinked.push(row);
    } catch (error) {
      console.warn(`[Organizer] Failed to delete old file: ${row.filePath}`, error);
    }
  }
  return unlinked;
}

/** Database only. Call inside the write gate, after the bytes are gone. */
export function forgetRetiredLibraryFileRows(
  rows: readonly RetiredLibraryFile[],
  replacementPath: string,
  fileType: "track" | "video",
): void {
  if (rows.length === 0) return;
  for (const row of rows) {
    try {
      recordHistoryEvent({
        artistId: row.artistId,
        albumId: null,
        mediaId: row.mediaId,
        libraryFileId: row.id,
        eventType: HISTORY_EVENT_TYPES.TrackFileDeleted,
        quality: row.quality,
        data: {
          deletedPath: row.resolvedPath,
          replacementPath,
          fileType,
        },
      });
    } catch (error) {
      console.warn(`[Organizer] Failed to record replacement delete history for ${row.resolvedPath}:`, error);
    }
  }
  db.prepare(`DELETE FROM TrackFiles WHERE id IN ${SQL_JSON_LIST}`).run(
    jsonList(rows.map((row) => row.id)),
  );
}
