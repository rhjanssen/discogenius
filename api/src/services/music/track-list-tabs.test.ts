import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseNestedEditions,
  resolveTrackListTabs,
  type TrackListEditionInput,
} from "./track-list-tabs.js";

function edition(
  editionId: number,
  recordingIds: number[],
  representative = false,
): TrackListEditionInput {
  return { editionId, recordingIds: new Set(recordingIds), representative };
}

test("one monitored edition yields a single default tab (no strip needed)", () => {
  assert.deepEqual(
    resolveTrackListTabs([edition(1, [1, 2, 3], true)]),
    [{ editionId: 1, default: true }],
  );
});

test("no monitored edition means nothing to tab", () => {
  assert.deepEqual(resolveTrackListTabs([]), []);
});

test("equivalent recording sets collapse to one default tab", () => {
  assert.deepEqual(
    resolveTrackListTabs([edition(1, [1, 2], true), edition(2, [2, 1])]),
    [{ editionId: 1, default: true }],
    "the same recordings twice is not two track lists",
  );
});

test("a strict subset collapses onto the superset tab", () => {
  // Standard 1-2 inside deluxe 1-4: only the deluxe list is needed.
  assert.deepEqual(
    resolveTrackListTabs([edition(1, [1, 2]), edition(2, [1, 2, 3, 4], true)]),
    [{ editionId: 2, default: true }],
  );
});

test("chain of nested subsets collapses to the outermost superset", () => {
  assert.deepEqual(
    resolveTrackListTabs([
      edition(1, [1]),
      edition(2, [1, 2]),
      edition(3, [1, 2, 3, 4], true),
    ]),
    [{ editionId: 3, default: true }],
  );
});

test("non-nested sets get tabs, defaulting to the representative", () => {
  // Each edition carries a recording the other does not, so no single list works.
  assert.deepEqual(
    resolveTrackListTabs([edition(1, [1, 2]), edition(2, [3, 4], true)]),
    [
      { editionId: 1, default: false },
      { editionId: 2, default: true },
    ],
  );
});

test("partial overlap is still non-nested and gets tabs", () => {
  assert.deepEqual(
    resolveTrackListTabs([edition(7, [1, 2, 3], true), edition(9, [3, 4])]),
    [
      { editionId: 7, default: true },
      { editionId: 9, default: false },
    ],
  );
});

test("subset among partial-overlap editions is dropped before tabs", () => {
  // A ⊂ B, and B partially overlaps C → only B and C need tabs (A is redundant).
  const tabs = resolveTrackListTabs([
    edition(1, [1, 2]), // subset of 2
    edition(2, [1, 2, 3], true),
    edition(3, [3, 9]),
  ]);
  assert.deepEqual(
    tabs.map((tab) => tab.editionId).sort((a, b) => a - b),
    [2, 3],
  );
  assert.equal(tabs.find((tab) => tab.default)?.editionId, 2);
});

test("a missing representative still yields exactly one default tab", () => {
  const tabs = resolveTrackListTabs([edition(5, [1]), edition(6, [2])]);
  assert.equal(tabs.filter((tab) => tab.default).length, 1);
  assert.equal(tabs.find((tab) => tab.default)?.editionId, 5, "lowest edition id is deterministic when sizes tie");
});

test("stereo and spatial twins of the same tracklist collapse to one tab", () => {
  // GMTF: Dreams explicit monitored for Stereo (348) and Spatial (350) with the
  // same recordings, plus deluxe with one unique remix (345).
  const tabs = resolveTrackListTabs([
    edition(348, [1, 2, 3, 4, 5], true),
    edition(350, [1, 2, 3, 4, 5], true),
    edition(345, [1, 2, 3, 9]),
  ]);
  assert.deepEqual(
    tabs.map((tab) => tab.editionId).sort((a, b) => a - b),
    [345, 348],
    "identical Dreams editions must not both appear as tabs",
  );
  assert.equal(tabs.filter((tab) => tab.default).length, 1);
  assert.equal(
    tabs.find((tab) => tab.default)?.editionId,
    348,
    "a representative Dreams edition wins the default tab",
  );
});

test("duplicate edition ids from multiple libraries collapse cleanly", () => {
  const tabs = resolveTrackListTabs([
    edition(10, [1, 2], true),
    edition(10, [1, 2], false),
    edition(11, [3]),
  ]);
  assert.deepEqual(tabs.map((tab) => tab.editionId).sort((a, b) => a - b), [10, 11]);
});

test("collapseNestedEditions keeps only maximals", () => {
  const result = collapseNestedEditions([
    edition(1, [1, 2]),
    edition(2, [1, 2, 3]),
    edition(3, [1, 2, 3, 4]),
    edition(4, [9]),
  ]);
  assert.deepEqual(
    result.map((e) => e.editionId).sort((a, b) => a - b),
    [3, 4],
  );
});
