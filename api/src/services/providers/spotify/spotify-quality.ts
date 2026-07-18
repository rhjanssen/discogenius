import type {
  NeutralAudioQuality,
  NeutralQuality,
  ProviderQualityMapping,
} from "../provider-quality.js";

/**
 * The baseline Spotify integration intentionally exposes only Votify's
 * prerequisite-light Vorbis path. AAC and FLAC modes need Widevine/desktop
 * material that Discogenius does not provision, so they are not advertised by
 * this adapter.
 */
export const spotifyQualityMapping: ProviderQualityMapping = {
  provider: "spotify",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    return normalized === "vorbis-low"
      || normalized === "vorbis-medium"
      || normalized === "vorbis-high"
      || normalized === "vorbis"
      || normalized === "lossy"
      ? "lossy"
      : null;
  },

  toNeutral(rawTags: Iterable<string | null | undefined>): NeutralQuality {
    for (const tag of rawTags) {
      if (this.toNeutralAudio(tag)) return { audio: "lossy", spatial: [] };
    }
    return { audio: null, spatial: [] };
  },

  fromNeutralAudio(quality: NeutralAudioQuality): string {
    if (quality !== "lossy") {
      throw new Error(`Spotify's baseline Votify backend does not support ${quality}`);
    }
    return "VORBIS_MEDIUM";
  },
};

