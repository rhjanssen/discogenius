/**
 * Video library placement modes (Settings → Naming → Video Folder Layout).
 *
 * - separated: always the dedicated video library
 * - inline: beside stereo tracks when provider_video_for + monitored stereo RG;
 *   otherwise separated
 * - inline_only: same placement as inline, but download-missing skips videos that
 *   would only land in the separated library (no album link / unmonitored stereo)
 */

import { db } from "../../database.js";
import { mainVideoMayFollowAudioRelationSql } from "../music/live-performance-markers.js";
import { VIDEO_ALBUM_ASSOCIATION_KIND_SQL } from "../music/video-album-association.js";

export type VideoFolderLayout = "separated" | "inline" | "inline_only";

export function normalizeVideoFolderLayout(
  value: string | null | undefined,
): VideoFolderLayout {
  if (value === "inline" || value === "inline_only") return value;
  return "separated";
}

/** True when layout may place linked videos beside stereo audio. */
export function allowsInlineVideoPlacement(
  layout: string | null | undefined,
): boolean {
  const normalized = normalizeVideoFolderLayout(layout);
  return normalized === "inline" || normalized === "inline_only";
}

/** True when automation must skip videos that cannot place inline. */
export function requiresAlbumLinkedVideosOnly(
  layout: string | null | undefined,
): boolean {
  return normalizeVideoFolderLayout(layout) === "inline_only";
}

/**
 * Whether a video recording can place inline today: provider_video_for → audio
 * on a release group monitored by an enabled nonspatial library.
 */
export function canVideoPlaceInline(videoRecordingId: string | number | null | undefined): boolean {
  const recordingId = String(videoRecordingId ?? "").trim();
  if (!recordingId) return false;

  const mayFollowAudio = mainVideoMayFollowAudioRelationSql({
    videoVariantExpr: "video.video_variant",
    trackTitleExpr: "audio.title",
    albumTitleExpr: "album.title",
    albumSecondaryExpr: "album.secondary_types",
  });
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM RecordingRelations rr
    JOIN Recordings audio ON audio.id = rr.target_recording_id
    JOIN Recordings video ON video.id = rr.source_recording_id
    LEFT JOIN TrackFiles tf
      ON tf.recording_id = rr.target_recording_id
     AND tf.file_type = 'track'
     AND tf.library_slot = 'stereo'
    LEFT JOIN Tracks t
      ON (t.recording_id = audio.id OR (audio.mbid IS NOT NULL AND t.recording_mbid = audio.mbid))
    LEFT JOIN AlbumEditions track_rg
      ON track_rg.id = t.album_edition_id
      OR (t.edition_mbid IS NOT NULL AND track_rg.mbid = t.edition_mbid)
    LEFT JOIN Albums album
      ON album.mbid = COALESCE(tf.canonical_release_group_mbid, track_rg.release_group_mbid)
    WHERE CAST(rr.source_recording_id AS TEXT) = CAST(? AS TEXT)
      AND rr.relation_type = 'provider_video_for'
      AND ${mayFollowAudio}
      AND EXISTS (
        SELECT 1
        FROM LibraryAlbums library_group
        JOIN Libraries library
          ON library.id = library_group.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        WHERE library_group.release_group_id = album.id
          AND library_group.monitored = 1
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          )
      )
    ORDER BY
      ${VIDEO_ALBUM_ASSOCIATION_KIND_SQL.replace(/\ba\./g, "album.")} ASC,
      COALESCE(track_rg.track_count, 0) DESC,
      rr.confidence DESC, tf.id ASC, t.position ASC, rr.id ASC
    LIMIT 1
  `).get(recordingId) as { ok?: number } | undefined;

  return Boolean(row?.ok);
}
