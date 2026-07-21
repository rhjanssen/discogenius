/**
 * Lidarr-inspired multi-signal video identity scoring.
 *
 * Lidarr has no music-video matcher; its audio DistanceCalculator weights
 * title / length / year together. We do the same for provider video merges:
 * title, duration, and release date all contribute — none alone dominates.
 */
import { videoComparableTitle } from "../mediafiles/import-matching-utils.js";
import {
  VIDEO_DURATION_MATCH_MS,
  cleanVideoGroupTitle,
  isMainVideoVariant,
  normalizeVideoVariant,
  parseVideoVariant,
  type VideoVariant,
} from "./video-variant.js";

const TITLE_WEIGHT = 3;
const DURATION_WEIGHT = 2;
const DATE_WEIGHT = 1;
const WEIGHT_TOTAL = TITLE_WEIGHT + DURATION_WEIGHT + DATE_WEIGHT;

/** Soft match threshold on the weighted average (0–1). */
export const VIDEO_IDENTITY_MATCH_THRESHOLD = 0.85;

/** Hard reject when both durations are known and farther apart than this. */
export const VIDEO_DURATION_HARD_REJECT_MS = 15_000;

export type VideoIdentitySignals = {
  titleA: string;
  titleB: string;
  lengthMsA: number | null | undefined;
  lengthMsB: number | null | undefined;
  releaseDateA?: string | null;
  releaseDateB?: string | null;
  variantA?: VideoVariant | string | null;
  variantB?: VideoVariant | string | null;
};

export type VideoIdentityMatchResult = {
  matched: boolean;
  score: number;
  titleScore: number;
  durationScore: number;
  dateScore: number;
  reason?: string;
};

function resolveVariant(title: string, stored?: VideoVariant | string | null): VideoVariant {
  if (stored != null && String(stored).trim()) {
    return normalizeVideoVariant(stored);
  }
  return parseVideoVariant(title);
}

function variantsCompatible(
  titleA: string,
  titleB: string,
  variantA?: VideoVariant | string | null,
  variantB?: VideoVariant | string | null,
): boolean {
  const clsA = resolveVariant(titleA, variantA);
  const clsB = resolveVariant(titleB, variantB);
  if (clsA === clsB) return true;
  if (isMainVideoVariant(clsA) && isMainVideoVariant(clsB)) return true;
  const lyricPair = (clsA === "lyric" && isMainVideoVariant(clsB))
    || (clsB === "lyric" && isMainVideoVariant(clsA));
  if (lyricPair) return true;
  const livePair = (clsA === "live" && isMainVideoVariant(clsB))
    || (clsB === "live" && isMainVideoVariant(clsA));
  if (livePair) {
    // Live must not attach to an explicitly "official" studio OMV.
    const officialMarker = /\bofficial\b/i;
    if (officialMarker.test(titleA) || officialMarker.test(titleB)) return false;
    if (clsA === "official" || clsB === "official") return false;
    return true;
  }
  return false;
}

