import type Database from "better-sqlite3";
import { getConfigSection } from "../config/config.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";

/**
 * Album and edition decisions.
 *
 * `LibraryAlbums.locked = 1` and `decision = 'user'` record a user decision.
 * `LibraryEditions.selection_mode = 'manual'` records a user edition choice.
 * Unmonitor deletes the monitored row and writes `LibraryUserExclusions`.
 * Curation reads that table and does not put the release back, in either mode.
 */

export function recordAlbumUserExclusion(
  db: Database.Database,
  libraryId: number,
  releaseGroupId: number,
): void {
  db.prepare(`
    INSERT INTO LibraryUserExclusions (library_id, release_group_id, edition_id)
    SELECT ?, ?, NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM LibraryUserExclusions
      WHERE library_id = ? AND release_group_id = ? AND edition_id IS NULL
    )
  `).run(libraryId, releaseGroupId, libraryId, releaseGroupId);
  db.prepare(`
    DELETE FROM LibraryCurationOutcomes
    WHERE library_id = ? AND release_group_id = ?
  `).run(libraryId, releaseGroupId);
}

export function recordEditionUserExclusion(
  db: Database.Database,
  libraryId: number,
  releaseGroupId: number,
  editionId: number,
): void {
  db.prepare(`
    INSERT INTO LibraryUserExclusions (library_id, release_group_id, edition_id)
    SELECT ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM LibraryUserExclusions
      WHERE library_id = ? AND edition_id = ?
    )
  `).run(libraryId, releaseGroupId, editionId, libraryId, editionId);
}

export function clearUserExclusions(
  db: Database.Database,
  libraryId: number,
  releaseGroupId: number,
): void {
  db.prepare(`
    DELETE FROM LibraryUserExclusions
    WHERE library_id = ? AND release_group_id = ?
  `).run(libraryId, releaseGroupId);
}

export function excludedReleaseGroupIds(
  db: Database.Database,
  libraryId: number,
): Set<number> {
  return new Set(
    (db.prepare(`
      SELECT release_group_id
      FROM LibraryUserExclusions
      WHERE library_id = ? AND edition_id IS NULL
    `).all(libraryId) as Array<{ release_group_id: number }>)
      .map((row) => row.release_group_id),
  );
}

export function excludedEditionIds(
  db: Database.Database,
  libraryId: number,
): Set<number> {
  return new Set(
    (db.prepare(`
      SELECT edition_id
      FROM LibraryUserExclusions
      WHERE library_id = ? AND edition_id IS NOT NULL
    `).all(libraryId) as Array<{ edition_id: number }>)
      .map((row) => row.edition_id),
  );
}

/** Coverage units curation must not go looking for on a compilation. */
export function excludedRecordingIds(
  db: Database.Database,
  libraryId: number,
): number[] {
  return (db.prepare(`
    SELECT DISTINCT track.recording_id AS recording_id
    FROM LibraryUserExclusions exclusion
    JOIN AlbumEditions edition
      ON edition.release_group_id = exclusion.release_group_id
     AND (
       exclusion.edition_id IS NULL
       OR exclusion.edition_id = edition.id
     )
    JOIN Tracks track ON track.album_edition_id = edition.id
    WHERE exclusion.library_id = ?
      AND track.recording_id IS NOT NULL
  `).all(libraryId) as Array<{ recording_id: number }>).map((row) => row.recording_id);
}

