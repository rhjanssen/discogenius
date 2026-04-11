import { db } from "../database.js";

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
            COUNT(*) as total_tracks,
            SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_scans,
            MIN(last_scanned) as oldest_scan
        FROM media
        WHERE album_id = ? AND type != 'Music Video'
    `).get(albumId) as {
        total_tracks?: number;
        missing_scans?: number;
        oldest_scan?: string | null;
    } | undefined;

    const totalTracks = Number(row?.total_tracks || 0);
    const missingScans = Number(row?.missing_scans || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;

    if (totalTracks === 0 || missingScans > 0 || !oldestScan) return true;
    return isRefreshDue(oldestScan, refreshDays);
}

export function shouldRefreshVideos(artistId: string, refreshDays: number | undefined): boolean {
    if (!refreshDays || refreshDays <= 0) return true;
    const row = db.prepare(`
        SELECT
            COUNT(*) as total_videos,
            SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_scans,
            MIN(last_scanned) as oldest_scan
        FROM media
        WHERE artist_id = ? AND type = 'Music Video'
    `).get(artistId) as {
        total_videos?: number;
        missing_scans?: number;
        oldest_scan?: string | null;
    } | undefined;

    const totalVideos = Number(row?.total_videos || 0);
    const missingScans = Number(row?.missing_scans || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;
    if (totalVideos === 0 || missingScans > 0 || !oldestScan) return true;
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
            COUNT(*) as total_tracks,
            SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) as missing_scans,
            MIN(last_scanned) as oldest_scan
        FROM media
        WHERE album_id = ? AND type != 'Music Video'
    `).get(albumId) as {
        total_tracks?: number;
        missing_scans?: number;
        oldest_scan?: string | null;
    } | undefined;

    const totalTracks = Number(row?.total_tracks || 0);
    const missingScans = Number(row?.missing_scans || 0);
    const oldestScan = row?.oldest_scan as string | null | undefined;
    const missingTracks = totalTracks === 0 || missingScans > 0 || !oldestScan;
    const oldestScanTime = oldestScan ? new Date(oldestScan).getTime() : Number.NEGATIVE_INFINITY;

    return {
        shouldRefresh: missingTracks || isRefreshDue(oldestScan, refreshDays),
        missingTracks,
        oldestScanTime: Number.isFinite(oldestScanTime) ? oldestScanTime : Number.NEGATIVE_INFINITY,
    };
}
