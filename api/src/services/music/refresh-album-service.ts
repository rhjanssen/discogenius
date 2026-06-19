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

        if (providerItem?.release_group_mbid || providerItem?.release_mbid) {
            return {
                releaseGroupMbid: providerItem.release_group_mbid || null,
                releaseMbid: providerItem.release_mbid || null,
            };
        }

        const legacyAlbum = db.prepare(`
            SELECT mb_release_group_id, mbid
            FROM ProviderAlbums
            WHERE id = ?
            LIMIT 1
        `).get(albumId) as { mb_release_group_id?: string | null; mbid?: string | null } | undefined;

        return {
            releaseGroupMbid: legacyAlbum?.mb_release_group_id || null,
            releaseMbid: legacyAlbum?.mbid || null,
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
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            textOrNull(track?.copyright),
            positiveNumberOrNull(track?.popularity),
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

        const existing = db.prepare(`
            SELECT Artists.id, Artists.mbid, ProviderAlbums.mb_release_group_id
            FROM ProviderAlbums
            JOIN Artists ON Artists.id = ProviderAlbums.artist_id
            WHERE ProviderAlbums.id = ?
            LIMIT 1
        `).get(albumId) as { id?: string | number | null; mbid?: string | null; mb_release_group_id?: string | null } | undefined;
        if (existing?.mbid) {
            return String(existing.id || existing.mbid);
        }

        const existingReleaseGroupArtistMbid = this.getArtistMbidForReleaseGroup(existing?.mb_release_group_id);
        if (existingReleaseGroupArtistMbid) {
            return this.ensureMusicBrainzArtist(existingReleaseGroupArtistMbid, false);
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
        const album = db.prepare(`
            SELECT
                a.id,
                a.review_text,
                a.credits,
                COUNT(m.id) as track_count
            FROM ProviderAlbums a
            LEFT JOIN ProviderMedia m ON a.id = m.album_id AND m.type != 'Music Video'
            WHERE a.id = ?
            GROUP BY a.id
        `).get(albumId) as {
            id?: string;
            review_text?: string | null;
            credits?: string | null;
            track_count?: number;
        } | undefined;

        if (!album) {
            return ScanLevel.NONE;
        }

        if (album.credits) {
            return ScanLevel.DEEP;
        }

        if (album.review_text !== null && album.review_text !== undefined && Number(album.track_count || 0) > 0) {
            return ScanLevel.SHALLOW;
        }

        if (album.id) {
            return ScanLevel.BASIC;
        }

        return ScanLevel.NONE;
    }

    static async scanBasic(
        albumId: string,
        artistId?: string,
        moduleOverride?: string | null,
        options: ScanOptions = {},
    ): Promise<void> {
        console.log(`[RefreshAlbumService] scanBasic for ${albumId}`);

        const monitoringConfig = getConfigSection("monitoring");
        const existingRow = db.prepare("SELECT id, mbid, mb_release_group_id, last_scanned FROM ProviderAlbums WHERE id = ?").get(albumId) as any;
        const shouldRefreshAlbum =
            !existingRow ||
            options.forceUpdate === true ||
            isRefreshDue(existingRow?.last_scanned, monitoringConfig.album_refresh_days);

        if (existingRow && !shouldRefreshAlbum) {
            if (!existingRow.mbid || !existingRow.mb_release_group_id || options.forceUpdate === true) {
                await MetadataIdentityService.resolveAlbum(albumId, { force: options.forceUpdate === true, includeTracks: false });
            }
            console.log(`[RefreshAlbumService] scanBasic skipped for ${albumId} (fresh)`);
            return;
        }

        const provider = this.resolveProviderForAlbum(albumId);
        const albumData = providerAlbumToAlbumMetadataRow(await provider.getAlbum(albumId));
        const forceUpdate = options.forceUpdate === true;

        const primaryArtistId = await this.resolveCanonicalArtistForProviderAlbum(provider.id, albumId, albumData, artistId);
        if (!primaryArtistId) {
            throw new Error(`provider album ${albumId} could not be linked to a MusicBrainz artist. Refresh/curate the artist before hydrating provider tracks.`);
        }

        const existing = db.prepare("SELECT id, monitored, monitored_lock FROM ProviderAlbums WHERE id = ?").get(albumId) as any;
        const existingModuleRow = artistId
            ? (db.prepare("SELECT module FROM ProviderAlbumArtists WHERE album_id = ? AND artist_id = ?").get(albumId, artistId) as any)
            : null;
        const module = moduleOverride ?? existingModuleRow?.module ?? null;

        if (!existing) {
            db.prepare(`
                INSERT INTO ProviderAlbums (
                    id, artist_id, title, version, release_date, type, explicit, quality,
                    cover, vibrant_color, video_cover,
                    num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                    mb_primary, mb_secondary, monitored, last_scanned
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
                albumId,
                primaryArtistId,
                albumData.title,
                albumData.version || null,
                albumData.release_date,
                albumData.type || "ALBUM",
                albumData.explicit ? 1 : 0,
                albumData.quality,
                albumData.cover,
                albumData.vibrant_color || null,
                albumData.video_cover || null,
                albumData.num_tracks || 0,
                albumData.num_volumes || 1,
                albumData.num_videos || 0,
                albumData.duration || 0,
                albumData.popularity || null,
                albumData.copyright || null,
                albumData.upc || null,
                this.getMusicBrainzPrimary(albumData.type, module, albumData.title),
                this.getMusicBrainzSecondary(albumData.type, module, albumData.title),
                0,
            );
        } else {
            const updateSql = forceUpdate
                ? `
                UPDATE ProviderAlbums SET
                    artist_id=?,
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=?, video_cover=?,
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `
                : `
                UPDATE ProviderAlbums SET
                    artist_id=COALESCE(?, artist_id),
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=COALESCE(?, vibrant_color), video_cover=COALESCE(?, video_cover),
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `;

            db.prepare(updateSql).run(
                primaryArtistId ?? null,
                albumData.title,
                albumData.version || null,
                albumData.release_date,
                albumData.type || "ALBUM",
                albumData.explicit ? 1 : 0,
                albumData.quality,
                albumData.cover,
                albumData.vibrant_color || null,
                albumData.video_cover || null,
                albumData.num_tracks || 0,
                albumData.num_volumes || 1,
                albumData.num_videos || 0,
                albumData.duration || 0,
                albumData.popularity || null,
                albumData.copyright || null,
                albumData.upc || null,
                this.getMusicBrainzPrimary(albumData.type, module, albumData.title),
                this.getMusicBrainzSecondary(albumData.type, module, albumData.title),
                albumId,
            );
        }

        await MetadataIdentityService.resolveAlbum(albumId, { force: forceUpdate, includeTracks: false });
        const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
        this.storeCanonicalAlbumSupplements({
            releaseGroupMbid: canonicalLink.releaseGroupMbid,
            releaseMbid: canonicalLink.releaseMbid,
            album: albumData,
        });

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
        const existing = db.prepare(`SELECT review_text, last_scanned FROM ProviderAlbums WHERE id = ?`).get(albumId) as any;
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

                if (reviewText !== null && reviewText !== undefined) {
                    db.prepare(`
                        UPDATE ProviderAlbums
                        SET review_text = ?, review_source = ?, review_last_updated = ?
                        WHERE id = ?
                    `).run(reviewText ?? "", provider.id, reviewLastUpdated, albumId);
                    const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
                    this.storeCanonicalAlbumReview({
                        releaseGroupMbid: canonicalLink.releaseGroupMbid,
                        reviewText: reviewText ?? "",
                        reviewSource: provider.id,
                        reviewLastUpdated,
                    });
                } else if (options.forceUpdate === true || existing?.review_text == null) {
                    db.prepare(`
                        UPDATE ProviderAlbums
                        SET review_text = ?, review_source = ?, review_last_updated = ?
                        WHERE id = ?
                    `).run("", provider.id, reviewLastUpdated, albumId);
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

        try {
            const provider = this.resolveProviderForAlbum(albumId);
            const credits = provider.getAlbumCredits
                ? await provider.getAlbumCredits(albumId)
                : [];
            if (credits && credits.length > 0) {
                db.prepare("UPDATE ProviderAlbums SET credits = ? WHERE id = ?")
                    .run(JSON.stringify(credits), albumId);
            }
        } catch (error) {
            console.warn(`[RefreshAlbumService] Failed to fetch credits for album ${albumId}:`, error);
        }

        try {
            const provider = this.resolveProviderForAlbum(albumId);
            const trackCreditsMap = provider.getAlbumTrackCredits
                ? await provider.getAlbumTrackCredits(albumId)
                : new Map<string, any[]>();
            if (trackCreditsMap.size > 0) {
                const updateTrackCredits = db.prepare("UPDATE ProviderMedia SET credits = ? WHERE id = ? AND album_id = ?");
                db.transaction(() => {
                    for (const [trackId, credits] of trackCreditsMap) {
                        updateTrackCredits.run(JSON.stringify(credits), trackId, albumId);
                        this.storeCanonicalTrackCredits(provider.id, String(trackId), credits);
                    }
                })();
            }
        } catch (error) {
            console.warn(`[RefreshAlbumService] Failed to fetch per-track credits for album ${albumId}:`, error);
        }

        db.prepare("UPDATE ProviderAlbums SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?").run(albumId);

        console.log(`[RefreshAlbumService] scanDeep complete for ${albumId}`);
    }

    static async scanTracks(
        albumId: string,
        options: { resolveMusicBrainz?: boolean } = {},
    ): Promise<void> {
        const provider = this.resolveProviderForAlbum(albumId);
        const tracks = (await provider.getAlbumTracks(albumId))
            .map(providerTrackToTrackMetadataRow);
        console.log(`[RefreshAlbumService] Fetched ${tracks.length} tracks for album ${albumId}`);

        const album = db.prepare("SELECT id, artist_id, type, monitored FROM ProviderAlbums WHERE id = ?").get(albumId) as any;
        if (!album) {
            console.warn(`[RefreshAlbumService] Album ${albumId} not found, skipping tracks`);
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

        const trackInsert = db.prepare(`
            INSERT INTO ProviderMedia (
                id, artist_id, album_id, title, version, release_date, type, explicit, quality,
                track_number, volume_number, duration, popularity,
                bpm, key, key_scale, peak, replay_gain,
                credits, copyright, isrc, monitored, last_scanned, downloaded
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
        `);

        const trackUpdate = db.prepare(`
            UPDATE ProviderMedia SET
                artist_id=?,
                title=?, version=?, release_date=?, explicit=?, quality=?,
                track_number=?, volume_number=?, duration=?, popularity=?,
                bpm=?, key=?, key_scale=?, peak=?, replay_gain=?,
                credits=?, copyright=?, last_scanned=CURRENT_TIMESTAMP
            WHERE id=? AND album_id=?
        `);

        const selectMedia = db.prepare("SELECT id, monitored, monitored_lock FROM ProviderMedia WHERE id = ? AND album_id = ?");
        const selectedRelease = db.prepare(`
            SELECT
                COALESCE(rgs.selected_release_mbid, pi.release_mbid, pa.mbid) AS release_mbid,
                COALESCE(rgs.release_group_mbid, pi.release_group_mbid, pa.mb_release_group_id) AS release_group_mbid,
                COALESCE(rgs.artist_mbid, pi.artist_mbid, artist.mbid) AS artist_mbid,
                COALESCE(rgs.slot, pi.library_slot, 'stereo') AS library_slot,
                COALESCE(rgs.quality, pi.quality, pa.quality) AS quality
            FROM ProviderAlbums pa
            LEFT JOIN ProviderItems pi
              ON pi.provider = ?
             AND pi.entity_type = 'album'
             AND pi.provider_id = CAST(pa.id AS TEXT)
            LEFT JOIN ReleaseGroupSlots rgs
              ON rgs.selected_provider = ?
             AND (
                rgs.selected_provider_id = CAST(pa.id AS TEXT)
                OR rgs.selected_provider_id LIKE CAST(pa.id AS TEXT) || ';%'
                OR rgs.selected_provider_id LIKE '%;' || CAST(pa.id AS TEXT) || ';%'
                OR rgs.selected_provider_id LIKE '%;' || CAST(pa.id AS TEXT)
             )
            LEFT JOIN Artists artist ON artist.id = pa.artist_id
            WHERE CAST(pa.id AS TEXT) = ?
            ORDER BY
              CASE WHEN rgs.selected_release_mbid IS NOT NULL THEN 0 ELSE 1 END,
              CASE rgs.slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END
            LIMIT 1
        `).get(providerId, providerId, albumId) as {
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
                provider, entity_type, provider_id, title, version, explicit, quality,
                isrc, duration, release_date, artist_mbid, release_group_mbid, release_mbid,
                track_mbid, recording_mbid, library_slot, track_id, recording_id,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'track', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
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
                        const currentTrackArtistId = String(album.artist_id);

                        const exists = selectMedia.get(currentTrack.provider_id, albumId) as any;

                        let shouldMonitor = exists?.monitored || (album?.monitored ? 1 : 0);
                        if (exists?.monitored_lock) {
                            shouldMonitor = exists.monitored;
                        }

                        if (!exists) {
                            trackInsert.run(
                                currentTrack.provider_id,
                                currentTrackArtistId,
                                albumId,
                                currentTrack.title,
                                currentTrack.version || null,
                                currentTrack.release_date || null,
                                album.type,
                                currentTrack.explicit ? 1 : 0,
                                currentTrack.quality,
                                currentTrack.track_number || 0,
                                currentTrack.volume_number || 1,
                                currentTrack.duration,
                                currentTrack.popularity || 0,
                                currentTrack.bpm || null,
                                currentTrack.key || null,
                                currentTrack.key_scale || null,
                                currentTrack.peak || null,
                                currentTrack.replay_gain || null,
                                null,
                                currentTrack.copyright || null,
                                currentTrack.isrc || null,
                                shouldMonitor,
                            );
                        } else {
                            trackUpdate.run(
                                currentTrackArtistId,
                                currentTrack.title,
                                currentTrack.version || null,
                                currentTrack.release_date || null,
                                currentTrack.explicit ? 1 : 0,
                                currentTrack.quality,
                                currentTrack.track_number || 0,
                                currentTrack.volume_number || 1,
                                currentTrack.duration,
                                currentTrack.popularity || 0,
                                currentTrack.bpm || null,
                                currentTrack.key || null,
                                currentTrack.key_scale || null,
                                currentTrack.peak || null,
                                currentTrack.replay_gain || null,
                                null,
                                currentTrack.copyright || null,
                                currentTrack.provider_id,
                                albumId,
                            );
                        }

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

                        this.storeTrackArtists(currentTrack, currentTrackArtistId, resolvedGuestsMap);
                    }
                })();
                trackBatch.length = 0;
                await cooperateTrackStore();
            }
        }

        if (options.resolveMusicBrainz !== false) {
            await MetadataIdentityService.resolveAlbumTracks(albumId, { force: false });
        }
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

        const exists = db.prepare("SELECT id, monitored, monitored_lock FROM ProviderAlbums WHERE id = ?").get(album.provider_id) as any;
        const shouldMonitor = exists?.monitored || 0;
        const moduleFromPage = albumModuleMap.get(album.provider_id) || album._module || null;

        if (!exists) {
            db.prepare(`
                INSERT INTO ProviderAlbums (
                    id, artist_id, title, version, release_date, type, explicit, quality,
                    cover, vibrant_color, video_cover,
                    num_tracks, num_volumes, num_videos, duration, popularity, copyright, upc,
                    mb_primary, mb_secondary, monitored
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                album.provider_id,
                primaryArtistId,
                album.title,
                album.version || null,
                album.release_date,
                album.type || "ALBUM",
                album.explicit ? 1 : 0,
                album.quality,
                album.cover,
                album.vibrant_color || null,
                album.video_cover || null,
                album.num_tracks || 0,
                album.num_volumes || 1,
                album.num_videos || 0,
                album.duration || 0,
                album.popularity || null,
                album.copyright || null,
                album.upc || null,
                this.getMusicBrainzPrimary(album.type, moduleFromPage, album.title),
                this.getMusicBrainzSecondary(album.type, moduleFromPage, album.title),
                shouldMonitor,
            );
        } else {
            const updateSql = forceUpdate
                ? `
                UPDATE ProviderAlbums SET
                    artist_id=?,
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=?, video_cover=?,
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `
                : `
                UPDATE ProviderAlbums SET
                    artist_id=COALESCE(?, artist_id),
                    title=?, version=?, release_date=?, type=?, explicit=?, quality=?,
                    cover=?, vibrant_color=COALESCE(?, vibrant_color), video_cover=COALESCE(?, video_cover),
                    num_tracks=?, num_volumes=?, num_videos=?, duration=?, popularity=?, copyright=?, upc=?,
                    mb_primary=?, mb_secondary=?, last_scanned=CURRENT_TIMESTAMP
                WHERE id=?
            `;

            db.prepare(updateSql).run(
                primaryArtistId ?? null,
                album.title,
                album.version || null,
                album.release_date,
                album.type || "ALBUM",
                album.explicit ? 1 : 0,
                album.quality,
                album.cover,
                album.vibrant_color || null,
                album.video_cover || null,
                album.num_tracks || 0,
                album.num_volumes || 1,
                album.num_videos || 0,
                album.duration || 0,
                album.popularity || null,
                album.copyright || null,
                album.upc || null,
                this.getMusicBrainzPrimary(album.type, moduleFromPage, album.title),
                this.getMusicBrainzSecondary(album.type, moduleFromPage, album.title),
                album.provider_id,
            );
        }

        const albumGroup = album._group_type || album._group || "ALBUMS";

        const upsertScannedRelation = db.prepare(`
            INSERT INTO ProviderAlbumArtists (album_id, artist_id, artist_name, ord, type, group_type, module)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artist_id, album_id) DO UPDATE SET
                artist_name = COALESCE(excluded.artist_name, ProviderAlbumArtists.artist_name),
                ord = COALESCE(excluded.ord, ProviderAlbumArtists.ord),
                type = excluded.type,
                group_type = excluded.group_type,
                module = excluded.module
        `);

        const upsertRelatedRelation = db.prepare(`
            INSERT INTO ProviderAlbumArtists (album_id, artist_id, artist_name, ord, type, group_type, module)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artist_id, album_id) DO UPDATE SET
                artist_name = COALESCE(excluded.artist_name, ProviderAlbumArtists.artist_name),
                ord = COALESCE(excluded.ord, ProviderAlbumArtists.ord),
                type = excluded.type,
                group_type = COALESCE(ProviderAlbumArtists.group_type, excluded.group_type),
                module = COALESCE(ProviderAlbumArtists.module, excluded.module)
        `);

        const participants = new Map<string, { name: string | null; ord: number | null }>();
        const setParticipant = (participantArtistId: string, name: string | null, ord: number | null) => {
            if (!participantArtistId) return;
            const key = String(participantArtistId);
            if (!participants.has(key)) {
                participants.set(key, { name, ord });
                return;
            }

            const current = participants.get(key)!;
            participants.set(key, {
                name: current.name || name,
                ord: current.ord ?? ord,
            });
        };

        setParticipant(scanningArtistId, scanningArtistId === primaryArtistId ? album.artist_name || null : null, 0);
        setParticipant(primaryArtistId, album.artist_name || null, 0);

        const scanningType = primaryArtistId === scanningArtistId ? "MAIN" : "APPEARS_ON";
        const scanningParticipant = participants.get(String(scanningArtistId));
        upsertScannedRelation.run(
            album.provider_id,
            scanningArtistId,
            scanningParticipant?.name || null,
            scanningParticipant?.ord ?? null,
            scanningType,
            albumGroup,
            moduleFromPage,
        );

        if (primaryArtistId && primaryArtistId !== scanningArtistId) {
            const primaryParticipant = participants.get(String(primaryArtistId));
            upsertRelatedRelation.run(
                album.provider_id,
                primaryArtistId,
                primaryParticipant?.name || album.artist_name || null,
                primaryParticipant?.ord ?? 0,
                "MAIN",
                null,
                null,
            );
        }

        const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(releaseGroupMatch);

        if (matchedReleaseGroup) {
            db.prepare(`
                UPDATE ProviderAlbums SET
                    mbid = COALESCE(?, mbid),
                    mb_release_group_id = ?,
                    mb_primary = COALESCE(?, mb_primary),
                    mb_secondary = COALESCE(?, mb_secondary),
                    musicbrainz_status = CASE
                        WHEN mbid IS NOT NULL AND musicbrainz_status = 'verified' THEN musicbrainz_status
                        ELSE COALESCE(?, musicbrainz_status)
                    END,
                    musicbrainz_last_checked = CURRENT_TIMESTAMP,
                    musicbrainz_match_method = ?
                WHERE id = ?
            `).run(
                matchedReleaseMbid,
                matchedReleaseGroup.mbid,
                primaryTypeFromProviderMatch(releaseGroupMatch),
                secondaryTypeFromProviderMatch(releaseGroupMatch),
                getAlbumIdentityStatusFromProviderMatch(releaseGroupMatch),
                releaseGroupMatch?.method || "musicbrainz-release-group-title-year-type",
                album.provider_id,
            );
        }

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

        this.storeCanonicalAlbumSupplements({
            releaseGroupMbid: matchedReleaseGroup?.mbid || null,
            releaseMbid: matchedReleaseMbid,
            album,
        });

        if (options.resolveMusicBrainz === false) {
            db.prepare(`
                UPDATE ProviderAlbums
                SET musicbrainz_status = COALESCE(musicbrainz_status, 'pending')
                WHERE id = ?
                  AND mbid IS NULL
                  AND mb_release_group_id IS NULL
            `).run(album.provider_id);
        } else {
            await MetadataIdentityService.resolveAlbum(String(album.provider_id), {
                force: forceUpdate,
                includeTracks: false,
            });
        }

        return !exists;
    }

    private static async storeSimilarAlbums(
        albumId: string,
        forceUpdate: boolean = false,
    ): Promise<SimilarAlbumSeed[]> {
        void albumId;
        void forceUpdate;
        return [];
    }

    private static storeTrackArtists(track: any, canonicalArtistId: string, resolvedGuestsMap?: Map<string, string>): void {
        const mediaId = track?.provider_id?.toString?.() ?? String(track?.provider_id ?? "");
        if (!mediaId) return;

        db.prepare("DELETE FROM ProviderMediaArtists WHERE media_id = ?").run(mediaId);

        const insertMediaArtist = db.prepare(`
            INSERT OR IGNORE INTO ProviderMediaArtists (media_id, artist_id, type) VALUES (?, ?, ?)
        `);

        insertMediaArtist.run(mediaId, canonicalArtistId, "MAIN");

        if (resolvedGuestsMap && Array.isArray(track.artists)) {
            const storedArtistIds = new Set([canonicalArtistId]);
            for (const a of track.artists) {
                if (a.id && a.id !== track.artist_id) {
                    const guestMbid = resolvedGuestsMap.get(a.id);
                    if (guestMbid && !storedArtistIds.has(guestMbid)) {
                        insertMediaArtist.run(mediaId, guestMbid, "CONTRIBUTOR");
                        storedArtistIds.add(guestMbid);
                    }
                }
            }
        }
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
