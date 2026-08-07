import { db } from "../../database.js";
import { requestMusicBrainzJson } from "../mediafiles/fingerprint.js";
import { normalizeComparableText, stringSimilarity } from "../mediafiles/import-matching-utils.js";

export type MetadataIdentityEntityType = "artist" | "album" | "track" | "video";
export type MetadataIdentityStatus = "pending" | "verified" | "ambiguous" | "unmatched" | "error";

export type MetadataIdentityOptions = {
    force?: boolean;
    provider?: string | null;
};

export type MetadataIdentityResult = {
    entityType: MetadataIdentityEntityType;
    entityId: string;
    status: MetadataIdentityStatus;
    confidence: number;
    method: string;
    message?: string;
    data?: Record<string, unknown>;
};

type ArtistRow = {
    id: number;
    name: string;
    mbid: string | null;
};

type ProviderAlbumOffer = {
    provider_item_id: number;
    release_mbid: string | null;
    release_group_mbid: string | null;
    title: string | null;
};

type ProviderTrackOffer = {
    provider_item_id: number;
    recording_mbid: string | null;
    recording_id: number | null;
};

type MusicBrainzArtistCandidate = {
    id: string;
    name: string;
    disambiguation: string | null;
    score: number;
};

function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function normalizeText(value: unknown): string {
    return normalizeComparableText(String(value || ""));
}

function identityStatusStorageId(entityId: string, provider?: string | null): string {
    const normalizedProvider = String(provider || "").trim();
    return normalizedProvider ? `${normalizedProvider}:${entityId}` : entityId;
}

function recordIdentityStatus(result: MetadataIdentityResult, provider?: string | null): void {
    db.prepare(`
        INSERT INTO metadata_identity_status (
            entity_type, entity_id, status, confidence, method, message, data, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            status = excluded.status,
            confidence = excluded.confidence,
            method = excluded.method,
            message = excluded.message,
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        result.entityType,
        identityStatusStorageId(result.entityId, provider),
        result.status,
        result.confidence,
        result.method,
        result.message || null,
        result.data ? JSON.stringify(result.data) : null,
    );
}

function updateArtistIdentityColumns(artistId: string, result: MetadataIdentityResult, mbid?: string | null): void {
    db.prepare(`
        UPDATE Artists SET
            mbid = COALESCE(?, mbid),
            musicbrainz_status = ?,
            musicbrainz_last_checked = CURRENT_TIMESTAMP,
            musicbrainz_match_method = ?
        WHERE id = ?
    `).run(mbid || null, result.status, result.method, artistId);
}

/**
 * Candidates for an artist name, from the **configured catalog source**.
 *
 * This runs once per unmapped-file artist during import. Asking
 * musicbrainz.org meant a global 1-request-per-second queue and, at library
 * scale, a run of 503s — so importing a folder of files for artists not yet in
 * the database resolved nothing, which is exactly what a local MusicBrainz
 * mirror exists to prevent. The registry's active provider answers this
 * offline; public MB stays as the fallback for deployments that have no local
 * source.
 */
async function searchCatalogArtists(name: string): Promise<MusicBrainzArtistCandidate[]> {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) return [];

    const score = (candidateName: string, apiScore: unknown): number => {
        const parsed = Number(apiScore);
        const textScore = stringSimilarity(normalizeText(name), normalizeText(candidateName));
        return clampConfidence((Number.isFinite(parsed) ? parsed / 100 : 0) * 0.55 + textScore * 0.45);
    };
    const rank = (candidates: MusicBrainzArtistCandidate[]): MusicBrainzArtistCandidate[] => candidates
        .filter((artist) => Boolean(artist.id && artist.name))
        .sort((left, right) => right.score - left.score);

    try {
        const { catalogProviderRegistry } = await import("../catalog/index.js");
        const results = await catalogProviderRegistry.getActive().search(normalizedName, { limit: 10 });
        const candidates = (results.artists || []).map((artist) => {
            const candidateName = String(artist?.artistname || "").trim();
            return {
                id: String(artist?.id || "").trim(),
                name: candidateName,
                disambiguation: String(artist?.disambiguation || "").trim() || null,
                // A local source returns no relevance score; text similarity alone
                // then decides, which is the honest signal we actually have.
                score: score(candidateName, undefined),
            } satisfies MusicBrainzArtistCandidate;
        });
        if (candidates.length > 0) return rank(candidates);
    } catch (error) {
        console.warn(`[MetadataIdentity] Catalog artist search failed for "${normalizedName}"; falling back to public MusicBrainz:`, error);
    }

    const query = `artist:"${normalizedName.replace(/"/g, "")}"`;
    const url = `https://musicbrainz.org/ws/2/artist?fmt=json&limit=10&query=${encodeURIComponent(query)}`;
    const data = await requestMusicBrainzJson<any>(url);
    const artists = Array.isArray(data?.artists) ? data.artists : [];

    return rank(artists.map((artist: any) => {
        const candidateName = String(artist?.name || "").trim();
        return {
            id: String(artist?.id || "").trim(),
            name: candidateName,
            disambiguation: String(artist?.disambiguation || "").trim() || null,
            score: score(candidateName, artist?.score),
        } satisfies MusicBrainzArtistCandidate;
    }));
}

