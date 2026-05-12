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

export class RefreshVideoService {
    static upsertArtistVideos(artistId: string, videos: any[], options: ScanOptions = {}): void {
        const forceUpdate = options.forceUpdate === true;
        const videoInsert = db.prepare(`
            INSERT INTO media (
                id, artist_id, album_id, title, duration, release_date, version,
                explicit, type, quality, popularity, cover, monitor, last_scanned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const videoUpdate = db.prepare(`
            UPDATE media SET
                title = ?, duration = ?, release_date = ?, version = ?,
                explicit = ?, quality = ?, popularity = ?,
                ${forceUpdate ? "cover = ?" : "cover = COALESCE(?, cover)"},
                last_scanned = CURRENT_TIMESTAMP
            WHERE id = ? AND type = 'Music Video'
        `);

        const selectVideo = db.prepare(
            "SELECT id, monitor, monitor_lock FROM media WHERE id = ? AND type = 'Music Video'",
        );
        const upsertIdentity = db.prepare(`
            INSERT INTO provider_video_identity (
                identity_key, title, artist_name, artist_mbid, recording_mbid,
                duration_bucket, match_method, confidence, data, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(identity_key) DO UPDATE SET
                title = COALESCE(excluded.title, provider_video_identity.title),
                artist_name = COALESCE(excluded.artist_name, provider_video_identity.artist_name),
                artist_mbid = COALESCE(excluded.artist_mbid, provider_video_identity.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, provider_video_identity.recording_mbid),
                duration_bucket = COALESCE(excluded.duration_bucket, provider_video_identity.duration_bucket),
                match_method = CASE
                    WHEN excluded.confidence >= provider_video_identity.confidence THEN excluded.match_method
                    ELSE provider_video_identity.match_method
                END,
                confidence = MAX(provider_video_identity.confidence, excluded.confidence),
                data = COALESCE(excluded.data, provider_video_identity.data),
                updated_at = CURRENT_TIMESTAMP
        `);
        const upsertProviderVideo = db.prepare(`
            INSERT INTO provider_video_items (
                provider, provider_id, identity_key, media_id, title, artist_name,
                artist_mbid, recording_mbid, duration, release_date, url, cover,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, provider_id) DO UPDATE SET
                identity_key = excluded.identity_key,
                media_id = excluded.media_id,
                title = excluded.title,
                artist_name = excluded.artist_name,
                artist_mbid = COALESCE(excluded.artist_mbid, provider_video_items.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, provider_video_items.recording_mbid),
                duration = excluded.duration,
                release_date = excluded.release_date,
                url = excluded.url,
                cover = COALESCE(excluded.cover, provider_video_items.cover),
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
        `);
        const upsertProviderItem = db.prepare(`
            INSERT INTO provider_items (
                provider, entity_type, provider_id, artist_mbid, recording_mbid,
                title, quality, duration, release_date, availability,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                artist_mbid = COALESCE(excluded.artist_mbid, provider_items.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, provider_items.recording_mbid),
                title = excluded.title,
                quality = excluded.quality,
                duration = excluded.duration,
                release_date = excluded.release_date,
                availability = excluded.availability,
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
                const identity = buildVideoIdentity(video);
                const bucket = durationBucket(video.duration);
                const recordingMbid = String(video.mbid || video.recording_mbid || "").trim() || null;
                const artistMbid = String(video.artist_mbid || video.mb_artist_mbid || "").trim() || null;

                let shouldMonitor = exists?.monitor || 0;
                if (exists?.monitor_lock) {
                    shouldMonitor = exists.monitor;
                }

                const quality = video.quality || "MP4_1080P";
                const cover = video.image_id || null;

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
                        shouldMonitor,
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
                        video.tidal_id,
                    );
                }

                upsertIdentity.run(
                    identity.key,
                    video.title,
                    video.artist_name || null,
                    artistMbid,
                    recordingMbid,
                    bucket,
                    identity.method,
                    identity.confidence,
                    JSON.stringify(video),
                );
                upsertProviderVideo.run(
                    provider,
                    String(video.tidal_id),
                    identity.key,
                    String(video.tidal_id),
                    video.title,
                    video.artist_name || null,
                    artistMbid,
                    recordingMbid,
                    video.duration || null,
                    video.release_date || null,
                    video.url || null,
                    cover,
                    identity.confidence >= 0.9 ? "verified" : "probable",
                    identity.confidence,
                    identity.method,
                    JSON.stringify(identity.evidence),
                    JSON.stringify(video),
                );
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
                    identity.confidence >= 0.9 ? "verified" : "probable",
                    identity.confidence,
                    identity.method,
                    JSON.stringify(identity.evidence),
                    JSON.stringify(video),
                );
            }
        })();
    }
}
