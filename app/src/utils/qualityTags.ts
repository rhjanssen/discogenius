import { isSpatialAudioQuality, normalizeQualityTag } from "@/utils/spatialAudio";

export interface QualityTaggedItem {
  quality?: string | null;
  qualityTags?: Array<string | null | undefined> | null;
}

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
      const key = quality.toUpperCase();
      if (!quality || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    // Stereo first, spatial (Dolby Atmos) last — matches the album release/track order.
    .sort((a, b) =>
      Number(isSpatialAudioQuality(normalizeQualityTag(a))) - Number(isSpatialAudioQuality(normalizeQualityTag(b))));
};
