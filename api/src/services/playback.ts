/**
 * TIDAL playback service — fetches streaming URLs for track preview/playback.
 *
 * Supports two manifest types returned by TIDAL depending on OAuth client:
 *   - **BTS** (`application/vnd.tidal.bts`): JSON manifest with direct CDN URL(s)
 *   - **DASH** (`application/dash+xml`): MPD manifest with segmented MP4 fragments
 *
 * The route layer handles both: BTS gets a simple proxy, DASH segments are
 * fetched sequentially and concatenated into a single audio/mp4 stream.
 */
import { loadToken, refreshTidalToken, getCountryCode } from "./providers/tidal/tidal.js";

const TIDAL_API_BASE = "https://api.tidal.com/v1";

// ── Result types ────────────────────────────────────────────────────────────
export type PlaybackInfo =
    | { type: "bts"; url: string }
    | { type: "dash"; segments: string[]; contentType: string };

export type VideoPlaybackInfo = {
    url: string;
    contentType?: string | null;
};

const PLAYBACK_QUALITY_ORDER = ["DOLBY_ATMOS", "HIRES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"] as const;
type PlaybackQuality = typeof PLAYBACK_QUALITY_ORDER[number];
type PlaybackManifestType = PlaybackInfo["type"];
export const BROWSER_PLAYBACK_MANIFEST_TYPES = ["bts", "dash"] as const satisfies readonly PlaybackManifestType[];

function normalizePlaybackQuality(value: string | undefined | null): PlaybackQuality | null {
    const normalized = String(value ?? "").trim().toUpperCase();
    return (PLAYBACK_QUALITY_ORDER as readonly string[]).includes(normalized)
        ? normalized as PlaybackQuality
        : null;
}

export function buildPlaybackQualityOrder(preferredQuality?: string | null): string[] {
    const preferred = normalizePlaybackQuality(preferredQuality);
    if (!preferred) {
        return ["HIRES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
    }

    const preferredIndex = PLAYBACK_QUALITY_ORDER.indexOf(preferred);
    return PLAYBACK_QUALITY_ORDER.slice(preferredIndex);
}

export function buildBrowserPlaybackQualityOrder(preferredQuality?: string | null): string[] {
    const preferred = normalizePlaybackQuality(preferredQuality);

    if (preferred === "LOW") {
        return ["LOW"];
    }

    if (preferred === "HIGH") {
        return ["HIGH", "LOW"];
    }

    // Match Tidarr's browser-preview approach: prefer progressive stereo-safe playback
    // instead of trying to force Atmos/Hi-Res manifests through the HTML audio element.
    return ["LOSSLESS", "HIGH", "LOW"];
}

// ── BTS manifest parser ─────────────────────────────────────────────────────
function parseBtsManifest(decoded: string): string[] {
    try {
        const data = JSON.parse(decoded);
        return Array.isArray(data.urls) ? data.urls : [];
    } catch {
        return [];
    }
}

// ── DASH / MPD manifest parser ──────────────────────────────────────────────
/**
 * Parse a TIDAL DASH MPD manifest and return ordered segment URLs.
 *
 * TIDAL's MPD structure (single Period → single AdaptationSet → single Representation):
 *   <SegmentTemplate
 *       initialization="https://…/0.mp4?token=…"
 *       media="https://…/$Number$.mp4?token=…"
 *       startNumber="1">
 *     <SegmentTimeline>
 *       <S d="176128" r="54"/>   ← 55 segments (r = repeat count)
 *       <S d="32179"/>           ← 1 final shorter segment
 *     </SegmentTimeline>
 *   </SegmentTemplate>
 */
function parseDashManifest(mpd: string): { segments: string[]; contentType: string } | null {
    try {
        // Extract mimeType and codecs from the manifest so the proxy response preserves
        // the actual audio format instead of collapsing everything to a generic MP4 type.
        const mimeMatch = mpd.match(/AdaptationSet[^>]+mimeType="([^"]+)"/);
        const codecsMatch =
            mpd.match(/Representation[^>]+codecs="([^"]+)"/)
            || mpd.match(/AdaptationSet[^>]+codecs="([^"]+)"/);
        const mimeType = mimeMatch?.[1] || "audio/mp4";
        const contentType = codecsMatch ? `${mimeType}; codecs="${codecsMatch[1]}"` : mimeType;

        // Extract SegmentTemplate attributes
        const initMatch = mpd.match(/initialization="([^"]+)"/);
        const mediaMatch = mpd.match(/<SegmentTemplate[^>]+media="([^"]+)"/);
        const startMatch = mpd.match(/startNumber="(\d+)"/);

        if (!initMatch || !mediaMatch) {
            console.error("[Playback] DASH: missing initialization or media URL in MPD");
            return null;
        }

        const initUrl = initMatch[1];
        const mediaTemplate = mediaMatch[1];
        const startNumber = startMatch ? parseInt(startMatch[1], 10) : 1;

        // Parse SegmentTimeline <S> elements
        const sElements = [...mpd.matchAll(/<S\s+d="(\d+)"(?:\s+r="(\d+)")?/g)];
        if (sElements.length === 0) {
            console.error("[Playback] DASH: no <S> elements in SegmentTimeline");
            return null;
        }

        // Build segment URL list: init segment first, then numbered media segments
        const segments: string[] = [initUrl];
        let num = startNumber;
        for (const s of sElements) {
            const repeat = s[2] ? parseInt(s[2], 10) + 1 : 1; // r="N" means N+1 total
            for (let i = 0; i < repeat; i++) {
                segments.push(mediaTemplate.replace("$Number$", String(num++)));
            }
        }

        console.log(`[Playback] DASH: parsed ${segments.length} segments (init + ${segments.length - 1} media)`);
        return { segments, contentType };
    } catch (err) {
        console.error("[Playback] DASH: MPD parse error:", err);
        return null;
    }
}

