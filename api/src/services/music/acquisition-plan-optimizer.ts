import type { ProviderReleaseRelation } from "./provider-release-relation.js";
import {
  compareAudioFidelity,
  lossyQualityScore,
  type AudioFacts,
} from "../providers/audio-facts.js";

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
  /**
   * What this variant is expected to deliver, filled from the provider tier
   * when the row was written. The profile ranks by class, so these are what
   * separate two offers that tie there.
   */
  codec?: string | null;
  bitrateKbps?: number | null;
  bitDepth?: number | null;
  sampleRateHz?: number | null;
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
  /**
   * Provider release/album explicit flag. Track lists are sometimes missing or
   * stale (every track stored clean while the album is affirmatively explicit).
   * Planning uses this so an explicit edition still gets an explicit plan badge.
   */
  releaseExplicit?: boolean | null;
  trackMatches: readonly AcquisitionTrackMatch[];
}

export interface OptimizedAcquisitionTrack {
  trackId: number;
  providerEditionMatchId: number;
  providerTrackMatchId: number;
  providerEditionMemberId: number;
  providerAudioVariantId: number;
  sourceQuality: NormalizedAudioQuality;
  /**
   * What the selected variant is expected to deliver.
   *
   * The profile ranks by *class*, so two lossy tracks tie there however far
   * apart they are — TIDAL's AAC 320 and a 128 kbps stream are both `lossy`.
   * These are what separate them, and they travel with the chosen track so the
   * plan can be compared and displayed on what it will actually fetch.
   */
  deliveredCodec?: string | null;
  deliveredBitrateKbps?: number | null;
  deliveredBitDepth?: number | null;
  deliveredSampleRateHz?: number | null;
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
  /**
   * Sum of raw preference ranks, lower being better. Unlike qualityScore this
   * is not zeroed at the cutoff, so it still separates a hi-res plan from a
   * lossless one when both clear it.
   */
  qualityRankTotal: number;
  fragmentation: number;
  relationScore: number;
}

const relationRank: Record<ProviderReleaseRelation, number> = {
  exact: 4,
  source_superset: 3,
  source_subset: 2,
  overlap: 1,
};

/**
 * Order two options by the properties their variant rows carry.
 *
 * Returns >0 when `left` is worse, matching the ascending comparator it is
 * used in. Missing properties compare equal rather than as zero, so an offer
 * we know nothing about never loses to one we do merely for being unmeasured.
 */
function deliveredFacts(option: OptimizedAcquisitionTrack): AudioFacts | null {
  if (option.deliveredBitrateKbps == null && option.deliveredBitDepth == null
    && option.deliveredSampleRateHz == null) return null;
  return {
    evidenceSource: "provider-catalog", confidence: "expected",
    codec: (option.deliveredCodec ?? null) as AudioFacts["codec"],
    codecProfile: null, container: null,
    lossless: option.sourceQuality !== "lossy",
    bitDepth: option.deliveredBitDepth ?? null,
    sampleRateHz: option.deliveredSampleRateHz ?? null,
    bitrateKbps: option.deliveredBitrateKbps ?? null,
    channelCount: null, channelLayout: null,
    immersiveFormat: null, objectAudio: null,
  };
}

function compareDeliveredQuality(left: TrackOption, right: TrackOption): number {
  const leftFacts = deliveredFacts(left);
  const rightFacts = deliveredFacts(right);
  if (!leftFacts || !rightFacts) return 0;
  return compareAudioFidelity(leftFacts, rightFacts);
}

/**
 * A plan's delivered quality, summed over its tracks. Higher is better.
 *
 * Lossy tracks contribute their codec-corrected score; lossless tracks
 * contribute depth and sample rate, scaled so they cannot be outvoted by a
 * large lossy bitrate. Tracks with no delivered properties contribute nothing,
 * so a plan is never punished for a sparse variant row.
 */
function deliveredQualityTotal(tracks: readonly OptimizedAcquisitionTrack[]): number {
  let total = 0;
  for (const track of tracks) {
    if (track.sourceQuality === "lossy") {
      const facts = deliveredFacts(track);
      total += facts ? (lossyQualityScore(facts) ?? 0) : 0;
      continue;
    }
    const depth = track.deliveredBitDepth ?? 0;
    const sampleRate = track.deliveredSampleRateHz ?? 0;
    total += depth * 1000 + Math.round(sampleRate / 1000);
  }
  return total;
}

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

