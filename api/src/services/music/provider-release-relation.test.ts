import assert from "node:assert/strict";
import test from "node:test";
import { determineProviderReleaseRelation } from "./provider-release-relation.js";

function relation(
  targetIds: number[],
  sourceIds: number[],
  pairs: Array<[number, number]>,
) {
  return determineProviderReleaseRelation({
    targetTrackIds: new Set(targetIds),
    sourceMemberIds: new Set(sourceIds),
    acceptedAssignments: pairs.map(([sourceMemberId, targetTrackId]) => ({
      sourceMemberId,
      targetTrackId,
    })),
  });
}

test("release relation is derived from accepted sets, not equal counts", () => {
  assert.equal(relation([1, 2], [10, 11], [[10, 1], [11, 2]]).relation, "exact");
  assert.equal(relation([1, 2], [10, 11], [[10, 1]]).relation, "overlap");
});

test("release relation is directional from the provider source", () => {
  assert.equal(
    relation([1, 2], [10, 11, 12], [[10, 1], [11, 2]]).relation,
    "source_superset",
  );
  assert.equal(
    relation([1, 2, 3], [10, 11], [[10, 1], [11, 2]]).relation,
    "source_subset",
  );
});

test("unknown or invalid assignments do not invent a release edge", () => {
  const result = relation([1, 2], [10, 11], [[99, 1], [10, 42]]);
  assert.equal(result.relation, null);
  assert.equal(result.matchedTrackCount, 0);
  assert.equal(result.sourceCoverage, 0);
  assert.equal(result.targetCoverage, 0);
});

test("duplicate source or target consumption is ignored", () => {
  const result = relation([1, 2], [10, 11], [[10, 1], [10, 2], [11, 1]]);
  assert.equal(result.relation, "overlap");
  assert.equal(result.matchedTrackCount, 1);
});