// ── Playback info fetcher ───────────────────────────────────────────────────
/**
 * Call TIDAL playbackinfo API and return a PlaybackInfo result.
 * Handles both BTS (single URL) and DASH (segmented) manifests.
 */
async function fetchPlaybackInfo(
    trackId: string,
    quality: string,
    accessToken: string,
    countryCode: string,
    supportedManifestTypes: PlaybackManifestType[] = ["bts", "dash"],
): Promise<PlaybackInfo | null> {
    const url =
        `${TIDAL_API_BASE}/tracks/${trackId}/playbackinfo` +
        `?countryCode=${countryCode}&audioquality=${quality}` +
        `&playbackmode=STREAM&assetpresentation=FULL`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
        },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[Playback] playbackinfo ${quality} → ${res.status}: ${body.slice(0, 200)}`);
        return null;
    }

    const data: any = await res.json();
    if (!data.manifest) return null;

    const decoded = Buffer.from(data.manifest, "base64").toString("utf8");
    const mime: string = data.manifestMimeType || "";
    const allowBts = supportedManifestTypes.includes("bts");
    const allowDash = supportedManifestTypes.includes("dash");

    // ── BTS manifest (direct CDN URL) ──
    if (mime === "application/vnd.tidal.bts" && allowBts) {
        const urls = parseBtsManifest(decoded);
        if (urls.length > 0) {
            console.log(`[Playback] BTS ${quality}: got ${urls.length} URL(s)`);
            return { type: "bts", url: urls[0] };
        }
        return null;
    }

    // ── DASH manifest (segmented MP4) ──
    if (mime === "application/dash+xml" && allowDash) {
        const dash = parseDashManifest(decoded);
        if (dash && dash.segments.length > 0) {
            console.log(`[Playback] DASH ${quality}: ${dash.segments.length} segments, type=${dash.contentType}`);
            return { type: "dash", segments: dash.segments, contentType: dash.contentType };
        }
        return null;
    }

    console.warn(`[Playback] Unsupported manifest type for ${quality}: ${mime}`);
    return null;
}

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Resolve the best-available playback info for a TIDAL track.
 * Tries a quality ladder based on the requested track quality.
 * Automatically refreshes the TIDAL token on failure.
 */
export async function getPlaybackInfo(trackId: string, preferredQuality?: string): Promise<PlaybackInfo | null> {
    let token = loadToken();
    if (!token) return null;

    const cc = getCountryCode();
    const qualities = buildPlaybackQualityOrder(preferredQuality);

    // First pass with current token
    for (const q of qualities) {
        const info = await fetchPlaybackInfo(trackId, q, token.access_token, cc);
        if (info) return info;
    }

    // All qualities failed — possibly expired token.  Refresh once and retry.
    try {
        await refreshTidalToken(true);
        token = loadToken();
        if (!token) return null;

        for (const q of qualities) {
            const info = await fetchPlaybackInfo(trackId, q, token.access_token, cc);
            if (info) return info;
        }
    } catch (err) {
        console.error("[Playback] Token refresh failed:", err);
    }

    return null;
}

export async function getBrowserPlaybackInfo(trackId: string, preferredQuality?: string): Promise<PlaybackInfo | null> {
    let token = loadToken();
    if (!token) return null;

    const cc = getCountryCode();
    const qualities = buildBrowserPlaybackQualityOrder(preferredQuality);

    for (const q of qualities) {
        const info = await fetchPlaybackInfo(trackId, q, token.access_token, cc, [...BROWSER_PLAYBACK_MANIFEST_TYPES]);
        if (info) return info;
    }

    try {
        await refreshTidalToken(true);
        token = loadToken();
        if (!token) return null;

        for (const q of qualities) {
            const info = await fetchPlaybackInfo(trackId, q, token.access_token, cc, [...BROWSER_PLAYBACK_MANIFEST_TYPES]);
            if (info) return info;
        }
    } catch (err) {
        console.error("[Playback] Browser preview token refresh failed:", err);
    }

    return null;
}

async function fetchVideoPlaybackInfo(
    videoId: string,
    quality: string,
    accessToken: string,
): Promise<VideoPlaybackInfo | null> {
    const url =
        `${TIDAL_API_BASE}/videos/${videoId}/urlpostpaywall` +
        `?urlusagemode=STREAM&videoquality=${quality}&assetpresentation=FULL`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
        },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[Playback] video url ${quality} -> ${res.status}: ${body.slice(0, 200)}`);
        return null;
    }

    const data: any = await res.json();
    const urls = Array.isArray(data?.urls) ? data.urls : [];
    const streamUrl = urls.find((value: unknown) => typeof value === "string" && value.length > 0);
    if (!streamUrl) {
        return null;
    }

    return {
        url: streamUrl,
        contentType: data?.mimeType || data?.contentType || null,
    };
}

export async function getVideoPlaybackInfo(videoId: string): Promise<VideoPlaybackInfo | null> {
    let token = loadToken();
    if (!token) return null;

    const qualities = ["HIGH", "MEDIUM", "LOW"];

    for (const quality of qualities) {
        const info = await fetchVideoPlaybackInfo(videoId, quality, token.access_token);
        if (info) return info;
    }

    try {
        await refreshTidalToken(true);
        token = loadToken();
        if (!token) return null;

        for (const quality of qualities) {
            const info = await fetchVideoPlaybackInfo(videoId, quality, token.access_token);
            if (info) return info;
        }
    } catch (err) {
        console.error("[Playback] Video token refresh failed:", err);
    }

    return null;
}
