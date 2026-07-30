import { db } from "../../database.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Refresh staleness policy constants
export const MIN_RETRY_HOURS = 12;
export const ARTIST_HARD_REFRESH_DAYS = 30;
export const ARTIST_ACTIVE_REFRESH_DAYS = 2;
export const ARTIST_INACTIVE_REFRESH_DAYS = 14;
export const ALBUM_HARD_REFRESH_DAYS = 60;
export const RECENT_RELEASE_DAYS = 30;
export const INACTIVE_ARTIST_RELEASE_YEARS = 5;

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

export function getLatestArtistReleaseTimestamp(artistId: string | number): number | null {
  const identifier = String(artistId);
  const row = db.prepare(`
    WITH target_artist(mbid) AS (
      SELECT mbid
      FROM Artists
      WHERE CAST(id AS TEXT) = ? OR mbid = ?
      UNION
      SELECT ?
    )
    SELECT MAX(album.first_release_date) AS latest_release
    FROM Albums album
    JOIN target_artist target ON target.mbid = album.artist_mbid
  `).get(identifier, identifier, identifier) as { latest_release?: string | null } | undefined;

  return parseTimestamp(row?.latest_release ?? null);
}

export function hasRecentArtistRelease(artistId: string | number): boolean {
  const latest = getLatestArtistReleaseTimestamp(artistId);
  if (latest === null) return false;

  return Date.now() - latest <= RECENT_RELEASE_DAYS * DAY_MS;
}

export function hasInactiveArtistCatalog(artistId: string | number): boolean {
  const latest = getLatestArtistReleaseTimestamp(artistId);
  if (latest === null) return false;

  return Date.now() - latest >= INACTIVE_ARTIST_RELEASE_YEARS * 365 * DAY_MS;
}

export function shouldRefreshArtist(options: {
  artistId: string | number;
  lastScanned?: string | null;
  refreshDays?: number | null;
}): boolean {
  const last = parseTimestamp(options.lastScanned ?? null);
  const refreshDays = typeof options.refreshDays === "number" && Number.isFinite(options.refreshDays) && options.refreshDays > 0
    ? options.refreshDays
    : null;

  if (last === null) return true;
  if (isNewerThanHours(last, MIN_RETRY_HOURS)) return false;
  if (refreshDays !== null) return isOlderThanDays(last, refreshDays);
  if (isOlderThanDays(last, ARTIST_HARD_REFRESH_DAYS)) return true;
  if (hasRecentArtistRelease(options.artistId)) return true;
  if (hasInactiveArtistCatalog(options.artistId)) return isOlderThanDays(last, ARTIST_INACTIVE_REFRESH_DAYS);

  return isOlderThanDays(last, ARTIST_ACTIVE_REFRESH_DAYS);
}

export function shouldRefreshAlbum(options: {
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

export function shouldRefreshTrackSet(options: {
  albumId: string | number;
  fallbackLastScanned?: string | null;
  provider?: string | null;
}): boolean {
  const row = db.prepare(`
    SELECT
      COUNT(track_item.provider_id) AS total_tracks,
      SUM(CASE WHEN track_item.provider_id IS NOT NULL AND track_item.updated_at IS NULL THEN 1 ELSE 0 END) AS missing_scans,
      MIN(track_item.updated_at) AS oldest_scan,
      MAX(COALESCE(release.date, album.first_release_date, album_item.release_date)) AS album_release_date
    FROM ProviderItems album_item
    LEFT JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = album_item.id
    LEFT JOIN ProviderItems track_item
      ON track_item.id = member.member_item_id
     AND track_item.entity_type IN ('track', 'video')
    LEFT JOIN ProviderEditionMatches release_match
      ON release_match.provider_edition_item_id = album_item.id
     AND release_match.match_state = 'accepted'
    LEFT JOIN AlbumReleases release ON release.id = release_match.release_id
    LEFT JOIN Albums album ON album.id = release.release_group_id
    WHERE album_item.entity_type = 'release'
      AND album_item.provider_id = ?
      AND (? IS NULL OR album_item.provider = ?)
  `).get(
    String(options.albumId),
    options.provider || null,
    options.provider || null,
  ) as {
    total_tracks?: number;
    missing_scans?: number;
    oldest_scan?: string | null;
    album_release_date?: string | null;
  };

  const total = Number(row?.total_tracks || 0);
  const missing = Number(row?.missing_scans || 0);
  const oldest = row?.oldest_scan ?? options.fallbackLastScanned ?? null;

  if (total === 0 || missing > 0 || !oldest) return true;

  return shouldRefreshAlbum({
    albumReleaseDate: row?.album_release_date ?? null,
    lastScanned: oldest,
  });
}

export function shouldRefreshVideos(options: {
  artistId: string | number;
  fallbackLastScanned?: string | null;
}): boolean {
  const identifier = String(options.artistId);
  const row = db.prepare(`
    WITH target_artist(mbid) AS (
      SELECT mbid
      FROM Artists
      WHERE CAST(id AS TEXT) = ? OR mbid = ?
      UNION
      SELECT ?
    )
    SELECT
      COUNT(video_item.provider_id) AS total_videos,
      SUM(CASE WHEN video_item.provider_id IS NOT NULL AND video_item.updated_at IS NULL THEN 1 ELSE 0 END) AS missing_scans,
      MIN(video_item.updated_at) AS oldest_scan
    FROM target_artist target
    LEFT JOIN ProviderItems video_item
      ON video_item.entity_type = 'video'
    LEFT JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = video_item.id
     AND video_match.match_state = 'accepted'
    LEFT JOIN Recordings recording ON recording.id = video_match.recording_id
    LEFT JOIN ArtistMetadata artist ON artist.id = recording.artist_metadata_id
    WHERE artist.mbid = target.mbid
  `).get(identifier, identifier, identifier) as {
    total_videos?: number;
    missing_scans?: number;
    oldest_scan?: string | null;
  };

  const total = Number(row?.total_videos || 0);
  const missing = Number(row?.missing_scans || 0);
  const oldest = row?.oldest_scan ?? options.fallbackLastScanned ?? null;

  if (total === 0 || missing > 0 || !oldest) return true;

  // Videos follow the album refresh cadence.
  return shouldRefreshAlbum({
    albumReleaseDate: null,
    lastScanned: oldest,
  });
}
