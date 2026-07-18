import type { NeutralAudioQuality, ProviderQualityMapping } from "../provider-quality.js";

/** YouTube/YouTube Music serves compressed Opus or AAC audio, not lossless. */
export const youtubeMusicQualityMapping: ProviderQualityMapping = {
  provider: "youtube-music",

  toNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
    const normalized = String(raw || "").trim().toLowerCase().replace(/[ _-]+/gu, "");
    if (["youtube", "youtubelossy", "lossy", "opus", "aac", "m4a", "webm", "low", "high"].includes(normalized)) {
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
    // Higher neutral tiers cannot be manufactured from a lossy source. The
    // backend always requests the best audio representation YouTube provides.
    return "YOUTUBE_LOSSY";
  },
};
