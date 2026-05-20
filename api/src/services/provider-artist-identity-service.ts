import { db } from "../database.js";
import { lidarrMetadataService, type LidarrArtist } from "./metadata/lidarr-metadata-service.js";
import type { ProviderArtist } from "./providers/streaming-provider.js";

export type ProviderArtistIdentityInput = {
  providerId: string;
  name: string;
  picture?: string | null;
  popularity?: number | null;
  mbid?: string | null;
  raw?: unknown;
};

export type ProviderArtistIdentityResolution = {
  mbid: string | null;
  status: "verified" | "probable" | "ambiguous" | "provider_only";
  confidence: number;
  method: string;
  reason?: string;
};

export function normalizeProviderArtist(artist: ProviderArtist): ProviderArtistIdentityInput {
  const raw = artist.raw && typeof artist.raw === "object" ? artist.raw as Record<string, unknown> : null;
  return {
    providerId: artist.providerId,
    name: artist.name,
    picture: artist.picture || null,
    popularity: artist.popularity ?? null,
    mbid: typeof raw?.mbid === "string" ? raw.mbid : null,
    raw: artist.raw,
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bestLidarrArtistMatch(providerArtist: ProviderArtistIdentityInput, candidates: LidarrArtist[]): {
  artist: LidarrArtist;
  status: "verified" | "probable";
  confidence: number;
  method: string;
} | null {
  const normalizedName = normalizeSearchText(providerArtist.name);
  const exactMatches = candidates
    .filter((candidate) => normalizeSearchText(candidate.artistname || "") === normalizedName)
    .sort((left, right) => (right.Albums?.length || 0) - (left.Albums?.length || 0));

  if (exactMatches.length === 0) {
    return null;
  }

  if (exactMatches.length === 1) {
    return {
      artist: exactMatches[0],
      status: "verified",
      confidence: 1,
      method: "lidarr-artist-name-exact",
    };
  }

  const [best, second] = exactMatches;
  const bestAlbumCount = best.Albums?.length || 0;
  const secondAlbumCount = second.Albums?.length || 0;
  const bestHasDisambiguation = String(best.disambiguation || "").trim().length > 0;
  const secondHasDisambiguation = String(second.disambiguation || "").trim().length > 0;

  if (bestAlbumCount >= secondAlbumCount + 5 && (!bestHasDisambiguation || secondHasDisambiguation)) {
    return {
      artist: best,
      status: "probable",
      confidence: 0.78,
      method: "lidarr-artist-name-discography-weight",
    };
  }

  return null;
}

export class ProviderArtistIdentityService {
  static async resolve(provider: string, artist: ProviderArtistIdentityInput): Promise<ProviderArtistIdentityResolution> {
    const cached = db.prepare(`
      SELECT artist_mbid, match_status, match_confidence, match_method
      FROM provider_items
      WHERE provider = ?
        AND entity_type = 'artist'
        AND provider_id = ?
        AND artist_mbid IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(provider, artist.providerId) as {
      artist_mbid?: string | null;
      match_status?: string | null;
      match_confidence?: number | null;
      match_method?: string | null;
    } | undefined;

    if (cached?.artist_mbid) {
      return {
        mbid: cached.artist_mbid,
        status: cached.match_status === "probable" ? "probable" : "verified",
        confidence: cached.match_confidence ?? 1,
        method: cached.match_method || "provider-artist-cache",
      };
    }

    if (artist.mbid) {
      return {
        mbid: artist.mbid,
        status: "verified",
        confidence: 1,
        method: "provider-musicbrainz-id",
      };
    }

    try {
      const candidates = await lidarrMetadataService.searchArtists(artist.name, 10);
      const match = bestLidarrArtistMatch(artist, candidates);
      const normalizedName = normalizeSearchText(artist.name);
      const exactCount = candidates.filter((candidate) => normalizeSearchText(candidate.artistname || "") === normalizedName).length;

      if (!match && exactCount > 1) {
        return {
          mbid: null,
          status: "ambiguous",
          confidence: 0,
          method: "lidarr-artist-name-ambiguous",
          reason: "musicbrainz_ambiguous",
        };
      }

      if (match) {
        return {
          mbid: match.artist.id,
          status: match.status,
          confidence: match.confidence,
          method: match.method,
        };
      }
    } catch (error) {
      console.warn(`[ProviderArtistIdentityService] Failed to match ${artist.name} to Lidarr metadata:`, error);
    }

    return {
      mbid: null,
      status: "provider_only",
      confidence: 0,
      method: "provider-artist-unmatched",
      reason: "musicbrainz_unmatched",
    };
  }

  static store(provider: string, artist: ProviderArtistIdentityInput, resolution: ProviderArtistIdentityResolution, localArtistId?: string | null): void {
    db.prepare(`
      INSERT INTO provider_items (
        provider, entity_type, provider_id, artist_mbid,
        title, match_status, match_confidence, match_method, data, updated_at
      )
      VALUES (?, 'artist', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
        artist_mbid = COALESCE(excluded.artist_mbid, provider_items.artist_mbid),
        title = excluded.title,
        match_status = excluded.match_status,
        match_confidence = excluded.match_confidence,
        match_method = excluded.match_method,
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      provider,
      artist.providerId,
      resolution.mbid || null,
      artist.name,
      resolution.status,
      resolution.confidence,
      resolution.method,
      JSON.stringify(artist.raw ?? artist),
    );

    if (!localArtistId) {
      return;
    }

    db.prepare(`
      INSERT INTO local_entities (local_id, entity_type, legacy_id, musicbrainz_id, display_name, updated_at)
      VALUES (?, 'artist', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(local_id) DO UPDATE SET
        legacy_id = COALESCE(local_entities.legacy_id, excluded.legacy_id),
        musicbrainz_id = COALESCE(excluded.musicbrainz_id, local_entities.musicbrainz_id),
        display_name = excluded.display_name,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      `artist:${localArtistId}`,
      localArtistId,
      resolution.mbid || null,
      artist.name,
    );

    db.prepare(`
      INSERT INTO provider_entity_ids (
        local_id, entity_type, provider, external_id, provider_entity_type,
        match_status, match_confidence, match_method, data, updated_at
      )
      VALUES (?, 'artist', ?, ?, 'artist', ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, provider_entity_type, external_id) DO UPDATE SET
        local_id = excluded.local_id,
        entity_type = excluded.entity_type,
        match_status = excluded.match_status,
        match_confidence = excluded.match_confidence,
        match_method = excluded.match_method,
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      `artist:${localArtistId}`,
      provider,
      artist.providerId,
      resolution.status,
      resolution.confidence,
      resolution.method,
      JSON.stringify(artist.raw ?? artist),
    );
  }
}
