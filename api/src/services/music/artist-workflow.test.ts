import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRefreshArtistJobPayload, queueArtistIntake } from "./artist-workflow.js";
import { TaskQueueService } from "../jobs/queue.js";

test("credited artist metadata refreshes can disable recursive credit expansion", () => {
  const payload = buildRefreshArtistJobPayload({
    artistId: "artist-mbid",
    artistName: "Collaborator",
    workflow: "metadata-refresh",
    forceUpdate: true,
    expandCreditedArtists: false,
  });

  assert.equal(payload.hydrateCatalog, true);
  assert.equal(payload.expandCreditedArtists, false);
});

test("unmonitored artist intake reuses metadata refresh without collaborator snowballing", () => {
  const originalAddJob = TaskQueueService.addJob;
  let queued: { type?: string; payload?: Record<string, unknown> } = {};
  TaskQueueService.addJob = ((type: string, payload: Record<string, unknown>) => {
    queued = { type, payload };
    return 42;
  }) as typeof TaskQueueService.addJob;

  try {
    const jobId = queueArtistIntake({
      artistId: "artist-mbid",
      artistName: "Collaborator",
      monitored: false,
      forceUpdate: true,
    });

    assert.equal(jobId, 42);
    assert.equal(queued.type, "RefreshArtist");
    assert.equal(queued.payload?.monitorArtist, false);
    assert.equal(queued.payload?.hydrateCatalog, true);
    assert.equal(queued.payload?.scanLibrary, false);
    assert.equal(queued.payload?.expandCreditedArtists, false);
    assert.equal(queued.payload?.scanDepth, "deep");
  } finally {
    TaskQueueService.addJob = originalAddJob;
  }
});
