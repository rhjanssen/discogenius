import { db, withSqliteWriteGate } from "../../database.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";
import { AlbumRefreshLevel, type RefreshOptions } from "./scan-types.js";
import { shouldRefreshAlbum as shouldRefreshAlbumPolicy, shouldRefreshTrackSet } from "../config/refresh-policy.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import type { ProviderReleaseGroupMatch } from "../metadata/provider-release-group-matcher.js";
import { streamingProviderManager } from "../providers/index.js";
import type { ProviderAlbum, ProviderTrack } from "../providers/streaming-provider.js";
import { ProviderArtistIdentityService, type ProviderArtistIdentityInput } from "../metadata/provider-artist-identity-service.js";
import { ProviderOfferReleaseLinkService } from "../metadata/provider-offer-release-link-service.js";
import { ArtistTopTrackService } from "./artist-top-track-service.js";
import {
    firstProviderEditorialText,
    listReleaseGroupAlbumOfferCandidates,
} from "../providers/provider-editorial-text.js";
import {
    matchPlaylistTracksToCanonical,
    PLAYLIST_TRACKLIST_COVERAGE_METHOD,
} from "../providers/soundcloud/soundcloud-playlist-match.js";
import {
    isSoundCloudTrackKnownUndownloadable,
} from "../providers/soundcloud/soundcloud-downloadability.js";
import {
    ProviderCatalogRepository,
    type ProviderAudioVariantInput,
} from "../providers/provider-catalog-repository.js";
import {
    ProviderReleaseIngestionService,
    type ProviderArtistCreditFacts,
} from "../providers/provider-release-ingestion-service.js";
import { RefreshVideoService } from "./refresh-video-service.js";

const MUSICBRAINZ_MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAME_RELEASE_SUPERSET_TRACKLIST_METHOD = "same-release-superset-track-coverage";

function isMusicBrainzMbid(value: string | number | null | undefined): boolean {
    return MUSICBRAINZ_MBID_RE.test(String(value || "").trim());
}

export function providerAlbumToAlbumMetadataRow(providerAlbum: ProviderAlbum): any {
    const raw = providerAlbum.raw;
    if (raw && typeof raw === "object" && "provider_id" in raw) {
        return {
            ...raw,
            // Always prefer the typed ProviderAlbum field — list/raw payloads often
            // omit or rename animated-cover ids.
            video_cover: providerAlbum.videoCover
                || (raw as any).video_cover
                || (raw as any).videoCover
                || null,
            videoCover: providerAlbum.videoCover
                || (raw as any).videoCover
                || (raw as any).video_cover
                || null,
            explicit: providerAlbum.explicit ?? (raw as any).explicit ?? null,
            qualityTags: Array.isArray(providerAlbum.qualityTags)
                ? providerAlbum.qualityTags
                : (Array.isArray((raw as any).qualityTags) ? (raw as any).qualityTags : (raw as any).quality_tags),
        };
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
        video_cover: providerAlbum.videoCover || null,
        videoCover: providerAlbum.videoCover || null,
        num_tracks: providerAlbum.trackCount || 0,
        num_videos: 0,
        num_volumes: providerAlbum.volumeCount || 1,
        duration: providerAlbum.duration || 0,
        type: providerAlbum.type || "ALBUM",
        version: providerAlbum.version || null,
        explicit: providerAlbum.explicit ?? null,
        quality: providerAlbum.quality || "LOSSLESS",
        qualityTags: Array.isArray(providerAlbum.qualityTags) ? providerAlbum.qualityTags : undefined,
        url: providerAlbum.url,
        popularity: providerAlbum.popularity ?? 0,
        copyright: providerAlbum.copyright || null,
        upc: providerAlbum.upc || null,
    };
}

