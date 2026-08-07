/**
 * Video facts, the same shape as audio facts and for the same reason.
 *
 * A resolution label is not a quality: 1080p VP9 and 1080p H.264 are the same
 * height and not the same picture, because VP9 carries more detail per bit.
 * Discogenius already preferred the better codec at equal resolution; this
 * makes that preference a consequence of stored facts rather than a rule buried
 * in a comparator, so the video and audio ladders can eventually be one
 * profile.
 *
 * Evidence works exactly as it does for audio: `expected` from the provider's
 * tier while planning, `observed` from ffprobe once a file exists.
 */
import type { AudioConfidence, AudioEvidenceSource } from "./audio-facts.js";

export type VideoCodec = "av1" | "vp9" | "hevc" | "h264" | "vp8" | "mpeg4";

/** The tier vocabulary the app already uses for video. */
export type VideoQualityClass = "sd" | "hd" | "fhd" | "uhd";

export interface VideoFacts {
  evidenceSource: AudioEvidenceSource;
  confidence: AudioConfidence;

  codec: VideoCodec | null;
  container: string | null;

  /** Frame height in pixels: 720, 1080, 2160. */
  heightPx: number | null;
  widthPx: number | null;
  heightPxMax: number | null;

  frameRate: number | null;
  bitrateKbps: number | null;
  bitrateKbpsMax: number | null;

  /** High dynamic range, when the provider or the file says so. */
  hdr: boolean | null;
}

const EMPTY: VideoFacts = {
  evidenceSource: "provider-catalog",
  confidence: "expected",
  codec: null, container: null,
  heightPx: null, widthPx: null, heightPxMax: null,
  frameRate: null, bitrateKbps: null, bitrateKbpsMax: null,
  hdr: null,
};

function expected(facts: Partial<VideoFacts>): VideoFacts {
  return { ...EMPTY, ...facts, confidence: "expected", evidenceSource: "provider-catalog" };
}

/**
 * What each provider's video tier implies.
 *
 * Heights are ceilings: a tier named "1080p" is the most the provider will
 * serve, and an individual video may be less.
 */
const PROVIDER_VIDEO_FACTS: Record<string, Record<string, VideoFacts>> = {
  tidal: {
    sd: expected({ codec: "h264", container: "mp4", heightPxMax: 480 }),
    hd: expected({ codec: "h264", container: "mp4", heightPxMax: 720 }),
    fhd: expected({ codec: "h264", container: "mp4", heightPxMax: 1080 }),
  },
  "apple-music": {
    hd: expected({ codec: "h264", container: "mp4", heightPxMax: 720 }),
    fhd: expected({ codec: "h264", container: "mp4", heightPxMax: 1080 }),
    uhd: expected({ codec: "hevc", container: "mp4", heightPxMax: 2160 }),
  },
  "youtube-music": {
    // YouTube serves VP9 (and AV1) above H.264 at the same heights, which is
    // the case that makes resolution-only ranking wrong.
    sd: expected({ codec: "h264", container: "mp4", heightPxMax: 480 }),
    hd: expected({ codec: "vp9", container: "webm", heightPxMax: 720 }),
    fhd: expected({ codec: "vp9", container: "webm", heightPxMax: 1080 }),
    uhd: expected({ codec: "vp9", container: "webm", heightPxMax: 2160 }),
  },
};

export function expectedVideoFactsForProviderTier(
  provider: string | null | undefined,
  tier: string | null | undefined,
): VideoFacts | null {
  const providerKey = String(provider || "").trim().toLowerCase();
  const tierKey = String(tier || "").trim().toLowerCase();
  if (!providerKey || !tierKey) return null;
  const facts = PROVIDER_VIDEO_FACTS[providerKey]?.[tierKey];
  return facts ? { ...facts } : null;
}

