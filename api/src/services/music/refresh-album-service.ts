import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { createCooperativeBatcher } from "../../utils/concurrent.js";
import { ScanLevel, type ScanOptions } from "./scan-types.js";
import { isRefreshDue, shouldRefreshTracks } from "./scan-refresh-state.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import type { ProviderReleaseGroupMatch } from "../metadata/provider-release-group-matcher.js";
import { streamingProviderManager } from "../providers/index.js";
import type { ProviderAlbum, ProviderTrack } from "../providers/streaming-provider.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";
import { ProviderArtistIdentityService, type ProviderArtistIdentityInput } from "../metadata/provider-artist-identity-service.js";
import { ProviderOfferReleaseLinkService } from "../metadata/provider-offer-release-link-service.js";
import { upsertProviderReleaseMatch } from "./provider-matches.js";

type SimilarAlbumSeed = {
    albumId: string;
    artistId: string;
};

const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMusicBrainzMbid(value: string | number | null | undefined): boolean {
    return MUSICBRAINZ_MBID_RE.test(String(value || "").trim());
}

function providerAlbumToAlbumMetadataRow(providerAlbum: ProviderAlbum): any {
    const raw = providerAlbum.raw;
    if (raw && typeof raw === "object" && "provider_id" in raw) {
        return raw;
    }

    return {
        id: providerAlbum.providerId,
        provider_id: providerAlbum.providerId,
        artist_id: providerAlbum.artist?.providerId || null,
        artist_name: providerAlbum.artist?.name || "Unknown Artist",
        artists: Array.isArray(providerAlbum.artists)
            ? providerAlbum.artists.map(a => ({ id: a.providerId, name: a.name }))
            : (providerAlbum.artist ? [{ id: providerAlbum.artist.providerId, name: providerAlbum.artist.name }] : []),
        title: providerAlbum.title,
        release_date: providerAlbum.releaseDate || null,
        cover: providerAlbum.cover || null,
        num_tracks: providerAlbum.trackCount || 0,
        num_videos: 0,
        num_volumes: providerAlbum.volumeCount || 1,
        duration: providerAlbum.duration || 0,
        type: providerAlbum.type || "ALBUM",
        version: providerAlbum.version || null,
        explicit: providerAlbum.explicit || false,
        quality: providerAlbum.quality || "LOSSLESS",
        url: providerAlbum.url,
        popularity: 0,
        copyright: null,
        upc: providerAlbum.upc || null,
    };
}

function providerTrackToTrackMetadataRow(providerTrack: ProviderTrack): any {
    const raw = providerTrack.raw;
    if (raw && typeof raw === "object" && "provider_id" in raw) {
        return raw;
    }

    return {
        provider_id: providerTrack.providerId,
        title: providerTrack.title,
        duration: providerTrack.duration || 0,
        track_number: providerTrack.trackNumber || 0,
        volume_number: providerTrack.volumeNumber || 1,
        version: null,
        isrc: providerTrack.isrc || null,
        explicit: false,
        quality: providerTrack.quality || "LOSSLESS",
        copyright: (providerTrack as any).copyright || null,
        artist_id: providerTrack.artist?.providerId || null,
        artist_name: providerTrack.artist?.name || "Unknown Artist",
        artists: Array.isArray(providerTrack.artists)
            ? providerTrack.artists.map(a => ({ id: a.providerId, name: a.name }))
            : (providerTrack.artist ? [{ id: providerTrack.artist.providerId, name: providerTrack.artist.name }] : []),
        url: providerTrack.url,
        popularity: (providerTrack as any).popularity || 0,
        release_date: null,
    };
}

function getProviderLibrarySlot(quality?: string | null): string {
    return isSpatialAudioQuality(quality) ? "spatial" : "stereo";
}

function textOrNull(...values: unknown[]): string | null {
    for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) {
            return text;
        }
    }
    return null;
}

function positiveNumberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// replay_gain is typically negative dB and peak is a 0..1 fraction, so a
// positive-only guard would drop valid values. Treat absent (null/undefined/"")
// as "no supplement" but accept any finite number, including negatives and 0.
function finiteNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getAlbumIdentityStatusFromProviderMatch(match?: ProviderReleaseGroupMatch | null): string | null {
    if (!match || match.status === "unmatched") {
        return null;
    }
    return match.status === "verified" ? "verified" : "ambiguous";
}

function primaryTypeFromProviderMatch(match?: ProviderReleaseGroupMatch | null): string | null {
    return String(match?.releaseGroup?.primaryType || "").trim().toLowerCase() || null;
}

