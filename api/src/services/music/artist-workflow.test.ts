import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIST_WORKFLOW_PRIORITY,
  buildRefreshArtistCommand,
  nextArtistWorkflowPriority,
  queueArtistIntake,
} from "./artist-workflow.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";

test("metadata refresh commands do not expose recursive credited artist expansion", () => {
  const payload = buildRefreshArtistCommand({
    artistId: "artist-mbid",
    artistName: "Collaborator",
    workflow: "metadata-refresh",
    forceUpdate: true,
  });

  assert.equal(payload.hydrateCatalog, true);
  assert.equal("expandCreditedArtists" in payload, false);
});

test("unmonitored artist intake reuses metadata refresh without collaborator snowballing", () => {
  const originalAddJob = CommandQueueManager.push;
  let queued: { type?: string; payload?: Record<string, unknown> } = {};
  CommandQueueManager.push = ((type: string, payload: Record<string, unknown>) => {
    queued = { type, payload };
    return 42;
  }) as typeof CommandQueueManager.push;

  try {
    const commandId = queueArtistIntake({
      artistId: "artist-mbid",
      artistName: "Collaborator",
      monitored: false,
      forceUpdate: true,
    });

    assert.equal(commandId, 42);
    assert.equal(queued.type, "RefreshArtist");
    assert.equal(queued.payload?.monitorArtist, false);
    assert.equal(queued.payload?.hydrateCatalog, true);
    assert.equal(queued.payload?.scanLibrary, false);
    assert.equal("expandCreditedArtists" in (queued.payload ?? {}), false);
    assert.equal("scanDepth" in (queued.payload ?? {}), false);
  } finally {
    CommandQueueManager.push = originalAddJob;
  }
});

test("monitoring intake hydrates provider offers and marks post-curate download queue", () => {
  const payload = buildRefreshArtistCommand({
    artistId: "artist-mbid",
    artistName: "Bastille",
    workflow: "monitoring-intake",
  });

  assert.equal(payload.monitorArtist, true);
  assert.equal(payload.hydrateCatalog, true);
  assert.equal(payload.hydrateAlbumTracks, true);
  assert.equal(payload.monitorAlbums, true);
  assert.equal(payload.forceDownloadQueue, true);
});

test("workflow handoffs run depth-first while credited artists stay in a lower tier", () => {
  const refreshPriority = ARTIST_WORKFLOW_PRIORITY.MONITORED_BATCH_BASE;
  const matchPriority = nextArtistWorkflowPriority(refreshPriority);
  const rescanPriority = nextArtistWorkflowPriority(matchPriority);
  const curatePriority = nextArtistWorkflowPriority(rescanPriority);
  const downloadPriority = nextArtistWorkflowPriority(curatePriority);

  assert.deepEqual(
    [refreshPriority, matchPriority, rescanPriority, curatePriority, downloadPriority],
    [-1, 0, 1, 2, 3],
  );
  assert.ok(ARTIST_WORKFLOW_PRIORITY.CREDITED_ARTIST_BASE < refreshPriority);
  assert.ok(nextArtistWorkflowPriority(ARTIST_WORKFLOW_PRIORITY.CREDITED_ARTIST_BASE) < refreshPriority);
});
