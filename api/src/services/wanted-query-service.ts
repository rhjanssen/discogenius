import { db } from "../database.js";
import { JobTypes } from "./queue.js";
import type { DiscogeniusLibraryType } from "./lidarr-domain-schema.js";

export type WantedItemType = "album" | "video";
export type WantedQueueStatus = "missing" | "queued" | "processing" | "unavailable";
export type WantedMonitorScope = "release" | "video";

export interface WantedItem {
  id: string;
  type: WantedItemType;
  monitorScope: WantedMonitorScope;
  sourceId: string;
  artistId: string | null;
  artistName: string | null;
  albumId: string | null;
  albumReleaseId: string | null;
  albumTitle: string | null;
  title: string;
  libraryType: DiscogeniusLibraryType;
  quality: string | null;
  cover: string | null;
  provider: string | null;
  providerItemId: string | null;
  queueStatus: WantedQueueStatus;
  activeJobId: number | null;
  monitorLocked: boolean;
  reason: string;
}

export interface WantedListInput {
  artistId?: string;
  type?: WantedItemType;
  libraryType?: DiscogeniusLibraryType;
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
  library_type: DiscogeniusLibraryType;
  source_id: string | number;
  artist_id: string | number | null;
  artist_name: string | null;
  album_id: string | number | null;
  album_release_id: string | number | null;
  album_title: string | null;
  title: string;
  quality: string | null;
  cover: string | null;
  provider: string | null;
  provider_item_id: string | null;
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

