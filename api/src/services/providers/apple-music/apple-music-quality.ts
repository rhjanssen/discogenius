import {
  NeutralAudioQuality,
  NeutralQuality,
  NeutralSpatialQuality,
  ProviderQualityMapping,
} from "../provider-quality.js";

/**
 * Apple Music <-> neutral quality mapping.
 *
 * Apple expresses fidelity through the `audioTraits` array on albums/songs:
 *   "lossy-stereo" | "lossless" | "hi-res-lossless" | "atmos" | "spatial"
 * (older payloads also use "dolby-atmos"). We map those into the neutral model
 * so callers never branch on Apple's raw vocabulary.
 */
export const appleMusicQualityMapping: ProviderQualityMapping = {
  provider: "apple-music",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw ?? "").trim().toLowerCase();
    switch (normalized) {
      case "lossy-stereo":
      case "lossy":
      case "aac":
      case "standard":
        return "lossy";
      case "lossless":
        return "lossless";
      case "hi-res-lossless":
      case "hires-lossless":
        return "hires-lossless";
      default:
        return null;
    }
  },

  toNeutral(rawTags: Iterable<string | null | undefined>): NeutralQuality {
    let audio: NeutralAudioQuality | null = null;
    const spatial = new Set<NeutralSpatialQuality>();
    const order: NeutralAudioQuality[] = ["lossy", "lossless", "hires-lossless"];
    for (const tag of rawTags) {
      const normalized = String(tag ?? "").trim().toLowerCase();
      if (normalized === "atmos" || normalized === "dolby-atmos") {
        spatial.add("atmos");
        continue;
      }
      if (normalized === "spatial") {
        // Apple's "spatial" trait is Atmos-rendered spatial audio.
        spatial.add("atmos");
        continue;
      }
      const mapped = this.toNeutralAudio(normalized);
      if (mapped && (!audio || order.indexOf(mapped) > order.indexOf(audio))) {
        audio = mapped;
      }
    }
    return { audio, spatial: Array.from(spatial) };
  },

  fromNeutralAudio(quality: NeutralAudioQuality): string {
    switch (quality) {
      case "lossy":
        return "lossy-stereo";
      case "lossless":
        return "lossless";
      case "hires-lossless":
        return "hi-res-lossless";
    }
  },
};
