import { db } from "../database.js";
import { JobTypes } from "./queue.js";

export type WantedItemType = "album" | "track" | "video";
export type WantedQueueStatus = "missing" | "queued" | "processing";
export type WantedMonitorScope = "release" | "manual_track" | "video";

export interface WantedItem {
  id: string;
  type: WantedItemType;
  monitorScope: WantedMonitorScope;
  sourceId: string;
  artistId: string | null;
  artistName: string | null;
  albumId: string | null;
  albumTitle: string | null;
  title: string;
  quality: string | null;
  cover: string | null;
  queueStatus: WantedQueueStatus;
  activeJobId: number | null;
  monitorLocked: boolean;
  reason: string;
}

export interface WantedListInput {
  artistId?: string;
  type?: WantedItemType;
  limit?: number;
  offset?: number;
}

export interface WantedListResult {
  total: number;
  limit: number;
  offset: number;
  items: WantedItem[];
}

interface WantedRow {
  item_type: WantedItemType;
  monitor_scope: WantedMonitorScope;
  source_id: string | number;
  artist_id: string | number | null;
  artist_name: string | null;
  album_id: string | number | null;
  album_title: string | null;
  title: string;
  quality: string | null;
  cover: string | null;
  job_id: number | null;
  job_status: "pending" | "processing" | null;
  monitor_locked: number | null;
  reason: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class WantedQueryService {
  static listWanted(input: WantedListInput = {}): WantedListResult {
    const limit = clampLimit(input.limit);
    const offset = Math.max(0, input.offset ?? 0);
    const params = buildParams(input);
    const where = buildWhere(input);
    const baseSql = buildWantedSql(where);

    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM (${baseSql}) wanted`).get(...params) as { total: number };
    const rows = db.prepare(`
      SELECT *
      FROM (${baseSql}) wanted
      ORDER BY artist_name COLLATE NOCASE, album_title COLLATE NOCASE, type_sort, title COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<WantedRow & { type_sort: number }>;

    return {
      total: Number(totalRow?.total || 0),
      limit,
      offset,
      items: rows.map(mapWantedRow),
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_LIMIT;
  }

  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function buildParams(input: WantedListInput): unknown[] {
  const params: unknown[] = [];

  if (input.artistId) {
    params.push(String(input.artistId));
  }

  if (input.type) {
    params.push(input.type);
  }

  return params;
}

function buildWhere(input: WantedListInput): string {
  const clauses: string[] = [];

  if (input.artistId) {
    clauses.push("CAST(artist_id AS TEXT) = ?");
  }

  if (input.type) {
    clauses.push("item_type = ?");
  }

  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function buildWantedSql(where: string): string {
  return `
    WITH album_stats AS (
      SELECT
        a.id AS album_id,
        COUNT(m.id) AS total_tracks,
        SUM(CASE WHEN m.monitor = 1 THEN 1 ELSE 0 END) AS monitored_tracks,
        SUM(CASE WHEN m.monitor = 1 AND lf.id IS NULL THEN 1 ELSE 0 END) AS missing_tracks,
        COUNT(CASE WHEN lf.id IS NOT NULL THEN 1 END) AS imported_tracks
      FROM albums a
      LEFT JOIN media m
        ON m.album_id = a.id
       AND m.type != 'Music Video'
      LEFT JOIN library_files lf
        ON lf.media_id = m.id
       AND lf.file_type = 'track'
      GROUP BY a.id
    ),
    album_file_stats AS (
      SELECT
        album_id,
        COUNT(*) AS imported_track_files
      FROM library_files
      WHERE file_type = 'track'
        AND album_id IS NOT NULL
      GROUP BY album_id
    ),
    active_album_jobs AS (
      SELECT
        ref_id,
        MIN(id) AS job_id,
        CASE
          WHEN SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) > 0 THEN 'processing'
          ELSE 'pending'
        END AS job_status
      FROM job_queue
      WHERE status IN ('pending', 'processing')
        AND type IN (
          '${JobTypes.DownloadAlbum}',
          '${JobTypes.ImportDownload}'
        )
      GROUP BY ref_id
    ),
    active_track_jobs AS (
      SELECT
        ref_id,
        MIN(id) AS job_id,
        CASE
          WHEN SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) > 0 THEN 'processing'
          ELSE 'pending'
        END AS job_status
      FROM job_queue
      WHERE status IN ('pending', 'processing')
        AND type IN (
          '${JobTypes.DownloadTrack}',
          '${JobTypes.ImportDownload}'
        )
      GROUP BY ref_id
    ),
    active_video_jobs AS (
      SELECT
        ref_id,
        MIN(id) AS job_id,
        CASE
          WHEN SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) > 0 THEN 'processing'
          ELSE 'pending'
        END AS job_status
      FROM job_queue
      WHERE status IN ('pending', 'processing')
        AND type IN (
          '${JobTypes.DownloadVideo}',
          '${JobTypes.ImportDownload}'
        )
      GROUP BY ref_id
    ),
    active_track_jobs_by_album AS (
      SELECT
        m.album_id,
        MIN(jq.id) AS job_id,
        CASE
          WHEN SUM(CASE WHEN jq.status = 'processing' THEN 1 ELSE 0 END) > 0 THEN 'processing'
          ELSE 'pending'
        END AS job_status
      FROM job_queue jq
      JOIN media m
        ON CAST(m.id AS TEXT) = CAST(jq.ref_id AS TEXT)
       AND m.type != 'Music Video'
      WHERE jq.status IN ('pending', 'processing')
        AND jq.type IN (
          '${JobTypes.DownloadTrack}',
          '${JobTypes.ImportDownload}'
        )
      GROUP BY m.album_id
    ),
    wanted_album_targets AS (
      SELECT
        'album' AS item_type,
        'release' AS monitor_scope,
        1 AS type_sort,
        CAST(a.id AS TEXT) AS source_id,
        a.artist_id AS artist_id,
        ar.name AS artist_name,
        a.id AS album_id,
        a.title AS album_title,
        CASE
          WHEN COALESCE(a.version, '') = '' THEN a.title
          WHEN LOWER(a.title) LIKE '%' || LOWER(a.version) || '%' THEN a.title
          ELSE a.title || ' (' || a.version || ')'
        END AS title,
        a.quality AS quality,
        a.cover AS cover,
        COALESCE(aj.job_id, taj.job_id) AS job_id,
        CASE
          WHEN aj.job_status = 'processing' OR taj.job_status = 'processing' THEN 'processing'
          ELSE COALESCE(aj.job_status, taj.job_status)
        END AS job_status,
        COALESCE(a.monitor_lock, 0) AS monitor_locked,
        CASE
          WHEN COALESCE(s.total_tracks, 0) = 0 THEN 'monitored album has no imported track files and needs provider resolution'
          ELSE 'all monitored album tracks are missing'
        END AS reason
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      LEFT JOIN album_stats s ON s.album_id = a.id
      LEFT JOIN album_file_stats fs ON fs.album_id = a.id
      LEFT JOIN active_album_jobs aj ON aj.ref_id = CAST(a.id AS TEXT)
      LEFT JOIN active_track_jobs_by_album taj ON taj.album_id = a.id
      WHERE a.monitor = 1
        AND (
          (COALESCE(s.total_tracks, 0) = 0 AND COALESCE(fs.imported_track_files, 0) = 0)
          OR (
            COALESCE(s.total_tracks, 0) > 0
            AND COALESCE(s.monitored_tracks, 0) = COALESCE(s.total_tracks, 0)
            AND COALESCE(s.missing_tracks, 0) > 0
          )
        )
    ),
    wanted_track_targets AS (
      SELECT
        'track' AS item_type,
        'manual_track' AS monitor_scope,
        2 AS type_sort,
        CAST(m.id AS TEXT) AS source_id,
        m.artist_id AS artist_id,
        ar.name AS artist_name,
        a.id AS album_id,
        a.title AS album_title,
        CASE
          WHEN COALESCE(m.version, '') = '' THEN m.title
          WHEN LOWER(m.title) LIKE '%' || LOWER(m.version) || '%' THEN m.title
          ELSE m.title || ' (' || m.version || ')'
        END AS title,
        COALESCE(m.quality, a.quality) AS quality,
        a.cover AS cover,
        COALESCE(aj.job_id, album_aj.job_id) AS job_id,
        CASE
          WHEN aj.job_status = 'processing' OR album_aj.job_status = 'processing' THEN 'processing'
          ELSE COALESCE(aj.job_status, album_aj.job_status)
        END AS job_status,
        COALESCE(m.monitor_lock, 0) AS monitor_locked,
        CASE
          WHEN COALESCE(a.monitor, 0) = 0 THEN 'individually monitored track is missing'
          ELSE 'monitored partial-album track is missing'
        END AS reason
      FROM media m
      JOIN albums a ON a.id = m.album_id
      LEFT JOIN artists ar ON ar.id = m.artist_id
      LEFT JOIN album_stats s ON s.album_id = a.id
      LEFT JOIN library_files lf
        ON lf.media_id = m.id
       AND lf.file_type = 'track'
      LEFT JOIN active_track_jobs aj ON aj.ref_id = CAST(m.id AS TEXT)
      LEFT JOIN active_album_jobs album_aj ON album_aj.ref_id = CAST(a.id AS TEXT)
      WHERE m.type != 'Music Video'
        AND m.monitor = 1
        AND lf.id IS NULL
        AND (
          COALESCE(a.monitor, 0) = 0
          OR COALESCE(s.monitored_tracks, 0) < COALESCE(s.total_tracks, 0)
        )
    ),
    wanted_video_targets AS (
      SELECT
        'video' AS item_type,
        'video' AS monitor_scope,
        3 AS type_sort,
        CAST(m.id AS TEXT) AS source_id,
        m.artist_id AS artist_id,
        ar.name AS artist_name,
        a.id AS album_id,
        a.title AS album_title,
        m.title AS title,
        m.quality AS quality,
        COALESCE(a.cover, ar.picture) AS cover,
        aj.job_id AS job_id,
        aj.job_status AS job_status,
        COALESCE(m.monitor_lock, 0) AS monitor_locked,
        'monitored music video is missing' AS reason
      FROM media m
      LEFT JOIN albums a ON a.id = m.album_id
      LEFT JOIN artists ar ON ar.id = m.artist_id
      LEFT JOIN library_files lf
        ON lf.media_id = m.id
       AND lf.file_type = 'video'
      LEFT JOIN active_video_jobs aj ON aj.ref_id = CAST(m.id AS TEXT)
      WHERE m.type = 'Music Video'
        AND m.monitor = 1
        AND lf.id IS NULL
    ),
    wanted_targets AS (
      SELECT * FROM wanted_album_targets
      UNION ALL
      SELECT * FROM wanted_track_targets
      UNION ALL
      SELECT * FROM wanted_video_targets
    )
    SELECT *
    FROM wanted_targets
    ${where}
  `;
}

function mapWantedRow(row: WantedRow): WantedItem {
  return {
    id: `${row.item_type}:${String(row.source_id)}`,
    type: row.item_type,
    monitorScope: row.monitor_scope,
    sourceId: String(row.source_id),
    artistId: row.artist_id == null ? null : String(row.artist_id),
    artistName: row.artist_name,
    albumId: row.album_id == null ? null : String(row.album_id),
    albumTitle: row.album_title,
    title: row.title,
    quality: row.quality,
    cover: row.cover,
    queueStatus: row.job_status === "processing" ? "processing" : row.job_status === "pending" ? "queued" : "missing",
    activeJobId: row.job_id ?? null,
    monitorLocked: Number(row.monitor_locked || 0) === 1,
    reason: row.reason,
  };
}
