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

/**
 * Neutral music-video resolution badge tiers (broadcast-style short labels).
 * Tooltips carry the pixel height (480p / 720p / 1080p / 2160p).
 */
export type VideoQualityTier = "UHD" | "FHD" | "HD" | "SD";

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

/** Placeholders that must never render as a stereo NORMAL badge. */
const UNKNOWN_QUALITY_MARKERS = new Set(["SOURCE", "UNKNOWN", "N/A", "NA", "NONE"]);

export function isUnknownQualityTag(quality: string | null | undefined): boolean {
  const normalized = normalizeQualityTag(quality);
  return !normalized || UNKNOWN_QUALITY_MARKERS.has(normalized);
}

/**
 * Map any provider's raw stereo quality string to one of four neutral badge
 * tiers. Spatial tags are a separate axis — callers detect spatial with
 * {@link isSpatialAudioQuality} first and only fall here for stereo offers.
 */
export function stereoQualityTier(quality: string | null | undefined): StereoQualityTier {
  const normalized = normalizeQualityTag(quality);
  if (!normalized || UNKNOWN_QUALITY_MARKERS.has(normalized)) return "NORMAL";
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

export const VIDEO_TIER_PIXELS: Record<VideoQualityTier, string> = {
  UHD: "2160p",
  FHD: "1080p",
  HD: "720p",
  SD: "480p",
};

/** Long tier name for tooltips (paired with a pixel fragment). */
export const VIDEO_TIER_NAME: Record<VideoQualityTier, string> = {
  UHD: "Ultra HD",
  FHD: "Full HD",
  HD: "HD",
  SD: "SD",
};

/** Expanded video tooltip copy — avoids repeating the short badge (FHD → Full HD · 1080p). */
export const VIDEO_TIER_DESCRIPTION: Record<VideoQualityTier, string> = {
  UHD: "Ultra HD · 2160p",
  FHD: "Full HD · 1080p",
  HD: "HD · 720p",
  SD: "SD · 480p",
};

/** Exact pixel height from a quality tag when present (`MP4_1080P` → `1080p`). */
export function videoResolutionExactPixels(quality: string | null | undefined): string | null {
  const normalized = normalizeQualityTag(quality);
  const match = /(?:^|_)(\d{3,4})P$/.exec(normalized);
  if (!match) return null;
  return `${match[1]}p`;
}

/** Map a provider's declared max video height to a badge tier. */
export function videoTierFromMaxHeight(height: number | null | undefined): VideoQualityTier | null {
  const value = Number(height);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 2160) return "UHD";
  if (value >= 1080) return "FHD";
  if (value >= 720) return "HD";
  // 360p–719p (and classic 480p clips) share the SD badge.
  if (value >= 360) return "SD";
  return null;
}

/** Capability / Settings prose for a video ceiling, e.g. "Up to UHD (2160p)". */
export function videoCapabilityLabel(height: number | null | undefined): string {
  const tier = videoTierFromMaxHeight(height);
  if (!tier) return "Not available";
  return `Up to ${tier} (${VIDEO_TIER_PIXELS[tier]})`;
}

/**
 * Map a raw video quality string to SD / HD / FHD / UHD. Returns null for unknown
 * placeholders such as SOURCE (must not fall through to stereo NORMAL).
 */
export function videoQualityTier(quality: string | null | undefined): VideoQualityTier | null {
  if (isUnknownQualityTag(quality)) return null;
  const normalized = normalizeQualityTag(quality);
  if (normalized.includes("2160") || normalized === "4K" || normalized === "UHD") return "UHD";
  if (normalized.includes("1440") || normalized === "QHD") return "FHD";
  if (normalized.includes("1080") || normalized === "FHD") return "FHD";
  if (normalized.includes("720") || normalized === "HD") return "HD";
  if (
    normalized.includes("480")
    || normalized.includes("360")
    || normalized.includes("240")
    || normalized === "SD"
  ) {
    return "SD";
  }
  const mp4 = /^MP4_(\d{3,4})P$/.exec(normalized);
  if (mp4) return videoTierFromMaxHeight(Number(mp4[1]));
  const bare = /^(\d{3,4})P$/.exec(normalized);
  if (bare) return videoTierFromMaxHeight(Number(bare[1]));
  return null;
}

/** Tooltip text for a raw quality string (spatial/video handled first, else tier + bitrate). */
export function qualityDescription(quality: string | null | undefined): string {
  const normalized = normalizeQualityTag(quality);
  if (isUnknownQualityTag(normalized)) return "Quality unknown";
  // Video before spatial: MP4_360P contains "360" which would otherwise match Sony 360RA.
  const videoTier = videoQualityTier(normalized);
  if (videoTier) {
    const pixels = videoResolutionExactPixels(normalized) || VIDEO_TIER_PIXELS[videoTier];
    return `${VIDEO_TIER_NAME[videoTier]} · ${pixels}`;
  }
  if (normalized === "DOLBY_ATMOS") return "Dolby Atmos — spatial audio";
  if (isSpatialAudioQuality(normalized)) return "Spatial audio";
  return QUALITY_TIER_DESCRIPTION[stereoQualityTier(normalized)];
}

/**
 * Whether a raw quality string represents a downloadable/streamable video
 * resolution (MP4_1080P, 2160P, …) rather than an audio fidelity tier.
 */
export function isVideoResolutionQuality(quality: string | null | undefined): boolean {
  return videoQualityTier(quality) !== null;
}

/** Short badge label for a video quality string: SD / HD / FHD / UHD. */
export function videoResolutionLabel(quality: string | null | undefined): string {
  return videoQualityTier(quality) || "";
}

/** Pixel tooltip fragment for a video quality string, e.g. "1080p". */
export function videoResolutionPixels(quality: string | null | undefined): string | null {
  const exact = videoResolutionExactPixels(quality);
  if (exact) return exact;
  const tier = videoQualityTier(quality);
  return tier ? VIDEO_TIER_PIXELS[tier] : null;
}
