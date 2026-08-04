import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePrimaryEditionCandidates,
  curateLibraryReleases,
  selectRepresentativeEdition,
  type CurationEditionCandidate,
} from "./library-curation-planner.js";

function candidate(
  releaseGroupId: number,
  editionId: number,
  units: number[],
  overrides: Partial<CurationEditionCandidate> = {},
): CurationEditionCandidate {
  return {
    releaseGroupId,
    editionId,
    attainableUnitIds: new Set(units),
    official: true,
    medium: "digital",
    preferredCountry: true,
    mediaCount: 1,
    releaseDate: "2020-01-01",
    releaseTypeRank: 0,
    secondaryTypeRank: 0,
    hasUsablePlan: true,
    planExplicitPreferenceRank: 1,
    editionExplicitPreferenceRank: 1,
    protected: false,
    existingRepresentative: false,
    ...overrides,
  };
}

test("1. Exactly one representative per release group before gap fill", () => {
  const c1 = candidate(1, 101, [1, 2, 3]);
  const c2 = candidate(1, 102, [1, 2, 3, 4]); // Extra track
  const result = curateLibraryReleases([c1, c2], false);
  assert.equal(result.representativeEditionIdByReleaseGroup.size, 1);
  assert.equal(result.representativeEditionIdByReleaseGroup.get(1), 102);
});

test("2. Unit-equal peers collapse deterministically", () => {
  const worse = candidate(1, 10, [1, 2], { official: false });
  const better = candidate(1, 11, [1, 2], { official: true });
  const rep = selectRepresentativeEdition([worse, better]);
  assert.equal(rep?.editionId, 11);
});

test("3. Protected zero-unit edition survives", () => {
  const zeroUnitProtected = candidate(1, 101, [], { protected: true });
  const album = candidate(2, 201, [1, 2]);
  const result = curateLibraryReleases([zeroUnitProtected, album], true);
  assert.ok(result.selectedEditionIds.includes(101));
  assert.ok(result.selectedEditionIds.includes(201));
});

test("4. Super Deluxe extras already present on another representative do not add a supplemental edition", () => {
  // RG 1 album covers units [1, 2, 3, 4]
  // RG 2 album covers units [1, 2, 5]
  // RG 1 super deluxe edition (edition 102) has units [1, 2, 3, 5] — extra 5 is already on RG 2
  const rg1Album = candidate(1, 101, [1, 2, 3, 4]);
  const rg1SuperDeluxe = candidate(1, 102, [1, 2, 3, 5]);
  const rg2Album = candidate(2, 201, [1, 2, 5]);

  const result = curateLibraryReleases([rg1Album, rg1SuperDeluxe, rg2Album], true);
  assert.equal(result.representativeEditionIdByReleaseGroup.get(1), 101);
  assert.equal(result.representativeEditionIdByReleaseGroup.get(2), 201);
  assert.equal(result.supplementalEditionIds.length, 0);
});

test("5. Three overlapping secondaries where one covers all novel units select only that one", () => {
  // Rep covers [1, 2]
  // Novel units are [3, 4]
  // Secondary A covers [3]
  // Secondary B covers [4]
  // Secondary C covers [3, 4] -> should pick only Secondary C
  const rep = candidate(1, 101, [1, 2]);
  const secA = candidate(2, 201, [3], { releaseTypeRank: 1 });
  const secB = candidate(3, 301, [4], { releaseTypeRank: 1 });
  const secC = candidate(4, 401, [3, 4], { releaseTypeRank: 1 });

  const result = curateLibraryReleases([rep, secA, secB, secC], true);
  assert.ok(result.selectedEditionIds.includes(401));
  assert.ok(!result.selectedEditionIds.includes(201));
  assert.ok(!result.selectedEditionIds.includes(301));
});

test("6. Complementary secondaries both remain", () => {
  const rep = candidate(1, 101, [1, 2]);
  const secA = candidate(2, 201, [3], { releaseTypeRank: 1 });
  const secB = candidate(3, 301, [4], { releaseTypeRank: 1 });

  const result = curateLibraryReleases([rep, secA, secB], true);
  assert.ok(result.selectedEditionIds.includes(201));
  assert.ok(result.selectedEditionIds.includes(301));
});

test("7. Input order does not change any output field", () => {
  const c1 = candidate(1, 101, [1, 2, 3]);
  const c2 = candidate(2, 201, [4, 5]);
  const c3 = candidate(3, 301, [2, 6], { releaseTypeRank: 2 });

  const res1 = curateLibraryReleases([c1, c2, c3], true);
  const res2 = curateLibraryReleases([c3, c1, c2], true);

  assert.deepEqual(res1.selectedEditionIds, res2.selectedEditionIds);
  assert.deepEqual(res1.supplementalEditionIds, res2.supplementalEditionIds);
  assert.deepEqual(
    [...res1.representativeEditionIdByReleaseGroup],
    [...res2.representativeEditionIdByReleaseGroup],
  );
});

test("8. Redundancy disabled preserves one representative for a covered Single release group", () => {
  const album = candidate(1, 101, [1, 2, 3]);
  const single = candidate(2, 201, [1], { releaseTypeRank: 2 }); // Single fully covered by album

  const result = curateLibraryReleases([album, single], false);
  assert.deepEqual(result.selectedEditionIds, [101, 201]);
});

