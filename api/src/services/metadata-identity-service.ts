import fs from "fs";
import { db } from "../database.js";
import {
    type AcoustIdLookupResult,
    type MusicBrainzArtistCredit,
    type MusicBrainzRecording,
    type MusicBrainzRelease,
    generateFingerprint,
    lookupAcoustIdMatches,
    lookupMusicBrainzRecording,
    lookupMusicBrainzRecordingsByIsrc,
    lookupMusicBrainzReleasesByBarcode,
    requestMusicBrainzJson,
} from "./fingerprint.js";
import { getConfigSection } from "./config.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import { resolveStoredLibraryPath } from "./library-paths.js";

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

type AlbumRow = {
    id: number;
    artist_id: number;
    title: string;
    release_date: string | null;
    upc: string | null;
    mbid: string | null;
    mb_release_group_id: string | null;
    artist_name: string | null;
    artist_mbid: string | null;
};

type TrackRow = {
    id: number;
    artist_id: number;
    album_id: number | null;
    title: string;
    duration: number | null;
    track_number: number | null;
    volume_number: number | null;
    isrc: string | null;
    mbid: string | null;
    acoustid_id: string | null;
    acoustid_fingerprint: string | null;
    artist_name: string | null;
    artist_mbid: string | null;
    album_title: string | null;
    album_mbid: string | null;
};

type MusicBrainzArtistCandidate = {
    id: string;
    name: string;
    disambiguation: string | null;
    score: number;
};

type ReleaseTrackCandidate = {
    recordingId: string;
    title: string;
    mediumNumber: number | null;
    position: number | null;
    durationSeconds: number | null;
    artistCredits: MusicBrainzArtistCredit[];
    isrcs: string[];
};

type TrackResolutionEvidence = {
    recording: MusicBrainzRecording;
    confidence: number;
    method: string;
    acoustid?: AcoustIdLookupResult | null;
    fingerprint?: string | null;
    fingerprintDuration?: number | null;
};

function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function normalizeText(value: unknown): string {
    return normalizeComparableText(String(value || ""));
}

function yearOf(value: string | null | undefined): string | null {
    const match = String(value || "").match(/^\d{4}/);
    return match ? match[0] : null;
}

function isSameYear(left: string | null | undefined, right: string | null | undefined): boolean {
    const leftYear = yearOf(left);
    const rightYear = yearOf(right);
    return Boolean(leftYear && rightYear && leftYear === rightYear);
}

function durationScore(leftSeconds: number | null | undefined, rightSeconds: number | null | undefined): number {
    const left = Number(leftSeconds);
    const right = Number(rightSeconds);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
        return 0;
    }

    const diff = Math.abs(left - right);
    if (diff <= 3) return 1;
    if (diff <= 8) return 0.7;
    if (diff <= 15) return 0.35;
    return 0;
}

function artistCreditNames(credits: MusicBrainzArtistCredit[]): string {
    return credits.map((credit) => credit.name).filter(Boolean).join(" ");
}

function getReleaseGroupPrimaryType(release: any): string | null {
    return String(release?.["release-group"]?.["primary-type"] || "")
        .trim()
        .toLowerCase() || null;
}

