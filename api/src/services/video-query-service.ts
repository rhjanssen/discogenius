import { db } from "../database.js";
import type { VideoContract, VideosListResponseContract } from "../contracts/catalog.js";
import type { VideoDetailContract } from "../contracts/media.js";

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
  monitor?: number | boolean | null;
  monitor_lock?: number | boolean | null;
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
    cover_art_url: row.cover_art_url ?? null,
    url: row.url ?? null,
    path: row.path ?? null,
    artist_id: String(row.artist_id),
    artist_name: row.artist_name ?? undefined,
    is_monitored: Boolean(row.monitor),
    monitor: row.monitor === undefined || row.monitor === null ? undefined : Boolean(row.monitor),
    monitor_lock: row.monitor_lock === undefined || row.monitor_lock === null ? undefined : Boolean(row.monitor_lock),
    monitor_locked: Boolean(row.monitor_lock),
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
    is_monitored: mapped.is_monitored,
    monitor: mapped.monitor,
    monitor_lock: mapped.monitor_lock,
    monitor_locked: mapped.monitor_locked,
    downloaded: mapped.downloaded ?? false,
    is_downloaded: mapped.is_downloaded,
  };
}

function getCanonicalVideoSelectSql(whereClause: string): string {
  return `
    SELECT
      CAST(recording.Id AS TEXT) AS id,
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
      COALESCE(recording.ReleaseDate, provider_item.release_date) AS release_date,
      provider_item.version AS version,
      provider_item.explicit AS explicit,
      provider_item.quality AS quality,
      provider_item.quality AS current_quality,
      COALESCE(recording.CoverImageId, provider_item.asset_id) AS cover,
      recording.CoverImageUrl AS cover_art_url,
      provider_item.provider_url AS url,
      NULL AS path,
      CAST(COALESCE(recording.ArtistMetadataId, artist.Id) AS TEXT) AS artist_id,
      artist.name AS artist_name,
      COALESCE(recording.Monitor, 0) AS monitor,
      COALESCE(recording.MonitorLock, 0) AS monitor_lock,
      recording.updated_at AS created_at,
      recording.updated_at AS updated_at,
      recording.updated_at AS last_scanned,
      NULL AS popularity,
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
      ON artist.Id = recording.ArtistMetadataId
      OR (recording.artist_mbid IS NOT NULL AND artist.mbid = recording.artist_mbid)
    LEFT JOIN ProviderItems provider_item
      ON provider_item.rowid = (
        SELECT candidate.rowid
        FROM ProviderItems candidate
        WHERE candidate.entity_type = 'video'
          AND (
            candidate.recording_id = recording.Id
            OR (recording.mbid IS NOT NULL AND candidate.recording_mbid = recording.mbid)
          )
        ORDER BY COALESCE(candidate.match_confidence, 0) DESC, candidate.updated_at DESC
        LIMIT 1
      )
    ${whereClause}
  `;
}

function getCanonicalVideoOrderBy(sort: SortableVideoField, dir: "ASC" | "DESC"): string {
  switch (sort) {
    case "name":
      return ` ORDER BY canonical_video.title ${dir}, canonical_video.id ASC`;
    case "popularity":
      return ` ORDER BY COALESCE(canonical_video.popularity, 0) ${dir}, canonical_video.id ASC`;
    case "scannedAt":
      return ` ORDER BY (canonical_video.updated_at IS NULL) ASC, canonical_video.updated_at ${dir}, canonical_video.id ASC`;
    case "releaseDate":
    default:
      return ` ORDER BY (canonical_video.release_date IS NULL) ASC, canonical_video.release_date ${dir}, canonical_video.id ASC`;
  }
}

function buildCanonicalVideoWhere(input: ListVideosQuery): {
  whereClause: string;
  params: Array<string | number>;
} {
  const where: string[] = ["recording.IsVideo = 1"];
  const params: Array<string | number> = [];

  if (input.search) {
    const searchParam = `%${input.search}%`;
    where.push("(recording.title LIKE ? OR artist.name LIKE ?)");
    params.push(searchParam, searchParam);
  }

  if (input.monitored !== undefined) {
    where.push("COALESCE(recording.Monitor, 0) = ?");
    params.push(input.monitored ? 1 : 0);
  }

  if (input.locked !== undefined) {
    where.push("COALESCE(recording.MonitorLock, 0) = ?");
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
  const selectSql = getCanonicalVideoSelectSql(whereClause);

  const rows = db.prepare(`
    SELECT *
    FROM (${selectSql}) canonical_video
    ${input.downloaded === undefined ? "" : `WHERE canonical_video.downloaded = ${input.downloaded ? 1 : 0}`}
    ${getCanonicalVideoOrderBy(sort, dir)}
    LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as (VideoRow & { downloaded?: number })[];

  const countResult = db.prepare(`
    SELECT COUNT(*) AS total
    FROM (${selectSql}) canonical_video
    ${input.downloaded === undefined ? "" : `WHERE canonical_video.downloaded = ${input.downloaded ? 1 : 0}`}
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
  const canonicalRow = db.prepare(`
    SELECT *
    FROM (${getCanonicalVideoSelectSql("WHERE recording.IsVideo = 1 AND CAST(recording.Id AS TEXT) = CAST(? AS TEXT)")}) canonical_video
  `).get(videoId) as (VideoRow & { downloaded?: number }) | undefined;

  if (canonicalRow) {
    return mapVideoDetail(canonicalRow, Boolean(canonicalRow.downloaded));
  }

  return null;
}