/**
 * Metadata identity is now resolved against the canonical MusicBrainz/Servarr Metadata Server
 * graph. ProviderItems contain provider-native facts only; accepted typed match
 * tables are the sole provider→canonical boundary. This service reports those
 * decisions and fails closed when colliding provider identities or accepted edges
 * disagree. Fingerprinting remains an unknown-local-import concern.
 */
export class MetadataIdentityService {
    static getStatus(
        entityType: MetadataIdentityEntityType,
        entityId: string,
        options: Pick<MetadataIdentityOptions, "provider"> = {},
    ): MetadataIdentityResult | null {
        const row = db.prepare(`
            SELECT entity_type, entity_id, status, confidence, method, message, data
            FROM metadata_identity_status
            WHERE entity_type = ? AND entity_id = ?
        `).get(entityType, identityStatusStorageId(entityId, options.provider)) as {
            entity_type: MetadataIdentityEntityType;
            entity_id: string;
            status: MetadataIdentityStatus;
            confidence: number | null;
            method: string | null;
            message: string | null;
            data: string | null;
        } | undefined;

        if (!row) return null;

        return {
            entityType: row.entity_type,
            entityId,
            status: row.status,
            confidence: Number(row.confidence || 0),
            method: row.method || "unknown",
            message: row.message || undefined,
            data: row.data ? JSON.parse(row.data) as Record<string, unknown> : undefined,
        };
    }

    static async resolveArtist(artistId: string, options: { force?: boolean } = {}): Promise<MetadataIdentityResult> {
        const artist = db.prepare("SELECT id, name, mbid FROM Artists WHERE id = ?").get(artistId) as ArtistRow | undefined;
        if (!artist) {
            const result = this.result("artist", artistId, "error", 0, "local-row", "Artist is not in the Discogenius database");
            recordIdentityStatus(result);
            return result;
        }

        if (artist.mbid && !options.force) {
            const result = this.result("artist", artistId, "verified", 1, "existing-mbid", undefined, { mbid: artist.mbid });
            recordIdentityStatus(result);
            updateArtistIdentityColumns(artistId, result, artist.mbid);
            return result;
        }

        try {
            const candidates = await searchCatalogArtists(artist.name);
            const best = candidates[0];
            if (!best) {
                const result = this.result("artist", artistId, "unmatched", 0, "artist-search", "No MusicBrainz artist candidate found");
                recordIdentityStatus(result);
                updateArtistIdentityColumns(artistId, result);
                return result;
            }

            const second = candidates[1]?.score ?? 0;
            if (best.score < 0.88 || (second > 0 && best.score - second < 0.05)) {
                const result = this.result("artist", artistId, "ambiguous", best.score, "artist-search", "MusicBrainz artist match is ambiguous", {
                    candidates: candidates.slice(0, 5),
                });
                recordIdentityStatus(result);
                updateArtistIdentityColumns(artistId, result);
                return result;
            }

            const result = this.result("artist", artistId, "verified", best.score, "artist-search", undefined, {
                mbid: best.id,
                name: best.name,
                disambiguation: best.disambiguation,
            });
            recordIdentityStatus(result);
            updateArtistIdentityColumns(artistId, result, best.id);
            return result;
        } catch (error) {
            const result = this.result("artist", artistId, "error", 0, "artist-search", error instanceof Error ? error.message : String(error));
            recordIdentityStatus(result);
            updateArtistIdentityColumns(artistId, result);
            return result;
        }
    }

