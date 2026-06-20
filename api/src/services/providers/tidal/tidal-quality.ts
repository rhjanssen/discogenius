import {
  NeutralAudioQuality,
  NeutralQuality,
  ProviderQualityMapping,
  classifyNeutralQuality,
} from "../provider-quality.js";
import { isSpatialAudioQuality } from "../../../utils/spatial-audio.js";

/**
 * TIDAL <-> neutral quality mapping.
 *
 * TIDAL raw vocabulary: LOW / HIGH (320 kbps AAC) / LOSSLESS (16-bit FLAC) /
 * HI_RES_LOSSLESS (>16-bit FLAC) for stereo, plus DOLBY_ATMOS / SONY_360RA tags
 * carried in mediaMetadata for spatial.
 */
export const tidalQualityMapping: ProviderQualityMapping = {
  provider: "tidal",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    switch (normalized) {
      case "LOW":
      case "HIGH":
        return "lossy";
      case "LOSSLESS":
        return "lossless";
      case "HI_RES":
      case "HIRES":
      case "HI_RES_LOSSLESS":
      case "HIRES_LOSSLESS":
      case "MASTER":
      case "MQA":
      case "MAX":
        return "hires-lossless";
      default:
        // DOLBY_ATMOS / SONY_360RA carry no stereo signal -> fall back to shared
        // heuristic which returns null for spatial-only tags.
        return classifyNeutralQuality([normalized]).audio ?? null;
    }
  },

  toNeutral(rawTags: Iterable<string | null | undefined>): NeutralQuality {
    const tags = Array.from(rawTags);
    const base = classifyNeutralQuality(tags);
    // Prefer the explicit TIDAL audio mapping for any non-spatial tag.
    let audio = base.audio;
    for (const tag of tags) {
      if (isSpatialAudioQuality(tag)) continue;
      const mapped = this.toNeutralAudio(tag);
      if (mapped) {
        audio = audio
          ? (["lossy", "lossless", "hires-lossless"].indexOf(mapped) > ["lossy", "lossless", "hires-lossless"].indexOf(audio)
            ? mapped
            : audio)
          : mapped;
      }
    }
    return { audio, spatial: base.spatial };
  },

  fromNeutralAudio(quality: NeutralAudioQuality): string {
    switch (quality) {
      case "lossy":
        return "HIGH";
      case "lossless":
        return "LOSSLESS";
      case "hires-lossless":
        return "HI_RES_LOSSLESS";
    }
  },
};
