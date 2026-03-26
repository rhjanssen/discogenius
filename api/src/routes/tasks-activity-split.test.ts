import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-route-split-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.route-split.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("../services/queue.js");
let historyEventsModule: typeof import("../services/history-events.js");
let tasksRouter: typeof import("./queue.js").default;
let activityRouter: typeof import("./activity.js").default;
let statusRouter: typeof import("./status.js").default;

before(async () => {
    dbModule = await import("../database.js");
    queueModule = await import("../services/queue.js");
    historyEventsModule = await import("../services/history-events.js");
    tasksRouter = (await import("./queue.js")).default;
    activityRouter = (await import("./activity.js")).default;
    statusRouter = (await import("./status.js")).default;
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM job_queue").run();
    dbModule.db.prepare("DELETE FROM history_events").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

type MockResponse = {
    statusCode: number;
    body: unknown;
    status: (code: number) => MockResponse;
    json: (payload: unknown) => MockResponse;
};

function createMockResponse(): MockResponse {
    return {
        statusCode: 200,
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
    };
}

function getGetHandler(router: any, pathName: string): (req: any, res: any) => void {
    const layer = router.stack.find((entry: any) => entry.route?.path === pathName && entry.route?.methods?.get);
    assert.ok(layer, `Expected GET handler for path ${pathName}`);
    return layer.route.stack[0].handle;
}

test("/api/tasks defaults to pending+processing+completed+failed+cancelled and supports explicit status override", () => {
    const pendingId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.ScanPlaylist, { tidalId: "playlist-pending" }, "playlist-pending");
    const processingId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshMetadata, { target: "library" });
    const completedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.HealthCheck, {});
    const failedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAllMonitored, {});
    const cancelledId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RescanAllRoots, {});

    queueModule.TaskQueueService.markProcessing(processingId);
    queueModule.TaskQueueService.complete(completedId);
    queueModule.TaskQueueService.fail(failedId, "test failure");
    queueModule.TaskQueueService.cancel(cancelledId);

    const tasksHandler = getGetHandler(tasksRouter as any, "/");

    const defaultRes = createMockResponse();
    tasksHandler({ query: {} }, defaultRes);

    assert.equal(defaultRes.statusCode, 200);
    const defaultBody = defaultRes.body as { items: Array<{ id: number; status: string }>; total: number };
    assert.equal(defaultBody.total, 5);
    assert.deepEqual(
        defaultBody.items.map((item) => item.id).sort((a, b) => a - b),
        [pendingId, processingId, completedId, failedId, cancelledId].sort((a, b) => a - b),
    );
    assert.deepEqual(
        [...new Set(defaultBody.items.map((item) => item.status))].sort(),
        ["cancelled", "completed", "failed", "pending", "running"],
    );
    for (const item of defaultBody.items) {
        assert.equal(typeof (item as any).description, "string");
        assert.ok(((item as any).description as string).length > 0);
        assert.equal(typeof (item as any).startTime, "number");
    }

    const completedRes = createMockResponse();
    tasksHandler({ query: { status: "completed" } }, completedRes);

    assert.equal(completedRes.statusCode, 200);
    const completedBody = completedRes.body as { items: Array<{ id: number; status: string }>; total: number };
    assert.equal(completedBody.total, 1);
    assert.equal(completedBody.items[0]?.id, completedId);
    assert.equal(completedBody.items[0]?.status, "completed");
    assert.equal(typeof (completedBody.items[0] as any)?.description, "string");
    assert.equal(typeof (completedBody.items[0] as any)?.startTime, "number");
});

test("/api/tasks rejects unsupported filters", () => {
    queueModule.TaskQueueService.addJob(queueModule.JobTypes.ScanPlaylist, { tidalId: "playlist-pending" }, "playlist-pending");

    const tasksHandler = getGetHandler(tasksRouter as any, "/");

    const invalidStatusRes = createMockResponse();
    tasksHandler({ query: { status: "not-a-status" } }, invalidStatusRes);
    assert.equal(invalidStatusRes.statusCode, 400);

    const invalidCategoryRes = createMockResponse();
    tasksHandler({ query: { category: "downloads" } }, invalidCategoryRes);
    assert.equal(invalidCategoryRes.statusCode, 400);

    const invalidTypeRes = createMockResponse();
    tasksHandler({ query: { type: "DownloadTrack" } }, invalidTypeRes);
    assert.equal(invalidTypeRes.statusCode, 400);

    const categoryTypeMismatchRes = createMockResponse();
    tasksHandler({ query: { category: "scans", type: "HealthCheck" } }, categoryTypeMismatchRes);
    assert.equal(categoryTypeMismatchRes.statusCode, 400);
});

test("/api/activity defaults to completed+failed+cancelled and supports explicit status override", () => {
    const pendingId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.ApplyCuration, { expectedArtists: 1 });
    const completedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.HealthCheck, {});
    const failedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.RefreshAllMonitored, {});
    const cancelledId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.ConfigPrune, {});

    queueModule.TaskQueueService.complete(completedId);
    queueModule.TaskQueueService.fail(failedId, "test failure");
    queueModule.TaskQueueService.cancel(cancelledId);

    const activityHandler = getGetHandler(activityRouter as any, "/");

    const defaultRes = createMockResponse();
    activityHandler({ query: {} }, defaultRes);

    assert.equal(defaultRes.statusCode, 200);
    const defaultBody = defaultRes.body as { items: Array<{ id: number; status: string }>; total: number };
    assert.equal(defaultBody.total, 3);
    assert.deepEqual(
        defaultBody.items.map((item) => item.id).sort((a, b) => a - b),
        [completedId, failedId, cancelledId].sort((a, b) => a - b),
    );
    assert.deepEqual(
        [...new Set(defaultBody.items.map((item) => item.status))].sort(),
        ["cancelled", "completed", "failed"],
    );

    const pendingRes = createMockResponse();
    activityHandler({ query: { status: "pending" } }, pendingRes);

    assert.equal(pendingRes.statusCode, 200);
    const pendingBody = pendingRes.body as { items: Array<{ id: number; status: string }>; total: number };
    assert.equal(pendingBody.total, 1);
    assert.equal(pendingBody.items[0]?.id, pendingId);
    assert.equal(pendingBody.items[0]?.status, "pending");

    const runningAliasRes = createMockResponse();
    activityHandler({ query: { status: "running" } }, runningAliasRes);
    assert.equal(runningAliasRes.statusCode, 200);
});

