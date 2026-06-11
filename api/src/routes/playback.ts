/**
 * Playback routes — signed proxy stream to TIDAL CDN.
 *
 * GET /stream/sign/:trackId   → returns { url } with a time-limited HMAC-signed URL
 * GET /stream/play/:trackId   → validates signature, fetches from TIDAL CDN, pipes to client
 *
 * Browser preview intentionally stays on a Tidarr-style safe path:
 *   - prefers BTS/progressive, but falls back to DASH when that is all TIDAL offers
 *   - byte range support preserved for scrubbing/seeking
 *   - Spatial/Hi-Res requests fall back to browser-friendly stereo ladders
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { pipeline } from "stream";
import { promisify } from "util";
import { Readable } from "stream";
import { streamingProviderManager } from "../services/providers/index.js";
import type { ProviderPlaybackInfo, ProviderVideoPlaybackInfo } from "../services/providers/streaming-provider.js";
import { authMiddleware } from "../middleware/auth.js";
import { looksLikeMusicBrainzMbid, resolveProviderTrackForCanonicalTrack } from "../services/metadata/provider-track-resolver.js";
import { materializeSegmentedPlayback, parsePlaybackRange } from "../services/music/segmented-playback-cache.js";
import { db } from "../database.js";

const streamPipeline = promisify(pipeline);
const router = Router();
const PLAYBACK_QUALITIES = new Set(["DOLBY_ATMOS", "HIRES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"]);
const PLAYBACK_INFO_TTL_MS = 5 * 60 * 1000;
const playbackInfoCache = new Map<string, {
    expiresAt: number;
    promise: Promise<ProviderPlaybackInfo | null>;
}>();

// Use JWT_SECRET (same as auth) for HMAC signing
const getSecret = () => process.env.JWT_SECRET || "discogenius-stream-secret";

function normalizePlaybackQuality(value: unknown): string | null {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (!normalized) {
        return null;
    }

    return PLAYBACK_QUALITIES.has(normalized) ? normalized : null;
}

function resolvePlaybackProvider(providerId?: unknown) {
    const requested = String(providerId ?? "").trim();
    return requested
        ? streamingProviderManager.getStreamingProvider(requested)
        : streamingProviderManager.getDefaultStreamingProvider();
}

function signUrl(providerId: string, id: string, expires: number, quality?: string | null): string {
    const hmac = crypto.createHmac("sha256", getSecret());
    hmac.update(`${providerId}:${id}:${quality || ""}:${expires}`);
    return hmac.digest("hex");
}

function getCachedPlaybackInfo(
    providerId: string,
    trackId: string,
    quality: string | null,
    load: () => Promise<ProviderPlaybackInfo | null>,
) {
    const key = `${providerId}:${trackId}:${quality || "auto"}`;
    const cached = playbackInfoCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.promise;
    }

    const promise = load().catch((error) => {
        playbackInfoCache.delete(key);
        throw error;
    });
    playbackInfoCache.set(key, {
        expiresAt: Date.now() + PLAYBACK_INFO_TTL_MS,
        promise,
    });
    return promise;
}

/**
 * GET /stream/sign/:trackId
 * Returns a signed URL valid for 5 minutes.
 */
