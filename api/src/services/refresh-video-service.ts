import { db } from "../database.js";
import type { ScanOptions } from "./scan-types.js";

function normalizeVideoText(value: unknown): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function normalizeProviderUrl(value: unknown): string | null {
    const raw = String(value || "").trim();
    if (!raw) {
        return null;
    }

    try {
        const url = new URL(raw);
        url.hash = "";
        url.search = "";
        return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        return raw.toLowerCase();
    }
}

function durationBucket(durationSeconds: unknown): number | null {
    const duration = Number(durationSeconds || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }

    return Math.round(duration / 5) * 5;
}

function buildVideoIdentity(video: any): { key: string; method: string; confidence: number; evidence: Record<string, unknown> } {
    const recordingMbid = String(video.mbid || video.recording_mbid || "").trim();
    if (recordingMbid) {
        return {
            key: `mb-recording:${recordingMbid}`,
            method: "musicbrainz-recording",
            confidence: 0.98,
            evidence: { recordingMbid },
        };
    }

    const normalizedUrl = normalizeProviderUrl(video.url);
    if (normalizedUrl) {
        return {
            key: `url:${normalizedUrl}`,
            method: "provider-url",
            confidence: 0.9,
            evidence: { url: video.url },
        };
    }

    const title = normalizeVideoText(video.title);
    const artist = normalizeVideoText(video.artist_name);
    const bucket = durationBucket(video.duration);
    return {
        key: `fingerprint:${artist}:${title}:${bucket ?? "unknown"}`,
        method: "title-artist-duration",
        confidence: bucket == null ? 0.62 : 0.78,
        evidence: {
            normalizedTitle: title,
            normalizedArtist: artist,
            durationBucket: bucket,
        },
    };
}

function nullableText(value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text.length > 0 ? text : null;
}

function durationMs(durationSeconds: unknown): number | null {
    const duration = Number(durationSeconds || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }
    return Math.round(duration * 1000);
}

function serializeArtistCredits(artists: unknown): string | null {
    if (!Array.isArray(artists) || artists.length === 0) {
        return null;
    }

    return JSON.stringify(artists.map((artist: any) => ({
        id: nullableText(artist?.id ?? artist?.providerId),
        name: nullableText(artist?.name),
    })).filter((artist) => artist.id || artist.name));
}

function getArtistMusicBrainzId(artistId: string): string | null {
    const row = db.prepare("SELECT mbid FROM Artists WHERE CAST(id AS TEXT) = CAST(? AS TEXT) LIMIT 1")
        .get(artistId) as { mbid?: string | null } | undefined;
    return nullableText(row?.mbid);
}

function getArtistMetadataId(artistMbid: string | null): number | null {
    if (!artistMbid) {
        return null;
    }
    const row = db.prepare(`
        SELECT Id
        FROM ArtistMetadata
        WHERE ForeignArtistId = ? OR mbid = ?
        LIMIT 1
    `).get(artistMbid, artistMbid) as { Id?: number | null } | undefined;
    return row?.Id == null ? null : Number(row.Id);
}

function getRecordingIdByForeignId(recordingMbid: string | null): number | null {
    if (!recordingMbid) {
        return null;
    }
    const row = db.prepare(`
        SELECT Id
        FROM Recordings
        WHERE ForeignRecordingId = ? OR mbid = ?
        LIMIT 1
    `).get(recordingMbid, recordingMbid) as { Id?: number | null } | undefined;
    return row?.Id == null ? null : Number(row.Id);
}

function ensureProviderVideoRecording(input: {
    video: any;
    artistMbid: string | null;
    existingRecordingId?: number | null;
}): number | null {
    const recordingMbid = nullableText(input.video.mbid) ?? nullableText(input.video.recording_mbid);
    const artistMbid = nullableText(input.video.artist_mbid) ?? nullableText(input.video.mb_artist_mbid) ?? input.artistMbid;
    const artistMetadataId = getArtistMetadataId(artistMbid);
    const title = nullableText(input.video.title) ?? "Unknown Video";
    const lengthMs = durationMs(input.video.duration);
    const data = input.video.raw ? JSON.stringify({ raw: input.video.raw }) : null;

    if (recordingMbid) {
        db.prepare(`
            INSERT OR IGNORE INTO Recordings (
                ForeignRecordingId, mbid, ArtistMetadataId, artist_mbid, title,
                artist_credit, length_ms, IsVideo, MetadataStatus, data, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'musicbrainz', ?, CURRENT_TIMESTAMP)
        `).run(
            recordingMbid,
            recordingMbid,
            artistMetadataId,
            artistMbid,
            title,
            nullableText(input.video.artist_name),
            lengthMs,
            data,
        );

        db.prepare(`
            UPDATE Recordings
            SET
                ArtistMetadataId = COALESCE(ArtistMetadataId, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = COALESCE(NULLIF(?, ''), title),
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                IsVideo = 1,
                MetadataStatus = 'musicbrainz',
                data = COALESCE(?, data),
                updated_at = CURRENT_TIMESTAMP
            WHERE ForeignRecordingId = ? OR mbid = ?
        `).run(
            artistMetadataId,
            artistMbid,
            title,
            nullableText(input.video.artist_name),
            lengthMs,
            data,
            recordingMbid,
            recordingMbid,
        );

        return getRecordingIdByForeignId(recordingMbid);
    }

    if (input.existingRecordingId) {
        db.prepare(`
            UPDATE Recordings
            SET
                ArtistMetadataId = COALESCE(ArtistMetadataId, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = COALESCE(NULLIF(?, ''), title),
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                IsVideo = 1,
                MetadataStatus = CASE
                    WHEN ForeignRecordingId IS NULL THEN 'provider_only'
                    ELSE MetadataStatus
                END,
                data = COALESCE(?, data),
                updated_at = CURRENT_TIMESTAMP
            WHERE Id = ?
        `).run(
            artistMetadataId,
            artistMbid,
            title,
            nullableText(input.video.artist_name),
            lengthMs,
            data,
            input.existingRecordingId,
        );
        return input.existingRecordingId;
    }

    const result = db.prepare(`
        INSERT INTO Recordings (
            ArtistMetadataId, artist_mbid, title, artist_credit, length_ms,
            IsVideo, MetadataStatus, data, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'provider_only', ?, CURRENT_TIMESTAMP)
    `).run(
        artistMetadataId,
        artistMbid,
        title,
        nullableText(input.video.artist_name),
        lengthMs,
        data,
    );

    return Number(result.lastInsertRowid);
}

