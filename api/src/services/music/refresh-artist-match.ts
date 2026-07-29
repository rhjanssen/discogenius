import { db } from "../../database.js";
import { servarrMetadata } from "../metadata/servarr-metadata.js";
import {
    matchProviderAlbumsToReleaseGroups,
    type ProviderReleaseGroupMatch,
} from "../metadata/provider-release-group-matcher.js";
import type { StreamingProvider, ProviderArtist } from "../providers/streaming-provider.js";

export function buildProviderReleaseGroupMatches(
    artistMbid: string | null,
    albums: any[],
): Map<string, ProviderReleaseGroupMatch> {
    if (!artistMbid || albums.length === 0) {
        return new Map();
    }

    const releaseGroups = servarrMetadata.getCachedReleaseGroupsForArtist(artistMbid);
    if (releaseGroups.length === 0) {
        return new Map();
    }

    return matchProviderAlbumsToReleaseGroups(
        albums.map((album) => ({
            provider: String(album.provider || "tidal"),
            providerId: String(album.provider_id),
            providerUrl: album.url ?? null,
            title: String(album.title || ""),
            version: album.version ?? null,
            releaseDate: album.release_date ?? null,
            type: album.type ?? null,
            quality: album.quality ?? null,
            qualityTags: Array.isArray(album.qualityTags) ? album.qualityTags : [],
            explicit: album.explicit ?? null,
            upc: album.upc ?? null,
            trackCount: album.num_tracks ?? null,
            volumeCount: album.num_volumes ?? null,
            isrcs: Array.isArray(album._provider_tracks)
                ? album._provider_tracks.map((t: any) => String(t.isrc || "")).filter(Boolean)
                : [],
        })),
        releaseGroups,
    );
}

export function getLinkedProviderArtistId(artistMbid: string, providerId: string): string | null {
    const row = db.prepare("SELECT links FROM ArtistMetadata WHERE mbid = ? LIMIT 1")
        .get(artistMbid) as { links?: string | null } | undefined;
    if (!row?.links) {
        return null;
    }

    try {
        const parsed = JSON.parse(row.links);
        const linkType = providerId === "apple-music" ? "apple" : providerId;
        const links = Array.isArray(parsed) ? parsed : [];
        for (const link of links) {
            if (String(link?.type || "").trim().toLowerCase() !== linkType) {
                continue;
            }
            const target = String(link?.target || "").trim();
            const match = providerId === "apple-music"
                ? target.match(/(?:artist\/[^/]+\/|artist\/|id)(\d+)(?:[/?#]|$)/i)
                : target.match(/artist\/(\d+)(?:[/?#]|$)/i);
            if (match?.[1]) {
                return match[1];
            }
        }
    } catch {
        // Ignore malformed cached metadata and fall back to verified search.
    }

    return null;
}

export function storeProviderArtistMatch(
    provider: StreamingProvider,
    artistMbid: string,
    artist: ProviderArtist,
    status: "verified" | "probable",
): void {
    db.prepare(`
        INSERT INTO ProviderItems (
            provider, entity_type, provider_id, artist_mbid,
            title, match_status, match_confidence, match_method, cover, popularity, updated_at
        )
        VALUES (?, 'artist', ?, ?, ?, ?, ?, 'artist-name-search', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
            artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
            title = excluded.title,
            match_status = excluded.match_status,
            match_confidence = excluded.match_confidence,
            match_method = excluded.match_method,
            cover = COALESCE(excluded.cover, ProviderItems.cover),
            popularity = COALESCE(excluded.popularity, ProviderItems.popularity),
            updated_at = CURRENT_TIMESTAMP
    `).run(
        provider.id,
        artist.providerId,
        artistMbid,
        artist.name || null,
        status,
        status === "verified" ? 1 : 0.75,
        artist.picture || null,
        artist.popularity ?? null,
    );

    const updatePopularity = artist.popularity ?? 0;
    db.prepare(`
        UPDATE Artists
        SET picture = COALESCE(?, picture),
            cover_image_url = COALESCE(?, cover_image_url),
            popularity = MAX(COALESCE(popularity, 0), ?)
        WHERE mbid = ?
    `).run(artist.picture || null, artist.picture || null, updatePopularity, artistMbid);

    db.prepare(`
        UPDATE ArtistMetadata
        SET picture = COALESCE(?, picture),
            cover_image_url = COALESCE(?, cover_image_url),
            popularity = MAX(COALESCE(popularity, 0), ?)
        WHERE mbid = ?
    `).run(artist.picture || null, artist.picture || null, updatePopularity, artistMbid);
}
