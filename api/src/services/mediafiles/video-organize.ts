/**
 * Video-organize helpers (Lidarr-style split from OrganizerService).
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
      CAST(provider_id AS TEXT) AS provider_id,
      COALESCE(title, '') AS title,
      track_number
    FROM ProviderItems
    WHERE provider = ?
      AND entity_type = 'track'
      AND library_slot = 'video'
      AND provider_album_id IN (${placeholders})
    ORDER BY volume_number ASC, track_number ASC, provider_id ASC
  `).all(provider, ...albumIds) as Array<{ provider_id: string; title: string; track_number: number | null }>;
}

export function resolveCanonicalVideoArtistId(provider: string, providerId: string): string | null {
  const row = db.prepare(`
    SELECT managed_artist.id
    FROM ProviderItems provider_item
    JOIN Recordings recording ON recording.id = provider_item.recording_id
    JOIN Artists managed_artist ON managed_artist.mbid = recording.artist_mbid
    WHERE provider_item.provider = ?
      AND provider_item.entity_type = 'video'
      AND provider_item.provider_id = ?
    ORDER BY CASE WHEN managed_artist.id = managed_artist.mbid THEN 0 ELSE 1 END
    LIMIT 1
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
      SELECT recording.title AS title
      FROM ProviderItems provider_item
      JOIN Recordings recording ON recording.id = provider_item.recording_id
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
    SELECT recording.title, recording.video_variant
    FROM ProviderItems pi
    JOIN Recordings recording ON recording.id = pi.recording_id
    WHERE pi.provider = ? AND pi.entity_type = 'video'
      AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
    LIMIT 1
  `).get(provider, providerId) as { title?: string | null; video_variant?: string | null } | undefined;
}
