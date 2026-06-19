import { db } from "../../database.js";
import type { ScanOptions } from "./scan-types.js";

type AudioRecordingVideoMatch = {
    id: number;
    mbid: string | null;
    confidence: number;
    method: string;
    evidence: Record<string, unknown>;
};

function normalizeVideoText(value: unknown): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function normalizeVideoComparableTitle(value: unknown): string {
    return normalizeVideoText(value)
        .replace(/\b(official|music|lyric|lyrics|audio|visualizer|visualiser|video|hd|hq|4k|remaster(?:ed)?|live|performance)\b/g, " ")
        .replace(/\s+/g, " ")
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
        SELECT id
        FROM ArtistMetadata
        WHERE foreign_artist_id = ? OR mbid = ?
        LIMIT 1
    `).get(artistMbid, artistMbid) as { id?: number | null } | undefined;
    return row?.id == null ? null : Number(row.id);
}

function getRecordingIdByForeignId(recordingMbid: string | null): number | null {
    if (!recordingMbid) {
        return null;
    }
    const row = db.prepare(`
        SELECT id
        FROM Recordings
        WHERE foreign_recording_id = ? OR mbid = ?
        LIMIT 1
    `).get(recordingMbid, recordingMbid) as { id?: number | null } | undefined;
    return row?.id == null ? null : Number(row.id);
}

function parseIsrcValues(value: unknown): string[] {
    const values = new Set<string>();
    const add = (candidate: unknown) => {
        const normalized = String(candidate ?? "").trim().toUpperCase();
        if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized)) {
            values.add(normalized);
        }
    };

    add(value);
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                parsed.forEach(add);
            }
        } catch {
            value.split(/[,\s;|]+/).forEach(add);
        }
    } else if (Array.isArray(value)) {
        value.forEach(add);
    }

    return [...values];
}

function findRelatedAudioRecordingForVideo(video: any, artistMbid: string | null): AudioRecordingVideoMatch | null {
    const normalizedArtistMbid = nullableText(artistMbid);
    const videoTitle = normalizeVideoComparableTitle(video.title);
    if (!normalizedArtistMbid || !videoTitle) {
        return null;
    }

    const videoDurationMs = durationMs(video.duration);
    const videoIsrcs = parseIsrcValues(video.isrc ?? video.isrcs);
    // Recordings created from MusicBrainz tracklists don't carry artist_mbid,
    // so resolve the artist's audio recordings through their release groups —
    // matching against Recordings.artist_mbid alone returns nothing.
    const rows = db.prepare(`
        SELECT DISTINCT rec.id, rec.mbid, rec.title, rec.length_ms, rec.isrcs
        FROM Recordings rec
        LEFT JOIN Tracks t ON t.recording_mbid = rec.mbid
        LEFT JOIN AlbumReleases ar ON ar.mbid = t.release_mbid
        LEFT JOIN Albums rg ON rg.mbid = ar.release_group_mbid
        LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
        WHERE COALESCE(rec.is_video, 0) = 0
          AND (rec.artist_mbid = ? OR rg.artist_mbid = ? OR scope.artist_mbid = ?)
    `).all(normalizedArtistMbid, normalizedArtistMbid, normalizedArtistMbid) as Array<{
        id: number;
        mbid?: string | null;
        title?: string | null;
        length_ms?: number | null;
        isrcs?: string | null;
    }>;

    let best: AudioRecordingVideoMatch | null = null;
    for (const row of rows) {
        const audioTitle = normalizeVideoComparableTitle(row.title);
        if (!audioTitle) {
            continue;
        }

        const audioIsrcs = parseIsrcValues(row.isrcs);
        const isrcOverlap = videoIsrcs.some((isrc) => audioIsrcs.includes(isrc));
        const exactTitle = videoTitle === audioTitle;
        const containedTitle = videoTitle.includes(audioTitle) || audioTitle.includes(videoTitle);
        if (!isrcOverlap && !exactTitle && !containedTitle) {
            continue;
        }

        const audioDurationMs = Number(row.length_ms || 0);
        const durationDiffMs = videoDurationMs && audioDurationMs ? Math.abs(videoDurationMs - audioDurationMs) : null;
        const durationCompatible = durationDiffMs == null || durationDiffMs <= 45_000;
        if (!isrcOverlap && !durationCompatible) {
            continue;
        }

        const confidence = isrcOverlap
            ? 0.95
            : exactTitle && durationCompatible
                ? 0.84
                : containedTitle && durationCompatible
                    ? 0.72
                    : 0.62;
        if (!best || confidence > best.confidence) {
            best = {
                id: Number(row.id),
                mbid: nullableText(row.mbid),
                confidence,
                method: isrcOverlap
                    ? "provider-video-isrc-recording"
                    : exactTitle
                        ? "provider-video-title-recording"
                        : "provider-video-contained-title-recording",
                evidence: {
                    videoTitle: video.title ?? null,
                    normalizedVideoTitle: videoTitle,
                    audioTitle: row.title ?? null,
                    normalizedAudioTitle: audioTitle,
                    isrcOverlap,
                    durationDiffMs,
                },
            };
        }
    }

    return best;
}

function upsertProviderVideoAudioRelation(input: {
    videoRecordingId: number | null;
    videoRecordingMbid: string | null;
    audioMatch: AudioRecordingVideoMatch | null;
    provider: string;
}): void {
    if (!input.videoRecordingId || !input.audioMatch) {
        return;
    }

    db.prepare(`
        INSERT INTO RecordingRelations (
            source_recording_id, target_recording_id, source_foreign_recording_id,
            target_foreign_recording_id, relation_type, source, confidence, data, updated_at
        ) VALUES (?, ?, ?, ?, 'provider_video_for', ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_recording_id, target_recording_id, relation_type) DO UPDATE SET
            source_foreign_recording_id = COALESCE(excluded.source_foreign_recording_id, RecordingRelations.source_foreign_recording_id),
            target_foreign_recording_id = COALESCE(excluded.target_foreign_recording_id, RecordingRelations.target_foreign_recording_id),
            source = excluded.source,
            confidence = excluded.confidence,
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        input.videoRecordingId,
        input.audioMatch.id,
        input.videoRecordingMbid,
        input.audioMatch.mbid,
        input.provider,
        input.audioMatch.confidence,
        JSON.stringify({
            method: input.audioMatch.method,
            evidence: input.audioMatch.evidence,
        }),
    );
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
                foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title,
                artist_credit, length_ms, is_video, metadata_status, data, updated_at
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
                artist_metadata_id = COALESCE(artist_metadata_id, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = COALESCE(NULLIF(?, ''), title),
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                is_video = 1,
                metadata_status = 'musicbrainz',
                data = COALESCE(?, data),
                updated_at = CURRENT_TIMESTAMP
            WHERE foreign_recording_id = ? OR mbid = ?
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
                artist_metadata_id = COALESCE(artist_metadata_id, ?),
                artist_mbid = COALESCE(artist_mbid, ?),
                title = COALESCE(NULLIF(?, ''), title),
                artist_credit = COALESCE(artist_credit, ?),
                length_ms = COALESCE(?, length_ms),
                is_video = 1,
                metadata_status = CASE
                    WHEN foreign_recording_id IS NULL THEN 'provider_only'
                    ELSE metadata_status
                END,
                data = COALESCE(?, data),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
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
            artist_metadata_id, artist_mbid, title, artist_credit, length_ms,
            is_video, metadata_status, data, updated_at
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
        const selectProviderItem = db.prepare(`
            SELECT recording_id
            FROM ProviderItems
            WHERE provider = ? AND entity_type = 'video' AND provider_id = ?
            LIMIT 1
        `);
        const updateRecordingState = db.prepare(`
            UPDATE Recordings
            SET
                release_date = COALESCE(?, release_date),
                cover_image_id = COALESCE(?, cover_image_id),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        const upsertProviderItem = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, provider_album_id, artist_mbid, recording_mbid,
                title, quality, duration, release_date, availability,
                library_slot, recording_id, provider_url, asset_id,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                provider_album_id = COALESCE(excluded.provider_album_id, ProviderItems.provider_album_id),
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
                const provider = String(video.provider || video._provider || "tidal");
                const existingProviderItem = selectProviderItem.get(provider, String(video.provider_id)) as { recording_id?: number | null } | undefined;
                const identity = buildVideoIdentity(video);
                const recordingMbid = String(video.mbid || video.recording_mbid || "").trim() || null;
                const artistMbid = String(video.artist_mbid || video.mb_artist_mbid || "").trim() || getArtistMusicBrainzId(artistId);
                const recordingId = ensureProviderVideoRecording({
                    video,
                    artistMbid,
                    existingRecordingId: existingProviderItem?.recording_id ?? null,
                });

                const quality = video.quality || "MP4_1080P";
                const cover = video.image_id || null;
                const audioMatch = findRelatedAudioRecordingForVideo(video, artistMbid);

                if (recordingId) {
                    updateRecordingState.run(
                        nullableText(video.release_date),
                        nullableText(cover),
                        recordingId,
                    );
                    upsertProviderVideoAudioRelation({
                        videoRecordingId: recordingId,
                        videoRecordingMbid: recordingMbid,
                        audioMatch,
                        provider,
                    });
                }

                upsertProviderItem.run(
                    provider,
                    String(video.provider_id),
                    nullableText(video.album_id),
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
