import type Database from "better-sqlite3";

/**
 * Monitoring an Album in a Library, and which Libraries a command may touch.
 *
 * Two rules live here, because both were previously spread across every caller
 * that happened to write a `LibraryAlbums` row.
 *
 * **Row existence is the state.** `LibraryAlbums` has no `monitored` column.
 * Monitoring inserts the row; unmonitoring deletes it, along with the Editions
 * monitored under it and the Album's lock. A caller cannot leave behind a row
 * that claims to be unmonitored, because there is nothing to claim it with.
 *
 * **A Library is named, never assumed.** Monitoring an Album in Stereo says
 * nothing about Spatial, and the Video Library is not an audio Library at all —
 * it holds canonical video Recordings, which are curated by a different path
 * entirely. Commands therefore state their scope: one Library, or every audio
 * Library on purpose.
 */

/** Which Libraries an Album command applies to. Never implicit. */
export type AlbumLibraryScope =
  | { kind: "library"; libraryId: number }
  /** Every enabled *audio* Library. The Video Library is never included. */
  | { kind: "all-audio-libraries" };

/**
 * A Library is an audio Library unless its quality profile accepts `video`.
 *
 * Reading the profile rather than the Library's name keeps this true for
 * Libraries the user renames or adds; `allowed_source_formats` is already how
 * the rest of the codebase separates spatial Libraries from stereo ones.
 */
export const AUDIO_LIBRARY_PREDICATE = `
  NOT EXISTS (
    SELECT 1
    FROM quality_profiles library_quality_profile
    JOIN json_each(COALESCE(library_quality_profile.allowed_source_formats, '[]')) allowed_format
    WHERE library_quality_profile.id = %ALIAS%.quality_profile_id
      AND allowed_format.value = 'video'
  )
`;

/** The same predicate, bound to a `Libraries` alias in the caller's query. */
export function audioLibraryPredicate(libraryAlias: string): string {
  return AUDIO_LIBRARY_PREDICATE.replaceAll("%ALIAS%", libraryAlias);
}

/** Enabled Library ids the scope resolves to, ascending. */
export function resolveScopedLibraryIds(
  db: Database.Database,
  scope: AlbumLibraryScope,
): number[] {
  if (scope.kind === "library") {
    const row = db.prepare(`
      SELECT library.id
      FROM Libraries library
      WHERE library.id = ? AND library.enabled = 1
    `).get(scope.libraryId) as { id: number } | undefined;
    return row ? [row.id] : [];
  }
  return (db.prepare(`
    SELECT library.id
    FROM Libraries library
    WHERE library.enabled = 1
      AND ${audioLibraryPredicate("library")}
    ORDER BY library.id
  `).all() as Array<{ id: number }>).map((row) => row.id);
}

/** True when this Library holds canonical video Recordings rather than audio. */
export function isVideoLibrary(db: Database.Database, libraryId: number): boolean {
  return !db.prepare(`
    SELECT 1
    FROM Libraries library
    WHERE library.id = ? AND ${audioLibraryPredicate("library")}
  `).get(libraryId);
}

export interface AlbumMonitoringOptions {
  reason: string;
  /**
   * Automation honours the Album lock; a user action is the reason locks can be
   * changed at all. See `library-album-lock.ts` for the full contract.
   */
  actor: "user" | "automation";
  selectionMode?: "auto" | "manual";
  curationVersion?: number;
}

/**
 * Monitor one Album in the given Libraries. Idempotent.
 *
 * A locked Album is left exactly as it is when automation asks: the lock exists
 * to stop automation reconsidering a decision, and re-asserting the row would
 * overwrite the reason and selection mode the user's choice recorded.
 */
export function monitorAlbumInLibraries(
  db: Database.Database,
  releaseGroupId: number,
  libraryIds: readonly number[],
  options: AlbumMonitoringOptions,
): number {
  if (libraryIds.length === 0) return 0;
  const selectionMode = options.selectionMode
    ?? (options.actor === "user" ? "manual" : "auto");
  const insert = db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked,
      reason, curation_version, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(library_id, release_group_id) DO UPDATE SET
      selection_mode = CASE WHEN ? = 'automation' AND LibraryAlbums.locked = 1
        THEN LibraryAlbums.selection_mode ELSE excluded.selection_mode END,
      reason = CASE WHEN ? = 'automation' AND LibraryAlbums.locked = 1
        THEN LibraryAlbums.reason ELSE excluded.reason END,
      curation_version = CASE WHEN ? = 'automation' AND LibraryAlbums.locked = 1
        THEN LibraryAlbums.curation_version ELSE excluded.curation_version END,
      updated_at = CURRENT_TIMESTAMP
  `);
  let changed = 0;
  for (const libraryId of libraryIds) {
    changed += insert.run(
      libraryId,
      releaseGroupId,
      selectionMode,
      options.reason,
      options.curationVersion ?? 1,
      options.actor,
      options.actor,
      options.actor,
    ).changes;
  }
  return changed;
}

/**
 * Stop monitoring one Album in the given Libraries.
 *
 * The monitored Editions under it go too — an Edition monitored inside an
 * unmonitored Album is the contradiction row-existence semantics exist to
 * prevent. Candidate acquisition plans, canonical metadata, provider matches
 * and files on disk all survive; only the statement "this Library wants this
 * Album" is withdrawn.
 */
export function unmonitorAlbumInLibraries(
  db: Database.Database,
  releaseGroupId: number,
  libraryIds: readonly number[],
  options: Pick<AlbumMonitoringOptions, "actor">,
): number {
  if (libraryIds.length === 0) return 0;
  // Automation may not unmonitor a locked Album; a user may, and the lock is
  // discarded with the row it lived on.
  const lockGuard = options.actor === "automation"
    ? "AND COALESCE((SELECT locked FROM LibraryAlbums WHERE library_id = ? AND release_group_id = ?), 0) = 0"
    : "";
  const deleteEditions = db.prepare(`
    DELETE FROM LibraryEditions
    WHERE library_id = ?
      AND edition_id IN (SELECT id FROM AlbumEditions WHERE release_group_id = ?)
      ${lockGuard}
  `);
  const deleteAlbum = db.prepare(`
    DELETE FROM LibraryAlbums
    WHERE library_id = ? AND release_group_id = ?
      ${options.actor === "automation" ? "AND locked = 0" : ""}
  `);
  let removed = 0;
  for (const libraryId of libraryIds) {
    if (options.actor === "automation") {
      deleteEditions.run(libraryId, releaseGroupId, libraryId, releaseGroupId);
    } else {
      deleteEditions.run(libraryId, releaseGroupId);
    }
    removed += deleteAlbum.run(libraryId, releaseGroupId).changes;
  }
  return removed;
}