function secondaryTypeFromProviderMatch(match?: ProviderReleaseGroupMatch | null): string | null {
    const secondaryTypes = match?.releaseGroup?.secondaryTypes || [];
    return secondaryTypes.map((type) => String(type || "").trim().toLowerCase()).filter(Boolean)[0] || null;
}

export class RefreshAlbumService {
    private static getCanonicalAlbumLink(providerId: string, albumId: string): {
        releaseGroupMbid: string | null;
        releaseMbid: string | null;
    } {
        const providerItem = db.prepare(`
            SELECT release_group_mbid, release_mbid
            FROM ProviderItems
            WHERE provider = ?
              AND entity_type = 'album'
              AND provider_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(providerId, albumId) as { release_group_mbid?: string | null; release_mbid?: string | null } | undefined;

        return {
            releaseGroupMbid: providerItem?.release_group_mbid || null,
            releaseMbid: providerItem?.release_mbid || null,
        };
    }

    private static storeCanonicalAlbumSupplements(input: {
        releaseGroupMbid?: string | null;
        releaseMbid?: string | null;
        album: any;
    }): void {
        const releaseGroupMbid = textOrNull(input.releaseGroupMbid);
        const releaseMbid = textOrNull(input.releaseMbid);
        const album = input.album || {};

        if (releaseGroupMbid) {
            db.prepare(`
                UPDATE Albums SET
                    cover_image_id = COALESCE(NULLIF(?, ''), cover_image_id),
                    vibrant_color = COALESCE(NULLIF(?, ''), vibrant_color),
                    video_cover = COALESCE(NULLIF(?, ''), video_cover),
                    popularity = COALESCE(?, popularity),
                    updated_at = CURRENT_TIMESTAMP
                WHERE mbid = ?
            `).run(
                textOrNull(album.cover, album.image_id, album.imageId),
                textOrNull(album.vibrant_color, album.vibrantColor),
                textOrNull(album.video_cover, album.videoCover),
                positiveNumberOrNull(album.popularity),
                releaseGroupMbid,
            );
        }

        if (releaseMbid) {
            db.prepare(`
                UPDATE AlbumReleases SET
                    copyright = COALESCE(NULLIF(?, ''), copyright),
                    updated_at = CURRENT_TIMESTAMP
                WHERE mbid = ?
            `).run(
                textOrNull(album.copyright),
                releaseMbid,
            );
        }
    }

    private static storeCanonicalAlbumReview(input: {
        releaseGroupMbid?: string | null;
        reviewText: string;
        reviewSource?: string | null;
        reviewLastUpdated?: string | null;
    }): void {
        const releaseGroupMbid = textOrNull(input.releaseGroupMbid);
        if (!releaseGroupMbid) {
            return;
        }

        db.prepare(`
            UPDATE Albums SET
                review_text = ?,
                review_source = COALESCE(NULLIF(?, ''), review_source),
                review_last_updated = COALESCE(NULLIF(?, ''), review_last_updated),
                updated_at = CURRENT_TIMESTAMP
            WHERE mbid = ?
        `).run(
            input.reviewText,
            textOrNull(input.reviewSource),
            textOrNull(input.reviewLastUpdated),
            releaseGroupMbid,
        );
    }

    private static storeCanonicalTrackSupplements(recordingId: number | null | undefined, track: any): void {
        if (!recordingId) {
            return;
        }

        db.prepare(`
            UPDATE Recordings SET
                copyright = COALESCE(NULLIF(?, ''), copyright),
                popularity = COALESCE(?, popularity),
                replay_gain = COALESCE(?, replay_gain),
                peak = COALESCE(?, peak),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            textOrNull(track?.copyright),
            positiveNumberOrNull(track?.popularity),
            finiteNumberOrNull(track?.replay_gain),
            finiteNumberOrNull(track?.peak),
            recordingId,
        );
    }

    private static storeCanonicalTrackCredits(providerId: string, trackProviderId: string, credits: unknown): void {
        const serializedCredits = JSON.stringify(credits);
        db.prepare(`
            UPDATE Recordings SET
                credits = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = (
                SELECT recording_id
                FROM ProviderItems
                WHERE provider = ?
                  AND entity_type = 'track'
                  AND provider_id = ?
                  AND recording_id IS NOT NULL
                LIMIT 1
            )
               OR mbid = (
                SELECT recording_mbid
                FROM ProviderItems
                WHERE provider = ?
                  AND entity_type = 'track'
                  AND provider_id = ?
                  AND recording_mbid IS NOT NULL
                LIMIT 1
            )
        `).run(serializedCredits, providerId, trackProviderId, providerId, trackProviderId);
    }

