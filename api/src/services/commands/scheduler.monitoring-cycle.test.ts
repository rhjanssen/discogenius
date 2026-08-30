import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

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
    dbModule.db.prepare("DELETE FROM LibraryArtists").run();
    dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedMonitoredArtist(mbid = "artist-mbid-1", name = "Artist One") {
    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(mbid, name);
    seedLibraryArtistMonitoring(dbModule.db, mbid);
    return mbid;
}

test("monitoring cycle is independent from the daily root scan and stamps after downloads", () => {
    const initialSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(initialSnapshot);
    assert.equal(initialSnapshot.lastQueuedAt, null);

    seedMonitoredArtist();

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
    assert.equal(pendingRootScans.length, 0);

    const pendingDownloads = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
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

test("health checks and database backups have recurring schedules and poll only once while active", () => {
    const initialSnapshots = taskSchedulerModule.getScheduledTaskSnapshots();
    const health = initialSnapshots.find((task) => task.key === "health-check");
    const backup = initialSnapshots.find((task) => task.key === "backup-database");
    assert.equal(health?.intervalMinutes, 360);
    assert.equal(backup?.intervalMinutes, 10_080);
    assert.equal(health?.taskName, queueModule.CommandNames.CheckHealth);
    assert.equal(backup?.taskName, queueModule.CommandNames.BackupDatabase);

    // Keep unrelated tasks out of this poll and make only the two maintenance
    // tasks overdue.
    dbModule.db.prepare("UPDATE scheduled_tasks SET last_queued_at = CURRENT_TIMESTAMP").run();
    dbModule.db.prepare(`
        UPDATE scheduled_tasks
        SET last_queued_at = '2000-01-01 00:00:00'
        WHERE task_key IN ('health-check', 'backup-database')
    `).run();

    taskSchedulerModule.pollScheduledTasks();

    const healthJobs = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.CheckHealth],
        10,
    );
    const backupJobs = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.BackupDatabase],
        10,
    );
    assert.equal(healthJobs.length, 1);
    assert.equal(backupJobs.length, 1);
    assert.equal(healthJobs[0]?.trigger, 2);
    assert.equal(backupJobs[0]?.trigger, 2);

    const activeSnapshots = taskSchedulerModule.getScheduledTaskSnapshots();
    assert.equal(activeSnapshots.find((task) => task.key === "health-check")?.active, true);
    assert.equal(activeSnapshots.find((task) => task.key === "backup-database")?.active, true);
    assert.notEqual(activeSnapshots.find((task) => task.key === "health-check")?.lastQueuedAt, null);
    assert.notEqual(activeSnapshots.find((task) => task.key === "backup-database")?.lastQueuedAt, null);

    taskSchedulerModule.pollScheduledTasks();
    assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.CheckHealth],
        10,
    ).length, 1);
    assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.BackupDatabase],
        10,
    ).length, 1);
});

test("poll repairs a future last_queued_at by queueing once against the current clock", () => {
    taskSchedulerModule.getScheduledTaskSnapshots();
    dbModule.db.prepare("UPDATE scheduled_tasks SET last_queued_at = CURRENT_TIMESTAMP").run();
    dbModule.db.prepare(`
        UPDATE scheduled_tasks
        SET last_queued_at = '2099-01-01 00:00:00'
        WHERE task_key = 'health-check'
    `).run();

    taskSchedulerModule.pollScheduledTasks();

    const healthJobs = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.CheckHealth],
        10,
    );
    assert.equal(healthJobs.length, 1);

    const repaired = dbModule.db.prepare(`
        SELECT last_queued_at
        FROM scheduled_tasks
        WHERE task_key = 'health-check'
    `).get() as { last_queued_at: string };
    assert.notEqual(repaired.last_queued_at, "2099-01-01 00:00:00");
    assert.ok(
        taskSchedulerModule.getScheduledTaskSnapshots()
            .find((task) => task.key === "health-check")
            ?.lastQueuedAt !== "2099-01-01 00:00:00",
    );

    taskSchedulerModule.pollScheduledTasks();
    assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.CheckHealth],
        10,
    ).length, 1);
});

test("config-prune callers can defer a distinct artwork reconciliation behind refresh workflows", () => {
    const commandId = taskSchedulerModule.queueConfigPrune({
        trigger: 1,
        priority: -100,
        refId: "artwork-preference-backfill:42",
        refreshArtworkPreference: true,
    });

    const command = queueModule.CommandQueueManager.get(commandId);
    assert.ok(command);
    assert.equal(command.name, queueModule.CommandNames.ConfigPrune);
    assert.equal(command.ref_id, "artwork-preference-backfill:42");
    assert.equal(command.priority, -100);
    assert.equal(command.trigger, 1);
    assert.equal(
        (command.payload as Record<string, unknown>).refreshArtworkPreference,
        true,
    );
});

