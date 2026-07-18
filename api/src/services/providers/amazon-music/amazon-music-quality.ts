import type { NeutralAudioQuality, ProviderQualityMapping } from "../provider-quality.js";

export const amazonMusicQualityMapping: ProviderQualityMapping = {
  provider: "amazon-music",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw || "").trim().toLowerCase();
    if (/uhd|max|master|24[ -]?bit|hi.?res/u.test(normalized)) return "hires-lossless";
    if (/\bhd\b|lossless|flac|high/u.test(normalized)) return "lossless";
    if (/normal|medium|low|free|opus|lossy|sd/u.test(normalized)) return "lossy";
    return null;
  },

  toNeutral(rawTags) {
    let audio: NeutralAudioQuality | null = null;
    let atmos = false;
    for (const tag of rawTags) {
      const normalized = String(tag || "").trim().toLowerCase();
      if (/atmos|spatial|eac3|ec-3|ac-4/u.test(normalized)) atmos = true;
      const mapped = this.toNeutralAudio(normalized);
      if (mapped === "hires-lossless" || (mapped === "lossless" && audio !== "hires-lossless") || (!audio && mapped)) {
        audio = mapped;
      }
    }
    return { audio, spatial: atmos ? ["atmos"] : [] };
  },

  fromNeutralAudio(quality: NeutralAudioQuality): string {
    if (quality === "hires-lossless") return "Max";
    if (quality === "lossless") return "High";
    return "Normal";
  },
};
