import assert from "node:assert/strict";
import test from "node:test";
import {
  enumerateAcquisitionPlans,
  optimizeAcquisitionPlan,
  type AcquisitionQualityProfile,
  type AcquisitionSourceCandidate,
  type NormalizedAudioQuality,
} from "./acquisition-plan-optimizer.js";

const variantId: Record<NormalizedAudioQuality, number> = {
  lossy: 1,
  lossless: 2,
  "hires-lossless": 3,
  spatial: 4,
};

function source(
  id: number,
  relation: AcquisitionSourceCandidate["relation"],
  trackQualities: Array<[number, NormalizedAudioQuality]>,
  overrides: Partial<AcquisitionSourceCandidate> = {},
): AcquisitionSourceCandidate {
  return {
    provider: "tidal",
    providerEditionMatchId: id,
    relation,
    sourceTrackCount: trackQualities.length,
    albumDownloadSafe: true,
    trackMatches: trackQualities.map(([trackId, quality], index) => ({
      providerTrackMatchId: id * 100 + index,
      providerEditionMemberId: id * 1000 + index,
      trackId,
      variants: [{ id: id * 10 + variantId[quality], quality, available: true }],
    })),
    ...overrides,
  };
}

const high: AcquisitionQualityProfile = {
  allowedQualities: new Set(["lossless", "hires-lossless"]),
  preferenceOrder: ["hires-lossless", "lossless", "lossy", "spatial"],
  cutoff: "lossless",
  continueUpgradesAfterCutoff: false,
};

const max: AcquisitionQualityProfile = {
  allowedQualities: new Set(["lossless", "hires-lossless"]),
  preferenceOrder: ["hires-lossless", "lossless", "lossy", "spatial"],
  cutoff: "hires-lossless",
  continueUpgradesAfterCutoff: true,
};

test("HIGH chooses one coherent exact lossless source over a fragmented hi-res composite", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "source_subset", [[1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"]]),
      source(20, "exact", [[1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"]]),
    ],
  });
  assert.deepEqual(plan?.sourceIds, [20]);
  assert.equal(plan?.composition, "single_source");
  assert.equal(plan?.downloadMode, "album");
});

test("MAX creates a justified standard plus deluxe quality composite", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: max,
    providerPriority: ["tidal"],
    sources: [
      source(10, "source_subset", [[1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"]]),
      source(20, "exact", [[1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"]]),
    ],
  });
  assert.deepEqual(plan?.sourceIds, [10, 20]);
  assert.equal(plan?.composition, "composite");
  assert.equal(plan?.downloadMode, "tracks");
  assert.deepEqual(plan?.tracks.map((track) => track.sourceQuality), [
    "hires-lossless",
    "hires-lossless",
    "hires-lossless",
    "lossless",
  ]);
});

test("same-quality singles do not fragment an equivalent coherent plan", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3],
    profile: max,
    providerPriority: ["tidal"],
    sources: [
      source(20, "exact", [[1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"]]),
      source(30, "source_subset", [[2, "hires-lossless"]]),
    ],
  });
  assert.deepEqual(plan?.sourceIds, [20]);
  assert.equal(plan?.downloadMode, "album");
});

test("source superset uses track mode and leaves extras unassigned", () => {
  const superset = source(
    40,
    "source_superset",
    [[1, "lossless"], [2, "lossless"]],
    { sourceTrackCount: 3 },
  );
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [superset],
  });
  assert.deepEqual(plan?.tracks.map((track) => track.trackId), [1, 2]);
  assert.equal(plan?.downloadMode, "tracks");
});

test("provider-local plans are compared only after optimization", () => {
  const apple = source(
    50,
    "exact",
    [[1, "lossless"], [2, "lossless"]],
    { provider: "apple-music" },
  );
  const tidal = source(
    60,
    "exact",
    [[1, "lossless"], [2, "lossless"]],
    { provider: "tidal" },
  );
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["apple-music", "tidal"],
    sources: [tidal, apple],
  });
  assert.equal(plan?.provider, "apple-music");
  assert.deepEqual(plan?.sourceIds, [50]);
});

test("a preferred provider edition is a primary preference, not a source lock", () => {
  // The user picked offer 10, which only covers three of the four canonical
  // tracks. Offer 20 (same provider) carries the missing one.
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    preferredProviderEditionMatchId: 10,
    sources: [
      source(10, "source_subset", [
        [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"],
      ]),
      source(20, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"],
      ]),
    ],
  });

  assert.ok(plan);
  assert.equal(plan.tracks.length, 4, "the secondary source must cover the missing track");
  assert.equal(plan.composition, "composite");
  assert.ok(plan.sourceIds.includes(10), "the preferred offer must still be used");
  assert.equal(plan.preferredSourceId, 10);
});

