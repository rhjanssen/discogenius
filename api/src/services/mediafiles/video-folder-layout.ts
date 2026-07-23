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
 * on a release group whose stereo slot is monitored (same gate as path compute).
 */
export function canVideoPlaceInline(videoRecordingId: string | number | null | undefined): boolean {
  const recordingId = String(videoRecordingId ?? "").trim();
  if (!recordingId) return false;

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
    LEFT JOIN AlbumReleases track_rg
      ON track_rg.id = t.album_release_id
      OR (t.release_mbid IS NOT NULL AND track_rg.mbid = t.release_mbid)
    LEFT JOIN Albums album
      ON album.mbid = COALESCE(tf.canonical_release_group_mbid, track_rg.release_group_mbid)
    WHERE CAST(rr.source_recording_id AS TEXT) = CAST(? AS TEXT)
      AND rr.relation_type = 'provider_video_for'
      AND (
        COALESCE(NULLIF(TRIM(video.video_variant), ''), 'video') NOT IN ('video', 'official')
        OR (
          LOWER(COALESCE(audio.title, '')) NOT LIKE '%live%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%performance%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%mtv unplugged%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%jools holland%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%hootenanny%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%porchester%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%mercury prize%'
          AND LOWER(COALESCE(audio.title, '')) NOT LIKE '%pete mitchell%'
          AND NOT (
            LOWER(COALESCE(audio.title, '')) LIKE '%later%'
            AND LOWER(COALESCE(audio.title, '')) LIKE '%jools%'
          )
        )
      )
      AND EXISTS (
        SELECT 1
        FROM ReleaseGroupSlots rgs
        WHERE rgs.release_group_mbid = COALESCE(tf.canonical_release_group_mbid, track_rg.release_group_mbid)
          AND rgs.slot = 'stereo'
          AND rgs.monitored = 1
      )
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(album.secondary_types, '')) LIKE '%"live"%' THEN 3
        WHEN LOWER(COALESCE(album.secondary_types, '')) LIKE '%"compilation"%' THEN 2
        WHEN LOWER(COALESCE(album.primary_type, '')) IN ('album', 'ep', 'single') THEN 0
        ELSE 1
      END ASC,
      COALESCE(track_rg.track_count, 0) DESC,
      rr.confidence DESC, tf.id ASC, t.position ASC, rr.id ASC
    LIMIT 1
  `).get(recordingId) as { ok?: number } | undefined;

  return Boolean(row?.ok);
}
