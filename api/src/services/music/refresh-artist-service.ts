import pLimit from "p-limit";
import { db, runChunkedWrite } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import {
    resolveArtistFolderForIdentityUpdate,
    resolveArtistFolderFromTemplate,
    shouldReapplyArtistPathTemplate,
} from "./artist-paths.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import { type RefreshOptions, type ArtistRefreshResult } from "./scan-types.js";
import { shouldRefreshArtist, shouldRefreshVideos } from "../config/refresh-policy.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import { servarrMetadata } from "../metadata/servarr-metadata.js";
import { syncMusicBrainzVideosForArtist } from "../metadata/musicbrainz-video-service.js";
import {
    matchProviderAlbumsToReleaseGroups,
    type MusicBrainzReleaseGroupForMatching,
    type ProviderReleaseGroupMatch,
} from "../metadata/provider-release-group-matcher.js";
import { ProviderArtistIdentityService, normalizeProviderArtist } from "../metadata/provider-artist-identity-service.js";
import { streamingProviderManager } from "../providers/index.js";
import type { StreamingProvider, ProviderAlbum } from "../providers/streaming-provider.js";
import { ProviderOfferReleaseLinkService } from "../metadata/provider-offer-release-link-service.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { isUntrustedTidalCatalogVideoQuality } from "../providers/tidal/tidal-quality.js";
import {
    resolveAlbumArtwork,
    resolveArtistArtwork,
    resolveVideoArtwork,
    hasCachedMediaCover,
    isMediaCoverSourceCacheCurrent,
    type ProviderArtworkCandidate,
} from "../metadata/media-cover-service.js";
import { MusicBrainzArtistCreditService } from "../metadata/musicbrainz-artist-credit-service.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import { ProviderCatalogRepository } from "../providers/provider-catalog-repository.js";
import { ArtistTopTrackService } from "./artist-top-track-service.js";
import { CurationService } from "./curation-service.js";
import {
    completeBulkTrackList,
    isCoreVideoCatalogProvider,
    isMusicBrainzMbid,
    normalizeIsrc,
    normalizeMatchText,
    providerAlbumToOfferRow,
    providerVideoToOfferRow,
    slotTrack,
    type SlotTrack,
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

export class RefreshArtistService {
    private static getArtistMusicBrainzId(artistId: string): string | null {
        const row = db.prepare("SELECT mbid FROM Artists WHERE id = ?").get(artistId) as { mbid?: string | null } | undefined;
        return row?.mbid ? String(row.mbid) : null;
    }

    private static async syncArtistMusicBrainzCatalog(
        artistId: string,
        force = false,
        includeCreditedReleaseGroups = false,
    ): Promise<string | null> {
        const artistMbid = this.getArtistMusicBrainzId(artistId);
        if (!artistMbid) {
            return null;
        }

        // Past the artist-refresh staleness gate we always re-pull canonical
        // stubs + videos. syncArtist is content_hash-cheap; video upserts are
        // idempotent. Skipping because Albums/videos already exist stranded new
        // release groups and left ISRCs / curated columns on the first hydrate.
        void force;
        try {
            await servarrMetadata.syncArtist(artistMbid);
            if (includeCreditedReleaseGroups) {
                const credited = await MusicBrainzArtistCreditService.syncCreditedReleaseGroupsForArtist(artistMbid);
                console.log(
                    `[RefreshArtistService] Synced ${credited.releaseGroups} credited MusicBrainz release group(s) ` +
                    `and ${credited.artists} credited artist(s) for ${artistMbid}`,
                );
                // Scan in each first-degree credited artist one level deep so they
                // get a picture, their MusicBrainz discography, and provider
                // matching. Recursion is naturally bounded: credited artists are
                // created monitored=0, so their own refresh runs with
                // includeCreditedReleaseGroups=false and does not pull a second
                // degree of credits. Enqueue is deduped by artistId (queue refId).
                await this.queueCreditedArtistRefreshes(credited.artistMbids);
            }
            const syncedVideos = await syncMusicBrainzVideosForArtist(artistMbid, { force: true });
            if (syncedVideos > 0) {
                console.log(`[RefreshArtistService] Synced ${syncedVideos} MusicBrainz video recording(s) for artist ${artistMbid}`);
            }
            // MusicBrainz free-streaming URL offers are written inside a sync
            // transaction and cannot probe resolution inline, so they land with
            // quality=NULL. Fill those (and any other missing tags) via the
            // provider getVideo probe now that we're outside that transaction.
            try {
                const backfilled = await RefreshVideoService.backfillMissingVideoOfferQuality(artistMbid);
                if (backfilled > 0) {
                    console.log(`[RefreshArtistService] Backfilled quality on ${backfilled} video offer(s) for artist ${artistMbid}`);
                }
            } catch (error) {
                console.warn(`[RefreshArtistService] Video offer quality backfill failed for ${artistMbid}:`, error);
            }
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to sync canonical metadata for artist ${artistId} (${artistMbid}):`, error);
        }

        return artistMbid;
    }

    /**
     * Scan in first-degree credited artists one level deep. For each newly
     * created credited artist (skeleton row, never scanned, not monitored),
     * enqueue a metadata refresh so it gets a picture, its MusicBrainz
     * discography, and provider matching. Monitored/already-scanned artists are
     * skipped — the normal cycle owns those. Recursion is bounded: credited
     * artists are monitored=0, so their own refresh runs with
     * includeCreditedReleaseGroups=false and never pulls a second degree.
     */
    private static async queueCreditedArtistRefreshes(artistMbids: string[]): Promise<void> {
        const uniqueMbids = Array.from(new Set((artistMbids || []).filter(Boolean)));
        if (uniqueMbids.length === 0) return;

        const placeholders = uniqueMbids.map(() => "?").join(", ");
        const rows = db.prepare(`
            SELECT id, mbid, name, monitored, last_scanned
            FROM Artists
            WHERE mbid IN (${placeholders})
        `).all(...uniqueMbids) as Array<{
            id: string; mbid: string; name: string | null; monitored: number; last_scanned: string | null;
        }>;

        const pending = rows.filter((row) => !row.last_scanned && !row.monitored);
        if (pending.length === 0) return;

        try {
            const { queueCreditedArtistHydrationBatch } = await import("./artist-workflow.js");
            const result = queueCreditedArtistHydrationBatch(pending.map((row) => ({
                artistId: String(row.id),
                artistName: row.name || row.mbid,
            })));
            console.log(
                `[RefreshArtistService] Queued ${result.queued} low-priority first-degree credited artist(s)` +
                (result.remaining > 0 ? `; ${result.remaining} persisted for continuation` : ""),
            );
        } catch (error) {
            console.warn("[RefreshArtistService] Failed to queue credited-artist refreshes:", error);
        }
    }

    private static async hydrateScopedReleaseGroups(artistMbid: string): Promise<void> {
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
        try {
            await servarrMetadata.syncArtistReleaseGroups(artistMbid, releaseGroupMbids);
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to bulk-hydrate release groups for ${artistMbid}:`, error);
        }

        // Always reconcile scoped covers after catalog hydration. The resolver
        // is source-marker-aware and returns without network I/O when current;
        // running it for every row also catches a changed canonical image URL.
        const artworkReleaseGroupMbids = releaseGroups.map((releaseGroup) => releaseGroup.mbid);
        const limit = pLimit(6);
        await Promise.all(artworkReleaseGroupMbids.map((releaseGroupMbid) => limit(async () => {
            try {
                await resolveAlbumArtwork({ albumMbid: releaseGroupMbid });
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to resolve artwork for release group ${releaseGroupMbid}:`, error);
            }
        })));
    }

    static async upsertMusicBrainzArtist(artistMbid: string, options: RefreshOptions = {}): Promise<string> {
        if (!isMusicBrainzMbid(artistMbid)) {
            throw new Error(`Invalid MusicBrainz artist id: ${artistMbid}`);
        }

        const existing = db.prepare(
            "SELECT id, monitored, path FROM Artists WHERE id = ? OR mbid = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1",
        ).get(artistMbid, artistMbid, artistMbid) as { id: string | number; monitored?: number | null; path?: string | null } | undefined;
        const localArtistId = existing?.id != null ? String(existing.id) : artistMbid;
        const shouldMonitor = options.monitorArtist === true ? true : Boolean(existing?.monitored);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;
        const artistData = await servarrMetadata.syncArtist(artistMbid);
        const artistName = artistData.artistname || "Unknown Artist";
        const providerArtworkRows = db.prepare(`
            SELECT provider, provider_id, cover, popularity
            FROM ProviderItems
            WHERE entity_type = 'artist'
              AND artist_mbid = ?
            ORDER BY updated_at DESC
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
            artistId: localArtistId,
            artistName,
            artistMbId: artistMbid,
            artistDisambiguation: artistData.disambiguation || null,
            existingPath: existing?.path ?? null,
        });

        if (artistName === "Various Artists" || localArtistId === "0") {
            console.warn(`[RefreshArtistService] Cannot monitor 'Various Artists' (MBID: ${artistMbid}). Skipping.`);
            throw new Error("Cannot monitor 'Various Artists'. Please monitor specific compilations instead.");
        }

        if (!existing) {
            db.prepare(`
                INSERT OR IGNORE INTO Artists (
                    id, name, picture, cover_image_url, popularity, artist_types, artist_roles,
                    mbid, musicbrainz_status, musicbrainz_last_checked, musicbrainz_match_method,
                    bio_text, bio_source,
                    monitored, monitored_at, user_date_added, path
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', CURRENT_TIMESTAMP, 'musicbrainz-metadata',
                    ?, 'musicbrainz', ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)
            `).run(
                localArtistId,
                artistName,
                posterUrl,
                fanartUrl,
                maxPopularity,
                JSON.stringify([artistData.type || "Artist"]),
                JSON.stringify([]),
                artistMbid,
                artistData.overview || null,
                shouldMonitorInt,
                shouldMonitorInt,
                null,
                resolvedArtistFolder.path,
            );
        } else {
            db.prepare(`
                UPDATE Artists SET
                    name = ?,
                    picture = COALESCE(?, picture),
                    cover_image_url = COALESCE(?, cover_image_url),
                    popularity = ?,
                    artist_types = ?,
                    artist_roles = COALESCE(artist_roles, ?),
                    mbid = ?,
                    musicbrainz_status = 'verified',
                    musicbrainz_last_checked = CURRENT_TIMESTAMP,
                    musicbrainz_match_method = 'musicbrainz-metadata',
                    bio_text = COALESCE(NULLIF(TRIM(bio_text), ''), ?),
                    bio_source = CASE
                        WHEN (bio_text IS NULL OR TRIM(bio_text) = '') AND ? IS NOT NULL THEN 'musicbrainz'
                        ELSE bio_source
                    END,
                    monitored = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END,
                    path = CASE WHEN ? = 1 THEN ? ELSE COALESCE(path, ?) END
                WHERE id = ?
            `).run(
                artistName,
                posterUrl,
                fanartUrl,
                maxPopularity,
                JSON.stringify([artistData.type || "Artist"]),
                JSON.stringify([]),
                artistMbid,
                artistData.overview || null,
                artistData.overview || null,
                shouldMonitorInt,
                shouldMonitorInt,
                resolvedArtistFolder.shouldReplaceExistingPath ? 1 : 0,
                resolvedArtistFolder.path,
                resolvedArtistFolder.path,
                localArtistId,
            );
        }

        db.prepare(`
            UPDATE ArtistMetadata SET
                picture = COALESCE(?, picture),
                cover_image_url = COALESCE(?, cover_image_url),
                popularity = ?
            WHERE mbid = ?
        `).run(posterUrl, fanartUrl, maxPopularity, artistMbid);

        return localArtistId;
    }

    private static async addSupplementalProviderOffers(
        provider: StreamingProvider,
        albums: any[],
        matches: Map<string, ProviderReleaseGroupMatch>,
    ): Promise<void> {
        const albumsById = new Map(albums.map((album) => [String(album.provider_id), album] as const));
        const groups = new Map<string, ProviderReleaseGroupMatch[]>();

        for (const match of matches.values()) {
            if (!match.releaseGroup || (match.status !== "verified" && match.status !== "probable")) {
                continue;
            }
            const groupMatches = groups.get(match.releaseGroup.mbid) || [];
            groupMatches.push(match);
            groups.set(match.releaseGroup.mbid, groupMatches);
        }

        for (const [releaseGroupMbid, groupMatches] of groups) {
            const representative = MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid);
            if (!representative || Number(representative.track_count || 0) <= 1) {
                continue;
            }

            const initialAlbums = groupMatches
                .map((match) => albumsById.get(String(match.providerId)))
                .filter(Boolean);
            const targetTrackCount = Number(representative.track_count || 0);
            const hydratedTracks = new Map<string, SlotTrack[]>();

            const hydrateAlbum = async (albumId: string): Promise<SlotTrack[]> => {
                const cached = hydratedTracks.get(albumId);
                if (cached) {
                    return cached;
                }

                const album = albumsById.get(albumId);
                if (Array.isArray(album?._provider_tracks)) {
                    hydratedTracks.set(albumId, album._provider_tracks);
                    return album._provider_tracks;
                }

                const rawTracks = await provider.getAlbumTracks(albumId);
                // Persist what we fetch: materialize provider track offer rows once
                // (single source of truth) instead of discarding the tracklist into a
                // dead blob and re-calling the provider each refresh cycle.
                try {
                    const { RefreshAlbumService, providerTrackToTrackMetadataRow } = await import("./refresh-album-service.js");
                    await RefreshAlbumService.storeProviderTrackOffers(
                        provider.id,
                        albumId,
                        rawTracks.map(providerTrackToTrackMetadataRow),
                    );
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to persist provider track offers for album ${albumId}:`, error);
                }
                const tracks = rawTracks.map((track) => slotTrack(track));
                hydratedTracks.set(albumId, tracks);
                if (album) {
                    album._provider_tracks = tracks;
                }
                return tracks;
            };

            for (const match of groupMatches) {
                const album = albumsById.get(String(match.providerId));
                if (!album) {
                    continue;
                }

                const albumTrackCount = Number(album.num_tracks || 0);
                const hasSuspiciousShape = targetTrackCount > 1
                    && albumTrackCount > 0
                    && albumTrackCount !== targetTrackCount;
                const needsEvidence = match.status !== "verified" || match.evidence?.trackCountMatched !== true;
                if (hasSuspiciousShape || needsEvidence) {
                    try {
                        await hydrateAlbum(String(album.provider_id));
                    } catch (error) {
                        console.warn(`[RefreshArtistService] Failed to hydrate provider album ${album.provider_id}:`, error);
                    }
                }
            }

            const largestInitialOffer = Math.max(0, ...initialAlbums.map((album) => Number(album.num_tracks || 0)));
            if (largestInitialOffer >= targetTrackCount) {
                continue;
            }

            const targets = db.prepare(`
                SELECT t.title, r.isrcs
                FROM Tracks t
                LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
                WHERE t.release_mbid = ?
                ORDER BY t.medium_position ASC, t.position ASC
            `).all(representative.mbid) as Array<{ title: string; isrcs?: string | null }>;
            const targetRows = targets.map((target) => {
                let isrcs: string[] = [];
                try {
                    const parsed = JSON.parse(String(target.isrcs || "[]"));
                    isrcs = Array.isArray(parsed) ? parsed.map(normalizeIsrc).filter(Boolean) : [];
                } catch {
                    isrcs = [];
                }
                return {
                    title: target.title,
                    normalizedTitle: normalizeMatchText(target.title),
                    isrcs: new Set(isrcs),
                };
            });
            const coversTarget = (track: SlotTrack, target: typeof targetRows[number]) =>
                Boolean(track.isrc && target.isrcs.has(track.isrc))
                || normalizeMatchText(track.title) === target.normalizedTitle;

            for (const album of initialAlbums) {
                await hydrateAlbum(String(album.provider_id));
            }

            for (const target of targetRows) {
                const alreadyCovered = Array.from(hydratedTracks.values())
                    .some((tracks) => tracks.some((track) => coversTarget(track, target)));
                if (alreadyCovered) {
                    continue;
                }

                const results = await provider.search(target.title, { types: ["tracks"], limit: 15 });
                for (const searchTrack of results.tracks) {
                    let track = searchTrack;
                    if (!track.album?.providerId || !track.isrc) {
                        try {
                            track = await provider.getTrack(track.providerId);
                        } catch (error) {
                            console.warn(
                                `[RefreshArtistService] Failed to hydrate provider track ${track.providerId}:`,
                                error,
                            );
                            continue;
                        }
                    }

                    const shapedTrack = slotTrack(track);
                    if (!coversTarget(shapedTrack, target)) {
                        continue;
                    }
                    const providerAlbumId = String(track.album?.providerId || "").trim();
                    if (!providerAlbumId) {
                        continue;
                    }

                    let album = albumsById.get(providerAlbumId);
                    if (!album) {
                        album = providerAlbumToOfferRow(await provider.getAlbum(providerAlbumId), "");
                        albums.push(album);
                        albumsById.set(providerAlbumId, album);
                    }
                    await hydrateAlbum(providerAlbumId);

                    const base = groupMatches[0];
                    matches.set(providerAlbumId, {
                        ...base,
                        providerId: providerAlbumId,
                        status: "probable",
                        confidence: Math.max(base.confidence, 0.9),
                        method: "musicbrainz-recording-isrc-coverage",
                        releaseMbid: representative.mbid,
                        evidence: {
                            ...base.evidence,
                            matchedReleaseMbid: representative.mbid,
                            availableReleaseMbids: [representative.mbid],
                        },
                    });
                    break;
                }
            }
        }
    }

    private static async searchCanonicalCollaborationOffers(
        provider: StreamingProvider,
        artistMbid: string | null,
    ): Promise<{ albums: any[]; matches: Map<string, ProviderReleaseGroupMatch> }> {
        if (!artistMbid || !provider.searchReleaseGroup) {
            return { albums: [], matches: new Map() };
        }

        const cachedReleaseGroups = new Map(
            servarrMetadata.getCachedReleaseGroupsForArtist(artistMbid)
                .map((releaseGroup) => [releaseGroup.mbid, releaseGroup] as const),
        );
        const targets = db.prepare(`
            SELECT DISTINCT
                rg.mbid,
                rg.title,
                rg.first_release_date,
                owner.name AS artist_name,
                (
                    SELECT release.track_count
                    FROM AlbumReleases release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_track_count,
                (
                    SELECT release.media_count
                    FROM AlbumReleases release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_volume_count
            FROM Albums rg
            JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            LEFT JOIN ArtistMetadata owner ON owner.mbid = rg.artist_mbid
            WHERE scope.artist_mbid = ?
              AND rg.artist_mbid != ?
            ORDER BY rg.mbid ASC
        `).all(artistMbid, artistMbid) as Array<{
            mbid: string;
            title: string;
            first_release_date?: string | null;
            artist_name?: string | null;
            preferred_track_count?: number | null;
            preferred_volume_count?: number | null;
        }>;
        const slots = ["stereo", "spatial"] as const;
        const albumsByProviderId = new Map<string, any>();
        const matches = new Map<string, ProviderReleaseGroupMatch>();

        for (const target of targets) {
            const releaseGroup = cachedReleaseGroups.get(target.mbid) as MusicBrainzReleaseGroupForMatching | undefined;
            if (!releaseGroup) {
                continue;
            }

            for (const slot of slots) {
                try {
                    const providerAlbums = await provider.searchReleaseGroup({
                        artistName: String(target.artist_name || ""),
                        releaseGroupMbid: target.mbid,
                        releaseGroupTitle: target.title,
                        releaseDate: target.first_release_date || null,
                        slot,
                        preferredTrackCount: target.preferred_track_count || null,
                        preferredVolumeCount: target.preferred_volume_count || null,
                    });
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
                    }
                } catch (error) {
                    console.warn(
                        `[RefreshArtistService] Failed to search ${provider.name} for canonical collaboration ` +
                        `${target.title} (${target.mbid}):`,
                        error,
                    );
                }
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
            const existing = db.prepare(`
                SELECT title, version, type, upc, duration, release_date, explicit,
                       provider_url, cover, volume_count, copyright
                FROM ProviderItems
                WHERE provider = 'soundcloud'
                  AND entity_type = 'album'
                  AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                LIMIT 1
            `).get(providerAlbumId) as Record<string, unknown> | undefined;
            if (existing) {
                const durationSeconds = Number(existing.duration);
                new ProviderCatalogRepository(db).upsertItem({
                    provider: "soundcloud",
                    entityType: "release",
                    providerId: providerAlbumId,
                    title: String(existing.title || "") || null,
                    version: String(existing.version || "") || null,
                    providerType: String(existing.type || "") || null,
                    upc: String(existing.upc || "") || null,
                    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0
                        ? Math.round(durationSeconds * 1000)
                        : null,
                    releaseDate: String(existing.release_date || "") || null,
                    explicit: existing.explicit == null ? null : Boolean(existing.explicit),
                    availability: "unavailable",
                    availabilityReason: reason,
                    checkedAt: new Date().toISOString(),
                    providerUrl: String(existing.provider_url || "") || null,
                    coverId: String(existing.cover || "") || null,
                    volumeCount: existing.volume_count == null ? null : Number(existing.volume_count),
                    copyright: String(existing.copyright || "") || null,
                });
            }
            db.prepare(`
                UPDATE ProviderItems
                SET availability = 'unavailable',
                    match_status = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE provider = 'soundcloud'
                  AND entity_type = 'album'
                  AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            `).run(providerAlbumId);
            db.prepare(`
                UPDATE ProviderItems
                SET availability = 'unavailable',
                    match_status = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE provider = 'soundcloud'
                  AND entity_type = 'track'
                  AND CAST(provider_album_id AS TEXT) = CAST(? AS TEXT)
            `).run(providerAlbumId);
            db.prepare(`
                UPDATE ProviderItems
                SET availability = 'unavailable',
                    availability_reason = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE provider = 'soundcloud'
                  AND entity_type = 'release'
                  AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            `).run(reason, providerAlbumId);
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
                    FROM AlbumReleases release
                    WHERE release.release_group_mbid = rg.mbid
                    ORDER BY COALESCE(release.track_count, 0) DESC, release.mbid ASC
                    LIMIT 1
                ) AS preferred_release_mbid,
                (
                    SELECT release.track_count
                    FROM AlbumReleases release
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
            SELECT CAST(provider_id AS TEXT) AS provider_id
            FROM ProviderItems
            WHERE provider = 'soundcloud'
              AND entity_type = 'album'
              AND release_group_mbid = ?
              AND match_method = ?
              AND match_status IN ('verified', 'probable', 'candidate')
            ORDER BY updated_at DESC, provider_id ASC
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
        artistMbid: string | null,
        albums: any[],
        matches: Map<string, ProviderReleaseGroupMatch>,
    ): Promise<void> {
        if (albums.length === 0) {
            return;
        }

        const upsert = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, title, version, explicit, quality, type,
                upc, copyright, duration, volume_count, release_date, artist_mbid, release_group_mbid, release_mbid, library_slot,
                match_status, match_confidence, match_method, match_evidence, cover, discovered_from_artist_mbid, provider_url, availability, updated_at
            ) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                title = excluded.title,
                version = COALESCE(excluded.version, ProviderItems.version),
                explicit = COALESCE(excluded.explicit, ProviderItems.explicit),
                quality = COALESCE(excluded.quality, ProviderItems.quality),
                type = COALESCE(excluded.type, ProviderItems.type),
                upc = COALESCE(excluded.upc, ProviderItems.upc),
                copyright = COALESCE(excluded.copyright, ProviderItems.copyright),
                duration = COALESCE(excluded.duration, ProviderItems.duration),
                volume_count = COALESCE(excluded.volume_count, ProviderItems.volume_count),
                release_date = COALESCE(excluded.release_date, ProviderItems.release_date),
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                release_group_mbid = COALESCE(excluded.release_group_mbid, ProviderItems.release_group_mbid),
                release_mbid = COALESCE(excluded.release_mbid, ProviderItems.release_mbid),
                library_slot = excluded.library_slot,
                match_status = excluded.match_status,
                match_confidence = COALESCE(excluded.match_confidence, ProviderItems.match_confidence),
                match_method = COALESCE(excluded.match_method, ProviderItems.match_method),
                match_evidence = COALESCE(excluded.match_evidence, ProviderItems.match_evidence),
                cover = COALESCE(excluded.cover, ProviderItems.cover),
                discovered_from_artist_mbid = COALESCE(excluded.discovered_from_artist_mbid, ProviderItems.discovered_from_artist_mbid),
                provider_url = COALESCE(excluded.provider_url, ProviderItems.provider_url),
                availability = excluded.availability,
                updated_at = CURRENT_TIMESTAMP
        `);

        const selectCanonicalOwner = db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?");
        const normalizedCatalog = new ProviderCatalogRepository(db);

        // Chunk the per-album upserts so a prolific artist's provider catalog
        // doesn't hold the write lock for the whole batch and starve peers.
        runChunkedWrite(albums, (album) => {
                const providerAlbumId = String(album.provider_id);
                const match = matches.get(providerAlbumId);
                const matchedReleaseGroup = match?.status !== "unmatched" ? match?.releaseGroup : null;
                const canonicalOwner = matchedReleaseGroup?.mbid
                    ? selectCanonicalOwner.get(matchedReleaseGroup.mbid) as { artist_mbid?: string | null } | undefined
                    : null;
                const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(match);
                upsert.run(
                    providerId,
                    providerAlbumId,
                    album.title || null,
                    album.version || null,
                    album.explicit == null ? null : (album.explicit ? 1 : 0),
                    album.quality || null,
                    album.type || null,
                    album.upc || null,
                    album.copyright || null,
                    album.duration || null,
                    album.num_volumes ?? null,
                    album.release_date || null,
                    matchedReleaseGroup ? canonicalOwner?.artist_mbid || artistMbid : null,
                    matchedReleaseGroup?.mbid || null,
                    matchedReleaseMbid,
                    isSpatialAudioQuality(album.quality) ? "spatial" : "stereo",
                    match?.status || "unmatched",
                    match?.confidence ?? null,
                    match?.method || null,
                    match ? JSON.stringify({
                        ...match.evidence,
                        providerQualityTags: Array.isArray(album.qualityTags) ? album.qualityTags : [],
                    }) : null,
                    album.cover || null,
                    artistMbid,
                    // Persist the provider's human permalink (e.g. a SoundCloud
                    // set's soundcloud.com/<user>/sets/<slug>) so links/tags use
                    // the real playlist. Stable numeric ids remain acquisition
                    // and workspace identity.
                    album.url || null,
                );
                const durationSeconds = Number(album.duration);
                normalizedCatalog.upsertItem({
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
                    coverId: album.cover || null,
                    volumeCount: album.num_volumes ?? null,
                    copyright: album.copyright || null,
                });
        });
        // Acquire artwork after slot selection in precacheArtistMediaCovers().
        // Provisional matches can point several provider albums at one canonical
        // release group; warming them here raced unrelated covers into one cache.
    }

    /**
     * ALL provider identities linked to this canonical artist, not just the
     * most recent one. Providers sometimes split one real-world artist into
     * several catalog entries (TIDAL has both "Concertgebouworkest" and "Royal
     * Concertgebouw Orchestra" for the same MB artist); each identity carries
     * its own releases, so hydration must union their catalogs or half the
     * discography never shows up as offers.
     */

    private static reapplyArtistPathAfterIdentity(artistId: string): void {
        const artist = db.prepare(`
            SELECT Artists.id, Artists.name, Artists.mbid, Artists.path, ArtistMetadata.disambiguation
            FROM Artists
            LEFT JOIN ArtistMetadata ON ArtistMetadata.mbid = Artists.mbid
            WHERE Artists.id = ?
        `).get(artistId) as {
            id: number | string;
            name: string | null;
            mbid: string | null;
            path: string | null;
            disambiguation: string | null;
        } | undefined;

        if (!artist?.name || !artist.mbid) {
            return;
        }

        const existingPath = String(artist.path || "").trim();
        if (existingPath && !shouldReapplyArtistPathTemplate({
            artistId,
            artistName: artist.name,
            artistMbId: artist.mbid,
            artistDisambiguation: artist.disambiguation,
            existingPath,
        })) {
            return;
        }

        const nextPath = resolveArtistFolderFromTemplate({
            artistId,
            artistName: artist.name,
            artistMbId: artist.mbid,
            artistDisambiguation: artist.disambiguation,
        });
        db.prepare("UPDATE Artists SET path = ? WHERE id = ?").run(nextPath, artistId);
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
        const row = db.prepare("SELECT last_scanned FROM Artists WHERE id = ?")
            .get(artistId) as { last_scanned?: string | null } | undefined;
        return !row || row.last_scanned == null;
    }

    static async refreshArtistMetadata(artistId: string, options: RefreshOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] refreshArtistMetadata for ${artistId}`);

        const existing = db.prepare(
            "SELECT id, monitored, name, mbid, last_scanned, path FROM Artists WHERE id = ?",
        ).get(artistId) as any;
        const shouldRefresh =
            !existing ||
            options.forceUpdate === true ||
            shouldRefreshArtist({
                artistId,
                lastScanned: existing?.last_scanned,
            });

        const shouldMonitor = options.monitorArtist === true ? true : (existing?.monitored || false);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;
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
                monitorArtist: options.monitorArtist === true ? true : Boolean(existing.monitored),
            });
            console.log(`[RefreshArtistService] refreshArtistMetadata skipped provider lookup for ${artistId} (provider not connected)`);
            return;
        }

        if (existing && !shouldRefresh) {
            if (options.monitorArtist === true && existing.monitored !== shouldMonitorInt) {
                db.prepare(`
                    UPDATE Artists SET
                        monitored = ?,
                        monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END
                    WHERE id = ?
                `).run(shouldMonitorInt, shouldMonitorInt, artistId);
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

    /**
     * Fetch + store artist biography from streaming providers in
     * `provider_priority` order. First non-empty bio wins. Servarr/MB overview
     * remains the hole-fill fallback when no provider returns text.
     */

    static async refreshArtist(artistId: string, options: RefreshOptions = {}): Promise<ArtistRefreshResult> {
        console.log(`[RefreshArtistService] refreshArtist for ${artistId}`);
        options.progress?.({ kind: "status", message: `Scanning artist ${artistId}...` });

        const resolveArtistMbid = (): string | null =>
            (db.prepare("SELECT mbid FROM Artists WHERE id = ?")
                .get(artistId) as { mbid?: string | null } | undefined)?.mbid
            || (isMusicBrainzMbid(artistId) ? artistId : null);

        const artistRow = db.prepare("SELECT last_scanned FROM Artists WHERE id = ?").get(artistId) as any;
        const isNewArtist = !artistRow?.last_scanned;
        const beforeFingerprint = artistCatalogFingerprint(resolveArtistMbid());

        // ShouldRefreshArtist staleness gate.
        // Refresh iff forced, never scanned, or stale per the refresh policy
        // (12h-retry / 30d-hard / 2d-active / recent-release). One refresh path.
        const shouldRefresh =
            options.forceUpdate === true ||
            !artistRow ||
            shouldRefreshArtist({
                artistId,
                lastScanned: artistRow?.last_scanned,
            });

        if (!shouldRefresh) {
            console.log(`[RefreshArtistService] Skipping artist ${artistId} refresh (fresh)`);
            // Fresh: a deferred match would only rebuild slots from stored offers.
            return {
                artistMbid: resolveArtistMbid(),
                shouldHydrateCatalog: false,
                metadataChanged: false,
                isNewArtist: false,
            };
        }

        // Past the staleness gate, refresh always re-syncs canonical stubs/videos
        // and re-reconciles every scoped release group; content_hash skips
        // unchanged payloads so the write cost stays bounded.
        const shouldHydrateCatalog = true;

        // Canonical identity + biography.
        await this.refreshArtistMetadata(artistId, options);
        await refreshArtistBiography(artistId, options);

        let artistMbid = resolveArtistMbid();

        {
            const monitoredArtist = db.prepare("SELECT monitored FROM Artists WHERE id = ?")
                .get(artistId) as { monitored?: number | null } | undefined;
            const isMonitored = Boolean(monitoredArtist?.monitored);
            artistMbid = await this.syncArtistMusicBrainzCatalog(
                artistId,
                options.forceUpdate === true,
                isMonitored,
            );
            if (artistMbid) {
                await this.hydrateScopedReleaseGroups(artistMbid);
            }
        }

        // The RefreshArtist command path defers matching to a standalone
        // MatchArtistProviders command (it enqueues one with the returned
        // context). Direct callers (scheduler, bulk RefreshMetadata) keep the
        // inline match so their single-job behaviour is unchanged.
        if (options.deferProviderMatching !== true) {
            await this.matchArtistProviders(artistId, artistMbid, options, shouldHydrateCatalog);
            this.markArtistRefreshComplete(artistId);
        }

        console.log(`[RefreshArtistService] refreshArtist complete for ${artistId}`);
        return {
            artistMbid,
            shouldHydrateCatalog,
            metadataChanged: beforeFingerprint !== artistCatalogFingerprint(artistMbid),
            isNewArtist,
        };
    }

    /**
     * Commit the durable refresh watermark only after the provider-matching
     * phase succeeds. Deferred command workflows call this from
     * MatchArtistProviders; direct callers call it immediately after their
     * inline match.
     */
    static markArtistRefreshComplete(artistId: string): void {
        db.prepare(`
            UPDATE Artists
            SET
                last_scanned = CURRENT_TIMESTAMP,
                library_origin = CASE
                    WHEN library_origin = 'musicbrainz-credit' THEN 'musicbrainz-credit-hydrated'
                    ELSE library_origin
                END
            WHERE id = ?
        `).run(artistId);
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

        // Music-video CATALOG is a core, always-on metadata source (like
        // MusicBrainz/Servarr): YouTube keeps contributing video metadata even
        // when its download plugin is not configured. Downloading/previewing that
        // video still requires the corresponding plugin.
        const videoCatalogProviders = resolvedStatuses
            .filter((entry) => entry.status.connected
                || (entry.status.remoteCatalogAvailable && isCoreVideoCatalogProvider(entry.provider.id)))
            .map((entry) => entry.provider);
        const videoOnlyProviders = videoCatalogProviders.filter(
            (provider) => !connectedProviders.some((connected) => connected.id === provider.id),
        );

        if (!shouldHydrateCatalog) {
            console.log(`[RefreshArtistService] Skipping broad catalog hydration for artist ${artistId} (managed metadata already present)`);
            await CurationService.processAll(artistId, { skipDownloadQueue: true });

            const shouldRefreshArtistVideos =
                options.forceUpdate === true ||
                shouldRefreshVideos({ artistId });
            if (shouldRefreshArtistVideos) {
                await this.refreshProviderVideos(videoCatalogProviders, artistId, artistMbid, options);
            }
            ArtistTopTrackService.rebuildForArtist(artistId, artistMbid);
            await this.precacheArtistMediaCovers(artistId, artistMbid);
            return;
        }

        if (connectedProviders.length === 0) {
            console.log(
                `[RefreshArtistService] Skipping provider catalog hydration for ${artistId} ` +
                `(no providers connected)`,
            );
            // Video discovery is core metadata, so it still runs with no audio
            // plugin connected (e.g. YouTube's public music-video catalog).
            if (videoCatalogProviders.length > 0) {
                await this.refreshProviderVideos(videoCatalogProviders, artistId, artistMbid, options);
            }
            ArtistTopTrackService.rebuildForArtist(artistId, artistMbid);
            await this.precacheArtistMediaCovers(artistId, artistMbid);
            return;
        }

        let totalAlbumsCount = 0;

        // Core video-catalog providers that are NOT connected for audio still
        // contribute music-video metadata (YouTube's public catalog). They are
        // deliberately excluded from the album/offer hydration loop below.
        // Run connected providers in parallel so adding Apple/YouTube/etc. does
        // not serialize wall-clock matching time against TIDAL.
        await Promise.all(videoOnlyProviders.map(async (provider) => {
            try {
                const providerArtistIds = await resolveProviderArtistIds(provider, artistId, artistMbid);
                if (providerArtistIds.length > 0) {
                    await this.refreshProviderVideosForMatchedArtist(provider, providerArtistIds[0], artistId, options);
                }
            } catch (err) {
                console.warn(`[RefreshArtistService] Non-fatal error fetching videos on ${provider.name} for ${artistId}:`, err);
            }
        }));

        await Promise.all(connectedProviders.map(async (provider) => {
            const providerArtistIds = await resolveProviderArtistIds(provider, artistId, artistMbid);
            if (providerArtistIds.length === 0) {
                console.log(`[RefreshArtistService] Skipping catalog hydration on ${provider.name} for ${artistId} (no provider artist match)`);
                return;
            }

            try {
                await this.refreshProviderVideosForMatchedArtist(provider, providerArtistIds[0], artistId, options);
            } catch (err) {
                console.warn(`[RefreshArtistService] Non-fatal error fetching videos on ${provider.name} for ${artistId}:`, err);
            }

            try {
                // Union the release catalogs of every linked provider identity
                // (a provider can split one artist into several entries, each
                // holding part of the discography), deduped by provider album id.
                const providerAlbums: ProviderAlbum[] = [];
                const seenProviderAlbumIds = new Set<string>();
                for (const providerArtistId of providerArtistIds) {
                    const identityAlbums = provider.listArtistReleaseOffers
                        ? await provider.listArtistReleaseOffers(providerArtistId)
                        : await provider.getArtistAlbums(providerArtistId);
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
                const albums = providerAlbums.map((album) => ({
                    ...providerAlbumToOfferRow(album, artistId),
                    provider: provider.id,
                }));

                // Reuse already-materialized provider track offer rows for track-level
                // matching instead of re-fetching the tracklist every refresh. Track
                // offers are persisted below (storeProviderTrackOffers) once fetched, so
                // subsequent refreshes read them here and skip the provider call. The
                // slotTrack shape is reconstructed from the row + its (volume, position)
                // evidence.
                const loadMaterializedTracks = db.prepare(`
                    SELECT
                        provider_id,
                        title,
                        isrc,
                        duration,
                        track_number,
                        volume_number
                    FROM ProviderItems
                    WHERE provider = ? AND entity_type = 'track' AND provider_album_id = ?
                    ORDER BY COALESCE(volume_number, 1), COALESCE(track_number, 0)
                `);
                for (const album of albums) {
                    const numTracks = Number(album.num_tracks);
                    if (!Number.isFinite(numTracks) || numTracks <= 0) {
                        continue;
                    }
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
                    }>;
                    if (materialized.length === numTracks) {
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
                }

                options.progress?.({ kind: "albums_total", total: albums.length });

                // Provider artist catalogs can contain hundreds of compilations and
                // loosely credited releases. First narrow them using the cheap album
                // metadata already returned by the artist-catalog call, then hydrate
                // tracklists only for plausible MusicBrainz release-group candidates.
                // Canonical MB tracklists remain complete; this only avoids detailed
                // provider calls for releases the metadata matcher cannot associate.
                const preliminaryMatches = buildProviderReleaseGroupMatches(artistMbid, albums);
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

                    // Prefer one batched fetch for the whole artist when the provider
                    // supports it (TIDAL v2: ~2×ceil(albums/20) calls instead of one per
                    // album — the provider-matching N+1 killer). Falls back to per-album
                    // getAlbumTracks for any album the batch didn't return.
                    let bulkTracks: Map<string, any> | null = null;
                    if (provider.getAlbumTracksBulk) {
                        try {
                            bulkTracks = await provider.getAlbumTracksBulk(missingAlbums.map((album) => String(album.provider_id)));
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
                                    // Compound provider documents may paginate a nested
                                    // album relationship independently of the top-level
                                    // response. A partial batch is unsafe for matching
                                    // and durable ProviderItems, so refresh just that
                                    // album through the provider's complete endpoint.
                                    const rawTracks = completeBatch
                                        ? completeBatch
                                        : await provider.getAlbumTracks(album.provider_id);
                                    album._provider_tracks = rawTracks.map((t: any) => slotTrack(t));
                                    // Keep the raw provider tracks so we can persist them as
                                    // track offer rows once the album offers exist (below).
                                    album._provider_raw_tracks = rawTracks;
                                } catch (error) {
                                    console.warn(`[RefreshArtistService] Failed to fetch tracks for album ${album.provider_id}:`, error);
                                    album._provider_tracks = [];
                                }
                            })
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
                console.log(`[RefreshArtistService] Found ${albums.length} albums on ${provider.name} for artist ${artistId}`);

                totalAlbumsCount += albums.length;

                await this.storeProviderAlbumOffers(provider.id, artistMbid, albums, providerReleaseGroupMatches);

                // Persist the freshly-fetched tracklists as provider track offer rows.
                // The album offers now exist, so storeProviderTrackOffers can map each
                // provider track to its canonical MB track by (volume, position). This
                // is the single materialization path and avoids re-fetching next refresh
                // (see loadMaterializedTracks above). No extra API calls — these tracks
                // were already fetched for release-group matching.
                const { RefreshAlbumService: RefreshAlbumSvc, providerTrackToTrackMetadataRow: toTrackRow } =
                    await import("./refresh-album-service.js");
                for (const album of albums) {
                    const rawTracks = album._provider_raw_tracks;
                    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
                        continue;
                    }
                    try {
                        await RefreshAlbumSvc.storeProviderTrackOffers(
                            provider.id,
                            String(album.provider_id),
                            rawTracks.map(toTrackRow),
                            artistMbid,
                        );
                    } catch (error) {
                        console.warn(`[RefreshArtistService] Failed to persist track offers for album ${album.provider_id}:`, error);
                    }
                }

                for (const album of albums) {
                    const providerAlbumId = String(album.provider_id);
                    const match = providerReleaseGroupMatches.get(providerAlbumId);
                    if (!match) {
                        continue;
                    }
                    // SoundCloud DRM/SNIP-only catalog shells must not fill slots or
                    // drive monitoring — reject them and keep looking for fan sets.
                    if (provider.id === "soundcloud"
                        && match.method !== PLAYLIST_TRACKLIST_COVERAGE_METHOD) {
                        const rawTracks = Array.isArray(album._provider_raw_tracks)
                            ? album._provider_raw_tracks
                            : [];
                        if (rawTracks.length > 0) {
                            const downloadable = scoreSoundCloudDownloadableCoverage(
                                rawTracks.map((_: unknown, index: number) => ({ playlistIndex: index })),
                                rawTracks,
                                rawTracks.length,
                            );
                            if (!soundCloudOfferHasDownloadableMatch(downloadable)) {
                                const classifiable = downloadable.downloadableCovered
                                    + downloadable.knownUndownloadableCovered;
                                if (classifiable > 0 && downloadable.downloadableCovered === 0) {
                                    this.markSoundCloudPlaylistOfferUnavailable(
                                        providerAlbumId,
                                        "drm-only",
                                    );
                                    providerReleaseGroupMatches.delete(providerAlbumId);
                                    continue;
                                }
                            }
                        }
                    }
                }

                // SoundCloud mixtapes / dj-mixes / demos often live only as fan or
                // user playlists, not under the official artist album catalog.
                // For those release types, search playlists by title and accept
                // supersets that cover the MusicBrainz tracklist.
                // Title-only shells with no tracklist must not block this search —
                // otherwise an empty official SC album stub prevents finding the
                // fan set that actually covers the mixtape.
                // DRM/SNIP-only SoundCloud catalog matches also must not block:
                // they are not real Discogenius downloads and secondary fan sets
                // (e.g. emmatad OPH) should still be searched.
                const matchedRgMbids = new Set(
                    Array.from(providerReleaseGroupMatches.entries())
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
                            if (provider.id !== "soundcloud") return true;
                            // Official SoundCloud hit: only block secondary search when
                            // the hydrated tracks are actually downloadable enough.
                            const album = albums.find((row) =>
                                String(row.provider_id) === String(providerAlbumId));
                            const rawTracks = Array.isArray(album?._provider_raw_tracks)
                                ? album._provider_raw_tracks
                                : [];
                            if (rawTracks.length === 0) {
                                // Empty/stub shells never block mixtape fallback.
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
                    const { RefreshAlbumService: RefreshAlbumSvcWide, providerTrackToTrackMetadataRow: toTrackRowWide } =
                        await import("./refresh-album-service.js");
                    for (const album of widePlaylistOffers.albums) {
                        const rawTracks = album._provider_raw_tracks;
                        if (!Array.isArray(rawTracks) || rawTracks.length === 0) continue;
                        try {
                            await RefreshAlbumSvcWide.storeProviderTrackOffers(
                                provider.id,
                                String(album.provider_id),
                                rawTracks.map(toTrackRowWide),
                                artistMbid,
                            );
                        } catch (error) {
                            console.warn(
                                `[RefreshArtistService] Failed to persist mixtape playlist track offers for ${album.provider_id}:`,
                                error,
                            );
                        }
                    }
                    for (const album of widePlaylistOffers.albums) {
                        const providerAlbumId = String(album.provider_id);
                        const match = widePlaylistOffers.matches.get(providerAlbumId);
                        if (!match) continue;
                    }
                    totalAlbumsCount += widePlaylistOffers.albums.length;
                    console.log(
                        `[RefreshArtistService] Added ${widePlaylistOffers.albums.length} SoundCloud mixtape/playlist offer(s) for ${artistId}`,
                    );
                }
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to fetch albums on ${provider.name} for ${artistId}:`, error);
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

        await CurationService.processAll(artistId, { skipDownloadQueue: true });
        ArtistTopTrackService.rebuildForArtist(artistId, artistMbid);
        await this.precacheArtistMediaCovers(artistId, artistMbid);
    }

    private static async refreshProviderVideos(
        providers: StreamingProvider[],
        artistId: string,
        artistMbid: string | null,
        options: RefreshOptions,
    ): Promise<void> {
        if (providers.length === 0) {
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
    }

    private static async refreshProviderVideosForMatchedArtist(
        provider: StreamingProvider,
        providerArtistId: string | number,
        artistId: string,
        options: RefreshOptions,
    ): Promise<void> {
        if (!provider.getArtistVideos) {
            return;
        }

        try {
            const videos = (await provider.getArtistVideos(providerArtistId) || [])
                .map((video) => ({
                    ...providerVideoToOfferRow(video, artistId),
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
                            const detailed = await provider.getVideo!(String(video.provider_id));
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
            RefreshVideoService.upsertArtistVideos(artistId, videos, options);
            await this.precacheArtistVideoArtwork(artistId);
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to fetch videos on ${provider.name} for ${artistId}:`, error);
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
        const releaseGroups = db.prepare(`
            SELECT DISTINCT rg.mbid
            FROM Albums rg
            LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
            ORDER BY rg.mbid ASC
        `).all(artistMbid, artistMbid) as Array<{ mbid: string }>;
        const limit = pLimit(6);
        await Promise.all(releaseGroups.map((releaseGroup) => limit(async () => {
            try {
                await resolveAlbumArtwork({ albumMbid: releaseGroup.mbid });
            } catch (error) {
                console.warn(
                    `[RefreshArtistService] Failed to pre-cache album artwork for ${releaseGroup.mbid}:`,
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
        const artistMbid = this.getArtistMusicBrainzId(artistId);
        const videoIds = db.prepare(`
            SELECT DISTINCT
              recording.id AS id,
              recording.cover_image_url AS cover_image_url
            FROM Recordings recording
            JOIN ProviderItems offer
              ON offer.entity_type = 'video'
             AND (offer.recording_id = recording.id
                  OR (recording.mbid IS NOT NULL AND offer.recording_mbid = recording.mbid))
            WHERE recording.is_video = 1
              AND (recording.artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = ?)
                   OR recording.artist_mbid = ?)
        `).all(artistMbid, artistMbid) as Array<{
            id: number;
            cover_image_url?: string | null;
        }>;
        const needingArtwork = videoIds.filter(
            (video) => (
                !hasCachedMediaCover(video.id, "Video", "Cover")
                || (
                    Boolean(String(video.cover_image_url || "").trim())
                    && !isMediaCoverSourceCacheCurrent(
                        video.id,
                        "Video",
                        "Cover",
                        video.cover_image_url,
                    )
                )
            ),
        );
        if (needingArtwork.length === 0) {
            return;
        }
        const limit = pLimit(6);
        await Promise.all(needingArtwork.map((video) => limit(async () => {
            try {
                await resolveVideoArtwork({ videoId: video.id });
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to pre-cache video artwork for ${video.id}:`, error);
            }
        })));
    }

}