test("an explicit exclusive source lock keeps planning inside the chosen offer", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    preferredProviderEditionMatchId: 10,
    exclusive: true,
    sources: [
      source(10, "source_subset", [
        [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"],
      ]),
      source(20, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"],
      ]),
    ],
  });

  assert.ok(plan);
  assert.deepEqual(plan.sourceIds, [10]);
  assert.equal(plan.tracks.length, 3, "an exclusive lock accepts the incomplete coverage");
  assert.equal(plan.preferredSourceId, 10);
});

test("a preferred offer stays primary even when a secondary source carries more tracks", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    preferredProviderEditionMatchId: 10,
    sources: [
      source(10, "source_subset", [[1, "hires-lossless"]]),
      source(20, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"],
      ]),
    ],
  });

  assert.ok(plan);
  assert.equal(plan.preferredSourceId, 10);
  assert.ok(plan.sourceIds.includes(10));
  assert.ok(plan.sourceIds.includes(20));
});

test("a preference keeps planning inside the chosen provider", () => {
  const deezerExact = source(
    30,
    "exact",
    [[1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"]],
    { provider: "deezer" },
  );
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["deezer", "tidal"],
    preferredProviderEditionMatchId: 10,
    sources: [
      source(10, "source_subset", [
        [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"],
      ]),
      deezerExact,
    ],
  });

  assert.ok(plan);
  assert.equal(plan.provider, "tidal");
  assert.equal(plan.preferredSourceId, 10);
});

test("plans that deliver an identical result are stored once", () => {
  // Ten singles covering tracks 1-3 versus one subset match covering the same
  // three tracks at the same quality: the same product, assembled differently.
  const subset = source(40, "source_subset", [
    [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"],
  ]);
  const singles = [1, 2, 3].map((trackId) =>
    source(50 + trackId, "source_subset", [[trackId, "hires-lossless"]]));

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3],
    profile: max,
    providerPriority: ["tidal"],
    sources: [subset, ...singles],
  });

  const signatures = plans.map((plan) =>
    plan.tracks.map((track) => `${track.trackId}:${track.sourceQuality}`).sort().join(","));
  assert.equal(
    new Set(signatures).size,
    signatures.length,
    "no two stored plans may deliver the same tracks at the same quality",
  );
  const full = plans.filter((plan) => plan.coverage === 3);
  assert.equal(full.length, 1, "one plan per distinct outcome");
  assert.deepEqual(full[0].sourceIds, [40], "the simplest assembly wins");
});

test("a composite that reproduces the direct match is not stored", () => {
  const direct = source(60, "exact", [
    [1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"],
  ]);
  const redundantSingles = [1, 2, 3, 4].map((trackId) =>
    source(70 + trackId, "source_subset", [[trackId, "lossless"]]));

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    sources: [direct, ...redundantSingles],
  });

  const fullCoverage = plans.filter((plan) => plan.coverage === 4);
  assert.equal(fullCoverage.length, 1);
  assert.equal(fullCoverage[0].composition, "single_source");
  assert.deepEqual(fullCoverage[0].sourceIds, [60]);
});

// Regression: with a cutoff of lossless and no continue-upgrades, every allowed
// quality scores 0, so a hi-res and a lossless offer tied and the winner fell
// out of the lexicographic source-id fallback. Observed live: the same album
// picked hi-res on one edition and lossless on another purely by row order.
test("a hi-res offer beats a lossless one even when both clear the cutoff", () => {
  const losslessOffer = source(10, "exact", [[1, "lossless"], [2, "lossless"]]);
  const hiresOffer = source(20, "exact", [[1, "hires-lossless"], [2, "hires-lossless"]]);

  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    // Lower id first, so the old lexicographic fallback would have chosen it.
    sources: [losslessOffer, hiresOffer],
  });

  assert.ok(plan);
  assert.deepEqual(plan.sourceIds, [20]);
  assert.equal(plan.qualityTier, "hires-lossless");
});

