import assert from "node:assert/strict";
import test from "node:test";
import {
  curateLibraryReleases,
  type CurationReleaseCandidate,
} from "./library-curation-planner.js";

function candidate(
  releaseGroupId: number,
  editionId: number,
  recordings: number[],
  overrides: Partial<CurationReleaseCandidate> = {},
): CurationReleaseCandidate {
  return {
    releaseGroupId,
    editionId,
    attainableRecordingIds: new Set(recordings),
    official: true,
    medium: "digital",
    preferredCountry: true,
    mediaCount: 1,
    releaseDate: "2020-01-01",
    ...overrides,
  };
}

test("Laura Palmer partial EP remains with redundancy off and drops with redundancy on", () => {
  const badBlood = candidate(1, 101, [1, 2, 3, 4]);
  const lauraPalmerEp = candidate(2, 201, [1]);

  assert.deepEqual(
    curateLibraryReleases([lauraPalmerEp, badBlood], false).selectedReleaseIds,
    [101, 201],
  );
  assert.deepEqual(
    curateLibraryReleases([lauraPalmerEp, badBlood], true).selectedReleaseIds,
    [101],
  );
});

test("Laura Palmer EP survives redundancy when its acoustic recording is attainable", () => {
  const result = curateLibraryReleases([
    candidate(1, 101, [1, 2, 3, 4]),
    candidate(2, 201, [1, 5]),
  ], true);
  assert.deepEqual(result.selectedReleaseIds, [101, 201]);
});

test("covered single is retained only when redundancy is disabled", () => {
  const album = candidate(10, 1001, [1, 2, 3]);
  const single = candidate(11, 1101, [2]);
  assert.deepEqual(curateLibraryReleases([single, album], false).selectedReleaseIds, [1001, 1101]);
  assert.deepEqual(curateLibraryReleases([single, album], true).selectedReleaseIds, [1001]);
});

test("anchor selection is deterministic across candidate input order", () => {
  const worse = candidate(1, 12, [1, 2], { official: false, medium: "vinyl" });
  const better = candidate(1, 11, [1, 2], { official: true, medium: "digital" });
  const forward = curateLibraryReleases([worse, better], false);
  const reversed = curateLibraryReleases([better, worse], false);
  assert.deepEqual(forward.selectedReleaseIds, [11]);
  assert.deepEqual(reversed.selectedReleaseIds, [11]);
});

test("manual or locked releases survive final irredundancy", () => {
  const protectedSingle = candidate(2, 201, [1], { protected: true });
  const album = candidate(1, 101, [1, 2]);
  const result = curateLibraryReleases([protectedSingle, album], true);
  assert.deepEqual(result.selectedReleaseIds, [101, 201]);
});

test("explicit preference rank breaks ties when coverage units are equal", () => {
  const clean = candidate(1, 20, [1, 2, 3], { hasUsablePlan: true, planExplicitPreferenceRank: 0 });
  const explicit = candidate(1, 21, [1, 2, 3], { hasUsablePlan: true, planExplicitPreferenceRank: 1 });
  const result = curateLibraryReleases([clean, explicit], true);
  assert.deepEqual(result.selectedReleaseIds, [21]);
});

test("unit-equal clean/explicit peers collapse to the preferred edition", () => {
  const clean = candidate(1, 20, [1, 2, 3], { hasUsablePlan: true, planExplicitPreferenceRank: 0 });
  const explicit = candidate(1, 21, [1, 2, 3], { hasUsablePlan: true, planExplicitPreferenceRank: 1 });
  const result = curateLibraryReleases([clean, explicit], true);
  assert.deepEqual(result.selectedReleaseIds, [21]);
});

test("true unique material keeps a second edition of the same album", () => {
  // Deluxe exclusive remix is a real coverage unit the standard lacks.
  const standard = candidate(1, 10, [1, 2, 3]);
  const deluxe = candidate(1, 11, [1, 2, 3, 4]);
  const result = curateLibraryReleases([standard, deluxe], true);
  assert.deepEqual(result.selectedReleaseIds, [11], "superset alone covers everything");
});

test("peer completes with different unique units both enter the baseline", () => {
  // Belgian vs 10th Anniversary: different live bonuses. With correct units
  // both contribute; set-cover may keep both when redundancy cannot drop one.
  const tenth = candidate(1, 393, [1, 2, 3, 10, 11]);
  const belgian = candidate(1, 395, [1, 2, 3, 20, 21]);
  const result = curateLibraryReleases([tenth, belgian], true);
  assert.deepEqual(result.selectedReleaseIds.sort((a, b) => a - b), [393, 395]);
});

test("a pure re-pack compilation is dropped when redundancy is on", () => {
  const frank = candidate(1, 100, [1, 2, 3, 4]);
  const backToBlack = candidate(2, 200, [5, 6, 7, 8]);
  const pureRepack = candidate(3, 301, [1, 2, 3, 4, 5, 6, 7, 8], {
    secondaryTypeRank: 3,
  });
  assert.deepEqual(
    curateLibraryReleases([frank, backToBlack, pureRepack], true).selectedReleaseIds,
    [100, 200],
  );
});

test("one unique track on a compilation is enough to keep it", () => {
  const frank = candidate(1, 100, [1, 2, 3, 4]);
  const backToBlack = candidate(2, 200, [5, 6, 7, 8]);
  const boxsetWithDemo = candidate(3, 300, [1, 2, 3, 4, 5, 6, 7, 8, 9], {
    secondaryTypeRank: 3,
  });
  assert.deepEqual(
    curateLibraryReleases([frank, backToBlack, boxsetWithDemo], true).selectedReleaseIds
      .sort((a, b) => a - b),
    [100, 200, 300],
  );
});
