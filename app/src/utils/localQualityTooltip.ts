import { isSpatialAudioQuality, normalizeQualityTag } from "./spatialAudio";
import {
  isUnknownQualityTag,
  isVideoResolutionQuality,
  qualityDescription,
  VIDEO_TIER_NAME,
  VIDEO_TIER_PIXELS,
  videoQualityTier,
  videoResolutionExactPixels,
} from "./qualityTier";

/** File tech props used to build local library quality tooltips. */
export interface LocalFileQualityProps {
  quality?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channels?: number | null;
  /** Audio codec for tracks; for videos this is typically the audio stream codec. */
  codec?: string | null;
  /**
   * Video stream codec when known (H.264 / HEVC / AV1 / …).
   * Populated from TrackFiles.video_codec when the library API returns it.
   */
  video_codec?: string | null;
}

const VIDEO_CODEC_KEYS = new Set([
  "H264",
  "AVC",
  "AVC1",
  "H265",
  "HEVC",
  "HEV1",
  "HVC1",
  "AV1",
  "AV01",
  "VP9",
  "VP09",
  "VP8",
  "VP08",
]);

function normalizeCodecKey(codec: string | null | undefined): string {
  return String(codec || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Whether a raw codec string looks like a video stream codec (not audio). */
export function isVideoCodecName(codec: string | null | undefined): boolean {
  const key = normalizeCodecKey(codec);
  return Boolean(key) && VIDEO_CODEC_KEYS.has(key);
}

/** User-facing codec labels — prefer brand names already used elsewhere in the app. */
export function formatCodecLabel(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const normalized = normalizeCodecKey(codec);
  if (!normalized) return null;
  // Video — user-facing: H.264 / HEVC / AV1 / VP9 (not raw h264/h265, not AVC primary).
  if (normalized === "H264" || normalized === "AVC" || normalized === "AVC1") return "H.264";
  if (normalized === "H265" || normalized === "HEVC" || normalized === "HEV1" || normalized === "HVC1") {
    return "HEVC";
  }
  if (normalized === "AV1" || normalized === "AV01") return "AV1";
  if (normalized === "VP9" || normalized === "VP09") return "VP9";
  if (normalized === "VP8" || normalized === "VP08") return "VP8";
  // Audio / spatial
  if (normalized === "EAC3" || normalized === "EC3" || normalized === "DDPLUS" || normalized === "DDP") {
    return "Dolby Digital Plus";
  }
  if (normalized === "AC3" || normalized === "DD") return "Dolby Digital";
  if (normalized === "TRUEHD" || normalized === "MLP") return "TrueHD";
  if (normalized === "ALAC" || normalized === "APPLELOSSLESS") return "ALAC";
  if (normalized === "FLAC") return "FLAC";
  if (normalized === "AAC" || normalized === "MP4A" || normalized === "M4A") return "AAC";
  if (normalized === "OPUS") return "Opus";
  if (normalized === "VORBIS" || normalized === "OGG") return "Ogg Vorbis";
  if (normalized === "MP3" || normalized === "MPEG") return "MP3";
  if (normalized === "PCM" || normalized === "LPCM") return "PCM";
  return codec.trim().toUpperCase();
}

export function formatBitrateKbps(bitrate: number | null | undefined): string | null {
  const value = Number(bitrate);
  if (!Number.isFinite(value) || value <= 0) return null;
  const kbps = value >= 1000 ? Math.round(value / 1000) : Math.round(value);
  return `${kbps} kbps`;
}

export function formatSampleRateLabel(sampleRate: number | null | undefined): string | null {
  const value = Number(sampleRate);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000) {
    const khz = value / 1000;
    const rounded = Number.isInteger(khz) ? String(khz) : khz.toFixed(1).replace(/\.0$/, "");
    return `${rounded} kHz`;
  }
  return `${Math.round(value)} Hz`;
}

export function formatBitDepthLabel(bitDepth: number | null | undefined): string | null {
  const value = Number(bitDepth);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${Math.round(value)} Bit`;
}

/** Channel layout for tooltips: 6 → 5.1, 8 → 7.1, otherwise N.0 / stereo. */
export function formatChannelsLabel(channels: number | null | undefined): string | null {
  const value = Number(channels);
  if (!Number.isFinite(value) || value <= 0) return null;
  const n = Math.round(value);
  if (n === 6) return "5.1";
  if (n === 8) return "7.1";
  if (n === 2) return "Stereo";
  if (n === 1) return "Mono";
  return `${n}.0`;
}

/** Resolution head for local video tooltips, e.g. `Full HD · 1080p`. */
export function localVideoResolutionDescription(quality: string | null | undefined): string {
  const tier = videoQualityTier(quality);
  if (!tier) return qualityDescription(quality);
  const pixels = videoResolutionExactPixels(quality) || VIDEO_TIER_PIXELS[tier];
  return `${VIDEO_TIER_NAME[tier]} · ${pixels}`;
}

/**
 * Expanded local-file tooltip that does not awkwardly repeat the short badge
 * label (e.g. badge "FHD" → tooltip "Full HD · 1080p", not "Video · FHD · 1080p").
 *
 * Audio adapts to probed file properties when present:
 * - Hi-res / lossless: `24 Bit · 192 kHz · ALAC`
 * - Lossy: `256 kbps · AAC`
 * - Spatial: `Dolby Digital Plus 5.1 + Dolby Atmos · 768 kbps`
 *
 * Video appends probe props when present:
 * - `Full HD · 1080p · H.264 · AAC · 320 kbps`
 * - `Ultra HD · 2160p · AV1 · Opus · 768 kbps`
 */
export function localFileQualityTooltip(file: LocalFileQualityProps | null | undefined): string {
  const quality = String(file?.quality || "").trim();
  const normalized = normalizeQualityTag(quality);
  const codec = formatCodecLabel(file?.codec);
  const bitrate = formatBitrateKbps(file?.bitrate);
  const sampleRate = formatSampleRateLabel(file?.sample_rate);
  const bitDepth = formatBitDepthLabel(file?.bit_depth);
  const channels = formatChannelsLabel(file?.channels);
  const channelCount = Number(file?.channels);
  const isSpatial = isSpatialAudioQuality(normalized)
    || (Number.isFinite(channelCount) && channelCount > 2)
    || /EAC3|EC3|TRUEHD|ATMOS/i.test(String(file?.codec || ""));

  if (isVideoResolutionQuality(normalized)) {
    const base = localVideoResolutionDescription(quality);
    const explicitVideoCodec = formatCodecLabel(file?.video_codec);
    // If `codec` is itself a video FourCC (legacy/probe quirk), treat it as video.
    const codecIsVideo = isVideoCodecName(file?.codec);
    const videoCodec = explicitVideoCodec || (codecIsVideo ? codec : null);
    const audioCodec = explicitVideoCodec
      ? codec
      : (codecIsVideo ? null : codec);
    return [base, videoCodec, audioCodec, bitrate].filter(Boolean).join(" · ");
  }

  if (isSpatial) {
    const codecWithChannels = [codec || "Dolby Digital Plus", channels && channels !== "Stereo" ? channels : null]
      .filter(Boolean)
      .join(" ");
    const head = `${codecWithChannels} + Dolby Atmos`;
    return bitrate ? `${head} · ${bitrate}` : head;
  }

  if (bitDepth && sampleRate) {
    return [bitDepth, sampleRate, codec].filter(Boolean).join(" · ");
  }

  if (bitrate || codec) {
    return [bitrate, codec].filter(Boolean).join(" · ");
  }

  if (isUnknownQualityTag(normalized)) {
    return "Quality unknown";
  }

  // Fall back to the generic tier description when we have a quality tag but no probe data.
  return qualityDescription(quality);
}
