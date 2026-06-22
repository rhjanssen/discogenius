import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-scheduler-hardening-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.scheduler-hardening.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue.js");
let schedulerModule: typeof import("./command-executor.js");
let healthModule: typeof import("./health.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue.js");
    healthModule = await import("./health.js");
    schedulerModule = await import("./command-executor.js");

    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM commands").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("DownloadMissingForce queues a missing-download pass without legacy skip flag maintenance", async () => {
    const jobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.DownloadMissingForce,
        {},
    );

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.CommandExecutor as any).processJob(job);

    const completed = queueModule.CommandQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");

    const queuedDownloadMissing = queueModule.CommandQueueService.getTopPendingJobsByTypes(
        [queueModule.CommandNames.DownloadMissing],
        10,
    );
    assert.equal(queuedDownloadMissing.length, 1);
});

test("RescanAllRoots delegates to queueRescanFoldersPass and queues a RescanFolders job", async () => {
    const jobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.RescanAllRoots,
        {},
    );

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.CommandExecutor as any).processJob(job);

    const completed = queueModule.CommandQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, "Queued library-wide folder rescan");

    const queuedRootScans = queueModule.CommandQueueService.getTopPendingJobsByTypes(
        [queueModule.CommandNames.RescanFolders],
        10,
    );
    assert.equal(queuedRootScans.length, 1);
});

test("CheckHealth collects a real diagnostics snapshot and reports issue counts", async () => {
    const expectedDescription = schedulerModule.formatHealthCheckDescription(
        healthModule.collectHealthDiagnosticsSnapshot(),
    );

    const jobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.CheckHealth,
        {},
    );

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.CommandExecutor as any).processJob(job);

    const completed = queueModule.CommandQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, expectedDescription);
});

test("BulkRefreshArtist delegates to queueMetadataRefreshPass and queues a RefreshMetadata job", async () => {
    dbModule.db.prepare(`
        INSERT INTO Artists (id, name, monitored)
        VALUES (?, ?, ?), (?, ?, ?)
    `).run(101, "Monitored Artist", 1, 202, "Ignored Artist", 0);

    const jobId = queueModule.CommandQueueService.addJob(
        queueModule.CommandNames.BulkRefreshArtist,
        {},
    );

    const job = queueModule.CommandQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.CommandExecutor as any).processJob(job);

    const completed = queueModule.CommandQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, "Queued metadata refresh for all monitored artists");

    const queuedRefreshJobs = queueModule.CommandQueueService.getTopPendingJobsByTypes(
        [queueModule.CommandNames.RefreshMetadata],
        10,
    );
    assert.equal(queuedRefreshJobs.length, 1);
});