export function syncCurationOutcomes(
  db: Database.Database,
  libraryId: number,
  selectedReleaseGroupIds: readonly number[],
  replaced: ReadonlyArray<{ releaseGroupId: number; replacementTitle: string | null }>,
): void {
  if (selectedReleaseGroupIds.length > 0) {
    db.prepare(`
      DELETE FROM LibraryCurationOutcomes
      WHERE library_id = ?
        AND release_group_id IN ${SQL_JSON_LIST}
    `).run(libraryId, jsonList(selectedReleaseGroupIds));
  }
  const upsert = db.prepare(`
    INSERT INTO LibraryCurationOutcomes (
      library_id, release_group_id, outcome, replacement_title, updated_at
    ) VALUES (?, ?, 'replaced', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(library_id, release_group_id) DO UPDATE SET
      outcome = 'replaced',
      replacement_title = excluded.replacement_title,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const row of replaced) {
    upsert.run(libraryId, row.releaseGroupId, row.replacementTitle);
  }
}

export interface AlbumDecisionView {
  label: string | null;
  action: "back_to_automatic" | null;
}

/**
 * Album-page status. Curation outcomes stay hidden while automatic curation
 * is off. A user decision stays visible in both modes.
 */
export function albumDecisionView(
  db: Database.Database,
  releaseGroupMbid: string,
): AlbumDecisionView {
  const album = db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(releaseGroupMbid) as { id: number } | undefined;
  if (!album) return { label: null, action: null };

  const excluded = db.prepare(`
    SELECT 1 FROM LibraryUserExclusions
    WHERE release_group_id = ? AND edition_id IS NULL
    LIMIT 1
  `).get(album.id);
  if (excluded) {
    return { label: "Unmonitored by you", action: "back_to_automatic" };
  }

  const chosen = db.prepare(`
    SELECT 1 FROM LibraryAlbums
    WHERE release_group_id = ? AND locked = 1
    LIMIT 1
  `).get(album.id);
  if (chosen) {
    return { label: "Chosen by you", action: "back_to_automatic" };
  }

  const curationOn = getConfigSection("filtering").enable_redundancy_filter !== false;
  const monitored = db.prepare(`
    SELECT locked FROM LibraryAlbums WHERE release_group_id = ? LIMIT 1
  `).get(album.id) as { locked: number } | undefined;
  if (!curationOn) {
    return monitored
      ? { label: "Monitored automatically", action: null }
      : { label: null, action: null };
  }

  const waiting = waitingCoverage(db, album.id);
  if (waiting && waiting.total > 0 && waiting.covered < waiting.total) {
    return {
      label: `Waiting for replacement: ${waiting.covered} of ${waiting.total} tracks covered`,
      action: null,
    };
  }

  if (monitored) return { label: null, action: null };

  const replaced = db.prepare(`
    SELECT replacement_title
    FROM LibraryCurationOutcomes
    WHERE release_group_id = ? AND outcome = 'replaced'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(album.id) as { replacement_title: string | null } | undefined;
  if (replaced) {
    return {
      label: replaced.replacement_title
        ? `Unmonitored by curation: replaced by ${replaced.replacement_title}`
        : "Unmonitored by curation",
      action: null,
    };
  }
  return { label: null, action: null };
}

function waitingCoverage(
  db: Database.Database,
  releaseGroupId: number,
): { covered: number; total: number } | null {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM TrackFiles covered_file
        JOIN LibraryEditions covered_edition
          ON covered_edition.library_id = covered_file.library_id
         AND covered_edition.edition_id = covered_file.album_edition_id
        WHERE covered_file.id != file.id
          AND covered_file.library_id = file.library_id
          AND (
            (file.recording_id IS NOT NULL AND covered_file.recording_id = file.recording_id)
            OR (
              file.canonical_recording_mbid IS NOT NULL
              AND TRIM(file.canonical_recording_mbid) != ''
              AND covered_file.canonical_recording_mbid = file.canonical_recording_mbid
            )
          )
      ) THEN 1 ELSE 0 END) AS covered
    FROM TrackFiles file
    JOIN AlbumEditions edition ON edition.id = file.album_edition_id
    LEFT JOIN LibraryEditions monitored
      ON monitored.library_id = file.library_id
     AND monitored.edition_id = file.album_edition_id
    WHERE edition.release_group_id = ?
      AND monitored.id IS NULL
      AND (
        file.recording_id IS NOT NULL
        OR (file.canonical_recording_mbid IS NOT NULL AND TRIM(file.canonical_recording_mbid) != '')
      )
  `).get(releaseGroupId) as { total: number; covered: number | null } | undefined;
  if (!row || row.total === 0) return null;
  return { total: row.total, covered: Number(row.covered || 0) };
}

export function editionDecisionLabel(
  db: Database.Database,
  libraryId: number,
  releaseGroupId: number,
  editionId: number,
  monitored: boolean,
  selectionMode: "auto" | "manual",
  albumLocked: boolean,
): string | null {
  if (monitored && (selectionMode === "manual" || albumLocked)) return "Chosen by you";
  const excludedEdition = db.prepare(`
    SELECT 1 FROM LibraryUserExclusions
    WHERE library_id = ? AND (edition_id = ? OR (release_group_id = ? AND edition_id IS NULL))
    LIMIT 1
  `).get(libraryId, editionId, releaseGroupId);
  if (!monitored && excludedEdition) return "Unmonitored by you";
  const curationOn = getConfigSection("filtering").enable_redundancy_filter !== false;
  if (!monitored && curationOn) {
    const replaced = db.prepare(`
      SELECT replacement_title FROM LibraryCurationOutcomes
      WHERE library_id = ? AND release_group_id = ? AND outcome = 'replaced'
    `).get(libraryId, releaseGroupId) as { replacement_title: string | null } | undefined;
    if (replaced?.replacement_title) {
      return `Unmonitored by curation: replaced by ${replaced.replacement_title}`;
    }
  }
  return null;
}
