import { db } from "../../database.js";

/**
 * The one place that answers "where does this video's file go?".
 *
 * Every consumer used to derive this independently — download, import
 * finalisation, the organizer, expected-path, rename preview, rename apply, the
 * library scan, relinking — each running its own relation query with its own
 * ranking. Independent derivations of the same decision do not stay equal: a
 * rename would compute one album and a scan another, and the video ended up
 * duplicated across both.
 *
 * Curation decides once, writes it to `LibraryVideos`, and everything else
 * reads it here. Recomputation is curation's job and happens when monitoring
 * changes, not on every file operation.
 */

export interface PersistedVideoPlacement {
  libraryId: number;
  mode: "separated" | "inline";
  /** The audio library receiving an inline file. */
  placementLibraryId: number | null;
  /** The exact canonical audio Track occurrence an inline file sits beside. */
  inlineTrackId: number | null;
  inlineSlot: "video" | "lyrics" | null;
  /** The audio Recording that Track carries — what the inline file is named after. */
  inlineAudioRecordingId: number | null;
}

/**
 * The stored placement for a canonical video, or null when no Library has
 * selected it.
 *
 * Null means "not selected", which is different from "separated": an unselected
 * video has no destination at all because nothing is going to fetch it.
 */
export function resolvePersistedVideoPlacement(
  videoRecordingId: number | string | null | undefined,
): PersistedVideoPlacement | null {
  const recordingId = String(videoRecordingId ?? "").trim();
  if (!recordingId) return null;

  const row = db.prepare(`
    SELECT
      selected.library_id,
      selected.placement_mode,
      selected.placement_library_id,
      selected.inline_track_id,
      selected.inline_slot,
      track.recording_id AS inline_audio_recording_id
    FROM LibraryVideos selected
    JOIN Libraries library
      ON library.id = selected.library_id AND library.enabled = 1
    LEFT JOIN Tracks track ON track.id = selected.inline_track_id
    WHERE CAST(selected.video_recording_id AS TEXT) = CAST(? AS TEXT)
    -- An inline placement is the more specific answer, so it wins when a video
    -- is somehow selected by two libraries; ids break any remaining tie.
    ORDER BY CASE selected.placement_mode WHEN 'inline' THEN 0 ELSE 1 END,
             selected.library_id
    LIMIT 1
  `).get(recordingId) as {
    library_id: number;
    placement_mode: "separated" | "inline";
    placement_library_id: number | null;
    inline_track_id: number | null;
    inline_slot: "video" | "lyrics" | null;
    inline_audio_recording_id: number | null;
  } | undefined;
  if (!row) return null;

  return {
    libraryId: row.library_id,
    mode: row.placement_mode,
    placementLibraryId: row.placement_library_id,
    inlineTrackId: row.inline_track_id,
    inlineSlot: row.inline_slot,
    inlineAudioRecordingId: row.inline_audio_recording_id,
  };
}

/**
 * Whether this video's file belongs beside an audio track right now.
 *
 * Reads the stored decision rather than re-deriving it, so a caller cannot
 * disagree with the organizer about where the same file lives.
 */
export function videoIsPlacedInline(
  videoRecordingId: number | string | null | undefined,
): boolean {
  return resolvePersistedVideoPlacement(videoRecordingId)?.mode === "inline";
}