    /**
     * Reports a provider edition's canonical identity from accepted typed edition
     * matches. Several accepted editions may still agree on one release group.
     */
    static async resolveAlbum(albumId: string, options: MetadataIdentityOptions = {}): Promise<MetadataIdentityResult> {
        const offers = db.prepare(`
            SELECT
                item.id AS provider_item_id,
                edition.mbid AS release_mbid,
                album.mbid AS release_group_mbid,
                item.title
            FROM ProviderItems item
            LEFT JOIN ProviderEditionMatches edition_match
              ON edition_match.provider_edition_item_id = item.id
             AND edition_match.match_state = 'accepted'
            LEFT JOIN AlbumEditions edition ON edition.id = edition_match.edition_id
            LEFT JOIN Albums album ON album.id = edition.release_group_id
            WHERE item.entity_type = 'release'
              AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
              AND (? IS NULL OR item.provider = ?)
            ORDER BY item.id, edition_match.id
        `).all(albumId, options.provider || null, options.provider || null) as ProviderAlbumOffer[];

        if (offers.length === 0) {
            const result = this.result("album", albumId, "error", 0, "local-row", "Album offer is not in the Discogenius database");
            recordIdentityStatus(result, options.provider);
            return result;
        }

        const matched = offers.filter((offer) => offer.release_group_mbid);
        const releaseGroupMbids = [...new Set(matched.map((offer) => offer.release_group_mbid as string))];
        if (releaseGroupMbids.length > 1) {
            const result = this.result(
                "album",
                albumId,
                "ambiguous",
                0,
                "typed-provider-edition-match",
                "Accepted provider edition matches disagree on canonical release group",
                { releaseGroupIds: releaseGroupMbids },
            );
            recordIdentityStatus(result, options.provider);
            return result;
        }
        if (releaseGroupMbids.length === 1) {
            const releaseMbids = [...new Set(
                matched.map((offer) => offer.release_mbid).filter((value): value is string => Boolean(value)),
            )];
            const result = this.result("album", albumId, "verified", 1, "provider-items-canonical-link", undefined, {
                ...(releaseMbids.length === 1 ? { editionId: releaseMbids[0] } : {}),
                releaseGroupId: releaseGroupMbids[0],
            });
            recordIdentityStatus(result, options.provider);
            return result;
        }

        const result = this.result(
            "album",
            albumId,
            "unmatched",
            0,
            "canonical-catalog-only",
            "provider offer has not been matched to the canonical MusicBrainz catalog",
        );
        recordIdentityStatus(result, options.provider);
        return result;
    }

