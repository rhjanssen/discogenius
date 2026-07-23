import {
  classifyNeutralAudio,
  classifyNeutralSpatial,
  type NeutralAudioQuality,
  type NeutralSpatialQuality,
} from "./provider-quality.js";
import { streamingProviderManager } from "./index.js";

export type AudioOfferRankInput = {
  provider: string;
  quality?: string | null;
  providerId?: string;
  provider_id?: string;
};

export type SpatialOfferProjection = {
  /** Canonical download quality understood by every spatial backend. */
  quality: "DOLBY_ATMOS" | "SONY_360RA";
  /** Higher is better; kept aligned with release-group slot selection. */
  rank: number;
};

export type SpatialOfferRankInput = AudioOfferRankInput & {
  spatialRank?: number;
};

/**
 * Cross-provider stereo fidelity score.
 *
 * ProviderItems deliberately retain each provider's native quality vocabulary,
 * so raw string comparisons are not meaningful across services (for example,
 * Deezer `FLAC` is lossless while YouTube `YOUTUBE_LOSSY` is compressed).
 * Resolve through the adapter's neutral mapping first and preserve the small
 * HIGH/LOW distinction inside the lossy tier.
 */
export function providerAudioQualityRank(
  providerId: string | null | undefined,
  rawQuality: string | null | undefined,
): number {
  let neutral: NeutralAudioQuality | null = null;
  try {
    neutral = streamingProviderManager
      .getStreamingProvider(String(providerId || "").trim())
      .qualityMapping
      ?.toNeutralAudio(rawQuality) ?? null;
  } catch {
    // Unknown/removed provider: retain a best-effort shared classification so
    // legacy ProviderItems remain rankable during migrations.
  }
  neutral ??= classifyNeutralAudio(rawQuality);

  if (neutral === "hires-lossless") return 1000;
  if (neutral === "lossless") return 900;
  if (neutral === "lossy") {
    const normalized = String(rawQuality || "").trim().toUpperCase().replace(/[\s-]+/gu, "_");
    if (
      normalized === "HIGH"
      || normalized === "NORMAL"
      || normalized.includes("320")
      || normalized === "HQ"
    ) {
      return 200;
    }
    if (normalized === "LOW" || normalized === "LQ") return 50;
    return 100;
  }

  return 0;
}

/**
 * Derive a spatial download request from all known capability tags.
 *
 * A ProviderItems row has one scalar `quality`, but an album can expose stereo
 * and spatial variants at the same provider id. Adapters preserve that
 * multi-axis capability in `match_evidence.providerQualityTags`; projecting it
 * here keeps persisted provider ids stable while still asking the backend for
 * the requested stream.
 */
export function projectProviderSpatialOffer(
  providerId: string | null | undefined,
  rawQualities: Iterable<string | null | undefined>,
  legacySpatialProof = false,
): SpatialOfferProjection | null {
  const qualities = Array.from(rawQualities)
    .map((quality) => String(quality ?? "").trim())
    .filter(Boolean);
  const formats = new Set<NeutralSpatialQuality>();

  try {
    const mapped = streamingProviderManager
      .getStreamingProvider(String(providerId || "").trim())
      .qualityMapping
      ?.toNeutral(qualities)
      .spatial ?? [];
    for (const format of mapped) formats.add(format);
  } catch {
    // Unknown/removed providers and malformed legacy tags still get the shared
    // best-effort classification below.
  }

  for (const quality of qualities) {
    const format = classifyNeutralSpatial(quality);
    if (format) formats.add(format);
  }

  if (formats.has("atmos")) {
    return { quality: "DOLBY_ATMOS", rank: 1000 };
  }
  if (formats.has("spatial-360")) {
    return { quality: "SONY_360RA", rank: 920 };
  }

  // Older rows sometimes only carry library_slot='spatial'. Before capability
  // tags were persisted, that slot represented the supported Atmos job.
  return legacySpatialProof
    ? { quality: "DOLBY_ATMOS", rank: 1000 }
    : null;
}

/** Higher fidelity first; provider preference only breaks equal-fidelity ties. */
export function compareAudioOffersByQualityThenProvider(
  left: AudioOfferRankInput,
  right: AudioOfferRankInput,
): number {
  const qualityDelta = providerAudioQualityRank(right.provider, right.quality)
    - providerAudioQualityRank(left.provider, left.quality);
  if (qualityDelta !== 0) return qualityDelta;

  const providerDelta = streamingProviderManager.getProviderPreferenceRank(left.provider)
    - streamingProviderManager.getProviderPreferenceRank(right.provider);
  if (providerDelta !== 0) return providerDelta;

  const leftId = String(left.providerId ?? left.provider_id ?? "");
  const rightId = String(right.providerId ?? right.provider_id ?? "");
  return leftId.localeCompare(rightId);
}

/** Spatial format first (Atmos before 360), then the configured provider order. */
export function compareSpatialOffersByQualityThenProvider(
  left: SpatialOfferRankInput,
  right: SpatialOfferRankInput,
): number {
  const leftRank = left.spatialRank
    ?? projectProviderSpatialOffer(left.provider, [left.quality])?.rank
    ?? 0;
  const rightRank = right.spatialRank
    ?? projectProviderSpatialOffer(right.provider, [right.quality])?.rank
    ?? 0;
  const qualityDelta = rightRank - leftRank;
  if (qualityDelta !== 0) return qualityDelta;

  const providerDelta = streamingProviderManager.getProviderPreferenceRank(left.provider)
    - streamingProviderManager.getProviderPreferenceRank(right.provider);
  if (providerDelta !== 0) return providerDelta;

  const leftId = String(left.providerId ?? left.provider_id ?? "");
  const rightId = String(right.providerId ?? right.provider_id ?? "");
  return leftId.localeCompare(rightId);
}
