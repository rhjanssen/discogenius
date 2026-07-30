import type { ProviderReleaseRelation } from "./provider-release-relation.js";

export type NormalizedAudioQuality =
  | "lossy"
  | "lossless"
  | "hires-lossless"
  | "spatial";

export interface AcquisitionQualityProfile {
  allowedQualities: ReadonlySet<NormalizedAudioQuality>;
  /** Best to worst. */
  preferenceOrder: readonly NormalizedAudioQuality[];
  cutoff: NormalizedAudioQuality;
  continueUpgradesAfterCutoff: boolean;
}

export interface AcquisitionAudioVariant {
  id: number;
  quality: NormalizedAudioQuality;
  available: boolean;
}

export interface AcquisitionTrackMatch {
  providerTrackMatchId: number;
  providerEditionMemberId: number;
  trackId: number;
  variants: readonly AcquisitionAudioVariant[];
}

export interface AcquisitionSourceCandidate {
  provider: string;
  providerEditionMatchId: number;
  relation: ProviderReleaseRelation;
  sourceTrackCount: number;
  albumDownloadSafe: boolean;
  trackMatches: readonly AcquisitionTrackMatch[];
}

export interface OptimizedAcquisitionTrack {
  trackId: number;
  providerEditionMatchId: number;
  providerTrackMatchId: number;
  providerEditionMemberId: number;
  providerAudioVariantId: number;
  sourceQuality: NormalizedAudioQuality;
}

export interface OptimizedAcquisitionPlan {
  provider: string;
  composition: "single_source" | "composite";
  downloadMode: "album" | "tracks";
  sourceIds: number[];
  tracks: OptimizedAcquisitionTrack[];
}

interface TrackOption extends OptimizedAcquisitionTrack {
  qualityRank: number;
  cutoffSatisfied: boolean;
  relationRank: number;
}

interface CandidatePlan extends OptimizedAcquisitionPlan {
  coverage: number;
  cutoffSatisfied: number;
  qualityScore: number;
  fragmentation: number;
  relationScore: number;
}

const relationRank: Record<ProviderReleaseRelation, number> = {
  exact: 4,
  source_superset: 3,
  source_subset: 2,
  overlap: 1,
};

