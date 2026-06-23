import { db } from "../../database.js";
import { requestMusicBrainzJson } from "../mediafiles/fingerprint.js";
import { normalizeComparableText, stringSimilarity } from "../mediafiles/import-matching-utils.js";

export type MetadataIdentityEntityType = "artist" | "album" | "track" | "video";
export type MetadataIdentityStatus = "pending" | "verified" | "ambiguous" | "unmatched" | "error";

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
    id: string;
    release_mbid: string | null;
    release_group_mbid: string | null;
    artist_mbid: string | null;
    title: string | null;
};

type ProviderTrackOffer = {
    id: string;
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

function recordIdentityStatus(result: MetadataIdentityResult): void {
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
        result.entityId,
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

async function searchMusicBrainzArtists(name: string): Promise<MusicBrainzArtistCandidate[]> {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) return [];

    const query = `artist:"${normalizedName.replace(/"/g, "")}"`;
    const url = `https://musicbrainz.org/ws/2/artist?fmt=json&limit=10&query=${encodeURIComponent(query)}`;
    const data = await requestMusicBrainzJson<any>(url);
    const artists = Array.isArray(data?.artists) ? data.artists : [];

    return artists
        .map((artist: any) => {
            const candidateName = String(artist?.name || "").trim();
            const apiScore = Number(artist?.score);
            const textScore = stringSimilarity(normalizeText(name), normalizeText(candidateName));
            return {
                id: String(artist?.id || "").trim(),
                name: candidateName,
                disambiguation: String(artist?.disambiguation || "").trim() || null,
                score: clampConfidence((Number.isFinite(apiScore) ? apiScore / 100 : 0) * 0.55 + textScore * 0.45),
            } satisfies MusicBrainzArtistCandidate;
        })
        .filter((artist: MusicBrainzArtistCandidate) => Boolean(artist.id && artist.name))
        .sort((left: MusicBrainzArtistCandidate, right: MusicBrainzArtistCandidate) => right.score - left.score);
}

/**
 * Metadata identity is now resolved against the canonical MusicBrainz/Servarr Metadata Server
 * graph. Provider catalog tables are gone: an album/track's canonical link lives
 * on its `ProviderItems` offer (release_group_mbid / release_mbid / recording_mbid /
 * recording_id), populated by the release-group matcher and by-position mapping in
 * RefreshAlbumService.scanTracks. This service therefore reports identity from
 * those offers and ensures the canonical release-group row is synced; it no longer
 * runs a bespoke per-track ISRC/AcoustID search (retired with the legacy tables —
 * fingerprinting only matters for unknown *local* imports, a separate file path).
 */
export class MetadataIdentityService {
    static getStatus(entityType: MetadataIdentityEntityType, entityId: string): MetadataIdentityResult | null {
        const row = db.prepare(`
            SELECT entity_type, entity_id, status, confidence, method, message, data
            FROM metadata_identity_status
            WHERE entity_type = ? AND entity_id = ?
        `).get(entityType, entityId) as {
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
            entityId: row.entity_id,
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
            const candidates = await searchMusicBrainzArtists(artist.name);
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
     * Reports a provider album's canonical identity from its ProviderItems offer
     * and ensures the matched release group is present in the canonical catalog.
     * The matching itself (provider album → release group) already happened in the
     * scan; we no longer re-derive it or write provider catalog rows.
     */
    static async resolveAlbum(albumId: string, options: { force?: boolean } = {}): Promise<MetadataIdentityResult> {
        void options;
        const offer = db.prepare(`
            SELECT
                a.provider_id AS id,
                a.release_mbid AS release_mbid,
                a.release_group_mbid AS release_group_mbid,
                a.artist_mbid AS artist_mbid,
                a.title AS title
            FROM ProviderItems a
            WHERE a.entity_type = 'album' AND CAST(a.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY a.updated_at DESC
            LIMIT 1
        `).get(albumId) as ProviderAlbumOffer | undefined;

        if (!offer) {
            const result = this.result("album", albumId, "error", 0, "local-row", "Album offer is not in the Discogenius database");
            recordIdentityStatus(result);
            return result;
        }

        if (offer.artist_mbid) {
            await this.resolveArtist(String(offer.artist_mbid), { force: false });
        }

        if (offer.release_group_mbid) {
            const rgExists = db.prepare("SELECT 1 FROM Albums WHERE mbid = ?").get(offer.release_group_mbid);
            if (!rgExists) {
                try {
                    const { MusicBrainzReleaseGroupReadService } = await import("./musicbrainz-release-group-read-service.js");
                    await MusicBrainzReleaseGroupReadService.getAlbum(offer.release_group_mbid);
                } catch (err) {
                    console.warn(`[MetadataIdentity] Failed to auto-sync release group ${offer.release_group_mbid} for provider album ${albumId}:`, err);
                }
            }

            const result = this.result("album", albumId, "verified", 1, "provider-items-canonical-link", undefined, {
                releaseId: offer.release_mbid,
                releaseGroupId: offer.release_group_mbid,
            });
            recordIdentityStatus(result);
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
        recordIdentityStatus(result);
        return result;
    }

    /**
     * Reports a provider track's canonical identity from its ProviderItems offer.
     * Tracks are mapped to canonical recordings by position during the scan, so
     * there is no per-track MusicBrainz search here anymore.
     */
    static async resolveTrack(mediaId: string, options: { force?: boolean } = {}): Promise<MetadataIdentityResult> {
        void options;
        const offer = db.prepare(`
            SELECT
                a.provider_id AS id,
                a.recording_mbid AS recording_mbid,
                a.recording_id AS recording_id
            FROM ProviderItems a
            WHERE a.entity_type = 'track' AND CAST(a.provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY a.updated_at DESC
            LIMIT 1
        `).get(mediaId) as ProviderTrackOffer | undefined;

        if (!offer) {
            const result = this.result("track", mediaId, "error", 0, "local-row", "Track offer is not in the Discogenius database");
            recordIdentityStatus(result);
            return result;
        }

        if (offer.recording_mbid) {
            const result = this.result("track", mediaId, "verified", 1, "provider-items-canonical-link", undefined, {
                recordingId: offer.recording_mbid,
            });
            recordIdentityStatus(result);
            return result;
        }

        if (offer.recording_id) {
            const result = this.result(
                "track",
                mediaId,
                "unmatched",
                0.7,
                "provider-recording",
                "track maps to a provisional local recording without a MusicBrainz ID",
                { recordingId: offer.recording_id },
            );
            recordIdentityStatus(result);
            return result;
        }

        const result = this.result("track", mediaId, "unmatched", 0, "track-lookup", "No canonical recording linked to this provider track");
        recordIdentityStatus(result);
        return result;
    }

    static markVideoKnown(videoId: string): MetadataIdentityResult {
        const offer = db.prepare(`
            SELECT recording_mbid, recording_id
            FROM ProviderItems
            WHERE entity_type = 'video' AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(videoId) as { recording_mbid?: string | null; recording_id?: number | null } | undefined;

        const recordingMbid = String(offer?.recording_mbid || "").trim();
        if (recordingMbid) {
            const result = this.result("video", videoId, "verified", 1, "musicbrainz-recording", undefined, {
                recordingId: recordingMbid,
            });
            recordIdentityStatus(result);
            return result;
        }

        const result = this.result(
            "video",
            videoId,
            "unmatched",
            offer?.recording_id ? 0.7 : 1,
            offer?.recording_id ? "provider-recording" : "musicbrainz-video-unmatched",
            offer?.recording_id
                ? "provider video is represented as a provisional local recording without a MusicBrainz ID"
                : "No matching MusicBrainz video recording has been linked yet",
            offer?.recording_id ? { recordingId: offer.recording_id } : undefined,
        );
        recordIdentityStatus(result);
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
