import { db } from "../database.js";
import { getMediaDownloadStateMap } from "./download-state.js";
import type { VideoContract, VideosListResponseContract } from "../contracts/catalog.js";
import type { VideoDetailContract } from "../contracts/media.js";

const videoDownloadedPredicate = `
  EXISTS (
    SELECT 1
    FROM library_files lf
    WHERE lf.media_id = media.id
      AND lf.file_type = 'video'
  )
`;

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

function getVideoOrderBy(sort: SortableVideoField, dir: "ASC" | "DESC"): string {
  switch (sort) {
    case "name":
      return ` ORDER BY media.title ${dir}, media.id ASC`;
    case "popularity":
      return ` ORDER BY COALESCE(media.popularity, 0) ${dir}, media.id ASC`;
    case "scannedAt":
      return ` ORDER BY (media.last_scanned IS NULL) ASC, media.last_scanned ${dir}, media.id ASC`;
    case "releaseDate":
    default:
      return ` ORDER BY (media.release_date IS NULL) ASC, media.release_date ${dir}, media.id ASC`;
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

function getVideoSelectSql(whereClause: string): string {
  return `
    SELECT
      media.*,
      COALESCE((
        SELECT lf.quality
        FROM library_files lf
        WHERE lf.media_id = media.id
          AND lf.file_type = 'video'
        ORDER BY lf.verified_at DESC, lf.id DESC
        LIMIT 1
      ), media.quality) as current_quality,
      artists.name as artist_name
    FROM media
    LEFT JOIN artists ON media.artist_id = artists.id
    ${whereClause}
  `;
}

export function listVideos(input: ListVideosQuery): VideosListResponseContract {
  const where: string[] = ["media.type = 'Music Video'"];
  const params: Array<string | number> = [];
  const countParams: Array<string | number> = [];

  if (input.search) {
    const searchParam = `%${input.search}%`;
    where.push("(media.title LIKE ? OR artists.name LIKE ?)");
    params.push(searchParam, searchParam);
    countParams.push(searchParam, searchParam);
  }

  if (input.monitored !== undefined) {
    where.push("media.monitor = ?");
    const monitoredValue = input.monitored ? 1 : 0;
    params.push(monitoredValue);
    countParams.push(monitoredValue);
  }

  if (input.downloaded !== undefined) {
    where.push(input.downloaded ? videoDownloadedPredicate : `NOT (${videoDownloadedPredicate})`);
  }

  if (input.locked !== undefined) {
    where.push("COALESCE(media.monitor_lock, 0) = ?");
    const lockedValue = input.locked ? 1 : 0;
    params.push(lockedValue);
    countParams.push(lockedValue);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sort = normalizeSortField(input.sort);
  const dir = normalizeSortDirection(input.dir);
  const orderBy = getVideoOrderBy(sort, dir);

  const rows = db.prepare(`
    ${getVideoSelectSql(whereClause)}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as VideoRow[];

  const totalResult = db.prepare(`
    SELECT COUNT(*) as total
    FROM media
    LEFT JOIN artists ON media.artist_id = artists.id
    ${whereClause}
  `).get(...countParams) as { total: number };

  const downloadStates = getMediaDownloadStateMap(rows.map((video) => video.id), "video");
  const items = rows.map((video) => mapVideoRow(video, downloadStates.get(String(video.id)) ?? false));

  return {
    items,
    total: totalResult.total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + items.length < totalResult.total,
  };
}

export function getVideoDetail(videoId: string): VideoDetailContract | null {
  const row = db.prepare(`
    ${getVideoSelectSql("WHERE media.id = ? AND media.type = 'Music Video'")}
  `).get(videoId) as VideoRow | undefined;

  if (!row) {
    return null;
  }

  const downloadState = getMediaDownloadStateMap([row.id], "video").get(String(row.id)) ?? false;
  return mapVideoDetail(row, downloadState);
}
