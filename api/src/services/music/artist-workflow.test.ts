import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIST_WORKFLOW_PRIORITY,
  buildRefreshArtistCommand,
  buildRescanFoldersCommand,
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

test("library scan and refresh-scan still write cover and NFO sidecars", () => {
  for (const workflow of ["library-scan", "refresh-scan"] as const) {
    const payload = buildRescanFoldersCommand({
      artistId: "7808accb-6395-4b25-858c-678bbb73896b",
      artistName: "Bastille",
      workflow,
    });
    assert.equal(payload.skipMetadataBackfill, false, workflow);
  }
});

test("monitoring intake hydrates provider offers without coupling refresh to downloads", () => {
  const payload = buildRefreshArtistCommand({
    artistId: "artist-mbid",
    artistName: "Bastille",
    workflow: "monitoring-intake",
  });

  assert.equal(payload.monitorArtist, true);
  assert.equal(payload.hydrateCatalog, true);
  assert.equal(payload.hydrateAlbumTracks, true);
  assert.equal(payload.monitorAlbums, true);
  assert.equal("forceDownloadQueue" in payload, false);
});

test("workflow handoffs advance in selected-artist phase order", () => {
  const refreshPriority = ARTIST_WORKFLOW_PRIORITY.MONITORED_BATCH_BASE;
  const matchPriority = nextArtistWorkflowPriority(refreshPriority);
  const rescanPriority = nextArtistWorkflowPriority(matchPriority);
  const curatePriority = nextArtistWorkflowPriority(rescanPriority);
  const downloadPriority = nextArtistWorkflowPriority(curatePriority);

  assert.deepEqual(
    [refreshPriority, matchPriority, rescanPriority, curatePriority, downloadPriority],
    [-1, 0, 1, 2, 3],
  );
});
