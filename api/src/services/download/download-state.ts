import { db } from "../../database.js";
import { buildArtistCompletionPredicate } from "../music/managed-artists.js";
import { forwardCacheInvalidate } from "../commands/worker/command-worker-protocol.js";

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
  forwardCacheInvalidate("album", String(albumId));
  albumStatsCache.delete(String(albumId));
  invalidateReleaseGroupDownloadStatus(String(albumId));
}

export function invalidateReleaseGroupDownloadStatus(releaseGroupMbid: string): void {
  if (!releaseGroupMbid) return;
  forwardCacheInvalidate("releaseGroup", String(releaseGroupMbid));
  for (const key of Array.from(albumStatsCache.keys())) {
    if (key.endsWith(`:${releaseGroupMbid}`)) {
      albumStatsCache.delete(key);
    }
  }
}

export function invalidateArtistDownloadStatus(artistId: string): void {
  if (!artistId) return;
  forwardCacheInvalidate("artist", String(artistId));
  artistStatsCache.delete(String(artistId));
}

export function invalidateMediaDownloadState(mediaId: string): void {
  if (!mediaId) return;
  forwardCacheInvalidate("media", String(mediaId));
  mediaDownloadCache.delete(mediaCacheKey(String(mediaId), "track"));
  mediaDownloadCache.delete(mediaCacheKey(String(mediaId), "video"));
}