router.get("/stream/sign/:trackId", authMiddleware, async (req: Request, res: Response) => {
    let trackId = req.params.trackId as string;
    if (!trackId) return res.status(400).json({ error: "Missing trackId" });
    const requestedQuality = req.query.quality;
    let quality = normalizePlaybackQuality(requestedQuality);

    if (requestedQuality !== undefined && !quality) {
        return res.status(400).json({ error: "Unsupported playback quality" });
    }

    let providerId = "";
    try {
        const provider = resolvePlaybackProvider(req.query.provider);
        providerId = provider.id;
        if (!provider.getPlaybackInfo) {
            return res.status(501).json({ error: `${provider.name} does not support track preview` });
        }

        const releaseGroupMbid = String(req.query.releaseGroupMbid ?? "").trim();
        const canonicalTrackMbid = String(req.query.canonicalTrackMbid ?? "").trim();
        const canonicalRecordingMbid = String(req.query.canonicalRecordingMbid ?? "").trim();
        if (releaseGroupMbid && (canonicalTrackMbid || canonicalRecordingMbid || looksLikeMusicBrainzMbid(trackId))) {
            const resolved = await resolveProviderTrackForCanonicalTrack({
                releaseGroupMbid,
                canonicalTrackMbid: canonicalTrackMbid || (looksLikeMusicBrainzMbid(trackId) ? trackId : null),
                canonicalRecordingMbid: canonicalRecordingMbid || null,
                provider: providerId,
                slot: String(req.query.slot ?? "").trim() || null,
            });
            if (!resolved) {
                return res.status(409).json({ error: "provider track match not found" });
            }
            providerId = resolved.provider;
            trackId = resolved.providerTrackId;
            quality = quality ?? normalizePlaybackQuality(resolved.quality);
        }
    } catch (error: any) {
        return res.status(404).json({ error: error?.message || "provider not found" });
    }

    const expires = Math.floor(Date.now() / 1000) + 3600; // 1 h — must outlive a full album side
    const sig = signUrl(providerId, trackId, expires, quality);
    const qualityQuery = quality ? `&quality=${encodeURIComponent(quality)}` : "";
    const providerQuery = `&provider=${encodeURIComponent(providerId)}`;
    const signedQuery = `?exp=${expires}&sig=${sig}${providerQuery}${qualityQuery}`;
    const url = `/api/playback/stream/play/${trackId}${signedQuery}`;
    // DASH-backed tracks can stream progressively over HLS instead of waiting
    // for the proxy to materialize the whole file; the player probes this URL
    // first and falls back to `url` when the source is progressive-only.
    const hlsUrl = `/api/playback/stream/hls/${trackId}${signedQuery}`;

    res.json({ url, hlsUrl });
});

function verifySignedPlayback(req: Request): { ok: false; status: number; error: string } | {
    ok: true;
    providerId: string;
    quality: string | null;
} {
    const exp = String(req.query.exp ?? "") || undefined;
    const sig = String(req.query.sig ?? "") || undefined;
    const requestedQuality = req.query.quality;
    const quality = normalizePlaybackQuality(requestedQuality);
    const providerId = String(req.query.provider ?? "").trim();
    const trackId = req.params.trackId as string;

    if (!exp || !sig) return { ok: false, status: 403, error: "Missing signature" };
    if (requestedQuality !== undefined && !quality) return { ok: false, status: 400, error: "Unsupported playback quality" };
    if (!providerId) return { ok: false, status: 400, error: "Missing provider" };

    const expires = parseInt(exp, 10);
    if (Date.now() / 1000 > expires) return { ok: false, status: 403, error: "URL expired" };

    const expected = signUrl(providerId, trackId, expires, quality);
    if (sig !== expected) return { ok: false, status: 403, error: "Invalid signature" };

    return { ok: true, providerId, quality };
}

async function loadSignedPlaybackInfo(providerId: string, trackId: string, quality: string | null) {
    const provider = resolvePlaybackProvider(providerId);
    if (!provider.getPlaybackInfo) {
        return null;
    }
    return getCachedPlaybackInfo(providerId, trackId, quality, () =>
        provider.getPlaybackInfo!(trackId, quality || undefined),
    );
}

/**
 * GET /stream/hls/:trackId
 * Serves a VOD HLS media playlist for DASH-backed tracks so the browser can
 * stream/seek without the proxy materializing the whole file first. The init
 * segment is exposed via EXT-X-MAP; media segments stream through
 * /stream/seg/:trackId/:index on demand.
 */
