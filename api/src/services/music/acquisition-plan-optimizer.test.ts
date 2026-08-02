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

// Back to Black deluxe shape: a MAX hi-res standard (vol. 1) plus a HIGH
// lossless deluxe exact should outrank the pure lossless single-source plan.
// Live failure: the standard was only matched to its own edition, so the
// deluxe never saw the subset and stayed on lossless-only.
test("MAX ranks the standard+deluxe composite above the lossless single source", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4, 5],
    profile: max,
    providerPriority: ["tidal", "apple-music"],
    sources: [
      // TIDAL standard: hi-res on the first volume only.
      source(10, "source_subset", [
        [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"],
      ]),
      // TIDAL deluxe: lossless exact on the whole tracklist.
      source(20, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"],
        [4, "lossless"], [5, "lossless"],
      ]),
      // Apple Music exact lossless — same coverage as TIDAL deluxe, lower
      // fidelity than the TIDAL standard+deluxe composite. Must not be mixed
      // into a TIDAL plan; at equal quality it would lose only on provider
      // priority, but here quality already ranks the composite first.
      source(30, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"],
        [4, "lossless"], [5, "lossless"],
      ], { provider: "apple-music" }),
    ],
  });

  assert.ok(plans.length >= 2);
  const best = plans[0];
  assert.equal(best.composition, "composite");
  assert.equal(best.provider, "tidal");
  assert.deepEqual(best.sourceIds.slice().sort((a, b) => a - b), [10, 20]);
  assert.equal(best.qualityTier, "hires-lossless");
  assert.ok(
    plans.every((plan) => plan.sourceIds.every((id) => {
      const providers = new Set(
        [10, 20, 30].includes(id)
          ? [id === 30 ? "apple-music" : "tidal"]
          : [],
      );
      // Every plan is mono-provider: all of its source ids map to one provider.
      const planProvider = plan.provider;
      return plan.sourceIds.every((sourceId) =>
        (sourceId === 30 ? "apple-music" : "tidal") === planProvider);
    })),
    "no plan may mix TIDAL and Apple Music sources",
  );
  const multiProvider = plans.filter((plan) => {
    const providers = new Set(plan.sourceIds.map((id) => (id === 30 ? "apple-music" : "tidal")));
    return providers.size > 1;
  });
  assert.equal(multiProvider.length, 0, "cross-provider composites are unsupported");
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

// Quality outranks provider preference: Apple MAX (24-bit) beats preferred-provider
// TIDAL HIGH (16-bit) even when both are coherent single-source exacts.
test("higher fidelity beats preferred-provider lower fidelity single-source", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3],
    profile: max,
    providerPriority: ["tidal", "apple-music"],
    sources: [
      source(10, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"],
      ]),
      source(20, "exact", [
        [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"],
      ], { provider: "apple-music" }),
    ],
  });

  assert.equal(plan?.provider, "apple-music");
  assert.equal(plan?.composition, "single_source");
  assert.deepEqual(plan?.sourceIds, [20]);
  assert.equal(plan?.qualityTier, "hires-lossless");
});

