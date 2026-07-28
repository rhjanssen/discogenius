import assert from "node:assert/strict";
import test from "node:test";
import {
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
    providerReleaseMatchId: id,
    relation,
    sourceTrackCount: trackQualities.length,
    albumDownloadSafe: true,
    trackMatches: trackQualities.map(([trackId, quality], index) => ({
      providerTrackMatchId: id * 100 + index,
      providerReleaseMemberId: id * 1000 + index,
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
