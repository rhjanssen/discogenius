import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-control-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.download-control.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("../commands/command-queue-manager.js");
let controlModule: typeof import("./download-queue-control.js");

before(async () => {
  dbModule = await import("../../database.js");
  queueModule = await import("../commands/command-queue-manager.js");
  controlModule = await import("./download-queue-control.js");
  dbModule.initDatabase();
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM commands").run();
  dbModule.db.prepare("DELETE FROM runtime_controls").run();
  delete process.env.DISCOGENIUS_START_PAUSED;
});

after(() => {
  delete process.env.DISCOGENIUS_START_PAUSED;
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("persisted queue pause wins over later startup defaults", () => {
  process.env.DISCOGENIUS_START_PAUSED = "1";
  assert.deepEqual(controlModule.getDownloadQueueControlState(), {
    isPaused: true,
    persisted: false,
    updatedAt: null,
  });

  const resumed = controlModule.setDownloadQueuePaused(false);
  assert.equal(resumed.isPaused, false);
  assert.equal(resumed.persisted, true);
  assert.ok(resumed.updatedAt);

  // A worker/API/container restart may still carry START_PAUSED, but the
  // operator's durable resume remains authoritative.
  assert.equal(controlModule.getDownloadQueueControlState().isPaused, false);

  controlModule.setDownloadQueuePaused(true);
  const row = dbModule.db.prepare(`
    SELECT value
    FROM runtime_controls
    WHERE control_key = 'download_queue_paused'
  `).get() as { value: string };
  assert.equal(row.value, "true");
});

test("pause interruption preserves retry evidence and authoritative order", () => {
  const firstId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadTrack,
    { providerId: "pause-track-1", type: "track" },
    "pause-track-1",
  );
  const secondId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadAlbum,
    { providerId: "pause-album-2", type: "album" },
    "pause-album-2",
  );

  dbModule.db.prepare("UPDATE commands SET attempts = 2 WHERE id = ?").run(firstId);
  const before = queueModule.CommandQueueManager.get(firstId);
  assert.ok(before);
  assert.equal(queueModule.CommandQueueManager.markProcessing(firstId), true);

  assert.equal(queueModule.CommandQueueManager.requeuePausedDownload(firstId), true);

  const afterPause = queueModule.CommandQueueManager.get(firstId);
  assert.equal(afterPause?.status, "queued");
  assert.equal(afterPause?.attempts, 2);
  assert.equal(afterPause?.queue_order, before?.queue_order);
  assert.equal(afterPause?.priority, before?.priority);
  assert.equal(afterPause?.trigger, before?.trigger);
  assert.equal((afterPause?.payload.downloadState as { state?: string } | undefined)?.state, "paused");

  const pending = queueModule.CommandQueueManager.listJobsByTypesAndStatuses(
    queueModule.DOWNLOAD_COMMAND_NAMES,
    ["queued"],
    10,
    0,
    { orderBy: "execution" },
  );
  assert.deepEqual(pending.map((job) => job.id), [firstId, secondId]);
});

test("pause requeue rejects a stale owner without disturbing the live attempt", () => {
  const commandId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadTrack,
    { providerId: "pause-owned-track", type: "track" },
    "pause-owned-track",
  );
  const claimed = queueModule.CommandQueueManager.claimForExecution(
    commandId,
    "download-attempt-current",
    30_000,
  );
  assert.ok(claimed);
  assert.equal(claimed.attempt, 1);

  assert.equal(
    queueModule.CommandQueueManager.requeuePausedDownload(commandId, "download-attempt-stale"),
    false,
  );
  const afterStaleOwner = queueModule.CommandQueueManager.get(commandId);
  assert.equal(afterStaleOwner?.status, "started");
  assert.equal(afterStaleOwner?.worker_id, "download-attempt-current");
  assert.equal(afterStaleOwner?.attempt, 1);

  assert.equal(
    queueModule.CommandQueueManager.requeuePausedDownload(commandId, "download-attempt-current"),
    true,
  );
  const requeued = queueModule.CommandQueueManager.get(commandId);
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.worker_id ?? null, null);
  assert.equal(requeued?.attempt, 1);
});