// Regression: qualityTier was copied from the library target, so a source that
// only offers lossless was persisted and displayed as Hi-Res, and shared a plan
// key with a genuinely hi-res plan.
test("a plan is labelled with the tier it reaches, not the tier it targeted", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "exact", [[1, "lossless"], [2, "lossless"]]),
      source(20, "exact", [[1, "hires-lossless"], [2, "hires-lossless"]]),
    ],
  });

  const tierBySource = new Map(
    plans.filter((plan) => plan.sourceIds.length === 1)
      .map((plan) => [plan.sourceIds[0], plan.qualityTier]),
  );
  assert.equal(tierBySource.get(10), "lossless");
  assert.equal(tierBySource.get(20), "hires-lossless");
});

test("each achievable quality tier yields one plan, not every partial upgrade", () => {
  // Tracks 1-2 exist in hi-res, tracks 3-4 only in lossless.
  const mixed: AcquisitionSourceCandidate = {
    provider: "tidal",
    providerEditionMatchId: 80,
    relation: "exact",
    sourceTrackCount: 4,
    albumDownloadSafe: true,
    trackMatches: [
      { providerTrackMatchId: 801, providerEditionMemberId: 8001, trackId: 1,
        variants: [
          { id: 8101, quality: "hires-lossless", available: true },
          { id: 8102, quality: "lossless", available: true },
        ] },
      { providerTrackMatchId: 802, providerEditionMemberId: 8002, trackId: 2,
        variants: [
          { id: 8103, quality: "hires-lossless", available: true },
          { id: 8104, quality: "lossless", available: true },
        ] },
      { providerTrackMatchId: 803, providerEditionMemberId: 8003, trackId: 3,
        variants: [{ id: 8105, quality: "lossless", available: true }] },
      { providerTrackMatchId: 804, providerEditionMemberId: 8004, trackId: 4,
        variants: [{ id: 8106, quality: "lossless", available: true }] },
    ],
  };

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4],
    profile: max,
    providerPriority: ["tidal"],
    sources: [mixed],
  });

  // Two achievable tiers, so at most two plans — never "1 hi-res + 3 lossless",
  // "2 hi-res + 2 lossless", and every step between.
  assert.ok(plans.length <= 2, `expected at most one plan per tier, got ${plans.length}`);
  assert.deepEqual(
    [...new Set(plans.map((plan) => plan.qualityTier))].sort(),
    ["hires-lossless", "lossless"],
  );
});


test("one explicit track makes the whole composite explicit", () => {
  // Standard source supplies tracks 1-2 and is clean; deluxe supplies 3-4 and
  // track 4 is explicit. The delivered plan is explicit, never "mixed".
  const standard: AcquisitionSourceCandidate = {
    provider: "apple-music",
    providerEditionMatchId: 90,
    relation: "source_subset",
    sourceTrackCount: 2,
    albumDownloadSafe: false,
    trackMatches: [
      { providerTrackMatchId: 901, providerEditionMemberId: 9001, trackId: 1, explicit: false,
        variants: [{ id: 9101, quality: "lossless", available: true }] },
      { providerTrackMatchId: 902, providerEditionMemberId: 9002, trackId: 2, explicit: false,
        variants: [{ id: 9102, quality: "lossless", available: true }] },
    ],
  };
  const deluxe: AcquisitionSourceCandidate = {
    provider: "apple-music",
    providerEditionMatchId: 91,
    relation: "exact",
    sourceTrackCount: 2,
    albumDownloadSafe: false,
    trackMatches: [
      { providerTrackMatchId: 903, providerEditionMemberId: 9003, trackId: 3, explicit: false,
        variants: [{ id: 9103, quality: "lossless", available: true }] },
      { providerTrackMatchId: 904, providerEditionMemberId: 9004, trackId: 4, explicit: true,
        variants: [{ id: 9104, quality: "lossless", available: true }] },
    ],
  };

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["apple-music"],
    sources: [standard, deluxe],
  });

  const full = plans.find((plan) => plan.coverage === 4);
  assert.ok(full);
  assert.equal(full.explicitContent, "explicit");
  assert.equal(full.explicitnessCounts.explicitTrackCount, 1);
  assert.equal(full.explicitnessCounts.cleanTrackCount, 3);
  assert.equal(full.explicitnessCounts.unknownExplicitnessCount, 0);
});

