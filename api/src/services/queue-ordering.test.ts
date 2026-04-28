import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-queue-order-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.queue-order.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("./queue.js");

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("./queue.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM job_queue").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function queuePendingDownload(type: "track" | "video" | "album", tidalId: string) {
    const jobType = type === "video"
        ? queueModule.JobTypes.DownloadVideo
        : type === "album"
            ? queueModule.JobTypes.DownloadAlbum
            : queueModule.JobTypes.DownloadTrack;

    return queueModule.TaskQueueService.addJob(
        jobType,
        { tidalId, type, url: `https://listen.tidal.com/${type}/${tidalId}` },
        tidalId,
    );
}

test("reorderPendingJobs preserves explicit move order deterministically", () => {
    const first = queuePendingDownload("track", "1");
    const second = queuePendingDownload("track", "2");
    const third = queuePendingDownload("track", "3");

    const changed = queueModule.TaskQueueService.reorderPendingJobs([third, first], {
        beforeJobId: second,
        types: queueModule.DOWNLOAD_JOB_TYPES,
    });
    assert.equal(changed, 3);

    const pending = queueModule.TaskQueueService.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_JOB_TYPES,
        ["pending"],
        10,
        0,
        { orderBy: "execution" },
    );

    assert.deepEqual(
        pending.map((job) => job.id),
        [third, first, second],
    );
});

test("reorderPendingJobs rejects invalid reorder sets", () => {
    const first = queuePendingDownload("track", "11");
    const second = queuePendingDownload("track", "12");

    assert.throws(
        () => queueModule.TaskQueueService.reorderPendingJobs([first, first], { beforeJobId: second }),
        /duplicate queue item ids/i,
    );

    const completed = queuePendingDownload("track", "13");
    queueModule.TaskQueueService.complete(completed);

    assert.throws(
        () => queueModule.TaskQueueService.reorderPendingJobs([completed], { beforeJobId: second }),
        /Only pending download queue items can be reordered/i,
    );

    assert.throws(
        () => queueModule.TaskQueueService.reorderPendingJobs([first], { beforeJobId: first }),
        /anchor must be a different pending queue item/i,
    );

    assert.throws(
        () => queueModule.TaskQueueService.reorderPendingJobs([first], {}),
        /requires exactly one anchor/i,
    );
});

test("import jobs inherit durable queue order and live queue listing stays stable across transitions", () => {
    const first = queuePendingDownload("track", "21");
    const second = queuePendingDownload("track", "22");
    const third = queuePendingDownload("track", "23");

    queueModule.TaskQueueService.markProcessing(first);
    queueModule.TaskQueueService.markProcessing(second);

    const originalJob = queueModule.TaskQueueService.getById(first);
    const secondJob = queueModule.TaskQueueService.getById(second);
    const thirdJob = queueModule.TaskQueueService.getById(third);
    assert.ok(originalJob);
    assert.ok(secondJob);
    assert.ok(thirdJob);

    const importJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ImportDownload,
        {
            type: "track",
            tidalId: "21",
            path: "E:/tmp/downloads/job_21",
            originalJobId: first,
        },
        "21",
        100,
        0,
        originalJob?.queue_order,
    );

    queueModule.TaskQueueService.complete(first);

    const importJob = queueModule.TaskQueueService.getById(importJobId);
    assert.ok(importJob);
    assert.equal(importJob?.queue_order, originalJob?.queue_order);

    const liveJobs = queueModule.TaskQueueService.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_OR_IMPORT_JOB_TYPES,
        ["pending", "processing"],
        10,
        0,
        { orderBy: "queue_order" },
    );

    assert.deepEqual(
        liveJobs.map((job) => ({ id: job.id, type: job.type, status: job.status, queueOrder: job.queue_order })),
        [
            {
                id: importJobId,
                type: queueModule.JobTypes.ImportDownload,
                status: "pending",
                queueOrder: originalJob?.queue_order,
            },
            {
                id: second,
                type: queueModule.JobTypes.DownloadTrack,
                status: "processing",
                queueOrder: secondJob?.queue_order,
            },
            {
                id: third,
                type: queueModule.JobTypes.DownloadTrack,
                status: "pending",
                queueOrder: thirdJob?.queue_order,
            },
        ],
    );
});

test("terminal queue jobs ignore late progress, state, complete, and fail updates", () => {
    const jobId = queuePendingDownload("track", "99");
    queueModule.TaskQueueService.markProcessing(jobId);
    queueModule.TaskQueueService.updateState(jobId, {
        progress: 45,
        payloadPatch: { downloadState: { state: "downloading", statusMessage: "Downloading track" } },
    });
    queueModule.TaskQueueService.cancel(jobId);

    queueModule.TaskQueueService.updateProgress(jobId, 88);
    queueModule.TaskQueueService.updateState(jobId, {
        progress: 90,
        payloadPatch: { downloadState: { state: "importing", statusMessage: "Late import state" } },
    });
    queueModule.TaskQueueService.complete(jobId);
    queueModule.TaskQueueService.fail(jobId, "Late failure");

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);
    assert.equal(job.status, "cancelled");
    assert.equal(job.progress, 45);
    assert.equal(job.error ?? null, null);
    assert.equal(job.payload.downloadState?.state, "downloading");
    assert.equal(job.payload.downloadState?.statusMessage, "Downloading track");
});

test("terminal queue jobs cannot be resurrected as processing", () => {
    const jobId = queuePendingDownload("track", "100");
    queueModule.TaskQueueService.cancel(jobId);

    const marked = queueModule.TaskQueueService.markProcessing(jobId);

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.equal(marked, false);
    assert.ok(job);
    assert.equal(job.status, "cancelled");
});

test("manual retry resets attempts so max-attempt jobs can run again", () => {
    const jobId = queuePendingDownload("track", "101");

    queueModule.TaskQueueService.fail(jobId, "first failure");
    queueModule.TaskQueueService.retry(jobId);

    const job = queueModule.TaskQueueService.getById(jobId);
    assert.ok(job);
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
    assert.equal(job.progress, 0);
    assert.equal(job.error ?? null, null);
});

test("active import blocks duplicate download for the same content id", () => {
    const importJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ImportDownload,
        {
            type: "track",
            tidalId: "102",
            path: path.join(tempDir, "download-102"),
            originalJobId: 1,
        },
        "102",
    );

    const duplicateDownloadId = queuePendingDownload("track", "102");
    const pendingDownloads = queueModule.TaskQueueService.listJobsByTypesAndStatuses(
        queueModule.DOWNLOAD_JOB_TYPES,
        ["pending", "processing"],
    );

    assert.equal(duplicateDownloadId, importJobId);
    assert.equal(pendingDownloads.length, 0);
});
