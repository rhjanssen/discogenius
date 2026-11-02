import assert from "node:assert/strict";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("rename-work");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let work: typeof import("./rename-work.js");
let context: typeof import("./command-context.js");
let config: typeof import("../config/config.js");
let ids: number[];
before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    work = await import("./rename-work.js");
    context = await import("./command-context.js");
    config = await import("../config/config.js");
    ids = Array.from({ length: 26 }, (_, i) => Number(database.db.prepare(`INSERT INTO TrackFiles
        (file_path, filename, relative_path, library_root, extension, file_type, library_slot)
        VALUES (?, ?, ?, ?, 'flac', 'track', 'stereo')`)
        .run(path.join(tempDir, `missing-${i}.flac`), `missing-${i}.flac`, `missing-${i}.flac`, tempDir).lastInsertRowid));
});
beforeEach(() => database.db.prepare("DELETE FROM commands").run());
after(() => closeActiveSchemaDb(database.dbModule, tempDir));
function claim(owner: string) {
    const id = queue.CommandQueueManager.push(queue.CommandNames.RenameFiles, { ids });
    return queue.CommandQueueManager.claimForExecution(id, owner, 60_000)!;
}

test("rename finishes one album and resumes the exact durable plan after reopen", async () => {
    const job = claim("rename-one");
    const finished = await work.runRenameWorkUnit(job, context.buildHandlerContext(), () => ids, false);
    assert.equal(finished.missing, 26);
    assert.equal((database.db.prepare("SELECT cursor, plan_complete FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number; plan_complete: number }).cursor, 26);
    const stored = JSON.parse((database.db.prepare("SELECT result FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { result: string }).result) as { missing: number };
    stored.missing = 25;
    database.db.prepare("UPDATE CommandRenamePlans SET cursor = 25, result = ? WHERE command_id = ?").run(JSON.stringify(stored), job.id);
    database.db.prepare("UPDATE CommandRenameWork SET status = 'pending', result = NULL WHERE command_id = ? AND ordinal = 25").run(job.id);
    assert.equal(queue.CommandQueueManager.recoverOwnedCommand({
        id: job.id, workerId: job.worker_id!, reason: "process interrupted", maxAttempts: 5, retryDelayMs: 0,
    }).outcome, "requeued");
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    const next = queue.CommandQueueManager.claimForExecution(job.id, "rename-two", 60_000);
    assert.ok(next);
    const result = await work.runRenameWorkUnit(next, context.buildHandlerContext(), () => { throw new Error("Must not reselect scope"); }, false);
    assert.equal(result.missing, 26);
    assert.deepEqual(result.errors, []);
    assert.equal(await context.persistCommandOutcome(next, null), "completed");
});

test("rename refuses settings changes on a stored plan", async () => {
    const job = claim("settings-one");
    await work.runRenameWorkUnit(job, context.buildHandlerContext(), () => ids, false);
    const original = getPath();
    config.updateConfig("path", { music_path: path.join(tempDir, "changed-root") });
    try {
        await assert.rejects(work.runRenameWorkUnit(job, context.buildHandlerContext(), () => { throw new Error("must not reselect"); }, false), /settings changed/);
        assert.equal((database.db.prepare("SELECT cursor FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number }).cursor, 26);
    } finally { config.updateConfig("path", original); }
});
function getPath() { return config.getConfigSection("path"); }

test("retired rename ownership cannot rename a file", async () => {
    const job = claim("retired-rename");
    const ctx = context.buildHandlerContext();
    ctx.yieldToEventLoop = async () => { queue.CommandQueueManager.fail(job.id, "Retired", job.worker_id!); };
    await assert.rejects(work.runRenameWorkUnit(job, ctx, () => ids, false), /ownership changed/);
    assert.equal((database.db.prepare("SELECT cursor FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number }).cursor, 0);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM CommandRenameWork WHERE command_id = ? AND status = 'settled'").get(job.id) as { n: number }).n, 0);
});

test("changed catalogue identity is refused and recorded without abandoning the rest of the plan", async () => {
    const job = claim("identity-one");
    const ctx = context.buildHandlerContext();
    let yields = 0;
    ctx.yieldToEventLoop = async () => {
        if (++yields === 1) database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = 'changed-recording' WHERE id = ?").run(ids[25]);
    };
    try {
        const result = await work.runRenameWorkUnit(job, ctx, () => ids, false);
        assert.equal(result.missing, 25);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].id, ids[25]);
        assert.match(result.errors[0].error, /changed catalogue identity/);
        assert.equal((database.db.prepare("SELECT cursor FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number }).cursor, 26);
    } finally { database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = NULL WHERE id = ?").run(ids[25]); }
});
