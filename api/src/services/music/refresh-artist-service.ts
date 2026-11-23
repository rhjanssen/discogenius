import pLimit from "p-limit";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";
import { db, runGatedChunkedWrite, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import {
    resolveArtistFolderForIdentityUpdate,
    resolveArtistFolderFromTemplate,
    shouldReapplyArtistPathTemplate,
} from "./artist-paths.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import { type RefreshOptions, type ArtistRefreshResult } from "./scan-types.js";
import {
    ALBUM_HARD_REFRESH_DAYS,
    shouldRefreshAlbum,
    shouldRefreshArtist,
    shouldRefreshVideos,
} from "../config/refresh-policy.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import { servarrMetadata } from "../metadata/servarr-metadata.js";
import { syncMusicBrainzVideosForArtist } from "../metadata/musicbrainz-video-service.js";
import {
    supplementSparseProviderVideosFromYouTube,
    syncYouTubeVideoCatalogForArtist,
} from "./youtube-video-catalog.js";
import {
    matchProviderAlbumsToReleaseGroups,
    type MusicBrainzReleaseGroupForMatching,
    type ProviderReleaseGroupMatch,
} from "../metadata/provider-release-group-matcher.js";
import { ProviderArtistIdentityService, normalizeProviderArtist } from "../metadata/provider-artist-identity-service.js";
import { streamingProviderManager } from "../providers/index.js";
import type { StreamingProvider, ProviderAlbum } from "../providers/streaming-provider.js";
import { ProviderRateLimitError, providerRequestState } from "../providers/provider-request-state.js";
import { ProviderOfferReleaseLinkService } from "../metadata/provider-offer-release-link-service.js";
import { isUntrustedTidalCatalogVideoQuality } from "../providers/tidal/tidal-quality.js";
import {
    discardEditionCoverIfDuplicateOfAlbum,
    listArtistCoverPrecacheTargets,
    resolveAlbumArtwork,
    resolveArtistArtwork,
    resolveEditionArtwork,
    resolveVideoArtwork,
    type ProviderArtworkCandidate,
} from "../metadata/media-cover-service.js";
import { MusicBrainzArtistCreditService } from "../metadata/musicbrainz-artist-credit-service.js";
import { ProviderCatalogRepository } from "../providers/provider-catalog-repository.js";
import {
    providerAudioVariants,
    providerTrackToTrackMetadataRow,
    RefreshAlbumService,
} from "./refresh-album-service.js";
import { ArtistTopTrackService } from "./artist-top-track-service.js";
import { parseVideoVariant } from "./video-variant.js";
import {
    isArtistLibraryMonitored,
    loadArtistMetadataIdentity,
    resolveArtistMetadataId,
    stampArtistLibraryPath,
    stampArtistLibraryRefresh,
    syncLibraryArtistMonitoring,
} from "./managed-artists.js";
import {
    completeBulkTrackList,
    isCoreVideoCatalogProvider,
    isMusicBrainzMbid,
    normalizeIsrc,
    providerAlbumToOfferRow,
    providerVideoToOfferRow,
    slotTrack,
} from "./refresh-artist-support.js";
import {
    buildProviderReleaseGroupMatches,
} from "./refresh-artist-match.js";
import {
    artistCatalogFingerprint,
    refreshArtistBiography,
    resolveProviderArtistId,
    resolveProviderArtistIds,
} from "./refresh-artist-bio.js";
import {
    normalizeMusicBrainzType,
    parseMusicBrainzSecondaryTypes,
} from "../metadata/musicbrainz-release-group-filter.js";
import {
    PLAYLIST_TRACKLIST_COVERAGE_METHOD,
    playlistCoversCanonicalTracklistDownloadable,
    scorePlaylistTracklistCoverage,
} from "../providers/soundcloud/soundcloud-playlist-match.js";
import {
    scoreSoundCloudDownloadableCoverage,
    soundCloudOfferHasDownloadableMatch,
} from "../providers/soundcloud/soundcloud-downloadability.js";
import { syncVideoRelationsFromEditionMembership } from "./video-edition-relation-sync.js";
import { yieldToEventLoop } from "../commands/command-context.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 24 * 60 * 60 * 1000;
export const COLLABORATION_NEGATIVE_MISS_TTL_MS = 7 * DAY_MS;
export const MAX_COLLABORATION_SEARCHES_PER_REFRESH = 50;

function isWidePlaylistSearchReleaseGroup(
    primaryType?: string | null,
    secondaryTypes?: string | null,
): boolean {
    const primary = normalizeMusicBrainzType(primaryType);
    if (primary === "other") return true;
    return parseMusicBrainzSecondaryTypes(secondaryTypes).some((type) =>
        type === "mixtape/street" || type === "dj-mix" || type === "demo");
}

export {
    completeBulkTrackList,
    isMusicBrainzMbid,
    providerAlbumToOfferRow,
} from "./refresh-artist-support.js";

/**
 * Albums processed between cooperative yields inside provider matching.
 *
 * MatchArtistProviders lost its lease and poison-failed under load. The
 * heartbeat is a timer in the worker entry, so it only misses when the handler
 * holds the event loop — which long synchronous stretches over a large
 * discography do. Yielding periodically is the structural fix; lengthening the
 * lease would only postpone the same failure.
 *
 * Chosen so a yield lands several times a second on a big catalogue without
 * making the loop itself measurably slower.
 */
export const MATCHING_YIELD_INTERVAL = 25;

/**
 * Also yield after this much wall-clock in one uninterrupted stretch.
 *
 * A count alone assumes albums cost roughly the same. One pathological album —
 * a 200-track compilation, a provider release matching thousands of candidate
 * recordings — can exceed the heartbeat interval on its own, and 24 more like
 * it would still not trip a count of 25.
 */
export const MATCHING_YIELD_MS = 150;

/**
 * Cooperative yield for the matcher's local loops: every N albums, or whenever
 * one stretch has run long enough to threaten the heartbeat.
 */
export function createMatchingYield(): () => Promise<void> {
  let sinceYield = 0;
  let lastYieldAt = Date.now();
  return async () => {
    sinceYield += 1;
    if (sinceYield < MATCHING_YIELD_INTERVAL && Date.now() - lastYieldAt < MATCHING_YIELD_MS) {
      return;
    }
    sinceYield = 0;
    await yieldToEventLoop();
    lastYieldAt = Date.now();
  };
}

export class RefreshArtistService {
    private static readonly collaborationNegativeMissAt = new Map<string, number>();

    private static getArtistMusicBrainzId(artistId: string): string | null {
        const identity = loadArtistMetadataIdentity(artistId);
        return identity?.mbid ? String(identity.mbid) : null;
    }

    private static isVideoLibraryEnabled(): boolean {
        const row = db.prepare(`
            SELECT 1
            FROM Libraries library
            JOIN quality_profiles quality_profile
              ON quality_profile.id = library.quality_profile_id
            WHERE library.enabled = 1
              AND EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'video'
              )
            LIMIT 1
        `).get();
        return Boolean(row);
    }

    private static getEnabledAudioLibrarySlots(): Array<"stereo" | "spatial"> {
        const rows = db.prepare(`
            SELECT quality_profile.allowed_source_formats
            FROM Libraries library
            JOIN quality_profiles quality_profile
              ON quality_profile.id = library.quality_profile_id
            WHERE library.enabled = 1
            ORDER BY library.id
        `).all() as Array<{ allowed_source_formats: string | null }>;
        let hasStereo = false;
        let hasSpatial = false;
        for (const row of rows) {
            try {
                const formats = JSON.parse(String(row.allowed_source_formats || "[]"));
                if (!Array.isArray(formats)) continue;
                for (const raw of formats) {
                    const format = String(raw || "").trim().toLowerCase();
                    if (format === "spatial") hasSpatial = true;
                    if (format === "lossy" || format === "lossless" || format === "hires-lossless") {
                        hasStereo = true;
                    }
                }
            } catch {
                // Ignore malformed quality profile format JSON.
            }
        }
        const slots: Array<"stereo" | "spatial"> = [];
        if (hasStereo) slots.push("stereo");
        if (hasSpatial) slots.push("spatial");
        return slots;
    }

    private static normalizeTimestampMs(raw: string | null | undefined): number | null {
        if (!raw) return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
            ? `${trimmed.replace(" ", "T")}Z`
            : trimmed;
        const parsed = Date.parse(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private static shouldRefreshProviderArtistCatalog(
        artistMbid: string | null,
        providerId: string,
    ): boolean {
        if (!artistMbid) return true;
        const row = db.prepare(`
            SELECT
                COUNT(DISTINCT release_item.id) AS matched_releases,
                MIN(COALESCE(release_item.checked_at, release_item.updated_at)) AS oldest_scan,
                MAX(album.first_release_date) AS latest_release_date
            FROM Albums album
            LEFT JOIN AlbumEditions edition
              ON edition.release_group_id = album.id
            LEFT JOIN ProviderEditionMatches release_match
              ON release_match.edition_id = edition.id
             AND release_match.match_state = 'accepted'
            LEFT JOIN ProviderItems release_item
              ON release_item.id = release_match.provider_edition_item_id
             AND release_item.provider = ?
             AND release_item.entity_type = 'release'
            WHERE album.artist_mbid = ?
        `).get(providerId, artistMbid) as {
            matched_releases?: number;
            oldest_scan?: string | null;
            latest_release_date?: string | null;
        } | undefined;

        const matchedReleases = Number(row?.matched_releases || 0);
        const oldestScanMs = this.normalizeTimestampMs(row?.oldest_scan ?? null);
        if (matchedReleases === 0 || oldestScanMs === null) {
            return true;
        }

        return shouldRefreshAlbum({
            albumReleaseDate: row?.latest_release_date ?? null,
            lastScanned: new Date(oldestScanMs).toISOString(),
        });
    }

    private static async syncArtistMusicBrainzCatalog(
        artistId: string,
        force = false,
        includeCreditedReleaseGroups = false,
    ): Promise<{ artistMbid: string | null; creditedArtistMbids: string[] }> {
        const artistMbid = this.getArtistMusicBrainzId(artistId);
        if (!artistMbid) {
            return { artistMbid: null, creditedArtistMbids: [] };
        }

        void force;
        await servarrMetadata.syncArtist(artistMbid);
        let creditedArtistMbids: string[] = [];
        if (includeCreditedReleaseGroups) {
            const credited = await MusicBrainzArtistCreditService.syncCreditedReleaseGroupsForArtist(artistMbid);
            creditedArtistMbids = credited.artistMbids.filter((mbid) => mbid !== artistMbid);
            console.log(
                `[RefreshArtistService] Synced ${credited.releaseGroups} credited MusicBrainz release group(s) ` +
                `and ${credited.artists} credited artist(s) for ${artistMbid}`,
            );
        }
        if (this.isVideoLibraryEnabled()) {
            const syncedVideos = await syncMusicBrainzVideosForArtist(artistMbid, { force: true });
            if (syncedVideos > 0) {
                console.log(`[RefreshArtistService] Synced ${syncedVideos} MusicBrainz video recording(s) for artist ${artistMbid}`);
            }
            try {
                const youtubeVideos = await syncYouTubeVideoCatalogForArtist(artistId, artistMbid);
                if (youtubeVideos > 0) {
                    console.log(`[RefreshArtistService] Synced ${youtubeVideos} YouTube video recording(s) for artist ${artistMbid}`);
                }
            } catch (error) {
                console.warn(`[RefreshArtistService] YouTube video catalog sync failed for ${artistMbid}:`, error);
            }
            try {
                const backfilled = await RefreshVideoService.backfillMissingVideoOfferQuality(artistMbid);
                if (backfilled > 0) {
                    console.log(`[RefreshArtistService] Backfilled quality on ${backfilled} video offer(s) for artist ${artistMbid}`);
                }
            } catch (error) {
                console.warn(`[RefreshArtistService] Video offer quality backfill failed for ${artistMbid}:`, error);
            }
        }

        return { artistMbid, creditedArtistMbids };
    }

    /**
     * Video→audio relations that need hydrated Tracks: mixed-edition membership
     * first, then the shared title+duration function for leftover standalone OMVs.
     */
    private static async syncCatalogVideoAudioRelations(artistMbid: string): Promise<void> {
        if (!this.isVideoLibraryEnabled()) {
            return;
        }
        const editionVideoRelations = await syncVideoRelationsFromEditionMembership(artistMbid);
        if (editionVideoRelations > 0) {
            console.log(`[RefreshArtistService] Derived ${editionVideoRelations} video→audio relation(s) from canonical edition membership for ${artistMbid}`);
        }
        const inferred = await RefreshVideoService.linkCatalogVideoAudioRelations(artistMbid);
        if (inferred > 0) {
            console.log(`[RefreshArtistService] Linked ${inferred} catalog video→audio relation(s) for ${artistMbid}`);
        }
    }

    private static async hydrateScopedReleaseGroups(artistMbid: string, options?: RefreshOptions): Promise<void> {
        const releaseGroups = db.prepare(`
            SELECT DISTINCT rg.mbid
            FROM Albums rg
            LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
            ORDER BY rg.mbid ASC
        `).all(artistMbid, artistMbid) as Array<{ mbid: string }>;

        // Reconcile EVERY scoped release group. Missing-releases-only hydration
        // froze Softly-class albums after first write (null ISRCs, empty labels)
        // even though local MusicBrainz already had the data. content_hash still
        // skips unchanged payloads inside syncArtistReleaseGroups.
        const releaseGroupMbids = releaseGroups.map((releaseGroup) => releaseGroup.mbid);
        await servarrMetadata.syncArtistReleaseGroups(artistMbid, releaseGroupMbids, (index, total) => {
            options?.progress?.({
                kind: "album",
                index,
                total,
                albumId: "",
                title: "",
                created: false,
            });
        });
        // Covers wait for MatchArtistProviders.precacheArtistMediaCovers().
        // Hitting Cover Art Archive here made local-MB RefreshArtist look
        // rate-limited: every scoped album (and every collaborator's albums)
        // paid CAA even though Postgres itself is unthrottled.
    }

    static async upsertMusicBrainzArtist(artistMbid: string, options: RefreshOptions = {}): Promise<string> {
        if (!isMusicBrainzMbid(artistMbid)) {
            throw new Error(`Invalid MusicBrainz artist id: ${artistMbid}`);
        }

        const existingIdentity = loadArtistMetadataIdentity(artistMbid);
        const shouldMonitor = options.monitorArtist === true
            ? true
            : (existingIdentity ? Boolean(existingIdentity.in_library) : false);
        const artistData = await servarrMetadata.syncArtist(artistMbid);
        const artistName = artistData.artistname || "Unknown Artist";
        const providerArtworkRows = db.prepare(`
            SELECT
              item.provider,
              item.provider_id,
              COALESCE(item.artwork_url, item.cover_id) AS cover,
              item.popularity
            FROM ProviderArtistMatches artist_match
            JOIN ProviderItems item
              ON item.id = artist_match.provider_artist_item_id
            JOIN ArtistMetadata canonical_artist ON canonical_artist.id = artist_match.artist_id
            WHERE item.entity_type = 'artist'
              AND canonical_artist.mbid = ?
              AND artist_match.match_state = 'accepted'
            ORDER BY
              CASE artist_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
              artist_match.confidence DESC,
              artist_match.updated_at DESC
        `).all(artistMbid) as Array<{ provider: string; provider_id: string; cover?: string | null; popularity?: number | null }>;

        let maxPopularity = 0;
        for (const row of providerArtworkRows) {
            if (typeof row.popularity === "number" && row.popularity > maxPopularity) {
                maxPopularity = row.popularity;
            }
        }

        const providerCandidates: ProviderArtworkCandidate[] = providerArtworkRows.map((row) => ({
            provider: row.provider,
            entityId: row.provider_id,
            imageId: row.cover,
        }));
        const posterUrl = await resolveArtistArtwork({
            artistMbid,
            servarrMetadataData: artistData,
            providerCandidates,
            preferredCoverTypes: ["Poster", "Headshot"],
        });
        const fanartUrl = await resolveArtistArtwork({
            artistMbid,
            servarrMetadataData: artistData,
            providerCandidates,
            preferredCoverTypes: ["Fanart"],
        }) || posterUrl;
        const resolvedArtistFolder = resolveArtistFolderForIdentityUpdate({
            artistId: artistMbid,
            artistName,
            artistMbId: artistMbid,
            artistDisambiguation: artistData.disambiguation || null,
            existingPath: existingIdentity?.path ?? null,
        });

        if (artistName === "Various Artists" || artistMbid === "0") {
            console.warn(`[RefreshArtistService] Cannot monitor 'Various Artists' (MBID: ${artistMbid}). Skipping.`);
            throw new Error("Cannot monitor 'Various Artists'. Please monitor specific compilations instead.");
        }

        await withSqliteWriteGate(() => {
            db.prepare(`
                UPDATE ArtistMetadata SET
                    name = ?,
                    picture = COALESCE(?, picture),
                    cover_image_url = COALESCE(?, cover_image_url),
                    popularity = ?,
                    overview = COALESCE(NULLIF(TRIM(overview), ''), ?),
                    type = COALESCE(?, type),
                    updated_at = CURRENT_TIMESTAMP
                WHERE mbid = ?
            `).run(
                artistName,
                posterUrl,
                fanartUrl,
                maxPopularity,
                artistData.overview || null,
                artistData.type || null,
                artistMbid,
            );

            const metadataId = resolveArtistMetadataId(artistMbid);
            if (metadataId != null && resolvedArtistFolder.path) {
                stampArtistLibraryPath(metadataId, resolvedArtistFolder.path, resolvedArtistFolder.shouldReplaceExistingPath);
            }

            if (shouldMonitor) {
                syncLibraryArtistMonitoring(artistMbid, true);
            }

        }, "refresh-artist:identity");

        return artistMbid;
    }

    private static async retryOnRateLimit<T>(
        operation: () => Promise<T>,
        context: {
            provider: StreamingProvider | string;
            action: string;
            maxRetries?: number;
            maxWaitMs?: number;
            options?: RefreshOptions;
        },
    ): Promise<T> {
        const providerName = typeof context.provider === "string" ? context.provider : context.provider.name;
        const providerId = typeof context.provider === "string" ? context.provider : context.provider.id;
        const maxRetries = context.maxRetries ?? 5;
        const maxWaitMs = context.maxWaitMs ?? 65_000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
                const isRateLimit =
                    error instanceof ProviderRateLimitError ||
                    error?.status === 429;

                if (!isRateLimit) {
                    throw error;
                }

                const state = providerRequestState();
                let waitMs = 0;
                if (error instanceof ProviderRateLimitError && error.retryAt) {
                    waitMs = Math.max(0, error.retryAt - Date.now());
                } else if (error?.retryAfterMs != null) {
                    waitMs = Math.max(0, error.retryAfterMs);
                } else {
                    const retryAt = state.retryAt(providerId);
                    if (retryAt > Date.now()) {
                        waitMs = retryAt - Date.now();
                    } else {
                        waitMs = Math.min(1000 * Math.pow(2, attempt - 1), maxWaitMs);
                    }
                }

                if (waitMs > maxWaitMs) {
                    console.warn(
                        `[RefreshArtistService] ${context.action} hit rate limit on ${providerName}; ` +
                        `advertised wait ${Math.ceil(waitMs)}ms exceeds maximum ${maxWaitMs}ms, deferring`
                    );
                    throw error;
                }

                const effectiveMaxRetries = waitMs >= 20_000 ? Math.min(maxRetries, 2) : maxRetries;
                if (attempt >= effectiveMaxRetries) {
                    console.warn(
                        `[RefreshArtistService] ${context.action} hit rate limit on ${providerName}; ` +
                        `giving up after ${attempt} attempts`
                    );
                    throw error;
                }

                console.warn(
                    `[RefreshArtistService] ${context.action} hit rate limit on ${providerName}; ` +
                    `retrying (${attempt}/${effectiveMaxRetries}) after ${Math.ceil(waitMs)}ms`
                );
                context.options?.progress?.({
                    kind: "status",
                    message: `waiting out rate limit on ${providerName} (${Math.ceil(waitMs / 1000)}s)`,
                });
                if (waitMs > 0) {
                    await sleep(waitMs);
                }
            }
        }
        throw new Error(`Failed ${context.action} on ${providerName} after rate limit retries`);
    }

    private static isCollaborationNegativeMissFresh(providerId: string, releaseGroupMbid: string): boolean {
        const key = `${providerId}:${releaseGroupMbid}`;
        const missedAt = this.collaborationNegativeMissAt.get(key);
        if (missedAt === undefined) {
            return false;
        }
        if (Date.now() - missedAt < COLLABORATION_NEGATIVE_MISS_TTL_MS) {
            return true;
        }
        this.collaborationNegativeMissAt.delete(key);
        return false;
    }

    private static async searchCanonicalCollaborationOffers(
        provider: StreamingProvider,
        artistMbid: string | null,
        forceUpdate: boolean,
        reportPhase?: (message: string) => void,
        options?: RefreshOptions,
        includePrimaryUnmatched = false,
        alreadyMatchedRgMbids?: ReadonlySet<string>,
    ): Promise<{ albums: any[]; matches: Map<string, ProviderReleaseGroupMatch> }> {
        if (!artistMbid || !provider.searchReleaseGroup) {
            return { albums: [], matches: new Map() };
        }
        const slots = this.getEnabledAudioLibrarySlots();
        if (slots.length === 0) {
            return { albums: [], matches: new Map() };
        }

        const rawTargets = db.prepare(`
            SELECT DISTINCT
                rg.mbid,
                rg.title,
                rg.first_release_date,
                owner.name AS artist_name,
                (
                    SELECT release.track_count
                    FROM AlbumEditions release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_track_count,
                (
                    SELECT release.media_count
                    FROM AlbumEditions release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_volume_count,
                (
                    SELECT MAX(edition_match.updated_at)
                    FROM AlbumEditions edition
                    JOIN ProviderEditionMatches edition_match
                      ON edition_match.edition_id = edition.id
                    JOIN ProviderItems provider_item
                      ON provider_item.id = edition_match.provider_edition_item_id
                     AND provider_item.entity_type = 'release'
                    WHERE edition.release_group_mbid = rg.mbid
                      AND provider_item.provider = ?
                ) AS last_match_attempt_at
            FROM Albums rg
            LEFT JOIN ArtistReleaseGroups scope
              ON scope.release_group_mbid = rg.mbid
             AND scope.artist_mbid = ?
            LEFT JOIN ArtistMetadata owner ON owner.mbid = rg.artist_mbid
            WHERE (
                (? = 1 AND (rg.artist_mbid = ? OR scope.artist_mbid = ?))
                OR (? = 0 AND scope.artist_mbid = ? AND rg.artist_mbid != ?)
              )
              AND (
                ? = 1
                OR NOT EXISTS (
                    SELECT 1
                    FROM AlbumEditions edition
                    JOIN ProviderEditionMatches edition_match
                      ON edition_match.edition_id = edition.id
                     AND edition_match.match_state = 'accepted'
                    JOIN ProviderItems provider_item
                      ON provider_item.id = edition_match.provider_edition_item_id
                     AND provider_item.entity_type = 'release'
                    WHERE edition.release_group_mbid = rg.mbid
                      AND provider_item.provider = ?
                )
              )
            ORDER BY COALESCE(rg.first_release_date, '') DESC, rg.mbid ASC
        `).all(
            provider.id,
            artistMbid,
            includePrimaryUnmatched ? 1 : 0,
            artistMbid,
            artistMbid,
            includePrimaryUnmatched ? 1 : 0,
            artistMbid,
            artistMbid,
            forceUpdate ? 1 : 0,
            provider.id,
        ) as Array<{
            mbid: string;
            title: string;
            first_release_date?: string | null;
            artist_name?: string | null;
            preferred_track_count?: number | null;
            preferred_volume_count?: number | null;
            last_match_attempt_at?: string | null;
        }>;

        const now = Date.now();
        const filteredTargets = rawTargets.filter((target) => {
            if (alreadyMatchedRgMbids?.has(target.mbid)) {
                return false;
            }
            if (forceUpdate) {
                return true;
            }
            if (this.isCollaborationNegativeMissFresh(provider.id, target.mbid)) {
                return false;
            }
            const lastAttemptMs = this.normalizeTimestampMs(target.last_match_attempt_at);
            if (lastAttemptMs !== null && now - lastAttemptMs < COLLABORATION_NEGATIVE_MISS_TTL_MS) {
                return false;
            }
            return true;
        });
        const targets = forceUpdate
            ? filteredTargets
            : filteredTargets.slice(0, MAX_COLLABORATION_SEARCHES_PER_REFRESH);
        if (targets.length === 0) {
            return { albums: [], matches: new Map() };
        }

        const cachedReleaseGroups = new Map(
            servarrMetadata.getCachedReleaseGroupsForArtist(artistMbid)
                .map((releaseGroup) => [releaseGroup.mbid, releaseGroup] as const),
        );
        const albumsByProviderId = new Map<string, any>();
        const matches = new Map<string, ProviderReleaseGroupMatch>();
        const yieldSearch = createMatchingYield();

        for (const [targetIndex, target] of targets.entries()) {
            await yieldSearch();
            const releaseGroup = cachedReleaseGroups.get(target.mbid) as MusicBrainzReleaseGroupForMatching | undefined;
            if (!releaseGroup) {
                continue;
            }
            const phaseMessage = `${provider.name}: searching collaborations (${targetIndex + 1}/${targets.length})`;
            reportPhase?.(phaseMessage);
            options?.progress?.({ kind: "status", message: phaseMessage });

            let matchedTarget = false;
            let hadSearchError = false;
            for (const slot of slots) {
                try {
                    const providerAlbums = await this.retryOnRateLimit(
                        () => provider.searchReleaseGroup!({
                            artistName: String(target.artist_name || ""),
                            releaseGroupMbid: target.mbid,
                            releaseGroupTitle: target.title,
                            releaseDate: target.first_release_date || null,
                            slot,
                            preferredTrackCount: target.preferred_track_count || null,
                            preferredVolumeCount: target.preferred_volume_count || null,
                        }),
                        {
                            provider,
                            action: `search canonical collaboration ${target.title} (${slot})`,
                            options,
                            maxWaitMs: 25_000,
                        },
                    );
                    const albums = providerAlbums.map((album) => providerAlbumToOfferRow(album, artistMbid));
                    const targetMatches = matchProviderAlbumsToReleaseGroups(
                        albums.map((album) => ({
                            provider: String(album.provider || provider.id),
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
                        })),
                        [releaseGroup],
                    );

                    for (const album of albums) {
                        const providerAlbumId = String(album.provider_id);
                        const match = targetMatches.get(providerAlbumId);
                        if (!match || match.status === "unmatched" || match.releaseGroup?.mbid !== target.mbid) {
                            continue;
                        }
                        albumsByProviderId.set(providerAlbumId, album);
                        matches.set(providerAlbumId, match);
                        matchedTarget = true;
                    }
                } catch (error) {
                    if (error instanceof ProviderRateLimitError) {
                        console.warn(`[RefreshArtistService] Deferring ${provider.name} collaboration searches: ${error.message}`);
                        return { albums: Array.from(albumsByProviderId.values()), matches };
                    }
                    hadSearchError = true;
                    console.warn(
                        `[RefreshArtistService] Failed to search ${provider.name} for canonical collaboration ` +
                        `${target.title} (${target.mbid}):`,
                        error,
                    );
                }
            }
            const missKey = `${provider.id}:${target.mbid}`;
            if (matchedTarget) {
                this.collaborationNegativeMissAt.delete(missKey);
            } else if (!hadSearchError) {
                this.collaborationNegativeMissAt.set(missKey, Date.now());
            }
        }

        return {
            albums: Array.from(albumsByProviderId.values()),
            matches,
        };
    }

    private static markSoundCloudPlaylistOfferUnavailable(
        providerAlbumId: string,
        reason: "missing" | "empty" | "coverage-changed" | "drm-only",
    ): void {
        db.transaction(() => {
            const releaseRow = db.prepare(`
                SELECT id
                FROM ProviderItems
                WHERE provider = 'soundcloud'
                  AND entity_type = 'release'
                  AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                LIMIT 1
            `).get(providerAlbumId) as { id: number } | undefined;
            if (!releaseRow) {
                return;
            }
            const checkedAt = new Date().toISOString();
            db.prepare(`
                UPDATE ProviderItems
                SET availability = 'unavailable',
                    availability_reason = ?,
                    checked_at = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                   OR (
                     provider = 'soundcloud'
                     AND entity_type = 'track'
                     AND id IN (
                       SELECT member_item_id
                       FROM ProviderEditionMembers
                       WHERE provider_edition_item_id = ?
                     )
                   )
            `).run(reason, checkedAt, releaseRow.id, releaseRow.id);
            db.prepare(`
                UPDATE ProviderEditionMatches
                SET match_state = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE provider_edition_item_id = ?
                  AND method = ?
            `).run(releaseRow.id, PLAYLIST_TRACKLIST_COVERAGE_METHOD);
        })();
    }

    private static isMissingSoundCloudResourceError(error: unknown): boolean {
        const status = Number((error as { status?: unknown } | null)?.status);
        return status === 404 || status === 410;
    }

    /**
     * SoundCloud-only wide search for less-official release groups (mixtape/street,
     * dj-mix, demo, primary Other) that were not matched from the artist’s official
     * album catalog. Fan playlists may be supersets — coverage of the MB tracklist
     * is required; conviction is always `probable` via playlist-tracklist-coverage.
     */
    private static async searchSoundCloudMixtapePlaylistOffers(
        provider: StreamingProvider,
        artistMbid: string | null,
        alreadyMatchedRgMbids: Set<string>,
    ): Promise<{ albums: any[]; matches: Map<string, ProviderReleaseGroupMatch> }> {
        if (!artistMbid || provider.id !== "soundcloud" || !provider.searchReleaseGroup) {
            return { albums: [], matches: new Map() };
        }

        const cachedReleaseGroups = servarrMetadata.getCachedReleaseGroupsForArtist(artistMbid);
        const cachedByMbid = new Map(
            cachedReleaseGroups.map((releaseGroup) => [releaseGroup.mbid, releaseGroup] as const),
        );

        const targets = db.prepare(`
            SELECT
                rg.mbid,
                rg.title,
                rg.primary_type,
                rg.secondary_types,
                rg.first_release_date,
                owner.name AS artist_name,
                (
                    SELECT release.mbid
                    FROM AlbumEditions release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_release_mbid,
                (
                    SELECT release.track_count
                    FROM AlbumEditions release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_track_count
            FROM Albums rg
            LEFT JOIN ArtistMetadata owner ON owner.mbid = rg.artist_mbid
            WHERE rg.artist_mbid = ?
            ORDER BY rg.mbid ASC
        `).all(artistMbid) as Array<{
            mbid: string;
            title: string;
            primary_type?: string | null;
            secondary_types?: string | null;
            first_release_date?: string | null;
            artist_name?: string | null;
            preferred_release_mbid?: string | null;
            preferred_track_count?: number | null;
        }>;

        const albumsByProviderId = new Map<string, any>();
        const matches = new Map<string, ProviderReleaseGroupMatch>();
        const loadTracks = db.prepare(`
            SELECT title, length_ms, position
            FROM Tracks
            WHERE release_mbid = ?
            ORDER BY medium_position, position
        `);
        const loadStoredPlaylistOffers = db.prepare(`
            SELECT CAST(item.provider_id AS TEXT) AS provider_id
            FROM ProviderEditionMatches release_match
            JOIN ProviderItems item
              ON item.id = release_match.provider_edition_item_id
            JOIN AlbumEditions release ON release.id = release_match.edition_id
            JOIN Albums release_group ON release_group.id = release.release_group_id
            WHERE item.provider = 'soundcloud'
              AND item.entity_type = 'release'
              AND release_group.mbid = ?
              AND release_match.method = ?
              AND release_match.match_state IN ('accepted', 'candidate')
            ORDER BY release_match.updated_at DESC, item.provider_id ASC
        `);

        for (const target of targets) {
            if (!isWidePlaylistSearchReleaseGroup(target.primary_type, target.secondary_types)) {
                continue;
            }
            const releaseGroup = cachedByMbid.get(target.mbid);
            if (!releaseGroup) continue;

            let secondaryTypes: string[] = [];
            try {
                const parsed = JSON.parse(String(target.secondary_types || "[]"));
                secondaryTypes = Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
            } catch {
                secondaryTypes = [];
            }

            const preferredTracks = target.preferred_release_mbid
                ? (loadTracks.all(target.preferred_release_mbid) as Array<{
                    title: string | null;
                    length_ms: number | null;
                    position: number | null;
                }>).map((row) => ({
                    title: String(row.title || ""),
                    durationSec: row.length_ms != null ? Math.round(Number(row.length_ms) / 1000) : null,
                    trackNumber: row.position ?? null,
                })).filter((row) => row.title)
                : [];
            if (preferredTracks.length === 0) continue;

            const validatePlaylist = async (providerAlbum: ProviderAlbum): Promise<{
                album: any | null;
                match: ProviderReleaseGroupMatch | null;
                invalidReason: "empty" | "coverage-changed" | "drm-only" | null;
            }> => {
                const album = {
                    ...providerAlbumToOfferRow(providerAlbum, artistMbid),
                    provider: provider.id,
                };
                const providerAlbumId = String(album.provider_id);
                const rawTracks = await provider.getAlbumTracks(providerAlbum.providerId);
                if (rawTracks.length === 0) {
                    return { album: null, match: null, invalidReason: "empty" };
                }
                // Require downloadable coverage — DRM/SNIP-only shells are not matches.
                if (!playlistCoversCanonicalTracklistDownloadable(preferredTracks, rawTracks)) {
                    const titleCoverage = scorePlaylistTracklistCoverage(preferredTracks, rawTracks);
                    const classifiable = (titleCoverage.downloadable?.downloadableCovered || 0)
                        + (titleCoverage.downloadable?.knownUndownloadableCovered || 0);
                    // Title covered but nothing downloadable → durable reject as drm-only.
                    if (titleCoverage.covered > 0 && classifiable > 0
                        && (titleCoverage.downloadable?.downloadableCovered || 0) === 0) {
                        return { album: null, match: null, invalidReason: "drm-only" };
                    }
                    return { album: null, match: null, invalidReason: "coverage-changed" };
                }

                album._provider_tracks = rawTracks.map((track: any) => slotTrack(track));
                album._provider_raw_tracks = rawTracks;
                album.num_tracks = rawTracks.length;

                const targetMatches = matchProviderAlbumsToReleaseGroups(
                    [{
                        provider: provider.id,
                        providerId: providerAlbumId,
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
                    }],
                    [releaseGroup],
                );
                const match = targetMatches.get(providerAlbumId);
                if (!match || match.status === "unmatched" || match.releaseGroup?.mbid !== target.mbid) {
                    return { album: null, match: null, invalidReason: null };
                }

                // Fan playlists are never verified identity — keep probable with
                // an explicit coverage method so UI/slot logic treat them correctly.
                match.status = "probable";
                match.method = PLAYLIST_TRACKLIST_COVERAGE_METHOD;
                match.confidence = Math.max(Number(match.confidence || 0), 0.85);
                const coverage = scorePlaylistTracklistCoverage(preferredTracks, rawTracks);
                match.evidence = {
                    ...match.evidence,
                    trackCountMatched: false,
                    providerTrackCount: album.num_tracks ?? null,
                    targetTrackCount: preferredTracks.length,
                    downloadableTrackCount: coverage.downloadable?.downloadableCovered ?? null,
                    downloadableRatio: coverage.downloadable?.downloadableRatio ?? null,
                };
                return { album, match, invalidReason: null };
            };
            const acceptPlaylist = (album: any, match: ProviderReleaseGroupMatch): void => {
                const providerAlbumId = String(album.provider_id);
                albumsByProviderId.set(providerAlbumId, album);
                matches.set(providerAlbumId, match);
            };

            // Revalidate the durable offer first. This both repairs old NULL
            // permalinks and detects removed, emptied, or edited user sets even
            // when SoundCloud search no longer returns the playlist.
            let retainedStoredOffer = false;
            const storedOffers = loadStoredPlaylistOffers.all(
                target.mbid,
                PLAYLIST_TRACKLIST_COVERAGE_METHOD,
            ) as Array<{ provider_id: string }>;
            for (const stored of storedOffers) {
                try {
                    const providerAlbum = await provider.getAlbum(stored.provider_id);
                    const validated = await validatePlaylist(providerAlbum);
                    if (validated.invalidReason) {
                        this.markSoundCloudPlaylistOfferUnavailable(
                            stored.provider_id,
                            validated.invalidReason,
                        );
                        continue;
                    }
                    if (!validated.album || !validated.match) {
                        continue;
                    }
                    acceptPlaylist(validated.album, validated.match);
                    retainedStoredOffer = true;
                } catch (error) {
                    if (this.isMissingSoundCloudResourceError(error)) {
                        this.markSoundCloudPlaylistOfferUnavailable(stored.provider_id, "missing");
                        continue;
                    }
                    // A transient API/auth failure must not destroy a valid
                    // durable match. Leave it untouched and allow a later refresh.
                    console.warn(
                        `[RefreshArtistService] Failed to revalidate SoundCloud playlist ${stored.provider_id}:`,
                        error,
                    );
                }
            }
            if (retainedStoredOffer || alreadyMatchedRgMbids.has(target.mbid)) {
                continue;
            }

            try {
                const providerAlbums = await provider.searchReleaseGroup!({
                    artistName: String(target.artist_name || ""),
                    releaseGroupMbid: target.mbid,
                    releaseGroupTitle: target.title,
                    releaseDate: target.first_release_date || null,
                    slot: "stereo",
                    preferredTrackCount: target.preferred_track_count || preferredTracks.length,
                    primaryType: target.primary_type || null,
                    secondaryTypes,
                    preferredTracks,
                });
                if (providerAlbums.length === 0) continue;

                for (const providerAlbum of providerAlbums) {
                    const providerAlbumId = String(providerAlbum.providerId);
                    if (albumsByProviderId.has(providerAlbumId)) continue;

                    try {
                        const validated = await validatePlaylist(providerAlbum);
                        if (!validated.album || !validated.match) {
                            continue;
                        }
                        acceptPlaylist(validated.album, validated.match);
                        // One covering playlist per RG is enough for offer selection.
                        break;
                    } catch (error) {
                        console.warn(
                            `[RefreshArtistService] Failed to hydrate SoundCloud playlist ${providerAlbumId}:`,
                            error,
                        );
                    }
                }
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] SoundCloud mixtape playlist search failed for ${target.title} (${target.mbid}):`,
                    error,
                );
            }
        }

        return {
            albums: Array.from(albumsByProviderId.values()),
            matches,
        };
    }

    private static async storeProviderAlbumOffers(
        providerId: string,
        _artistMbid: string | null,
        albums: any[],
        _matches?: Map<string, ProviderReleaseGroupMatch>,
    ): Promise<void> {
        if (albums.length === 0) {
            return;
        }

        const normalizedCatalog = new ProviderCatalogRepository(db);

        // Chunk the per-album upserts so a prolific artist's provider catalog
        // doesn't hold the write lock for the whole batch and starve peers, and
        // take the process-global gate so peers *wait asynchronously* rather
        // than blocking their thread inside SQLite's busy handler — a blocked
        // worker cannot heartbeat, and the watchdog kills it for that.
        await runGatedChunkedWrite(albums, (album) => {
                const providerAlbumId = String(album.provider_id);
                const durationSeconds = Number(album.duration);
                const itemId = normalizedCatalog.upsertItem({
                    provider: providerId,
                    entityType: "release",
                    providerId: providerAlbumId,
                    title: album.title || null,
                    version: album.version || null,
                    providerType: album.type || null,
                    upc: album.upc || null,
                    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0
                        ? Math.round(durationSeconds * 1000)
                        : null,
                    releaseDate: album.release_date || null,
                    explicit: album.explicit == null ? null : Boolean(album.explicit),
                    availability: "available",
                    checkedAt: new Date().toISOString(),
                    providerUrl: album.url || null,
                    coverId: /^https?:\/\//i.test(String(album.cover || "")) ? null : album.cover || null,
                    artworkUrl: /^https?:\/\//i.test(String(album.cover || "")) ? album.cover || null : null,
                    volumeCount: album.num_volumes ?? null,
                    copyright: album.copyright || null,
                });
                const variants = providerAudioVariants(providerId, [
                    ...(Array.isArray(album.qualityTags) ? album.qualityTags : []),
                    album.quality,
                ]);
                if (variants.length > 0) {
                    normalizedCatalog.replaceAudioVariants(itemId, variants, { provider: providerId });
                }
        }, 50, `provider-album-offers:${providerId}`);
        // Acquire artwork after slot selection in precacheArtistMediaCovers().
        // Provisional matches can point several provider albums at one canonical
        // release group; warming them here raced unrelated covers into one cache.
    }

    private static reapplyArtistPathAfterIdentity(artistId: string): void {
        const identity = loadArtistMetadataIdentity(artistId);
        if (!identity?.name || !identity.mbid) {
            return;
        }

        const existingPath = String(identity.path || "").trim();
        if (existingPath && !shouldReapplyArtistPathTemplate({
            artistId,
            artistName: identity.name,
            artistMbId: identity.mbid,
            artistDisambiguation: null,
            existingPath,
        })) {
            return;
        }

        const nextPath = resolveArtistFolderFromTemplate({
            artistId,
            artistName: identity.name,
            artistMbId: identity.mbid,
            artistDisambiguation: null,
        });
        stampArtistLibraryPath(identity.id, nextPath, true);
    }

    /**
     * Whether an artist has never been refreshed (`last_info_sync` empty).
     * An artist is either refreshed or not — this replaces the old scan-level
     * state machine. The UI uses it only to auto-trigger an initial refresh;
     * ongoing staleness is decided by shouldRefreshArtist. The RefreshArtist
     * queue is per-ref exclusive, so a repeated trigger for a still-empty
     * artist can't pile up.
     */
    static needsInitialRefresh(artistId: string): boolean {
        const identity = loadArtistMetadataIdentity(artistId);
        return !identity || identity.last_scanned == null;
    }

    static async refreshArtistMetadata(artistId: string, options: RefreshOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] refreshArtistMetadata for ${artistId}`);

        const existing = loadArtistMetadataIdentity(artistId);
        const shouldRefresh =
            !existing ||
            options.forceUpdate === true ||
            shouldRefreshArtist({
                artistId,
                lastScanned: existing?.last_scanned,
            });

        const alreadyMonitored = existing ? Boolean(existing.in_library) : false;
        const shouldMonitor = options.monitorArtist === true ? true : alreadyMonitored;
        const provider = options.provider
            ? streamingProviderManager.getStreamingProvider(options.provider)
            : streamingProviderManager.getDefaultStreamingProvider();
        let providerCatalogAvailable = true;
        try {
            providerCatalogAvailable = Boolean((await provider.getAuthStatus()).remoteCatalogAvailable);
        } catch (error) {
            providerCatalogAvailable = provider.isAuthenticated ? provider.isAuthenticated() : false;
            console.warn(`[RefreshArtistService] Failed to read ${provider.name} catalog status:`, error);
        }

        if (isMusicBrainzMbid(artistId) && (!existing || existing.mbid === artistId || String(existing.id) === artistId)) {
            await this.upsertMusicBrainzArtist(artistId, options);
            console.log(`[RefreshArtistService] refreshArtistMetadata complete for MusicBrainz artist ${artistId}`);
            return;
        }

        if (existing?.mbid && !providerCatalogAvailable) {
            await this.upsertMusicBrainzArtist(String(existing.mbid), {
                ...options,
                monitorArtist: options.monitorArtist === true ? true : alreadyMonitored,
            });
            console.log(`[RefreshArtistService] refreshArtistMetadata skipped provider lookup for ${artistId} (provider not connected)`);
            return;
        }

        if (existing && !shouldRefresh) {
            if (options.monitorArtist === true && !alreadyMonitored) {
                syncLibraryArtistMonitoring(artistId, true);
            }

            if (!existing.mbid || options.forceUpdate === true) {
                await MetadataIdentityService.resolveArtist(artistId, { force: options.forceUpdate === true });
                this.reapplyArtistPathAfterIdentity(artistId);
                await this.syncArtistMusicBrainzCatalog(artistId, options.forceUpdate === true);
            }

            console.log(`[RefreshArtistService] refreshArtistMetadata skipped for ${artistId} (fresh)`);
            return;
        }

        const artistData = await provider.getArtist(artistId);
        const providerArtistIdentity = normalizeProviderArtist(artistData);
        const musicBrainzIdentity = await ProviderArtistIdentityService.resolve(provider.id, providerArtistIdentity);
        if (musicBrainzIdentity.mbid) {
            const localArtistId = await this.upsertMusicBrainzArtist(musicBrainzIdentity.mbid, {
                ...options,
                monitorArtist: shouldMonitor,
            });
            ProviderArtistIdentityService.store(provider.id, providerArtistIdentity, musicBrainzIdentity, localArtistId);
            if (localArtistId !== artistId) {
                await this.refreshArtistMetadata(localArtistId, {
                    ...options,
                    monitorArtist: shouldMonitor,
                });
            }
            return;
        }

        ProviderArtistIdentityService.store(provider.id, providerArtistIdentity, musicBrainzIdentity, null);
        throw new Error(
            `Could not match ${provider.name} artist "${artistData.name}" (${artistId}) to MusicBrainz. ` +
            "Discogenius v2 requires a canonical MusicBrainz artist before scanning provider availability.",
        );
    }

    static async refreshArtist(artistId: string, options: RefreshOptions = {}): Promise<ArtistRefreshResult> {
        console.log(`[RefreshArtistService] refreshArtist for ${artistId}`);
        options.progress?.({ kind: "status", message: `Scanning artist ${artistId}...` });

        const resolveArtistMbid = (): string | null =>
            loadArtistMetadataIdentity(artistId)?.mbid
            || (db.prepare("SELECT mbid FROM ArtistMetadata WHERE CAST(id AS TEXT) = CAST(? AS TEXT) OR mbid = ?")
                .get(artistId, artistId) as { mbid?: string | null } | undefined)?.mbid
            || (isMusicBrainzMbid(artistId) ? artistId : null);

        const artistIdentity = loadArtistMetadataIdentity(artistId);
        const lastScanned = artistIdentity?.last_scanned ?? null;
        const isNewArtist = !lastScanned;
        const beforeFingerprint = artistCatalogFingerprint(resolveArtistMbid());

        // ShouldRefreshArtist staleness gate.
        // Refresh iff forced, never scanned, or stale per the refresh policy
        // (12h-retry / 30d-hard / 2d-active / recent-release). One refresh path.
        const shouldRefresh =
            options.forceUpdate === true ||
            !artistIdentity ||
            shouldRefreshArtist({
                artistId,
                lastScanned,
            });

        if (!shouldRefresh) {
            console.log(`[RefreshArtistService] Skipping artist ${artistId} refresh (fresh)`);
            // Fresh: a deferred match would only rebuild slots from stored offers.
            return {
                artistMbid: resolveArtistMbid(),
                shouldHydrateCatalog: false,
                metadataChanged: false,
                isNewArtist: false,
                creditedArtistMbids: [],
            };
        }

        // Past the staleness gate, refresh always re-syncs canonical stubs/videos
        // and re-reconciles every scoped release group; content_hash skips
        // unchanged payloads so the write cost stays bounded.
        const shouldHydrateCatalog = true;

        // Canonical identity first, then MusicBrainz/Servarr catalog, then
        // provider biography. Catalog sync used to run after the bio write and
        // replace ArtistMetadata.overview with a null MB mapping.
        await this.refreshArtistMetadata(artistId, options);
        await yieldToEventLoop();

        let artistMbid = resolveArtistMbid();
        let creditedArtistMbids: string[] = [];

        {
            const isMonitored = isArtistLibraryMonitored(artistId);
            options.progress?.({ kind: "status", message: `syncing MusicBrainz catalog for ${artistId}` });
            const catalogSync = await this.syncArtistMusicBrainzCatalog(
                artistId,
                options.forceUpdate === true,
                isMonitored,
            );
            artistMbid = catalogSync.artistMbid;
            creditedArtistMbids = catalogSync.creditedArtistMbids;
            await yieldToEventLoop();
            if (artistMbid) {
                await this.hydrateScopedReleaseGroups(artistMbid, options);
                await yieldToEventLoop();
                if (this.isVideoLibraryEnabled()) {
                    options.progress?.({ kind: "status", message: `syncing catalog relations for ${artistId}` });
                    await this.syncCatalogVideoAudioRelations(artistMbid);
                }
            }
        }

        options.progress?.({ kind: "status", message: `refreshing biography for ${artistId}` });
        await refreshArtistBiography(artistId, options);
        await yieldToEventLoop();

        // The RefreshArtist command path defers matching to a standalone
        // MatchArtistProviders command (it enqueues one with the returned
        // context). Direct callers (scheduler, bulk RefreshMetadata) keep the
        // inline match so their single-job behaviour is unchanged.
        if (options.deferProviderMatching !== true) {
            await this.matchArtistProviders(artistId, artistMbid, options, shouldHydrateCatalog);
            await withSqliteWriteGate(() => this.markArtistRefreshComplete(artistId), "refresh-artist:complete");
        }

        console.log(`[RefreshArtistService] refreshArtist complete for ${artistId}`);
        return {
            artistMbid,
            shouldHydrateCatalog,
            metadataChanged: beforeFingerprint !== artistCatalogFingerprint(artistMbid),
            isNewArtist,
            creditedArtistMbids,
        };
    }

    /**
     * Commit the durable refresh watermark only after the provider-matching
     * phase succeeds. Deferred command workflows call this from
     * MatchArtistProviders; direct callers call it immediately after their
     * inline match.
     */
    static markArtistRefreshComplete(artistId: string): void {
        const metadataId = resolveArtistMetadataId(artistId);
        if (metadataId == null) return;
        stampArtistLibraryRefresh(metadataId);
    }

    /**
     * Provider matching for an artist: resolve the provider's artist id, refresh
     * its music videos, pull its release offers, match each to a MusicBrainz
     * release group, persist the offers, and select provider slots.
     *
     * Extracted verbatim from refreshArtist as the seam for a standalone
     * MatchArtistProviders command that runs AFTER metadata refresh (keeps
     * import-list/availability work separate from metadata refresh). Behaviour-
     * preserving: same order, same writes, same logs. When the catalog was not
     * (re)hydrated this just rebuilds slot selections from stored offers; when no
     * providers are connected it is a no-op (a successful refresh still stamps
     * last_scanned after this method returns).
     */
    static async matchArtistProviders(
        artistId: string,
        artistMbid: string | null,
        options: RefreshOptions,
        shouldHydrateCatalog: boolean,
    ): Promise<void> {
        const providers = streamingProviderManager.getAllStreamingProviders();
        const providerStatuses = await Promise.all(providers.map(async (provider) => {
            try {
                const status = await provider.getAuthStatus();
                return { provider, status };
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to read ${provider.name} catalog status:`, error);
                return null;
            }
        }));
        const resolvedStatuses = providerStatuses.filter(
            (entry): entry is NonNullable<typeof entry> => entry !== null,
        );

        // Album/track OFFERS only come from plugins the user actually connected.
        // Deezer and YouTube Music expose a PUBLIC catalog (remoteCatalogAvailable
        // is true with no credentials), so keying off that injected offers for
        // providers the user never added in Settings.
        const connectedProviders = resolvedStatuses
            .filter((entry) => entry.status.connected)
            .map((entry) => entry.provider);

        const videoEnabled = this.isVideoLibraryEnabled();
        const shouldRefreshArtistVideos =
            videoEnabled && (
                options.forceUpdate === true ||
                shouldRefreshVideos({ artistId })
            );
        const videoCatalogProviders = videoEnabled
            ? connectedProviders.filter(
                (provider) => Boolean(provider.getArtistVideos) && !isCoreVideoCatalogProvider(provider.id),
            )
            : [];

        if (!shouldHydrateCatalog) {
            console.log(`[RefreshArtistService] Skipping broad catalog hydration for artist ${artistId} (managed metadata already present)`);

            if (shouldRefreshArtistVideos) {
                try {
                    await syncYouTubeVideoCatalogForArtist(artistId, artistMbid);
                } catch (error) {
                    console.warn(`[RefreshArtistService] YouTube video catalog sync failed for ${artistId}:`, error);
                }
                await this.refreshProviderVideos(videoCatalogProviders, artistId, artistMbid, options);
            }
            await withSqliteWriteGate(() => ArtistTopTrackService.rebuildForArtist(artistId, artistMbid), "refresh-artist:top-tracks");
            await this.refreshMissingAlbumReviews(artistMbid, options.forceUpdate === true);
            await this.precacheArtistMediaCovers(artistId, artistMbid);
            return;
        }

        if (connectedProviders.length === 0) {
            console.log(
                `[RefreshArtistService] Skipping provider catalog hydration for ${artistId} ` +
                `(no providers connected)`,
            );
            await withSqliteWriteGate(() => ArtistTopTrackService.rebuildForArtist(artistId, artistMbid), "refresh-artist:top-tracks");
            await this.precacheArtistMediaCovers(artistId, artistMbid);
            return;
        }

        let totalAlbumsCount = 0;
        const loadMaterializedTracks = db.prepare(`
            SELECT
                track_item.provider_id,
                COALESCE(member.contextual_title, track_item.title) AS title,
                track_item.isrc,
                COALESCE(
                  ROUND(member.contextual_duration_ms / 1000.0),
                  ROUND(track_item.duration_ms / 1000.0)
                ) AS duration,
                member.position AS track_number,
                member.medium_position AS volume_number,
                track_item.updated_at AS updated_at
            FROM ProviderItems release_item
            JOIN ProviderEditionMembers member
              ON member.provider_edition_item_id = release_item.id
            JOIN ProviderItems track_item
              ON track_item.id = member.member_item_id
             AND track_item.entity_type = 'track'
            WHERE release_item.provider = ?
              AND release_item.entity_type = 'release'
              AND release_item.provider_id = ?
            ORDER BY member.medium_position, member.position
        `);

        const runningPhases = new Map<string, string>();
        const matchOneProvider = async (provider: StreamingProvider) => {
            const reportPhase = (message: string) => {
                runningPhases.set(provider.name, message.replace(`${provider.name}: `, ""));
                options.progress?.({ kind: "provider_phase", message });
            };
            const ingestProviderAlbums = async (
                albums: any[],
                seededMatches: Map<string, ProviderReleaseGroupMatch>,
            ): Promise<Map<string, ProviderReleaseGroupMatch>> => {
                if (albums.length === 0) {
                    return new Map();
                }

                const yieldMaterialize = createMatchingYield();
                const tracklistTtlMs = ALBUM_HARD_REFRESH_DAYS * DAY_MS;
                const nowMs = Date.now();
                for (const album of albums) {
                    await yieldMaterialize();
                    if (options.forceUpdate === true || Array.isArray(album._provider_tracks)) {
                        continue;
                    }
                    const numTracks = Number(album.num_tracks);
                    const materialized = loadMaterializedTracks.all(
                        provider.id,
                        String(album.provider_id),
                    ) as Array<{
                        provider_id: string;
                        title: string | null;
                        isrc: string | null;
                        duration: number | null;
                        track_number: number | null;
                        volume_number: number | null;
                        updated_at: string | null;
                    }>;
                    if (materialized.length === 0) {
                        continue;
                    }
                    if (Number.isFinite(numTracks) && numTracks > 0 && materialized.length !== numTracks) {
                        continue;
                    }
                    const isStale = materialized.some((row) => {
                        const updatedMs = this.normalizeTimestampMs(row.updated_at);
                        return updatedMs !== null && nowMs - updatedMs >= tracklistTtlMs;
                    });
                    if (isStale) {
                        continue;
                    }
                    if (!Number.isFinite(numTracks) || numTracks <= 0) {
                        album.num_tracks = materialized.length;
                    }
                    album._provider_tracks = materialized.map((row) => ({
                        mbid: null,
                        provider_id: row.provider_id || null,
                        isrc: normalizeIsrc(row.isrc) || null,
                        title: row.title || null,
                        track_number: row.track_number || null,
                        volume_number: row.volume_number || 1,
                        duration: row.duration || null,
                    }));
                }

                options.progress?.({ kind: "albums_total", total: albums.length });

                const preliminaryMatches = buildProviderReleaseGroupMatches(artistMbid, albums);
                for (const [providerAlbumId, match] of seededMatches) {
                    preliminaryMatches.set(providerAlbumId, match);
                }
                const candidateAlbumIds = new Set(
                    Array.from(preliminaryMatches.values())
                        .filter((match) => Boolean(match.releaseGroup))
                        .map((match) => String(match.providerId)),
                );
                const missingAlbums = albums.filter((album) =>
                    !album._provider_tracks
                    && candidateAlbumIds.has(String(album.provider_id)),
                );
                const skippedTracklists = albums.length
                    - albums.filter((album) => Boolean(album._provider_tracks)).length
                    - missingAlbums.length;
                if (skippedTracklists > 0) {
                    console.log(
                        `[RefreshArtistService] Skipping ${skippedTracklists} non-candidate tracklist(s) `
                        + `from ${provider.name}; hydrating ${missingAlbums.length}/${albums.length} plausible releases`,
                    );
                }
                if (missingAlbums.length > 0) {
                    console.log(`[RefreshArtistService] Fetching tracklists for ${missingAlbums.length} albums from ${provider.name}...`);
                    reportPhase(`${provider.name}: fetching tracklists`);
                    let bulkTracks: Map<string, any> | null = null;
                    if (provider.getAlbumTracksBulk) {
                        try {
                            bulkTracks = await this.retryOnRateLimit(
                                () => provider.getAlbumTracksBulk!(missingAlbums.map((album) => String(album.provider_id))),
                                { provider, action: `bulk tracklist fetch for ${missingAlbums.length} albums`, options },
                            );
                        } catch (error) {
                            console.warn(`[RefreshArtistService] Bulk tracklist fetch failed for ${provider.name}, falling back per-album:`, error);
                        }
                    }

                    const chunkSize = 5;
                    for (let i = 0; i < missingAlbums.length; i += chunkSize) {
                        const chunk = missingAlbums.slice(i, i + chunkSize);
                        await Promise.all(
                            chunk.map(async (album) => {
                                try {
                                    const batched = bulkTracks?.get(String(album.provider_id));
                                    const completeBatch = completeBulkTrackList(album.num_tracks, batched);
                                    const rawTracks = completeBatch
                                        ? completeBatch
                                        : await this.retryOnRateLimit(
                                            () => provider.getAlbumTracks(album.provider_id),
                                            { provider, action: `fetch tracks for album ${album.provider_id}`, options },
                                        );
                                    album._provider_tracks = rawTracks.map((t: any) => slotTrack(t));
                                    album._provider_raw_tracks = rawTracks;
                                } catch (error) {
                                    console.warn(`[RefreshArtistService] Failed to fetch tracks for album ${album.provider_id}:`, error);
                                    album._provider_tracks = [];
                                }
                            }),
                        );
                        const fetched = Math.min(i + chunkSize, missingAlbums.length);
                        const lastAlbum = chunk[chunk.length - 1];
                        options.progress?.({
                            kind: "album",
                            index: fetched,
                            total: missingAlbums.length,
                            albumId: String(lastAlbum?.provider_id ?? ""),
                            title: String(lastAlbum?.title ?? ""),
                            created: false,
                        });
                    }
                }

                const providerReleaseGroupMatches = buildProviderReleaseGroupMatches(artistMbid, albums);
                for (const [providerAlbumId, match] of seededMatches) {
                    providerReleaseGroupMatches.set(providerAlbumId, match);
                }
                console.log(`[RefreshArtistService] Found ${albums.length} albums on ${provider.name} for artist ${artistId}`);
                totalAlbumsCount += albums.length;

                await this.storeProviderAlbumOffers(provider.id, artistMbid, albums, providerReleaseGroupMatches);

                let rematchedReleases = 0;
                reportPhase(`${provider.name}: matching releases`);
                const yieldIngest = createMatchingYield();
                const ingestTotal = Math.max(albums.length, 1);
                for (const [albumIndex, album] of albums.entries()) {
                    options.progress?.({
                        kind: "matching",
                        index: albumIndex + 1,
                        total: ingestTotal,
                        message: `matching ${provider.name} releases (${albumIndex + 1}/${albums.length})`,
                    });
                    await yieldIngest();
                    const providerAlbumId = String(album.provider_id);
                    const match = providerReleaseGroupMatches.get(providerAlbumId);
                    const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(match || null);
                    const rawTracks = album._provider_raw_tracks;
                    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
                        if (!album._provider_tracks) continue;
                        try {
                            if (await RefreshAlbumService.rematchStoredProviderRelease(
                                provider.id,
                                providerAlbumId,
                                matchedReleaseMbid,
                            )) {
                                rematchedReleases += 1;
                            }
                        } catch (error) {
                            console.warn(`[RefreshArtistService] Failed to re-match stored release ${providerAlbumId}:`, error);
                        }
                        continue;
                    }
                    try {
                        await RefreshAlbumService.storeProviderTrackOffers(
                            provider.id,
                            providerAlbumId,
                            rawTracks.map(providerTrackToTrackMetadataRow),
                            artistMbid,
                            matchedReleaseMbid,
                        );
                    } catch (error) {
                        console.warn(`[RefreshArtistService] Failed to persist track offers for album ${providerAlbumId}:`, error);
                    }

                    if (provider.id === "soundcloud"
                        && match
                        && match.method !== PLAYLIST_TRACKLIST_COVERAGE_METHOD
                        && rawTracks.length > 0) {
                        const downloadable = scoreSoundCloudDownloadableCoverage(
                            rawTracks.map((_: unknown, index: number) => ({ playlistIndex: index })),
                            rawTracks,
                            rawTracks.length,
                        );
                        if (!soundCloudOfferHasDownloadableMatch(downloadable)) {
                            const classifiable = downloadable.downloadableCovered
                                + downloadable.knownUndownloadableCovered;
                            if (classifiable > 0 && downloadable.downloadableCovered === 0) {
                                this.markSoundCloudPlaylistOfferUnavailable(providerAlbumId, "drm-only");
                                providerReleaseGroupMatches.delete(providerAlbumId);
                            }
                        }
                    }
                }
                if (rematchedReleases > 0) {
                    console.log(`[RefreshArtistService] Re-matched ${rematchedReleases} already-materialized ${provider.name} release(s) from stored rows`);
                }

                return providerReleaseGroupMatches;
            };

            reportPhase(`${provider.name}: finding the artist`);
            const providerArtistIds = await resolveProviderArtistIds(provider, artistId, artistMbid);
            const shouldFetchOwnCatalog =
                providerArtistIds.length > 0 && (
                    options.forceUpdate === true ||
                    this.shouldRefreshProviderArtistCatalog(artistMbid, provider.id)
                );

            let ownAlbums: any[] = [];
            let ownReleaseGroupMatches = new Map<string, ProviderReleaseGroupMatch>();
            if (providerArtistIds.length > 0 && !shouldFetchOwnCatalog) {
                console.log(`[RefreshArtistService] Skipping ${provider.name} album catalog listing for ${artistId} (fresh)`);
            } else if (shouldFetchOwnCatalog) {
                try {
                    const providerAlbums: ProviderAlbum[] = [];
                    const seenProviderAlbumIds = new Set<string>();
                    for (const providerArtistId of providerArtistIds) {
                        reportPhase(`${provider.name}: listing releases`);
                        const identityAlbums = await this.retryOnRateLimit(
                            () => (provider.listArtistReleaseOffers
                                ? provider.listArtistReleaseOffers(providerArtistId)
                                : provider.getArtistAlbums(providerArtistId)),
                            { provider, action: `fetch artist albums for ${providerArtistId}`, options },
                        );
                        for (const album of identityAlbums) {
                            const key = String(album.providerId);
                            if (seenProviderAlbumIds.has(key)) continue;
                            seenProviderAlbumIds.add(key);
                            providerAlbums.push(album);
                        }
                    }
                    if (providerArtistIds.length > 1) {
                        console.log(`[RefreshArtistService] Merged ${providerAlbums.length} releases from ${providerArtistIds.length} ${provider.name} identities for ${artistId}`);
                    }
                    ownAlbums = providerAlbums.map((album) => ({
                        ...providerAlbumToOfferRow(album, artistId),
                        provider: provider.id,
                    }));
                    ownReleaseGroupMatches = await ingestProviderAlbums(ownAlbums, new Map());
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to fetch albums on ${provider.name} for ${artistId}:`, error);
                }
            }

            const alreadyMatchedRgMbids = new Set<string>();
            for (const match of ownReleaseGroupMatches.values()) {
                if (match.releaseGroup?.mbid && (match.status === "verified" || match.status === "probable")) {
                    alreadyMatchedRgMbids.add(match.releaseGroup.mbid);
                }
            }

            const collaborationOffers = await this.searchCanonicalCollaborationOffers(
                provider,
                artistMbid,
                options.forceUpdate === true,
                reportPhase,
                options,
                providerArtistIds.length > 0 && !shouldFetchOwnCatalog,
                alreadyMatchedRgMbids,
            );
            if (providerArtistIds.length === 0 && collaborationOffers.albums.length === 0) {
                console.log(`[RefreshArtistService] Skipping catalog hydration on ${provider.name} for ${artistId} (no provider artist match)`);
                return;
            }

            if (collaborationOffers.albums.length > 0) {
                const ownAlbumIds = new Set(ownAlbums.map((album) => String(album.provider_id)));
                const newCollaborationAlbums = collaborationOffers.albums
                    .filter((album) => !ownAlbumIds.has(String(album.provider_id)))
                    .map((album) => ({ ...album, provider: provider.id }));
                if (newCollaborationAlbums.length > 0) {
                    try {
                        await ingestProviderAlbums(newCollaborationAlbums, collaborationOffers.matches);
                    } catch (error) {
                        console.warn(`[RefreshArtistService] Failed to ingest collaboration albums on ${provider.name} for ${artistId}:`, error);
                    }
                }
            }

            if (shouldRefreshArtistVideos && providerArtistIds.length > 0 && !isCoreVideoCatalogProvider(provider.id)) {
                try {
                    reportPhase(`${provider.name}: fetching videos`);
                    await this.refreshProviderVideosForMatchedArtist(provider, providerArtistIds[0], artistId, options);
                } catch (err) {
                    console.warn(`[RefreshArtistService] Non-fatal error fetching videos on ${provider.name} for ${artistId}:`, err);
                }
            }

            if (provider.id === "soundcloud") {
                try {
                    const matchedRgMbids = new Set(
                        Array.from(ownReleaseGroupMatches.entries())
                            .filter(([providerAlbumId, match]) => {
                                if (!match.releaseGroup) return false;
                                if (!["verified", "probable", "candidate"].includes(match.status)) {
                                    return false;
                                }
                                if (match.method === PLAYLIST_TRACKLIST_COVERAGE_METHOD) {
                                    return true;
                                }
                                const hasShape = match.evidence?.trackCountMatched === true
                                    || Number(match.evidence?.providerTrackCount || 0) > 0;
                                if (!hasShape) return false;
                                const album = ownAlbums.find((row) =>
                                    String(row.provider_id) === String(providerAlbumId));
                                const rawTracks = Array.isArray(album?._provider_raw_tracks)
                                    ? album._provider_raw_tracks
                                    : [];
                                if (rawTracks.length === 0) {
                                    return false;
                                }
                                const downloadable = scoreSoundCloudDownloadableCoverage(
                                    rawTracks.map((_: unknown, index: number) => ({ playlistIndex: index })),
                                    rawTracks,
                                    rawTracks.length,
                                );
                                return soundCloudOfferHasDownloadableMatch(downloadable);
                            })
                            .map(([, match]) => String(match.releaseGroup!.mbid)),
                    );
                    const widePlaylistOffers = await this.searchSoundCloudMixtapePlaylistOffers(
                        provider,
                        artistMbid,
                        matchedRgMbids,
                    );
                    if (widePlaylistOffers.albums.length > 0) {
                        await this.storeProviderAlbumOffers(
                            provider.id,
                            artistMbid,
                            widePlaylistOffers.albums,
                            widePlaylistOffers.matches,
                        );
                        for (const album of widePlaylistOffers.albums) {
                            const rawTracks = album._provider_raw_tracks;
                            if (!Array.isArray(rawTracks) || rawTracks.length === 0) continue;
                            try {
                                const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(
                                    widePlaylistOffers.matches.get(String(album.provider_id)) || null,
                                );
                                await RefreshAlbumService.storeProviderTrackOffers(
                                    provider.id,
                                    String(album.provider_id),
                                    rawTracks.map(providerTrackToTrackMetadataRow),
                                    artistMbid,
                                    matchedReleaseMbid,
                                );
                            } catch (error) {
                                console.warn(
                                    `[RefreshArtistService] Failed to persist mixtape playlist track offers for ${album.provider_id}:`,
                                    error,
                                );
                            }
                        }
                        totalAlbumsCount += widePlaylistOffers.albums.length;
                        console.log(
                            `[RefreshArtistService] Added ${widePlaylistOffers.albums.length} SoundCloud mixtape/playlist offer(s) for ${artistId}`,
                        );
                    }
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to search SoundCloud mixtape playlists for ${artistId}:`, error);
                }
            }
        };
        await Promise.all(connectedProviders.map(async (provider) => {
            try {
                await matchOneProvider(provider);
            } finally {
                runningPhases.delete(provider.name);
                if (runningPhases.size > 0) {
                    const waitingOn = [...runningPhases].map(([name, phase]) => `${name} (${phase})`).join(", ");
                    options.progress?.({ kind: "provider_phase", message: `waiting for ${waitingOn}` });
                }
            }
        }));

        // The per-provider loop above already reported fetch progress; from here
        // the remaining work is release selection over the collected offers.
        options.progress?.({
            kind: "status",
            message: totalAlbumsCount > 0
                ? `matching ${totalAlbumsCount} releases to your library`
                : "no provider releases found",
        });

        await this.replayStaleTrackMatches(artistMbid);

        await withSqliteWriteGate(() => ArtistTopTrackService.rebuildForArtist(artistId, artistMbid), "refresh-artist:top-tracks");
        await this.refreshMissingAlbumReviews(artistMbid, options.forceUpdate === true);
        await this.precacheArtistMediaCovers(artistId, artistMbid);
    }

    /**
     * Replay track matching for this artist's provider releases whose stored
     * verdicts predate the current matcher.
     *
     * The loop above already replays a release the provider returned this run,
     * which covers a matcher fix for anything still in the artist's catalog
     * listing. It does not cover a release that is matched to one of this
     * artist's editions but no longer appears in that listing — an overlap match
     * to a regional pressing, a release the provider stopped attributing to the
     * artist. Amy Winehouse's Frank kept a match asserting a 4:15 "Amy Amy Amy"
     * was the canonical 13:17 "Amy Amy Amy / Outro" through a full refresh,
     * matching and curation cycle for exactly that reason.
     *
     * Keying on the stored version rather than on provider traffic is what makes
     * a matcher improvement reach the whole catalog. No provider calls: this
     * replays the decision over rows already stored.
     */
    private static async replayStaleTrackMatches(artistMbid: string | null): Promise<void> {
        if (!artistMbid) return;
        const stale = db.prepare(`
            SELECT DISTINCT release_item.provider, release_item.provider_id, edition.mbid AS edition_mbid
            FROM ProviderTrackMatches track_match
            JOIN ProviderEditionMatches release_match
              ON release_match.id = track_match.provider_edition_match_id
            JOIN ProviderItems release_item
              ON release_item.id = release_match.provider_edition_item_id
            JOIN AlbumEditions edition ON edition.id = release_match.edition_id
            JOIN Albums release_group ON release_group.id = edition.release_group_id
            WHERE release_group.artist_mbid = ?
              AND track_match.decision_source = 'automatic'
              AND track_match.matcher_version < ?
        `).all(artistMbid, PROVIDER_TRACK_MATCHER_VERSION) as Array<{
            provider: string;
            provider_id: string;
            edition_mbid: string;
        }>;
        if (stale.length === 0) return;

        const yieldReplay = createMatchingYield();
        let replayed = 0;
        for (const release of stale) {
            await yieldReplay();
            try {
                if (await RefreshAlbumService.rematchStoredProviderRelease(
                    release.provider,
                    release.provider_id,
                    release.edition_mbid,
                )) {
                    replayed += 1;
                }
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] Failed to replay stale match for ${release.provider}:${release.provider_id}:`,
                    error,
                );
            }
        }
        console.log(
            `[RefreshArtistService] Replayed ${replayed}/${stale.length} provider release(s) `
            + `whose track matches predated matcher version ${PROVIDER_TRACK_MATCHER_VERSION}`,
        );
    }

    private static async refreshProviderVideos(
        providers: StreamingProvider[],
        artistId: string,
        artistMbid: string | null,
        options: RefreshOptions,
    ): Promise<void> {
        if (providers.length === 0 || !this.isVideoLibraryEnabled()) {
            return;
        }

        await Promise.all(providers.map(async (provider) => {
            const providerArtistId = await resolveProviderArtistId(provider, artistId, artistMbid);
            if (!providerArtistId) {
                return;
            }
            try {
                await this.refreshProviderVideosForMatchedArtist(provider, providerArtistId, artistId, options);
            } catch (err) {
                console.warn(`[RefreshArtistService] Non-fatal error fetching videos on ${provider.name} for ${artistId}:`, err);
            }
        }));
        try {
            const supplemented = await supplementSparseProviderVideosFromYouTube(artistId, artistMbid);
            if (supplemented > 0) {
                console.log(
                    `[RefreshArtistService] Resolved ${supplemented} sparse provider video(s) through YouTube for ${artistId}`,
                );
            }
        } catch (error) {
            console.warn(`[RefreshArtistService] Sparse video catalog supplementation failed for ${artistId}:`, error);
        }
    }

    private static async refreshProviderVideosForMatchedArtist(
        provider: StreamingProvider,
        providerArtistId: string | number,
        artistId: string,
        options: RefreshOptions,
    ): Promise<void> {
        if (!provider.getArtistVideos || !this.isVideoLibraryEnabled()) {
            return;
        }

        try {
            const videos = (await this.retryOnRateLimit(
                () => provider.getArtistVideos!(providerArtistId),
                { provider, action: `fetch artist videos for ${providerArtistId}`, options },
            ) || [])
                .map((video) => ({
                    ...providerVideoToOfferRow(video, artistId),
                    provider: provider.id,
                    _provider: provider.id,
                }));
            // Fill missing publish dates / duration / quality, and always try to
            // pick up album / related-track associations when the list payload
            // omitted them (TIDAL list often has duration+quality but no album).
            // TIDAL catalog quality is often MP4_1080P even when the stream is
            // HD/SD — re-enrich untrusted FHD tags via getVideo stream probe.
            if (provider.getVideo) {
                const missingFacts = videos
                    .filter((video) =>
                        !String(video.release_date || "").trim()
                        || video.duration == null
                        || !String(video.quality || "").trim()
                        || (provider.id === "tidal" && isUntrustedTidalCatalogVideoQuality(video.quality))
                        || !String(video.album_id || "").trim()
                        || !String(video.related_track_id || "").trim())
                    .slice(0, 80);
                if (missingFacts.length > 0) {
                    const limit = pLimit(4);
                    await Promise.all(missingFacts.map((video) => limit(async () => {
                        try {
                            const detailed = await this.retryOnRateLimit(
                                () => provider.getVideo!(String(video.provider_id)),
                                { provider, action: `fetch video details for ${video.provider_id}`, options },
                            );
                            if (detailed.releaseDate) {
                                video.release_date = detailed.releaseDate;
                            }
                            if (detailed.duration != null) {
                                video.duration = Number(detailed.duration);
                            }
                            if (detailed.quality) {
                                video.quality = detailed.quality;
                            }
                            if (detailed.albumId) {
                                video.album_id = detailed.albumId;
                            }
                            if (detailed.relatedTrackId) {
                                video.related_track_id = detailed.relatedTrackId;
                            }
                            if (detailed.isrc) {
                                video.isrc = detailed.isrc;
                            }
                            if (
                                detailed.title
                                && (
                                    parseVideoVariant(video.title) === "video"
                                    || String(detailed.title).length > String(video.title || "").length
                                )
                            ) {
                                video.title = detailed.title;
                            }
                        } catch (error) {
                            console.warn(
                                `[RefreshArtistService] Failed to enrich video facts for ${provider.name}:${video.provider_id}:`,
                                error,
                            );
                        }
                    })));
                }
            }
            console.log(`[RefreshArtistService] Found ${videos.length} videos on ${provider.name} for artist ${artistId}`);
            await RefreshVideoService.upsertArtistVideosInBatches(artistId, videos, options);
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to fetch videos on ${provider.name} for ${artistId}:`, error);
        }
    }

    private static async refreshMissingAlbumReviews(
        artistMbid: string | null,
        force = false,
    ): Promise<void> {
        if (!artistMbid) {
            return;
        }
        const rows = db.prepare(`
            SELECT DISTINCT rg.mbid
            FROM Albums rg
            LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            WHERE (rg.artist_mbid = ? OR scope.artist_mbid = ?)
              AND (
                ? = 1
                OR ((rg.review_text IS NULL OR TRIM(rg.review_text) = '') AND rg.review_last_updated IS NULL)
              )
            ORDER BY rg.mbid
        `).all(artistMbid, artistMbid, force ? 1 : 0) as Array<{ mbid: string }>;
        if (rows.length === 0) {
            return;
        }

        const yieldReviews = createMatchingYield();
        for (const row of rows) {
            await yieldReviews();
            try {
                await RefreshAlbumService.refreshCanonicalAlbumReview(row.mbid, { force });
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] Failed to fetch album review for ${row.mbid}:`,
                    error,
                );
            }
        }
    }

    /**
     * Warm artist/album/video covers during MatchArtistProviders so page visits
     * serve config/media-cover cache. resolve*Artwork is idempotent when bytes
     * already exist; only missing (or preference-stale) entities hit the network.
     */
    private static async precacheArtistMediaCovers(
        artistId: string,
        artistMbid: string | null,
    ): Promise<void> {
        if (artistMbid) {
            try {
                // These calls are idempotent when source markers match and also
                // refresh artwork when the selected catalog URL changes.
                await resolveArtistArtwork({
                    artistMbid,
                    preferredCoverTypes: ["Poster", "Headshot"],
                });
                await resolveArtistArtwork({
                    artistMbid,
                    preferredCoverTypes: ["Fanart"],
                });
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] Failed to pre-cache artist artwork for ${artistMbid}:`,
                    error,
                );
            }

            await this.precacheArtistAlbumArtwork(artistMbid);
        }

        await this.precacheArtistVideoArtwork(artistId);
    }

    private static async precacheArtistAlbumArtwork(artistMbid: string): Promise<void> {
        const targets = listArtistCoverPrecacheTargets(artistMbid);
        const limit = pLimit(6);
        await Promise.all(targets.albumMbids.map((albumMbid) => limit(async () => {
            try {
                await resolveAlbumArtwork({ albumMbid });
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] Failed to pre-cache album artwork for ${albumMbid}:`,
                    error,
                );
            }
        })));
        await Promise.all(targets.editions.map((edition) => limit(async () => {
            try {
                await resolveEditionArtwork({
                    releaseMbid: edition.releaseMbid,
                    libraryId: edition.libraryId,
                });
                discardEditionCoverIfDuplicateOfAlbum(edition.releaseMbid, edition.albumMbid);
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] Failed to pre-cache edition artwork for ${edition.releaseMbid}:`,
                    error,
                );
            }
        })));
    }

    /**
     * Warm video thumbnails during refresh (parallel, off the request thread)
     * so UI delivery and library sidecar/embed work remain local-only.
     * resolveVideoArtwork caches a full-aspect origin plus the 250px card proxy.
     */
    private static async precacheArtistVideoArtwork(artistId: string): Promise<void> {
        if (!this.isVideoLibraryEnabled()) {
            return;
        }
        const artistMbid = this.getArtistMusicBrainzId(artistId);
        const videoIds = db.prepare(`
            SELECT DISTINCT
              recording.id AS id,
              recording.cover_image_url AS cover_image_url
            FROM Recordings recording
            JOIN ProviderVideoMatches video_match
              ON video_match.recording_id = recording.id
             AND video_match.match_state = 'accepted'
            JOIN ProviderItems offer
              ON offer.id = video_match.provider_video_item_id
             AND offer.entity_type = 'video'
            WHERE recording.is_video = 1
              AND (recording.artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = ?)
                   OR recording.artist_mbid = ?)
        `).all(artistMbid, artistMbid) as Array<{
            id: number;
            cover_image_url?: string | null;
        }>;
        if (videoIds.length === 0) {
            return;
        }
        // Always ask the resolver to validate the source marker. This remains
        // cheap when the cache is current, but lets it replace legacy covers
        // whose stored URL points at a related YouTube video. Filtering here
        // by recording.cover_image_url previously prevented the resolver's
        // watch-id correction from ever running when the bad cache and bad
        // stored URL agreed with each other.
        const limit = pLimit(6);
        await Promise.all(videoIds.map((video) => limit(async () => {
            try {
                await resolveVideoArtwork({ videoId: video.id });
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to pre-cache video artwork for ${video.id}:`, error);
            }
        })));
    }

}