test("/api/status no longer exposes deprecated /history route", () => {
    const hasHistoryRoute = (statusRouter as any).stack.some((entry: any) => entry.route?.path === "/history");
    assert.equal(hasHistoryRoute, false);
});


test("/api/activity rejects unsupported filters", () => {
    const activityHandler = getGetHandler(activityRouter as any, "/");

    const invalidStatusRes = createMockResponse();
    activityHandler({ query: { status: "not-a-status" } }, invalidStatusRes);
    assert.equal(invalidStatusRes.statusCode, 400);

    const invalidCategoryRes = createMockResponse();
    activityHandler({ query: { category: "nope" } }, invalidCategoryRes);
    assert.equal(invalidCategoryRes.statusCode, 400);

    const invalidTypeRes = createMockResponse();
    activityHandler({ query: { category: "scans", type: "DownloadTrack" } }, invalidTypeRes);
    assert.equal(invalidTypeRes.statusCode, 400);
});

test("/api/activity/events returns merged event log sorted newest-first with pagination metadata", () => {
    const pendingId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.ScanPlaylist, { tidalId: "playlist-events" }, "playlist-events");
    const failedId = queueModule.TaskQueueService.addJob(queueModule.JobTypes.HealthCheck, {});
    queueModule.TaskQueueService.fail(failedId, "health failed");

    const historyInfoId = historyEventsModule.recordHistoryEvent({
        eventType: historyEventsModule.HISTORY_EVENT_TYPES.TrackFileImported,
        sourceTitle: "Imported Track",
    });
    const historyErrorId = historyEventsModule.recordHistoryEvent({
        eventType: historyEventsModule.HISTORY_EVENT_TYPES.DownloadFailed,
        sourceTitle: "Failed Download",
    });

    dbModule.db.prepare("UPDATE job_queue SET created_at = ? WHERE id = ?").run("2024-01-01 10:00:00", pendingId);
    dbModule.db.prepare("UPDATE job_queue SET created_at = ?, started_at = ?, completed_at = ? WHERE id = ?")
        .run("2024-01-02 10:00:00", "2024-01-02 10:05:00", "2024-01-02 10:10:00", failedId);
    dbModule.db.prepare("UPDATE history_events SET date = ? WHERE id = ?").run("2024-01-03 12:00:00", historyInfoId);
    dbModule.db.prepare("UPDATE history_events SET date = ? WHERE id = ?").run("2024-01-04 12:00:00", historyErrorId);

    const eventsHandler = getGetHandler(activityRouter as any, "/events");

    const pageOneRes = createMockResponse();
    eventsHandler({ query: { limit: "2", offset: "0" } }, pageOneRes);

    assert.equal(pageOneRes.statusCode, 200);
    const pageOneBody = pageOneRes.body as {
        items: Array<{
            id: string;
            time: number;
            level: string;
            component: string;
            message: string;
            source: string;
        }>;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
    };

    assert.equal(pageOneBody.total, 4);
    assert.equal(pageOneBody.limit, 2);
    assert.equal(pageOneBody.offset, 0);
    assert.equal(pageOneBody.hasMore, true);
    assert.equal(pageOneBody.items.length, 2);
    assert.deepEqual(pageOneBody.items.map((item) => item.id), [
        `history:${historyErrorId}`,
        `history:${historyInfoId}`,
    ]);

    for (const item of pageOneBody.items) {
        assert.equal(typeof item.id, "string");
        assert.equal(typeof item.time, "number");
        assert.ok(item.time > 0);
        assert.ok(["info", "warning", "error"].includes(item.level));
        assert.equal(typeof item.component, "string");
        assert.ok(item.component.length > 0);
        assert.equal(typeof item.message, "string");
        assert.ok(item.message.length > 0);
        assert.ok(["task", "history"].includes(item.source));
    }

    const pageTwoRes = createMockResponse();
    eventsHandler({ query: { limit: "2", offset: "2" } }, pageTwoRes);
    assert.equal(pageTwoRes.statusCode, 200);

    const pageTwoBody = pageTwoRes.body as {
        items: Array<{ id: string; source: string; level: string }>;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
    };
    assert.equal(pageTwoBody.total, 4);
    assert.equal(pageTwoBody.limit, 2);
    assert.equal(pageTwoBody.offset, 2);
    assert.equal(pageTwoBody.hasMore, false);
    assert.deepEqual(pageTwoBody.items.map((item) => item.id), [
        `task:${failedId}`,
        `task:${pendingId}`,
    ]);
    assert.equal(pageTwoBody.items[0]?.source, "task");
    assert.equal(pageTwoBody.items[0]?.level, "error");
    assert.equal(pageTwoBody.items[1]?.source, "task");
    assert.equal(pageTwoBody.items[1]?.level, "info");
});

test("/api/status no longer exposes deprecated /tasks route", () => {
    const hasTasksRoute = (statusRouter as any).stack.some((entry: any) => entry.route?.path === "/tasks");
    assert.equal(hasTasksRoute, false);
});
