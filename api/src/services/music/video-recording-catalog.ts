/**
 * Video recording catalog identity: MusicBrainz mbid, YouTube watch id, or a
 * provider-catalog mint (Apple/TIDAL until a later MB/YT attach).
 *
 * youtube_video_id is a catalog key, not ProviderItems.provider_id.
 */

import { db } from "../../database.js";
import { parseProviderResourceIdentity } from "../metadata/provider-url-identity.js";

export const VIDEO_PROVIDER_CATALOG_STATUS = "provider_catalog";
export const VIDEO_YOUTUBE_CATALOG_STATUS = "youtube";

const YOUTUBE_WATCH_ID = /^[A-Za-z0-9_-]{11}$/u;

type VideoRecordingRow = {
  id: number;
  mbid: string | null;
  foreign_recording_id: string | null;
  youtube_video_id: string | null;
  metadata_status: string | null;
  artist_metadata_id: number | null;
  artist_mbid: string | null;
  title: string | null;
  artist_credit: string | null;
  length_ms: number | null;
  disambiguation: string | null;
  video_variant: string | null;
  release_date: string | null;
  cover_image_id: string | null;
  cover_image_url: string | null;
};

export function parseYouTubeWatchId(value?: string | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const fromUrl = parseProviderResourceIdentity(text);
  if (fromUrl?.provider === "youtube-music" && YOUTUBE_WATCH_ID.test(fromUrl.id)) {
    return fromUrl.id;
  }
  return YOUTUBE_WATCH_ID.test(text) ? text : null;
}

export function youtubeWatchIdFromVideoOffer(video: {
  provider?: string | null;
  _provider?: string | null;
  provider_id?: string | null;
  providerId?: string | null;
  url?: string | null;
}): string | null {
  const provider = String(video.provider || video._provider || "").trim().toLowerCase();
  const providerId = String(video.provider_id ?? video.providerId ?? "").trim();
  if (provider === "youtube-music" || provider === "youtube") {
    const fromId = parseYouTubeWatchId(providerId);
    if (fromId) return fromId;
  }
  return parseYouTubeWatchId(video.url ?? null);
}

export function findVideoRecordingByYouTubeWatchId(youtubeVideoId: string): number | null {
  const watchId = parseYouTubeWatchId(youtubeVideoId);
  if (!watchId) return null;
  const row = db.prepare(`
    SELECT id FROM Recordings
    WHERE is_video = 1 AND youtube_video_id = ?
    LIMIT 1
  `).get(watchId) as { id?: number } | undefined;
  return row?.id == null ? null : Number(row.id);
}

