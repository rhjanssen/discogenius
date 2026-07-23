/**
 * Lidarr-inspired multi-signal video identity scoring.
 *
 * Lidarr has no music-video matcher; its audio DistanceCalculator weights
 * title / length / year together. We do the same for provider video merges:
 * title, duration, and release date all contribute — none alone dominates.
 * Shared ISRC is a strong cross-provider twin signal when duration is sparse.
 */
import { videoComparableTitle } from "../mediafiles/import-matching-utils.js";
import { parseIsrcValues } from "./refresh-video-support.js";
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

/**
 * Hard reject when both durations are known and farther apart than this.
 * Videos that differ by more than a couple seconds are different cuts
 * (official vs TV performance, radio edit, etc.) — keep this tight.
 */
export const VIDEO_DURATION_HARD_REJECT_MS = 3_000;

export type VideoIdentitySignals = {
  titleA: string;
  titleB: string;
  lengthMsA: number | null | undefined;
  lengthMsB: number | null | undefined;
  releaseDateA?: string | null;
  releaseDateB?: string | null;
  variantA?: VideoVariant | string | null;
  variantB?: VideoVariant | string | null;
  /** Optional ISRC evidence (ProviderItems.isrc / Recordings.isrcs). */
  isrcsA?: string | string[] | null;
  isrcsB?: string | string[] | null;
  /** Provider ids when known — bare live↔main twin requires cross-provider. */
  providerA?: string | null;
  providerB?: string | null;
  /** Skip cross-provider gate when revalidating an offer already on a recording. */
  allowSameProviderBareLiveTwin?: boolean;
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
  // Live cuts must never share a recording with studio / official / unlabeled
  // main videos — cleaned titles strip "(Live)" and durations can agree.
  // Named TV/venue performances and cross-provider bare "(Live)" twins may still
  // pair with an unlabeled main offer — see canMergeLiveMainPerformanceTwin and
  // canMergeBareLiveMainTwin.
  const livePair = (clsA === "live" && isMainVideoVariant(clsB))
    || (clsB === "live" && isMainVideoVariant(clsA));
  if (livePair) return false;
  return false;
}

function isUnlabeledVideoVariant(
  title: string,
  stored?: VideoVariant | string | null,
): boolean {
  return resolveVariant(title, stored) === "video";
}

function isBareLiveVariant(
  title: string,
  stored?: VideoVariant | string | null,
): boolean {
  const cls = resolveVariant(title, stored);
  return cls === "live" && !hasNamedPerformanceQualifier(title);
}

function isCrossProvider(
  providerA?: string | null,
  providerB?: string | null,
): boolean {
  const left = String(providerA || "").trim();
  const right = String(providerB || "").trim();
  return Boolean(left && right && left !== right);
}

/**
 * Live↔main performance / bare-live twins share the soft ±2s catalog-rounding
 * gate used by {@link isExactVideoTwin}. Requiring identical whole seconds
 * left Apple 180s vs TIDAL 179s twins on separate recordings.
 */
function softDurationTwinMatch(
  lengthMsA: number | null,
  lengthMsB: number | null,
): boolean {
  if (lengthMsA == null || lengthMsB == null) return false;
  return Math.abs(Number(lengthMsA) - Number(lengthMsB)) <= VIDEO_DURATION_MATCH_MS;
}

function releaseDatesCompatibleWhenKnown(
  releaseDateA?: string | null,
  releaseDateB?: string | null,
): boolean {
  const a = parseDateParts(releaseDateA);
  const b = parseDateParts(releaseDateB);
  if (!a || !b) return true;
  return dateSimilarity(releaseDateA, releaseDateB) >= 1;
}

/**
 * True when the live title names a TV/show or venue performance — not bare
 * "(Live)". Providers (esp. TIDAL) often omit the venue on the twin offer.
 */
function hasNamedPerformanceQualifier(title: string): boolean {
  return /\bperformance\b|\blive\s+at\b|\blive\s+from\b/i.test(String(title || ""));
}

/**
 * Allow bare OMV title ↔ named venue/TV live twin when durations agree within
 * the soft ±2s gate. Plain "(Live)" without a venue stays blocked from
 * unlabeled studio cuts even at equal duration.
 */
function canMergeLiveMainPerformanceTwin(input: VideoIdentitySignals): boolean {
  const titleA = String(input.titleA || "");
  const titleB = String(input.titleB || "");
  const clsA = resolveVariant(titleA, input.variantA);
  const clsB = resolveVariant(titleB, input.variantB);
  const liveMain = (clsA === "live" && isMainVideoVariant(clsB))
    || (clsB === "live" && isMainVideoVariant(clsA));
  if (!liveMain) return false;

  const liveTitle = clsA === "live" ? titleA : titleB;
  if (!hasNamedPerformanceQualifier(liveTitle)) return false;

  if (!softDurationTwinMatch(
    input.lengthMsA == null ? null : Number(input.lengthMsA),
    input.lengthMsB == null ? null : Number(input.lengthMsB),
  )) return false;

  return titleSimilarity(titleA, titleB) >= 0.9;
}

