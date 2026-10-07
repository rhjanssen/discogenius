import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { withSqliteWriteMutexAsync } from "../../database/sqlite-write-mutex.js";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-command-busy-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.command-busy.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue-manager.js");
let contextModule: typeof import("./command-context.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue-manager.js");
    contextModule = await import("./command-context.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM commands").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function sqliteBusy(): Error {
    const error = new Error("database is locked");
    (error as Error & { code: string }).code = "SQLITE_BUSY";
    return error;
}

test("SQLITE_BUSY requeues a retry-safe command instead of failing it", async () => {
    const id = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RescanFolders,
        { providerId: "rescan-folders" } as never,
        undefined,
    );
    const job = queueModule.CommandQueueManager.claimForExecution(
        id,
        "busy-test-worker",
        60_000,
    );
    assert.ok(job);

    const outcome = await contextModule.persistCommandOutcome(job, sqliteBusy());
    assert.equal(outcome, "requeued");
    assert.equal(queueModule.CommandQueueManager.get(id)?.status, "queued");
});

test("SQLITE_BUSY still fails rename/retag so a partial filesystem mutation is not replayed", async () => {
    const id = queueModule.CommandQueueManager.push(
        queueModule.CommandNames.RenameArtist,
        { artistName: "Busy Rename" } as never,
        undefined,
    );
    const job = queueModule.CommandQueueManager.claimForExecution(
        id,
        "busy-test-worker",
        60_000,
    );
    assert.ok(job);

    const outcome = await contextModule.persistCommandOutcome(job, sqliteBusy());
    assert.equal(outcome, "failed");
    assert.equal(queueModule.CommandQueueManager.get(id)?.status, "failed");
});

test("completed monitoring jobs await a competing writer before queuing their terminal pass", async () => {
    const scheduler = await import("./scheduler.js");
    const { commandExecutors } = await import("./executors/registry.js");
    dbModule.db.prepare("DELETE FROM monitoring_runtime_state").run();
    dbModule.db.prepare("DELETE FROM runtime_controls").run();
    const id = scheduler.queueMonitoringCyclePass({ trigger: 2 });
    const job = queueModule.CommandQueueManager.claimForExecution(id, "chain-test", 60_000);
    assert.ok(job);
    const executor = commandExecutors[job.name];
    const complete = queueModule.CommandQueueManager.complete;
    const unrelatedContext = new AsyncResource("competing-chain-writer");
    let competing: Promise<void> | undefined;
    let writerEntered = false;
    let timerRan = false;
    commandExecutors[job.name] = { execute: async () => {} };
    queueModule.CommandQueueManager.complete = (...args) => {
        const result = complete.apply(queueModule.CommandQueueManager, args);
        // Queue an unrelated writer immediately after outcome persistence.
        // FIFO admission grants it before the command's follow-up can write.
        competing = unrelatedContext.runInAsyncScope(() => withSqliteWriteMutexAsync(async () => {
            writerEntered = true;
            await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 20));
        }));
        return result;
    };
    try {
        await contextModule.executeCommand(job);
        await competing;
        assert.equal(writerEntered, true);
        assert.equal(timerRan, true);
        assert.equal(queueModule.CommandQueueManager.get(id)?.status, "completed");
        assert.equal(queueModule.CommandQueueManager.getTopPendingJobsByTypes(
            [queueModule.CommandNames.DownloadMissing], 10).length, 1);
    } finally {
        commandExecutors[job.name] = executor;
        queueModule.CommandQueueManager.complete = complete;
        await competing;
        unrelatedContext.emitDestroy();
    }
});
