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

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("./queue.js");
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

test("RescanAllRoots completes with clear description when root_folders table is unavailable", async () => {
    const rootFoldersTable = dbModule.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'root_folders'")
        .get() as { name?: string } | undefined;
    assert.equal(Boolean(rootFoldersTable?.name), false);

    const jobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.RescanAllRoots,
        {},
    );

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);

    await (schedulerModule.Scheduler as any).processJob(job);

    const completed = queueModule.TaskQueueService.getById(jobId);
    assert.equal(completed?.status, "completed");
    assert.equal((completed?.payload as Record<string, unknown>)?.description, "Root folders table unavailable; queued scan for 0 root folder(s)");

    const queuedRootScans = queueModule.TaskQueueService.getTopPendingJobsByTypes(
        [queueModule.JobTypes.RescanFolders],
        10,
    );
    assert.equal(queuedRootScans.length, 0);
});
