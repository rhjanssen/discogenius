import { db } from "../../database.js";
import type { VideoContract, VideosListResponseContract } from "../../contracts/catalog.js";
import type {
  AlbumAssociatedVideoContract,
  VideoAlbumRefContract,
  VideoDetailContract,
  VideoProviderOfferContract,
} from "../../contracts/media.js";
import { streamingProviderManager } from "../providers/index.js";
import { videoCoverLocalUrl, albumCoverLocalUrl, imageContainerFromImagesColumn } from "../metadata/media-cover-service.js";
import { compareVideoOffersByQualityThenProvider } from "./video-offer-resolver.js";
import { getConfigSection } from "../config/config.js";
import { isVideoVariantDownloadAllowed } from "./video-type-filter.js";
import { VIDEO_ALBUM_ASSOCIATION_KIND_SQL } from "./video-album-association.js";
import { mainVideoMayFollowAudioRelationSql } from "./live-performance-markers.js";

type SortableVideoField = "name" | "popularity" | "scannedAt" | "releaseDate";

type VideoRow = {
  id: number | string;
  title: string;
  duration: number;
  release_date?: string | null;
  version?: string | null;
  video_variant?: string | null;
  explicit?: number | boolean | null;
  quality?: string | null;
  current_quality?: string | null;
  provider?: string | null;
  provider_id?: string | null;


  cover?: string | null;
  cover_art_url?: string | null;
  url?: string | null;
  path?: string | null;
  artist_id: number | string;
  artist_name?: string | null;
  monitored?: number | boolean | null;
  monitored_lock?: number | boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_scanned?: string | null;
  popularity?: number | null;
};

type GroupedVideoOfferRow = {
  recording_id: string;
  provider: string;
  provider_id: string;
  quality: string | null;
  url: string | null;
};

export interface ListVideosQuery {
  limit: number;
  offset: number;
  search?: string;
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
  provider?: string;
  sort?: string;
  dir?: string;
}

