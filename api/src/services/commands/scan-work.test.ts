import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import type { CommandModelOf } from "./command-model.js";

const { tempDir } = prepareActiveSchemaEnv("scan-work");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let work: typeof import("./scan-work.js");
let context: typeof import("./command-context.js");
let config: typeof import("../config/config.js");

before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    work = await import("./scan-work.js");
    context = await import("./command-context.js");
    config = await import("../config/config.js");
});
beforeEach(() => {
    database.db.prepare("DELETE FROM commands").run();
    config.updateConfig("filtering", { include_videos: true });
});
after(() => closeActiveSchemaDb(database.dbModule, tempDir));

function claim(workerId: string) {
    const id = queue.CommandQueueManager.push(queue.CommandNames.RescanFolders, {});
    return claimExisting(id, workerId);
}
function claimExisting(id: number, workerId: string): CommandModelOf<"RescanFolders"> {
    const job = queue.CommandQueueManager.claimForExecution(id, workerId, 60_000)!;
    assert.equal(job.name, "RescanFolders");
    return job as CommandModelOf<"RescanFolders">;
}
const result = () => ({ artists: 1, orphansRemoved: 1, filesIndexed: 2, filesUpdated: 3, downloadFlagsReset: 4, unmappedOrphans: 0 });
async function checkpoint(job: ReturnType<typeof claim>, callback: () => Promise<unknown>) {
    let continuation: unknown;
    try { await callback(); } catch (error) { continuation = error; }
    assert.equal(await context.persistCommandOutcome(job, continuation), "requeued");
    assert.equal(queue.CommandQueueManager.get(job.id)?.status, "queued");
}

test("scan checkpoints release disk admission and retain exact scope and counts after reopen", async () => {
    const job = claim("scan-one");
    const visited: string[] = [];
    const scan = async (id: string) => { visited.push(id); return result(); };
    let cleanups = 0;
    const cleanup = async () => { cleanups++; return 5; };
    await checkpoint(job, () => work.runScanWorkUnit(job, () => ["Bastille", "Bakermat", "Bastille"], scan, cleanup));
    const { CommandManager } = await import("./command.js");
    assert.equal(CommandManager.canStartCommand(queue.CommandNames.ImportDownload).canStart, true);
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    const second = claimExisting(job.id, "scan-two");
    const noReselect = () => { throw new Error("Scope must not change between units"); };
    await checkpoint(second, () => work.runScanWorkUnit(second, noReselect, scan, cleanup));
    const third = claimExisting(job.id, "scan-cleanup");
    assert.deepEqual(await work.runScanWorkUnit(third, noReselect, scan, cleanup),
        { artists: 2, orphansRemoved: 2, filesIndexed: 4, filesUpdated: 6, downloadFlagsReset: 8, unmappedOrphans: 5 });
    assert.deepEqual(visited, ["Bastille", "Bakermat"]);
    assert.equal(cleanups, 1);
    assert.equal(await context.persistCommandOutcome(third, null), "completed");
});

test("scan refuses changed settings before mutating the next artist", async () => {
    const job = claim("scan-policy");
    await checkpoint(job, () => work.runScanWorkUnit(job, () => ["one", "two"], async () => result(), null));
    config.updateConfig("filtering", { include_videos: false });
    const next = claimExisting(job.id, "scan-policy-next");
    await assert.rejects(work.runScanWorkUnit(next, () => [], async () => { throw new Error("Must not scan"); }, null), /settings changed/);
    assert.equal(queue.CommandQueueManager.get(job.id)?.payload.scanWork?.cursor, 1);
});

test("scan cannot settle an artist after its execution owner is retired", async () => {
    const job = claim("scan-retired");
    await assert.rejects(work.runScanWorkUnit(job, () => ["one"], async () => {
        queue.CommandQueueManager.fail(job.id, "Retired owner", job.worker_id!);
        return result();
    }, null), /ownership changed/);
    assert.equal(queue.CommandQueueManager.get(job.id)?.payload.scanWork?.cursor, 0);
});

test("scan cancellation settles the current artist and prevents the next one", async () => {
    const job = claim("scan-cancel");
    let continuation: unknown;
    try {
        await work.runScanWorkUnit(job, () => ["one", "two"], async () => {
            queue.CommandQueueManager.updateState(job.id, { workerId: job.worker_id!, payloadPatch: { cancelRequested: true } });
            return result();
        }, null);
    } catch (error) { continuation = error; }
    assert.equal(await context.persistCommandOutcome(job, continuation), "cancelled");
    assert.equal(queue.CommandQueueManager.get(job.id)?.payload.scanWork?.cursor, 1);
    assert.equal(queue.CommandQueueManager.get(job.id)?.status, "cancelled");
});