router.get("/stream/hls/:trackId", async (req: Request, res: Response) => {
    const trackId = req.params.trackId as string;
    const verified = verifySignedPlayback(req);
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

    try {
        const info = await loadSignedPlaybackInfo(verified.providerId, trackId, verified.quality);
        if (!info) return res.status(502).json({ error: "No playable quality available" });
        if (info.type !== "dash") {
            // Progressive source — the client should use the plain play URL.
            return res.status(409).json({ error: "progressive source", progressiveOnly: true });
        }

        const signedQuery = `?exp=${encodeURIComponent(String(req.query.exp))}&sig=${encodeURIComponent(String(req.query.sig))}`
            + `&provider=${encodeURIComponent(verified.providerId)}`
            + (verified.quality ? `&quality=${encodeURIComponent(verified.quality)}` : "");
        const segmentUri = (index: number) => `/api/playback/stream/seg/${trackId}/${index}${signedQuery}`;

        const durations = info.durations ?? [];
        const mediaDurations = info.segments.slice(1).map((_, i) => durations[i + 1] || 4);
        const targetDuration = Math.max(1, Math.ceil(Math.max(...mediaDurations, 1)));

        const lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            `#EXT-X-TARGETDURATION:${targetDuration}`,
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
            `#EXT-X-MAP:URI="${segmentUri(0)}"`,
        ];
        for (let index = 1; index < info.segments.length; index++) {
            lines.push(`#EXTINF:${(durations[index] || 4).toFixed(5)},`);
            lines.push(segmentUri(index));
        }
        lines.push("#EXT-X-ENDLIST");

        res.setHeader("content-type", "application/vnd.apple.mpegurl");
        res.setHeader("cache-control", "private, max-age=300");
        res.send(lines.join("\n"));
    } catch (err: any) {
        console.error("[Playback] HLS playlist error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * GET /stream/seg/:trackId/:index
 * Streams a single DASH segment (index 0 = init segment) from the provider CDN.
 */
router.get("/stream/seg/:trackId/:index", async (req: Request, res: Response) => {
    const trackId = req.params.trackId as string;
    const verified = verifySignedPlayback(req);
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });

    const index = Number.parseInt(String(req.params.index), 10);
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: "Invalid segment index" });

    try {
        const info = await loadSignedPlaybackInfo(verified.providerId, trackId, verified.quality);
        if (!info || info.type !== "dash") return res.status(502).json({ error: "No segmented source available" });
        if (index >= info.segments.length) return res.status(404).json({ error: "Segment out of range" });

        const upstream = await fetch(info.segments[index]);
        if (!upstream.ok || !upstream.body) {
            return res.status(502).json({ error: `Upstream segment fetch failed (${upstream.status})` });
        }

        res.setHeader("content-type", info.contentType || "audio/mp4");
        res.setHeader("cache-control", "private, max-age=600");
        const length = upstream.headers.get("content-length");
        if (length) res.setHeader("content-length", length);

        const nodeStream = Readable.fromWeb(upstream.body as any);
        await streamPipeline(nodeStream, res);
    } catch (err: any) {
        if (err?.code === "ERR_STREAM_PREMATURE_CLOSE") return;
        console.error("[Playback] Segment proxy error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
        else res.end();
    }
});

/**
 * GET /stream/play/:trackId
 * Validates HMAC signature, fetches a browser-compatible TIDAL preview URL,
 * and preserves byte range support so the HTML audio element can seek correctly.
 */
router.get("/stream/play/:trackId", async (req: Request, res: Response) => {
    const trackId = req.params.trackId as string;
    const exp = String(req.query.exp ?? "") || undefined;
    const sig = String(req.query.sig ?? "") || undefined;
    const requestedQuality = req.query.quality;
    const quality = normalizePlaybackQuality(requestedQuality);
    const providerId = String(req.query.provider ?? "").trim();

    if (!exp || !sig) return res.status(403).json({ error: "Missing signature" });
    if (requestedQuality !== undefined && !quality) return res.status(400).json({ error: "Unsupported playback quality" });
    if (!providerId) return res.status(400).json({ error: "Missing provider" });

    const expires = parseInt(exp, 10);
    if (Date.now() / 1000 > expires) return res.status(403).json({ error: "URL expired" });

    const expected = signUrl(providerId, trackId, expires, quality);
    if (sig !== expected) return res.status(403).json({ error: "Invalid signature" });

    try {
        const provider = resolvePlaybackProvider(providerId);
        if (!provider.getPlaybackInfo) {
            return res.status(501).json({ error: `${provider.name} does not support track preview` });
        }

        const info: ProviderPlaybackInfo | null = await getCachedPlaybackInfo(
            providerId,
            trackId,
            quality,
            () => {
                console.log(`[Playback] Fetching ${provider.name} playback info for track ${trackId} (preferred=${quality || "auto"})...`);
                return provider.getPlaybackInfo!(trackId, quality || undefined);
            },
        );
        if (!info) {
            console.error(`[Playback] No browser-safe playback source for track ${trackId}`);
            return res.status(502).json({ error: "No playable quality available" });
        }

        if (info.type === "bts") {
            console.log(`[Playback] BTS stream for track ${trackId}`);
            const range = typeof req.headers["range"] === "string" ? req.headers["range"] : undefined;
            const upstream = await fetch(info.url, {
                headers: range ? { Range: range } : {},
            });

            if (!upstream.ok || !upstream.body) {
                return res.status(upstream.status).json({ error: "Upstream fetch failed" });
            }

            res.status(upstream.status);
            for (const h of [
                "content-type", "content-length", "accept-ranges",
                "content-range", "cache-control", "expires", "last-modified", "etag",
            ]) {
                const v = upstream.headers.get(h);
                if (v) {
                    res.setHeader(h, v);
                }
            }

            if (!res.getHeader("accept-ranges")) {
                res.setHeader("accept-ranges", "bytes");
            }

            const nodeStream = Readable.fromWeb(upstream.body as any);
            await streamPipeline(nodeStream, res);
            return;
        }

        console.log(`[Playback] Seekable DASH stream for track ${trackId} (${info.segments.length} segments)`);
        const buffer = await materializeSegmentedPlayback(
            `${providerId}:${trackId}:${quality || "auto"}`,
            info.segments,
        );
        const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
        let range: { start: number; end: number } | null;
        try {
            range = parsePlaybackRange(rangeHeader, buffer.byteLength);
        } catch {
            res.status(416);
            res.setHeader("content-range", `bytes */${buffer.byteLength}`);
            return res.end();
        }

        res.setHeader("content-type", info.contentType || "audio/mp4");
        res.setHeader("cache-control", "private, max-age=300");
        res.setHeader("accept-ranges", "bytes");
        if (range) {
            const body = buffer.subarray(range.start, range.end + 1);
            res.status(206);
            res.setHeader("content-range", `bytes ${range.start}-${range.end}/${buffer.byteLength}`);
            res.setHeader("content-length", body.byteLength);
            return res.end(body);
        }

        res.status(200);
        res.setHeader("content-length", buffer.byteLength);
        return res.end(buffer);
    } catch (err: any) {
        // Ignore premature close (client stopped playback)
        if (err?.code === "ERR_STREAM_PREMATURE_CLOSE") return;

        console.error("[Playback] Stream error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
        } else {
            res.end();
        }
    }
});

