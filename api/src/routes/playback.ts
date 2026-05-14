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
import { spawnSegmentedPlaybackWorker } from "../services/playback-segment-worker.js";
import { streamingProviderManager } from "../services/providers/index.js";
import type { ProviderPlaybackInfo, ProviderVideoPlaybackInfo } from "../services/providers/streaming-provider.js";
import { authMiddleware } from "../middleware/auth.js";
import { looksLikeMusicBrainzMbid, resolveProviderTrackForCanonicalTrack } from "../services/provider-track-resolver.js";

const streamPipeline = promisify(pipeline);
const router = Router();
const PLAYBACK_QUALITIES = new Set(["DOLBY_ATMOS", "HIRES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"]);

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
                return res.status(409).json({ error: "Provider track match not found" });
            }
            providerId = resolved.provider;
            trackId = resolved.providerTrackId;
            quality = quality ?? normalizePlaybackQuality(resolved.quality);
        }
    } catch (error: any) {
        return res.status(404).json({ error: error?.message || "Provider not found" });
    }

    const expires = Math.floor(Date.now() / 1000) + 300; // 5 min
    const sig = signUrl(providerId, trackId, expires, quality);
    const qualityQuery = quality ? `&quality=${encodeURIComponent(quality)}` : "";
    const providerQuery = `&provider=${encodeURIComponent(providerId)}`;
    const url = `/api/playback/stream/play/${trackId}?exp=${expires}&sig=${sig}${providerQuery}${qualityQuery}`;

    res.json({ url });
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

        console.log(`[Playback] Fetching ${provider.name} playback info for track ${trackId} (preferred=${quality || "auto"})...`);
        const info: ProviderPlaybackInfo | null = await provider.getPlaybackInfo(trackId, quality || undefined);
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

        console.log(`[Playback] DASH stream for track ${trackId} (${info.segments.length} segments)`);
        const worker = spawnSegmentedPlaybackWorker({
            segments: info.segments,
            contentType: info.contentType,
        });
        let stderr = "";
        worker.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            worker.once("close", (code, signal) => resolve({ code, signal }));
            worker.once("error", reject);
        });
        const spawnedPromise = new Promise<void>((resolve, reject) => {
            worker.once("spawn", () => resolve());
            worker.once("error", reject);
        });
        const cleanupWorker = () => {
            if (worker.exitCode === null && worker.signalCode === null) {
                worker.kill();
            }
        };

        req.once("close", cleanupWorker);
        res.once("close", cleanupWorker);

        try {
            await spawnedPromise;

            res.status(200);
            res.setHeader("content-type", info.contentType || "audio/mp4");
            res.setHeader("cache-control", "no-store");
            res.setHeader("accept-ranges", "none");

            await streamPipeline(worker.stdout, res);

            const { code, signal } = await exitPromise;
            if ((code ?? 0) !== 0 && signal == null) {
                console.error(`[Playback] DASH worker exited with code ${code}: ${stderr.trim() || "unknown error"}`);
            }
            return;
        } finally {
            req.off("close", cleanupWorker);
            res.off("close", cleanupWorker);
            cleanupWorker();
        }
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

router.get("/video/sign/:videoId", authMiddleware, (req: Request, res: Response) => {
    const videoId = req.params.videoId as string;
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    let providerId = "";
    try {
        const provider = resolvePlaybackProvider(req.query.provider);
        providerId = provider.id;
        if (!provider.getVideoPlaybackInfo) {
            return res.status(501).json({ error: `${provider.name} does not support video preview` });
        }
    } catch (error: any) {
        return res.status(404).json({ error: error?.message || "Provider not found" });
    }

    const expires = Math.floor(Date.now() / 1000) + 300;
    const sig = signUrl(providerId, `video:${videoId}`, expires);
    const url = `/api/playback/video/play/${videoId}?exp=${expires}&sig=${sig}&provider=${encodeURIComponent(providerId)}`;

    res.json({ url });
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

        const range = req.headers["range"];
        const upstream = await fetch(info.url, {
            headers: range ? { Range: range } : {},
        });

        if (!upstream.ok || !upstream.body) {
            return res.status(upstream.status).json({ error: "Upstream video fetch failed" });
        }

        res.status(upstream.status);
        for (const header of [
            "content-type", "content-length", "accept-ranges",
            "content-range", "cache-control", "last-modified", "etag",
        ]) {
            const value = upstream.headers.get(header);
            if (value) {
                res.setHeader(header, value);
            }
        }

        if (!res.getHeader("content-type") && info.contentType) {
            res.setHeader("content-type", info.contentType);
        }

        const nodeStream = Readable.fromWeb(upstream.body as any);
        await streamPipeline(nodeStream, res);
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
