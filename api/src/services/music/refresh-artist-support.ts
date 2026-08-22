/**
 * Pure helpers extracted from RefreshArtistService.
 * No DB access, provider I/O, or service class state.
 */

import type { ProviderAlbum, ProviderArtist, ProviderTrack, ProviderVideo } from "../providers/streaming-provider.js";
import { normalizeIsrc } from "../mediafiles/import-matching-utils.js";
export { normalizeIsrc };

const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * YouTube Music is a core video *catalog* source (same role as MusicBrainz),
 * not a download-plugin feature. MatchArtistProviders still lists it when
 * cookies are missing; RefreshArtist also ingests via syncYouTubeVideoCatalogForArtist.
 * Downloading a YouTube video still needs browser headers/cookies.
 */
export function isCoreVideoCatalogProvider(providerId: string): boolean {
    return String(providerId || "").trim().toLowerCase() === "youtube-music";
}

export function isMusicBrainzMbid(value: string | number | null | undefined): boolean {
    return MUSICBRAINZ_MBID_RE.test(String(value || "").trim());
}

export function providerAlbumToOfferRow(providerAlbum: ProviderAlbum, fallbackArtistId: string): any {
    const raw = providerAlbum.raw;
    if (raw && typeof raw === "object" && "provider_id" in raw) {
        return {
            ...raw,
            provider_id: String((raw as any).provider_id),
            video_cover: (raw as any).video_cover || (raw as any).videoCover || providerAlbum.videoCover || null,
            qualityTags: Array.isArray(providerAlbum.qualityTags)
                ? providerAlbum.qualityTags
                : Array.isArray((raw as any).qualityTags)
                    ? (raw as any).qualityTags
                    : [],
        };
    }

    return {
        provider: (providerAlbum as any).provider || (providerAlbum.raw as any)?.provider || null,
        provider_id: providerAlbum.providerId,
        artist_id: providerAlbum.artist?.providerId || fallbackArtistId,
        artist_name: providerAlbum.artist?.name || "Unknown Artist",
        artists: providerAlbum.artist ? [{ id: providerAlbum.artist.providerId, name: providerAlbum.artist.name }] : [],
        title: providerAlbum.title || "Unknown Album",
        release_date: providerAlbum.releaseDate || null,
        cover: providerAlbum.cover || null,
        vibrant_color: null,
        video_cover: providerAlbum.videoCover || null,
        num_tracks: providerAlbum.trackCount || 0,
        num_videos: 0,
        num_volumes: providerAlbum.volumeCount || 1,
        duration: providerAlbum.duration || 0,
        type: providerAlbum.type || "ALBUM",
        version: providerAlbum.version || null,
        explicit: providerAlbum.explicit || false,
        quality: providerAlbum.quality || "LOSSLESS",
        qualityTags: Array.isArray(providerAlbum.qualityTags) ? providerAlbum.qualityTags : [],
        url: providerAlbum.url || null,
        popularity: 0,
        copyright: providerAlbum.copyright || null,
        upc: providerAlbum.upc || null,
        _group_type: "ALBUMS",
        _module: providerAlbum.type === "EP" ? "EP" : providerAlbum.type === "SINGLE" ? "SINGLE" : "ALBUM",
    };
}

export function providerVideoToOfferRow(providerVideo: ProviderVideo, fallbackArtistId: string): any {
    return {
        provider_id: providerVideo.providerId,
        title: providerVideo.title,
        duration: providerVideo.duration || 0,
        release_date: providerVideo.releaseDate || null,
        explicit: providerVideo.explicit || false,
        quality: providerVideo.quality || null,
        image_id: providerVideo.cover || null,
        artist_id: providerVideo.artist?.providerId || fallbackArtistId,
        artist_name: providerVideo.artist?.name || "Unknown Artist",
        artists: providerVideo.artists || [],
        url: providerVideo.url,
        isrc: providerVideo.isrc || null,
        recording_mbid: providerVideo.recordingMbid || null,
        album_id: providerVideo.albumId || null,
        related_track_id: providerVideo.relatedTrackId || null,
        type: "Music Video",
    };
}

export function parseJsonObject(value: unknown): Record<string, any> {
    if (!value) {
        return {};
    }
    if (typeof value === "object") {
        return value as Record<string, any>;
    }
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function providerArtistArtworkSnapshot(artist: ProviderArtist): string {
    return JSON.stringify({
        picture: artist.picture || null,
        popularity: artist.popularity ?? null,
        url: artist.url || null,
    });
}

export function completeBulkTrackList<T>(expectedTrackCount: unknown, tracks: T[] | undefined): T[] | null {
    const expected = Number(expectedTrackCount);
    return Array.isArray(tracks)
        && Number.isFinite(expected)
        && expected > 0
        && tracks.length === expected
        ? tracks
        : null;
}

/** Accent-stripped lowercase text used for title / artist-name matching. */
export function normalizeMatchText(value: unknown): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export type SlotTrack = {
    mbid: null;
    providerId: string | null;
    provider_id: string | null;
    isrc: string | null;
    title: string | null;
    track_number: number | null;
    volume_number: number;
    duration: number | null;
};

export function slotTrack(track: ProviderTrack): SlotTrack {
    return {
        mbid: null,
        providerId: track.providerId || null,
        provider_id: track.providerId || null,
        isrc: normalizeIsrc(track.isrc) || null,
        title: track.title || null,
        track_number: track.trackNumber || null,
        volume_number: track.volumeNumber || 1,
        duration: track.duration || null,
    };
}