function trackExplicitPreferenceRank(
  explicit: boolean | null | undefined,
  preferExplicit: boolean,
): 0 | 1 {
  return matchesExplicitPreference(
    explicit === undefined ? null : explicit,
    preferExplicit,
  )
    ? 1
    : 0;
}

function compareOptions(
  profile: AcquisitionQualityProfile,
  left: TrackOption,
  right: TrackOption,
  preferExplicit: boolean = true,
): number {
  return Number(right.cutoffSatisfied) - Number(left.cutoffSatisfied)
    || effectiveQualityScore(profile, right) - effectiveQualityScore(profile, left)
    // Past the cutoff every allowed quality scores 0, so without this a
    // hi-res and a lossless option are indistinguishable and the winner falls
    // out of row-id order. The cutoff governs whether we keep upgrading files;
    // it must not make a fresh choice between offers arbitrary.
    || left.qualityRank - right.qualityRank
    // Same class: order by what the offers actually deliver. Lossy compares on
    // a codec-corrected score, so 128 kbps Opus beats 128 kbps MP3; lossless
    // compares on depth then sample rate. Presentation is deliberately not
    // consulted — whether immersive beats hi-res stereo is a profile
    // preference, and the profile has already spoken by this point.
    || compareDeliveredQuality(right, left)
    // Same quality: prefer the explicit stream when Settings says so.
    || trackExplicitPreferenceRank(right.explicit, preferExplicit)
      - trackExplicitPreferenceRank(left.explicit, preferExplicit)
    || right.relationRank - left.relationRank
    || left.providerEditionMatchId - right.providerEditionMatchId
    || left.providerTrackMatchId - right.providerTrackMatchId
    || left.providerAudioVariantId - right.providerAudioVariantId;
}

/**
 * The best quality this plan actually reaches, which is the tier it represents
 * in the one-plan-per-achievable-tier enumeration. A source that only offers
 * lossless yields a lossless plan even when the library targets hi-res; before
 * this the target was copied onto every plan, so a lossless offer displayed as
 * Hi-Res and shared a plan key with a genuinely hi-res one.
 */
function achievedTier(
  tracks: readonly { sourceQuality: NormalizedAudioQuality; qualityRank?: number }[],
  fallback: NormalizedAudioQuality,
  profile?: AcquisitionQualityProfile,
): NormalizedAudioQuality {
  let bestQuality: NormalizedAudioQuality | undefined;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const track of tracks) {
    const rank = typeof track.qualityRank === "number"
      ? track.qualityRank
      : (profile ? qualityRank(profile, track.sourceQuality) : Number.MAX_SAFE_INTEGER);
    if (rank < bestRank) {
      bestRank = rank;
      bestQuality = track.sourceQuality;
    }
  }
  return bestQuality ?? fallback;
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

/**
 * Plan-ranking fidelity total. Lower is better.
 *
 * When the library continues upgrades past the cutoff (Max), every step of the
 * ladder counts — so a 24-bit plan beats a 16-bit plan even across providers or
 * composite vs single-source.
 *
 * When upgrades are off (High), anything at-or-better-than the cutoff is treated
 * as equal fidelity for ranking. That keeps a coherent lossless album preferred
 * over a fragmented hi-res composite once the cutoff is met, while still
 * preferring lossless over lossy.
 */
function rankingQualityRankTotal(
  profile: AcquisitionQualityProfile,
  tracks: readonly { sourceQuality: NormalizedAudioQuality }[],
): number {
  const cutoff = qualityRank(profile, profile.cutoff);
  let total = 0;
  for (const track of tracks) {
    let rank = qualityRank(profile, track.sourceQuality);
    if (!profile.continueUpgradesAfterCutoff && rank < cutoff) {
      rank = cutoff;
    }
    total += rank;
  }
  return total;
}

export type ExplicitStatus = boolean | null;

export function explicitStatusFromPlanContent(
  content: PlanExplicitContent,
): ExplicitStatus {
  if (content === "explicit") return true;
  if (content === "clean") return false;
  return null;
}

export function matchesExplicitPreference(
  status: ExplicitStatus,
  preferExplicit: boolean,
): boolean {
  return preferExplicit
    ? status === true
    : status !== true;
}

/**
 * Rank plan-level explicitness under Settings → prefer_explicit.
 * Higher is better.
 */
