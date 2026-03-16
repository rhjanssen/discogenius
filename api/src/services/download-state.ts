import { db } from "../database.js";
import { buildArtistCompletionPredicate } from "./managed-artists.js";

const CACHE_TTL_MS = 30_000;

export type DownloadableFileType = "track" | "video";

export interface AlbumDownloadStats {
  albumId: string;
  totalTracks: number;
  downloadedTracks: number;
  downloadedPercent: number;
  isDownloaded: boolean;
}

export interface ArtistDownloadStats {
  artistId: string;
  totalItems: number;
  downloadedItems: number;
  downloadedPercent: number;
  isDownloaded: boolean;
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const albumStatsCache = new Map<string, CacheEntry<AlbumDownloadStats>>();
const artistStatsCache = new Map<string, CacheEntry<ArtistDownloadStats>>();
const mediaDownloadCache = new Map<string, CacheEntry<boolean>>();

function now() {
  return Date.now();
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now()) {
    cache.delete(key);
    return undefined;
  }

  return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
}

function uniqueIds(ids: Array<string | number>) {
  return Array.from(new Set(ids.map((id) => String(id)).filter(Boolean)));
}

function mediaCacheKey(mediaId: string, fileType: DownloadableFileType) {
  return `${fileType}:${mediaId}`;
}

function toAlbumStats(albumId: string, totalTracks: number, downloadedTracks: number): AlbumDownloadStats {
  const normalizedTotalTracks = Math.max(0, totalTracks);
  const normalizedDownloadedTracks = Math.max(0, downloadedTracks);
  const downloadedPercent = normalizedTotalTracks > 0
    ? Math.min(100, Math.round((normalizedDownloadedTracks / normalizedTotalTracks) * 100))
    : 0;

  return {
    albumId,
    totalTracks: normalizedTotalTracks,
    downloadedTracks: normalizedDownloadedTracks,
    downloadedPercent,
    isDownloaded: normalizedTotalTracks > 0 && normalizedDownloadedTracks >= normalizedTotalTracks,
  };
}

function toArtistStats(artistId: string, totalItems: number, downloadedItems: number): ArtistDownloadStats {
  const normalizedTotalItems = Math.max(0, totalItems);
  const normalizedDownloadedItems = Math.max(0, downloadedItems);
  const downloadedPercent = normalizedTotalItems > 0
    ? Math.min(100, Math.round((normalizedDownloadedItems / normalizedTotalItems) * 100))
    : 0;

  return {
    artistId,
    totalItems: normalizedTotalItems,
    downloadedItems: normalizedDownloadedItems,
    downloadedPercent,
    isDownloaded: normalizedTotalItems > 0 && normalizedDownloadedItems >= normalizedTotalItems,
  };
}

export function invalidateAlbumDownloadStatus(albumId: string): void {
  if (!albumId) return;
  albumStatsCache.delete(String(albumId));
}

export function invalidateArtistDownloadStatus(artistId: string): void {
  if (!artistId) return;
  artistStatsCache.delete(String(artistId));
}

export function invalidateMediaDownloadState(mediaId: string): void {
  if (!mediaId) return;
  mediaDownloadCache.delete(mediaCacheKey(String(mediaId), "track"));
  mediaDownloadCache.delete(mediaCacheKey(String(mediaId), "video"));
}

export function invalidateAllDownloadState(): void {
  albumStatsCache.clear();
  artistStatsCache.clear();
  mediaDownloadCache.clear();
}