test("scheduled monitoring cycle with no due artists still runs the terminal download pass", () => {
    const refreshJobId = taskSchedulerModule.queueMonitoringCyclePass({ trigger: 2, includeRootScan: true });
    assert.ok(refreshJobId > 0);

    const refreshJob = queueModule.CommandQueueManager.get(refreshJobId);
    assert.ok(refreshJob);
    assert.equal((refreshJob.payload as Record<string, unknown>).expectedArtists, 0);
    queueModule.CommandQueueManager.complete(refreshJobId);
    taskSchedulerModule.queueNextMonitoringPass(refreshJob);

    // No metadata refresh is due, but the cycle must STILL run its terminal
    // DownloadMissing pass — monitored albums can become downloadable without any
    // artist being due (mirrors Lidarr always rescanning after the refresh loop).
    // The independent daily RescanFolders task is not queued here.
    const pendingRootScans = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.RescanFolders],
        10,
    );
    assert.equal(pendingRootScans.length, 0);

    const pendingDownloads = queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.DownloadMissing],
        10,
    );
    assert.equal(pendingDownloads.length, 1);
    assert.equal((pendingDownloads[0].payload as Record<string, unknown>).monitoringCycle, "full-cycle");
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), true);

    // The cycle is only stamped complete once the terminal download pass finishes.
    const midSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(midSnapshot);
    assert.equal(midSnapshot.lastQueuedAt, null);

    queueModule.CommandQueueManager.complete(pendingDownloads[0].id);
    taskSchedulerModule.queueNextMonitoringPass(pendingDownloads[0]);

    const finalSnapshot = taskSchedulerModule.getScheduledTaskSnapshots().find((task) => task.key === "monitoring-cycle");
    assert.ok(finalSnapshot);
    assert.notEqual(finalSnapshot.lastQueuedAt, null);
    assert.equal(taskStateModule.hasActiveMonitoringCycleWorkflow(), false);
});

test("scheduled monitoring excludes due artists already in an intake workflow", () => {
    seedMonitoredArtist();
    const intakeRefreshId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        workflowModule.buildRefreshArtistCommand({
            artistId: "artist-mbid-1",
            artistName: "Artist One",
            workflow: "monitoring-intake",
        }),
        "artist-mbid-1",
    );
    assert.ok(intakeRefreshId > 0);

    const refreshJobId = taskSchedulerModule.queueMonitoringCyclePass({ trigger: 2, includeRootScan: true });
    assert.ok(refreshJobId > 0);
    const refreshJob = queueModule.CommandQueueManager.get(refreshJobId);
    assert.ok(refreshJob);
    assert.equal((refreshJob.payload as Record<string, unknown>).expectedArtists, 0);

    queueModule.CommandQueueManager.complete(refreshJobId);
    taskSchedulerModule.queueNextMonitoringPass(refreshJob);

    assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
        [queueModule.CommandNames.RescanFolders],
        10,
    ).length, 0);
    assert.equal(pendingDownloadMissing().length, 0);
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

test("queueNextMonitoringPass ignores untagged CurateArtist", () => {
    // Cycle chaining only applies to monitoringCycle-tagged jobs. The
    // ARTIST_CURATED listener owns the scoped wanted check for monitored intake.
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
        assert.equal(pendingDownloadMissing().length, 0, `${workflow} should not chain via monitoring-cycle scheduler`);
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

test("credited hydration completion re-evaluates and queues one deferred terminal DownloadMissing", () => {
    const creditedOneId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        workflowModule.buildRefreshArtistCommand({
            artistId: "credited-1",
            artistName: "Credited One",
            workflow: "metadata-refresh",
        }),
        "credited-1",
        -10,
    );
    const creditedTwoId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        workflowModule.buildRefreshArtistCommand({
            artistId: "credited-2",
            artistName: "Credited Two",
            workflow: "metadata-refresh",
        }),
        "credited-2",
        -10,
    );
    assert.ok(creditedOneId > 0);
    assert.ok(creditedTwoId > 0);

    const cycleId = taskSchedulerModule.queueMonitoringCyclePass({
        trigger: 2,
        includeRootScan: true,
    });
    assert.ok(cycleId > 0);
    completeAndAdvance(cycleId);
    assert.equal(pendingDownloadMissing().length, 0);

    completeAndAdvance(creditedOneId);
    assert.equal(pendingDownloadMissing().length, 0);

    const lastCredited = completeAndAdvance(creditedTwoId);
    const terminal = pendingDownloadMissing();
    assert.equal(terminal.length, 1);
    assert.equal(
        (terminal[0].payload as Record<string, unknown>).monitoringCycle,
        "full-cycle",
    );
    assert.equal(terminal[0].trigger, 2);

    // Replayed completion hooks and scheduler ticks must reconcile from the
    // same durable command history without duplicating the terminal pass.
    taskSchedulerModule.queueNextMonitoringPass(lastCredited);
    taskSchedulerModule.pollScheduledTasks();
    assert.equal(pendingDownloadMissing().length, 1);
});

test("scheduler tick recovers a deferred terminal pass after the draining completion hook was missed", () => {
    const creditedId = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RefreshArtist,
        workflowModule.buildRefreshArtistCommand({
            artistId: "credited-restart",
            artistName: "Credited Restart",
            workflow: "metadata-refresh",
        }),
        "credited-restart",
        -10,
    );
    const cycleId = taskSchedulerModule.queueMonitoringCyclePass({
        trigger: 2,
        includeRootScan: true,
    });
    assert.ok(creditedId > 0);
    assert.ok(cycleId > 0);

    completeAndAdvance(cycleId);
    assert.equal(pendingDownloadMissing().length, 0);

    // Model a process stop after persisting completion but before invoking the
    // in-process completion hook.
    assert.equal(queueModule.CommandQueueManager.complete(creditedId), true);
    assert.equal(pendingDownloadMissing().length, 0);

    taskSchedulerModule.pollScheduledTasks();
    assert.equal(pendingDownloadMissing().length, 1);
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
