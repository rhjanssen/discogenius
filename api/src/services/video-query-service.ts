import { db } from "../database.js";
import { getMediaDownloadStateMap } from "./download-state.js";
import type { VideoContract } from "../contracts/catalog.js";
import type { VideoDetailContract } from "../contracts/media.js";

type VideoRow = {
  id: number | string;
  artist_id: number | string;
  explicit?: number | boolean | null;
  monitor?: number | boolean | null;
  monitor_lock?: number | boolean | null;
  quality?: string | null;
  cover?: string | null;
  current_quality?: string | null;
  artist_name?: string | null;
  [key: string]: unknown;
};

export type ListVideosOptions = {
  limit: number;
  offset: number;
  search?: string;
  monitored?: boolean;
  downloaded?: boolean;
  sort?: string;
  direction?: "ASC" | "DESC";
};

export type ListVideosResult = {
  items: VideoContract[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

const VIDEO_DOWNLOADED_PREDICATE = `
  EXISTS (
    SELECT 1
    FROM library_files lf
    WHERE lf.media_id = media.id
      AND lf.file_type = 'video'
  )
`;

function mapVideoRow<T extends VideoContract | VideoDetailContract>(
  video: VideoRow,
  downloaded: boolean,
): T {
  const { current_quality, ...rest } = video;

  return {
    ...rest,
    id: String(rest.id),
    artist_id: String(rest.artist_id),
    explicit: rest.explicit === undefined ? undefined : Boolean(rest.explicit),
    quality: current_quality || video.quality || null,
    cover_id: typeof video.cover === "string" ? video.cover : null,
    is_monitored: Boolean(video.monitor),
    monitor_locked: Boolean(video.monitor_lock),
    downloaded,
    is_downloaded: downloaded,
  } as T;
}

export function listVideos(options: ListVideosOptions): ListVideosResult {
  const params: any[] = [];
  const countParams: any[] = [];
  const where: string[] = ["media.type = 'Music Video'"];

  let query = `
    SELECT
      media.*,
      COALESCE((
        SELECT lf.quality
        FROM library_files lf
        WHERE lf.media_id = media.id
          AND lf.file_type = 'video'
        ORDER BY lf.verified_at DESC, lf.id DESC
        LIMIT 1
      ), media.quality) AS current_quality,
      artists.name AS artist_name
    FROM media
    LEFT JOIN artists ON media.artist_id = artists.id
  `;

  let countQuery = `
    SELECT COUNT(*) AS total
    FROM media
  `;

  if (options.search) {
    countQuery += ` LEFT JOIN artists ON media.artist_id = artists.id`;
    where.push("(media.title LIKE ? OR artists.name LIKE ?)");
    const searchParam = `%${options.search}%`;
    params.push(searchParam, searchParam);
    countParams.push(searchParam, searchParam);
  }

  if (options.monitored !== undefined) {
    where.push("media.monitor = ?");
    const monitoredValue = options.monitored ? 1 : 0;
    params.push(monitoredValue);
    countParams.push(monitoredValue);
  }

  if (options.downloaded !== undefined) {
    where.push(options.downloaded ? VIDEO_DOWNLOADED_PREDICATE : `NOT (${VIDEO_DOWNLOADED_PREDICATE})`);
  }

  if (where.length > 0) {
    const whereClause = ` WHERE ${where.join(" AND ")}`;
    query += whereClause;
    countQuery += whereClause;
  }

  const orderBy = (() => {
    switch (options.sort) {
      case "name":
        return ` ORDER BY media.title ${options.direction}, media.id ASC`;
      case "popularity":
        return ` ORDER BY media.popularity ${options.direction}, media.id ASC`;
      case "scannedAt":
        return ` ORDER BY media.last_scanned ${options.direction}, media.id ASC`;
      case "releaseDate":
      default:
        return ` ORDER BY media.release_date ${options.direction}, media.id ASC`;
    }
  })();

  query += `${orderBy} LIMIT ? OFFSET ?`;
  params.push(options.limit, options.offset);

  const rows = db.prepare(query).all(...params) as VideoRow[];
  const totalResult = db.prepare(countQuery).get(...countParams) as { total: number };
  const downloadStates = getMediaDownloadStateMap(rows.map((row) => row.id), "video");
  const items = rows.map((row) => mapVideoRow<VideoContract>(row, downloadStates.get(String(row.id)) ?? false));

  return {
    items,
    total: totalResult.total,
    limit: options.limit,
    offset: options.offset,
    hasMore: options.offset + rows.length < totalResult.total,
  };
}

export function getVideoDetail(videoId: string): VideoDetailContract | null {
  const row = db.prepare(`
    SELECT
      media.*,
      COALESCE((
        SELECT lf.quality
        FROM library_files lf
        WHERE lf.media_id = media.id
          AND lf.file_type = 'video'
        ORDER BY lf.verified_at DESC, lf.id DESC
        LIMIT 1
      ), media.quality) AS current_quality,
      artists.name AS artist_name
    FROM media
    LEFT JOIN artists ON media.artist_id = artists.id
    WHERE media.id = ? AND media.type = 'Music Video'
  `).get(videoId) as VideoRow | undefined;

  if (!row) {
    return null;
  }

  const downloaded = getMediaDownloadStateMap([row.id], "video").get(String(row.id)) ?? false;
  return mapVideoRow<VideoDetailContract>(row, downloaded);
}
