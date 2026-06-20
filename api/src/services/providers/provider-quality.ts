/**
 * Neutral (provider-agnostic) audio/video quality model.
 *
 * Historically TIDAL's quality vocabulary (LOSSLESS / HIRES_LOSSLESS /
 * DOLBY_ATMOS / HIGH ...) leaked through the whole app: callers branched on raw
 * provider strings. That makes the streaming-provider abstraction TIDAL-shaped.
 *
 * This module introduces a single normalized enum every provider maps into, plus
 * per-provider mapping helpers. Callers reason about `NeutralAudioQuality` /
 * `NeutralVideoQuality`; each adapter owns the translation between its own raw
 * tags and the neutral tiers.
 */

/** Provider-agnostic stereo audio tiers, ordered low -> high fidelity. */
export type NeutralAudioQuality =
  | "lossy"            // compressed AAC/MP3 (TIDAL HIGH/LOW, Apple AAC)
  | "lossless"         // CD-quality 16-bit FLAC/ALAC
  | "hires-lossless";  // >16-bit / >44.1kHz FLAC/ALAC

/** Spatial audio is modelled as a separate axis from stereo fidelity. */
export type NeutralSpatialQuality = "atmos" | "spatial-360";

/** Provider-agnostic video tiers, ordered low -> high resolution. */
export type NeutralVideoQuality = "sd" | "hd" | "fhd";

export const NEUTRAL_AUDIO_QUALITY_RANK: Record<NeutralAudioQuality, number> = {
  lossy: 0,
  lossless: 1,
  "hires-lossless": 2,
};

export const NEUTRAL_VIDEO_QUALITY_RANK: Record<NeutralVideoQuality, number> = {
  sd: 0,
  hd: 1,
  fhd: 2,
};

export interface NeutralQuality {
  /** Best stereo tier the offer supports, if any. */
  audio?: NeutralAudioQuality | null;
  /** Spatial formats the offer supports (empty when stereo-only). */
  spatial?: NeutralSpatialQuality[];
}

/**
 * A provider quality mapping translates between the provider's own raw quality
 * vocabulary and the neutral model. Each adapter supplies one so the rest of the
 * app never needs to know a provider's strings.
 */
export interface ProviderQualityMapping {
  readonly provider: string;
  /** Map a single raw provider audio tag to a neutral tier (null if unknown/spatial-only). */
  toNeutralAudio(rawQuality: string | null | undefined): NeutralAudioQuality | null;
  /** Map raw provider tags to a full neutral descriptor (stereo + spatial). */
  toNeutral(rawTags: Iterable<string | null | undefined>): NeutralQuality;
  /** Map a neutral stereo tier back to the provider's raw audio quality string. */
  fromNeutralAudio(quality: NeutralAudioQuality): string;
}

const SPATIAL_360_MARKERS = ["360", "SONY_360", "360RA"];
const ATMOS_MARKERS = ["ATMOS", "DOLBY"];
const HIRES_MARKERS = ["HIRES", "HI_RES", "MASTER", "MQA", "MAX"];
const LOSSLESS_MARKERS = ["LOSSLESS", "FLAC", "ALAC", "CD"];

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** Shared heuristic used as a sane default when a provider has no bespoke rule. */
export function classifyNeutralSpatial(raw: string | null | undefined): NeutralSpatialQuality | null {
  const normalized = normalize(raw);
  if (!normalized) return null;
  if (SPATIAL_360_MARKERS.some((m) => normalized.includes(m))) return "spatial-360";
  if (ATMOS_MARKERS.some((m) => normalized.includes(m)) || normalized.includes("SPATIAL")) return "atmos";
  return null;
}

/** Shared heuristic for stereo fidelity classification. */
export function classifyNeutralAudio(raw: string | null | undefined): NeutralAudioQuality | null {
  const normalized = normalize(raw);
  if (!normalized) return null;
  // Spatial-only tags carry no stereo fidelity signal.
  if (classifyNeutralSpatial(normalized)) {
    // HIRES + ATMOS combos still imply a hi-res stereo stream exists; fall through.
    if (!HIRES_MARKERS.some((m) => normalized.includes(m)) && !LOSSLESS_MARKERS.some((m) => normalized.includes(m))) {
      return null;
    }
  }
  if (HIRES_MARKERS.some((m) => normalized.includes(m))) return "hires-lossless";
  if (LOSSLESS_MARKERS.some((m) => normalized.includes(m))) return "lossless";
  if (normalized === "LOW" || normalized === "NORMAL" || normalized === "HIGH" || normalized.includes("AAC") || normalized.includes("MP3")) {
    return "lossy";
  }
  return null;
}

/**
 * Build a NeutralQuality from a set of raw tags using the shared heuristics.
 * Adapters can use this directly or override with provider-specific logic.
 */
export function classifyNeutralQuality(rawTags: Iterable<string | null | undefined>): NeutralQuality {
  let audio: NeutralAudioQuality | null = null;
  const spatial = new Set<NeutralSpatialQuality>();
  for (const tag of rawTags) {
    const a = classifyNeutralAudio(tag);
    if (a && (!audio || NEUTRAL_AUDIO_QUALITY_RANK[a] > NEUTRAL_AUDIO_QUALITY_RANK[audio])) {
      audio = a;
    }
    const s = classifyNeutralSpatial(tag);
    if (s) spatial.add(s);
  }
  return { audio, spatial: Array.from(spatial) };
}

/** Whether a neutral quality descriptor includes any spatial format. */
export function isNeutralSpatial(quality: NeutralQuality): boolean {
  return Boolean(quality.spatial && quality.spatial.length > 0);
}
