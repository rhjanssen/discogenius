import { describe, expect, it } from "vitest";
import type { DownloadProgressContract, QueueItemContract } from "@contracts/status";
import { mergeQueueItemsWithProgress, queueItemGroupKey } from "./queueItemProgress";

function item(id: number, patch: Partial<QueueItemContract> = {}): QueueItemContract {
  return { id, type: "album", provider: "tidal", providerId: "provider-album", url: null,
    path: null, status: "queued", progress: 0, error: null, created_at: "2026-09-06", updated_at: "2026-09-06",
    album_id: "canonical-album", ...patch };
}
function progress(jobId: number, patch: Partial<DownloadProgressContract> = {}): DownloadProgressContract {
  return { jobId, type: "album", providerId: "provider-album", state: "downloading", progress: 42, ...patch };
}

describe("queue snapshot and progress reconciliation", () => {
  it("keeps active work above waiting items without changing the waiting order", () => {
    const rows = [item(1, { status: "started", state: "queued" }), item(2, { status: "started", state: "downloading" }), item(3)];
    expect(mergeQueueItemsWithProgress(rows, new Map()).map(row => row.id)).toEqual([2, 1, 3]);
  });

  it("does not recreate a removed queue row from a late progress event", () => {
    expect(mergeQueueItemsWithProgress([], new Map([[8836, progress(8836)]]))).toEqual([]);
  });

  it("updates the exact queue row while preserving its canonical identity", () => {
    const rows = [item(6663, { status: "started", state: "downloading" }), item(8836)];
    const merged = mergeQueueItemsWithProgress(rows, new Map([[6663, progress(6663)]]));
    expect(merged[0]).toMatchObject({ id: 6663, album_id: "canonical-album", progress: 42 });
    expect(merged[1].progress).toBe(0);
  });

  it("does not resurrect pre-retry progress even when the queue row carries a tracklist", () => {
    const queued = item(1, { tracks: [{ title: "Pompeii", status: "queued" }] });
    expect(mergeQueueItemsWithProgress([queued], new Map([[1, progress(1)]]))).toEqual([queued]);
  });

  it("keeps two acquisitions of one album separate for edition and library context", () => {
    expect(queueItemGroupKey(item(1))).not.toBe(queueItemGroupKey(item(2)));
  });

  it("keeps import work visible until the command reports completion", () => {
    const active = item(1, { status: "started", state: "importing", stage: "import" });
    expect(mergeQueueItemsWithProgress([active], new Map([[1, progress(1, { state: "completed", progress: 100 })]]))[0])
      .toMatchObject({ status: "started", state: "importing" });
  });
});
