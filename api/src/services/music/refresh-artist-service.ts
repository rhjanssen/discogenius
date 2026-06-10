import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { shouldHydrateArtistCatalog } from "../config/scan-policy.js";
import {
    resolveArtistFolderForIdentityUpdate,
    resolveArtistFolderFromTemplate,
    shouldReapplyArtistPathTemplate,
} from "./artist-paths.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import { ScanLevel, type ScanOptions } from "./scan-types.js";
import { isRefreshDue, shouldRefreshVideos } from "./scan-refresh-state.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import { skyHookProxy } from "../metadata/skyhook-proxy.js";
import { syncMusicBrainzVideosForArtist } from "../metadata/musicbrainz-video-service.js";
import {
    matchProviderAlbumsToReleaseGroups,
    type MusicBrainzReleaseGroupForMatching,
    type ProviderReleaseGroupMatch,
} from "../metadata/provider-release-group-matcher.js";
import { ProviderArtistIdentityService, normalizeProviderArtist } from "../metadata/provider-artist-identity-service.js";
import { streamingProviderManager } from "../providers/index.js";
import type { StreamingProvider, ProviderAlbum, ProviderArtist, ProviderTrack, ProviderVideo } from "../providers/streaming-provider.js";
import { ReleaseGroupSlotService, type ProviderAlbumSlotCandidate } from "./release-group-slot-service.js";
import { ProviderOfferReleaseLinkService } from "../metadata/provider-offer-release-link-service.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import {
    getSkyHookArtistImageUrl,
    resolveArtistArtwork,
    type ProviderArtworkCandidate,
} from "../metadata/media-cover-service.js";
import { MusicBrainzArtistCreditService } from "../metadata/musicbrainz-artist-credit-service.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import { requestMusicBrainzJson } from "../mediafiles/fingerprint.js";
import { queueArtistIntake } from "./artist-workflow.js";

const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMusicBrainzMbid(value: string | number | null | undefined): boolean {
    return MUSICBRAINZ_MBID_RE.test(String(value || "").trim());
}

function providerAlbumToOfferRow(providerAlbum: ProviderAlbum, fallbackArtistId: string): any {
    const raw = providerAlbum.raw;
    if (raw && typeof raw === "object" && "provider_id" in raw) {
        return {
            ...raw,
            provider_id: String((raw as any).provider_id),
        };
    }

    return {
        provider_id: providerAlbum.providerId,
        artist_id: providerAlbum.artist?.providerId || fallbackArtistId,
        artist_name: providerAlbum.artist?.name || "Unknown Artist",
        artists: providerAlbum.artist ? [{ id: providerAlbum.artist.providerId, name: providerAlbum.artist.name }] : [],
        title: providerAlbum.title || "Unknown Album",
        release_date: providerAlbum.releaseDate || null,
        cover: providerAlbum.cover || null,
        vibrant_color: null,
        video_cover: null,
        num_tracks: providerAlbum.trackCount || 0,
        num_videos: 0,
        num_volumes: providerAlbum.volumeCount || 1,
        duration: providerAlbum.duration || 0,
        type: providerAlbum.type || "ALBUM",
        version: providerAlbum.version || null,
        explicit: providerAlbum.explicit || false,
        quality: providerAlbum.quality || "LOSSLESS",
        url: providerAlbum.url || null,
        popularity: 0,
        copyright: null,
        upc: providerAlbum.upc || null,
        _group_type: "ALBUMS",
        _module: providerAlbum.type === "EP" ? "EP" : providerAlbum.type === "SINGLE" ? "SINGLE" : "ALBUM",
    };
}

function providerVideoToLegacyVideoRow(providerVideo: ProviderVideo, fallbackArtistId: string): any {
    const raw = providerVideo.raw;
    if (raw && typeof raw === "object" && "provider_id" in raw) {
        return raw;
    }

    return {
        provider_id: providerVideo.providerId,
        title: providerVideo.title,
        duration: providerVideo.duration || 0,
        release_date: providerVideo.releaseDate || null,
        explicit: providerVideo.explicit || false,
        quality: providerVideo.quality || "MP4_1080P",
        image_id: providerVideo.cover || null,
        artist_id: providerVideo.artist?.providerId || fallbackArtistId,
        artist_name: providerVideo.artist?.name || "Unknown Artist",
        artists: providerVideo.artists || [],
        url: providerVideo.url,
        isrc: providerVideo.isrc || null,
        recording_mbid: providerVideo.recordingMbid || null,
        type: "Music Video",
    };
}