  if (input.libraryType) {
    params.push(input.libraryType);
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

  if (input.libraryType) {
    clauses.push("library_type = ?");
  }

  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function buildWantedSql(where: string): string {
  return `
    WITH selected_release_stats AS (
      SELECT
        rgm.release_group_id,
        rgm.library_type,
        rgm.selected_release_id,
        COUNT(t.id) AS total_tracks,
        SUM(CASE WHEN t.id IS NOT NULL AND tf.id IS NULL THEN 1 ELSE 0 END) AS missing_tracks,
        COUNT(tf.id) AS imported_tracks
      FROM release_group_monitoring rgm
      LEFT JOIN tracks t
        ON t.album_release_id = rgm.selected_release_id
      LEFT JOIN track_files tf
        ON tf.track_id = t.id
       AND tf.library_type = rgm.library_type
      GROUP BY rgm.release_group_id, rgm.library_type, rgm.selected_release_id
    ),
    ranked_provider_releases AS (
      SELECT
        pr.*,
        ROW_NUMBER() OVER (
          PARTITION BY pr.album_release_id, pr.library_type
          ORDER BY
            COALESCE(pr.confidence, 0) DESC,
            COALESCE(pr.score, 0) DESC,
            COALESCE(pr.track_count, 0) DESC,
            pr.fetched_at DESC
        ) AS provider_rank
      FROM provider_releases pr
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
    ranked_provider_videos AS (
      SELECT
        pv.*,
        ROW_NUMBER() OVER (
          PARTITION BY pv.video_id
          ORDER BY
            CASE WHEN pv.streamable = 1 THEN 0 ELSE 1 END,
            pv.fetched_at DESC
        ) AS provider_rank
      FROM provider_videos pv
    ),
    wanted_release_targets AS (
      SELECT
        'album' AS item_type,
        'release' AS monitor_scope,
        rgm.library_type AS library_type,
        1 AS type_sort,
        COALESCE(pr.provider_release_id, CAST(ar.id AS TEXT)) AS source_id,
        CAST(ma.id AS TEXT) AS artist_id,
        am.name AS artist_name,
        CAST(rg.id AS TEXT) AS album_id,
        CAST(ar.id AS TEXT) AS album_release_id,
        rg.title AS album_title,
        ar.title AS title,
        pr.quality AS quality,
        NULL AS cover,
        pr.provider AS provider,
        pr.provider_release_id AS provider_item_id,
        aj.job_id AS job_id,
        aj.job_status AS job_status,
        COALESCE(rgm.monitor_lock, 0) AS monitor_locked,
        CASE
          WHEN rgm.selected_release_id IS NULL THEN 'monitored release group has no selected MusicBrainz release'
          WHEN pr.provider_release_id IS NULL THEN 'selected MusicBrainz release needs provider availability'
          WHEN COALESCE(s.total_tracks, 0) = 0 THEN 'selected MusicBrainz release has no track list'
          ELSE 'selected monitored release is missing from the library'
        END AS reason
      FROM release_group_monitoring rgm
      JOIN release_groups rg ON rg.id = rgm.release_group_id
      JOIN artist_metadata am ON am.id = rg.artist_metadata_id
      LEFT JOIN managed_artists ma ON ma.artist_metadata_id = am.id
      LEFT JOIN album_releases ar ON ar.id = rgm.selected_release_id
      LEFT JOIN selected_release_stats s
        ON s.release_group_id = rgm.release_group_id
       AND s.library_type = rgm.library_type
       AND (
         s.selected_release_id = rgm.selected_release_id
         OR (s.selected_release_id IS NULL AND rgm.selected_release_id IS NULL)
       )
      LEFT JOIN ranked_provider_releases pr
        ON pr.album_release_id = rgm.selected_release_id
       AND pr.library_type = rgm.library_type
       AND pr.provider_rank = 1
      LEFT JOIN active_album_jobs aj
        ON aj.ref_id = COALESCE(pr.provider_release_id, CAST(ar.id AS TEXT))
      WHERE rg.monitored = 1
        AND rgm.monitored = 1
        AND COALESCE(ma.monitored, 1) = 1
        AND COALESCE(rgm.redundancy_state, 'selected') != 'redundant'
        AND (
          rgm.selected_release_id IS NULL
          OR pr.provider_release_id IS NULL
          OR COALESCE(s.total_tracks, 0) = 0
          OR COALESCE(s.missing_tracks, 0) > 0
        )
    ),
    wanted_video_targets AS (
      SELECT
        'video' AS item_type,
        'video' AS monitor_scope,
        'video' AS library_type,
        3 AS type_sort,
        COALESCE(pv.provider_video_id, CAST(v.id AS TEXT)) AS source_id,
        CAST(ma.id AS TEXT) AS artist_id,
        am.name AS artist_name,
        NULL AS album_id,
        NULL AS album_release_id,
        NULL AS album_title,
        v.title AS title,
        pv.quality AS quality,
        NULL AS cover,
        pv.provider AS provider,
        pv.provider_video_id AS provider_item_id,
        aj.job_id AS job_id,
        aj.job_status AS job_status,
        COALESCE(v.monitor_lock, 0) AS monitor_locked,
        CASE
          WHEN pv.provider_video_id IS NULL THEN 'monitored video needs provider availability'
          ELSE 'monitored video is missing from the library'
        END AS reason
      FROM videos v
      JOIN artist_metadata am ON am.id = v.artist_metadata_id
      LEFT JOIN managed_artists ma ON ma.artist_metadata_id = am.id
      LEFT JOIN video_files vf ON vf.video_id = v.id
      LEFT JOIN ranked_provider_videos pv
        ON pv.video_id = v.id
       AND pv.provider_rank = 1
      LEFT JOIN active_video_jobs aj
        ON aj.ref_id = COALESCE(pv.provider_video_id, CAST(v.id AS TEXT))
      WHERE v.monitored = 1
        AND COALESCE(ma.monitored, 1) = 1
        AND vf.id IS NULL
    )
    SELECT *
    FROM (
      SELECT * FROM wanted_release_targets
      UNION ALL
      SELECT * FROM wanted_video_targets
    ) wanted_union
    ${where}
  `;
}

function mapWantedRow(row: WantedRow): WantedItem {
  const providerItemId = row.provider_item_id ? String(row.provider_item_id) : null;
  const sourceId = String(row.source_id);

  return {
    id: `${row.item_type}:${row.library_type}:${sourceId}`,
    type: row.item_type,
    monitorScope: row.monitor_scope,
    sourceId,
    artistId: row.artist_id === null || row.artist_id === undefined ? null : String(row.artist_id),
    artistName: row.artist_name,
    albumId: row.album_id === null || row.album_id === undefined ? null : String(row.album_id),
    albumReleaseId: row.album_release_id === null || row.album_release_id === undefined ? null : String(row.album_release_id),
    albumTitle: row.album_title,
    title: row.title,
    libraryType: row.library_type,
    quality: row.quality,
    cover: row.cover,
    provider: row.provider,
    providerItemId,
    queueStatus: mapQueueStatus(row, providerItemId),
    activeJobId: row.job_id ?? null,
    monitorLocked: Boolean(row.monitor_locked),
    reason: row.reason,
  };
}

function mapQueueStatus(row: WantedRow, providerItemId: string | null): WantedQueueStatus {
  if (row.job_status === "processing") {
    return "processing";
  }

  if (row.job_status === "pending") {
    return "queued";
  }

  if (!providerItemId) {
    return "unavailable";
  }

  return "missing";
}
