import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-task-scheduler-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.task-scheduler.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("./queue.js");
let taskSchedulerModule: typeof import("./task-scheduler.js");
let taskStateModule: typeof import("./task-state.js");

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("./queue.js");
    taskSchedulerModule = await import("./task-scheduler.js");
    taskStateModule = await import("./task-state.js");

    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM job_queue").run();
    dbModule.db.prepare("DELETE FROM scheduled_tasks").run();
    dbModule.db.prepare("DELETE FROM monitoring_runtime_state").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("monitoring cycle waits for downstream work before queueing downloads and stamping completion", () => {
    const initialSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(initialSnapshot);
    assert.equal(initialSnapshot.lastQueuedAt, null);

    const refreshJobId = taskSchedulerModule.queueMonitoringCyclePass({ trigger: 2, includeRootScan: true });
    assert.ok(refreshJobId > 0);

    const beforeCompletionSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(beforeCompletionSnapshot);
    assert.equal(beforeCompletionSnapshot.lastQueuedAt, null);

    const refreshJob = queueModule.TaskQueueService.getById(refreshJobId);
    assert.ok(refreshJob);
    queueModule.TaskQueueService.complete(refreshJobId);
    taskSchedulerModule.queueNextMonitoringPass(refreshJob);

    const pendingRootScans = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.RescanFolders],
        10,
    );
    assert.equal(pendingRootScans.length, 1);
    assert.equal((pendingRootScans[0].payload as Record<string, unknown>).monitoringCycle, "full-cycle");
    assert.equal((pendingRootScans[0].payload as Record<string, unknown>).trackUnmappedFiles, false);

    let pendingDownloads = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.DownloadMissing],
        10,
    );
    assert.equal(pendingDownloads.length, 0);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), true);

    const rootScanJob = pendingRootScans[0];
    queueModule.TaskQueueService.complete(rootScanJob.id);
    taskSchedulerModule.queueNextMonitoringPass(rootScanJob);

    pendingDownloads = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.DownloadMissing],
        10,
    );
    assert.equal(pendingDownloads.length, 1);
    assert.equal((pendingDownloads[0].payload as Record<string, unknown>).monitoringCycle, "full-cycle");
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), true);

    const midSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(midSnapshot);
    assert.equal(midSnapshot.lastQueuedAt, null);

    const downloadJob = pendingDownloads[0];
    queueModule.TaskQueueService.complete(downloadJob.id);
    taskSchedulerModule.queueNextMonitoringPass(downloadJob);

    const finalSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(finalSnapshot);
    assert.notEqual(finalSnapshot.lastQueuedAt, null);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), false);
});

test("only monitoring-tagged child jobs keep the monitoring cycle active", () => {
    const manualCurationJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.CurateArtist,
        {
            artistId: "1001",
            artistName: "Manual Artist",
            workflow: "curation",
        },
        "1001",
    );
    assert.ok(manualCurationJobId > 0);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), false);

    queueModule.TaskQueueService.clearCompleted();
    dbModule.db.prepare("DELETE FROM job_queue").run();

    const monitoringCurationJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.CurateArtist,
        {
            artistId: "1002",
            artistName: "Scheduled Artist",
            workflow: "monitoring-intake",
            monitoringCycle: "curation-cycle",
        },
        "1002",
    );
    assert.ok(monitoringCurationJobId > 0);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), true);
});