export class RefreshVideoService {
    static upsertArtistVideos(artistId: string, videos: any[], options: ScanOptions = {}): void {
        const forceUpdate = options.forceUpdate === true;
        const videoInsert = db.prepare(`
            INSERT INTO ProviderMedia (
                id, artist_id, album_id, title, duration, release_date, version,
                explicit, type, quality, popularity, cover, credits, monitor, mbid, last_scanned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const videoUpdate = db.prepare(`
            UPDATE ProviderMedia SET
                title = ?, duration = ?, release_date = ?, version = ?,
                explicit = ?, quality = ?, popularity = ?,
                ${forceUpdate ? "cover = ?" : "cover = COALESCE(?, cover)"},
                credits = COALESCE(?, credits),
                mbid = ?,
                last_scanned = CURRENT_TIMESTAMP
            WHERE id = ? AND type = 'Music Video'
        `);

        const selectVideo = db.prepare(
            "SELECT id, monitor, monitor_lock FROM ProviderMedia WHERE id = ? AND type = 'Music Video'",
        );
        const selectProviderItem = db.prepare(`
            SELECT recording_id
            FROM ProviderItems
            WHERE provider = ? AND entity_type = 'video' AND provider_id = ?
            LIMIT 1
        `);
        const upsertProviderItem = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, artist_mbid, recording_mbid,
                title, quality, duration, release_date, availability,
                library_slot, recording_id, provider_url, asset_id,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, ProviderItems.recording_mbid),
                title = excluded.title,
                quality = excluded.quality,
                duration = excluded.duration,
                release_date = excluded.release_date,
                availability = excluded.availability,
                library_slot = excluded.library_slot,
                recording_id = COALESCE(excluded.recording_id, ProviderItems.recording_id),
                provider_url = COALESCE(excluded.provider_url, ProviderItems.provider_url),
                asset_id = COALESCE(excluded.asset_id, ProviderItems.asset_id),
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
        `);

        db.transaction(() => {
            for (const video of videos) {
                const exists = selectVideo.get(video.tidal_id) as any;
                const provider = String(video.provider || video._provider || "tidal");
                const existingProviderItem = selectProviderItem.get(provider, String(video.tidal_id)) as { recording_id?: number | null } | undefined;
                const identity = buildVideoIdentity(video);
                const recordingMbid = String(video.mbid || video.recording_mbid || "").trim() || null;
                const artistMbid = String(video.artist_mbid || video.mb_artist_mbid || "").trim() || getArtistMusicBrainzId(artistId);
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId: existingProviderItem?.recording_id ?? null,
                });

                let shouldMonitor = exists?.monitor || 0;
                if (exists?.monitor_lock) {
                    shouldMonitor = exists.monitor;
                }

                const quality = video.quality || "MP4_1080P";
                const cover = video.image_id || null;
                const credits = serializeArtistCredits(video.artists);

                if (!exists) {
                    videoInsert.run(
                        video.tidal_id,
                        artistId,
                        video.album_id || null,
                        video.title,
                        video.duration,
                        video.release_date,
                        video.version || null,
                        video.explicit ? 1 : 0,
                        quality,
                        video.popularity || 0,
                        cover,
                        credits,
                        shouldMonitor,
                        recordingMbid,
                    );
                } else {
                    videoUpdate.run(
                        video.title,
                        video.duration,
                        video.release_date,
                        video.version || null,
                        video.explicit ? 1 : 0,
                        quality,
                        video.popularity || 0,
                        cover,
                        credits,
                        recordingMbid,
                        video.tidal_id,
                    );
                }

                upsertProviderItem.run(
                    provider,
                    String(video.tidal_id),
                    artistMbid,
                    recordingMbid,
                    video.title,
                    quality,
                    video.duration || null,
                    video.release_date || null,
                    "available",
                    recordingId,
                    nullableText(video.url),
                    nullableText(video.image_id),
                    identity.confidence >= 0.9 ? "verified" : "probable",
                    identity.confidence,
                    identity.method,
                    JSON.stringify(identity.evidence),
                    null,
                );
            }
        })();
    }
}
