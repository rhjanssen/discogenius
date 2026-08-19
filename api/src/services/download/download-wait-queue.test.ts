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
