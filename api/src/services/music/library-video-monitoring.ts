import type Database from "better-sqlite3";
import { audioLibraryPredicate } from "./library-album-monitoring.js";

/**
 * Selecting a canonical video into a Video Library, and where its one file goes.
 *
 * Videos are not audio, and forcing them through the audio path was the mistake
 * this replaces. A video has no Edition, no track list and no acquisition plan
 * to compose; it has one provider offer and one destination. What it does have,
 * which audio does not, is several plausible candidates per song — an official
 * video, a lyric video, a live cut, a visualizer — of which a Library wants at
 * most one or two.
 *
 * So three statements are kept apart:
 *
 *   canonical Recordings + ProviderVideoMatches   every video we know of
 *   LibraryVideos row exists                       this Library selected it
 *   LibraryVideos placement columns                where that one file lives
 *
 * The last is persisted rather than re-derived on every download, organise,
 * rename and scan, because a video legitimately appears on many Album pages and
 * every consumer must agree on the single path it occupies. Re-deriving it
 * independently is how the same video ends up copied into three album folders.
 */

export type VideoPlacement =
  | { mode: "separated" }
  | {
    mode: "inline";
    /** The AUDIO library receiving the file. */
    placementLibraryId: number;
    /** The exact canonical audio Track occurrence it sits beside. */
    inlineTrackId: number;
    inlineSlot: "video" | "lyrics";
  };

export interface LibraryVideoSelection {
  libraryId: number;
  videoRecordingId: number;
  placement: VideoPlacement;
  preferredOfferKey?: string | null;
  selectionMode?: "auto" | "manual";
  placementSelectionMode?: "auto" | "manual";
  reason?: string | null;
}

/** Video Libraries: the ones whose quality profile accepts `video`. */
export function resolveVideoLibraryIds(db: Database.Database): number[] {
  return (db.prepare(`
    SELECT library.id
    FROM Libraries library
    WHERE library.enabled = 1
      AND NOT (${audioLibraryPredicate("library")})
    ORDER BY library.id
  `).all() as Array<{ id: number }>).map((row) => row.id);
}

/**
 * Select a video into a Library, or update the selection already there.
 *
 * Inline placement is written in the same statement as the selection so a video
 * is never briefly monitored with no destination. The partial unique index
 * rejects a second occupant of the same Plex role outright; callers decide the
 * winner before calling, they do not discover it here.
 */
export function selectLibraryVideo(
  db: Database.Database,
  input: LibraryVideoSelection,
): number {
  const inline = input.placement.mode === "inline" ? input.placement : null;
  const row = db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, preferred_offer_key, selection_mode,
      placement_mode, placement_library_id, inline_track_id, inline_slot,
      placement_selection_mode, reason, selected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(library_id, video_recording_id) DO UPDATE SET
      preferred_offer_key = excluded.preferred_offer_key,
      selection_mode = excluded.selection_mode,
      placement_mode = excluded.placement_mode,
      placement_library_id = excluded.placement_library_id,
      inline_track_id = excluded.inline_track_id,
      inline_slot = excluded.inline_slot,
      placement_selection_mode = excluded.placement_selection_mode,
      reason = excluded.reason,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `).get(
    input.libraryId,
    input.videoRecordingId,
    input.preferredOfferKey ?? null,
    input.selectionMode ?? "auto",
    input.placement.mode,
    inline?.placementLibraryId ?? null,
    inline?.inlineTrackId ?? null,
    inline?.inlineSlot ?? null,
    input.placementSelectionMode ?? "auto",
    input.reason ?? null,
  ) as { id: number };
  return row.id;
}

/**
 * Stop monitoring a video in a Library.
 *
 * Its canonical Recording and every provider match survive: an unselected video
 * is still a video the user can see and choose later, which is the whole reason
 * candidates and selections are separate tables.
 */
export function unselectLibraryVideo(
  db: Database.Database,
  libraryId: number,
  videoRecordingId: number,
): boolean {
  return db.prepare(`
    DELETE FROM LibraryVideos WHERE library_id = ? AND video_recording_id = ?
  `).run(libraryId, videoRecordingId).changes > 0;
}

/** True when any enabled Video Library has selected this video. */
export function isVideoMonitored(db: Database.Database, videoRecordingId: number): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM LibraryVideos selected
    JOIN Libraries library ON library.id = selected.library_id AND library.enabled = 1
    WHERE selected.video_recording_id = ?
    LIMIT 1
  `).get(videoRecordingId));
}

/**
 * SQL fragment: this canonical video Recording is selected by some enabled
 * Library. Row existence, and nothing else, is the monitoring statement.
 */
export function monitoredVideoPredicate(recordingIdExpr: string): string {
  return `EXISTS (
    SELECT 1
    FROM LibraryVideos selected_video
    JOIN Libraries selected_video_library
      ON selected_video_library.id = selected_video.library_id
     AND selected_video_library.enabled = 1
    WHERE selected_video.video_recording_id = ${recordingIdExpr}
  )`;
}

/** The persisted placement of one selected video, or null when unselected. */
export function videoPlacement(
  db: Database.Database,
  libraryId: number,
  videoRecordingId: number,
): VideoPlacement | null {
  const row = db.prepare(`
    SELECT placement_mode, placement_library_id, inline_track_id, inline_slot
    FROM LibraryVideos
    WHERE library_id = ? AND video_recording_id = ?
  `).get(libraryId, videoRecordingId) as {
    placement_mode: "separated" | "inline";
    placement_library_id: number | null;
    inline_track_id: number | null;
    inline_slot: "video" | "lyrics" | null;
  } | undefined;
  if (!row) return null;
  if (row.placement_mode === "separated") return { mode: "separated" };
  return {
    mode: "inline",
    placementLibraryId: row.placement_library_id!,
    inlineTrackId: row.inline_track_id!,
    inlineSlot: row.inline_slot!,
  };
}
