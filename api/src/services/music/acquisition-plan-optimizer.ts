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
  /** Provider-native explicit flag; null when the provider does not say. */
  explicit?: boolean | null;
  variants: readonly AcquisitionAudioVariant[];
}

/**
 * What a plan actually delivers.
 *
 * There is deliberately no "mixed": a plan containing one explicit track is an
 * explicit plan, because that is what the user will hear. "unknown" is the
 * honest answer when nothing is affirmatively explicit but some selected track
 * carries no reliable evidence — absent metadata never means clean.
 */
export type PlanExplicitContent = "explicit" | "clean" | "unknown";

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
  /** The quality tier this plan was built to target. */
  qualityTier: NormalizedAudioQuality;
  /** What the plan's selected tracks actually deliver. */
  explicitContent: PlanExplicitContent;
  /** Diagnostic breakdown behind explicitContent. */
  explicitnessCounts: PlanExplicitnessCounts;
  /** Stable shape identity; see acquisitionPlanKey. */
  planKey: string;
  tracks: OptimizedAcquisitionTrack[];
}

interface TrackOption extends OptimizedAcquisitionTrack {
  qualityRank: number;
  cutoffSatisfied: boolean;
  relationRank: number;
  explicit: boolean | null;
}

// planKey is derived once the plan is final, so candidates carry everything but.
interface CandidatePlan extends Omit<OptimizedAcquisitionPlan, "planKey"> {
  outcomeSignature: string;
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

/**
 * What a plan actually delivers: which canonical tracks, at which source
 * quality. Two plans with the same signature are the same product for the user
 * even when they are assembled from different Provider Editions — one direct
 * match plus ten singles, or one direct match plus one subset match, are not
 * two choices worth storing or showing.
 */

function rescoreAgainstProfile(
  profile: AcquisitionQualityProfile,
  candidate: CandidatePlan,
): CandidatePlan {
  let satisfied = 0;
  let qualityScore = 0;
  for (const track of candidate.tracks) {
    const rank = qualityRank(profile, track.sourceQuality);
    const meetsCutoff = cutoffSatisfied(profile, track.sourceQuality);
    if (meetsCutoff) satisfied += 1;
    qualityScore += effectiveQualityScore(profile, {
      qualityRank: rank,
      cutoffSatisfied: meetsCutoff,
    });
  }
  return { ...candidate, cutoffSatisfied: satisfied, qualityScore };
}

function outcomeSignature(provider: string, tracks: readonly TrackOption[]): string {
  // What the listener ends up with: which canonical tracks, at what quality,
  // with what explicitness. Plans equivalent here are the same product however
  // they are assembled, so only the best-ranked one is kept — and since ranking
  // prefers fewer sources, that is the coherent subset match rather than the ten
  // singles reproducing it.
  //
  // The exact provider plumbing (which Provider Track match, which audio
  // variant) is deliberately *not* part of this key: it belongs to plan
  // identity, so a user's chosen plan stays exactly reproducible. See
  // acquisitionPlanKey.
  const perTrack = tracks
    .map((track) => [
      track.trackId,
      track.sourceQuality,
      track.explicit === null ? "?" : track.explicit ? "e" : "c",
    ].join(":"))
    .sort();
  return `${provider}|${perTrack.join(",")}`;
}

/** The exact canonical tracks a plan covers, order-independent. */
export function planTrackSetKey(plan: { tracks: readonly { trackId: number }[] }): string {
  return [...new Set(plan.tracks.map((track) => track.trackId))]
    .sort((left, right) => left - right)
    .join(",");
}

export type PlanExplicitnessCounts = {
  explicitTrackCount: number;
  cleanTrackCount: number;
  unknownExplicitnessCount: number;
};

function explicitnessCounts(tracks: readonly TrackOption[]): PlanExplicitnessCounts {
  let explicitTrackCount = 0;
  let cleanTrackCount = 0;
  let unknownExplicitnessCount = 0;
  for (const track of tracks) {
    if (track.explicit === true) explicitTrackCount += 1;
    else if (track.explicit === false) cleanTrackCount += 1;
    else unknownExplicitnessCount += 1;
  }
  return { explicitTrackCount, cleanTrackCount, unknownExplicitnessCount };
}

/**
 * Explicit as soon as one selected track is affirmatively explicit; clean only
 * when every selected track is affirmatively known clean; otherwise unknown.
 *
 * A composite whose standard source is clean and whose deluxe source carries one
 * explicit track is an explicit plan — not a "mixed" one.
 */
function planExplicitContent(counts: PlanExplicitnessCounts): PlanExplicitContent {
  if (counts.explicitTrackCount > 0) return "explicit";
  if (counts.unknownExplicitnessCount > 0) return "unknown";
  return counts.cleanTrackCount > 0 ? "clean" : "unknown";
}

/**
 * A profile that aims at one specific tier: that tier is preferred above all
 * others and is the cutoff, so the search maximises tracks at it and fills the
 * remainder from lower tiers.
 *
 * Enumerating one plan per tier is what keeps the stored set finite. Without it
 * the optimizer would happily produce "1 track at max + 19 at high", "2 at max
 * + 18 at high" and every step in between, all of which are strictly worse than
 * the best plan for their tier.
 */
function profileTargeting(
  profile: AcquisitionQualityProfile,
  tier: NormalizedAudioQuality,
): AcquisitionQualityProfile {
  const rest = profile.preferenceOrder.filter((quality) => quality !== tier);
  return {
    allowedQualities: profile.allowedQualities,
    preferenceOrder: [tier, ...rest],
    cutoff: tier,
    continueUpgradesAfterCutoff: false,
  };
}

/** Tiers the provider's own variants can actually deliver, best first. */
function availableTiers(
  profile: AcquisitionQualityProfile,
  sources: readonly AcquisitionSourceCandidate[],
): NormalizedAudioQuality[] {
  const present = new Set<NormalizedAudioQuality>();
  for (const source of sources) {
    for (const match of source.trackMatches) {
      for (const variant of match.variants) {
        if (variant.available && profile.allowedQualities.has(variant.quality)) {
          present.add(variant.quality);
        }
      }
    }
  }
  return profile.preferenceOrder.filter((quality) => present.has(quality));
}

/**
 * The delivered result for one canonical track, independent of who supplies it.
 *
 * Two provider editions offering the same track at the same quality and the same
 * explicitness deliver the same file to the listener. Compressing a plan onto
 * the fewest sources is only sound because of that: swapping a source for
 * another that matches this key changes nothing the user can hear.
 */
function trackOutcomeKey(option: TrackOption): string {
  return `${option.sourceQuality}|${option.explicit === null ? "?" : option.explicit ? "e" : "c"}`;
}

/**
 * The smallest set of provider editions that can still deliver `desiredByTrack`.
 *
 * Exhaustively enumerating source subsets — which this replaces — was both
 * exponential and wrong at the edges: past fifteen sources it silently degraded
 * to "each source alone, or all of them together", so the sixteenth source
 * turned a carefully composed two-source plan into a blunt everything-at-once
 * one. There was no reason for the behaviour to change at that boundary except
 * that the loop had run out of bits.
 *
 * The outcome is decided first and the sources are fitted to it afterwards, so
 * the search is an ordinary minimum set cover: each source covers the tracks it
 * can deliver at the already-chosen outcome. Dominated sources are dropped —
 * one whose covered tracks are a subset of another's adds nothing — and the rest
 * are searched depth-first, branching on the least-covered track, under a node
 * budget with a greedy solution as both the seed and the fallback. Every step is
 * ordered by id, so shuffled inputs give the same answer.
 */
function minimumSourceCover(input: {
  universe: readonly number[];
  coveredBySource: ReadonlyMap<number, ReadonlySet<number>>;
  /** Never pruned: the user asked for this offer by name. */
  preferredSourceId: number | null;
}): number[] {
  const sourceIds = [...input.coveredBySource.keys()]
    .filter((sourceId) => (input.coveredBySource.get(sourceId)?.size ?? 0) > 0)
    .sort((left, right) => left - right);
  if (sourceIds.length === 0) return [];

  // Dominance pruning. A source covering a subset of another's tracks can never
  // be needed: anywhere it would appear, the other serves instead.
  const kept: number[] = [];
  for (const sourceId of sourceIds) {
    if (sourceId === input.preferredSourceId) {
      kept.push(sourceId);
      continue;
    }
    const covered = input.coveredBySource.get(sourceId)!;
    const dominated = sourceIds.some((otherId) => {
      if (otherId === sourceId) return false;
      const other = input.coveredBySource.get(otherId)!;
      if (other.size < covered.size) return false;
      // Equal sets: keep the lower id so the choice is stable.
      if (other.size === covered.size && otherId > sourceId) return false;
      for (const trackId of covered) {
        if (!other.has(trackId)) return false;
      }
      return true;
    });
    if (!dominated) kept.push(sourceId);
  }

  const coverable = new Set<number>();
  for (const sourceId of kept) {
    for (const trackId of input.coveredBySource.get(sourceId)!) coverable.add(trackId);
  }
  const universe = input.universe.filter((trackId) => coverable.has(trackId));
  if (universe.length === 0) return [];

  const marginal = (sourceId: number, remaining: ReadonlySet<number>): number => {
    let count = 0;
    for (const trackId of input.coveredBySource.get(sourceId)!) {
      if (remaining.has(trackId)) count += 1;
    }
    return count;
  };

  // Greedy seed: an upper bound the exact search can prune against, and the
  // answer itself if the search runs out of budget.
  const greedy: number[] = [];
  const remaining = new Set(universe);
  if (input.preferredSourceId != null && kept.includes(input.preferredSourceId)) {
    greedy.push(input.preferredSourceId);
    for (const trackId of input.coveredBySource.get(input.preferredSourceId)!) {
      remaining.delete(trackId);
    }
  }
  while (remaining.size > 0) {
    let best: number | null = null;
    let bestGain = 0;
    for (const sourceId of kept) {
      if (greedy.includes(sourceId)) continue;
      const gain = marginal(sourceId, remaining);
      if (gain > bestGain) {
        best = sourceId;
        bestGain = gain;
      }
    }
    if (best == null) break;
    greedy.push(best);
    for (const trackId of input.coveredBySource.get(best)!) remaining.delete(trackId);
  }

  let best = [...greedy].sort((left, right) => left - right);
  let budget = 20_000;
  const search = (chosen: number[], uncovered: Set<number>): void => {
    if (budget <= 0) return;
    budget -= 1;
    if (uncovered.size === 0) {
      const candidate = [...chosen].sort((left, right) => left - right);
      if (
        candidate.length < best.length
        || (candidate.length === best.length
          && candidate.join(",") < best.join(","))
      ) {
        best = candidate;
      }
      return;
    }
    if (chosen.length + 1 > best.length) return;

    // Branch on the track the fewest sources can supply: it forces the decision
    // rather than deferring it, which is what keeps the tree shallow.
    let pivot = -1;
    let pivotOptions: number[] = [];
    for (const trackId of uncovered) {
      const options = kept.filter((sourceId) =>
        !chosen.includes(sourceId) && input.coveredBySource.get(sourceId)!.has(trackId));
      if (pivot < 0 || options.length < pivotOptions.length) {
        pivot = trackId;
        pivotOptions = options;
      }
      if (options.length <= 1) break;
    }
    if (pivot < 0 || pivotOptions.length === 0) return;

    for (const sourceId of pivotOptions) {
      const nextUncovered = new Set(uncovered);
      for (const trackId of input.coveredBySource.get(sourceId)!) nextUncovered.delete(trackId);
      search([...chosen, sourceId], nextUncovered);
    }
  };
  const seed = input.preferredSourceId != null && kept.includes(input.preferredSourceId)
    ? [input.preferredSourceId]
    : [];
  const seedUncovered = new Set(universe);
  for (const sourceId of seed) {
    for (const trackId of input.coveredBySource.get(sourceId)!) seedUncovered.delete(trackId);
  }
  search(seed, seedUncovered);
  return best;
}

/**
 * Best plan per composition shape for one provider, decided outcome-first.
 *
 * Single offers come from walking the complete canonical track list against one
 * coherent provider edition. The combined offer comes from deciding the best
 * delivered outcome per track across every source, then fitting the fewest
 * sources to that outcome — never from enumerating source subsets and scoring
 * each one.
 */
function buildProviderPlans(
  orderedTrackIds: readonly number[],
  profile: AcquisitionQualityProfile,
  sources: readonly AcquisitionSourceCandidate[],
  preferredSource: AcquisitionSourceCandidate | null,
  targetTier: NormalizedAudioQuality,
): CandidatePlan[] {
  if (sources.length === 0) return [];
  const orderedSources = [...sources]
    .sort((left, right) => left.providerEditionMatchId - right.providerEditionMatchId);
  const sourceById = new Map(
    orderedSources.map((source) => [source.providerEditionMatchId, source]),
  );
  const optionsByTrack = new Map<number, TrackOption[]>();
  for (const source of orderedSources) {
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
          explicit: match.explicit ?? null,
        };
        const options = optionsByTrack.get(match.trackId) || [];
        options.push(option);
        optionsByTrack.set(match.trackId, options);
      }
    }
  }

  // The user's chosen offer supplies every track it carries; other accepted
  // sources only fill what it does not have. Without this the ordinary ranking
  // would quietly drop the preferred offer whenever a secondary edition scored
  // better on relation or quality.
  const preferredFirst = (option: TrackOption): number =>
    preferredSource && option.providerEditionMatchId === preferredSource.providerEditionMatchId
      ? 0
      : 1;
  const bestOption = (options: readonly TrackOption[]): TrackOption | undefined =>
    [...options].sort((left, right) =>
      preferredFirst(left) - preferredFirst(right) || compareOptions(profile, left, right))[0];

  /** Walk the complete canonical track list against one set of sources. */
  const materialize = (allowedSourceIds: readonly number[]): CandidatePlan | null => {
    const allowedSources = new Set(allowedSourceIds);
    const usedMembers = new Set<number>();
    const tracks: TrackOption[] = [];
    for (const trackId of orderedTrackIds) {
      const option = bestOption(
        (optionsByTrack.get(trackId) || []).filter((candidate) =>
          allowedSources.has(candidate.providerEditionMatchId)
          && !usedMembers.has(candidate.providerEditionMemberId)),
      );
      if (!option) continue;
      usedMembers.add(option.providerEditionMemberId);
      tracks.push(option);
    }
    if (tracks.length === 0) return null;

    const usedSourceIds = [...new Set(tracks.map((track) => track.providerEditionMatchId))]
      .sort((left, right) => left - right);
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
    const counts = explicitnessCounts(tracks);
    return {
      provider: orderedSources[0].provider,
      preferredSourceId: preferredSource
        && usedSourceIds.includes(preferredSource.providerEditionMatchId)
        ? preferredSource.providerEditionMatchId
        : null,
      qualityTier: targetTier,
      explicitContent: planExplicitContent(counts),
      explicitnessCounts: counts,
      outcomeSignature: outcomeSignature(orderedSources[0].provider, tracks),
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
  };

  // C. One offer per coherent provider edition, over the complete canonical list.
  const singles = orderedSources
    .map((source) => materialize([source.providerEditionMatchId]))
    .filter((plan): plan is CandidatePlan => plan != null);

  // Keep every single offer that something else does not already beat outright.
  // A user choosing between "the exact match" and "the deluxe superset" is
  // choosing between real alternatives; collapsing them to one hides a choice.
  const meaningfulSingles = singles.filter((candidate) => !singles.some((other) => {
    if (other === candidate) return false;
    if (other.explicitContent !== candidate.explicitContent) return false;
    const otherByTrack = new Map(other.tracks.map((track) => [track.trackId, track]));
    for (const track of candidate.tracks) {
      const rival = otherByTrack.get(track.trackId);
      if (!rival) return false;
      if (qualityRank(profile, rival.sourceQuality) > qualityRank(profile, track.sourceQuality)) {
        return false;
      }
    }
    // Strictly better somewhere, or identical and losing the id tie-break.
    return other.tracks.length > candidate.tracks.length
      || other.qualityScore > candidate.qualityScore
      || (other.outcomeSignature === candidate.outcomeSignature
        && other.sourceIds.join(",") < candidate.sourceIds.join(","));
  }));

  // D. The best delivered outcome per canonical track, whoever supplies it.
  const desiredByTrack = new Map<number, string>();
  for (const trackId of orderedTrackIds) {
    const option = bestOption(optionsByTrack.get(trackId) || []);
    if (option) desiredByTrack.set(trackId, trackOutcomeKey(option));
  }

  // E. Fit the fewest sources to that outcome.
  const coveredBySource = new Map<number, Set<number>>();
  for (const source of orderedSources) {
    const covered = new Set<number>();
    for (const trackId of desiredByTrack.keys()) {
      const desired = desiredByTrack.get(trackId)!;
      const deliverable = (optionsByTrack.get(trackId) || []).some((option) =>
        option.providerEditionMatchId === source.providerEditionMatchId
        && trackOutcomeKey(option) === desired);
      if (deliverable) covered.add(trackId);
    }
    coveredBySource.set(source.providerEditionMatchId, covered);
  }
  const combinedSourceIds = minimumSourceCover({
    universe: [...desiredByTrack.keys()],
    coveredBySource,
    preferredSourceId: preferredSource?.providerEditionMatchId ?? null,
  });
  const combined = combinedSourceIds.length > 1 ? materialize(combinedSourceIds) : null;

  // F. The combined offer earns its place only by delivering something no single
  // offer does. Outcome-equivalent duplicates are dropped by the caller's
  // signature dedup, which prefers the already-higher-ranked plan.
  return combined ? [...meaningfulSingles, combined] : meaningfulSingles;
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

  // One plan per provider, per achievable quality tier, per composition shape.
  // That is the axis set a user actually chooses along; everything else is a
  // permutation of the same product.
  const built: CandidatePlan[] = [];
  for (const sources of byProvider.values()) {
    for (const tier of availableTiers(input.profile, sources)) {
      built.push(...buildProviderPlans(
        input.orderedTrackIds,
        profileTargeting(input.profile, tier),
        sources,
        preferredSource,
        tier,
      ));
    }
  }

  // Each candidate was searched under a profile aimed at its own tier, so its
  // cutoff and quality scores are relative to that target. Re-score every
  // candidate against the library's real profile before ranking them against
  // each other, otherwise a lossless-targeted plan looks like it satisfies more
  // of the cutoff than a hi-res-targeted plan simply because its bar was lower.
  const ranked = built
    .map((candidate) => rescoreAgainstProfile(input.profile, candidate))
    .sort((left, right) =>
      preferredKept(left) - preferredKept(right)
      || compareCandidatePlans(left, right, providerPriority));

  // Collapse plans that deliver an identical result. The survivor is the one
  // already ranked highest, which prefers fewer sources — so a direct match
  // beats the composite that reproduces it, and one subset match beats ten
  // singles that cover the same tracks at the same quality.
  const seenOutcomes = new Set<string>();
  const distinct = ranked.filter((candidate) => {
    if (seenOutcomes.has(candidate.outcomeSignature)) return false;
    seenOutcomes.add(candidate.outcomeSignature);
    return true;
  });

  return distinct.map((candidate) => {
    const {
      coverage,
      outcomeSignature: _outcomeSignature,
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
  qualityTier: NormalizedAudioQuality;
  explicitContent: PlanExplicitContent;
  sourceIds: readonly number[];
  tracks: readonly {
    trackId: number;
    providerTrackMatchId: number;
    providerAudioVariantId: number;
    sourceQuality: NormalizedAudioQuality;
  }[];
}): string {
  const sources = [...plan.sourceIds].sort((left, right) => left - right).join(",");
  // Pin the exact acquisition: which Provider Track match and which audio
  // variant fulfils each canonical track. A key built from quality alone would
  // match a differently-sourced plan after replanning and silently hand the
  // user something they did not choose.
  const assignments = plan.tracks
    .map((track) =>
      `${track.trackId}>${track.providerTrackMatchId}@${track.providerAudioVariantId}`
      + `:${track.sourceQuality}`)
    .sort()
    .join(",");
  return `${plan.provider}|${plan.qualityTier}|${plan.explicitContent}`
    + `|${plan.composition}|${sources}|${assignments}`;
}