function normalizeSortDirection(value: string | undefined): "ASC" | "DESC" {
  return String(value || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function normalizeSortField(value: string | undefined): SortableVideoField {
  switch (value) {
    case "name":
    case "popularity":
    case "scannedAt":
    case "releaseDate":
      return value;
    default:
      return "releaseDate";
  }
}

function mapVideoRow(
  row: VideoRow,
  isDownloaded: boolean,
  groupedOffers: GroupedVideoOfferRow[] = [],
  preferredProvider?: string,
): VideoContract {
  // UI cover fields are always the local /media-cover URL — never raw provider UUIDs.
  const coverArtUrl = videoCoverLocalUrl(row.id, row.cover_art_url);
  const normalizedPreferredProvider = String(preferredProvider || "").trim();
  const preferredOffer = groupedOffers.find((offer) => offer.provider === normalizedPreferredProvider)
    ?? groupedOffers[0];
  return {
    id: String(row.id),
    title: row.title,
    duration: Number(row.duration || 0),
    release_date: row.release_date ?? null,
    version: row.version ?? null,
    explicit: row.explicit === undefined || row.explicit === null ? undefined : Boolean(row.explicit),
    quality: preferredOffer?.quality || row.current_quality || row.quality || null,
    provider: preferredOffer?.provider || row.provider || null,
    provider_id: preferredOffer?.provider_id || row.provider_id || null,
    providers: [...new Set(groupedOffers.map((offer) => offer.provider))],
    provider_offers: groupedOffers.map((offer) => ({
      provider: offer.provider,
      provider_id: offer.provider_id,
      quality: offer.quality,
      url: offer.url,
    })),
    cover: coverArtUrl,
    cover_id: coverArtUrl,
    cover_art_url: coverArtUrl,
    url: preferredOffer?.url || row.url || null,
    path: row.path ?? null,
    artist_id: String(row.artist_id),
    artist_name: row.artist_name ?? undefined,
    is_monitored: Boolean(row.monitored),
    monitored_lock: Boolean(row.monitored_lock),
    downloaded: isDownloaded,
    is_downloaded: isDownloaded,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  };
}

function mapVideoDetail(row: VideoRow, isDownloaded: boolean): VideoDetailContract {
  const mapped = mapVideoRow(row, isDownloaded);
  const variant = String(row.video_variant || "").trim().toLowerCase() || "video";

  return {
    id: mapped.id,
    title: mapped.title,
    duration: mapped.duration,
    artist_id: mapped.artist_id,
    artist_name: mapped.artist_name,
    release_date: mapped.release_date,
    version: mapped.version,
    video_variant: variant,
    explicit: mapped.explicit,
    quality: mapped.quality,
    cover: mapped.cover,
    cover_id: mapped.cover_id,
    cover_art_url: mapped.cover_art_url,
    is_monitored: mapped.is_monitored,
    monitored_lock: mapped.monitored_lock,
    downloaded: mapped.downloaded ?? false,
    is_downloaded: mapped.is_downloaded,
  };
}

/**
 * Prefer a real recording/provider title over the "Unknown Video" placeholder.
 * Provider refresh can leave Recordings.title stuck on the placeholder while
 * ProviderItems.title was later filled — artist cards and the video page must
 * agree on the same display title.
 */
const VIDEO_DISPLAY_TITLE_SQL = `
  CASE
    WHEN recording.title IS NOT NULL
      AND TRIM(recording.title) != ''
      AND LOWER(TRIM(recording.title)) != 'unknown video'
    THEN recording.title
    ELSE COALESCE(
      NULLIF(TRIM(provider_item.title), ''),
      NULLIF(TRIM(recording.title), ''),
      'Unknown Video'
    )
  END
`;

function getCanonicalVideoSelectSql(whereClause: string): string {
  return `
    SELECT
      CAST(recording.id AS TEXT) AS id,
      ${VIDEO_DISPLAY_TITLE_SQL} AS title,
      COALESCE(
        CASE
          WHEN COALESCE(recording.length_ms, 0) > 0
          THEN CAST(ROUND(recording.length_ms / 1000.0) AS INT)
          ELSE NULL
        END,
        CAST(ROUND(provider_item.duration_ms / 1000.0) AS INT),
        0
      ) AS duration,
      COALESCE(recording.release_date, provider_item.release_date) AS release_date,
      provider_item.version AS version,
      recording.video_variant AS video_variant,
      provider_item.explicit AS explicit,
      provider_item.video_quality AS quality,
      provider_item.video_quality AS current_quality,
      provider_item.provider AS provider,
      CAST(provider_item.provider_id AS TEXT) AS provider_id,
      COALESCE(recording.cover_image_id, provider_item.cover_id) AS cover,
      recording.cover_image_url AS cover_art_url,
      provider_item.provider_url AS url,
      NULL AS path,
      CAST(COALESCE(managed_artist.id, artist.mbid, recording.artist_mbid, recording.artist_metadata_id, artist.id) AS TEXT) AS artist_id,
      COALESCE(managed_artist.name, artist.name) AS artist_name,
      recording.monitored AS monitored,
      recording.monitored_lock AS monitored_lock,
      recording.updated_at AS created_at,
      recording.updated_at AS updated_at,
      recording.updated_at AS last_scanned,
      MAX(
        COALESCE(CAST(recording.popularity AS REAL), 0),
        COALESCE(CAST(provider_item.popularity AS REAL), 0)
      ) AS popularity,
      CASE WHEN EXISTS (
        SELECT 1
        FROM TrackFiles lf
        WHERE lf.file_type = 'video'
          AND (
            lf.recording_id = recording.id
            OR
            (recording.mbid IS NOT NULL AND lf.canonical_recording_mbid = recording.mbid)
            OR (
              provider_item.provider_id IS NOT NULL
              AND lf.provider = provider_item.provider
              AND CAST(lf.provider_id AS TEXT) = CAST(provider_item.provider_id AS TEXT)
            )
          )
      ) THEN 1 ELSE 0 END AS downloaded
    FROM Recordings recording
    LEFT JOIN ArtistMetadata artist
      ON artist.id = recording.artist_metadata_id
      OR (recording.artist_mbid IS NOT NULL AND artist.mbid = recording.artist_mbid)
    LEFT JOIN Artists managed_artist
      ON recording.artist_mbid IS NOT NULL
      AND managed_artist.mbid = recording.artist_mbid
    LEFT JOIN ProviderItems provider_item
      ON provider_item.id = (
        SELECT candidate.id
        FROM ProviderVideoMatches candidate_match
        JOIN ProviderItems candidate
          ON candidate.id = candidate_match.provider_video_item_id
        WHERE candidate_match.recording_id = recording.id
          AND candidate_match.match_state = 'accepted'
          AND candidate.entity_type = 'video'
          AND (
            candidate.availability IS NULL
            OR LOWER(CAST(candidate.availability AS TEXT))
               NOT IN ('0', 'false', 'unavailable', 'no', '')
          )
        ORDER BY
          CASE candidate_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          candidate_match.confidence DESC,
          candidate_match.updated_at DESC
        LIMIT 1
      )
    ${whereClause}
  `;
}

function buildCanonicalVideoWhere(input: ListVideosQuery): {
  whereClause: string;
  params: Array<string | number>;
} {
  const where: string[] = ["recording.is_video = 1"];
  const params: Array<string | number> = [];

  if (input.search) {
    const searchParam = `%${input.search}%`;
    where.push(`(
      recording.title LIKE ?
      OR recording.artist_metadata_id IN (
        SELECT search_artist.id FROM ArtistMetadata search_artist WHERE search_artist.name LIKE ?
      )
    )`);
    params.push(searchParam, searchParam);
  }

  if (input.monitored !== undefined) {
    where.push("recording.monitored = ?");
    params.push(input.monitored ? 1 : 0);
  }

  if (input.locked !== undefined) {
    where.push("recording.monitored_lock = ?");
    params.push(input.locked ? 1 : 0);
  }

  const providerFilter = String(input.provider || "").trim();
  if (providerFilter) {
    where.push(`recording.id IN (
      SELECT provider_match.recording_id
      FROM ProviderItems provider_filter
      JOIN ProviderVideoMatches provider_match
        ON provider_match.provider_video_item_id = provider_filter.id
       AND provider_match.match_state = 'accepted'
      WHERE provider_filter.entity_type = 'video'
        AND provider_filter.provider = ?
        AND (provider_filter.availability IS NULL
             OR LOWER(CAST(provider_filter.availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
    )`);
    params.push(providerFilter);
  }

  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function listCanonicalVideos(input: ListVideosQuery): VideosListResponseContract {
  const sort = normalizeSortField(input.sort);
  const dir = normalizeSortDirection(input.dir);
  const { whereClause, params } = buildCanonicalVideoWhere(input);
  const downloadedPredicate = input.downloaded === undefined ? "" : `
    AND ${input.downloaded ? "" : "NOT "}EXISTS (
      SELECT 1
      FROM TrackFiles candidate_file
      WHERE candidate_file.file_type = 'video'
        AND (
          candidate_file.recording_id = recording.id
          OR (
            recording.mbid IS NOT NULL
            AND candidate_file.canonical_recording_mbid = recording.mbid
          )
        )
    )
  `;
  const baseWhere = `${whereClause} ${downloadedPredicate}`;
  const candidateOrderBy = (() => {
    switch (sort) {
      case "name":
        return `ORDER BY recording.title ${dir}, recording.id ASC`;
      case "popularity":
        return `ORDER BY COALESCE(recording.popularity, 0) ${dir}, recording.id ASC`;
      case "scannedAt":
        return `ORDER BY (recording.updated_at IS NULL) ASC, recording.updated_at ${dir}, recording.id ASC`;
      case "releaseDate":
      default:
        return `ORDER BY (recording.release_date IS NULL) ASC, recording.release_date ${dir}, recording.id ASC`;
    }
  })();
  const candidates = db.prepare(`
    SELECT recording.id
    FROM Recordings recording
    ${baseWhere}
    ${candidateOrderBy}
    LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as Array<{ id: number }>;
  const candidateIds = candidates.map((candidate) => candidate.id);
  const candidateMarks = candidateIds.map(() => "?").join(", ");
  const detailRows = candidateIds.length === 0 ? [] : db.prepare(`
    SELECT *
    FROM (${getCanonicalVideoSelectSql(`WHERE recording.is_video = 1 AND recording.id IN (${candidateMarks})`)}) canonical_video
  `).all(...candidateIds) as (VideoRow & { downloaded?: number })[];
  const detailById = new Map(detailRows.map((row) => [Number(row.id), row]));
  const rows = candidates
    .map((candidate) => detailById.get(candidate.id))
    .filter((row): row is VideoRow & { downloaded?: number } => row != null);

  const countResult = db.prepare(`
    SELECT COUNT(*) AS total
    FROM Recordings recording
    ${baseWhere}
  `).get(...params) as { total: number };

  const offersByRecording = getGroupedVideoOfferRows(candidateIds.map(String));
  const items = rows.map((video) => mapVideoRow(
    video,
    Boolean(video.downloaded),
    offersByRecording.get(String(video.id)) || [],
    input.provider,
  ));

  return {
    items,
    total: countResult.total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + items.length < countResult.total,
  };
}

function getGroupedVideoOfferRows(recordingIds: string[]): Map<string, GroupedVideoOfferRow[]> {
  const result = new Map<string, GroupedVideoOfferRow[]>();
  if (recordingIds.length === 0) {
    return result;
  }

  const marks = recordingIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT CAST(video_match.recording_id AS TEXT) AS recording_id,
           pi.provider, CAST(pi.provider_id AS TEXT) AS provider_id, pi.video_quality AS quality,
           pi.provider_url AS url
    FROM ProviderItems pi
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = pi.id
     AND video_match.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
      AND video_match.recording_id IN (${marks})
      AND (pi.availability IS NULL
           OR LOWER(CAST(pi.availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
  `).all(...recordingIds) as GroupedVideoOfferRow[];

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.recording_id}\u0000${row.provider}\u0000${row.provider_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = result.get(row.recording_id) || [];
    bucket.push(row);
    result.set(row.recording_id, bucket);
  }
  for (const bucket of result.values()) {
    bucket.sort((left, right) => compareVideoOffersByQualityThenProvider(
      { provider: left.provider, quality: left.quality, provider_id: left.provider_id },
      { provider: right.provider, quality: right.quality, provider_id: right.provider_id },
    ));
  }
  return result;
}

export function listVideos(input: ListVideosQuery): VideosListResponseContract {
  return listCanonicalVideos(input);
}

export function getVideoDetail(videoId: string): VideoDetailContract | null {
  // Accept either a canonical video recording id (/video/196) or a provider
  // video id (/video/64660138). The download queue links by provider id, so
  // resolve that to the recording id first — otherwise the queue's video link
  // 404s while the same video opens fine from the artist page.
  const recordingId = resolveVideoRecordingId(videoId);
  if (!recordingId) {
    return null;
  }

  const canonicalRow = db.prepare(`
    SELECT *
    FROM (${getCanonicalVideoSelectSql("WHERE recording.is_video = 1 AND CAST(recording.id AS TEXT) = CAST(? AS TEXT)")}) canonical_video
  `).get(recordingId) as (VideoRow & { downloaded?: number }) | undefined;

  if (canonicalRow) {
    const detail = mapVideoDetail(canonicalRow, Boolean(canonicalRow.downloaded));
    detail.offers = getVideoProviderOffers(recordingId);
    detail.albums = getVideoAlbumRefs(recordingId);
    return detail;
  }

  return null;
}

function preferredLibraryReleaseMbidSql(releaseGroupIdExpression: string): string {
  return `(
    SELECT selected_release.mbid
    FROM LibraryEditions library_release
    JOIN AlbumEditions selected_release
      ON selected_release.id = library_release.edition_id
    JOIN LibraryAlbums library_group
      ON library_group.library_id = library_release.library_id
     AND library_group.release_group_id = selected_release.release_group_id
    JOIN Libraries library
      ON library.id = library_release.library_id
     AND library.enabled = 1
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    WHERE selected_release.release_group_id = ${releaseGroupIdExpression}
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      ) THEN 1 ELSE 0 END,
      library_group.monitored DESC,
      library_release.updated_at DESC,
      library_release.id DESC
    LIMIT 1
  )`;
}

/**
 * Videos associated with an album (release group) for album-page UX.
 *
 * Sources (unioned, de-duped by video recording id):
 *  1. `provider_video_for` / `music_video_for` from a video → audio recording
 *     that appears on this RG
 *  2. Video recordings that themselves appear as tracks on this RG
 *
 * Track position prefers the selected nonspatial library edition (then any
 * selected spatial edition), followed by the richest and earliest edition.
 */
export function getAlbumAssociatedVideos(releaseGroupMbid: string): AlbumAssociatedVideoContract[] {
  const rgMbid = String(releaseGroupMbid || "").trim();
  if (!rgMbid) return [];

  // Prefer the selected library release, then richest tracklist, then earliest
  // date — mirrors Appears On track pick order for a stable album-page label.
  const trackPickOrder = `
    CASE
      WHEN ar.mbid = ${preferredLibraryReleaseMbidSql("ar.release_group_id")} THEN 0
      ELSE 1
    END ASC,
    COALESCE(ar.track_count, 0) DESC,
    COALESCE(ar.media_count, 0) DESC,
    CASE WHEN ar.date IS NULL THEN 1 ELSE 0 END,
    ar.date ASC,
    t.medium_position ASC,
    t.position ASC
  `;

  const linkedViaRelation = db.prepare(`
    SELECT
      CAST(video.id AS TEXT) AS id,
      CASE
        WHEN video.title IS NOT NULL
          AND TRIM(video.title) != ''
          AND LOWER(TRIM(video.title)) != 'unknown video'
        THEN video.title
        ELSE COALESCE(
          NULLIF(TRIM(pi.title), ''),
          NULLIF(TRIM(video.title), ''),
          'Unknown Video'
        )
      END AS title,
      video.video_variant AS video_variant,
      video.release_date AS release_date,
      video.monitored AS monitored,
      video.monitored_lock AS monitored_lock,
      CASE WHEN pi.explicit IS NULL THEN NULL ELSE pi.explicit END AS explicit,
      pi.provider AS provider,
      pi.video_quality AS quality,
      CAST(pi.provider_id AS TEXT) AS provider_id,
      pi.provider_url AS provider_url,
      CASE WHEN EXISTS (
        SELECT 1 FROM TrackFiles lf
        WHERE lf.file_type = 'video'
          AND (
            lf.recording_id = video.id
            OR (video.mbid IS NOT NULL AND lf.canonical_recording_mbid = video.mbid)
            OR (
              pi.provider_id IS NOT NULL
              AND lf.provider = pi.provider
              AND CAST(lf.provider_id AS TEXT) = CAST(pi.provider_id AS TEXT)
            )
          )
      ) THEN 1 ELSE 0 END AS downloaded,
      (
        SELECT t.mbid
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = audio.id
            OR (audio.mbid IS NOT NULL AND t.recording_mbid = audio.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_mbid,
      (
        SELECT COALESCE(NULLIF(TRIM(t.title), ''), audio.title)
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = audio.id
            OR (audio.mbid IS NOT NULL AND t.recording_mbid = audio.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_title,
      (
        SELECT t.position
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = audio.id
            OR (audio.mbid IS NOT NULL AND t.recording_mbid = audio.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_number,
      (
        SELECT t.medium_position
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = audio.id
            OR (audio.mbid IS NOT NULL AND t.recording_mbid = audio.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS volume_number,
      audio.mbid AS audio_recording_mbid
    FROM RecordingRelations rr
    JOIN Recordings video ON video.id = rr.source_recording_id AND video.is_video = 1
    JOIN Recordings audio ON audio.id = rr.target_recording_id
    LEFT JOIN ProviderItems pi
      ON pi.id = (
        SELECT candidate.id
        FROM ProviderVideoMatches candidate_match
        JOIN ProviderItems candidate
          ON candidate.id = candidate_match.provider_video_item_id
        WHERE candidate_match.recording_id = video.id
          AND candidate_match.match_state = 'accepted'
          AND candidate.entity_type = 'video'
          AND (
            candidate.availability IS NULL
            OR LOWER(CAST(candidate.availability AS TEXT))
               NOT IN ('0', 'false', 'unavailable', 'no', '')
          )
        ORDER BY
          CASE candidate_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          candidate_match.confidence DESC,
          candidate_match.updated_at DESC
        LIMIT 1
      )
    WHERE rr.relation_type IN ('provider_video_for', 'music_video_for')
      AND EXISTS (
        SELECT 1
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = audio.id
            OR (audio.mbid IS NOT NULL AND t.recording_mbid = audio.mbid)
          )
      )
  `).all(rgMbid, rgMbid, rgMbid, rgMbid, rgMbid) as Array<{
    id: string;
    title: string;
    video_variant: string | null;
    release_date: string | null;
    monitored: number | boolean | null;
    monitored_lock: number | boolean | null;
    explicit: number | boolean | null;
    provider: string | null;
    quality: string | null;
    provider_id: string | null;
    provider_url: string | null;
    downloaded: number;
    track_mbid: string | null;
    track_title: string | null;
    track_number: number | null;
    volume_number: number | null;
    audio_recording_mbid: string | null;
  }>;

  const onAlbumVideoTracks = db.prepare(`
    SELECT
      CAST(video.id AS TEXT) AS id,
      CASE
        WHEN video.title IS NOT NULL
          AND TRIM(video.title) != ''
          AND LOWER(TRIM(video.title)) != 'unknown video'
        THEN video.title
        ELSE COALESCE(
          NULLIF(TRIM(pi.title), ''),
          NULLIF(TRIM(video.title), ''),
          'Unknown Video'
        )
      END AS title,
      video.video_variant AS video_variant,
      video.release_date AS release_date,
      video.monitored AS monitored,
      video.monitored_lock AS monitored_lock,
      CASE WHEN pi.explicit IS NULL THEN NULL ELSE pi.explicit END AS explicit,
      pi.provider AS provider,
      pi.video_quality AS quality,
      CAST(pi.provider_id AS TEXT) AS provider_id,
      pi.provider_url AS provider_url,
      CASE WHEN EXISTS (
        SELECT 1 FROM TrackFiles lf
        WHERE lf.file_type = 'video'
          AND (
            lf.recording_id = video.id
            OR (video.mbid IS NOT NULL AND lf.canonical_recording_mbid = video.mbid)
            OR (
              pi.provider_id IS NOT NULL
              AND lf.provider = pi.provider
              AND CAST(lf.provider_id AS TEXT) = CAST(pi.provider_id AS TEXT)
            )
          )
      ) THEN 1 ELSE 0 END AS downloaded,
      (
        SELECT t.mbid
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = video.id
            OR (video.mbid IS NOT NULL AND t.recording_mbid = video.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_mbid,
      (
        SELECT COALESCE(NULLIF(TRIM(t.title), ''), video.title)
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = video.id
            OR (video.mbid IS NOT NULL AND t.recording_mbid = video.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_title,
      (
        SELECT t.position
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = video.id
            OR (video.mbid IS NOT NULL AND t.recording_mbid = video.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_number,
      (
        SELECT t.medium_position
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = video.id
            OR (video.mbid IS NOT NULL AND t.recording_mbid = video.mbid)
          )
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS volume_number,
      CAST(NULL AS TEXT) AS audio_recording_mbid
    FROM Recordings video
    LEFT JOIN ProviderItems pi
      ON pi.id = (
        SELECT candidate.id
        FROM ProviderVideoMatches candidate_match
        JOIN ProviderItems candidate
          ON candidate.id = candidate_match.provider_video_item_id
        WHERE candidate_match.recording_id = video.id
          AND candidate_match.match_state = 'accepted'
          AND candidate.entity_type = 'video'
          AND (
            candidate.availability IS NULL
            OR LOWER(CAST(candidate.availability AS TEXT))
               NOT IN ('0', 'false', 'unavailable', 'no', '')
          )
        ORDER BY
          CASE candidate_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          candidate_match.confidence DESC,
          candidate_match.updated_at DESC
        LIMIT 1
      )
    WHERE video.is_video = 1
      AND EXISTS (
        SELECT 1
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = ?
          AND (
            t.recording_id = video.id
            OR (video.mbid IS NOT NULL AND t.recording_mbid = video.mbid)
          )
      )
  `).all(rgMbid, rgMbid, rgMbid, rgMbid, rgMbid) as Array<{
    id: string;
    title: string;
    video_variant: string | null;
    release_date: string | null;
    monitored: number | boolean | null;
    monitored_lock: number | boolean | null;
    explicit: number | boolean | null;
    provider: string | null;
    quality: string | null;
    provider_id: string | null;
    provider_url: string | null;
    downloaded: number;
    track_mbid: string | null;
    track_title: string | null;
    track_number: number | null;
    volume_number: number | null;
    audio_recording_mbid: string | null;
  }>;

  // Honor the same monitored + music-video-type gating the tracklist glyphs and
  // download automation use, so a video whose type is turned off in Settings
  // (e.g. lyric videos) or that curation has unmonitored no longer clutters the
  // album page. Anything already on disk stays visible — never hide a video the
  // user physically has downloaded.
  const filtering = getConfigSection("filtering");
  const byId = new Map<string, AlbumAssociatedVideoContract>();
  const upsert = (row: typeof linkedViaRelation[number]) => {
    const id = String(row.id);
    if (byId.has(id)) return;
    const isDownloaded = Boolean(row.downloaded);
    if (!isDownloaded) {
      if (!row.monitored) return;
      if (!isVideoVariantDownloadAllowed(row.video_variant, filtering)) return;
    }
    const coverArtUrl = videoCoverLocalUrl(id);
    byId.set(id, {
      id,
      title: row.title || "Unknown Video",
      cover: coverArtUrl,
      cover_id: coverArtUrl,
      cover_art_url: coverArtUrl,
      video_variant: row.video_variant ?? null,
      release_date: row.release_date ?? null,
      provider: row.provider ?? null,
      quality: row.quality ?? null,
      provider_id: row.provider_id ?? null,
      provider_url: row.provider_url ?? null,
      explicit: row.explicit == null ? undefined : Boolean(row.explicit),
      is_monitored: Boolean(row.monitored),
      monitored_lock: Boolean(row.monitored_lock),
      downloaded: Boolean(row.downloaded),
      is_downloaded: Boolean(row.downloaded),
      track_mbid: row.track_mbid ?? null,
      track_title: row.track_title ?? null,
      track_number: row.track_number == null ? null : Number(row.track_number),
      volume_number: row.volume_number == null ? null : Number(row.volume_number),
      audio_recording_mbid: row.audio_recording_mbid ?? null,
    });
  };

  // Relation-linked first (prefer audio-track affiliation), then on-RG video tracks.
  for (const row of linkedViaRelation) upsert(row);
  for (const row of onAlbumVideoTracks) upsert(row);

  // Album pages only show videos whose preferred association is this RG.
  // Studio OMVs that also appear as DVD tracks on a Live/Compilation set stay
  // on Appears On (ranked below studio) but do not clutter the live album strip.
  const preferredForRg: AlbumAssociatedVideoContract[] = [];
  for (const video of byId.values()) {
    const preferred = getVideoAlbumRefs(String(video.id))[0];
    if (preferred && String(preferred.id) === rgMbid) {
      preferredForRg.push(video);
    }
  }

  return preferredForRg.sort((left, right) => {
    const leftVol = left.volume_number ?? 0;
    const rightVol = right.volume_number ?? 0;
    if (leftVol !== rightVol) return leftVol - rightVol;
    const leftTrack = left.track_number ?? Number.MAX_SAFE_INTEGER;
    const rightTrack = right.track_number ?? Number.MAX_SAFE_INTEGER;
    if (leftTrack !== rightTrack) return leftTrack - rightTrack;
    return String(left.title).localeCompare(String(right.title), undefined, { sensitivity: "base" });
  });
}

/** All provider VIDEO offers for the canonical recording, preference-ordered. */
function getVideoProviderOffers(recordingId: string): VideoProviderOfferContract[] {
  const rows = db.prepare(`
    SELECT
      pi.provider,
      CAST(pi.provider_id AS TEXT) AS provider_id,
      -- Prefer an on-disk probed quality for this provider offer when present.
      -- Catalog has4K/UHD badges are aspirational until import confirms the
      -- longer edge; stale offer UHD must not outrank a probed FHD/UHD file.
      COALESCE(
        (
          SELECT NULLIF(TRIM(tf.quality), '')
          FROM TrackFiles tf
          WHERE tf.provider = pi.provider
            AND CAST(tf.provider_id AS TEXT) = CAST(pi.provider_id AS TEXT)
            AND (tf.provider_entity_type = 'video' OR tf.library_slot = 'video' OR tf.file_type = 'video')
            AND tf.quality IS NOT NULL
            AND TRIM(tf.quality) != ''
          ORDER BY tf.modified_at DESC
          LIMIT 1
        ),
        NULLIF(TRIM(pi.video_quality), '')
      ) AS quality,
      pi.provider_url AS url
    FROM ProviderItems pi
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = pi.id
     AND video_match.match_state = 'accepted'
    WHERE pi.entity_type = 'video'
      -- availability is stored as text ('available') or NULL for live offers,
      -- never the integer 1 — testing it against 1 silently dropped every video
      -- offer and broke both preview and download (the TIDAL-only regression).
      -- Include anything not explicitly marked unavailable so both the 'available'
      -- string and any legacy truthy value survive.
      AND (pi.availability IS NULL
           OR LOWER(CAST(pi.availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
      AND CAST(video_match.recording_id AS TEXT) = CAST(? AS TEXT)
  `).all(recordingId) as Array<{ provider: string; provider_id: string; quality: string | null; url: string | null }>;
  rows.sort((a, b) => compareVideoOffersByQualityThenProvider(
    { provider: a.provider, quality: a.quality, provider_id: a.provider_id },
    { provider: b.provider, quality: b.quality, provider_id: b.provider_id },
  ));
  return rows.map((row) => {
    let canPreview = false;
    let canDownload = false;
    let connected = false;
    try {
      const provider = streamingProviderManager.getStreamingProvider(row.provider);
      const requiresConnection = provider.manifest?.auth.mediaAccessRequiresConnection
        ?? provider.manifest?.auth.kind !== "none";
      connected = !requiresConnection
        || typeof provider.isAuthenticated !== "function"
        || provider.isAuthenticated();
      canPreview = connected && provider.capabilities.videoPreviews;
      canDownload = connected && provider.capabilities.videoDownloads;
    } catch {
      // Preserve stale offer provenance for display, but never advertise
      // actions until that provider is registered again.
    }
    return {
      provider: row.provider,
      provider_id: row.provider_id,
      quality: row.quality ?? null,
      url: row.url ?? null,
      available: connected,
      can_preview: canPreview,
      can_download: canDownload,
    };
  });
}

/**
 * Albums (release groups) this video appears on.
 *
 * Sources (unioned):
 *  1. Canonical release tracks pointing at this video recording (MB video tracks)
 *  2. Related audio recordings (`RecordingRelations.provider_video_for` /
 *     `music_video_for`) — album membership lives on the audio tracklist
 *     (YouTube ATV↔OMV counterparts, Apple/TIDAL title+duration links,
 *     MusicBrainz music-video relations, etc.)
 *
 * Provider video offers may carry stamped `release_group_mbid` /
 * `provider_album_id` after album refresh, but those are processing artifacts,
 * not native provider MB identity — Appears On follows catalog Tracks + the
 * audio relation instead.
 *
 * Track/disc position prefers the monitored/selected library release when present,
 * then richer multi-disc editions, then earliest date. Preferred album order:
 * studio Album/EP/Single > other > compilation > live; then wanted/monitored;
 * then largest track count (never let a larger compilation beat a studio album).
 */
function getVideoAlbumRefs(recordingId: string): VideoAlbumRefContract[] {
  // Main OMVs must not pull Appears On membership from live-marked audio
  // (title marker or live-album-only membership) via provider_video_for /
  // music_video_for. Live/lyric variants may still follow those links.
  // Video-as-track membership on a live compilation remains (ranked below studio).
  const mayFollowRelatedAudio = mainVideoMayFollowAudioRelationSql({
    videoVariantExpr: "video.video_variant",
    trackTitleExpr: "audio.title",
    recordingIdExpr: "audio.id",
    recordingMbidExpr: "audio.mbid",
  });
  const videoOrRelatedAudio = `
    CAST(t.recording_id AS TEXT) = CAST(? AS TEXT)
    OR t.recording_mbid = (
      SELECT mbid FROM Recordings
      WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND mbid IS NOT NULL
    )
    OR t.recording_id IN (
      SELECT rr.target_recording_id
      FROM RecordingRelations rr
      JOIN Recordings audio ON audio.id = rr.target_recording_id
      JOIN Recordings video ON video.id = rr.source_recording_id
      WHERE CAST(rr.source_recording_id AS TEXT) = CAST(? AS TEXT)
        AND rr.relation_type IN ('provider_video_for', 'music_video_for')
        AND rr.target_recording_id IS NOT NULL
        AND ${mayFollowRelatedAudio}
    )
  `;
  // Prefer a track row that belongs to the video recording itself; fall back to
  // the related audio recording's position on the same release group. Prefer
  // the selected-library / richest edition over the earliest-dated single.
  const trackPickOrder = `
    CASE
      WHEN CAST(t.recording_id AS TEXT) = CAST(? AS TEXT) THEN 0
      WHEN t.recording_mbid = (
        SELECT mbid FROM Recordings
        WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND mbid IS NOT NULL
      ) THEN 0
      ELSE 1
    END ASC,
    COALESCE(ar.track_count, 0) DESC,
    COALESCE(ar.media_count, 0) DESC,
    CASE
      WHEN ar.mbid = ${preferredLibraryReleaseMbidSql("ar.release_group_id")} THEN 0
      ELSE 1
    END ASC,
    CASE WHEN ar.date IS NULL THEN 1 ELSE 0 END,
    ar.date ASC,
    t.medium_position ASC,
    t.position ASC
  `;
  const rows = db.prepare(`
    SELECT
      a.mbid AS id,
      a.title,
      a.images AS album_images,
      CASE WHEN EXISTS (
        SELECT 1
        FROM LibraryAlbums library_group
        JOIN Libraries library
          ON library.id = library_group.library_id
         AND library.enabled = 1
        WHERE library_group.release_group_id = a.id
          AND library_group.monitored = 1
      ) THEN 1 ELSE 0 END AS wanted,
      (
        SELECT t.mbid
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = a.mbid
          AND (${videoOrRelatedAudio})
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_mbid,
      (
        SELECT t.position
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = a.mbid
          AND (${videoOrRelatedAudio})
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_number,
      (
        SELECT t.medium_position
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = a.mbid
          AND (${videoOrRelatedAudio})
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS volume_number,
      (
        SELECT COALESCE(
          NULLIF(ar.track_count, 0),
          (
            SELECT COUNT(*)
            FROM Tracks t2
            WHERE t2.album_edition_id = ar.id
               OR (t2.edition_mbid IS NOT NULL AND t2.edition_mbid = ar.mbid)
          )
        )
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = a.mbid
          AND (${videoOrRelatedAudio})
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS track_count,
      (
        SELECT COALESCE(NULLIF(ar.media_count, 0), 1)
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = a.mbid
          AND (${videoOrRelatedAudio})
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ) AS media_count
    FROM Albums a
    WHERE a.mbid IN (
      SELECT ar.release_group_mbid
      FROM Tracks t
      JOIN AlbumEditions ar
        ON ar.id = t.album_edition_id
        OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
      WHERE ${videoOrRelatedAudio}
    )
    ORDER BY
      ${VIDEO_ALBUM_ASSOCIATION_KIND_SQL} ASC,
      wanted DESC,
      COALESCE((
        SELECT COALESCE(
          NULLIF(ar.track_count, 0),
          (
            SELECT COUNT(*)
            FROM Tracks t2
            WHERE t2.album_edition_id = ar.id
               OR (t2.edition_mbid IS NOT NULL AND t2.edition_mbid = ar.mbid)
          )
        )
        FROM Tracks t
        JOIN AlbumEditions ar
          ON ar.id = t.album_edition_id
          OR (t.edition_mbid IS NOT NULL AND ar.mbid = t.edition_mbid)
        WHERE ar.release_group_mbid = a.mbid
          AND (${videoOrRelatedAudio})
        ORDER BY ${trackPickOrder}
        LIMIT 1
      ), 0) DESC,
      a.title COLLATE NOCASE ASC
  `).all(
    // Per position subquery: videoOrRelatedAudio (3) + trackPickOrder (2)
    // × 5 subqueries (track_mbid, track_number, volume_number, track_count, media_count)
    recordingId, recordingId, recordingId, recordingId, recordingId,
    recordingId, recordingId, recordingId, recordingId, recordingId,
    recordingId, recordingId, recordingId, recordingId, recordingId,
    recordingId, recordingId, recordingId, recordingId, recordingId,
    recordingId, recordingId, recordingId, recordingId, recordingId,
    // ORDER BY largest track_count among matching editions: videoOrRelatedAudio (3) + trackPickOrder (2)
    recordingId, recordingId, recordingId, recordingId, recordingId,
    // IN-clause Tracks branch: videoOrRelatedAudio (3)
    recordingId, recordingId, recordingId,
  ) as Array<{
    id: string;
    title: string;
    album_images: string | null;
    wanted: number;
    track_mbid: string | null;
    track_number: number | null;
    volume_number: number | null;
    track_count: number | null;
    media_count: number | null;
  }>;
  return rows.map((row) => {
    const coverArtUrl = albumCoverLocalUrl({
      albumMbid: row.id,
      images: imageContainerFromImagesColumn(row.album_images),
    });
    return {
      id: String(row.id),
      title: row.title,
      cover_id: coverArtUrl,
      cover_art_url: coverArtUrl,
      track_mbid: row.track_mbid ?? null,
      track_number: row.track_number == null ? null : Number(row.track_number),
      volume_number: row.volume_number == null ? null : Number(row.volume_number),
      track_count: row.track_count == null || Number(row.track_count) <= 0
        ? null
        : Number(row.track_count),
      media_count: row.media_count == null || Number(row.media_count) <= 0
        ? null
        : Number(row.media_count),
    };
  });
}

function resolveVideoRecordingId(videoId: string): string | null {
  const direct = db.prepare(
    "SELECT id FROM Recordings WHERE is_video = 1 AND CAST(id AS TEXT) = CAST(? AS TEXT) LIMIT 1",
  ).get(videoId) as { id?: number | string } | undefined;
  if (direct?.id != null) {
    return String(direct.id);
  }

  const viaProvider = db.prepare(`
    SELECT video_match.recording_id
    FROM ProviderItems provider_item
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = provider_item.id
     AND video_match.match_state = 'accepted'
    WHERE provider_item.entity_type = 'video'
      AND CAST(provider_item.provider_id AS TEXT) = CAST(? AS TEXT)
      AND LOWER(CAST(provider_item.availability AS TEXT))
          NOT IN ('0', 'false', 'unavailable', 'no', '')
    ORDER BY video_match.updated_at DESC
    LIMIT 1
  `).get(videoId) as { recording_id?: number | string | null } | undefined;
  return viaProvider?.recording_id != null ? String(viaProvider.recording_id) : null;
}
