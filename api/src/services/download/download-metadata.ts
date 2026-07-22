import { db } from '../../database.js';
import {
    getDefaultStreamingSource,
} from '../download/download-routing.js';
import { MediaSeedService } from '../music/media-seed-service.js';
import { RefreshAlbumService } from '../music/refresh-album-service.js';
import type {
    DownloadAlbumCommand,
    DownloadMediaType,
    DownloadTrackCommand,
    DownloadVideoCommand,
    ResolvedDownloadMetadata,
} from '../commands/command-bodies.js';
import {
    albumCoverLocalUrl,
    renderableProviderArtworkUrl,
    videoCoverLocalUrl,
} from '../metadata/media-cover-service.js';

export type CanonicalProviderOffer = {
    provider?: string | null;
    slot_cover?: string | null;
    provider_cover?: string | null;
    provider_id?: string | null;
    entity_type?: string | null;
    artist_mbid?: string | null;
    release_group_mbid?: string | null;
    release_mbid?: string | null;
    track_mbid?: string | null;
    recording_mbid?: string | null;
    provider_title?: string | null;
    provider_quality?: string | null;
    asset_id?: string | null;
    provider_artist_name?: string | null;
    slot_provider_artist_name?: string | null;
    slot_provider_title?: string | null;
    slot_quality?: string | null;
    selected_release_mbid?: string | null;
    canonical_album_title?: string | null;
    canonical_track_title?: string | null;
    canonical_recording_title?: string | null;
    canonical_recording_id?: number | null;
    artist_name?: string | null;
};

type DownloadCommand = DownloadTrackCommand | DownloadVideoCommand | DownloadAlbumCommand;
type DownloadJobType = Extract<DownloadMediaType, 'track' | 'video' | 'album'>;

