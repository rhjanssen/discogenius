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
