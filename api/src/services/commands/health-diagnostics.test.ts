import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-health-diagnostics-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.health-diagnostics.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");
process.env.MUSIC_PATH = path.join(tempDir, "music");
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DISCOGENIUS_DISABLE_DOWNLOADS = "1";
process.env.DISCOGENIUS_SCHEDULER_THREAD_LIMIT = "1";

for (const directory of [
  process.env.DOWNLOAD_PATH,
  process.env.MUSIC_PATH,
  process.env.SPATIAL_PATH,
  process.env.VIDEO_PATH,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

let dbModule: typeof import("../../database.js");
let healthModule: typeof import("./health.js");
let runtimeDiagnosticsModule: typeof import("./runtime-diagnostics.js");
let queueModule: typeof import("./command-queue-manager.js");
let workerPoolModule: typeof import("./worker/command-worker-pool.js");
let bootstrapSnapshot: ReturnType<typeof import("./health.js").collectHealthDiagnosticsSnapshot>;

before(async () => {
  dbModule = await import("../../database.js");
  healthModule = await import("./health.js");
  runtimeDiagnosticsModule = await import("./runtime-diagnostics.js");
  queueModule = await import("./command-queue-manager.js");
  workerPoolModule = await import("./worker/command-worker-pool.js");

  bootstrapSnapshot = healthModule.collectHealthDiagnosticsSnapshot();
  dbModule.initDatabase();
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM commands").run();
  dbModule.db.prepare("DELETE FROM runtime_controls").run();
  dbModule.db.prepare("DELETE FROM scheduled_tasks").run();
  dbModule.db.prepare(`
    INSERT OR REPLACE INTO AlbumLibraryProjectionState (singleton_id, row_count, updated_at)
    VALUES (1, 0, CURRENT_TIMESTAMP)
  `).run();
  dbModule.db.prepare(`
    INSERT OR REPLACE INTO TrackLibraryProjectionState (singleton_id, row_count, updated_at)
    VALUES (1, 0, CURRENT_TIMESTAMP)
  `).run();
  healthModule.clearHealthCapabilityCache();
});

after(async () => {
  await workerPoolModule.CommandWorkerPool.stop();
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("lightweight diagnostics tolerate collection before schema initialization", () => {
  assert.equal(bootstrapSnapshot.subsystems.database.schema.status, "warning");
  assert.equal(bootstrapSnapshot.subsystems.database.schema.details?.userVersion, 0);
  assert.equal(bootstrapSnapshot.subsystems.database.lastDeepResult, null);
  assert.ok(bootstrapSnapshot.subsystems.commandQueue);
  assert.ok(bootstrapSnapshot.subsystems.scheduledTasks);
});

test("lightweight diagnostics expose schema, WAL, storage, queue, and configured connectivity", () => {
  const snapshot = healthModule.collectHealthDiagnosticsSnapshot();

  assert.equal(snapshot.subsystems.database.schema.details?.userVersion, 43);
  assert.equal(snapshot.subsystems.database.schema.details?.journalMode, "wal");
  assert.equal(snapshot.subsystems.database.wal.status, "ok");
  assert.equal(snapshot.subsystems.database.storage.status, "ok");
  assert.equal(snapshot.subsystems.commandQueue.status, "ok");
  assert.equal(snapshot.subsystems.scheduledTasks.status, "ok");
  assert.equal(snapshot.subsystems.imports.status, "ok");
  assert.equal(snapshot.subsystems.statistics.status, "ok");
  assert.equal(snapshot.subsystems.catalog.details?.connectivity, "unknown");
  assert.match(
    String(snapshot.subsystems.catalog.details?.connectivityPolicy),
    /does not make live catalog requests/,
  );
  assert.equal(snapshot.subsystems.database.deep.status, "warning");
});

test("runtime diagnostics retain bounded API latency percentiles and exclude streams", () => {
  const before = runtimeDiagnosticsModule.getRuntimeDiagnosticsSnapshot();

  runtimeDiagnosticsModule.trackRuntimeRequest("GET", "/api/v1/artist?limit=1")(200);
  runtimeDiagnosticsModule.trackRuntimeRequest("GET", "/api/v1/stats")(200);
  runtimeDiagnosticsModule.trackRuntimeRequest("GET", "/api/v1/events")(200);
  runtimeDiagnosticsModule.trackRuntimeRequest("GET", "/assets/index.js")(200);

  const after = runtimeDiagnosticsModule.getRuntimeDiagnosticsSnapshot();
  assert.equal(after.totalRequests, before.totalRequests + 2);
  assert.equal(after.totalStreamingRequests, before.totalStreamingRequests + 1);
  assert.equal(after.requestLatency.sampleCount, before.requestLatency.sampleCount + 2);
  assert.ok(after.requestLatency.capacity >= after.requestLatency.sampleCount);
  assert.ok(after.requestLatency.p50Ms >= 0);
  assert.ok(after.requestLatency.p95Ms >= after.requestLatency.p50Ms);
  assert.ok(after.requestLatency.p99Ms >= after.requestLatency.p95Ms);
});

test("deep database audit persists quick_check and foreign-key evidence", () => {
  const result = healthModule.runDeepDatabaseHealthCheck();
  assert.equal(result.status, "healthy");
  assert.equal(result.quickCheck.status, "ok");
  assert.equal(result.foreignKeys.violationCount, 0);
  assert.equal(result.persisted, true);

  const snapshot = healthModule.collectHealthDiagnosticsSnapshot();
  assert.equal(snapshot.subsystems.database.deep.status, "ok");
  assert.equal(snapshot.subsystems.database.lastDeepResult?.checkedAt, result.checkedAt);
  assert.equal(snapshot.subsystems.database.lastDeepResult?.persisted, true);
});

test("deep database audit records foreign-key violations as unhealthy", () => {
  dbModule.db.pragma("foreign_keys = OFF");
  dbModule.db.exec(`
    CREATE TABLE health_diagnostic_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE health_diagnostic_child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES health_diagnostic_parent(id)
    );
    INSERT INTO health_diagnostic_child (id, parent_id) VALUES (1, 999);
  `);

  try {
    const result = healthModule.runDeepDatabaseHealthCheck();
    assert.equal(result.status, "unhealthy");
    assert.equal(result.quickCheck.status, "ok");
    assert.ok(result.foreignKeys.violationCount >= 1);
    assert.equal(result.persisted, true);

    const snapshot = healthModule.collectHealthDiagnosticsSnapshot();
    assert.equal(snapshot.subsystems.database.deep.status, "error");
    assert.ok(snapshot.issues.some((issue) => issue.scope === "database.deep"));
  } finally {
    dbModule.db.exec(`
      DROP TABLE health_diagnostic_child;
      DROP TABLE health_diagnostic_parent;
    `);
    dbModule.db.pragma("foreign_keys = ON");
  }
});

test("bounded diagnostics flag aging work, failed imports, and overdue tasks", () => {
  dbModule.db.prepare(`
    INSERT INTO commands (
      name, payload, status, priority, created_at, completed_at, updated_at
    ) VALUES
      ('CheckHealth', '{}', 'queued', 0, datetime('now', '-5 hours'), NULL, CURRENT_TIMESTAMP),
      (
        'ImportDownload',
        '{"downloadState":{"state":"importFailed"}}',
        'failed',
        0,
        datetime('now', '-1 hour'),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
  `).run();
  dbModule.db.prepare(`
    INSERT INTO scheduled_tasks (
      task_key, name, interval_minutes, enabled, last_queued_at, updated_at
    ) VALUES (
      'health-check',
      'Check Health',
      30,
      1,
      datetime('now', '-5 hours'),
      CURRENT_TIMESTAMP
    )
  `).run();
  dbModule.db.prepare("DELETE FROM AlbumLibraryProjectionState").run();
  dbModule.db.prepare("DELETE FROM TrackLibraryProjectionState").run();

  process.env.DISCOGENIUS_QUEUE_AGE_WARNING_MS = "1000";
  process.env.DISCOGENIUS_QUEUE_AGE_ERROR_MS = "2000";
  try {
    const snapshot = healthModule.collectHealthDiagnosticsSnapshot();
    assert.equal(snapshot.subsystems.commandQueue.status, "warning");
    assert.equal(snapshot.subsystems.imports.status, "warning");
    assert.equal(snapshot.subsystems.scheduledTasks.status, "warning");
    assert.equal(snapshot.subsystems.statistics.status, "ok");
    assert.deepEqual(
      snapshot.subsystems.statistics.details?.staleProjections,
      ["album-library", "track-library"],
    );
  } finally {
    delete process.env.DISCOGENIUS_QUEUE_AGE_WARNING_MS;
    delete process.env.DISCOGENIUS_QUEUE_AGE_ERROR_MS;
  }
});

test("production command-worker execution keeps deep PRAGMAs off the main thread", async () => {
  const commandId = queueModule.CommandQueueManager.push(queueModule.CommandNames.CheckHealth, {});
  const claimed = queueModule.CommandQueueManager.claimForExecution(
    commandId,
    `health-worker-test:${commandId}`,
    60_000,
  );
  assert.ok(claimed);

  workerPoolModule.CommandWorkerPool.start();
  await workerPoolModule.CommandWorkerPool.run(claimed, {
    leaseMs: 60_000,
    heartbeatMs: 1_000,
  });

  const snapshot = healthModule.collectHealthDiagnosticsSnapshot();
  assert.equal(snapshot.subsystems.database.lastDeepResult?.executedOffMainThread, true);
  assert.equal(snapshot.subsystems.database.lastDeepResult?.persisted, true);
  assert.equal(queueModule.CommandQueueManager.get(commandId)?.status, "completed");
});