export function pickString(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

export function resolvePayloadProvider(payload?: DownloadCommand): string {
    return pickString((payload as Record<string, unknown> | undefined)?.streamingSource)
        || pickString(payload?.provider)
        || getDefaultStreamingSource();
}

export function resolveCanonicalProviderOffer(
    providerId: string,
    type: DownloadJobType,
    payload?: DownloadCommand,
): CanonicalProviderOffer | null {
    const entityType = type === 'album' ? 'album' : type === 'video' ? 'video' : 'track';
    const provider = resolvePayloadProvider(payload);
    const releaseGroupMbid = pickString(payload?.releaseGroupMbid);
    const slot = pickString(payload?.slot) || 'stereo';

    if (type === 'album') {
        const row = db.prepare(`
            SELECT
                pi.provider,
                pi.provider_id,
                pi.entity_type,
                pi.artist_mbid,
                pi.release_group_mbid,
                pi.release_mbid,
                pi.title AS provider_title,
                pi.quality AS provider_quality,
                pi.asset_id,
                pi.provider_artist_name AS provider_artist_name,
                rgs.provider_artist_name AS slot_provider_artist_name,
                rgs.provider_title AS slot_provider_title,
                rgs.cover AS slot_cover,
                rgs.quality AS slot_quality,
                rgs.selected_release_mbid,
                rg.title AS canonical_album_title,
                am.name AS artist_name
            FROM ProviderItems pi
            LEFT JOIN ReleaseGroupSlots rgs
              ON rgs.selected_provider = pi.provider
             AND rgs.selected_provider_id = pi.provider_id
             AND rgs.release_group_mbid = pi.release_group_mbid
             AND (? IS NULL OR rgs.slot = ?)
            LEFT JOIN Albums rg
              ON rg.mbid = COALESCE(pi.release_group_mbid, rgs.release_group_mbid)
            LEFT JOIN ArtistMetadata am
              ON am.mbid = COALESCE(pi.artist_mbid, rgs.artist_mbid, rg.artist_mbid)
            WHERE pi.provider = ?
              AND pi.provider_id = ?
              AND pi.entity_type = 'album'
              AND (? IS NULL OR pi.release_group_mbid = ?)
            ORDER BY CASE WHEN rgs.slot = ? THEN 0 ELSE 1 END, pi.updated_at DESC
            LIMIT 1
        `).get(slot, slot, provider, providerId, releaseGroupMbid, releaseGroupMbid, slot) as CanonicalProviderOffer | undefined;

        if (row) return row;

        if (releaseGroupMbid) {
            const slotRow = db.prepare(`
                SELECT
                    rgs.selected_provider AS provider,
                    rgs.selected_provider_id AS provider_id,
                    'album' AS entity_type,
                    rgs.artist_mbid,
                    rgs.release_group_mbid,
                    rgs.selected_release_mbid AS release_mbid,
                    rgs.provider_artist_name AS slot_provider_artist_name,
                    rgs.provider_title AS slot_provider_title,
                    rgs.cover AS slot_cover,
                    rgs.quality AS slot_quality,
                    rgs.selected_release_mbid,
                    rg.title AS canonical_album_title,
                    am.name AS artist_name
                FROM ReleaseGroupSlots rgs
                LEFT JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
                LEFT JOIN ArtistMetadata am ON am.mbid = COALESCE(rgs.artist_mbid, rg.artist_mbid)
                WHERE rgs.release_group_mbid = ?
                  AND rgs.selected_provider = ?
                  AND rgs.selected_provider_id = ?
                  AND rgs.slot = ?
                LIMIT 1
            `).get(releaseGroupMbid, provider, providerId, slot) as CanonicalProviderOffer | undefined;
            return slotRow ?? null;
        }

        return null;
    }

    const row = db.prepare(`
        SELECT
            pi.provider,
            pi.provider_id,
            pi.entity_type,
            pi.artist_mbid,
            pi.release_group_mbid,
            pi.release_mbid,
            pi.track_mbid,
            pi.recording_mbid,
            pi.title AS provider_title,
            pi.quality AS provider_quality,
            pi.asset_id,
            pi.cover AS provider_cover,
            pi.provider_artist_name AS provider_artist_name,
            rg.title AS canonical_album_title,
            t.title AS canonical_track_title,
            r.title AS canonical_recording_title,
            r.id AS canonical_recording_id,
            am.name AS artist_name
        FROM ProviderItems pi
        LEFT JOIN Albums rg ON rg.mbid = pi.release_group_mbid
        LEFT JOIN Tracks t ON t.mbid = pi.track_mbid
        LEFT JOIN Recordings r ON (
          (pi.recording_id IS NOT NULL AND r.id = pi.recording_id)
          OR (pi.recording_id IS NULL AND pi.recording_mbid IS NOT NULL AND r.mbid = pi.recording_mbid)
        )
        LEFT JOIN ArtistMetadata am ON am.mbid = pi.artist_mbid
        WHERE pi.provider = ?
          AND pi.provider_id = ?
          AND pi.entity_type = ?
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(provider, providerId, entityType) as CanonicalProviderOffer | undefined;
    return row ?? null;
}

export function hasAlbumMetadataReady(albumId: string, payload?: DownloadCommand): boolean {
    const canonicalOffer = resolveCanonicalProviderOffer(albumId, 'album', payload);
    return Boolean(canonicalOffer);
}

export function hasTrackMetadataReady(trackId: string, payload?: DownloadCommand): boolean {
    const canonicalOffer = resolveCanonicalProviderOffer(trackId, 'track', payload);
    if (canonicalOffer) {
        return Boolean(
            canonicalOffer.provider_id
            && (canonicalOffer.provider_title || canonicalOffer.canonical_track_title || canonicalOffer.canonical_recording_title)
            && (canonicalOffer.artist_mbid || canonicalOffer.artist_name)
        );
    }

    return false;
}

export function hasVideoMetadataReady(videoId: string, payload?: DownloadCommand): boolean {
    const canonicalOffer = resolveCanonicalProviderOffer(videoId, 'video', payload);
    if (canonicalOffer) {
        return Boolean(
            canonicalOffer.provider_id
            && (canonicalOffer.provider_title || canonicalOffer.canonical_recording_title)
            && (canonicalOffer.artist_mbid || canonicalOffer.artist_name)
        );
    }

    return false;
}

export async function ensureMetadataReady(
    providerId: string,
    type: 'track' | 'video' | 'album',
    payload?: DownloadCommand,
): Promise<void> {
    switch (type) {
        case 'album': {
            const albumIds = providerId.split(";").filter(Boolean);
            for (const subAlbumId of albumIds) {
                if (!hasAlbumMetadataReady(subAlbumId, payload)) {
                    console.log(`[DOWNLOAD-PROCESSOR] Album ${subAlbumId} is missing complete metadata; refreshing album metadata before download`);
                    await RefreshAlbumService.refreshMetadata(subAlbumId, {
                        provider: (payload as any)?.streamingSource || payload?.provider,
                    });
                }
            }
            return;
        }
        case 'track':
            if (!hasTrackMetadataReady(providerId, payload)) {
                console.log(`[DOWNLOAD-PROCESSOR] Track ${providerId} is missing metadata; seeding track before download`);
                await MediaSeedService.seedTrack(providerId, {
                    provider: (payload as any)?.streamingSource || payload?.provider,
                });
            }
            return;
        case 'video':
            if (!hasVideoMetadataReady(providerId, payload)) {
                console.log(`[DOWNLOAD-PROCESSOR] Video ${providerId} is missing metadata; seeding video before download`);
                await MediaSeedService.seedVideo(providerId, {
                    provider: (payload as any)?.streamingSource || (payload as any)?.provider || undefined,
                });
            }
            return;
        default:
            return;
    }
}

/**
 * Resolve display title/artist/cover for a download job.
 * Prefer catalog titles via internal recording/track FKs; fall back to provider
 * then payload titles so Active queue never paints literal "Unknown" when we
 * already had a good enqueue title (int ids for joins, MBIDs for tags).
 */
export function resolveDownloadMetadata(
    providerId: string,
    type: DownloadJobType,
    payload: DownloadCommand,
): Required<ResolvedDownloadMetadata> {
    const fallbackTitle = pickNonPlaceholderTitle(payload?.title);
    const fallbackArtist = pickNonPlaceholderTitle(payload?.artist);
    const fallbackCover = payload?.cover ?? null;

    try {
        const canonicalOffer = resolveCanonicalProviderOffer(providerId, type, payload);
        if (canonicalOffer) {
            const catalogTitle = type === 'album'
                ? canonicalOffer.canonical_album_title
                : type === 'video'
                    ? canonicalOffer.canonical_recording_title
                    : canonicalOffer.canonical_track_title || canonicalOffer.canonical_recording_title;
            const title = pickNonPlaceholderTitle(catalogTitle)
                || pickNonPlaceholderTitle(canonicalOffer.provider_title)
                || fallbackTitle
                || 'Unknown';
            const artist = pickNonPlaceholderTitle(canonicalOffer.artist_name)
                || pickNonPlaceholderTitle(canonicalOffer.provider_artist_name)
                || fallbackArtist
                || 'Unknown';
            const providerCover = fallbackCover
                ?? canonicalOffer.slot_cover
                ?? canonicalOffer.provider_cover
                ?? canonicalOffer.asset_id
                ?? null;
            const canonicalCover = type === 'video'
                ? videoCoverLocalUrl(canonicalOffer.canonical_recording_id)
                : albumCoverLocalUrl({ albumMbid: canonicalOffer.release_group_mbid });
            const cover = canonicalCover
                ?? renderableProviderArtworkUrl(providerCover, canonicalOffer.provider)
                ?? renderableProviderArtworkUrl(fallbackCover, payload?.provider);

            return {
                title,
                artist,
                cover,
            };
        }

        return {
            title: fallbackTitle || 'Unknown',
            artist: fallbackArtist || 'Unknown',
            cover: renderableProviderArtworkUrl(fallbackCover, payload?.provider),
        };
    } catch {
        return {
            title: fallbackTitle || 'Unknown',
            artist: fallbackArtist || 'Unknown',
            cover: renderableProviderArtworkUrl(fallbackCover, payload?.provider),
        };
    }
}

function pickNonPlaceholderTitle(value: unknown): string | null {
    const text = String(value || "").trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower === "unknown" || lower === "unknown video" || lower === "unknown track" || lower === "unknown album") {
        return null;
    }
    return text;
}

export function resolveDownloadQuality(
    providerId: string,
    type: DownloadJobType,
    payload: DownloadCommand,
): string | null {
    if (payload?.quality) {
        return payload.quality;
    }

    try {
        const canonicalOffer = resolveCanonicalProviderOffer(providerId, type, payload);
        if (canonicalOffer) {
            return canonicalOffer.slot_quality ?? canonicalOffer.provider_quality ?? null;
        }
        return null;
    } catch {
        return null;
    }
}

export function getCanonicalAlbumDownloadProgress(
    providerId: string,
    payload: DownloadCommand,
): { total: number; done: number } | null {
    const canonicalOffer = resolveCanonicalProviderOffer(providerId, 'album', payload);
    const releaseGroupMbid = pickString(payload?.releaseGroupMbid) || canonicalOffer?.release_group_mbid;
    const releaseMbid = pickString(payload?.releaseMbid)
        || canonicalOffer?.selected_release_mbid
        || canonicalOffer?.release_mbid;
    const slot = pickString(payload?.slot) || 'stereo';

    if (!releaseGroupMbid && !releaseMbid) {
        return null;
    }

    const row = releaseMbid
        ? db.prepare(`
            SELECT
                COUNT(DISTINCT t.mbid) AS total,
                COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN t.mbid END) AS done
            FROM Tracks t
            LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
            LEFT JOIN TrackFiles lf
              ON (
                lf.canonical_track_mbid = t.mbid
                OR (
                  lf.canonical_track_mbid IS NULL
                  AND lf.canonical_recording_mbid = t.recording_mbid
                )
              )
             AND lf.file_type = 'track'
             AND lf.library_slot = ?
            WHERE t.release_mbid = ?
              AND (r.is_video IS NULL OR r.is_video = 0)
        `).get(slot, releaseMbid) as { total?: number; done?: number } | undefined
        : db.prepare(`
            SELECT
                COUNT(DISTINCT pi.provider_id) AS total,
                COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN pi.provider_id END) AS done
            FROM ProviderItems pi
            LEFT JOIN TrackFiles lf
              ON lf.provider = pi.provider
             AND lf.provider_entity_type = pi.entity_type
             AND lf.provider_id = pi.provider_id
             AND lf.file_type = 'track'
             AND lf.library_slot = pi.library_slot
            WHERE pi.release_group_mbid = ?
              AND pi.entity_type = 'track'
              AND pi.library_slot = ?
        `).get(releaseGroupMbid, slot) as { total?: number; done?: number } | undefined;

    if (!row) return null;
    return {
        total: Number(row.total || 0),
        done: Number(row.done || 0),
    };
}

export function isCanonicalProviderItemDownloaded(
    providerId: string,
    type: Extract<DownloadJobType, 'track' | 'video'>,
    payload: DownloadCommand,
): boolean {
    const canonicalOffer = resolveCanonicalProviderOffer(providerId, type, payload);
    if (!canonicalOffer) {
        return false;
    }

    const fileType = type === 'video' ? 'video' : 'track';
    const row = db.prepare(`
        SELECT 1
        FROM TrackFiles lf
        WHERE lf.file_type = ?
          AND (
            (lf.provider = ? AND lf.provider_entity_type = ? AND lf.provider_id = ?)
            OR (? IS NOT NULL AND lf.canonical_track_mbid = ?)
            OR (? IS NOT NULL AND lf.canonical_recording_mbid = ?)
          )
        LIMIT 1
    `).get(
        fileType,
        canonicalOffer.provider,
        canonicalOffer.entity_type,
        providerId,
        canonicalOffer.track_mbid,
        canonicalOffer.track_mbid,
        canonicalOffer.recording_mbid,
        canonicalOffer.recording_mbid,
    ) as { 1?: number } | undefined;

    return Boolean(row);
}
