/**
 * Pure helpers extracted from RefreshVideoService.
 * No DB access — identity, duration, and title-merge utilities only.
 * Variant class + clean group titles live in video-variant.ts.
 */

import { videoComparableTitle } from "../mediafiles/import-matching-utils.js";
import {
    VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS,
    VIDEO_DURATION_MATCH_MS,
    catalogVideoDisplayTitle,
    cleanVideoGroupTitle,
    extractVideoParentheticals,
    isMainVideoVariant,
    isMarketingVideoParenthetical,
    normalizeVideoVariant,
    parseVideoVariant,
    type VideoVariant,
} from "./video-variant.js";

export type AudioRecordingVideoMatch = {
    id: number;
    mbid: string | null;
    confidence: number;
    method: string;
    evidence: Record<string, unknown>;
};

export type AudioRecordingCandidateRow = {
    id: number;
    mbid?: string | null;
    title?: string | null;
    length_ms?: number | null;
    isrcs?: string | null;
    /** 1 when the recording appears on at least one non-Live release group. */
    has_non_live_album?: number | boolean | null;
    /**
     * 1 when it appears on a primary Album/EP/Single with no Live secondary
     * (prefer over compilation-only non-live membership).
     */
    has_studio_album?: number | boolean | null;
};

export type FindRelatedAudioOptions = {
    /** Video cut class — main/official rejects live-titled / live-only audio. */
    videoVariant?: VideoVariant | null;
    /**
     * When true (artist-wide main-video matching), prefer studio-album audio and
     * allow a wider duration gate for those candidates.
     */
    preferStudioAudio?: boolean;
};

