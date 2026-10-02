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

test("rename releases admission after 25 files and resumes the exact durable plan after reopen", async () => {
    const job = claim("rename-one");
    let continuation: unknown;
    try { await work.runRenameWorkUnit(job, context.buildHandlerContext(), () => ids, false); }
    catch (error) { continuation = error; }
    const { CommandContinuation } = await import("./command-continuation.js");
    assert.ok(continuation instanceof CommandContinuation);
    assert.equal(await context.persistCommandOutcome(job, continuation), "requeued");
    assert.equal((database.db.prepare("SELECT cursor FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number }).cursor, 25);
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    const next = queue.CommandQueueManager.claimForExecution(job.id, "rename-two", 60_000)!;
    const result = await work.runRenameWorkUnit(next, context.buildHandlerContext(), () => { throw new Error("Must not reselect scope"); }, false);
    assert.equal(result.missing, 26);
    assert.deepEqual(result.errors, []);
    assert.equal(await context.persistCommandOutcome(next, null), "completed");
});

test("rename refuses settings changes between dispatches", async () => {
    const job = claim("settings-one");
    let continuation: unknown;
    try { await work.runRenameWorkUnit(job, context.buildHandlerContext(), () => ids, false); }
    catch (error) { continuation = error; }
    assert.equal(await context.persistCommandOutcome(job, continuation), "requeued");
    const original = getPath();
    config.updateConfig("path", { music_path: path.join(tempDir, "changed-root") });
    try {
        const next = queue.CommandQueueManager.claimForExecution(job.id, "settings-two", 60_000)!;
        await assert.rejects(work.runRenameWorkUnit(next, context.buildHandlerContext(), () => ids, false), /settings changed/);
    } finally { config.updateConfig("path", original); }
});
function getPath() { return config.getConfigSection("path"); }

test("retired rename ownership cannot start a second file", async () => {
    const job = claim("retired-rename");
    const ctx = context.buildHandlerContext();
    ctx.yieldToEventLoop = async () => { queue.CommandQueueManager.fail(job.id, "Retired", job.worker_id!); };
    await assert.rejects(work.runRenameWorkUnit(job, ctx, () => ids, false), /ownership changed/);
    assert.equal((database.db.prepare("SELECT cursor FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number }).cursor, 1);
});

test("changed catalogue identity is refused and recorded without abandoning the rest of the plan", async () => {
    const job = claim("identity-one");
    let continuation: unknown;
    try { await work.runRenameWorkUnit(job, context.buildHandlerContext(), () => ids, false); }
    catch (error) { continuation = error; }
    await context.persistCommandOutcome(job, continuation);
    database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = 'changed-recording' WHERE id = ?").run(ids[25]);
    try {
        const next = queue.CommandQueueManager.claimForExecution(job.id, "identity-two", 60_000)!;
        const result = await work.runRenameWorkUnit(next, context.buildHandlerContext(), () => ids, false);
        assert.equal(result.missing, 25);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].id, ids[25]);
        assert.match(result.errors[0].error, /changed catalogue identity/);
        assert.equal((database.db.prepare("SELECT cursor FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { cursor: number }).cursor, 26);
    } finally { database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = NULL WHERE id = ?").run(ids[25]); }
});
