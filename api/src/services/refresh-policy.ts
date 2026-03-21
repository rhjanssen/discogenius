import { db } from "../database.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Lidarr-inspired refresh cadence
export const MIN_RETRY_HOURS = 12;
export const ARTIST_HARD_REFRESH_DAYS = 30;
export const ARTIST_ACTIVE_REFRESH_DAYS = 2;
export const ALBUM_HARD_REFRESH_DAYS = 60;
export const RECENT_RELEASE_DAYS = 30;

function parseTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOlderThanDays(timestamp: number, days: number): boolean {
  return Date.now() - timestamp >= days * DAY_MS;
}

function isNewerThanHours(timestamp: number, hours: number): boolean {
  return Date.now() - timestamp < hours * HOUR_MS;
}

export function hasRecentArtistRelease(artistId: string | number): boolean {
  const row = db.prepare(`
    SELECT MAX(release_date) AS latest_release
    FROM albums
    WHERE artist_id = ?
  `).get(String(artistId)) as { latest_release?: string | null } | undefined;

  const latest = parseTimestamp(row?.latest_release ?? null);
  if (latest === null) return false;

  return Date.now() - latest <= RECENT_RELEASE_DAYS * DAY_MS;
}

export function shouldRefreshArtistLidarrStyle(options: {
  artistId: string | number;
  lastScanned?: string | null;
}): boolean {
  const last = parseTimestamp(options.lastScanned ?? null);

  if (last === null) return true;
  if (isNewerThanHours(last, MIN_RETRY_HOURS)) return false;
  if (isOlderThanDays(last, ARTIST_HARD_REFRESH_DAYS)) return true;
  if (hasRecentArtistRelease(options.artistId)) return true;

  // Discogenius lacks a robust "artist ended" status, so use a conservative active cadence.
  return isOlderThanDays(last, ARTIST_ACTIVE_REFRESH_DAYS);
}

export function shouldRefreshAlbumLidarrStyle(options: {
  albumReleaseDate?: string | null;
  lastScanned?: string | null;
}): boolean {
  const last = parseTimestamp(options.lastScanned ?? null);
  const release = parseTimestamp(options.albumReleaseDate ?? null);

  if (last === null) return true;
  if (isNewerThanHours(last, MIN_RETRY_HOURS)) return false;
  if (isOlderThanDays(last, ALBUM_HARD_REFRESH_DAYS)) return true;
  if (release !== null && Date.now() - release <= RECENT_RELEASE_DAYS * DAY_MS) return true;

  return false;
}

export function shouldRefreshTrackSetLidarrStyle(options: {
  albumId: string | number;
  fallbackLastScanned?: string | null;
}): boolean {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_tracks,
      SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) AS missing_scans,
      MIN(last_scanned) AS oldest_scan,
      MAX(a.release_date) AS album_release_date
    FROM media m
    LEFT JOIN albums a ON a.id = m.album_id
    WHERE m.album_id = ? AND m.type != 'Music Video'
  `).get(String(options.albumId)) as {
    total_tracks?: number;
    missing_scans?: number;
    oldest_scan?: string | null;
    album_release_date?: string | null;
  };

  const total = Number(row?.total_tracks || 0);
  const missing = Number(row?.missing_scans || 0);
  const oldest = row?.oldest_scan ?? options.fallbackLastScanned ?? null;

  if (total === 0 || missing > 0 || !oldest) return true;

  return shouldRefreshAlbumLidarrStyle({
    albumReleaseDate: row?.album_release_date ?? null,
    lastScanned: oldest,
  });
}

export function shouldRefreshVideosLidarrStyle(options: {
  artistId: string | number;
  fallbackLastScanned?: string | null;
}): boolean {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_videos,
      SUM(CASE WHEN last_scanned IS NULL THEN 1 ELSE 0 END) AS missing_scans,
      MIN(last_scanned) AS oldest_scan
    FROM media
    WHERE artist_id = ? AND type = 'Music Video'
  `).get(String(options.artistId)) as {
    total_videos?: number;
    missing_scans?: number;
    oldest_scan?: string | null;
  };

  const total = Number(row?.total_videos || 0);
  const missing = Number(row?.missing_scans || 0);
  const oldest = row?.oldest_scan ?? options.fallbackLastScanned ?? null;

  if (total === 0 || missing > 0 || !oldest) return true;

  // Videos use album-style cadence for now (requested track-like treatment for videos).
  return shouldRefreshAlbumLidarrStyle({
    albumReleaseDate: null,
    lastScanned: oldest,
  });
}
