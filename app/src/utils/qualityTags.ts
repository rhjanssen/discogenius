import { isSpatialAudioQuality, normalizeQualityTag } from "./spatialAudio";
import {
  isUnknownQualityTag,
  isVideoResolutionQuality,
  stereoQualityTier,
  videoResolutionLabel,
} from "./qualityTier";

export interface QualityTaggedItem {
  quality?: string | null;
  qualityTags?: Array<string | null | undefined> | null;
}

export const qualityDisplayKey = (quality: string): string => {
  const normalized = normalizeQualityTag(quality);
  if (isUnknownQualityTag(normalized)) {
    return "UNKNOWN";
  }
  if (isSpatialAudioQuality(normalized)) {
    return normalized === "DOLBY_ATMOS" ? "SPATIAL:DOLBY_ATMOS" : "SPATIAL";
  }
  if (isVideoResolutionQuality(normalized)) {
    return `VIDEO:${videoResolutionLabel(normalized)}`;
  }
  return `AUDIO:${stereoQualityTier(normalized)}`;
};

export const orderedQualityTags = (item: QualityTaggedItem): string[] => {
  const values = Array.isArray(item.qualityTags) && item.qualityTags.length > 0
    ? item.qualityTags
    : item.quality
      ? [item.quality]
      : [];
  const seen = new Set<string>();

  return values
    .map((quality) => String(quality || "").trim())
    .filter((quality) => {
      if (!quality || isUnknownQualityTag(quality)) {
        return false;
      }
      const key = qualityDisplayKey(quality);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    // Stereo first, spatial (Dolby Atmos) last — matches the album release/track order.
    .sort((a, b) =>
      Number(isSpatialAudioQuality(normalizeQualityTag(a))) - Number(isSpatialAudioQuality(normalizeQualityTag(b))));
};