/**
 * Cross-provider bare "(Live)" ↔ unlabeled main video twin when durations agree
 * within the soft ±2s gate and titles match tightly. OMV/official main cuts
 * stay blocked; named venue/TV performances use
 * {@link canMergeLiveMainPerformanceTwin}.
 */
function canMergeBareLiveMainTwin(input: VideoIdentitySignals): boolean {
  const titleA = String(input.titleA || "");
  const titleB = String(input.titleB || "");
  const bareLiveMain = (isBareLiveVariant(titleA, input.variantA) && isUnlabeledVideoVariant(titleB, input.variantB))
    || (isBareLiveVariant(titleB, input.variantB) && isUnlabeledVideoVariant(titleA, input.variantA));
  if (!bareLiveMain) return false;
  if (!input.allowSameProviderBareLiveTwin && !isCrossProvider(input.providerA, input.providerB)) return false;
  if (!softDurationTwinMatch(
    input.lengthMsA == null ? null : Number(input.lengthMsA),
    input.lengthMsB == null ? null : Number(input.lengthMsB),
  )) return false;
  if (titleSimilarity(titleA, titleB) < 0.9) return false;
  if (!releaseDatesCompatibleWhenKnown(input.releaseDateA, input.releaseDateB)) return false;
  return true;
}

/**
 * Same-provider twins (rare duplicate IDs for one upload) must match more
 * tightly than cross-provider merges: strong title + duration inside the
 * soft gate. Catalog rounding often disagrees by 1s (232 vs 233); requiring
 * identical whole seconds left TIDAL listing twins on separate recordings.
 */
export function isExactVideoTwin(input: VideoIdentitySignals): boolean {
  const match = scoreVideoIdentityMatch(input);
  if (!match.matched) return false;
  const lengthMsA = input.lengthMsA == null ? null : Number(input.lengthMsA);
  const lengthMsB = input.lengthMsB == null ? null : Number(input.lengthMsB);
  if (lengthMsA == null || lengthMsB == null) return false;
  if (Math.abs(lengthMsA - lengthMsB) > VIDEO_DURATION_MATCH_MS) return false;
  return match.titleScore >= 0.95;
}

function sharedIsrc(
  isrcsA?: string | string[] | null,
  isrcsB?: string | string[] | null,
): boolean {
  const left = parseIsrcValues(isrcsA);
  const right = parseIsrcValues(isrcsB);
  if (left.length === 0 || right.length === 0) return false;
  return left.some((isrc) => right.includes(isrc));
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
 * length score: full credit inside the soft gate, then linear
 * falloff. Unknown durations contribute a weak mid score so date/title can
 * still carry a match only when ISRC (or both dates + near-perfect title) help.
 */
export function durationSimilarity(
  lengthMsA: number | null | undefined,
  lengthMsB: number | null | undefined,
): number {
  if (lengthMsA == null || lengthMsB == null) return 0.35;
  const diff = Math.abs(Number(lengthMsA) - Number(lengthMsB));
  if (diff <= VIDEO_DURATION_MATCH_MS) return 1;
  if (diff >= VIDEO_DURATION_HARD_REJECT_MS) return 0;
  // soft → 1.0, hard → 0.0
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
  const performanceTwin = canMergeLiveMainPerformanceTwin(input);
  const bareLiveTwin = canMergeBareLiveMainTwin(input);
  if (!variantsCompatible(titleA, titleB, input.variantA, input.variantB) && !performanceTwin && !bareLiveTwin) {
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

  const isrcOverlap = sharedIsrc(input.isrcsA, input.isrcsB);
  // Shared ISRC is strong twin evidence across providers when one side lacks
  // duration (common for sparse Apple/YouTube payloads).
  const durationScore = isrcOverlap
    ? 1
    : durationSimilarity(lengthMsA, lengthMsB);
  const datesKnown = Boolean(parseDateParts(input.releaseDateA) && parseDateParts(input.releaseDateB));
  // When durations agree tightly, missing dates should not drag a strong
  // title+duration twin under the threshold (tour/edition suffixes score ~0.88).
  const dateScore = datesKnown
    ? dateSimilarity(input.releaseDateA, input.releaseDateB)
    : (durationScore >= 0.95 ? 0.55 : 0.4);
  const score = (titleScore * TITLE_WEIGHT + durationScore * DURATION_WEIGHT + dateScore * DATE_WEIGHT)
    / WEIGHT_TOTAL;

  // When either side lacks a release date, lean on duration/ISRC: title+weak-date
  // alone must not glue lyric/live cuts that are several seconds apart.
  const durationsKnown = lengthMsA != null && lengthMsB != null;
  const matched = score >= VIDEO_IDENTITY_MATCH_THRESHOLD
    && (isrcOverlap || durationsKnown || (datesKnown && durationScore >= 0.95));

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