export function normalizeVideoText(value: unknown): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export function normalizeProviderUrl(value: unknown): string | null {
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

export function durationBucket(durationSeconds: unknown): number | null {
    const duration = Number(durationSeconds || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }

    return Math.round(duration / 5) * 5;
}

export function buildVideoIdentity(video: any): {
    key: string;
    method: string;
    confidence: number;
    evidence: Record<string, unknown>;
} {
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

export function isPlaceholderVideoTitle(value: unknown): boolean {
    const trimmed = String(value || "").trim();
    return !trimmed || trimmed.toLowerCase() === "unknown video";
}

export function nullableText(value: unknown): string | null {
    const text = String(value ?? "").trim();
    return text.length > 0 ? text : null;
}

export function durationMs(durationSeconds: unknown): number | null {
    const duration = Number(durationSeconds || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }
    return Math.round(duration * 1000);
}

export function parseIsrcValues(value: unknown): string[] {
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

/** Live / performance cut from title text (not album secondary types). */
export function isLivePerformanceTitle(title: string | null | undefined): boolean {
    return /\blive\b|\bperformance\b|\bmtv\s+unplugged\b/i.test(String(title || ""));
}

/**
 * Normalize venue phrases from "live at/from …" (and Unit 24-style
 * parentheticals) so Abbey Road never links to Unit 24 on base title alone.
 */
export function extractLiveVenueSignatures(title: string | null | undefined): string[] {
    const text = String(title || "");
    const out = new Set<string>();
    for (const match of text.matchAll(/\blive\s+(?:at|from)\s+([^)\]]+)/gi)) {
        const venue = normalizeVideoText(match[1]);
        if (venue) out.add(venue);
    }
    for (const part of extractVideoParentheticals(text)) {
        if (!/\blive\b|\bperformance\b|\bunit\s*\d+/i.test(part)) continue;
        const cleaned = normalizeVideoText(
            part.replace(/\bacoustic(?:\s+version)?\b/gi, " ").replace(/\bversion\b/gi, " "),
        );
        if (cleaned && cleaned !== "live") out.add(cleaned);
    }
    return [...out];
}

/**
 * When both titles name a live venue, require overlap. One-sided venue is OK
 * (providers often omit "at Abbey Road" on the twin).
 */
export function liveVenueSignaturesCompatible(
    titleA: string | null | undefined,
    titleB: string | null | undefined,
): boolean {
    const left = extractLiveVenueSignatures(titleA);
    const right = extractLiveVenueSignatures(titleB);
    if (left.length === 0 || right.length === 0) return true;
    return left.some((a) => right.some((b) => a === b || a.includes(b) || b.includes(a)));
}

/** Core title must agree before an explicit album-position audio link sticks. */
export function videoAudioTitlesCompatible(
    videoTitle: string | null | undefined,
    audioTitle: string | null | undefined,
): boolean {
    const videoComparable = videoComparableTitle(videoTitle);
    const audioComparable = videoComparableTitle(audioTitle);
    if (!videoComparable || !audioComparable) return false;
    const titleOk = videoComparable === audioComparable
        || videoComparable.includes(audioComparable)
        || audioComparable.includes(videoComparable);
    if (!titleOk) return false;
    return liveVenueSignaturesCompatible(videoTitle, audioTitle);
}

function candidateHasNonLiveAlbum(row: AudioRecordingCandidateRow): boolean {
    return Boolean(row.has_non_live_album) || Boolean(row.has_studio_album);
}

function candidateStudioRank(row: AudioRecordingCandidateRow): number {
    if (Boolean(row.has_studio_album)) return 2;
    if (Boolean(row.has_non_live_album)) return 1;
    return 0;
}

export function findRelatedAudioRecordingForVideo(
    video: any,
    candidates: AudioRecordingCandidateRow[],
    options: FindRelatedAudioOptions = {},
): AudioRecordingVideoMatch | null {
    const videoTitle = videoComparableTitle(video.title);
    if (!videoTitle || candidates.length === 0) {
        return null;
    }

    const videoDurationMs = durationMs(video.duration);
    const videoIsrcs = parseIsrcValues(video.isrc ?? video.isrcs);
    const videoVariant = options.videoVariant ?? parseVideoVariant(nullableText(video.title));
    const preferStudio = Boolean(options.preferStudioAudio) && isMainVideoVariant(videoVariant);
    const rawVideoTitle = String(video.title || "");

    type Scored = AudioRecordingVideoMatch & { studioBoost: number; durationDiffMs: number };
    let best: Scored | null = null;
    for (const row of candidates) {
        const rawAudioTitle = String(row.title || "");
        if (preferStudio && isLivePerformanceTitle(rawAudioTitle)) {
            continue;
        }
        if (!liveVenueSignaturesCompatible(rawVideoTitle, rawAudioTitle)) {
            continue;
        }

        const audioTitle = videoComparableTitle(row.title);
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

        const audioDurationMs = Number(row.length_ms || 0) > 0 ? Number(row.length_ms) : null;
        const durationDiffMs = videoDurationMs != null && audioDurationMs != null
            ? Math.abs(videoDurationMs - audioDurationMs)
            : Number.POSITIVE_INFINITY;
        const hasStudioAlbum = candidateHasNonLiveAlbum(row);
        const studioBoost = preferStudio ? candidateStudioRank(row) : 0;
        // Tight gate for same-cut matches; main OMV→studio album may use the
        // wider gate so a same-duration live bootleg does not win.
        const durationGateMs = preferStudio && hasStudioAlbum
            ? VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS
            : VIDEO_DURATION_MATCH_MS;
        const durationCompatible = durationsWithinMs(
            videoDurationMs,
            audioDurationMs,
            durationGateMs,
        );
        if (!isrcOverlap && !durationCompatible) {
            continue;
        }
        if (preferStudio && !hasStudioAlbum && !isrcOverlap) {
            // Artist-wide main videos must not attach to live-only bootlegs
            // just because duration agrees.
            continue;
        }

        const tightDuration = durationsWithinMs(
            videoDurationMs,
            audioDurationMs,
            VIDEO_DURATION_MATCH_MS,
        );
        const confidence = isrcOverlap
            ? 0.95
            : exactTitle && tightDuration
                ? 0.84
                : exactTitle && durationCompatible && hasStudioAlbum && preferStudio
                    // Studio OMV↔stereo often sits outside the tight 2s gate; keep
                    // artist-wide acceptance (≥0.84) when the wider studio gate hits.
                    ? 0.84
                    : exactTitle && durationCompatible
                        ? 0.8
                        : containedTitle && durationCompatible
                            ? 0.72
                            : 0.62;
        const candidate: Scored = {
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
                durationDiffMs: Number.isFinite(durationDiffMs) ? durationDiffMs : null,
                hasNonLiveAlbum: hasStudioAlbum,
                studioRank: studioBoost,
            },
            studioBoost,
            durationDiffMs: Number.isFinite(durationDiffMs) ? durationDiffMs : Number.POSITIVE_INFINITY,
        };
        if (
            !best
            || candidate.studioBoost > best.studioBoost
            || (candidate.studioBoost === best.studioBoost && candidate.confidence > best.confidence)
            || (
                candidate.studioBoost === best.studioBoost
                && candidate.confidence === best.confidence
                && candidate.durationDiffMs < best.durationDiffMs
            )
        ) {
            best = candidate;
        }
    }

    if (!best) return null;
    const { studioBoost: _studioBoost, durationDiffMs: _durationDiffMs, ...match } = best;
    return match;
}

