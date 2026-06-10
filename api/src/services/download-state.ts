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

function releaseGroupCacheKey(releaseGroupMbid: string, slot?: string | null) {
  return `release-group:${slot || "any"}:${releaseGroupMbid}`;
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
  invalidateReleaseGroupDownloadStatus(String(albumId));
}

export function invalidateReleaseGroupDownloadStatus(releaseGroupMbid: string): void {
  if (!releaseGroupMbid) return;
  for (const key of Array.from(albumStatsCache.keys())) {
    if (key.endsWith(`:${releaseGroupMbid}`)) {
      albumStatsCache.delete(key);
    }
  }
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
    const values = missing.map(() => "(?)").join(", ");
    const rows = db.prepare(`
      WITH target_ids(id) AS (
        VALUES ${values}
      )
      SELECT
        CAST(target_ids.id AS TEXT) AS id,
        CASE WHEN EXISTS (
          SELECT 1
          FROM TrackFiles lf
          WHERE lf.file_type = ?
            AND (
              CAST(lf.media_id AS TEXT) = CAST(target_ids.id AS TEXT)
              OR CAST(lf.provider_id AS TEXT) = CAST(target_ids.id AS TEXT)
              OR (? = 'track' AND lf.canonical_track_mbid = CAST(target_ids.id AS TEXT))
              OR lf.canonical_recording_mbid = CAST(target_ids.id AS TEXT)
              OR CAST(lf.canonical_recording_mbid AS TEXT) = (
                SELECT r.mbid
                FROM Recordings r
                WHERE CAST(r.Id AS TEXT) = CAST(target_ids.id AS TEXT)
                LIMIT 1
              )
            )
        ) THEN 1 ELSE 0 END AS downloaded
      FROM target_ids
    `).all(...missing, fileType, fileType) as Array<{ id: string; downloaded: number }>;

    const downloadedById = new Map(rows.map((row) => [String(row.id), Boolean(row.downloaded)]));
    for (const id of missing) {
      const isDownloaded = downloadedById.get(id) ?? false;
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
    const canonicalValues = missing.map(() => "(?)").join(", ");
    const canonicalRows = db.prepare(`
      WITH target_release_groups(release_group_mbid) AS (
        VALUES ${canonicalValues}
      ),
      selected_releases AS (
        SELECT
          rgs.release_group_mbid,
          rgs.slot,
          rgs.selected_release_mbid AS release_mbid
        FROM target_release_groups trg
        JOIN ReleaseGroupSlots rgs
          ON rgs.release_group_mbid = trg.release_group_mbid
         AND rgs.slot IN ('stereo', 'spatial')
         AND rgs.selected_release_mbid IS NOT NULL
      )
      SELECT
        sr.release_group_mbid AS album_id,
        COUNT(DISTINCT sr.slot || ':' || t.mbid) AS total_tracks,
        COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN sr.slot || ':' || t.mbid END) AS downloaded_tracks
      FROM selected_releases sr
      LEFT JOIN Tracks t
        ON t.release_mbid = sr.release_mbid
      LEFT JOIN Recordings r
        ON r.mbid = t.recording_mbid
      LEFT JOIN TrackFiles lf
        ON (
          lf.canonical_track_mbid = t.mbid
          OR (
            lf.canonical_track_mbid IS NULL
            AND lf.canonical_recording_mbid = t.recording_mbid
          )
        )
       AND lf.file_type = 'track'
       AND lf.library_slot = sr.slot
      WHERE COALESCE(r.IsVideo, 0) = 0
      GROUP BY sr.release_group_mbid
    `).all(...missing) as Array<{
      album_id: string;
      total_tracks: number;
      downloaded_tracks: number;
    }>;

    const statsByAlbumId = new Map(canonicalRows.map((row) => [String(row.album_id), row]));

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

export function getReleaseGroupDownloadStatsMap(
  releaseGroupMbids: Array<string | number>,
  slot?: "stereo" | "spatial" | "video" | null,
): Map<string, AlbumDownloadStats> {
  const ids = uniqueIds(releaseGroupMbids);
  const result = new Map<string, AlbumDownloadStats>();
  const missing: string[] = [];

  for (const id of ids) {
    const cached = getCached(albumStatsCache, releaseGroupCacheKey(id, slot));
    if (cached) {
      result.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const values = missing.map(() => "(?)").join(", ");
    const normalizedSlot = slot === "spatial" ? "spatial" : slot === "video" ? "video" : slot === "stereo" ? "stereo" : null;
    const slotPredicate = normalizedSlot
      ? `AND rgs.slot = '${normalizedSlot}'`
      : "AND rgs.slot IN ('stereo', 'spatial')";
    const rows = db.prepare(`
      WITH target_release_groups(release_group_mbid) AS (
        VALUES ${values}
      ),
      selected_releases AS (
        SELECT
          rgs.release_group_mbid,
          rgs.slot,
          rgs.selected_release_mbid AS release_mbid
        FROM target_release_groups trg
        JOIN ReleaseGroupSlots rgs
          ON rgs.release_group_mbid = trg.release_group_mbid
         ${slotPredicate}
         AND rgs.selected_release_mbid IS NOT NULL
      )
      SELECT
        sr.release_group_mbid,
        COUNT(DISTINCT sr.slot || ':' || t.mbid) AS total_tracks,
        COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN sr.slot || ':' || t.mbid END) AS downloaded_tracks
      FROM selected_releases sr
      LEFT JOIN Tracks t
        ON t.release_mbid = sr.release_mbid
      LEFT JOIN TrackFiles lf
        ON (
          lf.canonical_track_mbid = t.mbid
          OR (
            lf.canonical_track_mbid IS NULL
            AND lf.canonical_recording_mbid = t.recording_mbid
          )
        )
       AND lf.file_type = 'track'
       AND lf.library_slot = sr.slot
      GROUP BY sr.release_group_mbid
    `).all(...missing) as Array<{
      release_group_mbid: string;
      total_tracks: number;
      downloaded_tracks: number;
    }>;

    const statsByReleaseGroup = new Map(rows.map((row) => [String(row.release_group_mbid), row]));
    for (const releaseGroupMbid of missing) {
      const row = statsByReleaseGroup.get(releaseGroupMbid);
      const stats = toAlbumStats(
        releaseGroupMbid,
        Number(row?.total_tracks || 0),
        Number(row?.downloaded_tracks || 0),
      );
      setCached(albumStatsCache, releaseGroupCacheKey(releaseGroupMbid, slot), stats);
      result.set(releaseGroupMbid, stats);
    }
  }

  return result;
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
      WITH input_artists(input_id) AS (
        VALUES ${values}
      ),
      target_artists AS (
        SELECT
          CAST(input_artists.input_id AS TEXT) AS input_id,
          CAST(managed_artist.id AS TEXT) AS artist_id,
          COALESCE(managed_artist.mbid, artist_metadata.mbid, CAST(input_artists.input_id AS TEXT)) AS artist_mbid,
          artist_metadata.Id AS artist_metadata_id
        FROM input_artists
        LEFT JOIN Artists managed_artist
          ON CAST(managed_artist.id AS TEXT) = CAST(input_artists.input_id AS TEXT)
          OR managed_artist.mbid = CAST(input_artists.input_id AS TEXT)
        LEFT JOIN ArtistMetadata artist_metadata
          ON artist_metadata.mbid = COALESCE(managed_artist.mbid, CAST(input_artists.input_id AS TEXT))
          OR CAST(artist_metadata.Id AS TEXT) = CAST(input_artists.input_id AS TEXT)
      ),
      monitored_release_slots AS (
        SELECT
          target_artists.input_id,
          rgs.release_group_mbid,
          rgs.slot,
          rgs.selected_release_mbid
        FROM target_artists
        JOIN ReleaseGroupSlots rgs
          ON rgs.artist_mbid = target_artists.artist_mbid
        WHERE (rgs.monitored = 1 OR COALESCE(rgs.monitored_lock, 0) = 1)
          AND rgs.slot IN ('stereo', 'spatial')
          AND rgs.selected_release_mbid IS NOT NULL
      ),
      release_slot_stats AS (
        SELECT
          mrs.input_id,
          mrs.release_group_mbid,
          mrs.slot,
          COUNT(DISTINCT track.mbid) AS total_tracks,
          COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN track.mbid END) AS downloaded_tracks
        FROM monitored_release_slots mrs
        LEFT JOIN Tracks track
          ON track.release_mbid = mrs.selected_release_mbid
        LEFT JOIN Recordings recording
          ON recording.mbid = track.recording_mbid
        LEFT JOIN TrackFiles lf
          ON (
            lf.canonical_track_mbid = track.mbid
            OR (
              lf.canonical_track_mbid IS NULL
              AND lf.canonical_recording_mbid = track.recording_mbid
            )
          )
         AND lf.file_type = 'track'
         AND lf.library_slot = mrs.slot
        WHERE COALESCE(recording.IsVideo, 0) = 0
        GROUP BY mrs.input_id, mrs.release_group_mbid, mrs.slot
      ),
      monitored_videos AS (
        SELECT
          target_artists.input_id,
          recording.Id AS recording_id,
          CASE WHEN EXISTS (
            SELECT 1
            FROM TrackFiles lf
            WHERE lf.file_type = 'video'
              AND (
                (recording.mbid IS NOT NULL AND lf.canonical_recording_mbid = recording.mbid)
                OR CAST(lf.provider_id AS TEXT) IN (
                  SELECT CAST(pi.provider_id AS TEXT)
                  FROM ProviderItems pi
                  WHERE pi.entity_type = 'video'
                    AND (
                      pi.recording_id = recording.Id
                      OR (recording.mbid IS NOT NULL AND pi.recording_mbid = recording.mbid)
                    )
                )
              )
          ) THEN 1 ELSE 0 END AS is_downloaded
        FROM target_artists
        JOIN Recordings recording
          ON recording.IsVideo = 1
         AND (COALESCE(recording.Monitored, 0) = 1 OR COALESCE(recording.MonitoredLock, 0) = 1)
         AND (
          recording.artist_mbid = target_artists.artist_mbid
          OR (
            target_artists.artist_metadata_id IS NOT NULL
            AND recording.ArtistMetadataId = target_artists.artist_metadata_id
          )
         )
      )
      SELECT
        target_artists.input_id AS artist_id,
        COALESCE((
          SELECT COUNT(*)
          FROM release_slot_stats rss
          WHERE rss.input_id = target_artists.input_id
        ), 0) + COALESCE((
          SELECT COUNT(*)
          FROM monitored_videos mv
          WHERE mv.input_id = target_artists.input_id
        ), 0) AS total_items,
        COALESCE((
          SELECT SUM(CASE WHEN rss.total_tracks > 0 AND rss.downloaded_tracks >= rss.total_tracks THEN 1 ELSE 0 END)
          FROM release_slot_stats rss
          WHERE rss.input_id = target_artists.input_id
        ), 0) + COALESCE((
          SELECT SUM(mv.is_downloaded)
          FROM monitored_videos mv
          WHERE mv.input_id = target_artists.input_id
        ), 0) AS downloaded_items
      FROM target_artists
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
    FROM (
      SELECT
        rgs.release_group_mbid,
        rgs.slot,
        COUNT(DISTINCT t.mbid) AS total_tracks,
        COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN t.mbid END) AS downloaded_tracks
      FROM ReleaseGroupSlots rgs
      JOIN Tracks t
        ON t.release_mbid = rgs.selected_release_mbid
      LEFT JOIN TrackFiles lf
        ON (
          lf.canonical_track_mbid = t.mbid
          OR (
            lf.canonical_track_mbid IS NULL
            AND lf.canonical_recording_mbid = t.recording_mbid
          )
        )
       AND lf.file_type = 'track'
       AND lf.library_slot = rgs.slot
      WHERE rgs.slot IN ('stereo', 'spatial')
        AND rgs.selected_release_mbid IS NOT NULL
      GROUP BY rgs.release_group_mbid, rgs.slot
    ) slot_stats
    WHERE total_tracks > 0
      AND downloaded_tracks >= total_tracks
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedTracks(): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT rgs.release_group_mbid || ':' || rgs.slot || ':' || t.mbid) AS count
    FROM ReleaseGroupSlots rgs
    JOIN Tracks t
      ON t.release_mbid = rgs.selected_release_mbid
    JOIN TrackFiles lf
      ON (
        lf.canonical_track_mbid = t.mbid
        OR (
          lf.canonical_track_mbid IS NULL
          AND lf.canonical_recording_mbid = t.recording_mbid
        )
      )
     AND lf.file_type = 'track'
     AND lf.library_slot = rgs.slot
    WHERE rgs.slot IN ('stereo', 'spatial')
      AND rgs.selected_release_mbid IS NOT NULL
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedVideos(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM TrackFiles
    WHERE file_type = 'video'
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedManagedArtists(): number {
  const completionPredicate = buildArtistCompletionPredicate("a");
  const rows = db.prepare(`
    SELECT CAST(a.id AS TEXT) AS artist_id
    FROM Artists a
    WHERE ${completionPredicate}
  `).all() as Array<{ artist_id: string }>;
  if (rows.length === 0) {
    return 0;
  }

  const stats = getArtistDownloadStatsMap(rows.map((row) => row.artist_id));
  let count = 0;
  for (const row of rows) {
    if (stats.get(String(row.artist_id))?.isDownloaded) {
      count++;
    }
  }

  return count;
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

  const canonicalArtistIds = db.prepare(`
    SELECT DISTINCT CAST(a.id AS TEXT) AS artist_id
    FROM Albums rg
    LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
    WHERE rg.mbid = ?
    UNION
    SELECT DISTINCT CAST(a.id AS TEXT) AS artist_id
    FROM ReleaseGroupSlots rgs
    LEFT JOIN Artists a ON a.mbid = rgs.artist_mbid
    WHERE rgs.release_group_mbid = ?
      AND a.id IS NOT NULL
  `).all(albumId, albumId) as Array<{ artist_id: string | null }>;

  for (const row of canonicalArtistIds) {
    if (row.artist_id) {
      invalidateArtistDownloadStatus(String(row.artist_id));
    }
  }
}

export function updateArtistDownloadStatusFromMedia(mediaId: string): void {
  if (!mediaId) return;

  invalidateMediaDownloadState(mediaId);

  const canonicalRows = db.prepare(`
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      rg.mbid AS release_group_mbid
    FROM ProviderItems pi
    LEFT JOIN Artists a ON a.mbid = pi.artist_mbid
    LEFT JOIN Albums rg ON rg.mbid = pi.release_group_mbid
    WHERE CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
      AND pi.entity_type IN ('track', 'video')
    UNION
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      release_group.mbid AS release_group_mbid
    FROM Tracks track
    JOIN AlbumReleases release ON release.mbid = track.release_mbid
    JOIN Albums release_group ON release_group.mbid = release.release_group_mbid
    LEFT JOIN Artists a ON a.mbid = release_group.artist_mbid
    WHERE track.mbid = ?
       OR track.recording_mbid = ?
    UNION
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      NULL AS release_group_mbid
    FROM Recordings recording
    LEFT JOIN Artists a ON a.mbid = recording.artist_mbid
    WHERE recording.mbid = ?
       OR CAST(recording.Id AS TEXT) = CAST(? AS TEXT)
  `).all(mediaId, mediaId, mediaId, mediaId, mediaId) as Array<{
    artist_id?: string | null;
    release_group_mbid?: string | null;
  }>;

  for (const row of canonicalRows) {
    if (row.release_group_mbid) {
      invalidateReleaseGroupDownloadStatus(String(row.release_group_mbid));
    }
    if (row.artist_id) {
      invalidateArtistDownloadStatus(String(row.artist_id));
    }
  }
}
