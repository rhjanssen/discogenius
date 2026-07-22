import {
  NeutralAudioQuality,
  NeutralQuality,
  NeutralVideoQuality,
  ProviderQualityMapping,
  classifyNeutralQuality,
  classifyNeutralVideo,
  formatNeutralVideoTag,
  neutralVideoFromHeight,
  neutralVideoTagFromHeight,
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

  toNeutralVideo(raw: string | null | undefined): NeutralVideoQuality | null {
    return classifyNeutralVideo(raw);
  },

  fromNeutralVideo(quality: NeutralVideoQuality): string {
    // TIDAL's catalog still speaks MP4_* heights for download requests.
    switch (quality) {
      case "uhd":
        return "MP4_2160P";
      case "fhd":
        return "MP4_1080P";
      case "hd":
        return "MP4_720P";
      case "sd":
        return "MP4_480P";
    }
  },
};

/**
 * TIDAL's catalog `quality` field is unreliable for music videos: most items
 * report `MP4_1080P` even when the stream tops out at 720p or 480p. Treat that
 * catalog default as unknown so callers probe the stream (or leave the offer
 * unlabeled) instead of advertising FHD falsely.
 */
export function isUntrustedTidalCatalogVideoQuality(raw: string | null | undefined): boolean {
  const normalized = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return !normalized
    || normalized === "MP4_1080P"
    || normalized === "FHD"
    || normalized === "SOURCE"
    || normalized === "UNKNOWN";
}

/** Map a TIDAL catalog video quality into the persisted neutral tag. */
export function tidalVideoQualityTag(raw: string | null | undefined): string | null {
  // Catalog MP4_1080P / FHD are aspirational — require a stream probe instead.
  if (isUntrustedTidalCatalogVideoQuality(raw)) {
    return null;
  }
  const tier = tidalQualityMapping.toNeutralVideo(raw);
  return tier ? formatNeutralVideoTag(tier) : null;
}

/** Map TIDAL stream `videoQuality` (HIGH/MEDIUM/LOW) to a neutral tier. */
export function tidalStreamVideoQualityTier(
  streamQuality: string | null | undefined,
): NeutralVideoQuality | null {
  const normalized = String(streamQuality ?? "").trim().toUpperCase();
  switch (normalized) {
    case "HIGH":
      return "fhd";
    case "MEDIUM":
      return "hd";
    case "LOW":
    case "AUDIO_ONLY":
      return "sd";
    default:
      return classifyNeutralVideo(streamQuality);
  }
}

/**
 * Parse an HLS master playlist and return the highest RESOLUTION height.
 * TIDAL MEDIUM manifests can top out at 480p even though the tier name implies 720p.
 */
export function parseM3u8MaxHeight(masterPlaylist: string): number | null {
  let maxHeight: number | null = null;
  for (const line of String(masterPlaylist || "").split(/\r?\n/)) {
    const match = /RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i.exec(line);
    if (!match) continue;
    const height = Number(match[2]);
    if (!Number.isFinite(height) || height <= 0) continue;
    if (maxHeight == null || height > maxHeight) {
      maxHeight = height;
    }
  }
  return maxHeight;
}

/** Height (preferred) or stream-tier fallback → persisted neutral tag. */
export function tidalVideoQualityTagFromProbe(params: {
  height?: number | null;
  streamQuality?: string | null;
}): string | null {
  if (params.height != null) {
    const fromHeight = neutralVideoTagFromHeight(params.height);
    if (fromHeight) return fromHeight;
  }
  const fromStream = tidalStreamVideoQualityTier(params.streamQuality);
  return fromStream ? formatNeutralVideoTag(fromStream) : null;
}

export function tidalVideoTierFromHeight(height: number | null | undefined): NeutralVideoQuality | null {
  return neutralVideoFromHeight(height);
}