test("absent explicitness evidence is unknown, never clean", () => {
  const partial: AcquisitionSourceCandidate = {
    provider: "tidal",
    providerEditionMatchId: 95,
    relation: "exact",
    sourceTrackCount: 2,
    albumDownloadSafe: true,
    trackMatches: [
      { providerTrackMatchId: 951, providerEditionMemberId: 9501, trackId: 1, explicit: false,
        variants: [{ id: 9601, quality: "lossless", available: true }] },
      // No explicit evidence at all for this track.
      { providerTrackMatchId: 952, providerEditionMemberId: 9502, trackId: 2, explicit: null,
        variants: [{ id: 9602, quality: "lossless", available: true }] },
    ],
  };

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [partial],
  });

  assert.equal(plans[0].explicitContent, "unknown");
  assert.equal(plans[0].explicitnessCounts.unknownExplicitnessCount, 1);
});

test("a fully clean plan is classified clean", () => {
  const clean: AcquisitionSourceCandidate = {
    provider: "tidal",
    providerEditionMatchId: 96,
    relation: "exact",
    sourceTrackCount: 2,
    albumDownloadSafe: true,
    trackMatches: [
      { providerTrackMatchId: 961, providerEditionMemberId: 9601, trackId: 1, explicit: false,
        variants: [{ id: 9701, quality: "lossless", available: true }] },
      { providerTrackMatchId: 962, providerEditionMemberId: 9602, trackId: 2, explicit: false,
        variants: [{ id: 9702, quality: "lossless", available: true }] },
    ],
  };

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [clean],
  });

  assert.equal(plans[0].explicitContent, "clean");
});

// ---------------------------------------------------------------------------
// Outcome-first composition: no cliff, no subset enumeration
// ---------------------------------------------------------------------------

/**
 * Sources past the old fifteen-source limit, where the best plan needs exactly
 * two of them.
 *
 * The previous optimizer enumerated every non-empty subset up to fifteen sources
 * and, beyond that, evaluated only "each source alone" and "all of them at
 * once". The sixteenth source therefore changed the answer for reasons that had
 * nothing to do with the music: a two-source composite became reachable or
 * unreachable depending on how many irrelevant offers happened to sit beside it.
 */
function noiseSources(count: number, firstId: number): AcquisitionSourceCandidate[] {
  // Offers that carry a track this edition does not have: real rows, zero
  // relevance to the target, and exactly what used to exhaust the bit budget.
  return Array.from({ length: count }, (_, index) =>
    source(firstId + index, "overlap", [[900 + index, "lossless"]]));
}

/**
 * The defect this replaced, stated as a property.
 *
 * With fifteen overlapping sources the old optimizer enumerated every subset and
 * found a coherent four-source composite. With sixteen it fell back to "each
 * source alone, or all of them together" and returned a fifteen-source composite
 * delivering the identical twenty tracks. One extra offer — one that contributed
 * nothing — changed the shape of the answer, because the loop had run out of
 * bits, not because the music had changed.
 */
test("one more source does not change the composition strategy", () => {
  const canonicalTracks = Array.from({ length: 20 }, (_, index) => index + 1);
  const overlappingSources = (count: number) =>
    Array.from({ length: count }, (_, index) => source(
      10 + index,
      "source_subset",
      canonicalTracks.slice(index, index + 6)
        .map((trackId) => [trackId, "lossless" as NormalizedAudioQuality]),
    ));
  const bestFor = (count: number) => enumerateAcquisitionPlans({
    orderedTrackIds: canonicalTracks,
    profile: high,
    providerPriority: ["tidal"],
    sources: overlappingSources(count),
  })[0];

  const fifteen = bestFor(15);
  const sixteen = bestFor(16);

  assert.equal(fifteen.coverage, 20);
  assert.equal(sixteen.coverage, 20);
  assert.deepEqual(sixteen.sourceIds, fifteen.sourceIds,
    "the sixteenth source must not rewrite the answer");
  assert.ok(fifteen.sourceIds.length <= 5,
    `a coherent composite, not everything at once (got ${fifteen.sourceIds.length} sources)`);
});

test("more than fifteen sources still composes the two that matter", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "source_subset", [[1, "lossless"], [2, "lossless"]]),
      source(11, "source_subset", [[3, "lossless"], [4, "lossless"]]),
      ...noiseSources(20, 100),
    ],
  });

  const best = plans[0];
  assert.equal(best.coverage, 4, "all four canonical tracks are delivered");
  assert.deepEqual(best.sourceIds, [10, 11],
    "exactly the two sources that contribute, and no others");
});

