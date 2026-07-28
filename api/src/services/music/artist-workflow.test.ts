import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIST_WORKFLOW_PRIORITY,
  CREDITED_ARTIST_HYDRATION_BATCH_SIZE,
  buildRefreshArtistCommand,
  nextArtistWorkflowPriority,
  queueCreditedArtistHydrationBatch,
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

test("first-degree credited hydration is bounded and persists a durable continuation", () => {
  const originalPush = CommandQueueManager.push;
  const originalUpdateState = CommandQueueManager.updateState;
  const queued: Array<{ refId?: string; priority?: number }> = [];
  let continuation: Array<{ artistId: string; artistName: string }> = [];
  CommandQueueManager.push = ((_type: string, _payload: unknown, refId?: string, priority?: number) => {
    queued.push({ refId, priority });
    return queued.length;
  }) as typeof CommandQueueManager.push;
  CommandQueueManager.updateState = ((_id: number, options: any) => {
    continuation = options.payloadPatch.creditedContinuation;
    return null;
  }) as typeof CommandQueueManager.updateState;

  try {
    const items = Array.from({ length: 60 }, (_, index) => ({
      artistId: `credited-${index + 1}`,
      artistName: `Credited ${index + 1}`,
    }));
    const result = queueCreditedArtistHydrationBatch(items);
    assert.equal(result.queued, CREDITED_ARTIST_HYDRATION_BATCH_SIZE);
    assert.equal(result.remaining, 35);
    assert.equal(queued.length, 25);
    assert.ok(queued.every((item) => item.priority === ARTIST_WORKFLOW_PRIORITY.CREDITED_ARTIST_BASE));
    assert.deepEqual(
      continuation.map((item) => item.artistId),
      items.slice(25).map((item) => item.artistId),
    );
  } finally {
    CommandQueueManager.push = originalPush;
    CommandQueueManager.updateState = originalUpdateState;
  }
});