export function invalidateAllDownloadState(): void {
  forwardCacheInvalidate("all");
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
              CAST(lf.provider_id AS TEXT) = CAST(target_ids.id AS TEXT)
              OR (? = 'track' AND lf.canonical_track_mbid = CAST(target_ids.id AS TEXT))
              OR lf.canonical_recording_mbid = CAST(target_ids.id AS TEXT)
              OR CAST(lf.canonical_recording_mbid AS TEXT) = (
                SELECT r.mbid
                FROM Recordings r
                WHERE CAST(r.id AS TEXT) = CAST(target_ids.id AS TEXT)
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
      WHERE COALESCE(r.is_video, 0) = 0
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
    // Resolve each input id (a local Artists.id or an MBID) to its linked
    // artist_mbid + ArtistMetadata id with cheap point lookups, then aggregate
    // with plain IN-list queries that each use one index. Doing the resolution
    // inside one big CTE made the link table a CAST-heavy, non-materialized
    // subquery that SQLite re-evaluated per Recordings row — at ~1M recordings
    // one library-page call ran for minutes and, because main-thread reads are
    // synchronous, wedged every request behind it.
    const resolveArtistRow = db.prepare(
      "SELECT mbid FROM Artists WHERE CAST(id AS TEXT) = ? OR mbid = ? LIMIT 1",
    );
    const resolveMetadataByMbid = db.prepare("SELECT id, mbid FROM ArtistMetadata WHERE mbid = ? LIMIT 1");
    const resolveMetadataById = db.prepare("SELECT id, mbid FROM ArtistMetadata WHERE CAST(id AS TEXT) = ? LIMIT 1");
    const targets = missing.map((inputId) => {
      const artistRow = resolveArtistRow.get(inputId, inputId) as { mbid?: string | null } | undefined;
      let artistMbid = String(artistRow?.mbid || inputId);
      let metadata = resolveMetadataByMbid.get(artistMbid) as { id?: number; mbid?: string } | undefined;
      if (!metadata) {
        metadata = resolveMetadataById.get(inputId) as { id?: number; mbid?: string } | undefined;
        if (!artistRow?.mbid && metadata?.mbid) {
          artistMbid = String(metadata.mbid);
        }
      }
      return { inputId, artistMbid, artistMetadataId: metadata?.id ?? null };
    });

    const mbids = Array.from(new Set(targets.map((target) => target.artistMbid)));
    const metadataIds = Array.from(new Set(
      targets.map((target) => target.artistMetadataId).filter((id): id is number => id != null),
    ));
    const mbidMarks = mbids.map(() => "?").join(", ");

    // 1. Monitored release-slot completeness (indexed on rgs.artist_mbid).
    const slotRows = mbids.length === 0 ? [] : db.prepare(`
      SELECT
        rgs.artist_mbid,
        COUNT(DISTINCT track.mbid) AS total_tracks,
        COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN track.mbid END) AS downloaded_tracks
      FROM ReleaseGroupSlots rgs
      LEFT JOIN Tracks track
        ON track.release_mbid = rgs.selected_release_mbid
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
       AND lf.library_slot = rgs.slot
      WHERE rgs.artist_mbid IN (${mbidMarks})
        AND (rgs.monitored = 1 OR COALESCE(rgs.monitored_lock, 0) = 1)
        AND rgs.slot IN ('stereo', 'spatial')
        AND rgs.selected_release_mbid IS NOT NULL
        AND COALESCE(recording.is_video, 0) = 0
      GROUP BY rgs.artist_mbid, rgs.release_group_mbid, rgs.slot
    `).all(...mbids) as Array<{ artist_mbid: string; total_tracks: number; downloaded_tracks: number }>;

    // 2. Monitored videos — one indexed query per artist-link column instead of
    //    an OR-join that defeats both indexes.
    const monitoredVideoFlag = "(COALESCE(recording.monitored, 0) = 1 OR COALESCE(recording.monitored_lock, 0) = 1)";
    const videosLinkedByMbid = mbids.length === 0 ? [] : db.prepare(`
      SELECT recording.artist_mbid AS link, recording.id AS recording_id
      FROM Recordings recording
      WHERE recording.is_video = 1
        AND recording.artist_mbid IN (${mbidMarks})
        AND ${monitoredVideoFlag}
    `).all(...mbids) as Array<{ link: string; recording_id: number }>;
    const videosLinkedByMetadataId = metadataIds.length === 0 ? [] : db.prepare(`
      SELECT recording.artist_metadata_id AS link, recording.id AS recording_id
      FROM Recordings recording
      WHERE recording.is_video = 1
        AND recording.artist_metadata_id IN (${metadataIds.map(() => "?").join(", ")})
        AND ${monitoredVideoFlag}
    `).all(...metadataIds) as Array<{ link: number; recording_id: number }>;

    // 3. Downloaded video recordings, derived once from the (small) set of
    //    downloaded video files; no video files ⇒ nothing is downloaded.
    const downloadedVideoIds = new Set<number>();
    if (db.prepare("SELECT 1 FROM TrackFiles WHERE file_type = 'video' LIMIT 1").get()) {
      const downloadedRows = db.prepare(`
        SELECT recording.id AS recording_id
        FROM TrackFiles lf
        JOIN Recordings recording ON recording.mbid = lf.canonical_recording_mbid
        WHERE lf.file_type = 'video' AND lf.canonical_recording_mbid IS NOT NULL
        UNION
        SELECT pi.recording_id
        FROM TrackFiles lf
        JOIN ProviderItems pi
          ON pi.entity_type = 'video'
         AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
        WHERE lf.file_type = 'video' AND pi.recording_id IS NOT NULL
        UNION
        SELECT recording.id
        FROM TrackFiles lf
        JOIN ProviderItems pi
          ON pi.entity_type = 'video'
         AND CAST(pi.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
        JOIN Recordings recording ON recording.mbid = pi.recording_mbid
        WHERE lf.file_type = 'video'
      `).all() as Array<{ recording_id: number }>;
      for (const row of downloadedRows) {
        downloadedVideoIds.add(Number(row.recording_id));
      }
    }

    // Combine per requested artist in JS.
    const slotsByMbid = new Map<string, Array<{ total: number; downloaded: number }>>();
    for (const row of slotRows) {
      const list = slotsByMbid.get(row.artist_mbid) ?? [];
      list.push({ total: Number(row.total_tracks), downloaded: Number(row.downloaded_tracks) });
      slotsByMbid.set(row.artist_mbid, list);
    }
    const videosByMbid = new Map<string, Set<number>>();
    for (const row of videosLinkedByMbid) {
      const set = videosByMbid.get(String(row.link)) ?? new Set<number>();
      set.add(Number(row.recording_id));
      videosByMbid.set(String(row.link), set);
    }
    const videosByMetadataId = new Map<number, Set<number>>();
    for (const row of videosLinkedByMetadataId) {
      const set = videosByMetadataId.get(Number(row.link)) ?? new Set<number>();
      set.add(Number(row.recording_id));
      videosByMetadataId.set(Number(row.link), set);
    }

    const rows = targets.map((target) => {
      const slots = slotsByMbid.get(target.artistMbid) ?? [];
      const videoIds = new Set<number>(videosByMbid.get(target.artistMbid) ?? []);
      if (target.artistMetadataId != null) {
        for (const id of videosByMetadataId.get(target.artistMetadataId) ?? []) {
          videoIds.add(id);
        }
      }
      let downloadedVideos = 0;
      for (const id of videoIds) {
        if (downloadedVideoIds.has(id)) downloadedVideos += 1;
      }
      return {
        artist_id: target.inputId,
        total_items: slots.length + videoIds.size,
        downloaded_items: slots.filter((slot) => slot.total > 0 && slot.downloaded >= slot.total).length + downloadedVideos,
      };
    });

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
        ON t.album_release_id = rgs.selected_album_release_id
        OR (t.album_release_id IS NULL AND t.release_mbid = rgs.selected_release_mbid)
      LEFT JOIN TrackFiles lf
        ON (
          lf.track_id = t.id
          OR lf.canonical_track_mbid = t.mbid
          OR (
            lf.track_id IS NULL
            AND lf.canonical_track_mbid IS NULL
            AND (
              lf.recording_id = t.recording_id
              OR (lf.recording_id IS NULL AND lf.canonical_recording_mbid = t.recording_mbid)
            )
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
      ON t.album_release_id = rgs.selected_album_release_id
      OR (t.album_release_id IS NULL AND t.release_mbid = rgs.selected_release_mbid)
    JOIN TrackFiles lf
      ON (
        lf.track_id = t.id
        OR lf.canonical_track_mbid = t.mbid
        OR (
          lf.track_id IS NULL
          AND lf.canonical_track_mbid IS NULL
          AND (
            lf.recording_id = t.recording_id
            OR (lf.recording_id IS NULL AND lf.canonical_recording_mbid = t.recording_mbid)
          )
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
       OR CAST(recording.id AS TEXT) = CAST(? AS TEXT)
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
