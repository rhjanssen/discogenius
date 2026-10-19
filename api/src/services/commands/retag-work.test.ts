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
    ids = Array.from({ length: 251 }, (_, i) => Number(database.db.prepare(`
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

test("retag resumes its exact settled file plan after a database reopen", async (t) => {
    const job = claim("unit-one");
    const finished = await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids);
    assert.equal(finished.missing, 251);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 251);
    const last = database.db.prepare("SELECT ordinal, track_file_id FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal DESC LIMIT 1").get(job.id) as { ordinal: number; track_file_id: number };
    database.db.prepare(`UPDATE CommandFileWork SET status = 'pending', missing = 0, settled_at = NULL WHERE command_id = ? AND ordinal = ?`)
        .run(job.id, last.ordinal);
    database.db.prepare("UPDATE CommandFileWorkPlans SET cursor = 250, missing = 250 WHERE command_id = ?").run(job.id);
    assert.equal(queue.CommandQueueManager.recoverOwnedCommand({
        id: job.id, workerId: job.worker_id!, reason: "process interrupted", maxAttempts: 5, retryDelayMs: 0,
    }).outcome, "requeued");
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    const next = queue.CommandQueueManager.claimForExecution(job.id, "unit-two", 60_000);
    assert.ok(next);
    const tags = await import("../mediafiles/audio-tag-service.js");
    const opened: number[] = [];
    t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
        apply: async (fileIds: number[]) => {
            opened.push(...fileIds);
            return { retagged: 0, skipped: 0, missing: 1, errors: [] };
        },
        close: () => {},
    }));
    const result = await work.runRetagWorkUnit(next, context.buildHandlerContext(), () => { throw new Error("Scope must not be reselected"); });
    assert.deepEqual(opened, [last.track_file_id]);
    assert.equal(result.missing, 251);
    assert.equal(result.errors.length, 0);
    assert.deepEqual((database.db.prepare("SELECT track_file_id FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id) as Array<{ track_file_id: number }>).map(row => row.track_file_id), ids);
    assert.equal(await context.persistCommandOutcome(next, null), "completed");
});

test("tag stripping settles one album without reselecting a complete plan", async () => {
    const job = claim("strip-one");
    const result = await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids, true);
    assert.equal(result.missing, 251);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 251);
    assert.equal((database.db.prepare("SELECT operation, plan_complete FROM CommandFileWorkPlans WHERE command_id = ?").get(job.id) as { operation: string; plan_complete: number }).operation, "strip");
    assert.equal((database.db.prepare("SELECT plan_complete FROM CommandFileWorkPlans WHERE command_id = ?").get(job.id) as { plan_complete: number }).plan_complete, 1);
    database.db.prepare("UPDATE CommandFileWorkPlans SET cursor = 250, missing = 250 WHERE command_id = ?").run(job.id);
    database.db.prepare("UPDATE CommandFileWork SET status = 'pending', missing = 0 WHERE command_id = ? AND ordinal = 250").run(job.id);
    const resumed = await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => { throw new Error("Must not reselect"); }, true);
    assert.equal(resumed.missing, 251);
});

test("a settings change cannot silently mix tag policies across a stored plan", async () => {
    const job = claim("policy-one");
    await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids);
    config.updateConfig("metadata", { write_audio_tags_policy: "no" });
    await assert.rejects(work.runRetagWorkUnit(job, context.buildHandlerContext(), () => { throw new Error("must not reselect"); }), /settings changed/);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 251);
});

test("retired ownership stops before the album is opened", async () => {
    const job = claim("retired-owner");
    const ctx = context.buildHandlerContext();
    ctx.yieldToEventLoop = async () => { queue.CommandQueueManager.fail(job.id, "Ownership retired", job.worker_id!); };
    await assert.rejects(work.runRetagWorkUnit(job, ctx, () => ids), /ownership changed/);
    const plan = records.CommandFileWorkRepository.get(job.id);
    assert.equal(plan?.cursor, 0);
    assert.equal(plan?.missing, 0);
    assert.equal(database.db.prepare("SELECT 1 FROM CommandFileWork WHERE command_id = ? AND status = 'started'").get(job.id), undefined);
});

test("settling one file claims the next in the same transaction", () => {
    const job = claim("settle-and-claim");
    const repo = records.CommandFileWorkRepository;
    repo.create(job.id, job.worker_id!, "settle-claim", repo.prepare(ids.slice(0, 3)));
    assert.equal(repo.begin(job.id, job.worker_id!).id, ids[0]);
    database.db.exec(`CREATE TRIGGER abort_next_claim BEFORE UPDATE ON CommandFileWork
        WHEN NEW.ordinal = 1 AND NEW.status = 'started'
        BEGIN SELECT RAISE(ABORT, 'killed while claiming the next file'); END;`);
    try {
        assert.throws(() => repo.settleAndClaimNext(job.id, job.worker_id!, ids[0],
            { retagged: 0, skipped: 1, missing: 0, errors: [] }, true), /claiming the next file/);
        assert.equal(repo.get(job.id)?.cursor, 0);
        assert.deepEqual(database.db.prepare("SELECT ordinal, status FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id), [
            { ordinal: 0, status: "started" },
            { ordinal: 1, status: "pending" },
            { ordinal: 2, status: "pending" },
        ]);
    } finally {
        database.db.exec("DROP TRIGGER abort_next_claim");
    }
    const step = repo.settleAndClaimNext(job.id, job.worker_id!, ids[0],
        { retagged: 0, skipped: 1, missing: 0, errors: [] }, true);
    assert.equal(step.plan.cursor, 1);
    assert.equal(step.next?.id, ids[1]);
    assert.equal(step.replannedId, null);
    assert.deepEqual(database.db.prepare("SELECT ordinal, status FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id), [
        { ordinal: 0, status: "settled" },
        { ordinal: 1, status: "started" },
        { ordinal: 2, status: "pending" },
    ]);
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

test("one file changing identity mid-plan is re-planned alone and never fails the library-wide retag", async () => {
    const job = claim("identity-isolation");
    const repo = records.CommandFileWorkRepository;
    repo.create(job.id, job.worker_id!, "unused", repo.prepare(ids));
    database.db.prepare("DELETE FROM CommandFileWork WHERE command_id = ?").run(job.id);
    database.db.prepare("DELETE FROM CommandFileWorkPlans WHERE command_id = ?").run(job.id);
    const previous = database.db.prepare("SELECT canonical_recording_mbid FROM TrackFiles WHERE id = ?").get(ids[3]) as { canonical_recording_mbid: string | null };
    const ctx = context.buildHandlerContext();
    let yields = 0;
    // Simulate a concurrent import re-identifying file #4 after the plan exists.
    ctx.yieldToEventLoop = async () => {
        if (++yields === 1) database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = 're-identified-by-import' WHERE id = ?").run(ids[3]);
    };
    try {
        const result = await work.runRetagWorkUnit(job, ctx, () => ids);
        const plan = records.CommandFileWorkRepository.get(job.id)!;
        assert.equal(plan.cursor, plan.total, JSON.stringify({ plan, result }));
        assert.equal(result.missing + result.skipped + result.retagged, 251, JSON.stringify({ plan, result }));
        assert.equal(result.errors.length, 0);
        assert.deepEqual(result.identityChanged, [ids[3]]);
        assert.equal(result.identityChangedCount, 1);
    } finally {
        database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = ? WHERE id = ?").run(previous.canonical_recording_mbid, ids[3]);
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

test("unchanged fingerprints are skipped without opening the file", async (t) => {
    const tags = await import("../mediafiles/audio-tag-service.js");
    const desired = tags.AudioTagService.desiredManagedFingerprints(ids);
    assert.equal(desired.size, ids.length);
    const stamp = database.db.prepare("UPDATE TrackFiles SET managed_tag_fingerprint = ? WHERE id = ?");
    database.db.transaction(() => {
        for (const [fileId, fingerprint] of desired) stamp.run(fingerprint, fileId);
    })();
    try {
        t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
            apply: async () => { throw new Error("fingerprint skip opened a file"); },
            close: () => {},
        }));
        const job = claim("fingerprint-skip");
        const result = await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids);
        assert.equal(result.skipped, ids.length);
        assert.equal(result.missing, 0);
        assert.equal(result.retagged, 0);
        assert.deepEqual(result.errors, []);
        assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, ids.length);
    } finally {
        database.db.prepare("UPDATE TrackFiles SET managed_tag_fingerprint = NULL").run();
    }
});

test("the first album starts before the rest of the library is planned", async (t) => {
    const artist = (database.db.prepare("SELECT id FROM ArtistMetadata LIMIT 1").get() as { id: number }).id;
    const recording = (database.db.prepare("SELECT id FROM Recordings LIMIT 1").get() as { id: number }).id;
    const insert = database.db.prepare(`INSERT INTO TrackFiles (
        artist_metadata_id, recording_id, file_path, filename, relative_path, library_root, extension, file_type, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, 'flac', 'track', 'stereo')`);
    const make = (folder: string, count: number) => Array.from({ length: count }, (_, index) => {
        const name = `${folder}-${index}.flac`;
        const filePath = path.join(tempDir, folder, name);
        return Number(insert.run(artist, recording, filePath, name, `${folder}/${name}`, tempDir).lastInsertRowid);
    });
    const albumA = make("album-a", 2);
    const albumB = make("album-b", 3);
    const selected = [...albumA, ...albumB];
    const commandId = queue.CommandQueueManager.push(queue.CommandNames.RetagFiles, { ids: selected });
    const job = queue.CommandQueueManager.claimForExecution(commandId, "stream-plan", 60_000);
    assert.ok(job);
    const tags = await import("../mediafiles/audio-tag-service.js");
    let observed = false;
    t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
        apply: async (fileIds: number[]) => {
            if (!observed) {
                observed = true;
                const plan = records.CommandFileWorkRepository.get(job.id)!;
                assert.equal(plan.plan_complete, 0);
                assert.equal(plan.total, albumA.length);
                assert.equal(plan.cursor, 0);
                const rows = database.db.prepare("SELECT track_file_id FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal")
                    .all(job.id) as Array<{ track_file_id: number }>;
                assert.deepEqual(rows.map(row => row.track_file_id), albumA);
            }
            assert.equal(fileIds.length, 1);
            return { retagged: 0, skipped: 0, missing: 1, errors: [] };
        },
        close: () => {},
    }));
    const result = await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => selected);
    assert.equal(observed, true);
    const plan = records.CommandFileWorkRepository.get(job.id)!;
    assert.equal(plan.plan_complete, 1);
    assert.equal(plan.total, selected.length);
    assert.equal(plan.cursor, selected.length);
    assert.equal(result.missing, selected.length);
    assert.deepEqual(result.errors, []);
});