    /**
     * Reports a provider track's canonical identity from accepted typed track
     * matches. Edition context is optional; provider item identity is not.
     */
    static async resolveTrack(mediaId: string, options: MetadataIdentityOptions = {}): Promise<MetadataIdentityResult> {
        const offers = db.prepare(`
            SELECT
                item.id AS provider_item_id,
                recording.mbid AS recording_mbid,
                track_match.recording_id
            FROM ProviderItems item
            LEFT JOIN ProviderTrackMatches track_match
              ON track_match.provider_track_item_id = item.id
             AND track_match.match_state = 'accepted'
            LEFT JOIN Recordings recording ON recording.id = track_match.recording_id
            WHERE item.entity_type = 'track'
              AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
              AND (? IS NULL OR item.provider = ?)
            ORDER BY item.id, track_match.id
        `).all(mediaId, options.provider || null, options.provider || null) as ProviderTrackOffer[];

        if (offers.length === 0) {
            const result = this.result("track", mediaId, "error", 0, "local-row", "Track offer is not in the Discogenius database");
            recordIdentityStatus(result, options.provider);
            return result;
        }

        const accepted = offers.filter((offer) => offer.recording_id != null);
        const recordingIds = [...new Set(accepted.map((offer) => Number(offer.recording_id)))];
        if (recordingIds.length > 1) {
            const result = this.result(
                "track",
                mediaId,
                "ambiguous",
                0,
                "typed-provider-track-match",
                "Accepted provider track matches disagree on canonical recording",
                { recordingIds },
            );
            recordIdentityStatus(result, options.provider);
            return result;
        }
        const offer = accepted[0];
        if (offer?.recording_mbid) {
            const result = this.result("track", mediaId, "verified", 1, "typed-provider-track-match", undefined, {
                recordingId: offer.recording_mbid,
            });
            recordIdentityStatus(result, options.provider);
            return result;
        }

        if (offer.recording_id) {
            const result = this.result(
                "track",
                mediaId,
                "unmatched",
                0.7,
                "typed-provider-track-match",
                "track maps to a provisional local recording without a MusicBrainz ID",
                { recordingId: offer.recording_id },
            );
            recordIdentityStatus(result, options.provider);
            return result;
        }

        const result = this.result("track", mediaId, "unmatched", 0, "track-lookup", "No canonical recording linked to this provider track");
        recordIdentityStatus(result, options.provider);
        return result;
    }

    static markVideoKnown(
        videoId: string,
        options: Pick<MetadataIdentityOptions, "provider"> = {},
    ): MetadataIdentityResult {
        const offers = db.prepare(`
            SELECT video_match.recording_id, recording.mbid AS recording_mbid
            FROM ProviderItems item
            LEFT JOIN ProviderVideoMatches video_match
              ON video_match.provider_video_item_id = item.id
             AND video_match.match_state = 'accepted'
            LEFT JOIN Recordings recording ON recording.id = video_match.recording_id
            WHERE item.entity_type = 'video'
              AND CAST(item.provider_id AS TEXT) = CAST(? AS TEXT)
              AND (? IS NULL OR item.provider = ?)
            ORDER BY item.id, video_match.id
        `).all(videoId, options.provider || null, options.provider || null) as Array<{
            recording_mbid: string | null;
            recording_id: number | null;
        }>;
        const accepted = offers.filter((offer) => offer.recording_id != null);
        const recordingIds = [...new Set(accepted.map((offer) => Number(offer.recording_id)))];
        if (recordingIds.length > 1) {
            const result = this.result(
                "video",
                videoId,
                "ambiguous",
                0,
                "typed-provider-video-match",
                "Accepted provider video matches disagree on canonical recording",
                { recordingIds },
            );
            recordIdentityStatus(result, options.provider);
            return result;
        }
        const offer = accepted[0];
        const recordingMbid = String(offer?.recording_mbid || "").trim();
        if (recordingMbid) {
            const result = this.result("video", videoId, "verified", 1, "musicbrainz-recording", undefined, {
                recordingId: recordingMbid,
            });
            recordIdentityStatus(result, options.provider);
            return result;
        }

        const result = this.result(
            "video",
            videoId,
            "unmatched",
            offer?.recording_id ? 0.7 : 1,
            offer?.recording_id ? "typed-provider-video-match" : "musicbrainz-video-unmatched",
            offer?.recording_id
                ? "provider video is represented as a provisional local recording without a MusicBrainz ID"
                : "No matching MusicBrainz video recording has been linked yet",
            offer?.recording_id ? { recordingId: offer.recording_id } : undefined,
        );
        recordIdentityStatus(result, options.provider);
        return result;
    }

    private static result(
        entityType: MetadataIdentityEntityType,
        entityId: string,
        status: MetadataIdentityStatus,
        confidence: number,
        method: string,
        message?: string,
        data?: Record<string, unknown>,
    ): MetadataIdentityResult {
        return {
            entityType,
            entityId: String(entityId),
            status,
            confidence: clampConfidence(confidence),
            method,
            message,
            data,
        };
    }
}
