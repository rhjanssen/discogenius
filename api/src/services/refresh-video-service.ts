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
            INSERT INTO ProviderMedia (
                id, artist_id, album_id, title, duration, release_date, version,
                explicit, type, quality, popularity, cover, monitor, mbid, last_scanned
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Music Video', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const videoUpdate = db.prepare(`
            UPDATE ProviderMedia SET
                title = ?, duration = ?, release_date = ?, version = ?,
                explicit = ?, quality = ?, popularity = ?,
                ${forceUpdate ? "cover = ?" : "cover = COALESCE(?, cover)"},
                mbid = ?,
                last_scanned = CURRENT_TIMESTAMP
            WHERE id = ? AND type = 'Music Video'
        `);

        const selectVideo = db.prepare(
            "SELECT id, monitor, monitor_lock FROM ProviderMedia WHERE id = ? AND type = 'Music Video'",
        );
        const upsertProviderItem = db.prepare(`
            INSERT INTO ProviderItems (
                provider, entity_type, provider_id, artist_mbid, recording_mbid,
                title, quality, duration, release_date, availability,
                match_status, match_confidence, match_method, match_evidence, data, updated_at
            ) VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(provider, entity_type, provider_id) DO UPDATE SET
                artist_mbid = COALESCE(excluded.artist_mbid, ProviderItems.artist_mbid),
                recording_mbid = COALESCE(excluded.recording_mbid, ProviderItems.recording_mbid),
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