/** Catalog video matching: variant class from title (see video-variant.ts). */
export function videoVariantClass(title: string): VideoVariant {
    return parseVideoVariant(title);
}

export function durationsWithinMs(
    lengthMsA: number | null,
    lengthMsB: number | null,
    toleranceMs: number = VIDEO_DURATION_MATCH_MS,
): boolean {
    if (lengthMsA == null || lengthMsB == null) return false;
    return Math.abs(lengthMsA - lengthMsB) <= toleranceMs;
}

function sharedSignificantParenthetical(titleA: string, titleB: string): string | null {
    const left = extractVideoParentheticals(titleA).filter((part) => !isMarketingVideoParenthetical(part));
    const right = extractVideoParentheticals(titleB).filter((part) => !isMarketingVideoParenthetical(part));
    for (const a of left) {
        for (const b of right) {
            if (normalizeVideoText(a) === normalizeVideoText(b)) {
                return a.length >= b.length ? a : b;
            }
        }
    }
    return null;
}

function hasSignificantParenthetical(title: string): boolean {
    return extractVideoParentheticals(title).some((part) => !isMarketingVideoParenthetical(part));
}

/**
 * Prefer a shared full display title once a video group is established.
 * Matching still strips marketing/`()` noise via {@link cleanVideoGroupTitle};
 * storage/UI keep venue/live/feat when providers agree (or one side carries it).
 */
export function preferredMergedVideoTitle(titleA: string, titleB: string): string {
    const displayA = catalogVideoDisplayTitle(titleA);
    const displayB = catalogVideoDisplayTitle(titleB);
    const cleanA = cleanVideoGroupTitle(titleA);
    const cleanB = cleanVideoGroupTitle(titleB);
    const clsA = videoVariantClass(titleA);
    const clsB = videoVariantClass(titleB);

    // When a lyric cut merges onto a bare/main slot, keep the lyric display
    // title (variant wins as lyric; UI should still read as a lyric video).
    if (clsA === "lyric" && isMainVideoVariant(clsB)) return displayA;
    if (clsB === "lyric" && isMainVideoVariant(clsA)) return displayB;

    // Bare "(Live)" twin with same cleaned core: prefer the unlabeled main title.
    if (normalizeVideoText(cleanA) === normalizeVideoText(cleanB)) {
        const bareLiveA = clsA === "live" && clsB === "video"
            && !/\bperformance\b|\blive\s+(at|from)\b/i.test(displayA);
        const bareLiveB = clsB === "live" && clsA === "video"
            && !/\bperformance\b|\blive\s+(at|from)\b/i.test(displayB);
        if (bareLiveA) return displayB;
        if (bareLiveB) return displayA;
    }

    if (normalizeVideoText(cleanA) !== normalizeVideoText(cleanB)) {
        if (cleanA && cleanB) {
            return cleanA.length <= cleanB.length ? cleanA : cleanB;
        }
        return cleanA || cleanB || displayA || titleA;
    }

    const shared = sharedSignificantParenthetical(displayA, displayB);
    if (shared) {
        const withSharedA = displayA.toLowerCase().includes(shared.toLowerCase()) ? displayA : null;
        const withSharedB = displayB.toLowerCase().includes(shared.toLowerCase()) ? displayB : null;
        if (withSharedA && withSharedB) {
            return withSharedA.length >= withSharedB.length ? withSharedA : withSharedB;
        }
        return withSharedA || withSharedB || displayA;
    }

    // Same core: prefer the fuller non-marketing form (e.g. Live At …) when
    // only one offer carries it.
    if (hasSignificantParenthetical(displayA) && !hasSignificantParenthetical(displayB)) {
        return displayA;
    }
    if (hasSignificantParenthetical(displayB) && !hasSignificantParenthetical(displayA)) {
        return displayB;
    }

    if (normalizeVideoText(displayA) === normalizeVideoText(displayB)) {
        return displayA.length >= displayB.length ? displayA : displayB;
    }

    // Marketing-only difference → shorter clean group title.
    if (cleanA && cleanB) {
        return cleanA.length <= cleanB.length ? cleanA : cleanB;
    }
    return displayA || displayB || titleA;
}

export function videoCoreTitle(title: string): string {
    return videoComparableTitle(String(title || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
}

export function resolveCompareVariant(
    title: string,
    storedVariant?: VideoVariant | string | null,
): VideoVariant {
    if (storedVariant != null && String(storedVariant).trim()) {
        return normalizeVideoVariant(storedVariant);
    }
    return videoVariantClass(title);
}