router.get("/video/sign/:videoId", authMiddleware, async (req: Request, res: Response) => {
    const videoId = req.params.videoId as string;
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    let provider;
    try {
        provider = resolvePlaybackProvider(req.query.provider);
    } catch (error: any) {
        return res.status(404).json({ error: error?.message || "provider not found" });
    }
    if (!provider.getVideoPlaybackInfo) {
        return res.status(501).json({ error: `${provider.name} does not support video preview` });
    }

    // Accept canonical recording ids and resolve them to the provider's video id.
    let providerVideoId = videoId;
    if (!looksLikeMusicBrainzMbid(videoId)) {
        const row = db.prepare(
            "SELECT provider_id FROM ProviderItems WHERE entity_type = 'video' AND recording_id = ? AND provider = ? LIMIT 1",
        ).get(videoId, provider.id) as { provider_id?: string | number | null } | undefined;
        if (row?.provider_id != null) {
            providerVideoId = String(row.provider_id);
        }
    }

    try {
        // Video previews play the provider's HLS manifest directly in the
        // browser (hls.js); proxying every segment would only add load.
        const info = await provider.getVideoPlaybackInfo(providerVideoId);
        if (!info) {
            return res.status(502).json({ error: "No playable video stream available" });
        }
        res.json({ url: info.url });
    } catch {
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/video/play/:videoId", async (req: Request, res: Response) => {
    const videoId = req.params.videoId as string;
    const exp = String(req.query.exp ?? "") || undefined;
    const sig = String(req.query.sig ?? "") || undefined;
    const providerId = String(req.query.provider ?? "").trim();

    if (!exp || !sig) return res.status(403).json({ error: "Missing signature" });
    if (!providerId) return res.status(400).json({ error: "Missing provider" });

    const expires = parseInt(exp, 10);
    if (Date.now() / 1000 > expires) return res.status(403).json({ error: "URL expired" });

    const expected = signUrl(providerId, `video:${videoId}`, expires);
    if (sig !== expected) return res.status(403).json({ error: "Invalid signature" });

    try {
        const provider = resolvePlaybackProvider(providerId);
        if (!provider.getVideoPlaybackInfo) {
            return res.status(501).json({ error: `${provider.name} does not support video preview` });
        }

        const info: ProviderVideoPlaybackInfo | null = await provider.getVideoPlaybackInfo(videoId);
        if (!info) {
            return res.status(502).json({ error: "No playable video stream available" });
        }

        res.redirect(info.url);
    } catch (err: any) {
        if (err?.code === "ERR_STREAM_PREMATURE_CLOSE") return;

        console.error("[Playback] Video stream error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
        } else {
            res.end();
        }
    }
});

export default router;