function parseJsonObject(value: unknown): Record<string, any> {
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

function providerArtistArtworkSnapshot(artist: ProviderArtist): string {
    return JSON.stringify({
        picture: artist.picture || null,
        popularity: artist.popularity ?? null,
        url: artist.url || null,
    });
}

export class RefreshArtistService {
    private static getArtistMusicBrainzId(artistId: string): string | null {
        const row = db.prepare("SELECT mbid FROM Artists WHERE id = ?").get(artistId) as { mbid?: string | null } | undefined;
        return row?.mbid ? String(row.mbid) : null;
    }

    private static async syncArtistMusicBrainzCatalog(
        artistId: string,
        force = false,
        includeCreditedReleaseGroups = false,
        expandCreditedArtists = false,
    ): Promise<string | null> {
        const artistMbid = this.getArtistMusicBrainzId(artistId);
        if (!artistMbid) {
            return null;
        }

        const cachedCount = db.prepare("SELECT COUNT(*) AS count FROM Albums WHERE artist_mbid = ?")
            .get(artistMbid) as { count: number };
        const cachedVideoCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM Recordings
            WHERE artist_mbid = ?
              AND is_video = 1
        `).get(artistMbid) as { count: number };

        if (!force && Number(cachedCount?.count || 0) > 0 && Number(cachedVideoCount?.count || 0) > 0) {
            return artistMbid;
        }

        try {
            if (force || Number(cachedCount?.count || 0) === 0) {
                await skyHookProxy.syncArtist(artistMbid);
            }
            if (includeCreditedReleaseGroups) {
                const credited = await MusicBrainzArtistCreditService.syncCreditedReleaseGroupsForArtist(artistMbid);
                console.log(
                    `[RefreshArtistService] Synced ${credited.releaseGroups} credited MusicBrainz release group(s) ` +
                    `and ${credited.artists} credited artist(s) for ${artistMbid}`,
                );
                for (const collaboratorMbid of expandCreditedArtists ? credited.artistMbids : []) {
                    if (collaboratorMbid === artistMbid) {
                        continue;
                    }
                    const collaborator = db.prepare(`
                        SELECT
                            a.id,
                            a.name,
                            a.picture,
                            a.cover_image_url AS coverImageUrl,
                            a.last_scanned AS lastScanned,
                            a.library_origin AS libraryOrigin
                        FROM Artists a
                        WHERE a.mbid = ?
                        LIMIT 1
                    `).get(collaboratorMbid) as {
                        id?: string | number;
                        name?: string | null;
                        picture?: string | null;
                        coverImageUrl?: string | null;
                        lastScanned?: string | null;
                        libraryOrigin?: string | null;
                    } | undefined;

                    const requiresHydration =
                        !collaborator?.lastScanned ||
                        collaborator.libraryOrigin === "musicbrainz-credit";
                    if (requiresHydration) {
                        queueArtistIntake({
                            artistId: String(collaborator?.id || collaboratorMbid),
                            artistName: String(collaborator?.name || collaboratorMbid),
                            monitored: false,
                            forceUpdate: true,
                            expandCreditedArtists: false,
                            priority: -1,
                        });
                    }
                }
            }
            const syncedVideos = await syncMusicBrainzVideosForArtist(artistMbid, { force });
            if (syncedVideos > 0) {
                console.log(`[RefreshArtistService] Synced ${syncedVideos} MusicBrainz video recording(s) for artist ${artistMbid}`);
            }
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to sync canonical metadata for artist ${artistId} (${artistMbid}):`, error);
        }

        return artistMbid;
    }

    private static async hydrateScopedReleaseGroups(artistMbid: string): Promise<void> {
        const releaseGroups = db.prepare(`
            SELECT DISTINCT rg.mbid
            FROM Albums rg
            LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            WHERE (rg.artist_mbid = ? OR scope.artist_mbid = ?)
              AND NOT EXISTS (
                SELECT 1
                FROM AlbumReleases release
                WHERE release.release_group_mbid = rg.mbid
              )
            ORDER BY rg.mbid ASC
        `).all(artistMbid, artistMbid) as Array<{ mbid: string }>;

        for (const releaseGroup of releaseGroups) {
            try {
                await skyHookProxy.syncReleaseGroup(releaseGroup.mbid, artistMbid);
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to hydrate canonical release group ${releaseGroup.mbid}:`, error);
            }
        }
    }

    static async upsertMusicBrainzArtist(artistMbid: string, options: ScanOptions = {}): Promise<string> {
        if (!isMusicBrainzMbid(artistMbid)) {
            throw new Error(`Invalid MusicBrainz artist id: ${artistMbid}`);
        }

        const existing = db.prepare(
            "SELECT id, monitored, path FROM Artists WHERE id = ? OR mbid = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1",
        ).get(artistMbid, artistMbid, artistMbid) as { id: string | number; monitored?: number | null; path?: string | null } | undefined;
        const localArtistId = existing?.id != null ? String(existing.id) : artistMbid;
        const shouldMonitor = options.monitorArtist === true ? true : Boolean(existing?.monitored);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;
        const artistData = await skyHookProxy.syncArtist(artistMbid);
        const artistName = artistData.artistname || "Unknown Artist";
        const providerArtworkRows = db.prepare(`
            SELECT provider, provider_id, data
            FROM ProviderItems
            WHERE entity_type = 'artist'
              AND artist_mbid = ?
            ORDER BY updated_at DESC
        `).all(artistMbid) as Array<{ provider: string; provider_id: string; data?: string | null }>;

        let maxPopularity = 0;
        for (const row of providerArtworkRows) {
            if (row.data) {
                try {
                    const parsed = JSON.parse(row.data);
                    if (typeof parsed.popularity === "number" && parsed.popularity > maxPopularity) {
                        maxPopularity = parsed.popularity;
                    }
                } catch {
                    // Ignore JSON parsing errors
                }
            }
        }

        const providerCandidates: ProviderArtworkCandidate[] = providerArtworkRows.map((row) => ({
            provider: row.provider,
            entityId: row.provider_id,
            data: row.data,
        }));
        const posterUrl = await resolveArtistArtwork({
            artistMbid,
            skyHookData: artistData,
            providerCandidates,
            preferredCoverTypes: ["Poster", "Headshot"],
        });
        const fanartUrl = getSkyHookArtistImageUrl(artistData, "Fanart") || posterUrl;
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
                    monitored, monitored_at, user_date_added, last_scanned, path
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', CURRENT_TIMESTAMP, 'musicbrainz-metadata',
                    ?, 'musicbrainz', ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, ?, CURRENT_TIMESTAMP, ?)
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
                    bio_text = COALESCE(?, bio_text),
                    bio_source = CASE WHEN ? IS NOT NULL THEN 'musicbrainz' ELSE bio_source END,
                    monitored = ?,
                    monitored_at = CASE WHEN ? = 1 THEN COALESCE(monitored_at, CURRENT_TIMESTAMP) ELSE monitored_at END,
                    last_scanned = CURRENT_TIMESTAMP,
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

    private static buildProviderReleaseGroupMatches(
        artistMbid: string | null,
        albums: any[],
    ): Map<string, ProviderReleaseGroupMatch> {
        if (!artistMbid || albums.length === 0) {
            return new Map();
        }

        const releaseGroups = skyHookProxy.getCachedReleaseGroupsForArtist(artistMbid);
        if (releaseGroups.length === 0) {
            return new Map();
        }

        return matchProviderAlbumsToReleaseGroups(
            albums.map((album) => ({
                providerId: String(album.provider_id),
                title: String(album.title || ""),
                version: album.version ?? null,
                releaseDate: album.release_date ?? null,
                type: album.type ?? null,
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

    private static normalizeRecordingText(value: unknown): string {
        return String(value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
    }

    private static normalizeIsrc(value: unknown): string {
        return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
    }

    private static slotTrack(track: ProviderTrack) {
        return {
            mbid: null,
            isrc: this.normalizeIsrc(track.isrc) || null,
            title: track.title || null,
            track_number: track.trackNumber || null,
            volume_number: track.volumeNumber || 1,
            duration: track.duration || null,
        };
    }

    private static async enrichCanonicalReleaseIsrcs(releaseMbid: string): Promise<void> {
        const url = `https://musicbrainz.org/ws/2/release/${encodeURIComponent(releaseMbid)}?fmt=json&inc=recordings+isrcs`;
        const release = await requestMusicBrainzJson<any>(url);
        const tracks = Array.isArray(release?.media)
            ? release.media.flatMap((medium: any) => Array.isArray(medium?.tracks) ? medium.tracks : [])
            : [];
        const updateRecording = db.prepare("UPDATE Recordings SET isrcs = ? WHERE mbid = ?");

        db.transaction(() => {
            for (const track of tracks) {
                const recordingMbid = String(track?.recording?.id || "").trim();
                const isrcs = Array.isArray(track?.recording?.isrcs)
                    ? track.recording.isrcs.map(this.normalizeIsrc).filter(Boolean)
                    : [];
                if (recordingMbid && isrcs.length > 0) {
                    updateRecording.run(JSON.stringify(Array.from(new Set(isrcs))), recordingMbid);
                }
            }
        })();
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
            const hydratedTracks = new Map<string, ReturnType<typeof RefreshArtistService.slotTrack>[]>();

            const hydrateAlbum = async (albumId: string): Promise<ReturnType<typeof RefreshArtistService.slotTrack>[]> => {
                const cached = hydratedTracks.get(albumId);
                if (cached) {
                    return cached;
                }

                const album = albumsById.get(albumId);
                if (Array.isArray(album?._provider_tracks)) {
                    hydratedTracks.set(albumId, album._provider_tracks);
                    return album._provider_tracks;
                }

                const tracks = (await provider.getAlbumTracks(albumId)).map((track) => this.slotTrack(track));
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

            try {
                await this.enrichCanonicalReleaseIsrcs(representative.mbid);
            } catch (error) {
                console.warn(`[RefreshArtistService] Failed to enrich canonical ISRCs for ${representative.mbid}:`, error);
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
                    isrcs = Array.isArray(parsed) ? parsed.map(this.normalizeIsrc).filter(Boolean) : [];
                } catch {
                    isrcs = [];
                }
                return {
                    title: target.title,
                    normalizedTitle: this.normalizeRecordingText(target.title),
                    isrcs: new Set(isrcs),
                };
            });
            const coversTarget = (track: ReturnType<typeof RefreshArtistService.slotTrack>, target: typeof targetRows[number]) =>
                Boolean(track.isrc && target.isrcs.has(track.isrc))
                || this.normalizeRecordingText(track.title) === target.normalizedTitle;

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

                    const slotTrack = this.slotTrack(track);
                    if (!coversTarget(slotTrack, target)) {
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
            skyHookProxy.getCachedReleaseGroupsForArtist(artistMbid)
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
                            providerId: String(album.provider_id),
                            title: String(album.title || ""),
                            version: album.version ?? null,
                            releaseDate: album.release_date ?? null,
                            type: album.type ?? null,
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

    private static storeProviderAlbumOffers(
        providerId: string,
        artistMbid: string | null,
        albums: any[],
        matches: Map<string, ProviderReleaseGroupMatch>,
    ): void {
        if (albums.length === 0) {
            return;
        }

        const upsert = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, title, version, explicit, quality,
                upc, duration, release_date, artist_mbid, release_group_mbid, release_mbid, library_slot,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                title = excluded.title,
                version = excluded.version,
                explicit = excluded.explicit,
                quality = excluded.quality,
                upc = excluded.upc,
                duration = excluded.duration,
                release_date = excluded.release_date,
                artist_mbid = excluded.artist_mbid,
                release_group_mbid = excluded.release_group_mbid,
                release_mbid = excluded.release_mbid,
                library_slot = excluded.library_slot,
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
        `);

        db.transaction(() => {
            for (const album of albums) {
                const providerAlbumId = String(album.provider_id);
                const match = matches.get(providerAlbumId);
                const matchedReleaseGroup = match?.status !== "unmatched" ? match?.releaseGroup : null;
                const canonicalOwner = matchedReleaseGroup?.mbid
                    ? db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?")
                        .get(matchedReleaseGroup.mbid) as { artist_mbid?: string | null } | undefined
                    : null;
                const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(match);
                upsert.run(
                    providerId,
                    providerAlbumId,
                    album.title || null,
                    album.version || null,
                    album.explicit ? 1 : 0,
                    album.quality || null,
                    album.upc || null,
                    album.duration || null,
                    album.release_date || null,
                    matchedReleaseGroup ? canonicalOwner?.artist_mbid || artistMbid : null,
                    matchedReleaseGroup?.mbid || null,
                    matchedReleaseMbid,
                    isSpatialAudioQuality(album.quality) ? "spatial" : "stereo",
                    match?.status || "unmatched",
                    match?.confidence ?? null,
                    match?.method || null,
                    match ? JSON.stringify(match.evidence) : null,
                    JSON.stringify({
                        cover: album.cover || null,
                        explicit: album.explicit == null ? null : Boolean(album.explicit),
                        quality: album.quality || null,
                        discoveredFromArtistMbid: artistMbid,
                        tracks: album._provider_tracks || null,
                    }),
                );

            }
        })();
    }

    private static buildStoredProviderAlbumSelections(
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
                pi.data,
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
              AND pi.match_status IN ('verified', 'probable')
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
            data: string | null;
            release_group_title: string;
            primary_type: string | null;
            secondary_types: string | null;
            first_release_date: string | null;
            disambiguation: string | null;
        }>;

        return rows.map((row) => {
            const evidence = parseJsonObject(row.match_evidence);
            const data = parseJsonObject(row.data);
            let secondaryTypes: string[] = [];
            try {
                const parsed = JSON.parse(String(row.secondary_types || "[]"));
                secondaryTypes = Array.isArray(parsed) ? parsed.map((type) => String(type)) : [];
            } catch {
                secondaryTypes = [];
            }

            const providerId = String(row.provider_id);
            const providerTrackCount = Number(evidence.providerTrackCount || data.trackCount || data.num_tracks || 0);
            const providerVolumeCount = Number(evidence.providerVolumeCount || data.volumeCount || data.num_volumes || 0);
            const evidencePayload: Record<string, any> & { providerTitle: string } = {
                providerTitle: row.title || "",
                ...evidence,
            };

            return {
                provider: row.provider,
                album: {
                    providerId,
                    title: row.title || "",
                    version: row.version || null,
                    releaseDate: row.release_date || null,
                    quality: row.quality || null,
                    explicit: row.explicit,
                    trackCount: providerTrackCount > 0 ? providerTrackCount : null,
                    volumeCount: providerVolumeCount > 0 ? providerVolumeCount : null,
                    tracks: Array.isArray(data.tracks) ? data.tracks : undefined,
                    raw: data,
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

    static syncProviderSelectionsFromStoredOffers(artistMbid: string | null): { stereo: number; spatial: number } {
        const candidates = this.buildStoredProviderAlbumSelections(artistMbid);
        if (candidates.length === 0) {
            return { stereo: 0, spatial: 0 };
        }

        return ReleaseGroupSlotService.syncProviderAlbumSelections({
            artistMbid,
            candidates,
            clearProviders: [],
        });
    }

    private static normalizeProviderMatchText(value: unknown): string {
        return String(value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
    }

    private static getLinkedProviderArtistId(artistMbid: string, providerId: string): string | null {
        const row = db.prepare("SELECT data FROM ArtistMetadata WHERE mbid = ? LIMIT 1")
            .get(artistMbid) as { data?: string | null } | undefined;
        if (!row?.data) {
            return null;
        }

        try {
            const artist = JSON.parse(row.data);
            const linkType = providerId === "apple-music" ? "apple" : providerId;
            const links = Array.isArray(artist?.links) ? artist.links : [];
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

    private static storeProviderArtistMatch(provider: StreamingProvider, artistMbid: string, artist: ProviderArtist, status: "verified" | "probable"): void {
        db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, artist_mbid,
                title, match_status, match_confidence, match_method, data, updated_at
            )
            VALUES (?, 'artist', ?, ?, ?, ?, ?, 'artist-name-search', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                title = excluded.title,
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
        `).run(
            provider.id,
            artist.providerId,
            artistMbid,
            artist.name || null,
            status,
            status === "verified" ? 1 : 0.75,
            providerArtistArtworkSnapshot(artist),
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

    private static async resolveProviderArtistId(provider: StreamingProvider, artistId: string, artistMbid: string | null): Promise<string | null> {
        if (!artistMbid || !isMusicBrainzMbid(artistId)) {
            return artistId;
        }

        const cached = db.prepare(`
            SELECT provider_id
            FROM ProviderItems
            WHERE provider = ?
              AND entity_type = 'artist'
              AND artist_mbid = ?
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(provider.id, artistMbid) as { provider_id?: string | number | null } | undefined;
        if (cached?.provider_id != null) {
            return String(cached.provider_id);
        }

        const linkedProviderArtistId = this.getLinkedProviderArtistId(artistMbid, provider.id);
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
            const normalizedName = this.normalizeProviderMatchText(artistName);
            const exact = artists.find((artist) => this.normalizeProviderMatchText(artist.name) === normalizedName);
            const selected = exact || artists[0] || null;
            if (!selected?.providerId) {
                return null;
            }

            const resolution = await ProviderArtistIdentityService.resolve(provider.id, normalizeProviderArtist(selected));
            if (resolution.mbid !== artistMbid) {
                console.warn(
                    `[RefreshArtistService] Skipping ${provider.name} artist "${selected.name}" (${selected.providerId}) for ${artistName}: ` +
                    `provider identity resolved to ${resolution.mbid || resolution.status}, expected ${artistMbid}.`
                );
                return null;
            }

            this.storeProviderArtistMatch(provider, artistMbid, selected, resolution.status === "verified" ? "verified" : "probable");
            return selected.providerId;
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to resolve ${provider.name} artist for ${artistName} (${artistMbid}):`, error);
            return null;
        }
    }

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

    private static async storeSimilarArtists(artistId: string, forceUpdate = false): Promise<string[]> {
        try {
            const provider = streamingProviderManager.getDefaultStreamingProvider();
            const artistMbid = this.getArtistMusicBrainzId(artistId);
            const providerArtistId = await this.resolveProviderArtistId(provider, artistId, artistMbid);
            if (!providerArtistId || !artistMbid) {
                return [];
            }

            const similarArtists = provider.getSimilarArtists
                ? await provider.getSimilarArtists(providerArtistId)
                : [];
            const ids = new Set<string>();

            const deleteRelations = db.prepare("DELETE FROM ProviderSimilarArtists WHERE artist_id = ?");
            const insertRelation = db.prepare(`
                INSERT OR IGNORE INTO ProviderSimilarArtists (artist_id, similar_artist_id)
                VALUES (?, ?)
            `);

            deleteRelations.run(artistMbid);
            for (const similarArtist of similarArtists || []) {
                const providerIdentity = normalizeProviderArtist(similarArtist);
                if (!providerIdentity.providerId || providerIdentity.providerId === providerArtistId) {
                    continue;
                }

                const musicBrainzIdentity = await ProviderArtistIdentityService.resolve(provider.id, providerIdentity);
                if (!musicBrainzIdentity.mbid) {
                    ProviderArtistIdentityService.store(provider.id, providerIdentity, musicBrainzIdentity, null);
                    continue;
                }

                // Check if they exist in ArtistMetadata
                const similarArtistExists = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ? LIMIT 1").get(musicBrainzIdentity.mbid);
                if (!similarArtistExists) {
                    const pictureUrl = similarArtist.picture || null;
                    db.prepare(`
                        INSERT OR IGNORE INTO ArtistMetadata (mbid, name, picture, updated_at)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    `).run(musicBrainzIdentity.mbid, providerIdentity.name, pictureUrl);
                }

                ProviderArtistIdentityService.store(provider.id, providerIdentity, musicBrainzIdentity, musicBrainzIdentity.mbid);
                if (musicBrainzIdentity.mbid && musicBrainzIdentity.mbid !== artistMbid) {
                    ids.add(musicBrainzIdentity.mbid);
                    insertRelation.run(artistMbid, musicBrainzIdentity.mbid);
                }
            }

            return Array.from(ids);
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to fetch/store similar artists for ${artistId}:`, error);
            return [];
        }
    }

    static getScanLevel(artistId: string): ScanLevel {
        const artist = db.prepare(`
            SELECT
                id,
                name,
                picture,
                bio_text,
                last_scanned,
                mbid,
                (
                    SELECT COUNT(DISTINCT rg.mbid)
                    FROM Albums rg
                    LEFT JOIN ArtistReleaseGroups scope
                      ON scope.release_group_mbid = rg.mbid
                    WHERE rg.artist_mbid = Artists.mbid
                       OR scope.artist_mbid = Artists.mbid
                ) AS release_group_count,
                (
                    SELECT COUNT(DISTINCT release.mbid)
                    FROM AlbumReleases release
                    JOIN Albums rg ON rg.mbid = release.release_group_mbid
                    LEFT JOIN ArtistReleaseGroups scope
                      ON scope.release_group_mbid = rg.mbid
                    WHERE rg.artist_mbid = Artists.mbid
                       OR scope.artist_mbid = Artists.mbid
                ) AS release_count,
                (
                    SELECT COUNT(DISTINCT track.mbid)
                    FROM Tracks track
                    JOIN AlbumReleases release ON release.mbid = track.release_mbid
                    JOIN Albums rg ON rg.mbid = release.release_group_mbid
                    LEFT JOIN ArtistReleaseGroups scope
                      ON scope.release_group_mbid = rg.mbid
                    WHERE rg.artist_mbid = Artists.mbid
                       OR scope.artist_mbid = Artists.mbid
                ) AS track_count,
                (
                    SELECT COUNT(*)
                    FROM Recordings recording
                    WHERE recording.is_video = 1
                      AND recording.artist_mbid = Artists.mbid
                ) AS video_count,
                (
                    SELECT COUNT(*)
                    FROM ProviderItems item
                    WHERE item.entity_type IN ('album', 'video')
                      AND item.match_status IN ('verified', 'probable')
                      AND (
                        item.artist_mbid = Artists.mbid
                        OR EXISTS (
                            SELECT 1
                            FROM Albums rg
                            LEFT JOIN ArtistReleaseGroups scope
                              ON scope.release_group_mbid = rg.mbid
                            WHERE rg.mbid = item.release_group_mbid
                              AND (rg.artist_mbid = Artists.mbid OR scope.artist_mbid = Artists.mbid)
                        )
                      )
                ) AS provider_offer_count
            FROM Artists
            WHERE id = ?
        `).get(artistId) as {
            id?: string;
            name?: string | null;
            bio_text?: string | null;
            release_group_count?: number;
            release_count?: number;
            track_count?: number;
            video_count?: number;
            provider_offer_count?: number;
        } | undefined;

        if (!artist) {
            return ScanLevel.NONE;
        }

        const releaseGroupCount = Number(artist.release_group_count || 0);
        const releaseCount = Number(artist.release_count || 0);
        const trackCount = Number(artist.track_count || 0);
        const videoCount = Number(artist.video_count || 0);
        const providerOfferCount = Number(artist.provider_offer_count || 0);
        if (
            (releaseGroupCount > 0 && (releaseCount > 0 || trackCount > 0 || providerOfferCount > 0))
            || videoCount > 0
        ) {
            return ScanLevel.DEEP;
        }

        if (artist.bio_text !== null && artist.bio_text !== undefined) {
            return ScanLevel.SHALLOW;
        }

        if (artist.name) {
            return ScanLevel.BASIC;
        }

        return ScanLevel.NONE;
    }

    static async scanBasic(artistId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] scanBasic for ${artistId}`);

        const existing = db.prepare(
            "SELECT id, monitored, name, mbid, last_scanned, path FROM Artists WHERE id = ?",
        ).get(artistId) as any;
        const refreshDays = getConfigSection("monitoring").artist_refresh_days;
        const shouldRefresh =
            !existing ||
            options.forceUpdate === true ||
            isRefreshDue(existing?.last_scanned, refreshDays);

        const shouldMonitor = options.monitorArtist === true ? true : (existing?.monitored || false);
        const shouldMonitorInt = shouldMonitor ? 1 : 0;
        const provider = streamingProviderManager.getDefaultStreamingProvider();
        const providerAuthenticated = provider.isAuthenticated ? provider.isAuthenticated() : true;

        if (isMusicBrainzMbid(artistId) && (!existing || existing.mbid === artistId || String(existing.id) === artistId)) {
            await this.upsertMusicBrainzArtist(artistId, options);
            console.log(`[RefreshArtistService] scanBasic complete for MusicBrainz artist ${artistId}`);
            return;
        }

        if (existing?.mbid && !providerAuthenticated) {
            await this.upsertMusicBrainzArtist(String(existing.mbid), {
                ...options,
                monitorArtist: options.monitorArtist === true ? true : Boolean(existing.monitored),
            });
            console.log(`[RefreshArtistService] scanBasic skipped provider lookup for ${artistId} (provider not connected)`);
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

            const includeSimilar = options.includeSimilarArtists !== false || options.seedSimilarArtists === true;
            if (includeSimilar) {
                const queryId = existing?.mbid || artistId;
                const hasSimilar = db.prepare(
                    "SELECT 1 FROM ProviderSimilarArtists WHERE artist_id = ? LIMIT 1",
                ).get(queryId) as any;
                const shouldFetchSimilar = options.seedSimilarArtists === true || !hasSimilar;

                if (shouldFetchSimilar) {
                    const similarArtistIds = await this.storeSimilarArtists(artistId, options.forceUpdate === true);
                    if (options.seedSimilarArtists) {
                        for (const similarArtistId of similarArtistIds) {
                            try {
                                await this.scanShallow(similarArtistId, {
                                    monitorArtist: false,
                                    includeSimilarArtists: false,
                                    seedSimilarArtists: false,
                                });
                            } catch (error) {
                                console.warn(`[RefreshArtistService] Failed to seed similar artist ${similarArtistId}:`, error);
                            }
                        }
                    }
                }
            }

            if (!existing.mbid || options.forceUpdate === true) {
                await MetadataIdentityService.resolveArtist(artistId, { force: options.forceUpdate === true });
                this.reapplyArtistPathAfterIdentity(artistId);
                await this.syncArtistMusicBrainzCatalog(artistId, options.forceUpdate === true);
            }

            console.log(`[RefreshArtistService] scanBasic skipped for ${artistId} (fresh)`);
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
                await this.scanBasic(localArtistId, {
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

    static async scanShallow(artistId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] scanShallow for ${artistId}`);

        const refreshDays = getConfigSection("monitoring").artist_refresh_days;
        const existing = db.prepare("SELECT bio_text, last_scanned FROM Artists WHERE id = ?").get(artistId) as any;
        const shouldRefreshBio =
            options.forceUpdate === true ||
            existing?.bio_text == null ||
            isRefreshDue(existing?.last_scanned, refreshDays);

        await this.scanBasic(artistId, options);

        const refreshed = db.prepare("SELECT mbid FROM Artists WHERE id = ?").get(artistId) as { mbid?: string | null } | undefined;
        if (isMusicBrainzMbid(artistId) && refreshed?.mbid === artistId) {
            console.log(`[RefreshArtistService] Skipping provider biography lookup for MusicBrainz artist ${artistId}`);
            return;
        }

        if (!shouldRefreshBio) {
            console.log(`[RefreshArtistService] Skipping bio refresh for ${artistId} (fresh)`);
            return;
        }

        try {
            const provider = streamingProviderManager.getDefaultStreamingProvider();
            const bioText = await provider.getArtistBio?.(artistId);

            if (bioText !== null && bioText !== undefined) {
                db.prepare(`
                    UPDATE Artists SET
                        bio_text = ?,
                        bio_source = ?,
                        bio_last_updated = ?
                    WHERE id = ?
                `).run(bioText ?? "", provider.id, new Date().toISOString(), artistId);
            } else if (options.forceUpdate === true || existing?.bio_text == null) {
                db.prepare(`
                    UPDATE Artists SET
                        bio_text = ?,
                        bio_source = ?,
                        bio_last_updated = ?
                    WHERE id = ?
                `).run("", provider.id, new Date().toISOString(), artistId);
            }
        } catch (error) {
            console.warn(`[RefreshArtistService] Failed to fetch bio for ${artistId}:`, error);
        }

        console.log(`[RefreshArtistService] scanShallow complete for ${artistId}`);
    }

    static async scanDeep(artistId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshArtistService] scanDeep for ${artistId}`);
        options.progress?.({ kind: "status", message: `Scanning artist ${artistId}...` });

        const monitoringConfig = getConfigSection("monitoring");
        const artistRow = db.prepare("SELECT last_scanned FROM Artists WHERE id = ?").get(artistId) as any;
        const currentLevel = this.getScanLevel(artistId);
        const shouldScanArtist =
            options.forceUpdate === true ||
            currentLevel < ScanLevel.DEEP ||
            !artistRow ||
            isRefreshDue(artistRow?.last_scanned, monitoringConfig.artist_refresh_days);

        if (!shouldScanArtist) {
            console.log(`[RefreshArtistService] Skipping artist ${artistId} scan (fresh)`);
            return;
        }

        const includeSimilarArtists = options.includeSimilarArtists !== false;
        const seedSimilarArtists = options.seedSimilarArtists !== false;
        const hasManagedMetadata = currentLevel >= ScanLevel.DEEP;
        const shouldHydrateCatalog = options.forceUpdate === true || shouldHydrateArtistCatalog(options, {
            hasManagedMetadata,
        });
        const shouldRunShallow =
            options.forceUpdate === true ||
            currentLevel < ScanLevel.SHALLOW ||
            includeSimilarArtists ||
            seedSimilarArtists;

        if (shouldRunShallow) {
            console.log(`[RefreshArtistService] Artist ${artistId} running SHALLOW scan (refresh=${options.forceUpdate === true})`);
            await this.scanShallow(artistId, {
                ...options,
                includeSimilarArtists,
                seedSimilarArtists,
            });
        }

        let artistMbid = (db.prepare("SELECT mbid FROM Artists WHERE id = ?")
            .get(artistId) as { mbid?: string | null } | undefined)?.mbid
            || (isMusicBrainzMbid(artistId) ? artistId : null);

        if (shouldHydrateCatalog) {
            const monitoredArtist = db.prepare("SELECT monitored FROM Artists WHERE id = ?")
                .get(artistId) as { monitored?: number | null } | undefined;
            const isMonitored = Boolean(monitoredArtist?.monitored);
            artistMbid = await this.syncArtistMusicBrainzCatalog(
                artistId,
                options.forceUpdate === true,
                isMonitored,
                isMonitored,
            );
            if (artistMbid) {
                await this.hydrateScopedReleaseGroups(artistMbid);
            }
            const providers = streamingProviderManager.getAllStreamingProviders();
            const connectedProviders = providers.filter((p) => p.isAuthenticated ? p.isAuthenticated() : true);

            if (connectedProviders.length === 0) {
                console.log(
                    `[RefreshArtistService] Skipping provider catalog hydration for ${artistId} ` +
                    `(no providers connected)`,
                );
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
                return;
            }

            const allMatchedSelections: Array<{
                provider: string;
                album: ProviderAlbumSlotCandidate;
                match: ProviderReleaseGroupMatch;
            }> = [];
            const refreshedProviders = new Set<string>();
            let totalAlbumsCount = 0;

            for (const provider of connectedProviders) {
                const providerArtistId = await this.resolveProviderArtistId(provider, artistId, artistMbid);
                if (!providerArtistId) {
                    console.log(`[RefreshArtistService] Skipping catalog hydration on ${provider.name} for ${artistId} (no provider artist match)`);
                    continue;
                }

                const shouldRefreshArtistVideos =
                    options.forceUpdate === true ||
                    shouldRefreshVideos(artistId, monitoringConfig.video_refresh_days);
                if (shouldRefreshArtistVideos && provider.getArtistVideos) {
                    try {
                        const videos = (await provider.getArtistVideos(providerArtistId) || [])
                            .map((video) => ({
                                ...providerVideoToLegacyVideoRow(video, artistId),
                                _provider: provider.id,
                            }));
                        console.log(`[RefreshArtistService] Found ${videos.length} videos on ${provider.name} for artist ${artistId}`);
                        RefreshVideoService.upsertArtistVideos(artistId, videos, options);
                    } catch (error) {
                        console.warn(`[RefreshArtistService] Failed to fetch videos on ${provider.name} for ${artistId}:`, error);
                    }
                }

                try {
                    const providerAlbums = provider.listArtistReleaseOffers
                        ? await provider.listArtistReleaseOffers(providerArtistId)
                        : await provider.getArtistAlbums(providerArtistId);
                    const albums = providerAlbums.map((album) => providerAlbumToOfferRow(album, artistId));

                    // Fetch tracks for all provider albums to support track-level matching
                    for (const album of albums) {
                        let loadedTracks: any[] | null = null;
                        const cachedItem = db.prepare(`
                            SELECT data
                            FROM ProviderItems
                            WHERE provider = ? AND entity_type = 'album' AND provider_id = ?
                        `).get(provider.id, String(album.provider_id)) as { data?: string | null } | undefined;

                        if (cachedItem?.data) {
                            try {
                                const parsed = JSON.parse(cachedItem.data);
                                if (Array.isArray(parsed.tracks) && parsed.tracks.length === Number(album.num_tracks)) {
                                    loadedTracks = parsed.tracks;
                                }
                            } catch {
                                // Ignore JSON parse errors
                            }
                        }

                        if (loadedTracks) {
                            album._provider_tracks = loadedTracks;
                        }
                    }

                    const missingAlbums = albums.filter((album) => !album._provider_tracks);
                    if (missingAlbums.length > 0) {
                        console.log(`[RefreshArtistService] Fetching tracklists for ${missingAlbums.length} albums from ${provider.name}...`);
                        const chunkSize = 5;
                        for (let i = 0; i < missingAlbums.length; i += chunkSize) {
                            const chunk = missingAlbums.slice(i, i + chunkSize);
                            await Promise.all(
                                chunk.map(async (album) => {
                                    try {
                                        const rawTracks = await provider.getAlbumTracks(album.provider_id);
                                        album._provider_tracks = rawTracks.map((t) => this.slotTrack(t));
                                    } catch (error) {
                                        console.warn(`[RefreshArtistService] Failed to fetch tracks for album ${album.provider_id}:`, error);
                                        album._provider_tracks = [];
                                    }
                                })
                            );
                        }
                    }

                    const providerReleaseGroupMatches = this.buildProviderReleaseGroupMatches(artistMbid, albums);
                    console.log(`[RefreshArtistService] Found ${albums.length} albums on ${provider.name} for artist ${artistId}`);

                    totalAlbumsCount += albums.length;

                    this.storeProviderAlbumOffers(provider.id, artistMbid, albums, providerReleaseGroupMatches);
                    refreshedProviders.add(provider.id);

                    for (const album of albums) {
                        const providerAlbumId = String(album.provider_id);
                        const match = providerReleaseGroupMatches.get(providerAlbumId);
                        if (match) {
                            allMatchedSelections.push({
                                provider: provider.id,
                                album: {
                                    providerId: providerAlbumId,
                                    title: String(album.title || ""),
                                    version: album.version ?? null,
                                    releaseDate: album.release_date ?? null,
                                    quality: album.quality ?? null,
                                    explicit: album.explicit ?? null,
                                    trackCount: album.num_tracks ?? null,
                                    volumeCount: album.num_volumes ?? null,
                                    tracks: Array.isArray(album._provider_tracks) ? album._provider_tracks : undefined,
                                    raw: album,
                                },
                                match,
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`[RefreshArtistService] Failed to fetch albums on ${provider.name} for ${artistId}:`, error);
                }
            }

            options.progress?.({ kind: "albums_total", total: totalAlbumsCount });

            const registeredProviderIds = new Set(providers.map((provider) => provider.id));
            const staleProviderIds = db
                .prepare(`
                    SELECT DISTINCT selected_provider AS providerId
                    FROM ReleaseGroupSlots
                    WHERE selected_provider IS NOT NULL
                `)
                .all()
                .map((row) => String((row as { providerId: string }).providerId))
                .filter((providerId) => !registeredProviderIds.has(providerId));

            const slotCounts = ReleaseGroupSlotService.syncProviderAlbumSelections({
                artistMbid,
                candidates: allMatchedSelections,
                clearProviders: [...new Set([...refreshedProviders, ...staleProviderIds])],
            });
            const storedSlotCounts = this.syncProviderSelectionsFromStoredOffers(artistMbid);
            const totalSlotCounts = {
                stereo: Math.max(slotCounts.stereo, storedSlotCounts.stereo),
                spatial: Math.max(slotCounts.spatial, storedSlotCounts.spatial),
            };
            if (totalSlotCounts.stereo > 0 || totalSlotCounts.spatial > 0) {
                console.log(`[RefreshArtistService] Selected provider offers for ${totalSlotCounts.stereo} stereo and ${totalSlotCounts.spatial} spatial release-group slots`);
            }
        } else {
            console.log(`[RefreshArtistService] Skipping broad catalog hydration for artist ${artistId} (managed metadata already present)`);
            const slotCounts = this.syncProviderSelectionsFromStoredOffers(artistMbid);
            if (slotCounts.stereo > 0 || slotCounts.spatial > 0) {
                console.log(`[RefreshArtistService] Rebuilt provider selections from stored offers for ${slotCounts.stereo} stereo and ${slotCounts.spatial} spatial release-group slots`);
            }
        }

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
        console.log(`[RefreshArtistService] scanDeep complete for ${artistId}`);
    }

}
