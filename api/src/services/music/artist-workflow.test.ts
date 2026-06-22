import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRefreshArtistCommand, queueArtistIntake } from "./artist-workflow.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";

test("credited artist metadata refreshes can disable recursive credit expansion", () => {
  const payload = buildRefreshArtistCommand({
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
    assert.equal(queued.payload?.expandCreditedArtists, false);
    assert.equal(queued.payload?.scanDepth, "deep");
  } finally {
    CommandQueueManager.push = originalAddJob;
  }
});

test("monitoring intake hydrates provider offers without queuing downloads", () => {
  const payload = buildRefreshArtistCommand({
    artistId: "artist-mbid",
    artistName: "Bastille",
    workflow: "monitoring-intake",
  });

  assert.equal(payload.monitorArtist, true);
  assert.equal(payload.hydrateCatalog, true);
  assert.equal(payload.hydrateAlbumTracks, true);
  assert.equal(payload.monitorAlbums, true);
  assert.equal(payload.forceDownloadQueue, false);
});
