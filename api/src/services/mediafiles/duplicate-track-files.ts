import path from "path";
import { db } from "../../database.js";
import { moveTrackFileToUnmapped } from "./track-file-unmap.js";
import { deleteLibraryFilesByIds } from "./library-file-delete-service.js";
import { normalizeResolvedPath } from "./path-utils.js";

/**
 * One file per track per library (Lidarr's rule). When a rename would land a
 * file on a path another file of the same edition and library already claims,
 * the collision is resolved instead of reported:
 *
 * - clear duplicate: the occupant is linked to the track and already sits at
 *   the path, the mover is an unlinked copy or a copy in another folder of the
 *   same edition -> delete the mover;
 * - manual import: the mover came in through manual import -> move it to the
 *   unmapped files list (file stays on disk);
 * - ambiguous: anything else (e.g. the linked file must move onto a path held
 *   by an unlinked copy) -> delete both and let the track be downloaded again.
 *
 * Different editions or libraries never collide here; those keep the conflict.
 */
export type DuplicateResolution =
  | { kind: "delete-unlinked"; deleteIds: number[]; keepId: number }
  | { kind: "unmapped"; unmapIds: number[]; keepId: number }
  | { kind: "ambiguous"; deleteIds: number[]; artistIds: string[] };

export type TrackFileClaim = {
  id: number;
  library_id: number | null;
  album_edition_id: number | null;
  track_id: number | null;
  artist_metadata_id: number | null;
  file_path: string;
  manual: boolean;
};

export function classifyTrackPathCollision(
  mover: TrackFileClaim,
  occupant: TrackFileClaim,
  targetPath: string,
): DuplicateResolution | null {
  if (mover.id === occupant.id) return null;
  if (mover.library_id !== occupant.library_id) return null;
  if (mover.album_edition_id == null || mover.album_edition_id !== occupant.album_edition_id) return null;

  const occupantLinkedInPlace = occupant.track_id != null
    && normalizeResolvedPath(occupant.file_path) === normalizeResolvedPath(targetPath);
  if (mover.manual && occupant.track_id != null) {
    return { kind: "unmapped", unmapIds: [mover.id], keepId: occupant.id };
  }
  // Clear: the linked file already sits at the path, and the mover is either
  // unlinked or a stray copy in another folder (e.g. an old edition-title folder).
  const strayFolder = path.dirname(normalizeResolvedPath(mover.file_path)) !== path.dirname(normalizeResolvedPath(targetPath));
  if (occupantLinkedInPlace && (mover.track_id == null || strayFolder)) {
    return { kind: "delete-unlinked", deleteIds: [mover.id], keepId: occupant.id };
  }
  const artistIds = [mover.artist_metadata_id, occupant.artist_metadata_id]
    .filter((id): id is number => id != null)
    .map(String);
  return { kind: "ambiguous", deleteIds: [mover.id, occupant.id], artistIds: [...new Set(artistIds)] };
}

export function loadTrackFileClaim(id: number): TrackFileClaim | null {
  const row = db.prepare(`
    SELECT id, library_id, album_edition_id, track_id, artist_metadata_id, file_path,
           provider, provider_id
    FROM TrackFiles WHERE id = ?
  `).get(id) as (Omit<TrackFileClaim, "manual"> & {
    provider: string | null;
    provider_id: string | null;
  }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    library_id: row.library_id,
    album_edition_id: row.album_edition_id,
    track_id: row.track_id,
    artist_metadata_id: row.artist_metadata_id,
    file_path: row.file_path,
    // Manual import clears the provider identity (canonical-manual-import-service);
    // downloaded files keep provider + provider_id even when unlinked.
    manual: row.provider == null && row.provider_id == null,
  };
}

export function findTrackPathOccupant(targetPath: string, excludeId: number): TrackFileClaim | null {
  const owners = db.prepare(`
    SELECT id FROM TrackFiles
    WHERE (file_path = ? OR expected_path = ?) AND id <> ?
    ORDER BY CASE WHEN file_path = ? THEN 0 ELSE 1 END, id
  `).all(targetPath, targetPath, excludeId, targetPath) as Array<{ id: number }>;
  for (const owner of owners) {
    const claim = loadTrackFileClaim(owner.id);
    if (claim) return claim;
  }
  return null;
}

export function planTrackPathCollision(moverId: number, targetPath: string): DuplicateResolution | null {
  const mover = loadTrackFileClaim(moverId);
  const occupant = findTrackPathOccupant(targetPath, moverId);
  if (!mover || !occupant) return null;
  return classifyTrackPathCollision(mover, occupant, targetPath);
}

export type DuplicateApplyResult = {
  deleted: number[];
  unmapped: number[];
  redownloadArtistIds: string[];
  errors: string[];
};

export function moveToUnmapped(id: number, reason: string): boolean {
  return moveTrackFileToUnmapped(db, id, reason);
}

/**
 * Execute resolutions. Deletion goes through the normal delete service (root
 * guard, extras release, empty-folder pruning). Ambiguous cases return the
 * artist ids whose monitored missing tracks must be queued again.
 */
export function applyDuplicateResolutions(plans: DuplicateResolution[]): DuplicateApplyResult {
  const result: DuplicateApplyResult = { deleted: [], unmapped: [], redownloadArtistIds: [], errors: [] };
  const handled = new Set<number>();
  const redownload = new Set<string>();
  for (const plan of plans) {
    if (plan.kind === "unmapped") {
      for (const id of plan.unmapIds) {
        if (handled.has(id)) continue;
        handled.add(id);
        if (moveToUnmapped(id, `Duplicate of track file ${plan.keepId}; manual import claims an occupied track`)) {
          result.unmapped.push(id);
        }
      }
      continue;
    }
    const ids = plan.deleteIds.filter((id) => !handled.has(id));
    ids.forEach((id) => handled.add(id));
    if (ids.length === 0) continue;
    const deletion = deleteLibraryFilesByIds(ids, { allLibraries: true });
    if (deletion.errors > 0 || deletion.skippedOutsideRoot > 0) {
      result.errors.push(`delete ${ids.join(",")}: ${deletion.errors} errors, ${deletion.skippedOutsideRoot} outside root`);
    }
    const remaining = new Set((db.prepare(
      `SELECT id FROM TrackFiles WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).all(...ids) as Array<{ id: number }>).map((row) => row.id));
    result.deleted.push(...ids.filter((id) => !remaining.has(id)));
    if (plan.kind === "ambiguous") plan.artistIds.forEach((id) => redownload.add(id));
  }
  result.redownloadArtistIds = [...redownload];
  return result;
}
