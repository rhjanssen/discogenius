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
    canonical_track_id?: number | null;
    canonical_release_id?: number | null;
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
    const provider = resolvePayloadProvider(payload);
    const releaseGroupMbid = pickString(payload?.releaseGroupMbid);
    const acquisitionPlanId = Number.isInteger(payload?.acquisitionPlanId)
        ? Number(payload?.acquisitionPlanId)
        : null;

    if (type === 'album') {
        const row = db.prepare(`
            SELECT
                provider_release.provider,
                provider_release.provider_id,
                provider_release.entity_type,
                release_group.artist_mbid,
                release_group.mbid AS release_group_mbid,
                release.mbid AS release_mbid,
                provider_release.title AS provider_title,
                COALESCE(
                  (
                    SELECT variant.provider_quality_label
                    FROM AcquisitionPlanTracks plan_track
                    JOIN ProviderItemAudioVariants variant
                      ON variant.id = plan_track.provider_audio_variant_id
                    WHERE plan_track.plan_id = ?
                    ORDER BY plan_track.id
                    LIMIT 1
                  ),
                  (
                    SELECT variant.quality_class
                    FROM AcquisitionPlanTracks plan_track
                    JOIN ProviderItemAudioVariants variant
                      ON variant.id = plan_track.provider_audio_variant_id
                    WHERE plan_track.plan_id = ?
                    ORDER BY plan_track.id
                    LIMIT 1
                  )
                ) AS provider_quality,
                provider_release.cover_id AS asset_id,
                provider_artist.title AS provider_artist_name,
                provider_release.title AS slot_provider_title,
                COALESCE(provider_release.artwork_url, provider_release.cover_id) AS slot_cover,
                COALESCE(
                  (
                    SELECT variant.provider_quality_label
                    FROM AcquisitionPlanTracks plan_track
                    JOIN ProviderItemAudioVariants variant
                      ON variant.id = plan_track.provider_audio_variant_id
                    WHERE plan_track.plan_id = ?
                    ORDER BY plan_track.id
                    LIMIT 1
                  ),
                  (
                    SELECT variant.quality_class
                    FROM AcquisitionPlanTracks plan_track
                    JOIN ProviderItemAudioVariants variant
                      ON variant.id = plan_track.provider_audio_variant_id
                    WHERE plan_track.plan_id = ?
                    ORDER BY plan_track.id
                    LIMIT 1
                  )
                ) AS slot_quality,
                release.mbid AS selected_release_mbid,
                release.id AS canonical_release_id,
                release_group.title AS canonical_album_title,
                COALESCE(canonical_credit.credited_name, artist.name) AS artist_name
            FROM ProviderItems provider_release
            JOIN ProviderReleaseMatches release_match
              ON release_match.provider_release_item_id = provider_release.id
             AND release_match.match_state = 'accepted'
            JOIN AlbumReleases release
              ON release.id = release_match.release_id
            JOIN Albums release_group
              ON release_group.id = release.release_group_id
            LEFT JOIN ReleaseGroupArtistCredits canonical_credit
              ON canonical_credit.release_group_id = release_group.id
             AND canonical_credit.ordinal = 0
            LEFT JOIN ArtistMetadata artist
              ON artist.id = release_group.artist_metadata_id
            LEFT JOIN ProviderItemCredits provider_credit
              ON provider_credit.item_id = provider_release.id
             AND provider_credit.ordinal = 0
            LEFT JOIN ProviderItems provider_artist
              ON provider_artist.id = provider_credit.artist_item_id
            WHERE provider_release.provider = ?
              AND provider_release.provider_id = ?
              AND provider_release.entity_type = 'release'
              AND (? IS NULL OR release_group.mbid = ?)
              AND (
                ? IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM AcquisitionPlanSources source
                  WHERE source.plan_id = ?
                    AND source.provider_release_match_id = release_match.id
                )
              )
            ORDER BY
              CASE WHEN release_match.decision_source = 'manual' THEN 0 ELSE 1 END,
              release_match.confidence DESC,
              release_match.id
            LIMIT 1
        `).get(
            acquisitionPlanId,
            acquisitionPlanId,
            acquisitionPlanId,
            acquisitionPlanId,
            provider,
            providerId,
            releaseGroupMbid,
            releaseGroupMbid,
            acquisitionPlanId,
            acquisitionPlanId,
        ) as CanonicalProviderOffer | undefined;
        return row ?? null;
    }

    if (type === 'video') {
        const row = db.prepare(`
            SELECT
                provider_video.provider,
                provider_video.provider_id,
                provider_video.entity_type,
                artist.mbid AS artist_mbid,
                provider_video.title AS provider_title,
                provider_video.cover_id AS asset_id,
                COALESCE(provider_video.artwork_url, provider_video.cover_id) AS provider_cover,
                provider_artist.title AS provider_artist_name,
                recording.mbid AS recording_mbid,
                recording.title AS canonical_recording_title,
                recording.id AS canonical_recording_id,
                artist.name AS artist_name
            FROM ProviderItems provider_video
            JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = provider_video.id
             AND video_match.match_state = 'accepted'
            JOIN Recordings recording
              ON recording.id = video_match.recording_id
            LEFT JOIN ArtistMetadata artist
              ON artist.id = recording.artist_metadata_id
            LEFT JOIN ProviderItemCredits provider_credit
              ON provider_credit.item_id = provider_video.id
             AND provider_credit.ordinal = 0
            LEFT JOIN ProviderItems provider_artist
              ON provider_artist.id = provider_credit.artist_item_id
            WHERE provider_video.provider = ?
              AND provider_video.provider_id = ?
              AND provider_video.entity_type = 'video'
            ORDER BY
              CASE WHEN video_match.decision_source = 'manual' THEN 0 ELSE 1 END,
              video_match.confidence DESC,
              video_match.id
            LIMIT 1
        `).get(provider, providerId) as CanonicalProviderOffer | undefined;
        return row ?? null;
    }

    const row = db.prepare(`
        SELECT
            provider_track.provider,
            provider_track.provider_id,
            provider_track.entity_type,
            release_group.artist_mbid,
            release_group.mbid AS release_group_mbid,
            release.mbid AS release_mbid,
            track.mbid AS track_mbid,
            recording.mbid AS recording_mbid,
            provider_track.title AS provider_title,
            COALESCE(variant.provider_quality_label, variant.quality_class) AS provider_quality,
            provider_track.cover_id AS asset_id,
            COALESCE(provider_track.artwork_url, provider_track.cover_id) AS provider_cover,
            provider_artist.title AS provider_artist_name,
            release_group.title AS canonical_album_title,
            track.title AS canonical_track_title,
            track.id AS canonical_track_id,
            release.id AS canonical_release_id,
            recording.title AS canonical_recording_title,
            recording.id AS canonical_recording_id,
            COALESCE(track_credit.credited_name, artist.name) AS artist_name
        FROM ProviderItems provider_track
        JOIN ProviderReleaseMembers release_member
          ON release_member.member_item_id = provider_track.id
        JOIN ProviderTrackMatches track_match
          ON track_match.provider_release_member_id = release_member.id
         AND track_match.match_state = 'accepted'
        JOIN Tracks track
          ON track.id = track_match.track_id
        JOIN Recordings recording
          ON recording.id = track_match.recording_id
        JOIN AlbumReleases release
          ON release.id = track.album_release_id
        JOIN Albums release_group
          ON release_group.id = release.release_group_id
        LEFT JOIN ProviderItemAudioVariants variant
          ON variant.id = (
            SELECT candidate.id
            FROM ProviderItemAudioVariants candidate
            WHERE candidate.provider_item_id = provider_track.id
            ORDER BY
              CASE candidate.availability WHEN 'available' THEN 0 ELSE 1 END,
              candidate.id
            LIMIT 1
          )
        LEFT JOIN TrackArtistCredits track_credit
          ON track_credit.track_id = track.id
         AND track_credit.ordinal = 0
        LEFT JOIN ArtistMetadata artist
          ON artist.id = release_group.artist_metadata_id
        LEFT JOIN ProviderItemCredits provider_credit
          ON provider_credit.item_id = provider_track.id
         AND provider_credit.ordinal = 0
        LEFT JOIN ProviderItems provider_artist
          ON provider_artist.id = provider_credit.artist_item_id
        WHERE provider_track.provider = ?
          AND provider_track.provider_id = ?
          AND provider_track.entity_type = 'track'
          AND (
            ? IS NULL
            OR EXISTS (
              SELECT 1
              FROM AcquisitionPlanTracks plan_track
              WHERE plan_track.plan_id = ?
                AND plan_track.provider_track_match_id = track_match.id
            )
          )
        ORDER BY
          CASE WHEN track_match.decision_source = 'manual' THEN 0 ELSE 1 END,
          track_match.confidence DESC,
          track_match.id
        LIMIT 1
    `).get(
        provider,
        providerId,
        acquisitionPlanId,
        acquisitionPlanId,
    ) as CanonicalProviderOffer | undefined;
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
            if (!hasAlbumMetadataReady(providerId, payload)) {
                console.log(`[DOWNLOAD-PROCESSOR] Album ${providerId} is missing complete metadata; refreshing album metadata before download`);
                await RefreshAlbumService.refreshMetadata(providerId, {
                    provider: (payload as any)?.streamingSource || payload?.provider,
                });
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
    const acquisitionPlanId = Number.isInteger(payload?.acquisitionPlanId)
        ? Number(payload.acquisitionPlanId)
        : null;
    const libraryId = Number.isInteger(payload?.libraryId)
        ? Number(payload.libraryId)
        : null;

    if (!releaseGroupMbid && !releaseMbid) {
        return null;
    }

    const row = acquisitionPlanId != null
        ? db.prepare(`
            SELECT
                COUNT(DISTINCT plan_track.track_id) AS total,
                COUNT(DISTINCT CASE
                  WHEN EXISTS (
                    SELECT 1
                    FROM TrackFiles file
                    JOIN AcquisitionPlans file_plan
                      ON file_plan.id = plan_track.plan_id
                    JOIN LibraryReleases file_library_release
                      ON file_library_release.id = file_plan.library_release_id
                    WHERE file.library_id = file_library_release.library_id
                      AND file.album_release_id = file_library_release.release_id
                      AND file.track_id = plan_track.track_id
                      AND file.file_class = 'audio'
                  )
                  THEN plan_track.track_id
                END) AS done
            FROM AcquisitionPlanTracks plan_track
            WHERE plan_track.plan_id = ?
        `).get(acquisitionPlanId) as { total?: number; done?: number } | undefined
        : db.prepare(`
            SELECT
                COUNT(DISTINCT track.id) AS total,
                COUNT(DISTINCT CASE WHEN file.id IS NOT NULL THEN track.id END) AS done
            FROM Tracks track
            JOIN Recordings recording ON recording.id = track.recording_id
            LEFT JOIN TrackFiles file
              ON file.library_id = ?
             AND file.album_release_id = track.album_release_id
             AND file.track_id = track.id
             AND file.file_class = 'audio'
            WHERE track.album_release_id = ?
              AND recording.is_video = 0
        `).get(
            libraryId,
            canonicalOffer?.canonical_release_id ?? null,
        ) as { total?: number; done?: number } | undefined;

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

    const libraryId = Number.isInteger(payload?.libraryId)
        ? Number(payload.libraryId)
        : null;
    const row = type === 'video'
        ? db.prepare(`
            SELECT 1
            FROM TrackFiles file
            WHERE file.recording_id = ?
              AND file.file_class = 'video'
            LIMIT 1
        `).get(canonicalOffer.canonical_recording_id) as { 1?: number } | undefined
        : db.prepare(`
            SELECT 1
            FROM TrackFiles file
            WHERE file.track_id = ?
              AND file.file_class = 'audio'
              AND (? IS NULL OR file.library_id = ?)
            LIMIT 1
        `).get(
            canonicalOffer.canonical_track_id,
            libraryId,
            libraryId,
        ) as { 1?: number } | undefined;

    return Boolean(row);
}