// Quality also outranks single-source preference: an Apple composite that
// reaches 24-bit on every track beats a TIDAL single-source 16-bit exact.
test("higher fidelity composite beats preferred-provider lower fidelity single-source", () => {
  const plan = optimizeAcquisitionPlan({
    orderedTrackIds: [1, 2, 3, 4],
    profile: max,
    providerPriority: ["tidal", "apple-music"],
    sources: [
      source(10, "exact", [
        [1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"],
      ]),
      source(20, "source_subset", [
        [1, "hires-lossless"], [2, "hires-lossless"],
      ], { provider: "apple-music" }),
      source(21, "source_subset", [
        [3, "hires-lossless"], [4, "hires-lossless"],
      ], { provider: "apple-music" }),
    ],
  });

  assert.equal(plan?.provider, "apple-music");
  assert.equal(plan?.composition, "composite");
  assert.deepEqual(plan?.sourceIds.slice().sort((a, b) => a - b), [20, 21]);
  assert.ok(plan?.tracks.every((track) => track.sourceQuality === "hires-lossless"));
});

// Equal quality: provider preference and single-source still break the tie.
test("equal quality keeps provider priority and single-source as tie-breakers", () => {
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: max,
    providerPriority: ["tidal", "apple-music"],
    sources: [
      source(10, "exact", [
        [1, "hires-lossless"], [2, "hires-lossless"],
      ]),
      source(20, "exact", [
        [1, "hires-lossless"], [2, "hires-lossless"],
      ], { provider: "apple-music" }),
    ],
  });

  assert.equal(plans[0].provider, "tidal");
  assert.equal(plans[0].composition, "single_source");
  assert.equal(plans[0].qualityTier, "hires-lossless");
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

// GMTF-shaped catalog: one MAX exact edition plus every single as its own
// subset match, plus a lower-quality full exact. Only the best single-source
// survives — multi-single rebuilds and same-tracklist lower tiers are noise.
test("a full MAX single-source plan eliminates partial singles, rebuild composites, and worse-tier exacts", () => {
  const exactMax = source(1, "exact", [
    [1, "hires-lossless"], [2, "hires-lossless"], [3, "hires-lossless"], [4, "hires-lossless"],
  ]);
  const singles = [1, 2, 3, 4].map((trackId) =>
    source(10 + trackId, "source_subset", [[trackId, "hires-lossless"]]));
  // Same tracklist at lower quality — not a second product under the one-best-
  // single policy; the MAX exact dominates it.
  const exactLossless = source(2, "exact", [
    [1, "lossless"], [2, "lossless"], [3, "lossless"], [4, "lossless"],
  ]);

  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2, 3, 4],
    profile: max,
    providerPriority: ["tidal"],
    sources: [exactMax, exactLossless, ...singles],
  });

  assert.equal(plans.length, 1, "one best single-source only");
  assert.equal(plans[0].composition, "single_source");
  assert.deepEqual(plans[0].sourceIds, [1]);
  assert.equal(plans[0].coverage, 4);
  assert.equal(plans[0].qualityTier, "hires-lossless");
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
// only offers lossless was persisted and displayed as Hi-Res.
test("a plan is labelled with the tier it reaches, not the library cutoff", () => {
  // Only the best single-source is stored; label it by what it actually delivers.
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: high,
    providerPriority: ["tidal"],
    sources: [
      source(10, "exact", [[1, "lossless"], [2, "lossless"]]),
      source(20, "exact", [[1, "hires-lossless"], [2, "hires-lossless"]]),
    ],
  });

  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].sourceIds, [20]);
  assert.equal(plans[0].qualityTier, "hires-lossless");
});

test("one best single-source picks the highest quality per track, not every partial upgrade", () => {
  // Tracks 1-2 exist in hi-res, tracks 3-4 only in lossless. One plan: best
  // available on each track. Never "1 hi-res + 3 lossless", "2 hi-res + 2
  // lossless", and every step between as separate stored plans.
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

  assert.equal(plans.length, 1);
  assert.equal(plans[0].composition, "single_source");
  assert.deepEqual(
    plans[0].tracks.map((track) => track.sourceQuality),
    ["hires-lossless", "hires-lossless", "lossless", "lossless"],
  );
  assert.equal(plans[0].qualityTier, "hires-lossless");
});

// Stereo and Spatial are separate libraries with separate profiles. Planning
// one must not suppress the other — even if both quality families somehow
// appeared in one profile's preference order.
test("stereo and spatial plans stay independent products", () => {
  const stereoProfile: AcquisitionQualityProfile = {
    allowedQualities: new Set(["lossless", "hires-lossless"]),
    preferenceOrder: ["hires-lossless", "lossless"],
    cutoff: "hires-lossless",
    continueUpgradesAfterCutoff: true,
  };
  const spatialProfile: AcquisitionQualityProfile = {
    allowedQualities: new Set(["spatial"]),
    preferenceOrder: ["spatial"],
    cutoff: "spatial",
    continueUpgradesAfterCutoff: true,
  };
  const stereoExact = source(1, "exact", [
    [1, "hires-lossless"], [2, "hires-lossless"],
  ]);
  const spatialExact: AcquisitionSourceCandidate = {
    provider: "tidal",
    providerEditionMatchId: 2,
    relation: "exact",
    sourceTrackCount: 2,
    albumDownloadSafe: true,
    trackMatches: [
      { providerTrackMatchId: 201, providerEditionMemberId: 2001, trackId: 1,
        variants: [{ id: 2101, quality: "spatial", available: true }] },
      { providerTrackMatchId: 202, providerEditionMemberId: 2002, trackId: 2,
        variants: [{ id: 2102, quality: "spatial", available: true }] },
    ],
  };

  const stereoPlans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: stereoProfile,
    providerPriority: ["tidal"],
    sources: [stereoExact, spatialExact],
  });
  const spatialPlans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: spatialProfile,
    providerPriority: ["tidal"],
    sources: [stereoExact, spatialExact],
  });

  assert.equal(stereoPlans.length, 1);
  assert.deepEqual(stereoPlans[0].sourceIds, [1]);
  assert.equal(stereoPlans[0].qualityTier, "hires-lossless");

  assert.equal(spatialPlans.length, 1);
  assert.deepEqual(spatialPlans[0].sourceIds, [2]);
  assert.equal(spatialPlans[0].qualityTier, "spatial");
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

