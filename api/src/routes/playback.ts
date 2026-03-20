/**
 * Playback routes — signed proxy stream to TIDAL CDN.
 *
 * GET /stream/sign/:trackId   → returns { url } with a time-limited HMAC-signed URL
 * GET /stream/play/:trackId   → validates signature, fetches from TIDAL CDN, pipes to client
 *
 * Supports two manifest types:
 *   - BTS:  single CDN URL — proxied directly with Range header support
 *   - DASH: segmented MP4 — all segments fetched and concatenated into one stream
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { pipeline } from "stream";
import { promisify } from "util";
import { Readable } from "stream";
import { getPlaybackInfo, getVideoPlaybackInfo } from "../services/playback.js";
import type { PlaybackInfo, VideoPlaybackInfo } from "../services/playback.js";
import { spawnSegmentedPlaybackWorker } from "../services/playback-segment-worker.js";
import { authMiddleware } from "../middleware/auth.js";

const streamPipeline = promisify(pipeline);
const router = Router();

// Use JWT_SECRET (same as auth) for HMAC signing
const getSecret = () => process.env.JWT_SECRET || "discogenius-stream-secret";

function signUrl(id: string, expires: number): string {
    const hmac = crypto.createHmac("sha256", getSecret());
    hmac.update(`${id}:${expires}`);
    return hmac.digest("hex");
}

/**
 * GET /stream/sign/:trackId
 * Returns a signed URL valid for 5 minutes.
 */
router.get("/stream/sign/:trackId", authMiddleware, (req: Request, res: Response) => {
    const trackId = req.params.trackId as string;
    if (!trackId) return res.status(400).json({ error: "Missing trackId" });

    const expires = Math.floor(Date.now() / 1000) + 300; // 5 min
    const sig = signUrl(trackId, expires);
    const url = `/api/playback/stream/play/${trackId}?exp=${expires}&sig=${sig}`;

    res.json({ url });
});

/**
 * GET /stream/play/:trackId
 * Validates HMAC signature, fetches CDN URL(s) from TIDAL, pipes bytes to the browser.
 * - BTS manifests: single URL, proxied with Range header support for seeking.
 * - DASH manifests: all segments fetched sequentially, concatenated into one audio/mp4 stream.
 */
router.get("/stream/play/:trackId", async (req: Request, res: Response) => {
    const trackId = req.params.trackId as string;
    const exp = String(req.query.exp ?? "") || undefined;
    const sig = String(req.query.sig ?? "") || undefined;

    if (!exp || !sig) return res.status(403).json({ error: "Missing signature" });

    const expires = parseInt(exp, 10);
    if (Date.now() / 1000 > expires) return res.status(403).json({ error: "URL expired" });

    const expected = signUrl(trackId, expires);
    if (sig !== expected) return res.status(403).json({ error: "Invalid signature" });

    try {
        console.log(`[Playback] Fetching playback info for track ${trackId}...`);
        const info: PlaybackInfo | null = await getPlaybackInfo(trackId);
        if (!info) {
            console.error(`[Playback] No playable quality for track ${trackId}`);
            return res.status(502).json({ error: "No playable quality available" });
        }

        // ── BTS: single CDN URL — proxy with Range support ──
        if (info.type === "bts") {
            console.log(`[Playback] BTS stream for track ${trackId}`);
            const range = req.headers["range"];
            const upstream = await fetch(info.url, {
                headers: range ? { Range: range } : {},
            });

            if (!upstream.ok || !upstream.body) {
                return res.status(upstream.status).json({ error: "Upstream fetch failed" });
            }

            res.status(upstream.status);
            for (const h of [
                "content-type", "content-length", "accept-ranges",
                "content-range", "cache-control", "last-modified", "etag",
            ]) {
                const v = upstream.headers.get(h);
                if (v) res.setHeader(h, v);
            }

            const nodeStream = Readable.fromWeb(upstream.body as any);
            await streamPipeline(nodeStream, res);
            return;
        }

        // ── DASH: segmented MP4 — offload sequential streaming to a worker ──
        console.log(`[Playback] DASH stream for track ${trackId}: ${info.segments.length} segments`);

        res.setHeader("Content-Type", info.contentType);
        res.setHeader("Cache-Control", "no-cache");
        // No Content-Length (chunked transfer) — we don't know total size upfront
        res.status(200);

        const worker = spawnSegmentedPlaybackWorker({
            segments: info.segments,
            contentType: info.contentType,
        });

        const stopWorker = () => {
            if (!worker.killed) {
                worker.kill("SIGTERM");
            }
        };

        worker.stderr.on("data", (chunk) => {
            const message = Buffer.from(chunk).toString("utf8").trim();
            if (message) {
                console.warn(`[Playback] DASH worker: ${message}`);
            }
        });

        worker.once("error", (error) => {
            console.error(`[Playback] DASH worker failed for track ${trackId}:`, error);
            stopWorker();
            if (!res.headersSent) {
                res.status(502).json({ error: "Playback worker failed" });
            } else if (!res.writableEnded) {
                res.end();
            }
        });

        worker.once("close", (code, signal) => {
            if (code === 0 || signal === "SIGTERM") {
                if (!res.writableEnded) {
                    res.end();
                }
                console.log(`[Playback] DASH stream complete for track ${trackId}`);
                return;
            }

            console.error(`[Playback] DASH worker exited with code ${code} for track ${trackId}`);
            if (!res.headersSent) {
                res.status(502).json({ error: "Playback worker exited unexpectedly" });
            } else if (!res.writableEnded) {
                res.end();
            }
        });

        req.once("close", stopWorker);
        res.once("close", stopWorker);
        worker.stdout.pipe(res);
        return;
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

    const expires = Math.floor(Date.now() / 1000) + 300;
    const sig = signUrl(`video:${videoId}`, expires);
    const url = `/api/playback/video/play/${videoId}?exp=${expires}&sig=${sig}`;

    res.json({ url });
});

router.get("/video/play/:videoId", async (req: Request, res: Response) => {
    const videoId = req.params.videoId as string;
    const exp = String(req.query.exp ?? "") || undefined;
    const sig = String(req.query.sig ?? "") || undefined;

    if (!exp || !sig) return res.status(403).json({ error: "Missing signature" });

    const expires = parseInt(exp, 10);
    if (Date.now() / 1000 > expires) return res.status(403).json({ error: "URL expired" });

    const expected = signUrl(`video:${videoId}`, expires);
    if (sig !== expected) return res.status(403).json({ error: "Invalid signature" });

    try {
        const info: VideoPlaybackInfo | null = await getVideoPlaybackInfo(videoId);
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