    private static resolveProviderForAlbum(albumId: string): any {
        const itemRow = db.prepare(`
            SELECT provider
            FROM ProviderItems
            WHERE entity_type = 'album' AND provider_id = ?
            LIMIT 1
        `).get(albumId) as { provider?: string } | undefined;
        if (itemRow?.provider) {
            return streamingProviderManager.getStreamingProvider(itemRow.provider);
        }

        const slotRow = db.prepare(`
            SELECT selected_provider
            FROM ReleaseGroupSlots
            WHERE selected_provider_id = ?
               OR selected_provider_id LIKE ?
               OR selected_provider_id LIKE ?
               OR selected_provider_id LIKE ?
            LIMIT 1
        `).get(albumId, `${albumId};%`, `%;${albumId}`, `%;${albumId};%`) as { selected_provider?: string } | undefined;
        if (slotRow?.selected_provider) {
            return streamingProviderManager.getStreamingProvider(slotRow.selected_provider);
        }

        return streamingProviderManager.getDefaultStreamingProvider();
    }
    private static getArtistMbidForReleaseGroup(releaseGroupMbid?: string | null): string | null {
        if (!releaseGroupMbid) {
            return null;
        }

        const row = db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?")
            .get(releaseGroupMbid) as { artist_mbid?: string | null } | undefined;
        return row?.artist_mbid ? String(row.artist_mbid) : null;
    }

    private static async ensureMusicBrainzArtist(artistMbid: string, monitorArtist = false): Promise<string> {
        const { RefreshArtistService } = await import("./refresh-artist-service.js");
        return RefreshArtistService.upsertMusicBrainzArtist(artistMbid, {
            monitorArtist,
            includeSimilarArtists: false,
            seedSimilarArtists: false,
        });
    }

