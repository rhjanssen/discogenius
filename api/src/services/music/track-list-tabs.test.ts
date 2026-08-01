import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrackListTabs, type TrackListEditionInput } from "./track-list-tabs.js";

function edition(
  editionId: number,
  recordingIds: number[],
  representative = false,
): TrackListEditionInput {
  return { editionId, recordingIds: new Set(recordingIds), representative };
}

test("one monitored edition never needs tabs", () => {
  assert.deepEqual(resolveTrackListTabs([edition(1, [1, 2, 3], true)]), []);
});

test("no monitored edition means nothing to tab", () => {
  assert.deepEqual(resolveTrackListTabs([]), []);
});

test("equivalent recording sets share one list", () => {
  assert.deepEqual(
    resolveTrackListTabs([edition(1, [1, 2], true), edition(2, [2, 1])]),
    [],
    "the same recordings twice is not two track lists",
  );
});

test("a strict subset shares the superset's list", () => {
  // Standard 1-2 inside deluxe 1-4: the deluxe list already shows everything.
  assert.deepEqual(
    resolveTrackListTabs([edition(1, [1, 2]), edition(2, [1, 2, 3, 4], true)]),
    [],
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

test("partial overlap is still non-nested", () => {
  assert.deepEqual(
    resolveTrackListTabs([edition(7, [1, 2, 3], true), edition(9, [3, 4])]),
    [
      { editionId: 7, default: true },
      { editionId: 9, default: false },
    ],
  );
});

test("one non-nested pair is enough, even among otherwise nested editions", () => {
  const tabs = resolveTrackListTabs([
    edition(1, [1, 2]),
    edition(2, [1, 2, 3], true),
    edition(3, [9]),
  ]);
  assert.deepEqual(tabs.map((tab) => tab.editionId), [1, 2, 3]);
  assert.deepEqual(tabs.filter((tab) => tab.default).map((tab) => tab.editionId), [2]);
});

test("a missing representative still yields exactly one default tab", () => {
  const tabs = resolveTrackListTabs([edition(5, [1]), edition(6, [2])]);
  assert.equal(tabs.filter((tab) => tab.default).length, 1);
  assert.equal(tabs.find((tab) => tab.default)?.editionId, 5, "lowest edition id is deterministic");
});
