import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-wait-queue-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.wait-queue.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let waitQueueModule: typeof import("./download-wait-queue.js");
let queryModule: typeof import("./download-queue-query-service.js");
let queueModule: typeof import("../commands/command-queue-manager.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  waitQueueModule = await import("./download-wait-queue.js");
  queryModule = await import("./download-queue-query-service.js");
  queueModule = await import("../commands/command-queue-manager.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM DownloadQueue").run();
  dbModule.db.prepare("DELETE FROM commands").run();
  queryModule.DownloadQueueQueryService.invalidateSnapshots();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function enqueueTrack(ref: string, title: string, position: "front" | "back" = "back") {
  return waitQueueModule.DownloadWaitQueue.enqueue({
    refKey: ref,
    mediaKind: "track",
    commandName: queueModule.CommandNames.DownloadTrack,
    provider: "tidal",
    providerId: ref,
    title,
    artist: "Bastille",
    payload: {
      type: "track",
      provider: "tidal",
      providerId: ref,
      title,
      artist: "Bastille",
    },
    position,
  });
}

test("enqueue stores waiting items without creating commands", () => {
  const first = enqueueTrack("track-1", "Pompeii");
  const second = enqueueTrack("track-2", "Things We Lost");
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 2);
  assert.equal(waitQueueModule.DownloadWaitQueue.countUnclaimed(), 2);

  const commandCount = dbModule.db.prepare(
    "SELECT COUNT(*) AS count FROM commands WHERE name = 'DownloadTrack'",
  ).get() as { count: number };
  assert.equal(commandCount.count, 0);

  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.equal(live.total, 2);
  assert.deepEqual(live.items.map((item) => item.title), ["Pompeii", "Things We Lost"]);
  assert.equal(live.items[0]?.status, "queued");
  assert.equal(live.items[0]?.provider, "tidal");
  assert.equal(live.items[0]?.queuePosition, 1);
  assert.equal(live.items[1]?.queuePosition, 2);
});

test("duplicate refKey does not insert a second wait row", () => {
  const first = enqueueTrack("track-dup", "Pompeii");
  const second = enqueueTrack("track-dup", "Pompeii");
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 1);
});

test("manual video download and Download Missing share one wait row for the same provider video", () => {
  const fromPage = waitQueueModule.DownloadWaitQueue.enqueue({
    refKey: "64660138",
    mediaKind: "video",
    commandName: queueModule.CommandNames.DownloadVideo,
    provider: "tidal",
    providerId: "64660138",
    title: "Living",
    payload: { type: "video", provider: "tidal", providerId: "64660138" },
  });
  const fromMissing = waitQueueModule.DownloadWaitQueue.enqueue({
    refKey: "recording:1:video",
    mediaKind: "video",
    commandName: queueModule.CommandNames.DownloadVideo,
    provider: "tidal",
    providerId: "64660138",
    title: "Living",
    payload: { type: "video", provider: "tidal", providerId: "64660138" },
  });
  assert.equal(fromPage.created, true);
  assert.equal(fromMissing.created, false);
  assert.equal(fromMissing.id, fromPage.id);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 1);
});

test("manual front insert sits before bulk waiting items", () => {
  enqueueTrack("bulk-1", "Bulk One", "back");
  enqueueTrack("bulk-2", "Bulk Two", "back");
  enqueueTrack("manual-1", "Manual Next", "front");

  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.deepEqual(live.items.map((item) => item.title), ["Manual Next", "Bulk One", "Bulk Two"]);
});

test("reorder moves a waiting item to the top like qBittorrent", () => {
  const first = enqueueTrack("r-1", "One");
  const second = enqueueTrack("r-2", "Two");
  const third = enqueueTrack("r-3", "Three");
  waitQueueModule.DownloadWaitQueue.reorder([third.id], { position: "top" });

  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.deepEqual(live.items.map((item) => item.id), [third.id, first.id, second.id]);
  assert.equal(live.items[0]?.queuePosition, 1);
});

test("failed claimed wait rows stay off the live queue page", () => {
  enqueueTrack("fail-1", "Failed Album");
  const claimed = waitQueueModule.DownloadWaitQueue.claimNext();
  assert.ok(claimed);
  queueModule.CommandQueueManager.fail(claimed.commandId, "provider error");
  enqueueTrack("wait-1", "Waiting Album");

  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.deepEqual(live.items.map((item) => item.title), ["Waiting Album"]);
  assert.equal(live.total, 1);
  assert.equal(live.items[0]?.status, "queued");
});

test("Download* commands without a wait row stay off the live queue", () => {
  const queuedId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadAlbum,
    { type: "album", provider: "tidal", title: "Orphan Album" },
    "orphan-album-ref",
  );
  const failedId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadAlbum,
    { type: "album", provider: "tidal", title: "The Spirit" },
    "failed-album-ref",
  );
  queueModule.CommandQueueManager.fail(failedId, "Hybrid album import incomplete");
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 0);

  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.equal(live.total, 0);
  assert.deepEqual(live.items, []);

  const history = queryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });
  assert.equal(history.items.some((item) => item.id === failedId), true);
  assert.equal(history.items.some((item) => item.id === queuedId), false);
});

