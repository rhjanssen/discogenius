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
