import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-maintenance-admission-"));
process.env.DB_PATH = path.join(root, "active.db");
process.env.DISCOGENIUS_CONFIG_DIR = root;
let database: typeof import("../../database.js");
let maintenance: typeof import("./runtime-maintenance.js");
before(async () => {
  database = await import("../../database.js");
  database.initDatabase();
  maintenance = await import("./runtime-maintenance.js");
});
after(() => {
  database.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test("housekeeping waits for the writer before pruning stale tracked assets", async () => {
  database.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES (1, 'maintenance-artist', 'Test Artist')").run();
  database.db.prepare("INSERT INTO MetadataFiles(artist_id, file_path, relative_path, library_root, extension, type, file_type) VALUES ('maintenance-artist', ?, 'missing-cover.jpg', ?, 'jpg', 'AlbumImage', 'cover')")
    .run(path.join(root, "missing-cover.jpg"), root);
  let admit!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writer = database.withSqliteWriteGate(async () => { admit(); await blocked; }, "test:held-writer");
  await admitted;
  let settled = false;
  const run = maintenance.runRuntimeMaintenance().then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM MetadataFiles").get() as { count: number }).count, 1);
  } finally { release(); }
  await writer;
  const result = await run;
  assert.equal(result.staleTrackedAssetsRemoved, 1);
  assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM MetadataFiles").get() as { count: number }).count, 0);
});

test("sidecar disk checks release writer admission and cannot delete a concurrently repaired path", async t => {
  const { LibraryFilesService } = await import("../mediafiles/library-files.js");
  const stale = path.join(root, "race-cover.jpg");
  const repaired = path.join(root, "repaired-cover.jpg");
  fs.writeFileSync(repaired, "cover");
  const id = Number(database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id, file_path, relative_path, library_root, extension, type, file_type)
    VALUES ('maintenance-artist', ?, 'race-cover.jpg', ?, 'jpg', 'AlbumImage', 'cover')`).run(stale, root).lastInsertRowid);
  const stat = fs.promises.stat;
  let checking!: () => void;
  let release!: () => void;
  const checked = new Promise<void>(resolve => { checking = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs.promises, "stat", async (file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === stale) { checking(); await blocked; }
    return stat(file, ...args as []);
  });
  const pruning = LibraryFilesService.pruneStaleTrackedAssets();
  await checked;
  try {
    await database.withSqliteWriteGate(() => database.db.prepare(`UPDATE MetadataFiles
      SET file_path = ?, relative_path = 'repaired-cover.jpg' WHERE id = ?`).run(repaired, id), "test:repair-during-stat");
  } finally { release(); }
  assert.equal((await pruning).removed, 0);
  assert.equal((database.db.prepare("SELECT file_path FROM MetadataFiles WHERE id = ?").get(id) as { file_path: string }).file_path, repaired);
});

test("repeated housekeeping preserves distinct physical audio row identities and linked lyrics", async () => {
  const ids = ["one", "two"].map(name => {
    const file = path.join(root, `${name}.flac`);
    fs.writeFileSync(file, "fixture");
    return Number(database.db.prepare(`INSERT INTO TrackFiles
      (file_path, filename, relative_path, library_root, extension, file_type, library_slot, canonical_track_mbid, canonical_recording_mbid)
      VALUES (?, ?, ?, ?, 'flac', 'track', 'stereo', 'same-track', 'same-recording')`).run(file, `${name}.flac`, `${name}.flac`, root).lastInsertRowid);
  });
  const lyric = path.join(root, "one.lrc");
  fs.writeFileSync(lyric, "[00:01]Fixture");
  database.db.prepare(`INSERT INTO LyricFiles (artist_id, track_file_id, file_path, relative_path, library_root, extension)
    VALUES ('maintenance-artist', ?, ?, 'one.lrc', ?, 'lrc')`).run(ids[0], lyric, root);
  await maintenance.runRuntimeMaintenance();
  await maintenance.runRuntimeMaintenance();
  assert.deepEqual((database.db.prepare("SELECT id FROM TrackFiles WHERE canonical_track_mbid = 'same-track' ORDER BY id").all() as Array<{ id: number }>).map(row => row.id), ids);
  assert.equal((database.db.prepare("SELECT track_file_id FROM LyricFiles WHERE file_path = ?").get(lyric) as { track_file_id: number }).track_file_id, ids[0]);
});

test("an import is admitted while a long Housekeeping run is active", async () => {
  const { CommandManager } = await import("./command.js");
  const { CommandQueueManager } = await import("./command-queue-manager.js");
  const { CommandNames } = await import("./command-names.js");

  // Housekeeping is running (started)
  const housekeepingId = CommandQueueManager.push(CommandNames.Housekeeping, {});
  CommandQueueManager.claimForExecution(housekeepingId, "housekeeping-worker", 60_000);

  // 1. canStartCommand for ImportDownload must be true
  const importCheck = CommandManager.canStartCommand(CommandNames.ImportDownload);
  assert.equal(importCheck.canStart, true, "ImportDownload must be able to start while Housekeeping is active");

  // 2. Completed download claiming import execution must succeed while Housekeeping is active
  const downloadId = CommandQueueManager.push(CommandNames.DownloadAlbum, { provider: "tidal", providerId: "album" } as any);
  CommandQueueManager.claimForExecution(downloadId, "download-worker", 60_000);
  const admitted = CommandQueueManager.claimImportForExecution(downloadId, "download-worker");
  assert.equal(admitted, true, "Completed download must be admitted for import while Housekeeping is active");

  CommandQueueManager.complete(downloadId, "download-worker");
  CommandQueueManager.complete(housekeepingId, "housekeeping-worker");
});

test("cancel stops Housekeeping within one batch and marks command cancelled", async () => {
  const { CommandQueueManager } = await import("./command-queue-manager.js");
  const { CommandNames } = await import("./command-names.js");
  const { handleHousekeeping } = await import("./handlers/maintenance-handlers.js");
  const { persistCommandOutcome } = await import("./command-context.js");
  const { cancelNonDownloadCommand } = await import("./command-control-service.js");

  const id = CommandQueueManager.push(CommandNames.Housekeeping, {});
  const job = CommandQueueManager.claimForExecution(id, "cancel-test-worker", 60_000)!;

  let progressReported = 0;
  const ctx = {
    updateCommandDescription: (_job: any, options: { progress?: number; description?: string }) => {
      if (options.progress !== undefined) progressReported = options.progress;
    },
    formatArtistPhaseDescription: () => "",
    formatWorkflowCommandLabel: () => "",
    resolveArtistLabel: () => "",
    yieldToEventLoop: async () => {},
  };

  // Request cancellation via cancelNonDownloadCommand (simulating DELETE /api/v1/command/:id)
  await cancelNonDownloadCommand(id);
  assert.equal(CommandQueueManager.get(id)?.payload.cancelRequested, true);

  // Run handleHousekeeping - should throw cancellation error
  let errorCaught: unknown;
  try {
    await handleHousekeeping(job as any, ctx);
  } catch (err) {
    errorCaught = err;
  }
  assert.match((errorCaught as Error)?.message || "", /Housekeeping cancellation requested/);

  // persistCommandOutcome records the cancelled status
  const outcome = await persistCommandOutcome(job, errorCaught);
  assert.equal(outcome, "cancelled");
  assert.equal(CommandQueueManager.get(id)?.status, "cancelled");
});

test("hard timeout stops Housekeeping cleanly without error and completes without retry", async () => {
  const { CommandQueueManager } = await import("./command-queue-manager.js");
  const { CommandNames } = await import("./command-names.js");
  const { handleHousekeeping } = await import("./handlers/maintenance-handlers.js");
  const { persistCommandOutcome } = await import("./command-context.js");

  // Direct runRuntimeMaintenance timeout test
  const summary = await maintenance.runRuntimeMaintenance({
    timeoutMs: -1, // immediate timeout
  });
  assert.equal(summary.timedOut, true);

  // Through command handler
  const id = CommandQueueManager.push(CommandNames.Housekeeping, {});
  const job = CommandQueueManager.claimForExecution(id, "timeout-test-worker", 60_000)!;

  let finalDescription = "";
  let finalProgress = 0;
  const ctx = {
    updateCommandDescription: (_job: any, options: { progress?: number; description?: string }) => {
      if (options.progress !== undefined) finalProgress = options.progress;
      if (options.description) finalDescription = options.description;
    },
    formatArtistPhaseDescription: () => "",
    formatWorkflowCommandLabel: () => "",
    resolveArtistLabel: () => "",
    yieldToEventLoop: async () => {},
  };

  process.env.DISCOGENIUS_HOUSEKEEPING_TIMEOUT_MS = "1";
  try {
    // Should NOT throw an error on timeout
    await handleHousekeeping(job as any, ctx);
  } finally {
    delete process.env.DISCOGENIUS_HOUSEKEEPING_TIMEOUT_MS;
  }

  assert.equal(finalProgress, 100);
  assert.match(finalDescription, /stopped at time limit/);

  // Outcome must be completed, not failed, so it does not retry 3x in a row
  const outcome = await persistCommandOutcome(job, null);
  assert.equal(outcome, "completed");
  assert.equal(CommandQueueManager.get(id)?.status, "completed");
});

test("task-schedule PATCH goes through SQLite write gate without database is locked", async () => {
  const { updateSystemTaskSchedule } = await import("./system-task-service.js");
  // Concurrently hold a write gate to verify that updateSystemTaskSchedule waits and succeeds
  let admit!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writer = database.withSqliteWriteGate(async () => {
    admit();
    await blocked;
  }, "test:held-writer-for-patch");

  await admitted;
  let patchSettled = false;
  const patchPromise = database.withSqliteWriteGate(
    () => updateSystemTaskSchedule("housekeeping", { enabled: false }),
    "system-task:update-schedule",
  ).then(res => { patchSettled = true; return res; });

  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(patchSettled, false, "PATCH must wait for the held write gate");
  release();
  await writer;

  const result = await patchPromise;
  assert.equal(result.enabled, false);
});