    private static async resolveCanonicalArtistForProviderAlbum(
        providerId: string,
        albumId: string,
        albumData: any,
        requestedArtistId?: string | null,
    ): Promise<string | null> {
        if (requestedArtistId && isMusicBrainzMbid(requestedArtistId)) {
            return this.ensureMusicBrainzArtist(requestedArtistId, false);
        }

        const providerItem = db.prepare(`
            SELECT artist_mbid, release_group_mbid
            FROM ProviderItems
            WHERE provider = ?
              AND entity_type = 'album'
              AND provider_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(providerId, albumId) as { artist_mbid?: string | null; release_group_mbid?: string | null } | undefined;

        const providerItemArtistMbid = providerItem?.artist_mbid || this.getArtistMbidForReleaseGroup(providerItem?.release_group_mbid);
        if (providerItemArtistMbid) {
            return this.ensureMusicBrainzArtist(providerItemArtistMbid, false);
        }

        const providerArtistId = albumData?.artist_id != null ? String(albumData.artist_id) : "";
        const providerArtistName = String(albumData?.artist_name || "").trim();
        if (!providerArtistId || !providerArtistName) {
            return null;
        }

        const cachedProviderArtist = db.prepare(`
            SELECT artist_mbid
            FROM ProviderItems
            WHERE provider = ?
              AND entity_type = 'artist'
              AND provider_id = ?
              AND artist_mbid IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(providerId, providerArtistId) as { artist_mbid?: string | null } | undefined;
        if (cachedProviderArtist?.artist_mbid) {
            return this.ensureMusicBrainzArtist(cachedProviderArtist.artist_mbid, false);
        }

        const artistIdentity: ProviderArtistIdentityInput = {
            providerId: providerArtistId,
            name: providerArtistName,
            raw: {
                id: providerArtistId,
                name: providerArtistName,
            },
        };
        const resolution = await ProviderArtistIdentityService.resolve(providerId, artistIdentity);
        if (!resolution.mbid) {
            ProviderArtistIdentityService.store(providerId, artistIdentity, resolution, null);
            return null;
        }

        const localArtistId = await this.ensureMusicBrainzArtist(resolution.mbid, false);
        ProviderArtistIdentityService.store(providerId, artistIdentity, resolution, localArtistId);
        return localArtistId;
    }

    static getScanLevel(albumId: string): ScanLevel {
        // Scan state is read from the canonical graph + the album's ProviderItems
        // offer now (no legacy provider catalog): the offer's existence = BASIC,
        // Albums.review_text (homed on shallow) = SHALLOW, and per-track credits
        // homed onto the album's Recordings (homed on deep) = DEEP.
        const offer = db.prepare(`
            SELECT release_group_mbid, release_mbid
            FROM ProviderItems
            WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(albumId) as { release_group_mbid?: string | null; release_mbid?: string | null } | undefined;

        if (!offer) {
            return ScanLevel.NONE;
        }

        const hasCredits = offer.release_mbid
            ? db.prepare(`
                SELECT 1 FROM Tracks t
                JOIN Recordings r ON r.mbid = t.recording_mbid
                WHERE t.release_mbid = ? AND r.credits IS NOT NULL
                LIMIT 1
            `).get(offer.release_mbid)
            : null;
        if (hasCredits) {
            return ScanLevel.DEEP;
        }

        const reviewText = offer.release_group_mbid
            ? (db.prepare("SELECT review_text FROM Albums WHERE mbid = ?").get(offer.release_group_mbid) as { review_text?: string | null } | undefined)?.review_text
            : null;
        const trackCount = Number((db.prepare(`
            SELECT COUNT(*) AS c FROM ProviderItems
            WHERE entity_type = 'track' AND provider_album_id = ?
        `).get(albumId) as { c?: number } | undefined)?.c || 0);
        if (reviewText !== null && reviewText !== undefined && trackCount > 0) {
            return ScanLevel.SHALLOW;
        }

        return ScanLevel.BASIC;
    }

    static async scanBasic(
        albumId: string,
        artistId?: string,
        moduleOverride?: string | null,
        options: ScanOptions = {},
    ): Promise<void> {
        console.log(`[RefreshAlbumService] scanBasic for ${albumId}`);

        const monitoringConfig = getConfigSection("monitoring");
        // Freshness is the album offer's updated_at (the offer is the provider
        // catalog now); the canonical link comes from release_(group_)mbid on it.
        const existingRow = db.prepare(`
            SELECT release_mbid AS mbid, release_group_mbid AS mb_release_group_id, updated_at AS last_scanned
            FROM ProviderItems
            WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(albumId) as any;
        const shouldRefreshAlbum =
            !existingRow ||
            options.forceUpdate === true ||
            isRefreshDue(existingRow?.last_scanned, monitoringConfig.album_refresh_days);

        if (existingRow && !shouldRefreshAlbum) {
            if (!existingRow.mbid || !existingRow.mb_release_group_id || options.forceUpdate === true) {
                await MetadataIdentityService.resolveAlbum(albumId, { force: options.forceUpdate === true });
            }
            console.log(`[RefreshAlbumService] scanBasic skipped for ${albumId} (fresh)`);
            return;
        }

        const provider = this.resolveProviderForAlbum(albumId);
        const albumData = providerAlbumToAlbumMetadataRow(await provider.getAlbum(albumId));
        const forceUpdate = options.forceUpdate === true;
        void moduleOverride;

        const primaryArtistId = await this.resolveCanonicalArtistForProviderAlbum(provider.id, albumId, albumData, artistId);
        if (!primaryArtistId) {
            throw new Error(`provider album ${albumId} could not be linked to a MusicBrainz artist. Refresh/curate the artist before hydrating provider tracks.`);
        }

        // No legacy ProviderAlbums row anymore — provider album facts live on the
        // ProviderItems offer (written by the artist scan / upsertArtistAlbum), and
        // allowed supplements are homed onto the canonical Albums/AlbumReleases rows.
        await MetadataIdentityService.resolveAlbum(albumId, { force: forceUpdate });
        const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
        this.storeCanonicalAlbumSupplements({
            releaseGroupMbid: canonicalLink.releaseGroupMbid,
            releaseMbid: canonicalLink.releaseMbid,
            album: albumData,
        });
        // Advance the offer freshness so isRefreshDue() sees this basic scan.
        db.prepare(`
            UPDATE ProviderItems SET updated_at = CURRENT_TIMESTAMP
            WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        `).run(albumId);

        const includeSimilar = options.includeSimilarAlbums !== false || options.seedSimilarAlbums === true;
        const similarAlbums = includeSimilar
            ? await this.storeSimilarAlbums(albumId, forceUpdate)
            : [];

        if (options.seedSimilarAlbums !== false) {
            const { RefreshArtistService } = await import("./refresh-artist-service.js");

            for (const similar of similarAlbums) {
                try {
                    await RefreshArtistService.scanShallow(similar.artistId, {
                        monitorArtist: false,
                        includeSimilarArtists: false,
                        seedSimilarArtists: false,
                    });
                    await this.scanShallow(similar.albumId, {
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                } catch (error) {
                    console.warn(`[RefreshAlbumService] Failed to seed similar album ${similar.albumId}:`, error);
                }
            }
        }

        console.log(`[RefreshAlbumService] scanBasic complete for ${albumId}`);
    }

    static async scanShallow(albumId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshAlbumService] scanShallow for ${albumId}`);

        const monitoringConfig = getConfigSection("monitoring");
        const existing = db.prepare(`
            SELECT a.review_text AS review_text, pi.updated_at AS last_scanned
            FROM ProviderItems pi
            LEFT JOIN Albums a ON a.mbid = pi.release_group_mbid
            WHERE pi.entity_type = 'album' AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY pi.updated_at DESC
            LIMIT 1
        `).get(albumId) as any;
        const shouldRefreshAlbumMeta =
            options.forceUpdate === true ||
            !existing ||
            isRefreshDue(existing?.last_scanned, monitoringConfig.album_refresh_days);

        if (shouldRefreshAlbumMeta) {
            await this.scanBasic(albumId, undefined, undefined, options);
        } else {
            console.log(`[RefreshAlbumService] Skipping album metadata refresh for ${albumId} (fresh)`);
        }

        const shouldRefreshTrackList =
            options.forceUpdate === true ||
            shouldRefreshTracks(albumId, monitoringConfig.track_refresh_days);
        if (shouldRefreshTrackList) {
            await this.scanTracks(albumId);
        } else {
            console.log(`[RefreshAlbumService] Skipping track refresh for album ${albumId} (fresh)`);
        }

        const shouldRefreshReview =
            options.forceUpdate === true ||
            existing?.review_text == null ||
            shouldRefreshAlbumMeta;

        if (shouldRefreshReview) {
            try {
                const provider = this.resolveProviderForAlbum(albumId);
                const reviewText = await provider.getAlbumReview?.(albumId);
                const reviewLastUpdated = new Date().toISOString();

                // Review homes onto the canonical Albums row (no legacy provider row).
                if (reviewText !== null && reviewText !== undefined) {
                    const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
                    this.storeCanonicalAlbumReview({
                        releaseGroupMbid: canonicalLink.releaseGroupMbid,
                        reviewText: reviewText ?? "",
                        reviewSource: provider.id,
                        reviewLastUpdated,
                    });
                } else if (options.forceUpdate === true || existing?.review_text == null) {
                    const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
                    this.storeCanonicalAlbumReview({
                        releaseGroupMbid: canonicalLink.releaseGroupMbid,
                        reviewText: "",
                        reviewSource: provider.id,
                        reviewLastUpdated,
                    });
                }
            } catch (error) {
                console.warn(`[RefreshAlbumService] Failed to fetch review for album ${albumId}:`, error);
            }
        } else {
            console.log(`[RefreshAlbumService] Skipping review refresh for album ${albumId} (fresh)`);
        }

        console.log(`[RefreshAlbumService] scanShallow complete for ${albumId}`);
    }

    static async scanDeep(albumId: string, options: ScanOptions = {}): Promise<void> {
        console.log(`[RefreshAlbumService] scanDeep for ${albumId}`);

        const currentLevel = this.getScanLevel(albumId);
        if (options.forceUpdate || currentLevel < ScanLevel.SHALLOW) {
            console.log(`[RefreshAlbumService] Album ${albumId} running SHALLOW scan (refresh=${options.forceUpdate === true})`);
            await this.scanShallow(albumId, options);
        }

        // Album-level credits had no canonical home and nothing reads them; only
        // per-track credits are kept (homed onto the canonical Recordings below).
        try {
            const provider = this.resolveProviderForAlbum(albumId);
            const trackCreditsMap = provider.getAlbumTrackCredits
                ? await provider.getAlbumTrackCredits(albumId)
                : new Map<string, any[]>();
            if (trackCreditsMap.size > 0) {
                db.transaction(() => {
                    for (const [trackId, credits] of trackCreditsMap) {
                        this.storeCanonicalTrackCredits(provider.id, String(trackId), credits);
                    }
                })();
            }
        } catch (error) {
            console.warn(`[RefreshAlbumService] Failed to fetch per-track credits for album ${albumId}:`, error);
        }

        // Advance offer freshness for this deep scan.
        db.prepare(`
            UPDATE ProviderItems SET updated_at = CURRENT_TIMESTAMP
            WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        `).run(albumId);

        console.log(`[RefreshAlbumService] scanDeep complete for ${albumId}`);
    }

    static async scanTracks(
        albumId: string,
        options: { resolveMusicBrainz?: boolean } = {},
    ): Promise<void> {
        // Track identity is mapped by position during this scan; `resolveMusicBrainz`
        // is accepted but unused.
        void options;
        const provider = this.resolveProviderForAlbum(albumId);
        const tracks = (await provider.getAlbumTracks(albumId))
            .map(providerTrackToTrackMetadataRow);
        console.log(`[RefreshAlbumService] Fetched ${tracks.length} tracks for album ${albumId}`);

        const album = db.prepare(`
            SELECT artist_mbid AS artist_id
            FROM ProviderItems
            WHERE entity_type = 'album' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(albumId) as any;
        if (!album) {
            console.warn(`[RefreshAlbumService] Album offer ${albumId} not found, skipping tracks`);
            return;
        }

        const providerId = provider.id;

        // Collect all guest artists
        const guestArtistsMap = new Map<string, { id: string, name: string }>();
        for (const track of tracks) {
            const trackArtistId = track.artist_id || album.artist_id;
            if (Array.isArray(track.artists)) {
                for (const a of track.artists) {
                    if (a.id && a.id !== trackArtistId) {
                        guestArtistsMap.set(a.id, a);
                    }
                }
            }
        }

        // Asynchronously resolve guest artists before transaction
        const resolvedGuestsMap = new Map<string, string>();
        const { RefreshArtistService } = await import("./refresh-artist-service.js");

        await Promise.all(
            Array.from(guestArtistsMap.values()).map(async (guest) => {
                try {
                    const artistIdentity: ProviderArtistIdentityInput = {
                        providerId: guest.id,
                        name: guest.name,
                        raw: {
                            id: guest.id,
                            name: guest.name,
                        },
                    };
                    const resolution = await ProviderArtistIdentityService.resolve(providerId, artistIdentity);
                    if (resolution.mbid) {
                        // Check if they exist in ArtistMetadata
                        const artistExists = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ? LIMIT 1").get(resolution.mbid);
                        if (!artistExists) {
                            const pictureUrl = (guest as any).picture || (guest as any).pictureUrl || null;
                            db.prepare(`
                                INSERT OR IGNORE INTO ArtistMetadata (mbid, name, picture, updated_at)
                                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                            `).run(resolution.mbid, guest.name, pictureUrl);
                        }
                        resolvedGuestsMap.set(guest.id, resolution.mbid);
                    }
                } catch (e) {
                    console.warn(`[RefreshAlbumService] Failed to resolve guest artist ${guest.name} (${guest.id}):`, e);
                }
            })
        );

        // Track identity is mapped by position onto the selected release's canonical
        // Tracks/Recordings and stored as a ProviderItems track offer. The selected
        // release comes from the album offer + its slot (no legacy ProviderAlbums).
        const selectedRelease = db.prepare(`
            SELECT
                COALESCE(rgs.selected_release_mbid, pi.release_mbid) AS release_mbid,
                COALESCE(rgs.release_group_mbid, pi.release_group_mbid) AS release_group_mbid,
                COALESCE(rgs.artist_mbid, pi.artist_mbid) AS artist_mbid,
                COALESCE(rgs.slot, pi.library_slot, 'stereo') AS library_slot,
                COALESCE(rgs.quality, pi.quality) AS quality
            FROM ProviderItems pi
            LEFT JOIN ReleaseGroupSlots rgs
              ON rgs.selected_provider = pi.provider
             AND (
                rgs.selected_provider_id = pi.provider_id
                OR rgs.selected_provider_id LIKE pi.provider_id || ';%'
                OR rgs.selected_provider_id LIKE '%;' || pi.provider_id || ';%'
                OR rgs.selected_provider_id LIKE '%;' || pi.provider_id
             )
            WHERE pi.entity_type = 'album'
              AND pi.provider = ?
              AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY
              CASE WHEN rgs.selected_release_mbid IS NOT NULL THEN 0 ELSE 1 END,
              CASE rgs.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
            LIMIT 1
        `).get(providerId, albumId) as {
            release_mbid?: string | null;
            release_group_mbid?: string | null;
            artist_mbid?: string | null;
            library_slot?: string | null;
            quality?: string | null;
        } | undefined;
        const selectCanonicalTrackByPosition = db.prepare(`
            SELECT
                t.id AS track_id,
                t.mbid AS track_mbid,
                t.recording_mbid,
                r.id AS recording_id
            FROM Tracks t
            LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
            WHERE t.release_mbid = ?
              AND t.medium_position = ?
              AND t.position = ?
              AND COALESCE(r.is_video, 0) = 0
            LIMIT 1
        `);
        const upsertProviderTrackOffer = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, provider_album_id, title, version, explicit, quality,
                isrc, duration, release_date, artist_mbid, release_group_mbid, release_mbid,
                track_mbid, recording_mbid, library_slot, track_id, recording_id,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'track', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                provider_album_id = COALESCE(excluded.provider_album_id, ProviderItems.provider_album_id),
                title = excluded.title,
                version = excluded.version,
                explicit = excluded.explicit,
                quality = excluded.quality,
                isrc = excluded.isrc,
                duration = excluded.duration,
                release_date = excluded.release_date,
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                release_group_mbid = COALESCE(excluded.release_group_mbid, ProviderItems.release_group_mbid),
                release_mbid = COALESCE(excluded.release_mbid, ProviderItems.release_mbid),
                track_mbid = COALESCE(excluded.track_mbid, ProviderItems.track_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, ProviderItems.recording_mbid),
                library_slot = excluded.library_slot,
                track_id = COALESCE(excluded.track_id, ProviderItems.track_id),
                recording_id = COALESCE(excluded.recording_id, ProviderItems.recording_id),
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
        `);

        const cooperateTrackStore = createCooperativeBatcher(25);
        const trackBatch: any[] = [];
        for (const track of tracks) {
            const trackArtistId = track.artist_id || album.artist_id;
            track.artist_id = trackArtistId;
            trackBatch.push(track);

            if (trackBatch.length >= 25 || track === tracks[tracks.length - 1]) {
                db.transaction(() => {
                    for (const currentTrack of trackBatch) {
                        const releaseMbid = String(selectedRelease?.release_mbid || "").trim();
                        const canonicalTrack = releaseMbid
                            ? selectCanonicalTrackByPosition.get(
                                releaseMbid,
                                Number(currentTrack.volume_number || 1),
                                Number(currentTrack.track_number || 0),
                            ) as {
                                track_id?: number | null;
                                track_mbid?: string | null;
                                recording_mbid?: string | null;
                                recording_id?: number | null;
                            } | undefined
                            : null;
                        upsertProviderTrackOffer.run(
                            providerId,
                            String(currentTrack.provider_id),
                            String(albumId),
                            currentTrack.title || null,
                            currentTrack.version || null,
                            currentTrack.explicit ? 1 : 0,
                            currentTrack.quality || selectedRelease?.quality || null,
                            currentTrack.isrc || null,
                            currentTrack.duration || null,
                            currentTrack.release_date || null,
                            selectedRelease?.artist_mbid || null,
                            selectedRelease?.release_group_mbid || null,
                            releaseMbid || null,
                            canonicalTrack?.track_mbid || null,
                            canonicalTrack?.recording_mbid || null,
                            selectedRelease?.library_slot || getProviderLibrarySlot(currentTrack.quality || selectedRelease?.quality),
                            canonicalTrack?.track_id || null,
                            canonicalTrack?.recording_id || null,
                            canonicalTrack?.track_mbid ? "matched" : "pending",
                            canonicalTrack?.track_mbid ? 0.9 : null,
                            canonicalTrack?.track_mbid ? "selected-release-position" : "provider-album-tracklist",
                            JSON.stringify({
                                albumProviderId: albumId,
                                mediumPosition: Number(currentTrack.volume_number || 1),
                                trackPosition: Number(currentTrack.track_number || 0),
                            }),
                            JSON.stringify({
                                albumProviderId: albumId,
                                copyright: currentTrack.copyright || null,
                                popularity: currentTrack.popularity || null,
                            }),
                        );
                        this.storeCanonicalTrackSupplements(canonicalTrack?.recording_id || null, currentTrack);
                    }
                })();
                trackBatch.length = 0;
                await cooperateTrackStore();
            }
        }

        // Per-track canonical identity is established above by position-mapping each
        // provider track onto the selected release's canonical Tracks/Recordings
        // (written into ProviderItems). The old per-track MusicBrainz search resolver
        // was retired with the legacy provider tables, so there is nothing more to do.
    }

    static async upsertArtistAlbum(
        album: any,
        scanningArtistId: string,
        albumModuleMap: Map<string, string>,
        options: ScanOptions,
    ): Promise<boolean> {
        const forceUpdate = options.forceUpdate === true;
        const primaryProviderArtistId = album.artist_id;
        const releaseGroupMatch = (album as { _mb_release_group_match?: ProviderReleaseGroupMatch })._mb_release_group_match || null;
        const matchedReleaseGroup = releaseGroupMatch?.status !== "unmatched" ? releaseGroupMatch?.releaseGroup : null;
        const matchedArtistMbid = (album as { _mb_artist_mbid?: string | null })._mb_artist_mbid || null;
        const primaryArtistId = matchedArtistMbid
            || (isMusicBrainzMbid(scanningArtistId) ? scanningArtistId : primaryProviderArtistId);

        const artistExists = db.prepare("SELECT id FROM Artists WHERE id = ?").get(primaryArtistId);
        if (!artistExists) {
            if (!isMusicBrainzMbid(primaryArtistId)) {
                throw new Error(`provider album ${album.provider_id} did not resolve to a canonical MusicBrainz artist.`);
            }
            await this.ensureMusicBrainzArtist(primaryArtistId, false);
        }

        // "New" = no album offer yet. The provider album's facts now live solely on
        // the ProviderItems offer (written below) + canonical supplement homing; the
        // legacy ProviderAlbums/ProviderAlbumArtists rows are gone. Album-artist
        // relations are canonical (AlbumArtists, from Skyhook).
        const offerExisted = db.prepare(`
            SELECT 1 FROM ProviderItems
            WHERE provider = 'tidal' AND entity_type = 'album'
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            LIMIT 1
        `).get(album.provider_id) as any;
        void albumModuleMap;
        void scanningArtistId;

        const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(releaseGroupMatch);

        db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, title, version, explicit, quality,
                upc, duration, release_date, artist_mbid, release_group_mbid, release_mbid, library_slot,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES ('tidal', 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
        `).run(
            String(album.provider_id),
            album.title || null,
            album.version || null,
            album.explicit ? 1 : 0,
            album.quality || null,
            album.upc || null,
            album.duration || null,
            album.release_date || null,
            matchedArtistMbid,
            matchedReleaseGroup?.mbid || null,
            matchedReleaseMbid,
            getProviderLibrarySlot(album.quality),
            releaseGroupMatch?.status || "unmatched",
            releaseGroupMatch?.confidence ?? null,
            releaseGroupMatch?.method || null,
            releaseGroupMatch ? JSON.stringify(releaseGroupMatch.evidence) : null,
            JSON.stringify({
                cover: album.cover || album.image_id || album.imageId || null,
                vibrant_color: album.vibrant_color || album.vibrantColor || null,
                video_cover: album.video_cover || album.videoCover || null,
                num_tracks: album.num_tracks || album.trackCount || null,
                num_volumes: album.num_volumes || album.volumeCount || null,
                num_videos: album.num_videos || album.videoCount || null,
                copyright: album.copyright || null,
                popularity: album.popularity || null,
                upc: album.upc || null,
                explicit: album.explicit == null ? null : Boolean(album.explicit),
                quality: album.quality || null,
            }),
        );

        // Additive: also persist the provider album -> MB release match into the
        // ProviderItemMatches candidate graph (powers the release-availability switcher).
        // The ProviderItems offer write above is unchanged.
        if (matchedReleaseMbid) {
            upsertProviderReleaseMatch({
                provider: "tidal",
                providerId: String(album.provider_id),
                providerAlbumId: String(album.provider_id),
                releaseMbid: matchedReleaseMbid,
                status: releaseGroupMatch?.status ?? null,
                confidence: releaseGroupMatch?.confidence ?? null,
                method: releaseGroupMatch?.method ?? null,
                evidence: releaseGroupMatch ? JSON.stringify(releaseGroupMatch.evidence) : null,
            });
        }

        this.storeCanonicalAlbumSupplements({
            releaseGroupMbid: matchedReleaseGroup?.mbid || null,
            releaseMbid: matchedReleaseMbid,
            album,
        });

        if (options.resolveMusicBrainz !== false) {
            await MetadataIdentityService.resolveAlbum(String(album.provider_id), {
                force: forceUpdate,
            });
        }

        return !offerExisted;
    }

    private static async storeSimilarAlbums(
        albumId: string,
        forceUpdate: boolean = false,
    ): Promise<SimilarAlbumSeed[]> {
        void albumId;
        void forceUpdate;
        return [];
    }

    private static getMusicBrainzPrimary(tidalType: string | undefined, module: string | undefined, title: string = ""): string {
        if (this.getMusicBrainzSecondary(tidalType, module, title) !== null) {
            return "album";
        }
        const type = (tidalType || "ALBUM").toUpperCase();
        switch (type) {
            case "SINGLE": return "single";
            case "EP": return "ep";
            case "ALBUM":
            default: return "album";
        }
    }

    private static getMusicBrainzSecondary(tidalType: string | undefined, module: string | undefined, title: string = ""): string | null {
        const normalizedModule = (module || "").toUpperCase();
        const lowerTitle = (title || "").toLowerCase();

        if (normalizedModule === "LIVE" || normalizedModule === "ARTIST_LIVE_ALBUMS") return "live";
        if (normalizedModule === "COMPILATION" || normalizedModule === "ARTIST_COMPILATIONS") return "compilation";
        if (normalizedModule === "DJ_MIXES") return "dj-mix";
        if (normalizedModule === "APPEARS_ON") return null;

        if (lowerTitle.includes("soundtrack") || lowerTitle.includes("o.s.t.") || lowerTitle.includes("original score") || lowerTitle.includes("motion picture")) {
            return "soundtrack";
        }
        if (lowerTitle.includes("remix") || lowerTitle.includes("remixed") || lowerTitle.includes("remixes")) {
            return "remix";
        }

        return null;
    }
}
