import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
const { tempDir } = prepareActiveSchemaEnv("command-cancel");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let control: typeof import("./command-control-service.js");
let pool: typeof import("./worker/command-worker-pool.js").CommandWorkerPool;
before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    control = await import("./command-control-service.js");
    pool = (await import("./worker/command-worker-pool.js")).CommandWorkerPool;
});
beforeEach(() => database.db.prepare("DELETE FROM commands").run());
after(() => closeActiveSchemaDb(database.dbModule, tempDir));

test("disk cancellation keeps ownership until the work unit settles and prevents continuation", async () => {
    const id = queue.CommandQueueManager.push(queue.CommandNames.RenameFiles, { ids: [1] });
    const job = queue.CommandQueueManager.claimForExecution(id, "cancel-owner", 60_000)!;
    const realAbort = pool.abortCommandAndWait;
    pool.abortCommandAndWait = async () => { throw new Error("Must not terminate a file writer"); };
    try {
        assert.equal(await control.cancelNonDownloadCommand(id), true);
        assert.equal(queue.CommandQueueManager.get(id)?.status, "started");
        assert.equal(queue.CommandQueueManager.get(id)?.payload.cancelRequested, true);
        const manager = (await import("./command.js")).CommandManager;
        assert.equal(manager.canStartCommand("RetagFiles").canStart, false);
        const ctx = await import("./command-context.js");
        const { CommandContinuation } = await import("./command-continuation.js");
        assert.equal(await ctx.persistCommandOutcome(job, new CommandContinuation({ renameWork: { version: 1 } })), "cancelled");
        assert.equal(queue.CommandQueueManager.get(id)?.status, "cancelled");
        assert.equal(manager.canStartCommand("RetagFiles").canStart, true);
        queue.CommandQueueManager.retry(id);
        assert.equal(queue.CommandQueueManager.get(id)?.payload.cancelRequested, undefined);
    } finally { pool.abortCommandAndWait = realAbort; }
});

test("non-file cancellation retains the command reservation until worker exit", async () => {
    const id = queue.CommandQueueManager.push(queue.CommandNames.CheckHealth, {});
    queue.CommandQueueManager.claimForExecution(id, "non-file-cancel", 60_000);
    const realAbort = pool.abortCommandAndWait;
    let release!: () => void;
    pool.abortCommandAndWait = async () => new Promise<void>(resolve => { release = resolve; });
    try {
        const cancelled = control.cancelNonDownloadCommand(id);
        assert.equal(queue.CommandQueueManager.get(id)?.status, "started");
        release();
        assert.equal(await cancelled, true);
        assert.equal(queue.CommandQueueManager.get(id)?.status, "cancelled");
    } finally { pool.abortCommandAndWait = realAbort; }
});

test("non-download cancellation cannot retire a dedicated download's ownership", async () => {
    const id = queue.CommandQueueManager.push(queue.CommandNames.DownloadAlbum, { provider: "tidal", providerId: "test" });
    queue.CommandQueueManager.claimForExecution(id, "download-owner", 60_000);
    await assert.rejects(control.cancelNonDownloadCommand(id), /download processor/);
    assert.equal(queue.CommandQueueManager.get(id)?.status, "started");
});