export function findVideoRecordingByMbid(mbid: string): number | null {
  const normalized = String(mbid || "").trim();
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT id FROM Recordings
    WHERE is_video = 1 AND (mbid = ? OR foreign_recording_id = ?)
    LIMIT 1
  `).get(normalized, normalized) as { id?: number } | undefined;
  return row?.id == null ? null : Number(row.id);
}

function loadVideoRecording(id: number): VideoRecordingRow | null {
  const row = db.prepare(`
    SELECT
      id, mbid, foreign_recording_id, youtube_video_id, metadata_status,
      artist_metadata_id, artist_mbid, title, artist_credit, length_ms,
      disambiguation, video_variant, release_date, cover_image_id, cover_image_url
    FROM Recordings
    WHERE id = ? AND is_video = 1
  `).get(id) as VideoRecordingRow | undefined;
  return row ?? null;
}

function catalogRank(row: VideoRecordingRow): number {
  if (row.mbid) return 2;
  if (row.youtube_video_id) return 1;
  return 0;
}

function chooseKeeper(left: VideoRecordingRow, right: VideoRecordingRow): {
  keeper: VideoRecordingRow;
  duplicate: VideoRecordingRow;
} {
  const leftRank = catalogRank(left);
  const rightRank = catalogRank(right);
  if (leftRank !== rightRank) {
    return leftRank >= rightRank
      ? { keeper: left, duplicate: right }
      : { keeper: right, duplicate: left };
  }
  return left.id <= right.id
    ? { keeper: left, duplicate: right }
    : { keeper: right, duplicate: left };
}

function statusAfterKeys(mbid: string | null, youtubeVideoId: string | null): string {
  if (mbid) return "musicbrainz";
  if (youtubeVideoId) return VIDEO_YOUTUBE_CATALOG_STATUS;
  return VIDEO_PROVIDER_CATALOG_STATUS;
}

export function coalesceVideoRecordings(leftId: number, rightId: number): number {
  if (leftId === rightId) return leftId;
  const left = loadVideoRecording(leftId);
  const right = loadVideoRecording(rightId);
  if (!left) return rightId;
  if (!right) return leftId;
  const { keeper, duplicate } = chooseKeeper(left, right);
  return mergeVideoRecordings(keeper.id, duplicate.id);
}

/**
 * Fold `duplicateId` into `keeperId`. Catalog keys, matches, files, and
 * library selections move; the duplicate row is deleted.
 */
export function mergeVideoRecordings(keeperId: number, duplicateId: number): number {
  if (keeperId === duplicateId) return keeperId;
  const keeper = loadVideoRecording(keeperId);
  const duplicate = loadVideoRecording(duplicateId);
  if (!keeper || !duplicate) {
    return keeper?.id ?? duplicate?.id ?? keeperId;
  }
  if (keeper.mbid && duplicate.mbid && keeper.mbid !== duplicate.mbid) {
    return keeper.id;
  }
  if (
    keeper.youtube_video_id
    && duplicate.youtube_video_id
    && keeper.youtube_video_id !== duplicate.youtube_video_id
  ) {
    return keeper.id;
  }

  const mbid = keeper.mbid || duplicate.mbid;
  const youtubeVideoId = keeper.youtube_video_id || duplicate.youtube_video_id;
  const foreignId = keeper.foreign_recording_id || duplicate.foreign_recording_id || mbid;
  const placeholderTitle = !keeper.title
    || !String(keeper.title).trim()
    || String(keeper.title).trim().toLowerCase() === "unknown video";

  db.prepare(`
    UPDATE Recordings
    SET mbid = NULL,
        youtube_video_id = NULL,
        foreign_recording_id = NULL,
        metadata_status = ?
    WHERE id = ?
  `).run(VIDEO_PROVIDER_CATALOG_STATUS, duplicate.id);

  db.prepare(`
    UPDATE Recordings
    SET
      mbid = COALESCE(mbid, ?),
      foreign_recording_id = COALESCE(foreign_recording_id, ?),
      youtube_video_id = COALESCE(youtube_video_id, ?),
      artist_metadata_id = COALESCE(artist_metadata_id, ?),
      artist_mbid = COALESCE(artist_mbid, ?),
      title = CASE WHEN ? = 1 THEN COALESCE(?, title) ELSE title END,
      artist_credit = COALESCE(artist_credit, ?),
      length_ms = COALESCE(length_ms, ?),
      disambiguation = COALESCE(disambiguation, ?),
      video_variant = CASE
        WHEN video_variant IS NULL OR TRIM(video_variant) = '' THEN ?
        ELSE video_variant
      END,
      release_date = COALESCE(release_date, ?),
      cover_image_id = COALESCE(cover_image_id, ?),
      cover_image_url = COALESCE(cover_image_url, ?),
      metadata_status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    mbid,
    foreignId,
    youtubeVideoId,
    duplicate.artist_metadata_id,
    duplicate.artist_mbid,
    placeholderTitle ? 1 : 0,
    duplicate.title,
    duplicate.artist_credit,
    duplicate.length_ms,
    duplicate.disambiguation,
    duplicate.video_variant,
    duplicate.release_date,
    duplicate.cover_image_id,
    duplicate.cover_image_url,
    statusAfterKeys(mbid, youtubeVideoId),
    keeper.id,
  );

  // The same provider item can already have a rejected edge to the keeper and
  // an accepted edge to the duplicate. Preserve the stronger decision before
  // collapsing the unique (provider item, recording) pair. The old code kept
  // whichever row happened to belong to the keeper, which could silently turn
  // a valid accepted offer into a rejected one.
  db.prepare(`
    DELETE FROM ProviderVideoMatches
    WHERE id IN (
      SELECT keeper_match.id
      FROM ProviderVideoMatches keeper_match
      JOIN ProviderVideoMatches duplicate_match
        ON duplicate_match.provider_video_item_id = keeper_match.provider_video_item_id
       AND duplicate_match.recording_id = ?
      WHERE keeper_match.recording_id = ?
        AND (
          (CASE duplicate_match.match_state
             WHEN 'accepted' THEN 8
             WHEN 'ambiguous' THEN 6
             WHEN 'candidate' THEN 4
             ELSE 2
           END + CASE duplicate_match.decision_source WHEN 'manual' THEN 1 ELSE 0 END)
          >
          (CASE keeper_match.match_state
             WHEN 'accepted' THEN 8
             WHEN 'ambiguous' THEN 6
             WHEN 'candidate' THEN 4
             ELSE 2
           END + CASE keeper_match.decision_source WHEN 'manual' THEN 1 ELSE 0 END)
        )
    )
  `).run(duplicate.id, keeper.id);
  db.prepare(`
    DELETE FROM ProviderVideoMatches
    WHERE recording_id = ?
      AND provider_video_item_id IN (
        SELECT provider_video_item_id FROM ProviderVideoMatches WHERE recording_id = ?
      )
  `).run(duplicate.id, keeper.id);
  db.prepare(`
    UPDATE ProviderVideoMatches SET recording_id = ? WHERE recording_id = ?
  `).run(keeper.id, duplicate.id);

  db.prepare(`
    INSERT OR IGNORE INTO RecordingRelations (
      source_recording_id, target_recording_id, source_foreign_recording_id,
      target_foreign_recording_id, relation_type, foreign_relation_type_id,
      source, confidence, data, updated_at
    )
    SELECT
      CASE WHEN source_recording_id = ? THEN ? ELSE source_recording_id END,
      CASE WHEN target_recording_id = ? THEN ? ELSE target_recording_id END,
      source_foreign_recording_id, target_foreign_recording_id, relation_type,
      foreign_relation_type_id, source, confidence, data, CURRENT_TIMESTAMP
    FROM RecordingRelations
    WHERE source_recording_id = ? OR target_recording_id = ?
  `).run(duplicate.id, keeper.id, duplicate.id, keeper.id, duplicate.id, duplicate.id);

  db.prepare(`
    UPDATE TrackFiles
    SET recording_id = ?,
        canonical_recording_mbid = COALESCE(?, canonical_recording_mbid)
    WHERE recording_id = ?
  `).run(keeper.id, mbid, duplicate.id);

  db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, preferred_offer_key, selection_mode,
      placement_mode, placement_library_id, inline_track_id, inline_slot,
      placement_selection_mode, reason, selected_at, updated_at
    )
    SELECT
      merged.library_id, ?, merged.preferred_offer_key, merged.selection_mode,
      'separated', NULL, NULL, NULL,
      merged.placement_selection_mode, merged.reason, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM LibraryVideos merged
    WHERE merged.video_recording_id = ?
    ON CONFLICT(library_id, video_recording_id) DO NOTHING
  `).run(keeper.id, duplicate.id);

  db.prepare(`DELETE FROM Recordings WHERE id = ?`).run(duplicate.id);
  return keeper.id;
}

export function claimYouTubeWatchId(recordingId: number, youtubeVideoId: string | null | undefined): number {
  const watchId = parseYouTubeWatchId(youtubeVideoId ?? null);
  if (!watchId) return recordingId;
  const existing = findVideoRecordingByYouTubeWatchId(watchId);
  if (existing != null && existing !== recordingId) {
    return coalesceVideoRecordings(recordingId, existing);
  }
  const row = loadVideoRecording(recordingId);
  if (!row) return recordingId;
  if (row.youtube_video_id && row.youtube_video_id !== watchId) {
    return recordingId;
  }
  db.prepare(`
    UPDATE Recordings
    SET youtube_video_id = ?,
        metadata_status = CASE WHEN mbid IS NOT NULL THEN metadata_status ELSE ? END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND is_video = 1 AND youtube_video_id IS NULL
  `).run(watchId, VIDEO_YOUTUBE_CATALOG_STATUS, recordingId);
  return recordingId;
}

export function claimRecordingMbid(recordingId: number, mbid: string | null | undefined): number {
  const normalized = String(mbid || "").trim();
  if (!normalized) return recordingId;
  const existing = findVideoRecordingByMbid(normalized);
  if (existing != null && existing !== recordingId) {
    return coalesceVideoRecordings(recordingId, existing);
  }
  const row = loadVideoRecording(recordingId);
  if (!row) return recordingId;
  if (row.mbid && row.mbid !== normalized) {
    return recordingId;
  }
  db.prepare(`
    UPDATE Recordings
    SET mbid = ?,
        foreign_recording_id = COALESCE(foreign_recording_id, ?),
        metadata_status = 'musicbrainz',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND is_video = 1 AND mbid IS NULL
  `).run(normalized, normalized, recordingId);
  return recordingId;
}

export function mintVideoRecording(input: {
  artistMbid?: string | null;
  artistMetadataId?: number | null;
  title: string;
  artistCredit?: string | null;
  lengthMs?: number | null;
  videoVariant?: string | null;
  youtubeVideoId?: string | null;
  releaseDate?: string | null;
  coverImageId?: string | null;
}): number {
  const youtubeVideoId = parseYouTubeWatchId(input.youtubeVideoId ?? null);
  if (youtubeVideoId) {
    const existing = findVideoRecordingByYouTubeWatchId(youtubeVideoId);
    if (existing != null) return existing;
  }
  const title = String(input.title || "").trim() || "Unknown Video";
  const metadataStatus = youtubeVideoId ? VIDEO_YOUTUBE_CATALOG_STATUS : VIDEO_PROVIDER_CATALOG_STATUS;
  const row = db.prepare(`
    INSERT INTO Recordings (
      artist_metadata_id, artist_mbid, title, artist_credit, length_ms,
      is_video, video_variant, metadata_status, youtube_video_id, release_date,
      cover_image_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    RETURNING id
  `).get(
    input.artistMetadataId ?? null,
    input.artistMbid ?? null,
    title,
    input.artistCredit ?? null,
    input.lengthMs ?? null,
    input.videoVariant ?? null,
    metadataStatus,
    youtubeVideoId,
    input.releaseDate ?? null,
    input.coverImageId ?? null,
  ) as { id: number };
  return Number(row.id);
}