export function planExplicitPreferenceRank(
  explicitContent: PlanExplicitContent,
  preferExplicit: boolean,
): 0 | 1 {
  return matchesExplicitPreference(
    explicitStatusFromPlanContent(explicitContent),
    preferExplicit,
  )
    ? 1
    : 0;
}

/**
 * Fidelity band for preferred-plan ranking. Lower is better.
 *
 * Settings quality is a *preferred maximum* (cutoff). Tiers at or better than
 * that maximum share one band when `continueUpgradesAfterCutoff` is false:
 *
 *   **Max**  — continue upgrades: hi-res < lossless < lossy (each step distinct)
 *   **High** — cutoff lossless, no continue: hi-res ≡ lossless; lossy worse
 *   **Normal / Low** — cutoff lossy, no continue: hi-res ≡ lossless ≡ lossy
 *
 * So under Normal, a single-source “normal” plan and a hi-res composite compete
 * on coverage / assembly / provider — not on fidelity class. Coverage is ranked
 * *before* fidelity: a complete lossy plan always outranks a partial hi-res one.
 * Among equal-coverage (including full vs full) plans, higher quality wins.
 *
 * Gap fill (Option B) is **not** nested plans: one AcquisitionPlan may assign
 * lower-quality variants only to holes; band reflects the best tier reached.
 */
function planFidelityBand(
  profile: AcquisitionQualityProfile,
  plan: Pick<CandidatePlan, "qualityTier" | "tracks">,
): number {
  const tier = plan.tracks.length > 0
    ? achievedTier(plan.tracks, profile.cutoff, profile)
    : (plan.qualityTier as NormalizedAudioQuality);
  let rank = qualityRank(profile, tier);
  const cutoff = qualityRank(profile, profile.cutoff);
  // Collapse everything better than the preferred maximum into one band.
  if (!profile.continueUpgradesAfterCutoff && rank < cutoff) {
    rank = cutoff;
  }
  return rank;
}

/**
 * Rank stored plan alternatives for default selection.
 *
 * Order of importance:
 *   1. prefer_explicit / prefer clean — soft coverage floor (GMTF reprise case)
 *   2. **Coverage** — complete beats partial at any quality band
 *   3. **Fidelity band** — among equal coverage (see planFidelityBand)
 *   4. Quality score / rank total (Max still splits hi-res vs lossless inside band)
 *   5. Assembly simplicity — single-source over composite when bands/coverage tie
 *   6. Relation / provider preference
 */
