import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLidarrReleaseMonitoringDecisions,
  selectBestAlbumRelease,
  type LidarrReleaseGroupCandidate,
} from "./lidarr-release-selection.js";

function group(seed: Partial<LidarrReleaseGroupCandidate> & { id: string | number; title: string }): LidarrReleaseGroupCandidate {
  return {
    id: seed.id,
    title: seed.title,
    type: seed.type ?? "album",
    monitored: seed.monitored ?? true,
    selectedReleaseId: seed.selectedReleaseId ?? null,
    releases: seed.releases ?? [],
  };
}

function release(
  releaseGroupId: string | number,
  id: string | number,
  title: string,
  tracks: Array<{ recordingId?: string; isrcs?: string[]; title: string }>,
  extras: Record<string, unknown> = {},
) {
  return {
    id,
    releaseGroupId,
    title,
    status: "Official",
    releaseDate: "2024-01-01",
    media: [{ format: "Digital Media" }],
    trackCount: tracks.length,
    monitored: false,
    tracks: tracks.map((track, index) => ({
      id: `${id}-${index + 1}`,
      ...track,
    })),
    ...extras,
  };
}

test("selectBestAlbumRelease follows Lidarr style selected release preference before track count", () => {
  const standard = release("rg-1", "release-standard", "Album", [
    { recordingId: "rec-1", title: "One" },
    { recordingId: "rec-2", title: "Two" },
  ]);
  const deluxe = release("rg-1", "release-deluxe", "Album", [
    { recordingId: "rec-1", title: "One" },
    { recordingId: "rec-2", title: "Two" },
    { recordingId: "rec-3", title: "Three" },
  ]);

  const selected = selectBestAlbumRelease(group({
    id: "rg-1",
    title: "Album",
    selectedReleaseId: "release-standard",
    releases: [deluxe, standard],
  }), "stereo");

  assert.equal(selected?.id, "release-standard");
});

test("selectBestAlbumRelease prefers highest track count when there is no selected release", () => {
  const standard = release("rg-1", "release-standard", "Album", [
    { recordingId: "rec-1", title: "One" },
    { recordingId: "rec-2", title: "Two" },
  ]);
  const deluxe = release("rg-1", "release-deluxe", "Album", [
    { recordingId: "rec-1", title: "One" },
    { recordingId: "rec-2", title: "Two" },
    { recordingId: "rec-3", title: "Three" },
  ]);

  const selected = selectBestAlbumRelease(group({
    id: "rg-1",
    title: "Album",
    releases: [standard, deluxe],
  }), "stereo");

  assert.equal(selected?.id, "release-deluxe");
});

test("buildLidarrReleaseMonitoringDecisions suppresses singles covered by selected albums", () => {
  const album = group({
    id: "rg-album",
    title: "Album",
    type: "album",
    releases: [
      release("rg-album", "release-album", "Album", [
        { recordingId: "rec-hit", title: "Hit Song" },
        { recordingId: "rec-deep-cut", title: "Deep Cut" },
      ]),
    ],
  });

  const single = group({
    id: "rg-single",
    title: "Hit Song",
    type: "single",
    releases: [
      release("rg-single", "release-single", "Hit Song", [
        { recordingId: "rec-hit", title: "Hit Song" },
      ]),
    ],
  });

  const result = buildLidarrReleaseMonitoringDecisions({
    releaseGroups: [single, album],
    libraryTypes: ["stereo"],
  });

  const decisions = new Map(result.decisions.map((decision) => [decision.releaseGroupId, decision]));
  assert.equal(decisions.get("rg-album")?.monitored, true);
  assert.equal(decisions.get("rg-single")?.monitored, false);
  assert.equal(decisions.get("rg-single")?.reason, "redundant_track_subset");
  assert.equal(decisions.get("rg-single")?.redundantToReleaseGroupId, "rg-album");
});

test("buildLidarrReleaseMonitoringDecisions keeps stereo and atmos decisions independent", () => {
  const album = group({
    id: "rg-album",
    title: "Album",
    type: "album",
    releases: [
      release("rg-album", "release-stereo", "Album", [
        { recordingId: "rec-1", title: "One" },
      ], {
        providerAvailable: { stereo: true },
      }),
      release("rg-album", "release-atmos", "Album", [
        { recordingId: "rec-1", title: "One" },
      ], {
        providerAvailable: { atmos: true },
      }),
    ],
  });

  const result = buildLidarrReleaseMonitoringDecisions({
    releaseGroups: [album],
    libraryTypes: ["stereo", "atmos"],
    redundancyEnabled: false,
  });

  const byLibrary = new Map(result.decisions.map((decision) => [decision.libraryType, decision]));
  assert.equal(byLibrary.get("stereo")?.selectedReleaseId, "release-stereo");
  assert.equal(byLibrary.get("atmos")?.selectedReleaseId, "release-atmos");
});
