export const PLAYBACK_QUALITY_ORDER = [
  "DOLBY_ATMOS",
  "HIRES_LOSSLESS",
  "LOSSLESS",
  "HIGH",
  "LOW",
] as const;

export type PlaybackQuality = typeof PLAYBACK_QUALITY_ORDER[number];

const PLAYBACK_QUALITY_ALIASES: Readonly<Record<string, PlaybackQuality>> = {
  ATMOS: "DOLBY_ATMOS",
  DOLBYATMOS: "DOLBY_ATMOS",
  DOLBY_ATMOS: "DOLBY_ATMOS",
  HIRES: "HIRES_LOSSLESS",
  HI_RES: "HIRES_LOSSLESS",
  HI_RES_LOSSLESS: "HIRES_LOSSLESS",
  HIRES_LOSSLESS: "HIRES_LOSSLESS",
  MAX: "HIRES_LOSSLESS",
  LOSSLESS: "LOSSLESS",
  HIGH: "HIGH",
  LOW: "LOW",
};

/**
 * Canonical quality used in signed playback URLs and provider preview calls.
 * Provider ingestion and older plan snapshots contain both HI_RES_LOSSLESS and
 * HIRES_LOSSLESS, while the UI may send the display tier MAX. They all mean the
 * same preview preference and must produce the same signature/cache key.
 */
export function normalizePlaybackQuality(value: unknown): PlaybackQuality | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, "_");
  if (!normalized) return null;
  return PLAYBACK_QUALITY_ALIASES[normalized] ?? null;
}
