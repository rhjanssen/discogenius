import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFewestReleaseGroupsForCoverage } from "./artist-coverage-optimizer.js";

test("fewest-releases cover keeps the 3-track edition and drops contained singles", () => {
  const retained = selectFewestReleaseGroupsForCoverage([
    {
      mbid: "rg-three",
      recordingIds: new Set(["rec-a", "rec-b", "rec-c"]),
      providerAlbumCount: 2,
      typePriority: 60,
    },
    {
      mbid: "rg-one",
      recordingIds: new Set(["rec-a"]),
      providerAlbumCount: 1,
      typePriority: 60,
    },
    {
      mbid: "rg-two",
      recordingIds: new Set(["rec-b", "rec-c"]),
      providerAlbumCount: 1,
      typePriority: 60,
    },
  ]);

  assert.deepEqual([...retained], ["rg-three"]);
});

test("fewest-releases cover prefers fewer provider albums when coverage ties", () => {
  const retained = selectFewestReleaseGroupsForCoverage([
    {
      mbid: "rg-composite",
      recordingIds: new Set(["rec-a", "rec-b"]),
      providerAlbumCount: 2,
      typePriority: 60,
    },
    {
      mbid: "rg-direct",
      recordingIds: new Set(["rec-a", "rec-b"]),
      providerAlbumCount: 1,
      typePriority: 60,
    },
  ]);

  assert.deepEqual([...retained], ["rg-direct"]);
});

test("fewest-releases cover keeps disjoint release groups", () => {
  const retained = selectFewestReleaseGroupsForCoverage([
    {
      mbid: "rg-album",
      recordingIds: new Set(["rec-1", "rec-2"]),
      providerAlbumCount: 1,
      typePriority: 100,
    },
    {
      mbid: "rg-other",
      recordingIds: new Set(["rec-3"]),
      providerAlbumCount: 1,
      typePriority: 60,
    },
  ]);

  assert.deepEqual([...retained].sort(), ["rg-album", "rg-other"]);
});

test("fewest-releases cover treats shared ISRC keys as the same recording", () => {
  const retained = selectFewestReleaseGroupsForCoverage([
    {
      mbid: "rg-deluxe",
      recordingIds: new Set(["isrc:GBUM72104384", "isrc:GBUM72108141", "isrc:GBUM72100001"]),
      providerAlbumCount: 1,
      typePriority: 100,
    },
    {
      mbid: "rg-piano-single",
      // Distinct MB recording for the piano master, but same ISRC as deluxe track
      recordingIds: new Set(["isrc:GBUM72108141", "isrc:GBUM72104384"]),
      providerAlbumCount: 1,
      typePriority: 60,
    },
  ]);

  assert.deepEqual([...retained], ["rg-deluxe"]);
});
