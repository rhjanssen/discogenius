import { db } from "../../database.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isRefreshDue(lastScanned: string | null | undefined, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    if (!lastScanned) return true;
    const last = new Date(lastScanned).getTime();
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= refreshDays * DAY_MS;
}

export function shouldRefreshTracks(albumId: string, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    const row = db.prepare(`
        SELECT
            COUNT(track_item.provider_id) as total_tracks,
            MIN(track_item.updated_at) as oldest_scan
        FROM ProviderItems album_item
        LEFT JOIN ProviderItems track_item
            ON track_item.provider = album_item.provider
           AND track_item.entity_type = 'track'
           AND (
                (album_item.release_mbid IS NOT NULL AND track_item.release_mbid = album_item.release_mbid)
                OR (album_item.release_group_mbid IS NOT NULL AND track_item.release_group_mbid = album_item.release_group_mbid)
           )
        WHERE album_item.entity_type = 'album'
          AND album_item.provider_id = ?
    `).get(albumId) as {
        total_tracks?: number;
        oldest_scan?: string | null;
    } | undefined;

    const totalTracks = Number(row?.total_tracks || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;

    if (totalTracks === 0 || !oldestScan) return true;
    return isRefreshDue(oldestScan, refreshDays);
}

export function shouldRefreshVideos(artistId: string, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    const row = db.prepare(`
        SELECT
            COUNT(video_item.provider_id) as total_videos,
            MIN(video_item.updated_at) as oldest_scan
        FROM Artists artist
        LEFT JOIN ProviderItems video_item
            ON video_item.artist_mbid = artist.mbid
           AND video_item.entity_type = 'video'
        WHERE artist.id = ?
    `).get(artistId) as {
        total_videos?: number;
        oldest_scan?: string | null;
    } | undefined;

    const totalVideos = Number(row?.total_videos || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;
    if (totalVideos === 0 || !oldestScan) return true;
    return isRefreshDue(oldestScan, refreshDays);
}

export function getTrackRefreshState(albumId: string, refreshDays: number | undefined): {
    shouldRefresh: boolean;
    missingTracks: boolean;
    oldestScanTime: number;
} {
    if (!refreshDays || refreshDays <= 0) {
        return {
            shouldRefresh: true,
            missingTracks: false,
            oldestScanTime: Number.NEGATIVE_INFINITY,
        };
    }

    const row = db.prepare(`
        SELECT
            COUNT(track_item.provider_id) as total_tracks,
            MIN(track_item.updated_at) as oldest_scan
        FROM ProviderItems album_item
        LEFT JOIN ProviderItems track_item
            ON track_item.provider = album_item.provider
           AND track_item.entity_type = 'track'
           AND (
                (album_item.release_mbid IS NOT NULL AND track_item.release_mbid = album_item.release_mbid)
                OR (album_item.release_group_mbid IS NOT NULL AND track_item.release_group_mbid = album_item.release_group_mbid)
           )
        WHERE album_item.entity_type = 'album'
          AND album_item.provider_id = ?
    `).get(albumId) as {
        total_tracks?: number;
        oldest_scan?: string | null;
    } | undefined;

    const totalTracks = Number(row?.total_tracks || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;
    const missingTracks = totalTracks === 0 || !oldestScan;
    const oldestScanTime = oldestScan ? new Date(oldestScan).getTime() : Number.NEGATIVE_INFINITY;

    return {
        shouldRefresh: missingTracks || isRefreshDue(oldestScan, refreshDays),
        missingTracks,
        oldestScanTime: Number.isFinite(oldestScanTime) ? oldestScanTime : Number.NEGATIVE_INFINITY,
    };
}