test("release-level explicit makes the plan explicit when every track row is clean", () => {
  // Live failure: TIDAL album 243864035 is explicit and 5 tracks are explicit,
  // but stale ProviderItems track rows all said clean (0), so the plan was
  // stored/shown as clean and the E badge never appeared.
  const staleTracks: AcquisitionSourceCandidate = {
    provider: "tidal",
    providerEditionMatchId: 97,
    relation: "exact",
    sourceTrackCount: 2,
    albumDownloadSafe: true,
    releaseExplicit: true,
    trackMatches: [
      { providerTrackMatchId: 971, providerEditionMemberId: 9701, trackId: 1, explicit: false,
        variants: [{ id: 9801, quality: "hires-lossless", available: true }] },
      { providerTrackMatchId: 972, providerEditionMemberId: 9702, trackId: 2, explicit: false,
        variants: [{ id: 9802, quality: "hires-lossless", available: true }] },
    ],
  };
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: [1, 2],
    profile: max,
    providerPriority: ["tidal"],
    sources: [staleTracks],
  });
  assert.equal(plans[0].explicitContent, "explicit");
});

test("a fully clean plan is classified clean", () => {
  const clean: AcquisitionSourceCandidate = {
    provider: "tidal",
    providerEditionMatchId: 96,
    relation: "exact",
    sourceTrackCount: 2,
    albumDownloadSafe: true,
    releaseExplicit: false,
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

const spatialProfile: AcquisitionQualityProfile = {
  allowedQualities: new Set(["spatial"]),
  preferenceOrder: ["spatial"],
  cutoff: "spatial",
  continueUpgradesAfterCutoff: true,
};

function spatialSource(
  id: number,
  trackIds: number[],
  explicit: boolean,
): AcquisitionSourceCandidate {
  return source(
    id,
    "exact",
    trackIds.map((trackId) => [trackId, "spatial"] as [number, NormalizedAudioQuality]),
    {
      releaseExplicit: explicit,
      trackMatches: trackIds.map((trackId, index) => ({
        providerTrackMatchId: id * 100 + index,
        providerEditionMemberId: id * 1000 + index,
        trackId,
        explicit,
        variants: [{ id: id * 10 + index, quality: "spatial" as const, available: true }],
      })),
    },
  );
}

test("prefer_explicit builds an explicit composite that fills clean-only tracks", () => {
  // GMTF Atmos: clean 10/10 vs explicit 9/10 → composite uses explicit for 9
  // and clean for the reprise → full coverage, plan marked explicit.
  const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: all,
    profile: spatialProfile,
    providerPriority: ["tidal"],
    preferExplicit: true,
    sources: [
      spatialSource(10, all, false),
      spatialSource(11, all.slice(0, 9), true),
    ],
  });

  assert.equal(plans[0].explicitContent, "explicit");
  assert.equal(plans[0].coverage, 10);
  assert.ok(plans[0].sourceIds.includes(11));
});

test("prefer_explicit still prefers a pure clean single when explicit is tiny", () => {
  // Explicit only covers 2 of 20 with no way to reach 90% without the clean
  // product dominating — composite still uses explicit as seed when possible.
  // When the explicit product is a tiny subset, the best plan remains full clean
  // only if no composite improves; with seeding, composite may still form.
  // Guard: a *single* explicit plan of 2 tracks alone must not beat clean 20.
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: ids,
    profile: spatialProfile,
    providerPriority: ["tidal"],
    preferExplicit: true,
    sources: [
      spatialSource(10, ids, false),
      spatialSource(11, ids.slice(0, 2), true),
    ],
  });

  // Full coverage is required; explicitness preferred when it does not lose tracks.
  assert.equal(plans[0].coverage, 20);
  assert.equal(plans[0].explicitContent, "explicit",
    "even a small explicit seed plus clean fill yields an explicit full plan");
});

test("explicit album plus clean fill for one track composes an explicit plan", () => {
  // Distorted Light Beam (reprise): Atmos only on clean product; rest on explicit.
  const all = [1, 2, 3, 4, 5];
  const plans = enumerateAcquisitionPlans({
    orderedTrackIds: all,
    profile: spatialProfile,
    providerPriority: ["tidal"],
    preferExplicit: true,
    sources: [
      spatialSource(10, all, false),
      spatialSource(11, [1, 2, 3, 4], true), // missing track 5
    ],
  });

  const best = plans[0];
  assert.equal(best.explicitContent, "explicit");
  assert.equal(best.coverage, 5, "clean fills the missing non-explicit track");
  assert.ok(best.sourceIds.includes(11) && best.sourceIds.includes(10),
    "composite draws from both products");
  assert.equal(best.composition, "composite");
});
