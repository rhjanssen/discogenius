import { normalizeQualityTag } from "./spatialAudio";
import { stereoQualityTier } from "./qualityTier";

export function normalizeDisplayQuality(displayQuality?: string | null): string | null {
  const norm = normalizeQualityTag(displayQuality);
  if (!norm) return null;
  if (norm === "DOLBY_ATMOS" || norm === "ATMOS") return "DOLBY_ATMOS";
  if (norm === "SONY_360RA" || norm === "360RA") return "SONY_360RA";
  if (norm === "SPATIAL" || norm === "SPATIAL_AUDIO" || norm === "SURROUND" || norm === "IMMERSIVE") return "SPATIAL";
  return String(displayQuality).trim();
}

export function normalizeProvider(provider?: string | null): string {
  return String(provider || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

export function acquisitionPlanDisplayQuality(input: {
  qualityTier?: string | null;
  displayQuality?: string | null;
  provider?: string | null;
} | null | undefined): string {
  if (!input) return "LOSSLESS";

  const provider = normalizeProvider(input.provider);
  const normalizedDisplay = normalizeDisplayQuality(input.displayQuality);

  if (normalizedDisplay === "DOLBY_ATMOS") {
    return "DOLBY_ATMOS";
  }

  if (normalizedDisplay === "SONY_360RA") {
    return "SONY_360RA";
  }

  if (normalizedDisplay === "SPATIAL") {
    return "SPATIAL";
  }

  const tier = String(input.qualityTier || "").trim().toLowerCase().replace(/_/g, "-");

  if (tier === "spatial") {
    if (
      provider === "tidal" ||
      provider === "apple" ||
      provider === "apple-music"
    ) {
      return "DOLBY_ATMOS";
    }

    return "SPATIAL";
  }

  if (tier === "hires-lossless") {
    return "HIRES_LOSSLESS";
  }

  if (tier === "lossless") {
    return "LOSSLESS";
  }

  if (tier === "lossy") {
    return "HIGH";
  }

  return input.displayQuality || stereoQualityTier(input.qualityTier) || "LOSSLESS";
}