test("claim creates a Download* command and leaves other wait rows unclaimed", () => {
  enqueueTrack("c-1", "First");
  enqueueTrack("c-2", "Second");
  const claimed = waitQueueModule.DownloadWaitQueue.claimNext();
  assert.ok(claimed);
  assert.ok(claimed.commandId > 0);

  const command = queueModule.CommandQueueManager.get(claimed.commandId);
  assert.equal(command?.name, "DownloadTrack");
  assert.equal(command?.status, "queued");
  assert.equal(waitQueueModule.DownloadWaitQueue.countUnclaimed(), 1);

  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.equal(live.total, 2);
  assert.equal(live.items[1]?.title, "Second");
  assert.equal(live.items[1]?.status, "queued");
});

test("removing a wait row does not require a command", () => {
  const queued = enqueueTrack("del-1", "Gone");
  const removed = waitQueueModule.DownloadWaitQueue.remove(queued.id);
  assert.equal(removed?.id, queued.id);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 0);
});

test("finishClaimed returns the wait-row id after the row is gone", () => {
  const queued = enqueueTrack("fin-1", "Pompeii");
  const claimed = waitQueueModule.DownloadWaitQueue.claim(queued.id);
  assert.ok(claimed);
  const waitId = waitQueueModule.DownloadWaitQueue.finishClaimed(claimed.commandId);
  assert.equal(waitId, queued.id);
  assert.equal(waitQueueModule.DownloadWaitQueue.getIdByCommandId(claimed.commandId), null);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 0);
});

test("completed SSE keeps the wait-row jobId after the claim is removed", async () => {
  const queued = enqueueTrack("sse-1", "Pompeii");
  const claimed = waitQueueModule.DownloadWaitQueue.claim(queued.id);
  assert.ok(claimed);
  const eventsModule = await import("./download-events.js");
  const seen: Array<{ jobId: number; commandId: number }> = [];
  const onCompleted = (event: { jobId: number; commandId: number }) => {
    seen.push({ jobId: event.jobId, commandId: event.commandId });
  };
  eventsModule.downloadEvents.on("completed", onCompleted);
  try {
    const waitId = waitQueueModule.DownloadWaitQueue.finishClaimed(claimed.commandId);
    eventsModule.downloadEvents.emitCompleted(claimed.commandId, {
      providerId: "sse-1",
      type: "track",
    }, waitId);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.jobId, queued.id);
    assert.equal(seen[0]?.commandId, claimed.commandId);
    assert.notEqual(seen[0]?.jobId, claimed.commandId);
  } finally {
    eventsModule.downloadEvents.off("completed", onCompleted);
  }
});

test("releaseUnstartedClaims returns a claimed-but-never-started wait row to the list", () => {
  const queued = enqueueTrack("unstarted-1", "Pompeii");
  const claimed = waitQueueModule.DownloadWaitQueue.claim(queued.id);
  assert.ok(claimed);
  assert.equal(queueModule.CommandQueueManager.get(claimed.commandId)?.status, "queued");

  const released = waitQueueModule.DownloadWaitQueue.releaseUnstartedClaims();
  assert.equal(released, 1);
  assert.equal(queueModule.CommandQueueManager.get(claimed.commandId), null);
  const wait = waitQueueModule.DownloadWaitQueue.get(queued.id);
  assert.equal(wait?.command_id, null);
  assert.equal(waitQueueModule.DownloadWaitQueue.countUnclaimed(), 1);
});

test("dropUnclaimedDownloadCommands removes queued Download* with no wait claim", () => {
  enqueueTrack("claimed-ref", "Claimed");
  const claimed = waitQueueModule.DownloadWaitQueue.claimNext();
  assert.ok(claimed);

  const strayId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadAlbum,
    { type: "album", providerId: "stray-album", provider: "tidal" },
    "stray-album",
  );
  assert.equal(queueModule.CommandQueueManager.get(strayId)?.status, "queued");

  const dropped = waitQueueModule.DownloadWaitQueue.dropUnclaimedDownloadCommands();
  assert.equal(dropped, 1);
  assert.equal(queueModule.CommandQueueManager.get(strayId), null);
  assert.ok(queueModule.CommandQueueManager.get(claimed.commandId));
});

test("history retry by command id re-enqueues a wait row after finishClaimed", async () => {
  const queued = enqueueTrack("hist-1", "Pompeii");
  const claimed = waitQueueModule.DownloadWaitQueue.claim(queued.id);
  assert.ok(claimed);
  queueModule.CommandQueueManager.fail(claimed.commandId, "synthetic failure");
  waitQueueModule.DownloadWaitQueue.finishClaimed(claimed.commandId);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 0);

  const retryModule = await import("./download-queue-retry.js");
  const result = retryModule.retryDownloadQueueItem(claimed.commandId);
  assert.equal(result.status, 200);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 1);
  const live = queryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
  assert.equal(live.items[0]?.title, "Pompeii");
  assert.equal(live.items[0]?.provider, "tidal");
});

test("recoverOrphanClaims drops wait rows whose command already failed", () => {
  enqueueTrack("fail-orphan", "Stuck Album");
  const claimed = waitQueueModule.DownloadWaitQueue.claimNext();
  assert.ok(claimed);
  queueModule.CommandQueueManager.fail(claimed.commandId, "import failed");
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 1);
  const dropped = waitQueueModule.DownloadWaitQueue.recoverOrphanClaims();
  assert.equal(dropped, 1);
  assert.equal(waitQueueModule.DownloadWaitQueue.count(), 0);
});
