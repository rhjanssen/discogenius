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
let downloadQueueQueryModule: typeof import("./download-queue-query-service.js");

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("./queue.js");
    downloadQueueQueryModule = await import("./download-queue-query-service.js");
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

test("download queue query surfaces pending, processing, and history items with payload metadata", () => {
    const processingAlbumId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-1",
            tidalId: "provider-album-1",
            releaseGroupMbid: "release-group-1",
            slot: "stereo",
            title: "Processing Album",
            artist: "Queue Artist",
            cover: "processing-cover",
            quality: "HIRES_LOSSLESS",
            downloadState: { progress: 42, currentFileNum: 2, totalFiles: 5 },
        },
        "release-group-1:stereo",
    );
    const pendingAlbumId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-2",
            tidalId: "provider-album-2",
            releaseGroupMbid: "release-group-2",
            slot: "spatial",
            title: "Pending Album",
            artist: "Queue Artist",
            cover: "pending-cover",
            quality: "DOLBY_ATMOS",
        },
        "release-group-2:spatial",
    );
    const completedTrackId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadTrack,
        {
            type: "track",
            provider: "tidal",
            providerId: "provider-track-1",
            tidalId: "provider-track-1",
            title: "Completed Track",
            artist: "Queue Artist",
            cover: "track-cover",
            quality: "LOSSLESS",
        },
        "provider-track-1",
    );

    queueModule.TaskQueueService.markProcessing(processingAlbumId);
    queueModule.TaskQueueService.complete(completedTrackId);

    const live = downloadQueueQueryModule.DownloadQueueQueryService.getQueue({ limit: 10, offset: 0 });
    assert.equal(live.total, 2);
    assert.deepEqual(live.items.map((item) => item.id), [processingAlbumId, pendingAlbumId]);
    assert.equal(live.items[0]?.title, "Processing Album");
    assert.equal(live.items[0]?.progress, 42);
    assert.equal(live.items[0]?.currentFileNum, 2);
    assert.equal(live.items[0]?.totalFiles, 5);
    assert.equal(live.items[1]?.queuePosition, 1);
    assert.equal(live.items[1]?.quality, "DOLBY_ATMOS");

    const details = downloadQueueQueryModule.DownloadQueueQueryService.getQueueDetails({});
    assert.deepEqual(details.map((item) => item.id), [processingAlbumId, pendingAlbumId]);

    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });
    assert.equal(history.total, 1);
    assert.equal(history.items[0]?.id, completedTrackId);
    assert.equal(history.items[0]?.title, "Completed Track");
    assert.equal(history.items[0]?.type, "track");
});

test("download queue history collapses completed download and import jobs into one logical item", () => {
    const downloadJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-history",
            tidalId: "provider-album-history",
            releaseGroupMbid: "release-group-history",
            slot: "stereo",
            title: "Imported Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
        },
        "release-group-history:stereo",
    );
    queueModule.TaskQueueService.complete(downloadJobId);

    const importJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ImportDownload,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-history",
            tidalId: "provider-album-history",
            releaseGroupMbid: "release-group-history",
            slot: "stereo",
            title: "Imported Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
            path: path.join(tempDir, "download-provider-album-history"),
            originalJobId: downloadJobId,
        },
        "provider-album-history",
    );
    queueModule.TaskQueueService.complete(importJobId);

    const history = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(history.total, 1);
    assert.equal(history.items[0]?.id, importJobId);
    assert.equal(history.items[0]?.stage, "import");
    assert.equal(history.items[0]?.title, "Imported Album");
    assert.equal(history.items[0]?.type, "album");
});

test("download queue history keeps completed album visible during import handoff", () => {
    const downloadJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.DownloadAlbum,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-handoff",
            tidalId: "provider-album-handoff",
            releaseGroupMbid: "release-group-handoff",
            slot: "stereo",
            title: "Handoff Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
        },
        "release-group-handoff:stereo",
    );
    queueModule.TaskQueueService.complete(downloadJobId);

    const importJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ImportDownload,
        {
            type: "album",
            provider: "tidal",
            providerId: "provider-album-handoff",
            tidalId: "provider-album-handoff",
            releaseGroupMbid: "release-group-handoff",
            slot: "stereo",
            title: "Handoff Album",
            artist: "Queue Artist",
            cover: "album-cover",
            quality: "LOSSLESS",
            path: path.join(tempDir, "download-provider-album-handoff"),
            originalJobId: downloadJobId,
        },
        "provider-album-handoff",
    );
    queueModule.TaskQueueService.markProcessing(importJobId);

    const historyDuringImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(historyDuringImport.total, 1);
    assert.equal(historyDuringImport.items[0]?.id, downloadJobId);
    assert.equal(historyDuringImport.items[0]?.stage, "download");
    assert.equal(historyDuringImport.items[0]?.title, "Handoff Album");

    queueModule.TaskQueueService.complete(importJobId);

    const historyAfterImport = downloadQueueQueryModule.DownloadQueueQueryService.getQueueHistory({ limit: 10, offset: 0 });

    assert.equal(historyAfterImport.total, 1);
    assert.equal(historyAfterImport.items[0]?.id, importJobId);
    assert.equal(historyAfterImport.items[0]?.stage, "import");
    assert.equal(historyAfterImport.items[0]?.title, "Handoff Album");
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
