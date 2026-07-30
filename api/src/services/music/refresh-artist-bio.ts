import { db } from "../../database.js";
import { streamingProviderManager } from "../providers/index.js";
import { firstProviderEditorialText } from "../providers/provider-editorial-text.js";
import type { RefreshOptions } from "./scan-types.js";
import { getLinkedProviderArtistId, storeProviderArtistMatch } from "./refresh-artist-match.js";
import { isMusicBrainzMbid, normalizeMatchText } from "./refresh-artist-support.js";
import { ProviderArtistIdentityService, normalizeProviderArtist } from "../metadata/provider-artist-identity-service.js";
import type { StreamingProvider } from "../providers/streaming-provider.js";

export function artistCatalogFingerprint(artistMbid: string | null): string | null {
    if (!artistMbid) return null;
    const artist = db.prepare("SELECT content_hash FROM ArtistMetadata WHERE mbid = ?")
        .get(artistMbid) as { content_hash?: string | null } | undefined;
    const releaseGroups = db.prepare(`
        SELECT rg.mbid, rg.content_hash
        FROM Albums rg
        LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
        WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
        GROUP BY rg.mbid, rg.content_hash
        ORDER BY rg.mbid
    `).all(artistMbid, artistMbid) as Array<{ mbid: string; content_hash: string | null }>;
    return JSON.stringify({ artist: artist?.content_hash || null, releaseGroups });
}

export async function resolveProviderArtistId(
    provider: StreamingProvider,
    artistId: string,
    artistMbid: string | null,
): Promise<string | null> {
    if (!artistMbid) {
        return artistId;
    }

    // ProviderItems carries no artist_mbid shadow column: the provider -> canonical
    // artist link is the accepted ProviderArtistMatches edge.
    const cached = db.prepare(`
        SELECT CAST(item.provider_id AS TEXT) AS provider_id
        FROM ProviderItems item
        JOIN ProviderArtistMatches artist_match
          ON artist_match.provider_artist_item_id = item.id
         AND artist_match.match_state = 'accepted'
        JOIN ArtistMetadata canonical_artist
          ON canonical_artist.id = artist_match.artist_id
        WHERE item.provider = ?
          AND item.entity_type = 'artist'
          AND canonical_artist.mbid = ?
        ORDER BY
          CASE artist_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
          artist_match.confidence DESC,
          item.updated_at DESC
        LIMIT 1
    `).get(provider.id, artistMbid) as { provider_id?: string | number | null } | undefined;
    if (cached?.provider_id != null) {
        return String(cached.provider_id);
    }

    const linkedProviderArtistId = getLinkedProviderArtistId(artistMbid, provider.id);
    if (linkedProviderArtistId) {
        return linkedProviderArtistId;
    }

    const localArtist = db.prepare("SELECT name FROM Artists WHERE id = ? OR mbid = ? LIMIT 1")
        .get(artistId, artistMbid) as { name?: string | null } | undefined;
    const artistName = String(localArtist?.name || "").trim();
    if (!artistName) {
        return null;
    }

    try {
        const results = await provider.search(artistName, { types: ["artists"], limit: 8 });
        const artists = Array.isArray(results.artists) ? results.artists : [];
        const normalizedName = normalizeMatchText(artistName);
        const exact = artists.find((artist) => normalizeMatchText(artist.name) === normalizedName);
        const selected = exact || artists[0] || null;
        if (!selected?.providerId) {
            return null;
        }

        const resolution = await ProviderArtistIdentityService.resolve(provider.id, normalizeProviderArtist(selected));
        if (resolution.mbid !== artistMbid) {
            console.warn(
                `[RefreshArtistService] Skipping ${provider.name} artist "${selected.name}" (${selected.providerId}) for ${artistName}: ` +
                `provider identity resolved to ${resolution.mbid || resolution.status}, expected ${artistMbid}.`,
            );
            return null;
        }

        storeProviderArtistMatch(provider, artistMbid, selected, resolution.status === "verified" ? "verified" : "probable");
        return selected.providerId;
    } catch (error) {
        console.warn(`[RefreshArtistService] Failed to resolve ${provider.name} artist for ${artistName} (${artistMbid}):`, error);
        return null;
    }
}

export async function resolveProviderArtistIds(
    provider: StreamingProvider,
    artistId: string,
    artistMbid: string | null,
): Promise<string[]> {
    const primary = await resolveProviderArtistId(provider, artistId, artistMbid);
    if (!artistMbid) {
        return primary ? [primary] : [];
    }

    const linked = db.prepare(`
        SELECT DISTINCT CAST(item.provider_id AS TEXT) AS provider_id
        FROM ProviderItems item
        JOIN ProviderArtistMatches artist_match
          ON artist_match.provider_artist_item_id = item.id
         AND artist_match.match_state = 'accepted'
        JOIN ArtistMetadata canonical_artist
          ON canonical_artist.id = artist_match.artist_id
        WHERE item.provider = ?
          AND item.entity_type = 'artist'
          AND canonical_artist.mbid = ?
    `).all(provider.id, artistMbid) as Array<{ provider_id: string | number }>;

    const ids = new Set<string>();
    if (primary) ids.add(String(primary));
    for (const row of linked) {
        if (row.provider_id != null) ids.add(String(row.provider_id));
    }
    return [...ids];
}

/**
 * Fetch + store artist biography from streaming providers in
 * `provider_priority` order. First non-empty bio wins. Servarr/MB overview
 * remains the hole-fill fallback when no provider returns text.
 */
export async function refreshArtistBiography(artistId: string, options: RefreshOptions = {}): Promise<void> {
    const existing = db.prepare("SELECT bio_text, bio_source, mbid FROM Artists WHERE id = ?")
        .get(artistId) as {
            bio_text?: string | null;
            bio_source?: string | null;
            mbid?: string | null;
        } | undefined;
    const existingBio = String(existing?.bio_text || "").trim();
    const artistMbid = existing?.mbid || (isMusicBrainzMbid(artistId) ? artistId : null);
    const priority = options.provider
        ? [options.provider, ...streamingProviderManager.getProviderPriority().filter((id) => id !== options.provider)]
        : streamingProviderManager.getProviderPriority();

    const candidates: Array<{ provider: string; providerId: string }> = [];
    for (const providerId of priority) {
        let provider;
        try {
            provider = streamingProviderManager.getStreamingProvider(providerId);
        } catch {
            continue;
        }
        if (typeof provider.getArtistBio !== "function") {
            continue;
        }
        const providerArtistIds = await resolveProviderArtistIds(provider, artistId, artistMbid);
        for (const providerArtistId of providerArtistIds) {
            candidates.push({ provider: provider.id, providerId: providerArtistId });
        }
    }

    try {
        const editorial = await firstProviderEditorialText({
            kind: "artistBio",
            candidates,
        });

        if (editorial) {
            db.prepare(`
                UPDATE Artists SET
                    bio_text = ?,
                    bio_source = ?,
                    bio_last_updated = ?
                WHERE id = ?
            `).run(editorial.text, editorial.source, new Date().toISOString(), artistId);
            return;
        }

        if (!existingBio) {
            console.log(`[RefreshArtistService] No provider biography found for ${artistId}`);
        }
    } catch (error) {
        console.warn(`[RefreshArtistService] Failed to fetch bio for ${artistId}:`, error);
    }
}