function compareCandidatePlans(
  left: CandidatePlan,
  right: CandidatePlan,
  providerPriority: ReadonlyMap<string, number>,
  profile: AcquisitionQualityProfile,
  preferExplicit: boolean,
): number {
  const bestCoverage = Math.max(left.coverage, right.coverage, 1);
  // Explicit wins when it is at least 90% as complete as the rival (and within
  // a one-track soft floor for small albums). A full clean Atmos product must
  // not beat a 26/27 explicit composite that only lacks a non-explicit reprise.
  const explicitCoverageFloor = Math.max(1, Math.ceil(bestCoverage * 0.9));
  const leftPreferenceOk =
    matchesExplicitPreference(
      explicitStatusFromPlanContent(left.explicitContent),
      preferExplicit,
    )
    && left.coverage >= explicitCoverageFloor;
  const rightPreferenceOk =
    matchesExplicitPreference(
      explicitStatusFromPlanContent(right.explicitContent),
      preferExplicit,
    )
    && right.coverage >= explicitCoverageFloor;
  if (leftPreferenceOk !== rightPreferenceOk) {
    return Number(rightPreferenceOk) - Number(leftPreferenceOk);
  }

  // Coverage before fidelity: a full High/Normal/Low plan outranks a partial
  // Max plan. Only another full-coverage plan (single-source or composite) at
  // higher quality may outrank a complete lower-tier match.
  return right.coverage - left.coverage
    || planFidelityBand(profile, left) - planFidelityBand(profile, right)
    || right.cutoffSatisfied - left.cutoffSatisfied
    || planExplicitPreferenceRank(right.explicitContent, preferExplicit)
      - planExplicitPreferenceRank(left.explicitContent, preferExplicit)
    || right.qualityScore - left.qualityScore
    || rankingQualityRankTotal(profile, left.tracks)
      - rankingQualityRankTotal(profile, right.tracks)
    // Every score above reads the quality *class*, so two lossy plans tie
    // there however far apart they are — TIDAL's AAC 320 and a 128 kbps stream
    // are both `lossy`. What the offers actually deliver breaks it, before
    // source count or provider priority get a say.
    || deliveredQualityTotal(right.tracks) - deliveredQualityTotal(left.tracks)
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
  let qualityRankTotal = 0;
  for (const track of candidate.tracks) {
    const rank = qualityRank(profile, track.sourceQuality);
    const meetsCutoff = cutoffSatisfied(profile, track.sourceQuality);
    if (meetsCutoff) satisfied += 1;
    // Each candidate was built under a profile aimed at its own tier, so its
    // ranks are only comparable once restated against the library's profile.
    qualityRankTotal += rank;
    qualityScore += effectiveQualityScore(profile, {
      qualityRank: rank,
      cutoffSatisfied: meetsCutoff,
    });
  }
  return { ...candidate, cutoffSatisfied: satisfied, qualityScore, qualityRankTotal };
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

/**
 * Whether `other` covers every track of `candidate` at equal-or-better quality
 * (same provider and plan-level explicitness). Used for dominance pruning so a
 * full MAX single-source plan eliminates both partial singles and multi-single
 * composites that only rebuild the same tracklist.
 */
/** Stereo and spatial are different media products — never rank one over the other. */
function isSpatialQuality(quality: NormalizedAudioQuality): boolean {
  return quality === "spatial";
}

function planWeaklyCovers(
  profile: AcquisitionQualityProfile,
  other: CandidatePlan,
  candidate: CandidatePlan,
): boolean {
  if (other.provider !== candidate.provider) return false;
  if (other.explicitContent !== candidate.explicitContent) return false;
  const otherByTrack = new Map(other.tracks.map((track) => [track.trackId, track]));
  for (const track of candidate.tracks) {
    const rival = otherByTrack.get(track.trackId);
    if (!rival) return false;
    // Spatial never fills stereo and vice versa, even if a (misconfigured) profile
    // listed both. Those plans live on separate libraries and stay independent.
    if (isSpatialQuality(rival.sourceQuality) !== isSpatialQuality(track.sourceQuality)) {
      return false;
    }
    // qualityRank is preference-order index: lower is better. Rival must be
    // at least as good as the candidate track (rank <= candidate rank).
    if (qualityRank(profile, rival.sourceQuality) > qualityRank(profile, track.sourceQuality)) {
      return false;
    }
  }
  return true;
}

/**
 * `other` dominates `candidate` when candidate is not a real alternative product.
 *
 * Dominated (drop candidate):
 *  - same tracklist quality outcome (outcomeSignature), worse assembly
 *  - proper track-set subset of other, at ≤ quality per track (partial singles)
 *  - same track set, equal-or-better quality on every track (worse single-source
 *    tier, or composite rebuild of the same product)
 *
 * Not dominated (keep both):
 *  - composite that upgrades at least one track above every single-source plan
 *  - clean vs explicit (different explicitContent — planWeaklyCovers refuses)
 *  - stereo vs spatial (different media family — planWeaklyCovers refuses; also
 *    planned on separate libraries under separate quality profiles)
 *
 * Policy is per edition × library × provider × explicitness: at most one best
 * single-source, plus a composite only when it is strictly better. Stereo and
 * Spatial libraries each run this independently, so a Spatial Atmos plan is
 * never discarded because a Stereo MAX plan exists (or vice versa).
 */
function planDominates(
  profile: AcquisitionQualityProfile,
  other: CandidatePlan,
  candidate: CandidatePlan,
): boolean {
  if (other === candidate) return false;
  if (!planWeaklyCovers(profile, other, candidate)) return false;

  // Identical product (tracks + quality + explicitness): prefer fewer sources.
  if (other.outcomeSignature === candidate.outcomeSignature) {
    return other.sourceIds.length < candidate.sourceIds.length
      || (other.sourceIds.length === candidate.sourceIds.length
        && other.sourceIds.join(",") < candidate.sourceIds.join(","));
  }

  const otherTrackIds = new Set(other.tracks.map((track) => track.trackId));
  const candidateIsTrackSubset = candidate.tracks.every((track) =>
    otherTrackIds.has(track.trackId));

  // Full edition eliminates partial singles/subsets of the same (or worse) quality.
  if (candidateIsTrackSubset && other.tracks.length > candidate.tracks.length) {
    return true;
  }

  // Same tracks, other is ≥ quality on every track (and not identical outcome —
  // handled above). Drop the worse tier single or the noisier assembly.
  if (other.tracks.length === candidate.tracks.length && candidateIsTrackSubset) {
    const otherByTrack = new Map(other.tracks.map((track) => [track.trackId, track]));
    let anyStrictlyBetter = false;
    for (const track of candidate.tracks) {
      const rival = otherByTrack.get(track.trackId)!;
      const rivalRank = qualityRank(profile, rival.sourceQuality);
      const trackRank = qualityRank(profile, track.sourceQuality);
      if (rivalRank < trackRank) anyStrictlyBetter = true;
    }
    // Strictly better quality on any track → dominate the inferior product.
    // Equal quality everywhere → dominate when fewer sources (composite noise).
    if (anyStrictlyBetter) return true;
    if (other.sourceIds.length < candidate.sourceIds.length) return true;
  }

  return false;
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
 *
 * Release-level `true` also makes the plan explicit: TIDAL (and others) often
 * mark only a subset of tracks explicit, and stale track rows can all say clean
 * while the album resource is still the explicit edition. Without this, the UI
 * never shows an E badge on plans for albums that are explicitly explicit.
 */
function planExplicitContent(
  counts: PlanExplicitnessCounts,
  sourceReleaseExplicit: readonly (boolean | null | undefined)[] = [],
): PlanExplicitContent {
  if (counts.explicitTrackCount > 0) return "explicit";
  if (sourceReleaseExplicit.some((value) => value === true)) return "explicit";
  if (counts.unknownExplicitnessCount > 0) return "unknown";
  if (sourceReleaseExplicit.some((value) => value == null) && counts.cleanTrackCount === 0) {
    return "unknown";
  }
  return counts.cleanTrackCount > 0 ? "clean" : "unknown";
}

/**
 * Quality tier the listener receives for one track — the dimension composite
 * cover uses when deciding whether source A fills a hole left by source B.
 *
 * Explicitness is intentionally *not* in this key. Distorted Light Beam
 * (reprise) often has Atmos only on the clean TIDAL product while the rest of
 * the album has Atmos on the explicit product; the composite must be free to
 * take explicit for 26 tracks and clean for that one non-explicit reprise.
 * Plan-level explicitContent still becomes "explicit" as soon as any selected
 * track/release is explicit, and plan ranking still prefers that plan.
 */
function trackOutcomeKey(option: TrackOption): string {
  return option.sourceQuality;
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
  preferExplicit: boolean = true,
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
        // A track on an explicit *album* counts as the explicit product for
        // preference even when the track row itself is stored clean (instrumental
        // / non-swearing). Otherwise an exact clean match outranks an overlap
        // explicit Atmos product purely on relation, and we never seed a
        // composite that fills Distorted Light Beam (reprise) from clean.
        const optionExplicit = match.explicit === true || source.releaseExplicit === true
          ? true
          : match.explicit === false
            ? false
            : null;
        const option: TrackOption = {
          trackId: match.trackId,
          providerEditionMatchId: source.providerEditionMatchId,
          providerTrackMatchId: match.providerTrackMatchId,
          providerEditionMemberId: match.providerEditionMemberId,
          providerAudioVariantId: variant.id,
          sourceQuality: variant.quality,
          deliveredCodec: variant.codec ?? null,
          deliveredBitrateKbps: variant.bitrateKbps ?? null,
          deliveredBitDepth: variant.bitDepth ?? null,
          deliveredSampleRateHz: variant.sampleRateHz ?? null,
          qualityRank: qualityRank(profile, variant.quality),
          cutoffSatisfied: cutoffSatisfied(profile, variant.quality),
          relationRank: relationRank[source.relation],
          explicit: optionExplicit,
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
      preferredFirst(left) - preferredFirst(right)
      || compareOptions(profile, left, right, preferExplicit))[0];

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
    const usedReleaseExplicit = usedSourceIds.map(
      (sourceId) => sourceById.get(sourceId)?.releaseExplicit,
    );
    return {
      provider: orderedSources[0].provider,
      preferredSourceId: preferredSource
        && usedSourceIds.includes(preferredSource.providerEditionMatchId)
        ? preferredSource.providerEditionMatchId
        : null,
      // The tier the plan actually delivers (best track quality), not the
      // library cutoff. Labelling every plan with the profile target made a
      // lossless plan display as Hi-Res and collapsed different offers onto
      // one plan key.
      qualityTier: achievedTier(tracks, profile.cutoff),
      explicitContent: planExplicitContent(counts, usedReleaseExplicit),
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
      qualityRankTotal: tracks.reduce((sum, track) => sum + track.qualityRank, 0),
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

  // Drop singles that another single already weakly covers at ≥ quality with a
  // strictly better product (more tracks, better quality, or same outcome with
  // fewer/preferred sources). A full MAX exact edition therefore eliminates
  // every partial single that only rebuilds a subset of its tracklist — those
  // are not choices, they are noise. Distinct products stay: e.g. a deluxe
  // superset vs a standard exact, or a hi-res partial that a lossless full
  // cannot match track-for-track.
  const meaningfulSingles = singles.filter((candidate) =>
    !singles.some((other) => planDominates(profile, other, candidate)));

  // D. The best delivered outcome per canonical track, whoever supplies it.
  const desiredByTrack = new Map<number, string>();
  for (const trackId of orderedTrackIds) {
    const option = bestOption(optionsByTrack.get(trackId) || []);
    if (option) desiredByTrack.set(trackId, trackOutcomeKey(option));
  }

  // E. Fit the fewest sources to that outcome. When prefer_explicit is on, seed
  // with the best explicit source so clean fills holes (Distorted Light Beam
  // reprise) rather than a full clean single winning the set cover alone.
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

  let compositeSeedId = preferredSource?.providerEditionMatchId ?? null;
  if (preferExplicit && compositeSeedId == null) {
    const explicitSeed = orderedSources
      .map((source) => ({
        id: source.providerEditionMatchId,
        explicitBias: source.releaseExplicit === true
          ? 2
          : source.trackMatches.some((match) => match.explicit === true)
            ? 1
            : 0,
        coverage: coveredBySource.get(source.providerEditionMatchId)?.size ?? 0,
      }))
      .filter((entry) => entry.explicitBias > 0 && entry.coverage > 0)
      .sort((left, right) =>
        right.explicitBias - left.explicitBias
        || right.coverage - left.coverage
        || left.id - right.id)[0];
    compositeSeedId = explicitSeed?.id ?? null;
  }

  const combinedSourceIds = minimumSourceCover({
    universe: [...desiredByTrack.keys()],
    coveredBySource,
    preferredSourceId: compositeSeedId,
  });
  const combined = combinedSourceIds.length > 1 ? materialize(combinedSourceIds) : null;

  // F. A composite is only worth storing when no single-source plan already
  // delivers that tracklist at equal-or-better quality *and* equal-or-better
  // explicitness. A full clean single must not silence an explicit+clean
  // composite that prefers the explicit product for every track that has it.
  //
  // Exception: when the user preferred a specific offer, a composite that keeps
  // that offer must not be silenced by a pure secondary single that merely
  // scores higher on quality. Preference is a ranking axis, not a quality one.
  const preservesPreference = (plan: CandidatePlan): boolean =>
    preferredSource != null
    && plan.sourceIds.includes(preferredSource.providerEditionMatchId);

  if (
    combined
    && meaningfulSingles.some((single) => {
      if (preservesPreference(combined) && !preservesPreference(single)) {
        return false;
      }
      if (planDominates(profile, single, combined)) return true;
      // Same tracklist quality, worse assembly — but only drop the composite
      // when the single is at least as preferred on explicitness.
      if (
        planWeaklyCovers(profile, single, combined)
        && single.tracks.length >= combined.tracks.length
        && single.qualityScore >= combined.qualityScore
        && planExplicitPreferenceRank(single.explicitContent, preferExplicit)
          >= planExplicitPreferenceRank(combined.explicitContent, preferExplicit)
      ) {
        return true;
      }
      return false;
    })
  ) {
    return meaningfulSingles;
  }
  return combined ? [...meaningfulSingles, combined] : meaningfulSingles;
}

/**
 * Optimize within each provider first, then compare the best provider-local
 * plans. Cross-provider composite plans are intentionally unsupported.
 *
 * Policy (per edition × library × provider × explicitness):
 *   - one best single-source plan under the library's quality profile
 *   - one composite only when it strictly improves coverage or quality
 *   - clean and explicit both kept when MusicBrainz does not split them
 *
 * Stereo vs Spatial is a library dimension, not a plan-tier dimension. Each
 * library has its own quality profile (stereo ladder vs spatial-only) and
 * plans are computed per library, so an Atmos plan is never discarded because
 * a stereo MAX plan exists, and vice versa.
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
  /** Settings → filtering.prefer_explicit (default true). */
  preferExplicit?: boolean;
}): OptimizedAcquisitionPlan[] {
  const preferredId = input.preferredProviderEditionMatchId ?? null;
  const preferredSource = preferredId == null
    ? null
    : input.sources.find((source) => source.providerEditionMatchId === preferredId) ?? null;
  const preferExplicit = input.preferExplicit !== false;

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
  const planRank = (left: CandidatePlan, right: CandidatePlan): number =>
    preferredKept(left) - preferredKept(right)
    || compareCandidatePlans(left, right, providerPriority, input.profile, preferExplicit);

  // One search under the library profile (not one fan-out per quality tier).
  // Dominance then keeps the best single-source and an optional better composite
  // per provider × explicitness.
  const built: CandidatePlan[] = [];
  for (const sources of byProvider.values()) {
    built.push(...buildProviderPlans(
      input.orderedTrackIds,
      input.profile,
      sources,
      preferredSource,
      preferExplicit,
    ));
  }

  // Scores are already relative to the library profile; re-score is still
  // applied so any future builder path stays comparable.
  const ranked = built
    .map((candidate) => rescoreAgainstProfile(input.profile, candidate))
    .sort(planRank);

  // Collapse plans that deliver an identical *or dominated* result. Exact
  // outcome signatures keep only the highest-ranked assembly; weak dominance
  // also drops a composite or partial that a better full plan already covers
  // at equal-or-better per-track quality (GMTF: keep the MAX single-source,
  // drop the multi-single rebuild *and* a same-tracklist lossless exact).
  //
  // A plan that still carries the user's preferred offer is never dominated by
  // one that dropped it — preference survives as a real alternative.
  const preservesPreference = (plan: CandidatePlan): boolean =>
    preferredSource != null
    && plan.sourceIds.includes(preferredSource.providerEditionMatchId);

  const seenOutcomes = new Set<string>();
  const kept: CandidatePlan[] = [];
  for (const candidate of ranked) {
    if (seenOutcomes.has(candidate.outcomeSignature)) continue;
    if (kept.some((other) => {
      if (preservesPreference(candidate) && !preservesPreference(other)) return false;
      return planDominates(input.profile, other, candidate);
    })) continue;
    seenOutcomes.add(candidate.outcomeSignature);
    kept.push(candidate);
  }

  // Cap to one best single-source and at most one composite per
  // (provider, explicitContent). Dominance already dropped worse tiers; this
  // guarantees the stored set matches the product policy even when two
  // non-dominated singles remain (e.g. disjoint track sets of equal rank).
  const selected = selectBestPlansPerBucket(
    kept,
    providerPriority,
    preferredKept,
    input.profile,
    preferExplicit,
  );

  return selected.map((candidate) => {
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
 * Per (provider, explicitContent): keep the best single-source and the best
 * composite (if any). Stereo/spatial never share a bucket with each other in
 * practice — they use different libraries and profiles — but explicit clean
 * vs explicit do, and both survive when MusicBrainz has not split them.
 */
function selectBestPlansPerBucket(
  plans: readonly CandidatePlan[],
  providerPriority: ReadonlyMap<string, number>,
  preferredKept: (plan: CandidatePlan) => number,
  profile: AcquisitionQualityProfile,
  preferExplicit: boolean,
): CandidatePlan[] {
  const rank = (left: CandidatePlan, right: CandidatePlan): number =>
    preferredKept(left) - preferredKept(right)
    || compareCandidatePlans(left, right, providerPriority, profile, preferExplicit);

  const buckets = new Map<string, CandidatePlan[]>();
  for (const plan of plans) {
    const key = `${plan.provider}|${plan.explicitContent}`;
    const group = buckets.get(key) || [];
    group.push(plan);
    buckets.set(key, group);
  }
  const selected: CandidatePlan[] = [];
  for (const group of buckets.values()) {
    const singles = group
      .filter((plan) => plan.composition === "single_source")
      .sort(rank);
    const composites = group
      .filter((plan) => plan.composition === "composite")
      .sort(rank);
    if (singles[0]) selected.push(singles[0]);
    if (composites[0]) selected.push(composites[0]);
  }
  // Preserve global ranking order among the survivors.
  return selected.sort(rank);
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
  preferExplicit?: boolean;
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
