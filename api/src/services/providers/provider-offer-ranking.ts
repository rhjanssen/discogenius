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
    // An unavailable plugin still gets the shared best-effort classification
    // from the normalized audio-variant label.
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
 * A provider item can expose several ProviderItemAudioVariants at one provider
 * id. Project the selected variant's normalized labels into the backend request
 * without treating source capability as a local file-quality fact.
 */
export function projectProviderSpatialOffer(
  providerId: string | null | undefined,
  rawQualities: Iterable<string | null | undefined>,
  sourceCapabilityProof = false,
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
    // An unavailable plugin still gets the shared best-effort classification.
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

  // `quality_class='spatial'` is itself normalized source-capability evidence
  // even when the provider did not supply a more specific spatial label.
  return sourceCapabilityProof
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
