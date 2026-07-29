import { db } from "../../database.js";
import { servarrMetadata } from "../metadata/servarr-metadata.js";
import {
    matchProviderAlbumsToReleaseGroups,
    type ProviderReleaseGroupMatch,
} from "../metadata/provider-release-group-matcher.js";
import type { StreamingProvider, ProviderArtist } from "../providers/streaming-provider.js";
import { parseJsonObject } from "./refresh-artist-support.js";

type ProviderTrackDetail = {
    mbid?: string | null;
    provider_id?: string | null;
    isrc?: string | null;
    title: string;
    version?: string | null;
    track_number?: number | null;
    volume_number?: number | null;
    duration?: number | null;
};

type ProviderAlbumSlotCandidate = {
    providerId: string;
    providerArtistName?: string | null;
    title: string;
    version?: string | null;
    releaseDate?: string | null;
    quality?: string | null;
    qualityTags?: string[];
    explicit?: boolean | number | null;
    trackCount?: number | null;
    volumeCount?: number | null;
    tracks?: ProviderTrackDetail[];
};

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

export function buildStoredProviderAlbumSelections(
    artistMbid: string | null,
): Array<{ provider: string; album: ProviderAlbumSlotCandidate; match: ProviderReleaseGroupMatch }> {
    if (!artistMbid) {
        return [];
    }

    const rows = db.prepare(`
        SELECT
            pi.provider,
            pi.provider_id,
            pi.title,
            pi.version,
            pi.explicit,
            pi.quality,
            pi.release_date,
            pi.release_group_mbid,
            pi.release_mbid,
            pi.match_status,
            pi.match_confidence,
            pi.match_method,
            pi.match_evidence,
            pi.provider_artist_name,
            rg.title AS release_group_title,
            rg.primary_type,
            rg.secondary_types,
            rg.first_release_date,
            rg.disambiguation
        FROM ProviderItems pi
        JOIN Albums rg
          ON rg.mbid = pi.release_group_mbid
        LEFT JOIN ArtistReleaseGroups scope
          ON scope.release_group_mbid = rg.mbid
         AND scope.artist_mbid = ?
        WHERE pi.entity_type = 'album'
          AND pi.release_group_mbid IS NOT NULL
          AND pi.match_status IN ('verified', 'probable', 'candidate')
          AND (
            pi.availability IS NULL
            OR LOWER(CAST(pi.availability AS TEXT))
               NOT IN ('0', 'false', 'unavailable', 'no', '')
          )
          AND (
            pi.artist_mbid = ?
            OR rg.artist_mbid = ?
            OR scope.artist_mbid IS NOT NULL
          )
    `).all(artistMbid, artistMbid, artistMbid) as Array<{
        provider: string;
        provider_id: string | number;
        title: string | null;
        version: string | null;
        explicit: number | null;
        quality: string | null;
        release_date: string | null;
        release_group_mbid: string;
        release_mbid: string | null;
        match_status: ProviderReleaseGroupMatch["status"];
        match_confidence: number | null;
        match_method: string | null;
        match_evidence: string | null;
        provider_artist_name: string | null;
        release_group_title: string;
        primary_type: string | null;
        secondary_types: string | null;
        first_release_date: string | null;
        disambiguation: string | null;
    }>;

    const tracksByAlbum = new Map<string, ProviderTrackDetail[]>();
    const albumProviderIds = rows.map((row) => String(row.provider_id));
    if (albumProviderIds.length > 0) {
        const placeholders = albumProviderIds.map(() => "?").join(",");
        const trackRows = db.prepare(`
            SELECT provider, provider_album_id, provider_id, title, version, isrc, duration, track_number, volume_number, track_mbid, recording_mbid
            FROM ProviderItems
            WHERE entity_type = 'track'
              AND provider_album_id IN (${placeholders})
        `).all(...albumProviderIds) as Array<{
            provider: string;
            provider_album_id: string | null;
            provider_id: string | null;
            title: string | null;
            version: string | null;
            isrc: string | null;
            duration: number | null;
            track_number: number | null;
            volume_number: number | null;
            track_mbid: string | null;
            recording_mbid: string | null;
        }>;
        for (const track of trackRows) {
            const providerAlbumId = String(track.provider_album_id || "");
            if (!providerAlbumId) {
                continue;
            }
            const key = `${track.provider}:${providerAlbumId}`;
            const list = tracksByAlbum.get(key) || [];
            list.push({
                mbid: track.track_mbid || track.recording_mbid || null,
                provider_id: track.provider_id || null,
                isrc: track.isrc || null,
                title: track.title || "",
                version: track.version || null,
                track_number: track.track_number ?? null,
                volume_number: track.volume_number ?? null,
                duration: track.duration ?? null,
            });
            tracksByAlbum.set(key, list);
        }
    }

    return rows.map((row) => {
        const evidence = parseJsonObject(row.match_evidence);
        let secondaryTypes: string[] = [];
        try {
            const parsed = JSON.parse(String(row.secondary_types || "[]"));
            secondaryTypes = Array.isArray(parsed) ? parsed.map((type) => String(type)) : [];
        } catch {
            secondaryTypes = [];
        }

        const providerId = String(row.provider_id);
        const providerTrackCount = Number(evidence.providerTrackCount || 0);
        const providerVolumeCount = Number(evidence.providerVolumeCount || 0);
        const evidencePayload: Record<string, any> & { providerTitle: string } = {
            providerTitle: row.title || "",
            ...evidence,
        };

        return {
            provider: row.provider,
            album: {
                providerId,
                providerArtistName: row.provider_artist_name || null,
                title: row.title || "",
                version: row.version || null,
                releaseDate: row.release_date || null,
                quality: row.quality || null,
                qualityTags: Array.isArray(evidence.providerQualityTags)
                    ? evidence.providerQualityTags.map((tag: unknown) => String(tag))
                    : [],
                explicit: row.explicit,
                trackCount: providerTrackCount > 0 ? providerTrackCount : null,
                volumeCount: providerVolumeCount > 0 ? providerVolumeCount : null,
                tracks: tracksByAlbum.get(`${row.provider}:${providerId}`) || [],
            },
            match: {
                providerId,
                status: row.match_status,
                confidence: Number(row.match_confidence || 0),
                method: row.match_method || "stored-provider-offer",
                releaseMbid: row.release_mbid || evidencePayload.matchedReleaseMbid || null,
                releaseGroup: {
                    mbid: row.release_group_mbid,
                    title: row.release_group_title,
                    primaryType: row.primary_type,
                    secondaryTypes,
                    firstReleaseDate: row.first_release_date,
                    disambiguation: row.disambiguation,
                },
                evidence: evidencePayload as ProviderReleaseGroupMatch["evidence"],
            },
        };
    });
}
