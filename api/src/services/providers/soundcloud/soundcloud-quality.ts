import type {
  NeutralAudioQuality,
  NeutralVideoQuality,
  ProviderQualityMapping,
} from "../provider-quality.js";
import { classifyNeutralVideo, formatNeutralVideoTag } from "../provider-quality.js";

/** SoundCloud serves lossy progressive/HLS audio only (no lossless/spatial). */
export const soundcloudQualityMapping: ProviderQualityMapping = {
  provider: "soundcloud",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw || "").trim().toLowerCase().replace(/[ _-]+/gu, "");
    if ([
      "soundcloud",
      "soundcloudlossy",
      "lossy",
      "mp3",
      "aac",
      "m4a",
      "hls",
      "progressive",
      "sq",
      "hq",
      "lq",
    ].includes(normalized)) {
      return "lossy";
    }
    return null;
  },

  toNeutral(rawTags) {
    for (const tag of rawTags) {
      if (this.toNeutralAudio(tag)) return { audio: "lossy", spatial: [] };
    }
    return { audio: null, spatial: [] };
  },

  fromNeutralAudio(_quality: NeutralAudioQuality): string {
    return "SOUNDCLOUD_LOSSY";
  },

  toNeutralVideo(raw: string | null | undefined): NeutralVideoQuality | null {
    return classifyNeutralVideo(raw);
  },

  fromNeutralVideo(quality: NeutralVideoQuality): string {
    return formatNeutralVideoTag(quality);
  },
};
