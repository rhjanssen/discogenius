import assert from "node:assert/strict";
import test from "node:test";
import {
  curateLibraryReleases,
  type CurationReleaseCandidate,
} from "./library-curation-planner.js";

function candidate(
  releaseGroupId: number,
  releaseId: number,
  recordings: number[],
  overrides: Partial<CurationReleaseCandidate> = {},
): CurationReleaseCandidate {
  return {
    releaseGroupId,
    releaseId,
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
