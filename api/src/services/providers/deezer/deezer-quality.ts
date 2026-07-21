import type {
  NeutralAudioQuality,
  NeutralVideoQuality,
  ProviderQualityMapping,
} from "../provider-quality.js";
import { classifyNeutralVideo, formatNeutralVideoTag } from "../provider-quality.js";

/** Deezer exposes MP3 tiers plus 16-bit FLAC (HiFi). */
export const deezerQualityMapping: ProviderQualityMapping = {
  provider: "deezer",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw || "").trim().toLowerCase();
    if (["flac", "lossless", "hifi", "2"].includes(normalized)) return "lossless";
    if (["mp3", "mp3_128", "mp3_320", "lossy", "0", "1"].includes(normalized)) return "lossy";
    return null;
  },

  toNeutral(rawTags) {
    let audio: NeutralAudioQuality | null = null;
    for (const raw of rawTags) {
      const mapped = this.toNeutralAudio(raw);
      if (mapped === "lossless") return { audio: mapped, spatial: [] };
      if (mapped) audio = mapped;
    }
    return { audio, spatial: [] };
  },

  fromNeutralAudio(quality: NeutralAudioQuality): string {
    return quality === "lossless" || quality === "hires-lossless" ? "FLAC" : "MP3_320";
  },

  toNeutralVideo(raw: string | null | undefined): NeutralVideoQuality | null {
    return classifyNeutralVideo(raw);
  },

  fromNeutralVideo(quality: NeutralVideoQuality): string {
    return formatNeutralVideoTag(quality);
  },
};
