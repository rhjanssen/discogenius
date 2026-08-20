import type Database from "better-sqlite3";
import { audioLibraryPredicate } from "./library-album-monitoring.js";
import { canonicalVideoType, inlineVideoSlot } from "./canonical-video-type.js";

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
      selection_mode = CASE
        WHEN LibraryVideos.selection_mode = 'manual'
         AND excluded.selection_mode IS NOT 'manual'
        THEN LibraryVideos.selection_mode
        ELSE excluded.selection_mode
      END,
      placement_mode = CASE
        WHEN LibraryVideos.placement_selection_mode = 'manual'
         AND excluded.placement_selection_mode IS NOT 'manual'
        THEN LibraryVideos.placement_mode
        ELSE excluded.placement_mode
      END,
      placement_library_id = CASE
        WHEN LibraryVideos.placement_selection_mode = 'manual'
         AND excluded.placement_selection_mode IS NOT 'manual'
        THEN LibraryVideos.placement_library_id
        ELSE excluded.placement_library_id
      END,
      inline_track_id = CASE
        WHEN LibraryVideos.placement_selection_mode = 'manual'
         AND excluded.placement_selection_mode IS NOT 'manual'
        THEN LibraryVideos.inline_track_id
        ELSE excluded.inline_track_id
      END,
      inline_slot = CASE
        WHEN LibraryVideos.placement_selection_mode = 'manual'
         AND excluded.placement_selection_mode IS NOT 'manual'
        THEN LibraryVideos.inline_slot
        ELSE excluded.inline_slot
      END,
      placement_selection_mode = CASE
        WHEN LibraryVideos.placement_selection_mode = 'manual'
         AND excluded.placement_selection_mode IS NOT 'manual'
        THEN LibraryVideos.placement_selection_mode
        ELSE excluded.placement_selection_mode
      END,
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

/**
 * SQL fragment: some enabled Library selected this video *by hand*.
 *
 * A video has no separate lock column. "The user chose this one" is a manual
 * selection, and that is what stops curation reconsidering it — the same
 * distinction `LibraryAlbums.locked` draws for albums.
 */
export function manuallySelectedVideoPredicate(recordingIdExpr: string): string {
  return `EXISTS (
    SELECT 1
    FROM LibraryVideos selected_video
    JOIN Libraries selected_video_library
      ON selected_video_library.id = selected_video.library_id
     AND selected_video_library.enabled = 1
    WHERE selected_video.video_recording_id = ${recordingIdExpr}
      AND selected_video.selection_mode = 'manual'
  )`;
}

export type RelatedInlineTrack = {
  id: number;
  title: string;
  albumTitle: string | null;
  trackNumber: number | null;
  volumeNumber: number | null;
};

/** User-facing placement / keep failures. Mapped to HTTP 400 by the video route. */
export class VideoPlacementError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "VideoPlacementError";
  }
}

function resolveStereoPlacementLibraryId(db: Database.Database): number | null {
  const row = db.prepare(`
    SELECT library.id
    FROM Libraries library
    JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
    WHERE library.enabled = 1
      AND ${audioLibraryPredicate("library")}
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      )
    ORDER BY library.id
  `).get() as { id?: number } | undefined;
  return row?.id ?? null;
}

/**
 * Audio tracks this video may sit beside. Exact recording relations only —
 * the same rule association uses, so a live cut never offers a studio track.
 */
export function listRelatedInlineTracks(
  db: Database.Database,
  videoRecordingId: number,
): RelatedInlineTrack[] {
  return db.prepare(`
    SELECT
      track.id AS id,
      COALESCE(NULLIF(TRIM(track.title), ''), audio.title) AS title,
      album.title AS albumTitle,
      track.position AS trackNumber,
      track.medium_position AS volumeNumber
    FROM RecordingRelations relation
    JOIN Recordings audio
      ON audio.id = relation.target_recording_id
     AND audio.is_video = 0
    JOIN Tracks track ON track.recording_id = audio.id
    JOIN AlbumEditions edition ON edition.id = track.album_edition_id
    JOIN Albums album ON album.id = edition.release_group_id
    JOIN LibraryEditions library_release
      ON library_release.edition_id = edition.id
    JOIN Libraries library
      ON library.id = library_release.library_id
     AND library.enabled = 1
    WHERE relation.source_recording_id = ?
      AND relation.relation_type IN ('provider_video_for', 'music_video_for')
    GROUP BY track.id
    ORDER BY album.title COLLATE NOCASE, track.medium_position, track.position, track.id
  `).all(videoRecordingId) as RelatedInlineTrack[];
}

/** One audio track by id — used so a persisted inline placement still labels the File location menu. */
export function describeRelatedInlineTrack(
  db: Database.Database,
  trackId: number,
): RelatedInlineTrack | null {
  if (!Number.isInteger(trackId) || trackId <= 0) {
    return null;
  }
  const row = db.prepare(`
    SELECT
      track.id AS id,
      COALESCE(NULLIF(TRIM(track.title), ''), recording.title) AS title,
      album.title AS albumTitle,
      track.position AS trackNumber,
      track.medium_position AS volumeNumber
    FROM Tracks track
    JOIN Recordings recording ON recording.id = track.recording_id
    JOIN AlbumEditions edition ON edition.id = track.album_edition_id
    JOIN Albums album ON album.id = edition.release_group_id
    WHERE track.id = ?
  `).get(trackId) as RelatedInlineTrack | undefined;
  return row ?? null;
}

