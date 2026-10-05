import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("root-scan-schedule");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let scheduler: typeof import("./scheduler.js");
let schedule: typeof import("./root-scan-schedule.js");
before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    scheduler = await import("./scheduler.js");
    schedule = await import("./root-scan-schedule.js");
});
beforeEach(() => {
    database.db.prepare("DELETE FROM commands").run();
    database.db.prepare("DELETE FROM runtime_controls").run();
    database.db.prepare("DELETE FROM scheduled_tasks").run();
});
after(() => closeActiveSchemaDb(database.dbModule, tempDir));

test("a long root scan schedules its next pass from completion and survives history pruning", () => {
    scheduler.getScheduledTaskSnapshots();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    database.db.prepare("UPDATE scheduled_tasks SET last_queued_at=? WHERE task_key='root-scan'").run(old);
    const id = queue.CommandQueueManager.push(queue.CommandNames.RescanFolders, {});
    const job = queue.CommandQueueManager.claimForExecution(id, "schedule-test", 60_000)!;
    assert.equal(queue.CommandQueueManager.complete(id, job.worker_id!), true);
    const completed = queue.CommandQueueManager.get(id)!.completed_at!;
    assert.equal(schedule.rootScanScheduleAnchor(old), completed);
    const snapshot = scheduler.getScheduledTaskSnapshots().find(row => row.key === "root-scan")!;
    assert.equal(snapshot.lastQueuedAt, old, "queue time keeps its original meaning");
    assert.equal(Date.parse(snapshot.nextRunAt!), Date.parse(completed.replace(" ", "T") + "Z") + 24 * 60 * 60 * 1000);
    queue.CommandQueueManager.cleanCommands("RescanFolders");
    scheduler.pollScheduledTasks();
    assert.equal(queue.CommandQueueManager.getTopPendingJobsByTypes([queue.CommandNames.RescanFolders], 10).length, 0);
    database.dbModule.closeDatabase(); database.dbModule.initDatabase();
    assert.equal(schedule.rootScanScheduleAnchor(old), completed);
});

test("scoped scans, failed scans and stale completion claims do not reset the root schedule", () => {
    const scoped = queue.CommandQueueManager.push(queue.CommandNames.RescanFolders, { artistIds: ["bastille"] });
    const job = queue.CommandQueueManager.claimForExecution(scoped, "scope-test", 60_000)!;
    assert.equal(queue.CommandQueueManager.complete(scoped, "wrong-owner"), false);
    assert.equal(queue.CommandQueueManager.complete(scoped, job.worker_id!), true);
    const failed = queue.CommandQueueManager.push(queue.CommandNames.RescanFolders, {});
    queue.CommandQueueManager.fail(failed, "Root unavailable");
    assert.equal(schedule.rootScanScheduleAnchor(null), null);
});

test("failure to persist the completion timestamp rolls back command completion", () => {
    const id = queue.CommandQueueManager.push(queue.CommandNames.RescanFolders, {});
    const job = queue.CommandQueueManager.claimForExecution(id, "atomic-test", 60_000)!;
    database.db.exec("CREATE TRIGGER reject_root_completion BEFORE INSERT ON runtime_controls BEGIN SELECT RAISE(ABORT,'test persistence failure'); END");
    try {
        assert.throws(() => queue.CommandQueueManager.complete(id, job.worker_id!), /test persistence failure/);
        assert.equal(queue.CommandQueueManager.get(id)!.status, "started");
        assert.equal(schedule.rootScanScheduleAnchor(null), null);
    } finally { database.db.exec("DROP TRIGGER reject_root_completion"); }
});