/** Resolution class from the height, so a tier name never has to be trusted. */
export function videoQualityClassOf(facts: VideoFacts): VideoQualityClass | null {
  const height = facts.heightPx ?? facts.heightPxMax;
  if (height == null) return null;
  if (height >= 2160) return "uhd";
  if (height >= 1080) return "fhd";
  if (height >= 720) return "hd";
  return "sd";
}

/**
 * Coding efficiency relative to H.264 at 1.0.
 *
 * Ordering heuristics from the broad consensus of public comparisons, not
 * measurements — as with audio, the ordering is what is tested. AV1 and VP9
 * both carry more detail per bit than H.264, which is why 1080p VP9 beats
 * 1080p H.264 rather than tying with it.
 */
const VIDEO_CODEC_EFFICIENCY: Record<VideoCodec, number> = {
  av1: 1.5,
  vp9: 1.3,
  hevc: 1.3,
  h264: 1.0,
  vp8: 0.8,
  mpeg4: 0.6,
};

export function videoCodecEfficiency(codec: VideoCodec | null): number {
  return codec == null ? 0 : VIDEO_CODEC_EFFICIENCY[codec];
}

/**
 * Order two video offers: resolution first, then codec, then bitrate.
 *
 * Resolution dominates because it is what a viewer notices first and cannot be
 * recovered by a better encoder. Within one resolution the codec decides —
 * 1080p VP9 over 1080p H.264 — and bitrate only breaks a remaining tie.
 *
 * Returns >0 when `left` is better, matching a descending comparator.
 */
export function compareVideoQuality(left: VideoFacts, right: VideoFacts): number {
  const height = (left.heightPx ?? left.heightPxMax ?? 0) - (right.heightPx ?? right.heightPxMax ?? 0);
  if (height !== 0) return height;
  const codec = videoCodecEfficiency(left.codec) - videoCodecEfficiency(right.codec);
  if (codec !== 0) return codec;
  if (left.hdr !== right.hdr) return (left.hdr ? 1 : 0) - (right.hdr ? 1 : 0);
  return (left.bitrateKbps ?? left.bitrateKbpsMax ?? 0)
    - (right.bitrateKbps ?? right.bitrateKbpsMax ?? 0);
}

const VIDEO_CODEC_LABELS: Record<VideoCodec, string> = {
  av1: "AV1", vp9: "VP9", hevc: "HEVC", h264: "H.264", vp8: "VP8", mpeg4: "MPEG-4",
};

/** As with audio, a ceiling reads as a ceiling and never as a measurement. */
export function videoFactsLabel(facts: VideoFacts): string {
  const parts: string[] = [];
  if (facts.codec) parts.push(VIDEO_CODEC_LABELS[facts.codec]);
  if (facts.heightPx != null) parts.push(`${facts.heightPx}p`);
  else if (facts.heightPxMax != null) parts.push(`up to ${facts.heightPxMax}p`);
  if (facts.hdr) parts.push("HDR");
  if (facts.frameRate != null) parts.push(`${facts.frameRate} fps`);
  if (facts.bitrateKbps != null) parts.push(`${facts.bitrateKbps} kbps`);
  else if (facts.bitrateKbpsMax != null) parts.push(`up to ${facts.bitrateKbpsMax} kbps`);
  return parts.join(" · ");
}

/** Layer a probe over a tier expectation; see `mergeAudioFacts`. */
export function mergeVideoFacts(base: VideoFacts, observed: Partial<VideoFacts>): VideoFacts {
  const merged: VideoFacts = { ...base };
  for (const [key, value] of Object.entries(observed) as Array<[keyof VideoFacts, never]>) {
    if (value != null) merged[key] = value;
  }
  if (observed.confidence === "observed" || base.confidence === "observed") {
    merged.confidence = "observed";
  }
  if (merged.heightPx != null) merged.heightPxMax = null;
  if (merged.bitrateKbps != null) merged.bitrateKbpsMax = null;
  return merged;
}