/**
 * Exact related tracks, plus the currently placed inline track when it is
 * missing from that list (auto placement can use edition co-membership).
 */
export function relatedTracksForVideoDetail(
  db: Database.Database,
  videoRecordingId: number,
  inlineTrackId: number | null | undefined,
): RelatedInlineTrack[] {
  const related = listRelatedInlineTracks(db, videoRecordingId);
  if (inlineTrackId == null || related.some((track) => track.id === inlineTrackId)) {
    return related;
  }
  const current = describeRelatedInlineTrack(db, inlineTrackId);
  return current ? [current, ...related] : related;
}

/**
 * The user placing a video. Selects it if needed, stamps both selection and
 * placement as manual so curation will not move it, and returns whether a
 * library file should be renamed to follow.
 */
export function applyManualVideoPlacement(
  db: Database.Database,
  videoRecordingId: number,
  input: { mode: "separated" } | { mode: "inline"; inlineTrackId: number },
): { artistId: string | null } {
  const videoLibraryIds = resolveVideoLibraryIds(db);
  if (videoLibraryIds.length === 0) {
    throw new VideoPlacementError("No Video Library is enabled");
  }

  const recording = db.prepare(`
    SELECT id, artist_mbid, video_variant
    FROM Recordings
    WHERE id = ? AND is_video = 1
  `).get(videoRecordingId) as {
    id: number;
    artist_mbid: string | null;
    video_variant: string | null;
  } | undefined;
  if (!recording) {
    throw new VideoPlacementError("Video not found");
  }

  let placement: VideoPlacement;
  if (input.mode === "separated") {
    placement = { mode: "separated" };
  } else {
    const track = db.prepare(`
      SELECT id FROM Tracks WHERE id = ?
    `).get(input.inlineTrackId) as { id?: number } | undefined;
    if (!track?.id) {
      throw new VideoPlacementError("Inline track not found");
    }
    const placementLibraryId = resolveStereoPlacementLibraryId(db);
    if (placementLibraryId == null) {
      throw new VideoPlacementError("No stereo library is enabled for inline video placement");
    }
    placement = {
      mode: "inline",
      placementLibraryId,
      inlineTrackId: input.inlineTrackId,
      inlineSlot: inlineVideoSlot(canonicalVideoType(recording.video_variant)),
    };
  }

  const artist = recording.artist_mbid
    ? db.prepare(`SELECT id FROM Artists WHERE mbid = ? LIMIT 1`).get(recording.artist_mbid) as { id?: string } | undefined
    : undefined;

  for (const libraryId of videoLibraryIds) {
    selectLibraryVideo(db, {
      libraryId,
      videoRecordingId,
      placement,
      selectionMode: "manual",
      placementSelectionMode: "manual",
      reason: "user",
    });
  }

  return { artistId: artist?.id ? String(artist.id) : null };
}

/**
 * Keep this video selected even when it is not a Plex-slot winner
 * (`inline_only` losers). Selection is stamped manual so curation will not
 * drop it; placement is left as it is, or separated if it was never placed.
 */
export function keepLibraryVideo(
  db: Database.Database,
  videoRecordingId: number,
): void {
  const videoLibraryIds = resolveVideoLibraryIds(db);
  if (videoLibraryIds.length === 0) {
    throw new VideoPlacementError("No Video Library is enabled");
  }
  const recording = db.prepare(`
    SELECT id FROM Recordings WHERE id = ? AND is_video = 1
  `).get(videoRecordingId) as { id?: number } | undefined;
  if (!recording?.id) {
    throw new VideoPlacementError("Video not found");
  }

  for (const libraryId of videoLibraryIds) {
    const current = db.prepare(`
      SELECT placement_mode, placement_library_id, inline_track_id, inline_slot
      FROM LibraryVideos
      WHERE library_id = ? AND video_recording_id = ?
    `).get(libraryId, videoRecordingId) as {
      placement_mode?: string;
      placement_library_id?: number | null;
      inline_track_id?: number | null;
      inline_slot?: "video" | "lyrics" | null;
    } | undefined;
    const placement = current?.placement_mode === "inline"
      && current.placement_library_id != null
      && current.inline_track_id != null
      && (current.inline_slot === "video" || current.inline_slot === "lyrics")
      ? {
        mode: "inline" as const,
        placementLibraryId: current.placement_library_id,
        inlineTrackId: current.inline_track_id,
        inlineSlot: current.inline_slot,
      }
      : { mode: "separated" as const };
    selectLibraryVideo(db, {
      libraryId,
      videoRecordingId,
      placement,
      selectionMode: "manual",
      reason: "user",
    });
  }
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
