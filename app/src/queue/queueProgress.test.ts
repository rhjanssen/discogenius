import { describe, expect, it } from "vitest";
import { buildProgressSnapshot, createEmptyProgressState, upsertProgressSnapshots, type DownloadProgress } from "./queueProgress";

const download: DownloadProgress = {
  jobId: 12, providerId: "album-1", type: "album", quality: null, state: "downloading", progress: 50,
  currentProviderTrackId: "one", currentFileNum: 1, trackStatus: "completed",
  tracks: [
    { providerTrackId: "one", title: "One", trackNum: 1, volumeNum: 1, status: "completed" },
    { providerTrackId: "two", title: "Two", trackNum: 2, volumeNum: 1, status: "downloading" },
  ],
};

describe("queue progress reconciliation", () => {
  it("retains per-track progress across partial events and reordered stale snapshots", () => {
    const partial = buildProgressSnapshot({ jobId: 12, speed: "1 MB/s" }, download)!;
    expect(partial.tracks).toEqual(download.tracks);
    expect(partial.state).toBe("downloading");
    let state = upsertProgressSnapshots(createEmptyProgressState(), [partial]);
    state = upsertProgressSnapshots(state, [{ ...download, tracks: [...download.tracks!].reverse().map(t => ({ ...t, status: "queued" })) }]);
    expect(state.byJobId.get(12)?.tracks?.map(t => t.status)).toEqual(["downloading", "completed"]);
  });

  it("resets only once at import handoff and ignores late download events", () => {
    const handoff = buildProgressSnapshot({ jobId: 12, state: "importPending", progress: 0 }, download)!;
    expect(handoff.currentProviderTrackId).toBeUndefined();
    expect(handoff.trackStatus).toBeUndefined();
    expect(handoff.tracks?.map(t => t.status)).toEqual(["queued", "queued"]);
    let state = upsertProgressSnapshots(createEmptyProgressState(), [download, handoff]);
    const importing = buildProgressSnapshot({ jobId: 12, state: "importing", currentProviderTrackId: "two", trackStatus: "completed" }, handoff)!;
    state = upsertProgressSnapshots(state, [importing, download]);
    expect(state.byJobId.get(12)?.state).toBe("importing");
    expect(state.byJobId.get(12)?.tracks?.map(t => t.status)).toEqual(["queued", "completed"]);
    state = upsertProgressSnapshots(state, [{ ...handoff, state: "importing" }]);
    expect(state.byJobId.get(12)?.tracks?.map(t => t.status)).toEqual(["queued", "completed"]);
  });

  it("does not transfer completion between repeated track IDs on different discs", () => {
    const tracks = [
      { title: "Repeat", providerTrackId: "repeat", trackNum: 1, volumeNum: 1, status: "completed" as const },
      { title: "Repeat", providerTrackId: "repeat", trackNum: 1, volumeNum: 2, status: "queued" as const },
    ];
    let state = upsertProgressSnapshots(createEmptyProgressState(), [{ ...download, tracks }]);
    state = upsertProgressSnapshots(state, [{ ...download, tracks: [...tracks].reverse().map(t => ({ ...t, status: "queued" })) }]);
    expect(state.byJobId.get(12)?.tracks?.map(t => t.status)).toEqual(["queued", "completed"]);
  });
});
