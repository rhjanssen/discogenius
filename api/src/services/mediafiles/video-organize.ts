/**
 * Video-organize helpers (split from OrganizerService).
 * Bundled-video import naming + catalog lookup after upsert.
 * DB reads only — no FS side effects or Organizer class state.
 */

import { db } from "../../database.js";

export function normalizeBundledVideoTitle(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function loadBundledVideoTrackCandidates(
  provider: string,
  albumIds: string[],
): Array<{ provider_id: string; title: string; track_number: number | null }> {
  if (!provider || albumIds.length === 0) {
    return [];
  }
  const placeholders = albumIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT
      CAST(member_item.provider_id AS TEXT) AS provider_id,
      COALESCE(member.contextual_title, member_item.title, '') AS title,
      member.position AS track_number
    FROM ProviderItems provider_release
    JOIN ProviderEditionMembers member
      ON member.provider_edition_item_id = provider_release.id
    JOIN ProviderItems member_item
      ON member_item.id = member.member_item_id
     AND member_item.entity_type = 'track'
    WHERE provider_release.provider = ?
      AND provider_release.entity_type = 'release'
      AND provider_release.provider_id IN (${placeholders})
    ORDER BY member.medium_position ASC, member.position ASC, member_item.provider_id ASC
  `).all(provider, ...albumIds) as Array<{ provider_id: string; title: string; track_number: number | null }>;
}

export function resolveCanonicalVideoArtistId(provider: string, providerId: string): string | null {
  const row = db.prepare(`
    SELECT CASE
      WHEN COUNT(DISTINCT managed_artist.id) = 1
      THEN MAX(managed_artist.id)
    END AS id
    FROM ProviderItems provider_item
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = provider_item.id
     AND video_match.match_state = 'accepted'
    JOIN Recordings recording ON recording.id = video_match.recording_id
    JOIN ArtistMetadata managed_artist ON managed_artist.mbid = recording.artist_mbid
    WHERE provider_item.provider = ?
      AND provider_item.entity_type = 'video'
      AND provider_item.provider_id = ?
  `).get(provider, providerId) as { id: string | number } | undefined;

  return row?.id != null ? String(row.id) : null;
}

/**
 * Catalog-first video title for organize. Prefer Recordings.title; provider
 * payload / ProviderItems only fill holes before catalog exists.
 */
export function resolveOrganizeVideoTitle(
  videoProvider: string,
  providerId: string,
  videoData: { title?: unknown; name?: unknown } | null | undefined,
): string {
  const candidates = [
    (db.prepare(`
      SELECT CASE
        WHEN COUNT(DISTINCT recording.id) = 1
        THEN MAX(recording.title)
      END AS title
      FROM ProviderItems provider_item
      JOIN ProviderVideoMatches video_match
        ON video_match.provider_video_item_id = provider_item.id
       AND video_match.match_state = 'accepted'
      JOIN Recordings recording ON recording.id = video_match.recording_id
      WHERE provider_item.provider = ?
        AND provider_item.entity_type = 'video'
        AND CAST(provider_item.provider_id AS TEXT) = CAST(? AS TEXT)
      LIMIT 1
    `).get(videoProvider, providerId) as { title?: string | null } | undefined)?.title,
    videoData?.title,
    videoData?.name,
    (db.prepare(`
      SELECT title FROM ProviderItems
      WHERE provider = ? AND entity_type = 'video' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
      LIMIT 1
    `).get(videoProvider, providerId) as { title?: string | null } | undefined)?.title,
  ];
  for (const candidate of candidates) {
    const title = String(candidate || "").trim();
    if (title && title.toLowerCase() !== "unknown video") {
      return title;
    }
  }
  return "Unknown Video";
}

/** Catalog Recording fields after RefreshVideoService.upsertArtistVideos. */
export function lookupCatalogVideoAfterUpsert(
  provider: string,
  providerId: string,
): { title?: string | null; video_variant?: string | null } | undefined {
  return db.prepare(`
    SELECT
      CASE WHEN COUNT(DISTINCT recording.id) = 1 THEN MAX(recording.title) END AS title,
      CASE WHEN COUNT(DISTINCT recording.id) = 1 THEN MAX(recording.video_variant) END AS video_variant
    FROM ProviderItems pi
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = pi.id
     AND video_match.match_state = 'accepted'
    JOIN Recordings recording ON recording.id = video_match.recording_id
    WHERE pi.provider = ? AND pi.entity_type = 'video'
      AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
    HAVING COUNT(DISTINCT recording.id) = 1
  `).get(provider, providerId) as { title?: string | null; video_variant?: string | null } | undefined;
}
