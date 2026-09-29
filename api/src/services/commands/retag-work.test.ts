import assert from "node:assert/strict";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("retag-work");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let work: typeof import("./retag-work.js");
let context: typeof import("./command-context.js");
let config: typeof import("../config/config.js");
let ids: number[];
let records: typeof import("./command-file-work-repository.js");

before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    work = await import("./retag-work.js");
    records = await import("./command-file-work-repository.js");
    context = await import("./command-context.js");
    config = await import("../config/config.js");
    const artist = database.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('retag-artist', 'Bastille')").run().lastInsertRowid;
    const recording = database.db.prepare("INSERT INTO Recordings (foreign_recording_id, mbid, title, artist_mbid) VALUES ('retag-recording', 'retag-recording', 'Pompeii', 'retag-artist')").run().lastInsertRowid;
    ids = Array.from({ length: 26 }, (_, i) => Number(database.db.prepare(`
        INSERT INTO TrackFiles (artist_metadata_id, recording_id, file_path, filename, relative_path, library_root, extension, file_type, library_slot)
        VALUES (?, ?, ?, ?, ?, ?, 'flac', 'track', 'stereo')
    `).run(artist, recording, path.join(tempDir, `missing-${i}.flac`), `missing-${i}.flac`, `missing-${i}.flac`, tempDir).lastInsertRowid));
});
beforeEach(() => {
    database.db.prepare("DELETE FROM commands").run();
    config.updateConfig("metadata", { write_audio_tags_policy: "all_files" });
});
after(() => closeActiveSchemaDb(database.dbModule, tempDir));

function claim(workerId: string) {
    const id = queue.CommandQueueManager.push(queue.CommandNames.RetagFiles, { ids });
    return queue.CommandQueueManager.claimForExecution(id, workerId, 60_000)!;
}

test("retag resumes its exact settled file plan after a database reopen", async () => {
    const job = claim("unit-one");
    let continuation: unknown;
    try {
        await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids);
    } catch (error) { continuation = error; }
    const { CommandContinuation } = await import("./command-continuation.js");
    assert.ok(continuation instanceof CommandContinuation);
    assert.equal(await context.persistCommandOutcome(job, continuation), "requeued");
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 25);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.missing, 25);
    assert.equal(database.db.prepare("SELECT 1 FROM CommandFileWork WHERE command_id = ? AND status = 'started'").get(job.id), undefined);
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    const next = queue.CommandQueueManager.claimForExecution(job.id, "unit-two", 60_000)!;
    const result = await work.runRetagWorkUnit(next, context.buildHandlerContext(), () => { throw new Error("Scope must not be reselected"); });
    assert.equal(result.missing, 26);
    assert.equal(result.errors.length, 0);
    assert.deepEqual((database.db.prepare("SELECT track_file_id FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id) as Array<{ track_file_id: number }>).map(row => row.track_file_id), ids);
    assert.equal(await context.persistCommandOutcome(next, null), "completed");
});

test("tag stripping uses the same bounded durable work units", async () => {
    const job = claim("strip-one");
    let continuation: unknown;
    try { await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids, true); }
    catch (error) { continuation = error; }
    assert.equal(await context.persistCommandOutcome(job, continuation), "requeued");
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 25);
    assert.equal((database.db.prepare("SELECT operation FROM CommandFileWorkPlans WHERE command_id = ?").get(job.id) as { operation: string }).operation, "strip");
    const next = queue.CommandQueueManager.claimForExecution(job.id, "strip-two", 60_000)!;
    const result = await work.runRetagWorkUnit(next, context.buildHandlerContext(), () => { throw new Error("Must not reselect"); }, true);
    assert.equal(result.missing, 26);
});

test("a settings change cannot silently mix tag policies across retag units", async () => {
    const job = claim("policy-one");
    let continuation: unknown;
    try { await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids); }
    catch (error) { continuation = error; }
    assert.equal(await context.persistCommandOutcome(job, continuation), "requeued");
    config.updateConfig("metadata", { write_audio_tags_policy: "no" });
    const next = queue.CommandQueueManager.claimForExecution(job.id, "policy-two", 60_000)!;
    await assert.rejects(work.runRetagWorkUnit(next, context.buildHandlerContext(), () => ids), /settings changed/);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 25);
});

test("retired ownership prevents a retag from starting its next file", async () => {
    const job = claim("retired-owner");
    const ctx = context.buildHandlerContext();
    ctx.yieldToEventLoop = async () => { queue.CommandQueueManager.fail(job.id, "Ownership retired", job.worker_id!); };
    await assert.rejects(work.runRetagWorkUnit(job, ctx, () => ids), /ownership changed/);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 1);
    assert.equal(database.db.prepare("SELECT 1 FROM CommandFileWork WHERE command_id = ? AND status = 'started'").get(job.id), undefined);
});

