import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-scheduler-hardening-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.scheduler-hardening.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("./queue.js");
let schedulerModule: typeof import("./scheduler.js");
let healthModule: typeof import("./health.js");

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("./queue.js");
    healthModule = await import("./health.js");
    schedulerModule = await import("./scheduler.js");

    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM job_queue").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("DownloadMissingForce skips legacy flag reset when skip_download/skip_upgrade columns are absent", async () => {
    const mediaColumns = dbModule.db.prepare("PRAGMA table_info(media)").all() as Array<{ name: string }>;
    const mediaColumnNames = new Set(mediaColumns.map((column) => column.name));
    assert.equal(mediaColumnNames.has("skip_download"), false);
    assert.equal(mediaColumnNames.has("skip_upgrade"), false);

    const jobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadMissingForce,
        { skipFlags: true },
    );

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.Scheduler as any).processJob(job);

    const completed = queueModule.TaskQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");

    const queuedDownloadMissing = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.DownloadMissing],
        10,
    );
    assert.equal(queuedDownloadMissing.length, 1);
});

test("RescanAllRoots delegates to queueRescanFoldersPass and queues a RescanFolders job", async () => {
    const jobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.RescanAllRoots,
        {},
    );

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.Scheduler as any).processJob(job);

    const completed = queueModule.TaskQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, "Queued library-wide folder rescan");

    const queuedRootScans = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.RescanFolders],
        10,
    );
    assert.equal(queuedRootScans.length, 1);
});

test("HealthCheck collects a real diagnostics snapshot and reports issue counts", async () => {
    const expectedDescription = schedulerModule.formatHealthCheckDescription(
        healthModule.collectHealthDiagnosticsSnapshot(),
    );

    const jobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.HealthCheck,
        {},
    );

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.Scheduler as any).processJob(job);

    const completed = queueModule.TaskQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, expectedDescription);
});

test("RefreshAllMonitored delegates to queueMetadataRefreshPass and queues a RefreshMetadata job", async () => {
    dbModule.db.prepare(`
        INSERT INTO artists (id, name, monitor)
        VALUES (?, ?, ?), (?, ?, ?)
    `).run(101, "Monitored Artist", 1, 202, "Ignored Artist", 0);

    const jobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.RefreshAllMonitored,
        {},
    );

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.Scheduler as any).processJob(job);

    const completed = queueModule.TaskQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, "Queued metadata refresh for all monitored artists");

    const queuedRefreshJobs = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.RefreshMetadata],
        10,
    );
    assert.equal(queuedRefreshJobs.length, 1);
});