export function getMediaDownloadStateMap(
  mediaIds: Array<string | number>,
  fileType: DownloadableFileType,
): Map<string, boolean> {
  const ids = uniqueIds(mediaIds);
  const result = new Map<string, boolean>();
  const missing: string[] = [];

  for (const id of ids) {
    const cached = getCached(mediaDownloadCache, mediaCacheKey(id, fileType));
    if (cached !== undefined) {
      result.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const placeholders = missing.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT DISTINCT CAST(media_id AS TEXT) AS media_id
      FROM library_files
      WHERE file_type = ?
        AND media_id IN (${placeholders})
    `).all(fileType, ...missing) as Array<{ media_id: string }>;

    const downloadedIds = new Set(rows.map((row) => String(row.media_id)));
    for (const id of missing) {
      const isDownloaded = downloadedIds.has(id);
      setCached(mediaDownloadCache, mediaCacheKey(id, fileType), isDownloaded);
      result.set(id, isDownloaded);
    }
  }

  return result;
}

export function isMediaDownloaded(mediaId: string | number, fileType: DownloadableFileType): boolean {
  return getMediaDownloadStateMap([mediaId], fileType).get(String(mediaId)) ?? false;
}

export function getAlbumDownloadStatsMap(albumIds: Array<string | number>): Map<string, AlbumDownloadStats> {
  const ids = uniqueIds(albumIds);
  const result = new Map<string, AlbumDownloadStats>();
  const missing: string[] = [];

  for (const id of ids) {
    const cached = getCached(albumStatsCache, id);
    if (cached) {
      result.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const placeholders = missing.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        CAST(m.album_id AS TEXT) AS album_id,
        COUNT(DISTINCT m.id) AS total_tracks,
        COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN m.id END) AS downloaded_tracks
      FROM media m
      LEFT JOIN library_files lf
        ON lf.media_id = m.id
       AND lf.file_type = 'track'
      WHERE m.album_id IN (${placeholders})
        AND m.type != 'Music Video'
      GROUP BY m.album_id
    `).all(...missing) as Array<{
      album_id: string;
      total_tracks: number;
      downloaded_tracks: number;
    }>;

    const statsByAlbumId = new Map(rows.map((row) => [String(row.album_id), row]));

    for (const albumId of missing) {
      const row = statsByAlbumId.get(albumId);
      const stats = toAlbumStats(
        albumId,
        Number(row?.total_tracks || 0),
        Number(row?.downloaded_tracks || 0),
      );
      setCached(albumStatsCache, albumId, stats);
      result.set(albumId, stats);
    }
  }

  return result;
}

export function getAlbumDownloadStats(albumId: string | number): AlbumDownloadStats {
  return getAlbumDownloadStatsMap([albumId]).get(String(albumId)) ?? toAlbumStats(String(albumId), 0, 0);
}

