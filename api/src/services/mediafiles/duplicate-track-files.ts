import path from "path";
import { db } from "../../database.js";
import { deleteLibraryFilesByIds } from "./library-file-delete-service.js";
import { normalizeResolvedPath } from "./path-utils.js";

/**
 * One file per track per library (Lidarr's rule). When a rename would land a
 * file on a path another file of the same edition and library already claims,
 * the collision is resolved instead of reported:
 *
 * - clear duplicate: the occupant is linked to the track and already sits at
 *   the path, the mover is an unlinked copy -> delete the mover;
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
  if (mover.track_id == null && occupantLinkedInPlace) {
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
           provider_item_id, source_audio_variant_id
    FROM TrackFiles WHERE id = ?
  `).get(id) as (Omit<TrackFileClaim, "manual"> & {
    provider_item_id: number | null;
    source_audio_variant_id: number | null;
  }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    library_id: row.library_id,
    album_edition_id: row.album_edition_id,
    track_id: row.track_id,
    artist_metadata_id: row.artist_metadata_id,
    file_path: row.file_path,
    // Manual import stores no provider acquisition (canonical-manual-import clears it).
    manual: row.provider_item_id == null && row.source_audio_variant_id == null,
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

function moveToUnmapped(id: number, reason: string): boolean {
  const row = db.prepare("SELECT * FROM TrackFiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  const filePath = String(row.file_path);
  const libraryRoot = String(row.library_root ?? path.dirname(filePath));
  const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
  db.transaction(() => {
    db.prepare(`
      INSERT INTO UnmappedFiles (
        file_path, relative_path, library_root, filename, extension, file_size, duration,
        bitrate, sample_rate, bit_depth, channels, codec, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET reason = excluded.reason, updated_at = CURRENT_TIMESTAMP
    `).run(
      filePath,
      String(row.relative_path ?? path.relative(libraryRoot, filePath)),
      libraryRoot,
      String(row.filename ?? path.basename(filePath)),
      String(row.extension ?? path.extname(filePath).replace(/^\./, "")),
      num(row.file_size),
      num(row.duration ?? (row.duration_ms != null ? Number(row.duration_ms) / 1000 : null)),
      num(row.bitrate),
      num(row.sample_rate),
      num(row.bit_depth),
      num(row.channels ?? row.channel_count),
      row.codec == null ? null : String(row.codec),
      reason,
    );
    db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(id);
  })();
  return true;
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