export function providerTrackToTrackMetadataRow(providerTrack: ProviderTrack): any {
    const raw = providerTrack.raw;
    const rawRow = raw && typeof raw === "object" ? raw as Record<string, any> : {};

    return {
        ...rawRow,
        provider_id: providerTrack.providerId,
        title: providerTrack.title,
        duration: providerTrack.duration || 0,
        track_number: providerTrack.trackNumber || 0,
        volume_number: providerTrack.volumeNumber || 1,
        version: null,
        isrc: providerTrack.isrc || null,
        // Was hardcoded false, which also overrode the raw payload spread above.
        // Every provider track therefore stored explicit=0, so acquisition plans
        // computed explicitContent="clean" even for an explicit release and the
        // prefer-explicit preference had nothing to act on.
        explicit: providerTrack.explicit ?? rawRow.explicit ?? null,
        quality: providerTrack.quality || "LOSSLESS",
        // Provider-native fidelity tags (e.g. Apple audioTraits: dolby-atmos,
        // lossless). storeProviderTrackOffers maps these into
        // ProviderItemAudioVariants — dropping them left every Apple track as
        // stereo-only even when the live song payload advertised Atmos.
        qualityTags: Array.isArray(providerTrack.qualityTags)
            ? providerTrack.qualityTags
            : (Array.isArray(rawRow.qualityTags) ? rawRow.qualityTags : undefined),
        copyright: providerTrack.copyright || null,
        replay_gain: providerTrack.replayGain ?? rawRow.replay_gain ?? rawRow.replayGain ?? null,
        peak: providerTrack.peak ?? rawRow.peak ?? null,
        bpm: rawRow.bpm ?? null,
        musical_key: rawRow.musical_key ?? rawRow.musicalKey ?? null,
        artist_id: providerTrack.artist?.providerId || null,
        artist_name: providerTrack.artist?.name || "Unknown Artist",
        artists: Array.isArray(providerTrack.artists)
            ? providerTrack.artists.map(a => ({ id: a.providerId, name: a.name }))
            : (providerTrack.artist ? [{ id: providerTrack.artist.providerId, name: providerTrack.artist.name }] : []),
        url: providerTrack.url,
        popularity: providerTrack.popularity ?? rawRow.popularity ?? 0,
        release_date: providerTrack.releaseDate || null,
        // Album-bundled music videos (Apple deluxe/festival editions) keep
        // their tracklist position but flow through the video import path.
        is_video: providerTrack.isVideo ? 1 : 0,
        // YouTube Music ATV→OMV counterpart (persisted as album-scoped video offer).
        counterpart_video_id: providerTrack.counterpartVideoId || null,
    };
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

function providerCredits(value: unknown): ProviderArtistCreditFacts[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const credits: ProviderArtistCreditFacts[] = [];
    value.forEach((artist, ordinal) => {
        const providerId = textOrNull(artist?.providerId, artist?.provider_id, artist?.id);
        const name = textOrNull(artist?.name);
        if (!providerId || !name) return;
        credits.push({
            providerId,
            name,
            ordinal,
            joinPhrase: textOrNull(artist?.joinPhrase, artist?.join_phrase) || "",
            normalizedRole: "other",
            providerRole: textOrNull(artist?.role),
        });
    });
    return credits.length > 0 ? credits : undefined;
}

export function providerAudioVariants(
    providerId: string,
    rawValues: Iterable<unknown>,
): ProviderAudioVariantInput[] {
    const tags = [...rawValues].map((value) => textOrNull(value)).filter((value): value is string => Boolean(value));
    if (tags.length === 0) return [];
    let mapping;
    try {
        mapping = streamingProviderManager.getStreamingProvider(providerId).qualityMapping;
    } catch {
        return [];
    }
    const neutral = mapping?.toNeutral(tags);
    if (!mapping || !neutral) return [];

    // `provider_quality_label` is the provider's own word for THIS variant, and
    // badges render it directly. Joining every tag a release advertises turned
    // one Apple album into the label "dolby-atmos,lossless,lossy-stereo,LOSSLESS"
    // — which is not a quality anything can display, so the queue fell back to a
    // generic chip on exactly the Atmos downloads that most needed the badge.
    // Attribute each variant to the single tag that produced it; when no tag
    // can be attributed, say nothing and let the neutral class speak.
    //
    // Searched last-first: callers pass the provider's own tag array followed by
    // its canonical quality string, so the last match is the badge-worthy token
    // ("YOUTUBE_LOSSY", "FLAC", "LOSSLESS") rather than an internal trait like
    // "opus" or "lossy-stereo" that happens to appear first.
    const labelFor = (matches: (tag: string) => boolean): string | null => {
        for (let index = tags.length - 1; index >= 0; index -= 1) {
            if (matches(tags[index])) return tags[index];
        }
        return null;
    };

    const variants: ProviderAudioVariantInput[] = [];
    if (neutral.audio) {
        variants.push({
            variantKey: `stereo:${neutral.audio}`,
            qualityClass: neutral.audio,
            lossless: neutral.audio !== "lossy",
            providerQualityLabel: labelFor((tag) => mapping.toNeutralAudio(tag) === neutral.audio),
            availability: "available",
        });
    }
    for (const spatial of neutral.spatial || []) {
        variants.push({
            variantKey: `spatial:${spatial}`,
            qualityClass: "spatial",
            spatialFormat: spatial,
            providerQualityLabel: labelFor((tag) => (mapping.toNeutral([tag]).spatial || []).includes(spatial)),
            availability: "available",
        });
    }
    return variants;
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
            SELECT
              CASE
                WHEN COUNT(DISTINCT release_group.id) = 1
                THEN MAX(release_group.mbid)
              END AS release_group_mbid,
              CASE
                WHEN COUNT(DISTINCT release.id) = 1
                THEN MAX(release.mbid)
              END AS release_mbid
            FROM ProviderItems item
            JOIN ProviderEditionMatches match
              ON match.provider_edition_item_id = item.id
             AND match.match_state = 'accepted'
            JOIN AlbumEditions release ON release.id = match.edition_id
            JOIN Albums release_group ON release_group.id = release.release_group_id
            WHERE item.provider = ?
              AND item.entity_type = 'release'
              AND item.provider_id = ?
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
                    popularity = MAX(COALESCE(popularity, 0), COALESCE(?, 0)),
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
                UPDATE AlbumEditions SET
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
            WHERE id IN (
                SELECT DISTINCT match.recording_id
                FROM ProviderItems item
                JOIN ProviderEditionMembers member ON member.member_item_id = item.id
                JOIN ProviderTrackMatches match
                  ON match.provider_edition_member_id = member.id
                 AND match.match_state = 'accepted'
                WHERE item.provider = ?
                  AND item.entity_type = 'track'
                  AND item.provider_id = ?
            )
        `).run(serializedCredits, providerId, trackProviderId);
    }

    private static resolveProviderForAlbum(albumId: string, requestedProviderId?: string | null): any {
        const normalizedProviderId = String(requestedProviderId || "").trim();
        if (normalizedProviderId) {
            return streamingProviderManager.getStreamingProvider(normalizedProviderId);
        }
        // A bare provider resource id cannot identify its provider. Callers
        // without an explicit provider intentionally address the configured
        // default provider; never infer one from a colliding ProviderItems row.
        return streamingProviderManager.getDefaultStreamingProvider();
    }
    private static getArtistMbidForReleaseGroup(releaseGroupMbid?: string | null): string | null {
        if (!releaseGroupMbid) {
            return null;
        }

        const row = db.prepare(`
            SELECT artist.mbid
            FROM Albums release_group
            LEFT JOIN ReleaseGroupArtistCredits credit
              ON credit.release_group_id = release_group.id AND credit.ordinal = 0
            JOIN ArtistMetadata artist
              ON artist.id = COALESCE(credit.artist_id, release_group.artist_metadata_id)
            WHERE release_group.mbid = ?
        `).get(releaseGroupMbid) as { mbid?: string | null } | undefined;
        return row?.mbid ? String(row.mbid) : null;
    }

    private static async ensureMusicBrainzArtist(artistMbid: string, monitorArtist = false): Promise<string> {
        const { RefreshArtistService } = await import("./refresh-artist-service.js");
        return RefreshArtistService.upsertMusicBrainzArtist(artistMbid, {
            monitorArtist,
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

        const canonicalLink = this.getCanonicalAlbumLink(providerId, albumId);
        const providerItemArtistMbid = this.getArtistMbidForReleaseGroup(canonicalLink.releaseGroupMbid);
        if (providerItemArtistMbid) {
            return this.ensureMusicBrainzArtist(providerItemArtistMbid, false);
        }

        const providerArtistId = albumData?.artist_id != null ? String(albumData.artist_id) : "";
        const providerArtistName = String(albumData?.artist_name || "").trim();
        if (!providerArtistId || !providerArtistName) {
            return null;
        }

        const cachedProviderArtist = db.prepare(`
            SELECT CASE
              WHEN COUNT(DISTINCT artist.id) = 1
              THEN MAX(artist.mbid)
            END AS mbid
            FROM ProviderItems item
            JOIN ProviderArtistMatches match
              ON match.provider_artist_item_id = item.id
             AND match.match_state = 'accepted'
            JOIN ArtistMetadata artist ON artist.id = match.artist_id
            WHERE item.provider = ?
              AND item.entity_type = 'artist'
              AND item.provider_id = ?
        `).get(providerId, providerArtistId) as { mbid?: string | null } | undefined;
        if (cachedProviderArtist?.mbid) {
            return this.ensureMusicBrainzArtist(cachedProviderArtist.mbid, false);
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

    static getRefreshLevel(albumId: string, requestedProviderId?: string | null): AlbumRefreshLevel {
        // Refresh state is read from the canonical graph + the album's ProviderItems
        // offer now: offer exists = OFFER, review + tracks = METADATA, and
        // per-track credits homed onto Recordings = DETAILS.
        const provider = this.resolveProviderForAlbum(albumId, requestedProviderId);
        const offer = db.prepare(`
            SELECT id
            FROM ProviderItems
            WHERE provider = ?
              AND entity_type = 'release'
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            LIMIT 1
        `).get(provider.id, albumId) as { id: number } | undefined;

        if (!offer) {
            return AlbumRefreshLevel.NONE;
        }
        const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);

        const hasCredits = canonicalLink.releaseMbid
            ? db.prepare(`
                SELECT 1 FROM Tracks t
                JOIN Recordings r ON r.id = t.recording_id
                JOIN AlbumEditions release ON release.id = t.album_edition_id
                WHERE release.mbid = ? AND r.credits IS NOT NULL
                LIMIT 1
            `).get(canonicalLink.releaseMbid)
            : null;
        if (hasCredits) {
            return AlbumRefreshLevel.DETAILS;
        }

        const reviewText = canonicalLink.releaseGroupMbid
            ? (db.prepare("SELECT review_text FROM Albums WHERE mbid = ?").get(canonicalLink.releaseGroupMbid) as { review_text?: string | null } | undefined)?.review_text
            : null;
        const trackCount = Number((db.prepare(`
            SELECT COUNT(*) AS c
            FROM ProviderEditionMembers
            WHERE provider_edition_item_id = ?
        `).get(offer.id) as { c?: number } | undefined)?.c || 0);
        if (reviewText !== null && reviewText !== undefined && trackCount > 0) {
            return AlbumRefreshLevel.METADATA;
        }

        return AlbumRefreshLevel.OFFER;
    }

    static async refreshOffer(
        albumId: string,
        artistId?: string,
        moduleOverride?: string | null,
        options: RefreshOptions = {},
    ): Promise<void> {
        console.log(`[RefreshAlbumService] refreshOffer for ${albumId}`);
        const provider = this.resolveProviderForAlbum(albumId, options.provider);

        // Freshness is the album offer's updated_at (the offer is the provider
        // catalog now); the canonical link comes from release_(group_)mbid on it.
        const existingRow = db.prepare(`
            SELECT
                release.mbid,
                album.mbid AS mb_release_group_id,
                pi.updated_at AS last_scanned,
                COALESCE(release.date, album.first_release_date, pi.release_date) AS album_release_date
            FROM ProviderItems pi
            LEFT JOIN ProviderEditionMatches match
              ON match.id = (
                SELECT preferred.id
                FROM ProviderEditionMatches preferred
                WHERE preferred.provider_edition_item_id = pi.id
                  AND preferred.match_state = 'accepted'
                ORDER BY
                  CASE preferred.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
                  preferred.confidence DESC,
                  preferred.id
                LIMIT 1
              )
            LEFT JOIN AlbumEditions release ON release.id = match.edition_id
            LEFT JOIN Albums album ON album.id = release.release_group_id
            WHERE pi.provider = ?
              AND pi.entity_type = 'release'
              AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY pi.updated_at DESC
            LIMIT 1
        `).get(provider.id, albumId) as any;
        const shouldRefreshAlbum =
            !existingRow ||
            options.forceUpdate === true ||
            shouldRefreshAlbumPolicy({
                albumReleaseDate: existingRow?.album_release_date,
                lastScanned: existingRow?.last_scanned,
            });

        if (existingRow && !shouldRefreshAlbum) {
            if (!existingRow.mbid || !existingRow.mb_release_group_id || options.forceUpdate === true) {
                await MetadataIdentityService.resolveAlbum(albumId, {
                    force: options.forceUpdate === true,
                    provider: provider.id,
                });
            }
            console.log(`[RefreshAlbumService] refreshOffer skipped for ${albumId} (fresh)`);
            return;
        }

        const albumData = providerAlbumToAlbumMetadataRow(await provider.getAlbum(albumId));
        const forceUpdate = options.forceUpdate === true;
        void moduleOverride;

        const primaryArtistId = await this.resolveCanonicalArtistForProviderAlbum(provider.id, albumId, albumData, artistId);
        if (!primaryArtistId) {
            throw new Error(`provider album ${albumId} could not be linked to a MusicBrainz artist. Refresh/curate the artist before hydrating provider tracks.`);
        }

        await this.upsertArtistAlbum(albumData, primaryArtistId, new Map(), {
            ...options,
            provider: provider.id,
            resolveMusicBrainz: false,
        });
        await MetadataIdentityService.resolveAlbum(albumId, { force: forceUpdate, provider: provider.id });
        const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
        this.storeCanonicalAlbumSupplements({
            releaseGroupMbid: canonicalLink.releaseGroupMbid,
            releaseMbid: canonicalLink.releaseMbid,
            album: albumData,
        });
        // Advance the offer freshness so adaptive refresh policy sees this scan.
        db.prepare(`
            UPDATE ProviderItems SET updated_at = CURRENT_TIMESTAMP
            WHERE provider = ?
              AND entity_type = 'release'
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        `).run(provider.id, albumId);

        console.log(`[RefreshAlbumService] refreshOffer complete for ${albumId}`);
    }

    static async refreshMetadata(albumId: string, options: RefreshOptions = {}): Promise<void> {
        console.log(`[RefreshAlbumService] refreshMetadata for ${albumId}`);
        const provider = this.resolveProviderForAlbum(albumId, options.provider);

        const existing = db.prepare(`
            SELECT
                a.review_text AS review_text,
                pi.updated_at AS last_scanned,
                COALESCE(release.date, a.first_release_date, pi.release_date) AS album_release_date
            FROM ProviderItems pi
            LEFT JOIN ProviderEditionMatches match
              ON match.id = (
                SELECT preferred.id
                FROM ProviderEditionMatches preferred
                WHERE preferred.provider_edition_item_id = pi.id
                  AND preferred.match_state = 'accepted'
                ORDER BY
                  CASE preferred.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
                  preferred.confidence DESC,
                  preferred.id
                LIMIT 1
              )
            LEFT JOIN AlbumEditions release ON release.id = match.edition_id
            LEFT JOIN Albums a ON a.id = release.release_group_id
            WHERE pi.provider = ?
              AND pi.entity_type = 'release'
              AND CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY pi.updated_at DESC
            LIMIT 1
        `).get(provider.id, albumId) as any;
        const shouldRefreshAlbumMeta =
            options.forceUpdate === true ||
            !existing ||
            shouldRefreshAlbumPolicy({
                albumReleaseDate: existing?.album_release_date,
                lastScanned: existing?.last_scanned,
            });

        if (shouldRefreshAlbumMeta) {
            await this.refreshOffer(albumId, undefined, undefined, { ...options, provider: provider.id });
        } else {
            console.log(`[RefreshAlbumService] Skipping album metadata refresh for ${albumId} (fresh)`);
        }

        const shouldRefreshTrackList =
            options.forceUpdate === true ||
            shouldRefreshTrackSet({
                albumId,
                fallbackLastScanned: existing?.last_scanned,
                provider: provider.id,
            });
        if (shouldRefreshTrackList) {
            await this.refreshTracks(albumId, { provider: provider.id });
        } else {
            console.log(`[RefreshAlbumService] Skipping track refresh for album ${albumId} (fresh)`);
        }

        const shouldRefreshReview =
            options.forceUpdate === true ||
            existing?.review_text == null ||
            String(existing?.review_text || "").trim() === "" ||
            shouldRefreshAlbumMeta;

        if (shouldRefreshReview) {
            try {
                const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
                const releaseGroupMbid = canonicalLink.releaseGroupMbid;
                const candidates = releaseGroupMbid
                    ? listReleaseGroupAlbumOfferCandidates(releaseGroupMbid)
                    : [{ provider: provider.id, providerId: String(albumId) }];

                // Always include the album currently being refreshed.
                candidates.unshift({ provider: provider.id, providerId: String(albumId) });

                const editorial = await firstProviderEditorialText({
                    kind: "albumReview",
                    candidates,
                });

                if (editorial) {
                    this.storeCanonicalAlbumReview({
                        releaseGroupMbid,
                        reviewText: editorial.text,
                        reviewSource: editorial.source,
                        reviewLastUpdated: new Date().toISOString(),
                    });
                } else if (!String(existing?.review_text || "").trim()) {
                    console.log(`[RefreshAlbumService] No provider review found for album ${albumId}`);
                }
            } catch (error) {
                console.warn(`[RefreshAlbumService] Failed to fetch review for album ${albumId}:`, error);
            }
        } else {
            console.log(`[RefreshAlbumService] Skipping review refresh for album ${albumId} (fresh)`);
        }

        const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
        if (canonicalLink.releaseGroupMbid) {
            ArtistTopTrackService.rebuildForReleaseGroup(canonicalLink.releaseGroupMbid);
        }

        console.log(`[RefreshAlbumService] refreshMetadata complete for ${albumId}`);
    }

    static async refreshDetails(albumId: string, options: RefreshOptions = {}): Promise<void> {
        console.log(`[RefreshAlbumService] refreshDetails for ${albumId}`);
        const provider = this.resolveProviderForAlbum(albumId, options.provider);

        const currentLevel = this.getRefreshLevel(albumId, provider.id);
        if (options.forceUpdate || currentLevel < AlbumRefreshLevel.METADATA) {
            console.log(`[RefreshAlbumService] Album ${albumId} refreshing metadata (force=${options.forceUpdate === true})`);
            await this.refreshMetadata(albumId, { ...options, provider: provider.id });
        }

        // Album-level credits had no canonical home and nothing reads them; only
        // per-track credits are kept (homed onto the canonical Recordings below).
        try {
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

        // Advance offer freshness for this detail refresh.
        db.prepare(`
            UPDATE ProviderItems SET updated_at = CURRENT_TIMESTAMP
            WHERE provider = ?
              AND entity_type = 'release'
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
        `).run(provider.id, albumId);

        console.log(`[RefreshAlbumService] refreshDetails complete for ${albumId}`);
    }

    static async refreshTracks(
        albumId: string,
        options: Pick<RefreshOptions, "resolveMusicBrainz" | "provider"> = {},
    ): Promise<void> {
        void options.resolveMusicBrainz;
        const provider = this.resolveProviderForAlbum(albumId, options.provider);
        const tracks = (await provider.getAlbumTracks(albumId))
            .map(providerTrackToTrackMetadataRow);
        console.log(`[RefreshAlbumService] Fetched ${tracks.length} tracks for album ${albumId}`);
        const canonicalLink = this.getCanonicalAlbumLink(provider.id, albumId);
        await this.storeProviderTrackOffers(
            provider.id,
            albumId,
            tracks,
            null,
            canonicalLink.releaseMbid,
        );
    }

    /**
     * Re-run track matching for a provider release from rows already stored,
     * without contacting the provider.
     *
     * Refresh reuses materialized track offers instead of re-fetching a
     * tracklist it already has, which is right for provider traffic but meant
     * matching only ever ran the first time an album was seen. A matcher fix
     * could then never reach an existing catalog: Bastille's reprise stayed
     * unmatched through repeated forced refreshes because the album was already
     * materialized, so the improved matcher was never asked about it.
     *
     * Item facts and audio variants are deliberately left alone — this replays
     * the *decision*, not the data. Credits and variants are omitted from the
     * ingest input so their existing rows survive untouched.
     */
    static async rematchStoredProviderRelease(
        providerId: string,
        albumId: string,
        canonicalReleaseMbid?: string | null,
    ): Promise<{ acceptedTrackCount: number; ambiguousTrackCount: number } | null> {
        // Mirror storeProviderTrackOffers: when the release-group matcher does not
        // name a release this pass, the edition this provider release is already
        // accepted against is the canonical target. Requiring a freshly selected
        // MBID would silently skip exactly the established releases that most need
        // re-matching.
        const canonicalRelease = (canonicalReleaseMbid
            ? db.prepare(`
                SELECT id FROM AlbumEditions WHERE mbid = ? LIMIT 1
              `).get(canonicalReleaseMbid)
            : db.prepare(`
                SELECT edition.id
                FROM ProviderItems item
                JOIN ProviderEditionMatches match
                  ON match.provider_edition_item_id = item.id
                 AND match.match_state = 'accepted'
                JOIN AlbumEditions edition ON edition.id = match.edition_id
                WHERE item.provider = ?
                  AND item.entity_type = 'release'
                  AND item.provider_id = ?
                ORDER BY
                  CASE match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
                  match.confidence DESC,
                  match.id
                LIMIT 1
              `).get(providerId, albumId)) as { id: number } | undefined;
        if (!canonicalRelease) return null;

        const releaseRow = db.prepare(`
            SELECT
              id, title, version, provider_type, upc, duration_ms, release_date,
              explicit, availability, checked_at, provider_url, cover_id,
              artwork_url, volume_count, copyright
            FROM ProviderItems
            WHERE provider = ? AND entity_type = 'release' AND provider_id = ?
            LIMIT 1
        `).get(providerId, albumId) as Record<string, any> | undefined;
        if (!releaseRow) return null;

        const memberRows = db.prepare(`
            SELECT
              member.medium_position, member.position, member.number,
              member.contextual_title, member.contextual_duration_ms,
              item.entity_type, item.provider_id, item.title, item.version,
              item.isrc, item.duration_ms, item.release_date, item.explicit,
              item.availability, item.provider_url, item.cover_id, item.artwork_url,
              item.replay_gain, item.peak, item.bpm, item.musical_key, item.copyright
            FROM ProviderEditionMembers member
            JOIN ProviderItems item ON item.id = member.member_item_id
            WHERE member.provider_edition_item_id = ?
            ORDER BY member.medium_position, member.position, member.id
        `).all(releaseRow.id) as Array<Record<string, any>>;
        if (memberRows.length === 0) return null;

        return withSqliteWriteGate(() => {
        const ingested = new ProviderReleaseIngestionService(db).ingest({
            canonicalReleaseId: canonicalRelease.id,
            matcherVersion: PROVIDER_TRACK_MATCHER_VERSION,
            release: {
                provider: providerId,
                entityType: "release",
                providerId: String(albumId),
                title: textOrNull(releaseRow.title),
                version: textOrNull(releaseRow.version),
                providerType: textOrNull(releaseRow.provider_type),
                upc: textOrNull(releaseRow.upc),
                durationMs: positiveNumberOrNull(releaseRow.duration_ms),
                releaseDate: textOrNull(releaseRow.release_date),
                explicit: releaseRow.explicit == null ? null : Boolean(releaseRow.explicit),
                availability: textOrNull(releaseRow.availability) || "available",
                checkedAt: textOrNull(releaseRow.checked_at) || new Date().toISOString(),
                providerUrl: textOrNull(releaseRow.provider_url),
                coverId: textOrNull(releaseRow.cover_id),
                artworkUrl: textOrNull(releaseRow.artwork_url),
                volumeCount: positiveNumberOrNull(releaseRow.volume_count),
                copyright: textOrNull(releaseRow.copyright),
            },
            members: memberRows.map((row) => ({
                item: {
                    provider: providerId,
                    entityType: row.entity_type === "video" ? "video" as const : "track" as const,
                    providerId: String(row.provider_id),
                    title: textOrNull(row.title),
                    version: textOrNull(row.version),
                    isrc: textOrNull(row.isrc),
                    durationMs: positiveNumberOrNull(row.duration_ms),
                    releaseDate: textOrNull(row.release_date),
                    explicit: row.explicit == null ? null : Boolean(row.explicit),
                    availability: textOrNull(row.availability) || "available",
                    providerUrl: textOrNull(row.provider_url),
                    coverId: textOrNull(row.cover_id),
                    artworkUrl: textOrNull(row.artwork_url),
                    replayGain: finiteNumberOrNull(row.replay_gain),
                    peak: finiteNumberOrNull(row.peak),
                    bpm: finiteNumberOrNull(row.bpm),
                    musicalKey: textOrNull(row.musical_key),
                    copyright: textOrNull(row.copyright),
                },
                mediumPosition: Number(row.medium_position || 1),
                position: Number(row.position || 0),
                number: textOrNull(row.number),
                contextualTitle: textOrNull(row.contextual_title),
                contextualDurationMs: positiveNumberOrNull(row.contextual_duration_ms),
            })),
        });
        // A provider release can be matched to several canonical Editions, and
        // this replay re-derives the best one — so anything still carrying an
        // older verdict is a decision the current matcher declined to make.
        // Retiring it is what makes the replay converge; otherwise a re-target
        // silently leaves the old Edition match behind, still asserting a match
        // the matcher would now refuse.
        const retired = new ProviderReleaseIngestionService(db)
            .retireStaleTrackMatches(releaseRow.id, PROVIDER_TRACK_MATCHER_VERSION);
        if (retired > 0) {
            console.log(
                `[RefreshAlbumService] Retired ${retired} track match(es) for ${providerId}:${albumId} `
                + `that matcher version ${PROVIDER_TRACK_MATCHER_VERSION} did not reproduce`,
            );
        }
        return {
            acceptedTrackCount: ingested.acceptedTrackCount,
            ambiguousTrackCount: ingested.ambiguousTrackCount,
        };
        }, `rematch-stored-release:${providerId}:${albumId}`);
    }

    /**
     * Persist provider-native release membership and, when a canonical release
     * is known, publish typed release/track matches through the shared matcher.
     */

    /**
     * SoundCloud DRM/SNIP/BLOCK tracks are not Discogenius download sources.
     * Drop them before ProviderEditionMembers / ProviderTrackMatches so they
     * cannot appear in acquisition plans. Unhydrated stubs stay (unknown).
     */
    static filterSoundCloudDownloadableTrackOffers<T>(tracks: T[]): T[] {
        return tracks.filter((track) => !isSoundCloudTrackKnownUndownloadable(track as any));
    }

    /**
     * Mark a SoundCloud release (and its members) unavailable and reject
     * automatic edition matches so planners drop the offer.
     */
    static markSoundCloudReleaseUndownloadable(
        albumId: string,
        reason: "drm-only" | "empty" = "drm-only",
    ): void {
        db.transaction(() => {
            const releaseItem = db.prepare(`
                SELECT id
                FROM ProviderItems
                WHERE provider = 'soundcloud'
                  AND entity_type = 'release'
                  AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
                LIMIT 1
            `).get(albumId) as { id: number } | undefined;
            if (!releaseItem) return;

            db.prepare(`
                UPDATE ProviderItems
                SET availability = 'unavailable',
                    availability_reason = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(reason, releaseItem.id);

            db.prepare(`
                UPDATE ProviderItems
                SET availability = 'unavailable',
                    availability_reason = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN (
                  SELECT member_item_id
                  FROM ProviderEditionMembers
                  WHERE provider_edition_item_id = ?
                )
            `).run(reason, releaseItem.id);

            db.prepare(`
                UPDATE ProviderEditionMatches
                SET match_state = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE provider_edition_item_id = ?
                  AND decision_source != 'manual'
            `).run(releaseItem.id);

            db.prepare(`
                UPDATE ProviderTrackMatches
                SET match_state = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE provider_edition_match_id IN (
                  SELECT id FROM ProviderEditionMatches
                  WHERE provider_edition_item_id = ?
                )
                  AND decision_source != 'manual'
            `).run(releaseItem.id);
        })();
    }

    static async storeProviderTrackOffers(
        providerId: string,
        albumId: string,
        tracks: any[],
        fallbackArtistId?: string | null,
        canonicalReleaseMbid?: string | null,
    ): Promise<void> {
        if (!Array.isArray(tracks) || tracks.length === 0) {
            return;
        }

        // SoundCloud: never materialize DRM/SNIP/BLOCK as matchable members.
        // Progressive/plain-HLS (and unhydrated unknowns) remain.
        const tracksForMatching = providerId === "soundcloud"
            ? this.filterSoundCloudDownloadableTrackOffers(tracks)
            : tracks;
        if (providerId === "soundcloud" && tracksForMatching.length === 0) {
            // Every classifiable track was undownloadable — reject the offer so
            // it cannot remain as an accepted plan source after a re-refresh.
            const hadKnownUndownloadable = tracks.some((track) =>
                isSoundCloudTrackKnownUndownloadable(track));
            if (hadKnownUndownloadable) {
                this.markSoundCloudReleaseUndownloadable(String(albumId), "drm-only");
            }
            return;
        }

        const catalog = new ProviderCatalogRepository(db);
        const existingRelease = db.prepare(`
            SELECT
              title, version, provider_type, upc, duration_ms, release_date,
              explicit, availability, checked_at, provider_url, cover_id,
              artwork_url, volume_count, copyright
            FROM ProviderItems
            WHERE provider = ? AND entity_type = 'release' AND provider_id = ?
            LIMIT 1
        `).get(providerId, albumId) as Record<string, any> | undefined;
        const release = {
            provider: providerId,
            entityType: "release" as const,
            providerId: String(albumId),
            title: textOrNull(existingRelease?.title),
            version: textOrNull(existingRelease?.version),
            providerType: textOrNull(existingRelease?.provider_type),
            upc: textOrNull(existingRelease?.upc),
            durationMs: positiveNumberOrNull(existingRelease?.duration_ms),
            releaseDate: textOrNull(existingRelease?.release_date),
            explicit: existingRelease?.explicit == null ? null : Boolean(existingRelease.explicit),
            // SoundCloud re-store of downloadable members clears a prior drm-only reject.
            availability: providerId === "soundcloud"
                ? "available"
                : (textOrNull(existingRelease?.availability) || "available"),
            ...(providerId === "soundcloud" ? { availabilityReason: null as string | null } : {}),
            checkedAt: textOrNull(existingRelease?.checked_at) || new Date().toISOString(),
            providerUrl: textOrNull(existingRelease?.provider_url),
            coverId: textOrNull(existingRelease?.cover_id),
            artworkUrl: textOrNull(existingRelease?.artwork_url),
            volumeCount: positiveNumberOrNull(existingRelease?.volume_count),
            copyright: textOrNull(existingRelease?.copyright),
        };
        const members = tracksForMatching
            .filter((track) => track?.provider_id != null)
            .map((currentTrack) => {
                const qualityTags = [
                    ...(Array.isArray(currentTrack.qualityTags) ? currentTrack.qualityTags : []),
                    currentTrack.quality,
                ];
                return {
                    item: {
                        provider: providerId,
                        entityType: currentTrack.is_video ? "video" as const : "track" as const,
                        providerId: String(currentTrack.provider_id),
                        title: textOrNull(currentTrack.title),
                        version: textOrNull(currentTrack.version),
                        isrc: textOrNull(currentTrack.isrc),
                        durationMs: positiveNumberOrNull(currentTrack.duration) == null
                            ? null
                            : Math.round(Number(currentTrack.duration) * 1000),
                        releaseDate: textOrNull(currentTrack.release_date),
                        explicit: currentTrack.explicit == null ? null : Boolean(currentTrack.explicit),
                        availability: "available",
                        checkedAt: new Date().toISOString(),
                        providerUrl: textOrNull(currentTrack.url),
                        coverId: /^https?:\/\//i.test(String(currentTrack.cover || ""))
                            ? null
                            : textOrNull(currentTrack.cover, currentTrack.image_id, currentTrack.imageId),
                        artworkUrl: /^https?:\/\//i.test(String(currentTrack.cover || ""))
                            ? textOrNull(currentTrack.cover)
                            : null,
                        replayGain: finiteNumberOrNull(currentTrack.replay_gain),
                        peak: finiteNumberOrNull(currentTrack.peak),
                        bpm: finiteNumberOrNull(currentTrack.bpm),
                        musicalKey: textOrNull(currentTrack.musical_key),
                        copyright: textOrNull(currentTrack.copyright),
                    },
                    mediumPosition: Number(currentTrack.volume_number || 1),
                    position: Number(currentTrack.track_number || 0),
                    number: textOrNull(currentTrack.track_number),
                    contextualTitle: textOrNull(currentTrack.title),
                    contextualDurationMs: positiveNumberOrNull(currentTrack.duration) == null
                        ? null
                        : Math.round(Number(currentTrack.duration) * 1000),
                    credits: providerCredits(currentTrack.artists),
                    audioVariants: currentTrack.is_video
                        ? undefined
                        : providerAudioVariants(providerId, qualityTags),
                };
            });
        if (members.length === 0) {
            return;
        }

        const canonicalRelease = canonicalReleaseMbid
            ? db.prepare(`
                SELECT release.id, release.mbid, release_group.mbid AS release_group_mbid
                FROM AlbumEditions release
                JOIN Albums release_group ON release_group.id = release.release_group_id
                WHERE release.mbid = ?
                LIMIT 1
              `).get(canonicalReleaseMbid) as { id: number; mbid: string; release_group_mbid: string } | undefined
            : db.prepare(`
                SELECT release.id, release.mbid, release_group.mbid AS release_group_mbid
                FROM ProviderItems item
                JOIN ProviderEditionMatches match
                  ON match.provider_edition_item_id = item.id
                 AND match.match_state = 'accepted'
                JOIN AlbumEditions release ON release.id = match.edition_id
                JOIN Albums release_group ON release_group.id = release.release_group_id
                WHERE item.provider = ?
                  AND item.entity_type = 'release'
                  AND item.provider_id = ?
                ORDER BY
                  CASE match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
                  match.confidence DESC,
                  match.id
                LIMIT 1
            `).get(providerId, albumId) as { id: number; mbid: string; release_group_mbid: string } | undefined;

        if (canonicalRelease) {
            // Ingestion and its counterpart-video follow-up are one write
            // section. Ungated, three refresh workers enter SQLite's *synchronous*
            // busy handler at once: the loser blocks its whole thread for up to
            // 30s per attempt, its lease heartbeat is a timer that cannot fire
            // while blocked, and the watchdog then kills a worker that was only
            // waiting its turn. Taking the process-global gate makes that wait
            // asynchronous, so the worker stays alive while another writes.
            await withSqliteWriteGate(() => {
            const ingested = new ProviderReleaseIngestionService(db).ingest({
                canonicalReleaseId: canonicalRelease.id,
                matcherVersion: PROVIDER_TRACK_MATCHER_VERSION,
                release,
                members,
            });
            if (ingested.releaseMatchId != null) {
                const accepted = db.prepare(`
                    SELECT item.provider_id, match.recording_id
                    FROM ProviderTrackMatches match
                    JOIN ProviderEditionMembers member
                      ON member.id = match.provider_edition_member_id
                    JOIN ProviderItems item ON item.id = member.member_item_id
                    WHERE match.provider_edition_match_id = ?
                      AND match.match_state = 'accepted'
                `).all(ingested.releaseMatchId) as Array<{
                    provider_id: string;
                    recording_id: number;
                }>;
                const trackByProviderId = new Map(
                    tracks.map((track) => [String(track.provider_id), track] as const),
                );
                for (const match of accepted) {
                    this.storeCanonicalTrackSupplements(
                        match.recording_id,
                        trackByProviderId.get(String(match.provider_id)),
                    );
                }
                const recordingByProviderTrack = new Map(
                    accepted.map((match) => [String(match.provider_id), Number(match.recording_id)] as const),
                );
                const counterparts = tracks.flatMap((track) => {
                    const counterpartId = textOrNull(track.counterpart_video_id);
                    const audioProviderTrackId = textOrNull(track.provider_id);
                    const audioRecordingId = audioProviderTrackId
                        ? recordingByProviderTrack.get(audioProviderTrackId) ?? null
                        : null;
                    if (!counterpartId || !audioProviderTrackId || !audioRecordingId) {
                        return [];
                    }
                    return [{
                        providerId: counterpartId,
                        albumId: String(albumId),
                        title: textOrNull(track.title) || "Unknown video",
                        duration: positiveNumberOrNull(track.duration),
                        releaseDate: textOrNull(track.release_date),
                        quality: textOrNull(track.quality),
                        cover: textOrNull(track.cover, track.image_id, track.imageId),
                        url: textOrNull(track.url),
                        audioRecordingId,
                        audioRecordingMbid: null,
                        audioProviderTrackId,
                        artistName: textOrNull(track.artist_name),
                    }];
                });
                if (counterparts.length > 0 && fallbackArtistId) {
                    RefreshVideoService.upsertAlbumTrackCounterpartVideos({
                        artistId: fallbackArtistId,
                        provider: providerId,
                        albumId: String(albumId),
                        releaseGroupMbid: canonicalRelease.release_group_mbid,
                        releaseMbid: canonicalRelease.mbid,
                        counterparts,
                    });
                }
            }
            }, `provider-release-ingest:${providerId}`);
            return;
        }

        await withSqliteWriteGate(() => db.transaction(() => {
            const releaseItemId = catalog.upsertItem(release);
            const materializeCredits = (
                itemId: number,
                credits: ProviderArtistCreditFacts[] | undefined,
            ) => {
                if (!credits) return;
                catalog.replaceCredits(itemId, credits.map((credit) => ({
                    artistItemId: catalog.upsertItem({
                        provider: providerId,
                        entityType: "artist",
                        providerId: credit.providerId,
                        title: credit.name,
                        availability: "unknown",
                    }),
                    ordinal: credit.ordinal,
                    creditedName: credit.name,
                    joinPhrase: credit.joinPhrase || "",
                    normalizedRole: credit.normalizedRole || "other",
                    providerRole: credit.providerRole,
                })));
            };
            const memberRows = members.map((member) => {
                const itemId = catalog.upsertItem(member.item);
                materializeCredits(itemId, member.credits);
                if (member.audioVariants) {
                    catalog.replaceAudioVariants(itemId, member.audioVariants, { provider: providerId });
                }
                return {
                    memberItemId: itemId,
                    mediumPosition: member.mediumPosition,
                    position: member.position,
                    number: member.number,
                    contextualTitle: member.contextualTitle,
                    contextualDurationMs: member.contextualDurationMs,
                };
            });
            catalog.replaceReleaseMembers(releaseItemId, memberRows);
        })(), `provider-release-unmatched:${providerId}`);
    }

    static async upsertArtistAlbum(
        album: any,
        scanningArtistId: string,
        albumModuleMap: Map<string, string>,
        options: RefreshOptions,
    ): Promise<boolean> {
        const forceUpdate = options.forceUpdate === true;
        const providerId = String(options.provider || "tidal").trim() || "tidal";
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

        // "New" means the provider-native release fact has not been seen before.
        const offerExisted = db.prepare(`
            SELECT 1 FROM ProviderItems
            WHERE provider = ? AND entity_type = 'release'
              AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            LIMIT 1
        `).get(providerId, album.provider_id) as any;
        void albumModuleMap;
        void scanningArtistId;

        const matchedReleaseMbid = ProviderOfferReleaseLinkService.selectReleaseMbid(releaseGroupMatch);

        const normalizedCatalog = new ProviderCatalogRepository(db);
        const normalizedReleaseItemId = normalizedCatalog.upsertItem({
            provider: providerId,
            entityType: "release",
            providerId: String(album.provider_id),
            title: textOrNull(album.title),
            version: textOrNull(album.version),
            providerType: textOrNull(album.type),
            upc: textOrNull(album.upc),
            durationMs: positiveNumberOrNull(album.duration) == null
                ? null
                : Math.round(Number(album.duration) * 1000),
            releaseDate: textOrNull(album.release_date),
            explicit: album.explicit == null ? null : Boolean(album.explicit),
            availability: "available",
            checkedAt: new Date().toISOString(),
            providerUrl: textOrNull(album.url),
            coverId: /^https?:\/\//i.test(String(album.cover || ""))
                ? null
                : textOrNull(album.cover, album.image_id, album.imageId),
            artworkUrl: /^https?:\/\//i.test(String(album.cover || ""))
                ? textOrNull(album.cover)
                : null,
            volumeCount: positiveNumberOrNull(album.num_volumes),
            copyright: textOrNull(album.copyright),
        });
        const releaseVariants = providerAudioVariants(providerId, [
            ...(Array.isArray(album.qualityTags) ? album.qualityTags : []),
            album.quality,
        ]);
        if (releaseVariants.length > 0) {
            normalizedCatalog.replaceAudioVariants(normalizedReleaseItemId, releaseVariants, { provider: providerId });
        }
        const releaseCredits = providerCredits(
            Array.isArray(album.artists) && album.artists.length > 0
                ? album.artists
                : (album.artist_id && album.artist_name
                    ? [{ id: album.artist_id, name: album.artist_name }]
                    : []),
        );
        if (releaseCredits) {
            const artistIds = releaseCredits.map((credit) => normalizedCatalog.upsertItem({
                provider: providerId,
                entityType: "artist",
                providerId: credit.providerId,
                title: credit.name,
                availability: "unknown",
            }));
            normalizedCatalog.replaceCredits(
                normalizedReleaseItemId,
                releaseCredits.map((credit, index) => ({
                    artistItemId: artistIds[index],
                    ordinal: credit.ordinal,
                    creditedName: credit.name,
                    joinPhrase: credit.joinPhrase || "",
                    normalizedRole: credit.normalizedRole,
                    providerRole: credit.providerRole,
                })),
            );
        }

        this.storeCanonicalAlbumSupplements({
            releaseGroupMbid: matchedReleaseGroup?.mbid || null,
            releaseMbid: matchedReleaseMbid,
            album,
        });

        if (options.resolveMusicBrainz !== false) {
            await MetadataIdentityService.resolveAlbum(String(album.provider_id), {
                force: forceUpdate,
                provider: providerId,
            });
        }

        return !offerExisted;
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