function titleSimilarity(titleA: string, titleB: string): number {
  const comparableA = videoComparableTitle(titleA);
  const comparableB = videoComparableTitle(titleB);
  if (!comparableA || !comparableB) return 0;
  if (comparableA === comparableB) return 1;

  const cleanA = videoComparableTitle(cleanVideoGroupTitle(titleA));
  const cleanB = videoComparableTitle(cleanVideoGroupTitle(titleB));
  if (cleanA && cleanB && cleanA === cleanB) return 0.95;

  const coreA = videoComparableTitle(String(titleA || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
  const coreB = videoComparableTitle(String(titleB || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
  if (coreA && coreB && coreA === coreB) return 0.9;

  // Shorter comparable title is a prefix of the longer (tour/edition suffixes).
  if (comparableA && comparableB) {
    const [shorter, longer] = comparableA.length <= comparableB.length
      ? [comparableA, comparableB]
      : [comparableB, comparableA];
    if (longer.startsWith(`${shorter} `) || longer === shorter) return 0.88;
  }

  if (cleanA && cleanB && (cleanA.includes(cleanB) || cleanB.includes(cleanA))) {
    return 0.7;
  }
  return 0;
}

/**
 * Lidarr-style length score: full credit inside the soft gate, then linear
 * falloff. Unknown durations contribute a neutral mid score so date/title can
 * still carry a match when one side lacks length.
 */
export function durationSimilarity(
  lengthMsA: number | null | undefined,
  lengthMsB: number | null | undefined,
): number {
  if (lengthMsA == null || lengthMsB == null) return 0.4;
  const diff = Math.abs(Number(lengthMsA) - Number(lengthMsB));
  if (diff <= VIDEO_DURATION_MATCH_MS) return 1;
  if (diff >= VIDEO_DURATION_HARD_REJECT_MS) return 0;
  // 5s → 1.0, 15s → 0.0
  return Math.max(0, 1 - (diff - VIDEO_DURATION_MATCH_MS) / (VIDEO_DURATION_HARD_REJECT_MS - VIDEO_DURATION_MATCH_MS));
}

function parseDateParts(raw: string | null | undefined): { y: number; m: number | null; d: number | null } | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = match[2] ? Number(match[2]) : null;
  const d = match[3] ? Number(match[3]) : null;
  if (!Number.isFinite(y) || y < 1000) return null;
  return { y, m, d };
}

/**
 * Same calendar day scores highest; coarser overlaps score lower. Missing dates
 * are neutral (not a hard fail) so ytmusicapi gaps do not block duration+title.
 */
export function dateSimilarity(
  releaseDateA: string | null | undefined,
  releaseDateB: string | null | undefined,
): number {
  const a = parseDateParts(releaseDateA);
  const b = parseDateParts(releaseDateB);
  if (!a || !b) return 0.4;
  if (a.y !== b.y) return 0.1;
  if (a.m != null && b.m != null && a.m === b.m) {
    if (a.d != null && b.d != null && a.d === b.d) return 1;
    if (a.d == null || b.d == null) return 0.75;
    return 0.45;
  }
  if (a.m == null || b.m == null) return 0.55;
  return 0.4;
}

export function scoreVideoIdentityMatch(input: VideoIdentitySignals): VideoIdentityMatchResult {
  const titleA = String(input.titleA || "");
  const titleB = String(input.titleB || "");
  if (!variantsCompatible(titleA, titleB, input.variantA, input.variantB)) {
    return {
      matched: false,
      score: 0,
      titleScore: 0,
      durationScore: 0,
      dateScore: 0,
      reason: "variant-incompatible",
    };
  }

  const titleScore = titleSimilarity(titleA, titleB);
  if (titleScore < 0.7) {
    return {
      matched: false,
      score: 0,
      titleScore,
      durationScore: 0,
      dateScore: 0,
      reason: "title-mismatch",
    };
  }

  const lengthMsA = input.lengthMsA == null ? null : Number(input.lengthMsA);
  const lengthMsB = input.lengthMsB == null ? null : Number(input.lengthMsB);
  if (
    lengthMsA != null
    && lengthMsB != null
    && Math.abs(lengthMsA - lengthMsB) > VIDEO_DURATION_HARD_REJECT_MS
  ) {
    return {
      matched: false,
      score: 0,
      titleScore,
      durationScore: 0,
      dateScore: dateSimilarity(input.releaseDateA, input.releaseDateB),
      reason: "duration-hard-reject",
    };
  }

  const durationScore = durationSimilarity(lengthMsA, lengthMsB);
  const dateScore = dateSimilarity(input.releaseDateA, input.releaseDateB);
  const score = (titleScore * TITLE_WEIGHT + durationScore * DURATION_WEIGHT + dateScore * DATE_WEIGHT)
    / WEIGHT_TOTAL;

  // When either side lacks a release date, lean on duration: title+weak-date
  // alone must not glue lyric/live cuts that are several seconds apart.
  const datesKnown = Boolean(parseDateParts(input.releaseDateA) && parseDateParts(input.releaseDateB));
  const matched = score >= VIDEO_IDENTITY_MATCH_THRESHOLD
    && (datesKnown || durationScore >= 0.95);

  return {
    matched,
    score,
    titleScore,
    durationScore,
    dateScore,
  };
}

export function videosAreSameIdentity(input: VideoIdentitySignals): boolean {
  return scoreVideoIdentityMatch(input).matched;
}
