import { db } from "../../database.js";
import type { VideoContract, VideosListResponseContract } from "../../contracts/catalog.js";
import type { VideoAlbumRefContract, VideoDetailContract, VideoProviderOfferContract } from "../../contracts/media.js";
import { streamingProviderManager } from "../providers/index.js";
import { videoCoverLocalUrl } from "../metadata/media-cover-service.js";

type SortableVideoField = "name" | "popularity" | "scannedAt" | "releaseDate";

type VideoRow = {
  id: number | string;
  title: string;
  duration: number;
  release_date?: string | null;
  version?: string | null;
  explicit?: number | boolean | null;
  quality?: string | null;
  current_quality?: string | null;


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

export interface ListVideosQuery {
  limit: number;
  offset: number;
  search?: string;
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
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

function mapVideoRow(row: VideoRow, isDownloaded: boolean): VideoContract {
  const coverArtUrl = videoCoverLocalUrl(row.id) ?? row.cover_art_url ?? null;
  return {
    id: String(row.id),
    title: row.title,
    duration: Number(row.duration || 0),
    release_date: row.release_date ?? null,
    version: row.version ?? null,
    explicit: row.explicit === undefined || row.explicit === null ? undefined : Boolean(row.explicit),
    quality: row.current_quality || row.quality || null,
    cover: row.cover ?? null,
    cover_id: row.cover ?? null,
    cover_art_url: coverArtUrl,
    url: row.url ?? null,
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

  return {
    id: mapped.id,
    title: mapped.title,
    duration: mapped.duration,
    artist_id: mapped.artist_id,
    artist_name: mapped.artist_name,
    release_date: mapped.release_date,
    version: mapped.version,
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

function getCanonicalVideoSelectSql(whereClause: string): string {
  return `
    SELECT
      CAST(recording.id AS TEXT) AS id,
      recording.title AS title,
      COALESCE(
        CASE
          WHEN COALESCE(recording.length_ms, 0) > 0
          THEN CAST(ROUND(recording.length_ms / 1000.0) AS INT)
          ELSE NULL
        END,
        provider_item.duration,
        0
      ) AS duration,
      COALESCE(recording.release_date, provider_item.release_date) AS release_date,
      provider_item.version AS version,
      provider_item.explicit AS explicit,
      provider_item.quality AS quality,
      provider_item.quality AS current_quality,
      COALESCE(recording.cover_image_id, provider_item.asset_id) AS cover,
      recording.cover_image_url AS cover_art_url,
      provider_item.provider_url AS url,
      NULL AS path,
      CAST(COALESCE(managed_artist.id, artist.mbid, recording.artist_mbid, recording.artist_metadata_id, artist.id) AS TEXT) AS artist_id,
      COALESCE(managed_artist.name, artist.name) AS artist_name,
      COALESCE(recording.monitored, 0) AS monitored,
      COALESCE(recording.monitored_lock, 0) AS monitored_lock,
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
            (recording.mbid IS NOT NULL AND lf.canonical_recording_mbid = recording.mbid)
            OR (provider_item.provider_id IS NOT NULL AND CAST(lf.provider_id AS TEXT) = CAST(provider_item.provider_id AS TEXT))
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
      ON provider_item.rowid = (
        SELECT candidate.rowid
        FROM ProviderItems candidate
        WHERE candidate.entity_type = 'video'
          AND (
            candidate.recording_id = recording.id
            OR (recording.mbid IS NOT NULL AND candidate.recording_mbid = recording.mbid)
          )
        ORDER BY COALESCE(candidate.match_confidence, 0) DESC, candidate.updated_at DESC
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

  const items = rows.map((video) => mapVideoRow(video, Boolean(video.downloaded)));

  return {
    items,
    total: countResult.total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + items.length < countResult.total,
  };
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

/** All provider VIDEO offers for the canonical recording, preference-ordered. */
function getVideoProviderOffers(recordingId: string): VideoProviderOfferContract[] {
  const rows = db.prepare(`
    SELECT pi.provider, CAST(pi.provider_id AS TEXT) AS provider_id, pi.quality, pi.provider_url AS url
    FROM ProviderItems pi
    WHERE pi.entity_type = 'video'
      -- availability is stored as text ('available') or NULL for live offers,
      -- never the integer 1 — testing it against 1 silently dropped every video
      -- offer and broke both preview and download (the TIDAL-only regression).
      -- Include anything not explicitly marked unavailable so both the 'available'
      -- string and any legacy truthy value survive.
      AND (pi.availability IS NULL
           OR LOWER(CAST(pi.availability AS TEXT)) NOT IN ('0', 'false', 'unavailable', 'no', ''))
      AND (
        CAST(pi.recording_id AS TEXT) = CAST(? AS TEXT)
        OR pi.recording_mbid = (SELECT mbid FROM Recordings WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND mbid IS NOT NULL)
      )
  `).all(recordingId, recordingId) as Array<{ provider: string; provider_id: string; quality: string | null; url: string | null }>;
  rows.sort((a, b) =>
    streamingProviderManager.getProviderPreferenceRank(a.provider)
    - streamingProviderManager.getProviderPreferenceRank(b.provider));
  return rows.map((row) => {
    let canPreview = false;
    let canDownload = false;
    try {
      const capabilities = streamingProviderManager.getStreamingProvider(row.provider).capabilities;
      canPreview = capabilities.videoPreviews;
      canDownload = capabilities.videoDownloads;
    } catch {
      // Preserve stale offer provenance for display, but never advertise
      // actions until that provider is registered again.
    }
    return {
      provider: row.provider,
      provider_id: row.provider_id,
      quality: row.quality ?? null,
      url: row.url ?? null,
      available: true,
      can_preview: canPreview,
      can_download: canDownload,
    };
  });
}

/**
 * Albums (release groups) this video appears on: canonical release VIDEO
 * tracks pointing at the recording, plus provider album linkage on the video
 * offers themselves (Apple bundles MVs inside albums).
 */
function getVideoAlbumRefs(recordingId: string): VideoAlbumRefContract[] {
  const rows = db.prepare(`
    SELECT DISTINCT a.mbid AS id, a.title, a.cover_image_id AS cover_id
    FROM Albums a
    WHERE a.mbid IN (
      SELECT ar.release_group_mbid
      FROM Tracks t
      JOIN AlbumReleases ar
        ON ar.id = t.album_release_id
        OR (t.release_mbid IS NOT NULL AND ar.mbid = t.release_mbid)
      WHERE CAST(t.recording_id AS TEXT) = CAST(? AS TEXT)
        OR t.recording_mbid = (SELECT mbid FROM Recordings WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND mbid IS NOT NULL)

      UNION

      SELECT v.release_group_mbid
      FROM ProviderItems v
      WHERE v.entity_type = 'video'
        AND CAST(v.recording_id AS TEXT) = CAST(? AS TEXT)
        AND v.release_group_mbid IS NOT NULL

      UNION

      SELECT alb.release_group_mbid
      FROM ProviderItems v
      JOIN ProviderItems alb
        ON alb.entity_type = 'album'
        AND alb.provider = v.provider
        AND CAST(alb.provider_id AS TEXT) = CAST(v.provider_album_id AS TEXT)
      WHERE v.entity_type = 'video'
        AND CAST(v.recording_id AS TEXT) = CAST(? AS TEXT)
        AND v.provider_album_id IS NOT NULL
        AND alb.release_group_mbid IS NOT NULL
    )
  `).all(recordingId, recordingId, recordingId, recordingId) as Array<{ id: string; title: string; cover_id: string | null }>;
  return rows.map((row) => ({
    id: String(row.id),
    title: row.title,
    cover_id: row.cover_id ?? null,
  }));
}

function resolveVideoRecordingId(videoId: string): string | null {
  const direct = db.prepare(
    "SELECT id FROM Recordings WHERE is_video = 1 AND CAST(id AS TEXT) = CAST(? AS TEXT) LIMIT 1",
  ).get(videoId) as { id?: number | string } | undefined;
  if (direct?.id != null) {
    return String(direct.id);
  }

  const viaProvider = db.prepare(
    "SELECT recording_id FROM ProviderItems WHERE entity_type = 'video' AND recording_id IS NOT NULL AND CAST(provider_id AS TEXT) = CAST(? AS TEXT) ORDER BY updated_at DESC LIMIT 1",
  ).get(videoId) as { recording_id?: number | string | null } | undefined;
  return viaProvider?.recording_id != null ? String(viaProvider.recording_id) : null;
}