test("an interrupted file intent stays failed until an explicit retry resumes its exact identity", async () => {
    const job = claim("interrupted-file-owner");
    const repo = records.CommandFileWorkRepository;
    repo.create(job.id, job.worker_id!, "journal-test", repo.prepare(ids));
    const file = repo.begin(job.id, job.worker_id!);
    assert.equal(file.id, ids[0]);
    assert.equal(queue.CommandQueueManager.recoverOwnedCommand({ id: job.id, workerId: job.worker_id!,
        reason: "process interrupted", maxAttempts: 1, retryDelayMs: 0 }).outcome, "failed");
    assert.equal(repo.get(job.id)?.cursor, 0);
    assert.throws(() => repo.settle(job.id, job.worker_id!, file.id,
        { retagged: 1, skipped: 0, missing: 0, errors: [] }), /ownership changed/);
    queue.CommandQueueManager.retry(job.id);
    const next = queue.CommandQueueManager.claimForExecution(job.id, "explicit-retry-owner", 60_000)!;
    assert.equal(repo.begin(job.id, next.worker_id!).id, file.id);
    repo.settle(job.id, next.worker_id!, file.id, { retagged: 0, skipped: 0, missing: 1, errors: [] });
    assert.equal(repo.get(job.id)?.cursor, 1);
});

test("retag journal refuses a changed catalogue identity before writing or settling a file", () => {
    const job = claim("identity-owner");
    const repo = records.CommandFileWorkRepository;
    repo.create(job.id, job.worker_id!, "identity-test", repo.prepare(ids));
    const previous = database.db.prepare("SELECT recording_id FROM TrackFiles WHERE id = ?").get(ids[0]) as { recording_id: number };
    try {
        database.db.prepare("UPDATE TrackFiles SET recording_id = NULL WHERE id = ?").run(ids[0]);
        assert.throws(() => repo.begin(job.id, job.worker_id!), /changed catalogue identity/);
        database.db.prepare("UPDATE TrackFiles SET recording_id = ? WHERE id = ?").run(previous.recording_id, ids[0]);
        const file = repo.begin(job.id, job.worker_id!);
        database.db.prepare("UPDATE TrackFiles SET recording_id = NULL WHERE id = ?").run(ids[0]);
        assert.throws(() => repo.settle(job.id, job.worker_id!, file.id,
            { retagged: 0, skipped: 1, missing: 0, errors: [] }), /changed identity/);
        assert.equal(repo.get(job.id)?.cursor, 0);
    } finally {
        database.db.prepare("UPDATE TrackFiles SET recording_id = ? WHERE id = ?").run(previous.recording_id, ids[0]);
    }
});

test("retrying failed file outcomes preserves earlier evidence and excludes successful files", () => {
    const job = claim("outcome-owner");
    const repo = records.CommandFileWorkRepository;
    repo.create(job.id, job.worker_id!, "outcome-test", repo.prepare(ids.slice(0, 2)));
    repo.begin(job.id, job.worker_id!);
    repo.settle(job.id, job.worker_id!, ids[0], { retagged: 0, skipped: 0, missing: 0, errors: [{ id: ids[0], error: "unreadable file" }] });
    repo.begin(job.id, job.worker_id!);
    repo.settle(job.id, job.worker_id!, ids[1], { retagged: 0, skipped: 1, missing: 0, errors: [] });
    queue.CommandQueueManager.fail(job.id, "one file failed", job.worker_id!);
    queue.CommandQueueManager.retry(job.id);
    const next = queue.CommandQueueManager.claimForExecution(job.id, "retry-failed-owner", 60_000)!;
    assert.equal(repo.retryFailed(job.id, next.worker_id!).total, 1);
    assert.equal(repo.begin(job.id, next.worker_id!).id, ids[0]);
    assert.equal((database.db.prepare("SELECT COUNT(*) n FROM CommandFileWork WHERE command_id = ? AND generation = 1").get(job.id) as { n: number }).n, 2);
    assert.deepEqual(repo.errors(job.id), []);
});

test("a file journal cannot settle an ambiguous or foreign-file outcome", () => {
    const job = claim("exact-outcome-owner");
    const repo = records.CommandFileWorkRepository;
    repo.create(job.id, job.worker_id!, "exact-outcome", repo.prepare(ids.slice(0, 1)));
    repo.begin(job.id, job.worker_id!);
    for (const result of [
        { retagged: 0, skipped: 0, missing: 0, errors: [] },
        { retagged: 1, skipped: 1, missing: 0, errors: [] },
        { retagged: 0, skipped: 0, missing: 0, errors: [{ id: ids[1], error: "another file failed" }] },
    ]) {
        assert.throws(() => repo.settle(job.id, job.worker_id!, ids[0], result), /exactly file/);
    }
    assert.equal(repo.get(job.id)?.cursor, 0);
});