test("9. Redundancy enabled drops that covered Single", () => {
  const album = candidate(1, 101, [1, 2, 3]);
  const single = candidate(2, 201, [1], { releaseTypeRank: 2 });

  const result = curateLibraryReleases([album, single], true);
  assert.deepEqual(result.selectedEditionIds, [101]);
});

test("10. Unique Single remains", () => {
  const album = candidate(1, 101, [1, 2, 3]);
  const single = candidate(2, 201, [1, 99], { releaseTypeRank: 2 }); // Has unique unit 99

  const result = curateLibraryReleases([album, single], true);
  assert.deepEqual(result.selectedEditionIds, [101, 201]);
});

test("11. Album is never removed in favour of a Single", () => {
  // Single covers [1, 2, 3, 4]
  // Album covers [1, 2, 3]
  // Single has more units, but Album has releaseTypeRank = 0 vs Single releaseTypeRank = 2.
  const album = candidate(1, 101, [1, 2, 3], { releaseTypeRank: 0 });
  const single = candidate(2, 201, [1, 2, 3, 4], { releaseTypeRank: 2 });

  const result = curateLibraryReleases([album, single], true);
  assert.ok(result.selectedEditionIds.includes(101), "Album must not be dropped for a Single");
});

test("12. Compilation superset cannot replace studio albums", () => {
  const album1 = candidate(1, 101, [1, 2], { releaseTypeRank: 0, secondaryTypeRank: 0 });
  const album2 = candidate(2, 201, [3, 4], { releaseTypeRank: 0, secondaryTypeRank: 0 });
  const compilation = candidate(3, 301, [1, 2, 3, 4], { releaseTypeRank: 0, secondaryTypeRank: 3 }); // compilation

  const result = curateLibraryReleases([album1, album2, compilation], true);
  assert.ok(result.selectedEditionIds.includes(101));
  assert.ok(result.selectedEditionIds.includes(201));
  assert.ok(!result.selectedEditionIds.includes(301));
});

test("13. Unique compilation/demo remains when required", () => {
  const album = candidate(1, 101, [1, 2]);
  const compilation = candidate(2, 201, [1, 2, 5], { secondaryTypeRank: 3 }); // Unique unit 5

  const result = curateLibraryReleases([album, compilation], true);
  assert.deepEqual(result.selectedEditionIds, [101, 201]);
});

test("14. Representative removed but same-group supplemental survives and is promoted", () => {
  // RG 1 Edition 101 (representative) has unit [1]
  // RG 1 Edition 102 has unit [1, 2]
  // RG 2 Album 201 has unit [1]
  // If Edition 101 is pruned as redundant to RG 2, Edition 102 survives and becomes representative of RG 1
  const rep101 = candidate(1, 101, [1], { releaseTypeRank: 1 }); // EP
  const supp102 = candidate(1, 102, [1, 2], { releaseTypeRank: 0 }); // Album
  const album201 = candidate(2, 201, [1], { releaseTypeRank: 0 });

  const result = curateLibraryReleases([rep101, supp102, album201], true);
  assert.equal(result.representativeEditionIdByReleaseGroup.get(1), 102);
});

test("15. Protected/manual/locked candidates are never pruned", () => {
  const album = candidate(1, 101, [1, 2]);
  const protectedSingle = candidate(2, 201, [1], { releaseTypeRank: 2, protected: true });

  const result = curateLibraryReleases([album, protectedSingle], true);
  assert.ok(result.selectedEditionIds.includes(201));
});

test("16. Every returned release group has exactly one representative", () => {
  const c1 = candidate(1, 101, [1, 2]);
  const c2 = candidate(2, 201, [3, 4]);
  const result = curateLibraryReleases([c1, c2], true);
  assert.equal(result.representativeEditionIdByReleaseGroup.size, result.selectedReleaseGroupIds.length);
  for (const rgId of result.selectedReleaseGroupIds) {
    assert.ok(result.representativeEditionIdByReleaseGroup.has(rgId));
  }
});

test("17. Every selectedEditionId appears in decisions", () => {
  const c1 = candidate(1, 101, [1, 2]);
  const c2 = candidate(2, 201, [1, 3], { releaseTypeRank: 1 });
  const result = curateLibraryReleases([c1, c2], true);
  assert.equal(result.decisions.length, result.selectedEditionIds.length);
  const decisionIds = result.decisions.map((d) => d.editionId).sort((a, b) => a - b);
  assert.deepEqual(decisionIds, result.selectedEditionIds);
});

test("18. Supplemental contributedUnitIds are non-empty unless the edition is protected", () => {
  const album = candidate(1, 101, [1, 2]);
  const supp = candidate(1, 201, [1, 3], { releaseTypeRank: 1 }); // Supplemental contributing unit 3
  const result = curateLibraryReleases([album, supp], true);

  const suppDecision = result.decisions.find((d) => d.editionId === 201);
  assert.equal(suppDecision?.role, "supplemental");
  assert.ok(suppDecision?.contributedUnitIds.length > 0);
  assert.deepEqual(suppDecision?.contributedUnitIds, [3]);
});