function getReleaseGroupSecondaryTypes(release: any): string[] {
    const rawSecondaryTypes = release?.["release-group"]?.["secondary-types"];
    if (!Array.isArray(rawSecondaryTypes)) {
        return [];
    }

    return rawSecondaryTypes
        .map((type) => String(type || "").trim().toLowerCase())
        .filter(Boolean);
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
        UPDATE artists SET
            mbid = COALESCE(?, mbid),
            musicbrainz_status = ?,
            musicbrainz_last_checked = CURRENT_TIMESTAMP,
            musicbrainz_match_method = ?
        WHERE id = ?
    `).run(mbid || null, result.status, result.method, artistId);
}

function updateAlbumIdentityColumns(
    albumId: string,
    result: MetadataIdentityResult,
    release?: {
        id: string;
        releaseGroupId?: string | null;
        releaseGroupPrimaryType?: string | null;
        releaseGroupSecondaryTypes?: string[] | null;
    } | null,
): void {
    const primaryType = String(release?.releaseGroupPrimaryType || "").trim().toLowerCase() || null;
    const secondaryType = Array.isArray(release?.releaseGroupSecondaryTypes)
        ? release.releaseGroupSecondaryTypes.map((type) => String(type || "").trim().toLowerCase()).filter(Boolean)[0] || null
        : null;

    db.prepare(`
        UPDATE albums SET
            mbid = COALESCE(?, mbid),
            mb_release_group_id = COALESCE(?, mb_release_group_id),
            mb_primary = COALESCE(?, mb_primary),
            mb_secondary = COALESCE(?, mb_secondary),
            musicbrainz_status = ?,
            musicbrainz_last_checked = CURRENT_TIMESTAMP,
            musicbrainz_match_method = ?
        WHERE id = ?
    `).run(
        release?.id || null,
        release?.releaseGroupId || null,
        primaryType,
        secondaryType,
        result.status,
        result.method,
        albumId,
    );
}

function updateTrackIdentityColumns(
    mediaId: string,
    result: MetadataIdentityResult,
    options: {
        recordingId?: string | null;
        acoustidId?: string | null;
        fingerprint?: string | null;
        fingerprintDuration?: number | null;
    } = {},
): void {
    db.prepare(`
        UPDATE media SET
            mbid = COALESCE(?, mbid),
            acoustid_id = COALESCE(?, acoustid_id),
            acoustid_fingerprint = COALESCE(?, acoustid_fingerprint),
            fingerprint_duration = COALESCE(?, fingerprint_duration),
            musicbrainz_status = ?,
            musicbrainz_last_checked = CURRENT_TIMESTAMP,
            musicbrainz_match_method = ?
        WHERE id = ?
    `).run(
        options.recordingId || null,
        options.acoustidId || null,
        options.fingerprint || null,
        options.fingerprintDuration || null,
        result.status,
        result.method,
        mediaId,
    );

    if (options.fingerprint || options.acoustidId || options.fingerprintDuration) {
        db.prepare(`
            UPDATE library_files SET
                fingerprint = COALESCE(?, fingerprint),
                acoustid_id = COALESCE(?, acoustid_id),
                fingerprint_duration = COALESCE(?, fingerprint_duration)
            WHERE media_id = ?
              AND file_type = 'track'
        `).run(options.fingerprint || null, options.acoustidId || null, options.fingerprintDuration || null, mediaId);
    }
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

function scoreReleaseCandidate(album: AlbumRow, release: MusicBrainzRelease, method: string): number {
    const titleScore = stringSimilarity(normalizeText(album.title), normalizeText(release.title));
    const artistScore = stringSimilarity(normalizeText(album.artist_name), normalizeText(artistCreditNames(release.artistCredits)));
    const barcodeScore = album.upc && release.barcode && album.upc.replace(/\D/g, "") === release.barcode.replace(/\D/g, "") ? 1 : 0;
    const dateScore = isSameYear(album.release_date, release.date) ? 1 : 0;

    if (method === "barcode") {
        return clampConfidence((barcodeScore * 0.55) + (titleScore * 0.3) + (artistScore * 0.1) + (dateScore * 0.05));
    }

    return clampConfidence((titleScore * 0.55) + (artistScore * 0.3) + (dateScore * 0.15));
}

async function searchMusicBrainzReleases(album: AlbumRow): Promise<MusicBrainzRelease[]> {
    const artistName = String(album.artist_name || "").trim();
    const title = String(album.title || "").trim();
    if (!artistName || !title) return [];

    const dateYear = yearOf(album.release_date);
    const queryParts = [`release:"${title.replace(/"/g, "")}"`, `artist:"${artistName.replace(/"/g, "")}"`];
    if (dateYear) queryParts.push(`date:${dateYear}`);
    const url = `https://musicbrainz.org/ws/2/release?fmt=json&limit=10&query=${encodeURIComponent(queryParts.join(" AND "))}`;
    const data = await requestMusicBrainzJson<any>(url);
    const releases = Array.isArray(data?.releases) ? data.releases : [];

    return releases.map((release: any) => ({
        id: String(release?.id || "").trim(),
        title: String(release?.title || "").trim(),
        barcode: String(release?.barcode || "").trim() || null,
        date: String(release?.date || "").trim() || null,
        country: String(release?.country || "").trim() || null,
        status: String(release?.status || "").trim() || null,
        releaseGroupId: String(release?.["release-group"]?.id || "").trim() || null,
        releaseGroupPrimaryType: getReleaseGroupPrimaryType(release),
        releaseGroupSecondaryTypes: getReleaseGroupSecondaryTypes(release),
        artistCredits: Array.isArray(release?.["artist-credit"])
            ? release["artist-credit"].map((credit: any) => ({
                id: String(credit?.artist?.id || "").trim(),
                name: String(credit?.name || credit?.artist?.name || "").trim(),
            })).filter((credit: MusicBrainzArtistCredit) => Boolean(credit.id && credit.name))
            : [],
    })).filter((release: MusicBrainzRelease) => Boolean(release.id && release.title));
}

async function lookupReleaseTracks(releaseId: string): Promise<ReleaseTrackCandidate[]> {
    if (!releaseId) return [];
    const url = `https://musicbrainz.org/ws/2/release/${encodeURIComponent(releaseId)}?fmt=json&inc=recordings+artist-credits+isrcs`;
    const data = await requestMusicBrainzJson<any>(url);
    const media = Array.isArray(data?.media) ? data.media : [];
    const candidates: ReleaseTrackCandidate[] = [];

    for (const medium of media) {
        const mediumNumber = Number.isFinite(Number(medium?.position)) ? Number(medium.position) : null;
        const tracks = Array.isArray(medium?.tracks) ? medium.tracks : [];
        for (const track of tracks) {
            const recording = track?.recording || {};
            const recordingId = String(recording?.id || "").trim();
            if (!recordingId) continue;

            const artistCredits = Array.isArray(recording?.["artist-credit"])
                ? recording["artist-credit"].map((credit: any) => ({
                    id: String(credit?.artist?.id || "").trim(),
                    name: String(credit?.name || credit?.artist?.name || "").trim(),
                })).filter((credit: MusicBrainzArtistCredit) => Boolean(credit.id && credit.name))
                : [];
            const length = typeof recording?.length === "number" && Number.isFinite(recording.length)
                ? Math.round(recording.length / 1000)
                : null;

            candidates.push({
                recordingId,
                title: String(recording?.title || track?.title || "").trim(),
                mediumNumber,
                position: Number.isFinite(Number(track?.position)) ? Number(track.position) : null,
                durationSeconds: length,
                artistCredits,
                isrcs: Array.isArray(recording?.isrcs) ? recording.isrcs.filter(Boolean) : [],
            });
        }
    }

    return candidates;
}

function scoreRecording(track: TrackRow, recording: MusicBrainzRecording, method: "isrc" | "acoustid"): number {
    const titleScore = stringSimilarity(normalizeText(track.title), normalizeText(recording.title));
    const artistScore = stringSimilarity(normalizeText(track.artist_name), normalizeText(recording.artists.join(" ")));
    const duration = durationScore(track.duration, recording.durationSeconds);
    const isrcScore = track.isrc && recording.isrcs.map((isrc) => isrc.toUpperCase()).includes(track.isrc.toUpperCase()) ? 1 : 0;

    if (method === "isrc") {
        return clampConfidence((isrcScore * 0.6) + (titleScore * 0.25) + (artistScore * 0.1) + (duration * 0.05));
    }

    return clampConfidence((titleScore * 0.45) + (artistScore * 0.25) + (duration * 0.15) + (isrcScore * 0.15));
}

function scoreReleaseTrack(track: TrackRow, candidate: ReleaseTrackCandidate): number {
    const positionScore = Number(track.track_number || 0) > 0 && Number(track.track_number) === Number(candidate.position || 0) ? 1 : 0;
    const mediumScore = Number(track.volume_number || 1) === Number(candidate.mediumNumber || 1) ? 1 : 0;
    const titleScore = stringSimilarity(normalizeText(track.title), normalizeText(candidate.title));
    const artistScore = stringSimilarity(normalizeText(track.artist_name), normalizeText(artistCreditNames(candidate.artistCredits)));
    const duration = durationScore(track.duration, candidate.durationSeconds);
    const isrcScore = track.isrc && candidate.isrcs.map((isrc) => isrc.toUpperCase()).includes(track.isrc.toUpperCase()) ? 1 : 0;

    return clampConfidence((positionScore * 0.28) + (mediumScore * 0.12) + (titleScore * 0.32) + (artistScore * 0.08) + (duration * 0.08) + (isrcScore * 0.12));
}

function getBestReleaseTrackMatch(track: TrackRow, releaseTracks: ReleaseTrackCandidate[]): ReleaseTrackCandidate | null {
    const scored = releaseTracks
        .map((candidate) => ({ candidate, score: scoreReleaseTrack(track, candidate) }))
        .sort((left, right) => right.score - left.score);

    if (scored.length === 0 || scored[0].score < 0.76) {
        return null;
    }

    const second = scored[1]?.score ?? 0;
    if (second > 0 && scored[0].score - second < 0.04) {
        return null;
    }

    return scored[0].candidate;
}

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
        const artist = db.prepare("SELECT id, name, mbid FROM artists WHERE id = ?").get(artistId) as ArtistRow | undefined;
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

    static async resolveAlbum(albumId: string, options: { force?: boolean; includeTracks?: boolean } = {}): Promise<MetadataIdentityResult> {
        const album = db.prepare(`
            SELECT
                a.id,
                a.artist_id,
                a.title,
                a.release_date,
                a.upc,
                a.mbid,
                a.mb_release_group_id,
                ar.name AS artist_name,
                ar.mbid AS artist_mbid
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
            WHERE a.id = ?
        `).get(albumId) as AlbumRow | undefined;

        if (!album) {
            const result = this.result("album", albumId, "error", 0, "local-row", "Album is not in the Discogenius database");
            recordIdentityStatus(result);
            return result;
        }

        if (album.artist_id) {
            await this.resolveArtist(String(album.artist_id), { force: false });
        }

        if (album.mbid && album.mb_release_group_id && !options.force) {
            const result = this.result("album", albumId, "verified", 1, "existing-mbid", undefined, {
                releaseId: album.mbid,
                releaseGroupId: album.mb_release_group_id,
            });
            recordIdentityStatus(result);
            updateAlbumIdentityColumns(albumId, result, { id: album.mbid, releaseGroupId: album.mb_release_group_id });
            if (options.includeTracks) {
                await this.resolveAlbumTracks(albumId, { force: false });
            }
            return result;
        }

        try {
            const barcodeCandidates = album.upc ? await lookupMusicBrainzReleasesByBarcode(album.upc) : [];
            const barcodeScored = barcodeCandidates
                .map((release) => ({ release, score: scoreReleaseCandidate(album, release, "barcode") }))
                .sort((left, right) => right.score - left.score);
            let method = "barcode";
            let best = barcodeScored[0];

            if (!best || best.score < 0.78) {
                method = "release-search";
                best = (await searchMusicBrainzReleases(album))
                    .map((release) => ({ release, score: scoreReleaseCandidate(album, release, "search") }))
                    .sort((left, right) => right.score - left.score)[0];
            }

            if (!best) {
                const result = this.result("album", albumId, "unmatched", 0, method, "No MusicBrainz release candidate found");
                recordIdentityStatus(result);
                updateAlbumIdentityColumns(albumId, result);
                return result;
            }

            if (best.score < 0.78) {
                const result = this.result("album", albumId, "ambiguous", best.score, method, "MusicBrainz release match is below confidence threshold", {
                    releaseId: best.release.id,
                    title: best.release.title,
                    releaseGroupId: best.release.releaseGroupId,
                    releaseGroupPrimaryType: best.release.releaseGroupPrimaryType,
                    releaseGroupSecondaryTypes: best.release.releaseGroupSecondaryTypes,
                });
                recordIdentityStatus(result);
                updateAlbumIdentityColumns(albumId, result);
                return result;
            }

            const result = this.result("album", albumId, "verified", best.score, method, undefined, {
                releaseId: best.release.id,
                releaseGroupId: best.release.releaseGroupId,
                releaseGroupPrimaryType: best.release.releaseGroupPrimaryType,
                releaseGroupSecondaryTypes: best.release.releaseGroupSecondaryTypes,
                title: best.release.title,
                barcode: best.release.barcode,
            });
            recordIdentityStatus(result);
            updateAlbumIdentityColumns(albumId, result, best.release);

            if (options.includeTracks) {
                await this.resolveAlbumTracks(albumId, { force: false, releaseId: best.release.id });
            }

            return result;
        } catch (error) {
            const result = this.result("album", albumId, "error", 0, "release-lookup", error instanceof Error ? error.message : String(error));
            recordIdentityStatus(result);
            updateAlbumIdentityColumns(albumId, result);
            return result;
        }
    }

    static async resolveAlbumTracks(
        albumId: string,
        options: { force?: boolean; releaseId?: string | null } = {},
    ): Promise<MetadataIdentityResult[]> {
        const releaseId = options.releaseId
            || (db.prepare("SELECT mbid FROM albums WHERE id = ?").get(albumId) as { mbid?: string | null } | undefined)?.mbid
            || null;
        let releaseTracks: ReleaseTrackCandidate[] = [];

        if (releaseId) {
            try {
                releaseTracks = await lookupReleaseTracks(releaseId);
            } catch (error) {
                console.warn(`[MetadataIdentity] Failed to fetch MusicBrainz release tracks for ${releaseId}:`, error);
            }
        }

        const tracks = db.prepare(`
            SELECT id FROM media
            WHERE album_id = ? AND type != 'Music Video'
            ORDER BY COALESCE(volume_number, 1), COALESCE(track_number, 0), id
        `).all(albumId) as Array<{ id: number }>;

        const results: MetadataIdentityResult[] = [];
        for (const track of tracks) {
            results.push(await this.resolveTrack(String(track.id), {
                force: options.force,
                releaseTracks,
            }));
        }
        return results;
    }

    static async resolveTrack(
        mediaId: string,
        options: {
            force?: boolean;
            filePath?: string;
            releaseTracks?: ReleaseTrackCandidate[];
        } = {},
    ): Promise<MetadataIdentityResult> {
        const track = db.prepare(`
            SELECT
                m.id,
                m.artist_id,
                m.album_id,
                m.title,
                m.duration,
                m.track_number,
                m.volume_number,
                m.isrc,
                m.mbid,
                m.acoustid_id,
                m.acoustid_fingerprint,
                ar.name AS artist_name,
                ar.mbid AS artist_mbid,
                al.title AS album_title,
                al.mbid AS album_mbid
            FROM media m
            LEFT JOIN artists ar ON ar.id = m.artist_id
            LEFT JOIN albums al ON al.id = m.album_id
            WHERE m.id = ?
        `).get(mediaId) as TrackRow | undefined;

        if (!track) {
            const result = this.result("track", mediaId, "error", 0, "local-row", "Track is not in the Discogenius database");
            recordIdentityStatus(result);
            return result;
        }

        if (track.mbid && !options.force) {
            const result = this.result("track", mediaId, "verified", 1, "existing-mbid", undefined, { recordingId: track.mbid });
            recordIdentityStatus(result);
            updateTrackIdentityColumns(mediaId, result, { recordingId: track.mbid });
            return result;
        }

        try {
            const evidence: TrackResolutionEvidence[] = [];

            if (track.isrc) {
                const recordings = await lookupMusicBrainzRecordingsByIsrc(track.isrc);
                for (const recording of recordings) {
                    evidence.push({
                        recording,
                        confidence: scoreRecording(track, recording, "isrc"),
                        method: "isrc",
                    });
                }
            }

            const releaseTracks = options.releaseTracks || [];
            const releaseTrack = getBestReleaseTrackMatch(track, releaseTracks);
            if (releaseTrack) {
                const recording = await lookupMusicBrainzRecording(releaseTrack.recordingId);
                if (recording) {
                    evidence.push({
                        recording,
                        confidence: scoreReleaseTrack(track, releaseTrack),
                        method: "release-tracklist",
                    });
                }
            }

            const tagConfig = getConfigSection("metadata");
            const filePath = options.filePath || this.findBestTrackFile(mediaId);
            if (tagConfig.enable_fingerprinting && filePath && fs.existsSync(filePath)) {
                try {
                    const fingerprint = await generateFingerprint(filePath);
                    const acoustidMatches = await lookupAcoustIdMatches(fingerprint.fingerprint, fingerprint.duration);
                    for (const acoustid of acoustidMatches) {
                        for (const recordingId of acoustid.recordingIds) {
                            const recording = await lookupMusicBrainzRecording(recordingId);
                            if (!recording) continue;
                            const metadataScore = scoreRecording(track, recording, "acoustid");
                            const acoustidScore = acoustid.score ?? 0;
                            evidence.push({
                                recording,
                                confidence: clampConfidence((acoustidScore * 0.6) + (metadataScore * 0.4)),
                                method: "acoustid",
                                acoustid,
                                fingerprint: fingerprint.fingerprint,
                                fingerprintDuration: fingerprint.duration,
                            });
                        }
                    }

                    if (acoustidMatches[0]?.id || fingerprint.fingerprint) {
                        db.prepare(`
                            UPDATE media SET
                                acoustid_id = COALESCE(?, acoustid_id),
                                acoustid_fingerprint = COALESCE(?, acoustid_fingerprint),
                                fingerprint_duration = COALESCE(?, fingerprint_duration)
                            WHERE id = ?
                        `).run(acoustidMatches[0]?.id || null, fingerprint.fingerprint, fingerprint.duration, mediaId);
                    }
                } catch (error) {
                    console.warn(`[MetadataIdentity] Failed to fingerprint ${filePath}:`, error);
                }
            }

            const scored = evidence.sort((left, right) => right.confidence - left.confidence);
            const best = scored[0];
            if (!best) {
                const result = this.result("track", mediaId, "unmatched", 0, "track-lookup", "No MusicBrainz recording candidate found");
                recordIdentityStatus(result);
                updateTrackIdentityColumns(mediaId, result);
                return result;
            }

            const second = scored[1]?.confidence ?? 0;
            if (best.confidence < 0.78 || (second > 0 && best.confidence - second < 0.04)) {
                const result = this.result("track", mediaId, "ambiguous", best.confidence, best.method, "MusicBrainz recording match is ambiguous", {
                    candidates: scored.slice(0, 5).map((item) => ({
                        recordingId: item.recording.id,
                        title: item.recording.title,
                        confidence: item.confidence,
                        method: item.method,
                    })),
                });
                recordIdentityStatus(result);
                updateTrackIdentityColumns(mediaId, result, {
                    acoustidId: best.acoustid?.id || null,
                    fingerprint: best.fingerprint || null,
                    fingerprintDuration: best.fingerprintDuration || null,
                });
                return result;
            }

            const result = this.result("track", mediaId, "verified", best.confidence, best.method, undefined, {
                recordingId: best.recording.id,
                title: best.recording.title,
                acoustidId: best.acoustid?.id || null,
            });
            recordIdentityStatus(result);
            updateTrackIdentityColumns(mediaId, result, {
                recordingId: best.recording.id,
                acoustidId: best.acoustid?.id || null,
                fingerprint: best.fingerprint || null,
                fingerprintDuration: best.fingerprintDuration || null,
            });
            return result;
        } catch (error) {
            const result = this.result("track", mediaId, "error", 0, "track-lookup", error instanceof Error ? error.message : String(error));
            recordIdentityStatus(result);
            updateTrackIdentityColumns(mediaId, result);
            return result;
        }
    }

    static markVideoKnown(videoId: string): MetadataIdentityResult {
        const result = this.result("video", videoId, "unmatched", 1, "not-applicable", "Music videos generally do not have MusicBrainz recording IDs");
        recordIdentityStatus(result);
        return result;
    }

    private static findBestTrackFile(mediaId: string): string | null {
        const row = db.prepare(`
            SELECT file_path, relative_path, library_root
            FROM library_files
            WHERE media_id = ? AND file_type = 'track'
            ORDER BY verified_at DESC, id DESC
            LIMIT 1
        `).get(mediaId) as { file_path?: string | null; relative_path?: string | null; library_root?: string | null } | undefined;

        if (!row?.file_path) return null;

        return resolveStoredLibraryPath({
            filePath: row.file_path,
            relativePath: row.relative_path,
            libraryRoot: row.library_root,
        });
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
