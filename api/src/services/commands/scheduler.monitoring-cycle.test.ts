import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-task-scheduler-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.task-scheduler.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue-manager.js");
let taskSchedulerModule: typeof import("./scheduler.js");
let taskStateModule: typeof import("./task-state.js");
let workflowModule: typeof import("../music/artist-workflow.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue-manager.js");
    taskSchedulerModule = await import("./scheduler.js");
    taskStateModule = await import("./task-state.js");
    workflowModule = await import("../music/artist-workflow.js");

    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM commands").run();
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

    const refreshJob = queueModule.CommandQueueManager.get(refreshJobId);
    assert.ok(refreshJob);
    queueModule.CommandQueueManager.complete(refreshJobId);
    taskSchedulerModule.queueNextMonitoringPass(refreshJob);

    const pendingRootScans = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.RescanFolders],
        10,
    );
    assert.equal(pendingRootScans.length, 1);
    assert.equal((pendingRootScans[0].payload as Record<string, unknown>).monitoringCycle, "full-cycle");
    assert.equal((pendingRootScans[0].payload as Record<string, unknown>).trackUnmappedFiles, false);

    let pendingDownloads = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.DownloadMissing],
        10,
    );
    assert.equal(pendingDownloads.length, 0);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), true);

    const rootScanJob = pendingRootScans[0];
    queueModule.CommandQueueManager.complete(rootScanJob.id);
    taskSchedulerModule.queueNextMonitoringPass(rootScanJob);

    pendingDownloads = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.DownloadMissing],
        10,
    );
    assert.equal(pendingDownloads.length, 1);
    assert.equal((pendingDownloads[0].payload as Record<string, unknown>).monitoringCycle, "full-cycle");
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), true);

    const midSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(midSnapshot);
    assert.equal(midSnapshot.lastQueuedAt, null);

    const downloadJob = pendingDownloads[0];
    queueModule.CommandQueueManager.complete(downloadJob.id);
    taskSchedulerModule.queueNextMonitoringPass(downloadJob);

    const finalSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(finalSnapshot);
    assert.notEqual(finalSnapshot.lastQueuedAt, null);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), false);
});

function completeAndAdvance(commandId: number) {
    const job = queueModule.CommandQueueManager.get(commandId);
    assert.ok(job);
    queueModule.CommandQueueManager.complete(commandId);
    taskSchedulerModule.queueNextMonitoringPass(job);
    return job;
}

function pendingDownloadMissing() {
    return queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.DownloadMissing],
        10,
    );
}

test("standalone monitored artist workflows do not queue DownloadMissing", () => {
    const workflows = ["monitoring-intake", "full-monitoring"] as const;

    for (const [index, workflow] of workflows.entries()) {
        const artistId = String(2001 + index);
        const curateId = queueModule.CommandQueueManager.push(
            queueModule.CommandNames.CurateArtist,
            { artistId, artistName: `Standalone ${workflow}`, workflow },
            artistId,
        );
        assert.ok(curateId > 0);

        completeAndAdvance(curateId);
        assert.equal(pendingDownloadMissing().length, 0, `${workflow} should wait for an explicit monitoring cycle`);
    }
});

test("manual (non-monitoring) curation does not trigger downloads", () => {
    const curateId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.CurateArtist,
        { artistId: "4001", artistName: "Manual", workflow: "curation" },
        "4001",
    );
    completeAndAdvance(curateId);
    assert.equal(pendingDownloadMissing().length, 0);
});

test("scheduled cycle defers its terminal DownloadMissing while artist intake is active", () => {
    // An intake RefreshArtist is in flight (pending), with no monitoringCycle tag.
    const intakeRefreshId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        workflowModule.buildRefreshArtistCommand({ artistId: "5002", artistName: "Intake", workflow: "monitoring-intake" }),
        "5002",
    );
    assert.ok(intakeRefreshId > 0);

    // The scheduled cycle's library rescan (full-cycle) completes.
    const rootScanId = taskSchedulerModule.queueRescanFoldersPass({
        trigger: 2,
        fullProcessing: true,
        trackUnmappedFiles: false,
        monitoringCycle: "full-cycle",
        addNewArtists: false,
    });
    assert.ok(rootScanId > 0);
    completeAndAdvance(rootScanId);

    // DownloadMissing must NOT be queued yet — intake is still running.
    assert.equal(pendingDownloadMissing().length, 0);
});

test("only monitoring-tagged child jobs keep the monitoring cycle active", () => {
    const manualCurationJobId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.CurateArtist,
        {
            artistId: "1001",
            artistName: "Manual Artist",
            workflow: "curation",
        },
        "1001",
    );
    assert.ok(manualCurationJobId > 0);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), false);

    queueModule.CommandQueueManager.clearCompleted();
    dbModule.db.prepare("DELETE FROM commands").run();

    const monitoringCurationJobId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.CurateArtist,
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