export function getArtistDownloadStatsMap(artistIds: Array<string | number>): Map<string, ArtistDownloadStats> {
  const ids = uniqueIds(artistIds);
  const result = new Map<string, ArtistDownloadStats>();
  const missing: string[] = [];

  for (const id of ids) {
    const cached = getCached(artistStatsCache, id);
    if (cached) {
      result.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const values = missing.map(() => "(?)").join(", ");
    const rows = db.prepare(`
      WITH target_artists(artist_id) AS (
        VALUES ${values}
      ),
      monitored_albums AS (
        SELECT
          CAST(aa.artist_id AS TEXT) AS artist_id,
          CAST(al.id AS TEXT) AS album_id,
          COUNT(DISTINCT m.id) AS total_tracks,
          COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN m.id END) AS downloaded_tracks
        FROM album_artists aa
        JOIN albums al ON al.id = aa.album_id
        LEFT JOIN media m
          ON m.album_id = al.id
         AND m.type != 'Music Video'
        LEFT JOIN library_files lf
          ON lf.media_id = m.id
         AND lf.file_type = 'track'
        WHERE CAST(aa.artist_id AS TEXT) IN (SELECT artist_id FROM target_artists)
          AND (
            al.monitor = 1
            OR COALESCE(al.monitor_lock, 0) = 1
          )
        GROUP BY aa.artist_id, al.id
      ),
      monitored_media AS (
        SELECT
          CAST(m.artist_id AS TEXT) AS artist_id,
          CAST(m.id AS TEXT) AS media_id,
          CASE WHEN EXISTS (
            SELECT 1
            FROM library_files lf
            WHERE lf.media_id = m.id
              AND lf.file_type = CASE WHEN m.type = 'Music Video' THEN 'video' ELSE 'track' END
          ) THEN 1 ELSE 0 END AS is_downloaded
        FROM media m
        LEFT JOIN albums al ON al.id = m.album_id
        WHERE CAST(m.artist_id AS TEXT) IN (SELECT artist_id FROM target_artists)
          AND (
            m.monitor = 1
            OR COALESCE(m.monitor_lock, 0) = 1
          )
          AND (
            m.type = 'Music Video'
            OR al.id IS NULL
            OR NOT (
              COALESCE(al.monitor, 0) = 1
              OR COALESCE(al.monitor_lock, 0) = 1
            )
          )
      ),
      album_totals AS (
        SELECT
          artist_id,
          COUNT(*) AS total_album_items,
          SUM(CASE WHEN total_tracks > 0 AND downloaded_tracks >= total_tracks THEN 1 ELSE 0 END) AS downloaded_album_items
        FROM monitored_albums
        GROUP BY artist_id
      ),
      media_totals AS (
        SELECT
          artist_id,
          COUNT(*) AS total_media_items,
          SUM(is_downloaded) AS downloaded_media_items
        FROM monitored_media
        GROUP BY artist_id
      )
      SELECT
        ta.artist_id AS artist_id,
        COALESCE(at.total_album_items, 0) + COALESCE(mt.total_media_items, 0) AS total_items,
        COALESCE(at.downloaded_album_items, 0) + COALESCE(mt.downloaded_media_items, 0) AS downloaded_items
      FROM target_artists ta
      LEFT JOIN album_totals at ON at.artist_id = ta.artist_id
      LEFT JOIN media_totals mt ON mt.artist_id = ta.artist_id
    `).all(...missing) as Array<{
      artist_id: string;
      total_items: number;
      downloaded_items: number;
    }>;

    const statsByArtistId = new Map(rows.map((row) => [String(row.artist_id), row]));
    for (const artistId of missing) {
      const row = statsByArtistId.get(artistId);
      const stats = toArtistStats(
        artistId,
        Number(row?.total_items || 0),
        Number(row?.downloaded_items || 0),
      );
      setCached(artistStatsCache, artistId, stats);
      result.set(artistId, stats);
    }
  }

  return result;
}

export function getArtistDownloadStats(artistId: string | number): ArtistDownloadStats {
  return getArtistDownloadStatsMap([artistId]).get(String(artistId)) ?? toArtistStats(String(artistId), 0, 0);
}

export function countDownloadedAlbums(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM albums a
    WHERE (a.monitor = 1 OR COALESCE(a.monitor_lock, 0) = 1)
      AND EXISTS (
        SELECT 1
        FROM media m
        WHERE m.album_id = a.id
          AND m.type != 'Music Video'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM media m
        WHERE m.album_id = a.id
          AND m.type != 'Music Video'
          AND NOT EXISTS (
            SELECT 1
            FROM library_files lf
            WHERE lf.media_id = m.id
              AND lf.file_type = 'track'
          )
      )
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedTracks(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media m
    WHERE m.album_id IS NOT NULL
      AND (m.monitor = 1 OR COALESCE(m.monitor_lock, 0) = 1)
      AND EXISTS (
        SELECT 1
        FROM library_files lf
        WHERE lf.media_id = m.id
          AND lf.file_type = 'track'
      )
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedVideos(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media m
    WHERE m.type = 'Music Video'
      AND (m.monitor = 1 OR COALESCE(m.monitor_lock, 0) = 1)
      AND EXISTS (
        SELECT 1
        FROM library_files lf
        WHERE lf.media_id = m.id
          AND lf.file_type = 'video'
      )
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedManagedArtists(): number {
  const completionPredicate = buildArtistCompletionPredicate("a");
  const row = db.prepare(`
    WITH target_artists AS (
      SELECT CAST(a.id AS TEXT) AS artist_id
      FROM artists a
      WHERE ${completionPredicate}
    ),
    monitored_albums AS (
      SELECT
        CAST(aa.artist_id AS TEXT) AS artist_id,
        CAST(al.id AS TEXT) AS album_id,
        COUNT(DISTINCT m.id) AS total_tracks,
        COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN m.id END) AS downloaded_tracks
      FROM album_artists aa
      JOIN albums al ON al.id = aa.album_id
      LEFT JOIN media m
        ON m.album_id = al.id
       AND m.type != 'Music Video'
      LEFT JOIN library_files lf
        ON lf.media_id = m.id
       AND lf.file_type = 'track'
      WHERE CAST(aa.artist_id AS TEXT) IN (SELECT artist_id FROM target_artists)
        AND (
          al.monitor = 1
          OR COALESCE(al.monitor_lock, 0) = 1
        )
      GROUP BY aa.artist_id, al.id
    ),
    monitored_media AS (
      SELECT
        CAST(m.artist_id AS TEXT) AS artist_id,
        CAST(m.id AS TEXT) AS media_id,
        CASE WHEN EXISTS (
          SELECT 1
          FROM library_files lf
          WHERE lf.media_id = m.id
            AND lf.file_type = CASE WHEN m.type = 'Music Video' THEN 'video' ELSE 'track' END
        ) THEN 1 ELSE 0 END AS is_downloaded
      FROM media m
      LEFT JOIN albums al ON al.id = m.album_id
      WHERE CAST(m.artist_id AS TEXT) IN (SELECT artist_id FROM target_artists)
        AND (
          m.monitor = 1
          OR COALESCE(m.monitor_lock, 0) = 1
        )
        AND (
          m.type = 'Music Video'
          OR al.id IS NULL
          OR NOT (
            COALESCE(al.monitor, 0) = 1
            OR COALESCE(al.monitor_lock, 0) = 1
          )
        )
    ),
    album_totals AS (
      SELECT
        artist_id,
        COUNT(*) AS total_album_items,
        SUM(CASE WHEN total_tracks > 0 AND downloaded_tracks >= total_tracks THEN 1 ELSE 0 END) AS downloaded_album_items
      FROM monitored_albums
      GROUP BY artist_id
    ),
    media_totals AS (
      SELECT
        artist_id,
        COUNT(*) AS total_media_items,
        SUM(is_downloaded) AS downloaded_media_items
      FROM monitored_media
      GROUP BY artist_id
    ),
    artist_progress AS (
      SELECT
        ta.artist_id,
        COALESCE(at.total_album_items, 0) + COALESCE(mt.total_media_items, 0) AS total_items,
        COALESCE(at.downloaded_album_items, 0) + COALESCE(mt.downloaded_media_items, 0) AS downloaded_items
      FROM target_artists ta
      LEFT JOIN album_totals at ON at.artist_id = ta.artist_id
      LEFT JOIN media_totals mt ON mt.artist_id = ta.artist_id
    )
    SELECT COUNT(*) AS count
    FROM artist_progress
    WHERE total_items > 0
      AND downloaded_items >= total_items
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function updateAlbumDownloadStatus(albumId: string): void {
  if (!albumId) return;
  invalidateAlbumDownloadStatus(albumId);
  updateArtistDownloadStatusFromAlbum(albumId);
}

export function updateArtistDownloadStatus(artistId: string): void {
  if (!artistId) return;
  invalidateArtistDownloadStatus(artistId);
}

export function updateArtistDownloadStatusFromAlbum(albumId: string): void {
  if (!albumId) return;

  invalidateAlbumDownloadStatus(albumId);

  const artistIds = db.prepare(`
    SELECT DISTINCT CAST(artist_id AS TEXT) AS artist_id
    FROM album_artists
    WHERE album_id = ?
  `).all(albumId) as Array<{ artist_id: string }>;

  for (const row of artistIds) {
    invalidateArtistDownloadStatus(String(row.artist_id));
  }
}

export function updateArtistDownloadStatusFromMedia(mediaId: string): void {
  if (!mediaId) return;

  invalidateMediaDownloadState(mediaId);

  const media = db.prepare(`
    SELECT artist_id, album_id
    FROM media
    WHERE id = ?
  `).get(mediaId) as { artist_id?: number | null; album_id?: number | null } | undefined;

  if (!media) return;

  if (media.album_id) {
    updateArtistDownloadStatusFromAlbum(String(media.album_id));
  }

  if (media.artist_id) {
    invalidateArtistDownloadStatus(String(media.artist_id));
  }
}
