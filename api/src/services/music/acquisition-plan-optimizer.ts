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
  /**
   * The Provider Edition the user asked for, when it survived into the plan.
   * It becomes the plan's `primary` source regardless of how many tracks it
   * contributes, so the preference is still recoverable on the next replan.
   */
  preferredSourceId: number | null;
  /** Canonical tracks this plan actually covers. */
  coverage: number;
  /** Stable shape identity; see acquisitionPlanKey. */
  planKey: string;
  tracks: OptimizedAcquisitionTrack[];
}

interface TrackOption extends OptimizedAcquisitionTrack {
  qualityRank: number;
  cutoffSatisfied: boolean;
  relationRank: number;
}

// planKey is derived once the plan is final, so candidates carry everything but.
interface CandidatePlan extends Omit<OptimizedAcquisitionPlan, "planKey"> {
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

/**
 * Best plan per composition shape for one provider.
 *
 * A library is offered real alternatives — "TIDAL, one edition" versus "TIDAL,
 * two editions combined" — rather than only the single winner, so returning the
 * best `single_source` and the best `composite` plan is the useful granularity.
 * Every other subset is dominated by one of those two under the same comparator.
 */
function buildProviderPlans(
  orderedTrackIds: readonly number[],
  profile: AcquisitionQualityProfile,
  sources: readonly AcquisitionSourceCandidate[],
  preferredSource: AcquisitionSourceCandidate | null = null,
): CandidatePlan[] {
  if (sources.length === 0) return [];
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

  const bestByComposition = new Map<CandidatePlan["composition"], CandidatePlan>();
  const neutralPriority = new Map<string, number>();
  for (const subset of subsets) {
    const allowedSources = new Set(subset);
    const usedMembers = new Set<number>();
    const tracks: TrackOption[] = [];
    // Within a subset the user's chosen offer supplies every track it carries;
    // other accepted sources only fill what it does not have. Without this the
    // ordinary ranking would quietly drop the preferred offer whenever a
    // secondary edition scored better on relation or quality.
    const preferredFirst = (option: TrackOption): number =>
      preferredSource && option.providerEditionMatchId === preferredSource.providerEditionMatchId
        ? 0
        : 1;
    for (const trackId of orderedTrackIds) {
      const option = [...(optionsByTrack.get(trackId) || [])]
        .filter((candidate) =>
          allowedSources.has(candidate.providerEditionMatchId)
          && !usedMembers.has(candidate.providerEditionMemberId))
        .sort((left, right) =>
          preferredFirst(left) - preferredFirst(right)
          || compareOptions(profile, left, right))[0];
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
      preferredSourceId: preferredSource
        && usedSourceIds.includes(preferredSource.providerEditionMatchId)
        ? preferredSource.providerEditionMatchId
        : null,
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
    // A subset that keeps the user's chosen offer wins before any other
    // ranking key: the preference is intent, not a scoring hint.
    const keepsPreferred = (plan: CandidatePlan): number =>
      preferredSource && plan.preferredSourceId != null ? 0 : 1;
    const incumbent = bestByComposition.get(candidate.composition);
    if (
      !incumbent
      || keepsPreferred(candidate) - keepsPreferred(incumbent) < 0
      || (keepsPreferred(candidate) === keepsPreferred(incumbent)
        && compareCandidatePlans(candidate, incumbent, neutralPriority) < 0)
    ) {
      bestByComposition.set(candidate.composition, candidate);
    }
  }
  return [...bestByComposition.values()];
}

/**
 * Optimize within each provider first, then compare the best provider-local
 * plans. Cross-provider composite plans are intentionally unsupported.
 *
 * A `preferredProviderEditionMatchId` is a primary preference, not a source
 * lock: planning stays inside that offer's provider, and plans containing the
 * offer outrank plans that drop it, but an accepted secondary Provider Edition
 * from the same provider may still cover canonical tracks the preferred offer
 * does not carry. Pass `exclusive` for the explicit single-source lock.
 */
export function enumerateAcquisitionPlans(input: {
  orderedTrackIds: readonly number[];
  profile: AcquisitionQualityProfile;
  sources: readonly AcquisitionSourceCandidate[];
  providerPriority: readonly string[];
  preferredProviderEditionMatchId?: number | null;
  exclusive?: boolean;
}): OptimizedAcquisitionPlan[] {
  const preferredId = input.preferredProviderEditionMatchId ?? null;
  const preferredSource = preferredId == null
    ? null
    : input.sources.find((source) => source.providerEditionMatchId === preferredId) ?? null;

  let candidateSources = input.sources;
  if (preferredSource) {
    candidateSources = input.exclusive === true
      ? [preferredSource]
      : input.sources.filter((source) => source.provider === preferredSource.provider);
  }

  const byProvider = new Map<string, AcquisitionSourceCandidate[]>();
  for (const source of candidateSources) {
    const group = byProvider.get(source.provider) || [];
    group.push(source);
    byProvider.set(source.provider, group);
  }
  const providerPriority = new Map(
    input.providerPriority.map((provider, index) => [provider, index]),
  );
  const preferredKept = (plan: CandidatePlan): number =>
    preferredSource && plan.sourceIds.includes(preferredSource.providerEditionMatchId) ? 0 : 1;
  const ranked = [...byProvider.values()]
    .flatMap((sources) =>
      buildProviderPlans(input.orderedTrackIds, input.profile, sources, preferredSource))
    .sort((left, right) =>
      preferredKept(left) - preferredKept(right)
      || compareCandidatePlans(left, right, providerPriority));

  return ranked.map((candidate) => {
    const {
      coverage,
      cutoffSatisfied: _cutoffSatisfied,
      qualityScore: _qualityScore,
      fragmentation: _fragmentation,
      relationScore: _relationScore,
      ...plan
    } = candidate;
    return { ...plan, coverage, planKey: acquisitionPlanKey(plan) };
  });
}

/**
 * Best plan only. Kept for callers that genuinely want one answer; the ranked
 * list is what gets persisted so a library can be offered its alternatives.
 */
export function optimizeAcquisitionPlan(input: {
  orderedTrackIds: readonly number[];
  profile: AcquisitionQualityProfile;
  sources: readonly AcquisitionSourceCandidate[];
  providerPriority: readonly string[];
  preferredProviderEditionMatchId?: number | null;
  exclusive?: boolean;
}): OptimizedAcquisitionPlan | null {
  return enumerateAcquisitionPlans(input)[0] ?? null;
}

/**
 * Stable identity for a plan's shape: provider, the exact set of Provider
 * Edition sources it draws on, its composition, and the source qualities it
 * resolves to.
 *
 * Plan rows are deleted and rebuilt on every replan, so a user's chosen plan
 * cannot be remembered by row id. This key survives replanning as long as the
 * same alternative is still available, and stops existing when it genuinely is
 * not — which is exactly when the choice should be reported as unavailable
 * rather than silently swapped.
 */
export function acquisitionPlanKey(plan: {
  provider: string;
  composition: string;
  sourceIds: readonly number[];
  tracks: readonly { sourceQuality: NormalizedAudioQuality }[];
}): string {
  const sources = [...plan.sourceIds].sort((left, right) => left - right).join(",");
  const qualities = [...new Set(plan.tracks.map((track) => track.sourceQuality))].sort().join("+");
  return `${plan.provider}|${plan.composition}|${sources}|${qualities}`;
}