test("more than fifteen sources still composes the three that matter", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4, 5, 6],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "source_subset", [[1, "lossless"], [2, "lossless"]]),
      source(11, "source_subset", [[3, "lossless"], [4, "lossless"]]),
      source(12, "source_subset", [[5, "lossless"], [6, "lossless"]]),
      ...noiseSources(20, 100),
    ],
  });

  const best = plans[0];
  assert.equal(best.coverage, 6);
  assert.deepEqual(best.sourceIds, [10, 11, 12]);
});

test("all sources together loses to the small coherent composite", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "source_subset", [[1, "lossless"], [2, "lossless"]]),
      source(11, "source_subset", [[3, "lossless"], [4, "lossless"]]),
      // Twelve singles that could each supply one already-covered track. Taking
      // them all in would deliver the same audio from twelve more places.
      ...Array.from({ length: 12 }, (_, index) =>
        source(200 + index, "overlap", [[(index % 4) + 1, "lossless"]])),
    ],
  });

  const best = plans[0];
  assert.equal(best.coverage, 4);
  assert.deepEqual(best.sourceIds, [10, 11],
    "a source that adds no unique track outcome is discarded");
});

test("a single source beats the composite that reproduces it exactly", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "exact", [[1, "lossless"], [2, "lossless"]]),
      source(11, "overlap", [[1, "lossless"]]),
      source(12, "overlap", [[2, "lossless"]]),
    ],
  });

  assert.equal(plans[0].composition, "single_source");
  assert.deepEqual(plans[0].sourceIds, [10]);
  // The two-single composite delivers exactly the same files, so it is not a
  // second choice worth storing.
  assert.equal(
    plans.filter((plan) => plan.sourceIds.join(",") === "11,12").length,
    0,
  );
});

test("a composite is kept only when it delivers something no single offer does", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "exact", [[1, "lossless"], [2, "lossless"]]),
      source(11, "overlap", [[3, "lossless"]]),
    ],
  });

  const composite = plans.find((plan) => plan.composition === "composite");
  assert.ok(composite, "covering the third track needs both sources");
  assert.equal(composite.coverage, 3);
  assert.ok(
    plans.every((plan) => plan.composition !== "composite" || plan.coverage === 3),
    "no composite survives that merely re-serves what a single already delivers",
  );
});

test("shuffled sources produce identical plans and identical keys", () => {
  const sources = [
    source(10, "source_subset", [[1, "lossless"], [2, "lossless"]]),
    source(11, "source_subset", [[3, "hires-lossless"], [4, "lossless"]]),
    source(12, "overlap", [[2, "hires-lossless"]]),
    source(13, "exact", [[1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"]]),
    ...noiseSources(18, 100),
  ];
  // A deterministic shuffle: reversing, then rotating, gives a genuinely
  // different input order without depending on a random seed.
  const shuffled = [...sources].reverse();
  const rotated = [...shuffled.slice(7), ...shuffled.slice(0, 7)];

  const describe = (input: AcquisitionSourceCandidate[]) =>
    enumerateAcquisitionPlans({
      orderedTrackIds: [1, 2, 3, 4],
      profile: max,
      providerPriority: ["tidal"],
      sources: input,
    }).map((plan) => plan.planKey);

  assert.deepEqual(describe(shuffled), describe(sources));
  assert.deepEqual(describe(rotated), describe(sources));
});

test("outcome-equivalent plans collapse to one", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "exact", [[1, "lossless"], [2, "lossless"]]),
      // A second provider edition delivering the identical outcome.
      source(11, "exact", [[1, "lossless"], [2, "lossless"]]),
    ],
  });

  const signatures = plans.map((plan) =>
    plan.tracks.map((track) => `${track.trackId}:${track.sourceQuality}`).sort().join(","));
  assert.equal(new Set(signatures).size, signatures.length,
    "two ways to obtain the same files are not two choices");
});

test("the preferred provider edition stays primary without locking out the rest", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3],
    profile: high,
    providerPriority: ["tidal"],
    preferredProviderEditionMatchId: 10,
    sources: [
      source(10, "source_subset", [[1, "lossless"], [2, "lossless"]]),
      source(11, "source_superset" as AcquisitionSourceCandidate["relation"],
        [[1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"]]),
    ],
  });

  const best = plans[0];
  assert.equal(best.preferredSourceId, 10, "the chosen offer is still the primary source");
  assert.ok(best.sourceIds.includes(11),
    "and the other edition may still cover the track it does not carry");
  assert.equal(best.coverage, 3);
});