function qualityRank(
  profile: AcquisitionQualityProfile,
  quality: NormalizedAudioQuality,
): number {
  const index = profile.preferenceOrder.indexOf(quality);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function cutoffSatisfied(
  profile: AcquisitionQualityProfile,
  quality: NormalizedAudioQuality,
): boolean {
  const rank = qualityRank(profile, quality);
  const cutoff = qualityRank(profile, profile.cutoff);
  return rank <= cutoff;
}

function effectiveQualityScore(
  profile: AcquisitionQualityProfile,
  option: Pick<TrackOption, "qualityRank" | "cutoffSatisfied">,
): number {
  if (option.cutoffSatisfied && !profile.continueUpgradesAfterCutoff) return 0;
  return Number.MAX_SAFE_INTEGER - option.qualityRank;
}

function compareOptions(
  profile: AcquisitionQualityProfile,
  left: TrackOption,
  right: TrackOption,
): number {
  return Number(right.cutoffSatisfied) - Number(left.cutoffSatisfied)
    || effectiveQualityScore(profile, right) - effectiveQualityScore(profile, left)
    || right.relationRank - left.relationRank
    || left.providerEditionMatchId - right.providerEditionMatchId
    || left.providerTrackMatchId - right.providerTrackMatchId
    || left.providerAudioVariantId - right.providerAudioVariantId;
}

function planFragmentation(
  orderedTrackIds: readonly number[],
  tracks: readonly OptimizedAcquisitionTrack[],
): number {
  if (tracks.length <= 1) return 0;
  const sourceByTrack = new Map(tracks.map((track) => [track.trackId, track.providerEditionMatchId]));
  const counts = new Map<number, number>();
  for (const track of tracks) {
    counts.set(track.providerEditionMatchId, (counts.get(track.providerEditionMatchId) || 0) + 1);
  }
  const principal = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
  let transitions = 0;
  let outsidePrincipal = 0;
  let isolated = 0;
  let previous: number | null = null;
  for (let index = 0; index < orderedTrackIds.length; index += 1) {
    const source = sourceByTrack.get(orderedTrackIds[index]);
    if (source == null) continue;
    if (previous != null && previous !== source) transitions += 1;
    if (source !== principal) {
      outsidePrincipal += 1;
      const before = sourceByTrack.get(orderedTrackIds[index - 1]);
      const after = sourceByTrack.get(orderedTrackIds[index + 1]);
      if (before !== source && after !== source) isolated += 1;
    }
    previous = source;
  }
  return transitions + outsidePrincipal + isolated;
}

function compareCandidatePlans(
  left: CandidatePlan,
  right: CandidatePlan,
  providerPriority: ReadonlyMap<string, number>,
): number {
  return right.coverage - left.coverage
    || right.cutoffSatisfied - left.cutoffSatisfied
    || right.qualityScore - left.qualityScore
    || left.sourceIds.length - right.sourceIds.length
    || left.fragmentation - right.fragmentation
    || right.relationScore - left.relationScore
    || (providerPriority.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
      - (providerPriority.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
    || left.sourceIds.join(",").localeCompare(right.sourceIds.join(","));
}

function buildProviderPlan(
  orderedTrackIds: readonly number[],
  profile: AcquisitionQualityProfile,
  sources: readonly AcquisitionSourceCandidate[],
): CandidatePlan | null {
  if (sources.length === 0) return null;
  const sourceById = new Map(sources.map((source) => [source.providerEditionMatchId, source]));
  const optionsByTrack = new Map<number, TrackOption[]>();
  for (const source of sources) {
    for (const match of source.trackMatches) {
      for (const variant of match.variants) {
        if (!variant.available || !profile.allowedQualities.has(variant.quality)) continue;
        const option: TrackOption = {
          trackId: match.trackId,
          providerEditionMatchId: source.providerEditionMatchId,
          providerTrackMatchId: match.providerTrackMatchId,
          providerEditionMemberId: match.providerEditionMemberId,
          providerAudioVariantId: variant.id,
          sourceQuality: variant.quality,
          qualityRank: qualityRank(profile, variant.quality),
          cutoffSatisfied: cutoffSatisfied(profile, variant.quality),
          relationRank: relationRank[source.relation],
        };
        const options = optionsByTrack.get(match.trackId) || [];
        options.push(option);
        optionsByTrack.set(match.trackId, options);
      }
    }
  }

  const sourceIds = [...sourceById.keys()].sort((a, b) => a - b);
  const subsets: number[][] = [];
  if (sourceIds.length <= 15) {
    for (let mask = 1; mask < (1 << sourceIds.length); mask += 1) {
      const subset: number[] = [];
      for (let bit = 0; bit < sourceIds.length; bit += 1) {
        if (mask & (1 << bit)) subset.push(sourceIds[bit]);
      }
      subsets.push(subset);
    }
  } else {
    subsets.push(sourceIds);
    for (const sourceId of sourceIds) subsets.push([sourceId]);
  }

  let best: CandidatePlan | null = null;
  const neutralPriority = new Map<string, number>();
  for (const subset of subsets) {
    const allowedSources = new Set(subset);
    const usedMembers = new Set<number>();
    const tracks: TrackOption[] = [];
    for (const trackId of orderedTrackIds) {
      const option = [...(optionsByTrack.get(trackId) || [])]
        .filter((candidate) =>
          allowedSources.has(candidate.providerEditionMatchId)
          && !usedMembers.has(candidate.providerEditionMemberId))
        .sort((left, right) => compareOptions(profile, left, right))[0];
      if (!option) continue;
      usedMembers.add(option.providerEditionMemberId);
      tracks.push(option);
    }
    if (tracks.length === 0) continue;
    const usedSourceIds = [...new Set(tracks.map((track) => track.providerEditionMatchId))]
      .sort((a, b) => a - b);
    const singleSource = usedSourceIds.length === 1
      ? sourceById.get(usedSourceIds[0])
      : null;
    const albumSafe = Boolean(
      singleSource
      && singleSource.relation === "exact"
      && singleSource.albumDownloadSafe
      && tracks.length === orderedTrackIds.length
      && singleSource.sourceTrackCount === orderedTrackIds.length
      && singleSource.trackMatches.length === orderedTrackIds.length,
    );
    const candidate: CandidatePlan = {
      provider: sources[0].provider,
      composition: usedSourceIds.length === 1 ? "single_source" : "composite",
      downloadMode: albumSafe ? "album" : "tracks",
      sourceIds: usedSourceIds,
      tracks,
      coverage: tracks.length,
      cutoffSatisfied: tracks.filter((track) => track.cutoffSatisfied).length,
      qualityScore: tracks.reduce(
        (sum, track) => sum + effectiveQualityScore(profile, track),
        0,
      ),
      fragmentation: planFragmentation(orderedTrackIds, tracks),
      relationScore: usedSourceIds.reduce(
        (sum, sourceId) => sum + relationRank[sourceById.get(sourceId)!.relation],
        0,
      ),
    };
    if (!best || compareCandidatePlans(candidate, best, neutralPriority) < 0) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Optimize within each provider first, then compare the best provider-local
 * plans. Cross-provider composite plans are intentionally unsupported.
 */
export function optimizeAcquisitionPlan(input: {
  orderedTrackIds: readonly number[];
  profile: AcquisitionQualityProfile;
  sources: readonly AcquisitionSourceCandidate[];
  providerPriority: readonly string[];
}): OptimizedAcquisitionPlan | null {
  const byProvider = new Map<string, AcquisitionSourceCandidate[]>();
  for (const source of input.sources) {
    const group = byProvider.get(source.provider) || [];
    group.push(source);
    byProvider.set(source.provider, group);
  }
  const providerPriority = new Map(
    input.providerPriority.map((provider, index) => [provider, index]),
  );
  const plans = [...byProvider.values()]
    .map((sources) => buildProviderPlan(input.orderedTrackIds, input.profile, sources))
    .filter((plan): plan is CandidatePlan => plan != null)
    .sort((left, right) => compareCandidatePlans(left, right, providerPriority));
  const best = plans[0];
  if (!best) return null;
  const {
    coverage: _coverage,
    cutoffSatisfied: _cutoffSatisfied,
    qualityScore: _qualityScore,
    fragmentation: _fragmentation,
    relationScore: _relationScore,
    ...plan
  } = best;
  return plan;
}
