import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import Database from "better-sqlite3";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-system-task-"));
const databasePath = path.join(tempDir, "discogenius.system-task.test.db");
process.env.DB_PATH = databasePath;
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue-manager.js");
let schedulerModule: typeof import("./scheduler.js");
let serviceModule: typeof import("./system-task-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  queueModule = await import("./command-queue-manager.js");
  schedulerModule = await import("./scheduler.js");
  serviceModule = await import("./system-task-service.js");

  dbModule.initDatabase();
});

beforeEach(() => {
  if (schedulerModule.getMonitoringStatus().running) {
    schedulerModule.stopMonitoring();
  }
  dbModule.db.prepare("DELETE FROM commands").run();
  dbModule.db.prepare("DELETE FROM scheduled_tasks").run();
  dbModule.db.prepare("DELETE FROM monitoring_runtime_state").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
});

after(() => {
  if (schedulerModule.getMonitoringStatus().running) {
    schedulerModule.stopMonitoring();
  }
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function readPersistedSchedule(taskKey: string) {
  const reopened = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return reopened.prepare(`
      SELECT interval_minutes, enabled, last_queued_at
      FROM scheduled_tasks
      WHERE task_key = ?
    `).get(taskKey) as {
      interval_minutes: number;
      enabled: number;
      last_queued_at: string | null;
    } | undefined;
  } finally {
    reopened.close();
  }
}

test("monitoring interval PATCH persists through scheduler resync and an independent database reopen", () => {
  const updated = serviceModule.updateSystemTaskSchedule("monitoring-cycle", {
    intervalMinutes: 37,
  });
  assert.equal(updated.intervalMinutes, 37);

  // Both snapshot reads and poll ticks resynchronise definitions. Neither may
  // replace a user-edited interval with the environment/default interval.
  dbModule.db.prepare("UPDATE scheduled_tasks SET last_queued_at = CURRENT_TIMESTAMP").run();
  assert.equal(
    schedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle")?.intervalMinutes,
    37,
  );
  schedulerModule.updateMonitoringConfig({ monitor_new_artists: true });
  if (schedulerModule.getMonitoringStatus().running) {
    schedulerModule.stopMonitoring();
  }
  assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
    [queueModule.CommandNames.RefreshMetadata],
    10,
  ).length, 0);
  schedulerModule.pollScheduledTasks();
  schedulerModule.pollScheduledTasks();
  assert.equal(
    schedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle")?.intervalMinutes,
    37,
  );

  const persisted = readPersistedSchedule("monitoring-cycle");
  assert.equal(persisted?.interval_minutes, 37);
});

test("combined monitoring enabled and interval update preserves both values and remains disabled across polls", () => {
  const updated = serviceModule.updateSystemTaskSchedule("monitoring-cycle", {
    enabled: false,
    intervalMinutes: 19,
  });
  if (schedulerModule.getMonitoringStatus().running) {
    schedulerModule.stopMonitoring();
  }

  assert.equal(updated.enabled, false);
  assert.equal(updated.intervalMinutes, 19);

  dbModule.db.prepare(`
    UPDATE scheduled_tasks
    SET last_queued_at = '2000-01-01 00:00:00'
    WHERE task_key = 'monitoring-cycle'
  `).run();
  schedulerModule.pollScheduledTasks();
  schedulerModule.pollScheduledTasks();

  assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
    [queueModule.CommandNames.RefreshMetadata],
    10,
  ).length, 0);
  const persisted = readPersistedSchedule("monitoring-cycle");
  assert.equal(persisted?.enabled, 0);
  assert.equal(persisted?.interval_minutes, 19);
});

test("enabling with a longer interval does not run one tick using the previous interval", () => {
  schedulerModule.getScheduledTaskSnapshots();
  schedulerModule.updateScheduledTask("monitoring-cycle", {
    enabled: false,
    intervalMinutes: 5,
  });
  dbModule.db.prepare(`
    UPDATE scheduled_tasks
    SET last_queued_at = datetime('now', '-30 minutes')
    WHERE task_key = 'monitoring-cycle'
  `).run();

  const updated = serviceModule.updateSystemTaskSchedule("monitoring-cycle", {
    enabled: true,
    intervalMinutes: 60,
  });
  if (schedulerModule.getMonitoringStatus().running) {
    schedulerModule.stopMonitoring();
  }

  assert.equal(updated.enabled, true);
  assert.equal(updated.intervalMinutes, 60);
  assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
    [queueModule.CommandNames.RefreshMetadata],
    10,
  ).length, 0);
});

