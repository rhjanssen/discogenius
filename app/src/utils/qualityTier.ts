import { isSpatialAudioQuality, normalizeQualityTag } from "./spatialAudio";

/**
 * The four neutral stereo-fidelity badge tiers, ordered high -> low.
 *
 * Every streaming provider ships its own quality vocabulary (TIDAL
 * HIRES_LOSSLESS/LOSSLESS/HIGH/LOW, Apple/Amazon hi-res, Deezer FLAC/MP3_320,
 * Spotify OGG tiers, YouTube Music Opus/"YOUTUBE_LOSSY"). The badge UI must not
 * leak those raw strings — everything collapses onto MAX / HIGH / NORMAL / LOW
 * so a lossy YouTube offer reads the same as a lossy Apple offer.
 */
export type StereoQualityTier = "MAX" | "HIGH" | "NORMAL" | "LOW";

// Markers that imply a >16-bit / >44.1kHz lossless stream (TIDAL "MAX" branding,
// MQA masters, Apple/Amazon "hi-res"/"HD"-plus tiers).
const HIRES_MARKERS = ["HIRES", "HI_RES", "MASTER", "MQA"];
// CD-quality lossless containers.
const LOSSLESS_MARKERS = ["LOSSLESS", "FLAC", "ALAC"];
// Explicit low-bitrate lossy signals. Anything lossy without one of these reads
// as NORMAL (AAC ~256, MP3/OGG 320, TIDAL HIGH).
//
// YouTube Music is special: yt-dlp without a Premium account tops out at Opus
// ~160 kbps (itag 251) or 128 kbps AAC — genuinely LOW, not NORMAL. Premium
// (256 kbps) would be NORMAL, but the catalog can't know the account tier, so we
// label the realistic no-Premium delivery honestly rather than over-claiming.
const LOW_MARKERS = ["_96", "_128", "_64", "MP3_128", "MP3_96", "MP3_64", "YOUTUBE_LOSSY", "YT_LOSSY"];

/**
 * Map any provider's raw stereo quality string to one of four neutral badge
 * tiers. Spatial tags are a separate axis — callers detect spatial with
 * {@link isSpatialAudioQuality} first and only fall here for stereo offers.
 */
export function stereoQualityTier(quality: string | null | undefined): StereoQualityTier {
  const normalized = normalizeQualityTag(quality);
  if (!normalized) return "NORMAL";
  if (normalized === "MAX" || HIRES_MARKERS.some((marker) => normalized.includes(marker))) {
    return "MAX";
  }
  if (LOSSLESS_MARKERS.some((marker) => normalized.includes(marker))) {
    return "HIGH";
  }
  if (
    normalized === "LOW"
    || normalized.endsWith("_LOW")
    || LOW_MARKERS.some((marker) => normalized.includes(marker))
  ) {
    return "LOW";
  }
  return "NORMAL";
}

/**
 * Human description of each tier, including the bitrate/format range — different
 * services land at different points within a tier (e.g. NORMAL is 256 kbps AAC
 * on Apple but 320 kbps on TIDAL/Deezer), so we show the span rather than a
 * single number. Surfaced as the badge tooltip everywhere a badge renders.
 */
export const QUALITY_TIER_DESCRIPTION: Record<StereoQualityTier, string> = {
  MAX: "Hi-res lossless — 24-bit FLAC/ALAC (up to 192 kHz)",
  HIGH: "Lossless — 16-bit FLAC/ALAC (CD quality)",
  NORMAL: "High lossy — 256–320 kbps (AAC/OGG)",
  LOW: "Standard lossy — 96–160 kbps (incl. YouTube ~160 kbps Opus)",
};

/** Tooltip text for a raw quality string (spatial/video handled first, else tier + bitrate). */
export function qualityDescription(quality: string | null | undefined): string {
  const normalized = normalizeQualityTag(quality);
  if (normalized === "DOLBY_ATMOS") return "Dolby Atmos — spatial audio";
  if (isSpatialAudioQuality(normalized)) return "Spatial audio";
  if (isVideoResolutionQuality(normalized)) return `Video · ${videoResolutionLabel(normalized)}`;
  return QUALITY_TIER_DESCRIPTION[stereoQualityTier(normalized)];
}

/**
 * Whether a raw quality string represents a downloadable/streamable video
 * resolution (MP4_1080P, 2160P, …) rather than an audio fidelity tier.
 */
export function isVideoResolutionQuality(quality: string | null | undefined): boolean {
  const normalized = normalizeQualityTag(quality);
  return normalized.startsWith("MP4_") || /^\d{3,4}P$/.test(normalized);
}

/** Short human resolution label for a video quality string, e.g. "1080p". */
export function videoResolutionLabel(quality: string | null | undefined): string {
  return normalizeQualityTag(quality).replace(/^MP4_/, "").toLowerCase();
}