test("edited enabled schedule queues once across consecutive polls", () => {
  schedulerModule.getScheduledTaskSnapshots();
  dbModule.db.prepare("UPDATE scheduled_tasks SET last_queued_at = CURRENT_TIMESTAMP").run();
  serviceModule.updateSystemTaskSchedule("health-check", {
    enabled: true,
    intervalMinutes: 7,
  });
  dbModule.db.prepare(`
    UPDATE scheduled_tasks
    SET last_queued_at = '2000-01-01 00:00:00'
    WHERE task_key = 'health-check'
  `).run();

  schedulerModule.pollScheduledTasks();
  schedulerModule.pollScheduledTasks();

  assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
    [queueModule.CommandNames.CheckHealth],
    10,
  ).length, 1);
  const persisted = readPersistedSchedule("health-check");
  assert.equal(persisted?.enabled, 1);
  assert.equal(persisted?.interval_minutes, 7);
  assert.notEqual(persisted?.last_queued_at, "2000-01-01 00:00:00");
});

test("task history distinguishes queued, started, terminal, successful, and failed runs", () => {
  const insert = dbModule.db.prepare(`
    INSERT INTO commands (
      name, ref_id, payload, status, created_at, started_at, completed_at
    ) VALUES (?, ?, '{}', ?, ?, ?, ?)
  `);

  insert.run(
    queueModule.CommandNames.CheckHealth,
    "successful",
    "completed",
    "2026-01-01 10:00:00",
    "2026-01-01 10:01:00",
    "2026-01-01 10:02:00",
  );
  insert.run(
    queueModule.CommandNames.CheckHealth,
    "failed",
    "failed",
    "2026-01-02 10:00:00",
    "2026-01-02 10:01:00",
    "2026-01-02 10:02:00",
  );
  insert.run(
    queueModule.CommandNames.CheckHealth,
    "cancelled",
    "cancelled",
    "2026-01-03 10:00:00",
    "2026-01-03 10:01:00",
    "2026-01-03 10:02:00",
  );
  insert.run(
    queueModule.CommandNames.CheckHealth,
    "started",
    "started",
    "2026-01-04 10:00:00",
    "2026-01-04 10:01:00",
    null,
  );
  insert.run(
    queueModule.CommandNames.CheckHealth,
    "queued",
    "queued",
    "2026-01-05 10:00:00",
    null,
    null,
  );

  const task = serviceModule.getSystemTask("health-check");
  assert.ok(task);
  assert.equal(task.active, true);
  assert.equal(task.lastQueuedTime, "2026-01-05 10:00:00");
  assert.equal(task.lastStartTime, "2026-01-04 10:01:00");
  assert.equal(task.lastExecution, "2026-01-03 10:02:00");
  assert.equal(task.lastExecutionStatus, "cancelled");
  assert.equal(task.lastSuccessTime, "2026-01-01 10:02:00");
  assert.equal(task.lastFailureTime, "2026-01-02 10:02:00");
});

test("a queued task is not reported as started or executed", () => {
  dbModule.db.prepare(`
    INSERT INTO commands (name, ref_id, payload, status, created_at)
    VALUES (?, 'queued-only', '{}', 'queued', '2026-02-01 09:00:00')
  `).run(queueModule.CommandNames.BackupDatabase);

  const task = serviceModule.getSystemTask("backup-database");
  assert.ok(task);
  assert.equal(task.active, true);
  assert.equal(task.lastQueuedTime, "2026-02-01 09:00:00");
  assert.equal(task.lastStartTime, null);
  assert.equal(task.lastExecution, null);
  assert.equal(task.lastExecutionStatus, null);
  assert.equal(task.lastSuccessTime, null);
  assert.equal(task.lastFailureTime, null);
});
