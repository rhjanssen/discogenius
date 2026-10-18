import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { CommandContinuation } from "./command-continuation.js";

const FILE_COUNT = 2000;
const { tempDir } = prepareActiveSchemaEnv("retag-write-gate");

let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let work: typeof import("./retag-work.js");
let context: typeof import("./command-context.js");
let tags: typeof import("../mediafiles/audio-tag-service.js");
let locks: typeof import("./worker/sqlite-write-lock.js");
let ids: number[];

before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    work = await import("./retag-work.js");
    context = await import("./command-context.js");
    tags = await import("../mediafiles/audio-tag-service.js");
    locks = await import("./worker/sqlite-write-lock.js");
    const artist = Number(database.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('bench-artist', 'Bastille')").run().lastInsertRowid);
    const recording = Number(database.db.prepare("INSERT INTO Recordings (foreign_recording_id, mbid, title, artist_mbid) VALUES ('bench-recording', 'bench-recording', 'Pompeii', 'bench-artist')").run().lastInsertRowid);
    const insert = database.db.prepare(`INSERT INTO TrackFiles (
        artist_metadata_id, recording_id, file_path, filename, relative_path, library_root, extension, file_type, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, 'flac', 'track', 'stereo')`);
    ids = database.db.transaction(() => Array.from({ length: FILE_COUNT }, (_, index) => {
        const name = `bench-${index}.flac`;
        return Number(insert.run(artist, recording, path.join(tempDir, name), name, name, tempDir).lastInsertRowid);
    }))();
});

after(() => {
    locks.captureSqliteWriteLockLabels(false);
    closeActiveSchemaDb(database.dbModule, tempDir);
});

test("unchanged retag files take one write-gate transaction in steady state", async (t) => {
    t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
        apply: async () => ({ retagged: 0, skipped: 1, missing: 0, errors: [] }),
        close: () => {},
    }));
    const id = queue.CommandQueueManager.push(queue.CommandNames.RetagFiles, { ids });
    let job = queue.CommandQueueManager.claimForExecution(id, "bench-owner", 60_000);
    assert.ok(job);
    locks.captureSqliteWriteLockLabels(true);
    locks.takeSqliteWriteLockLabels();
    const started = performance.now();
    let guard = 0;
    while (job) {
        try {
            await work.runRetagWorkUnit(job, context.buildHandlerContext(), () => ids);
            break;
        } catch (error) {
            if (!(error instanceof CommandContinuation)) throw error;
            assert.equal(await context.persistCommandOutcome(job, error), "requeued");
            job = queue.CommandQueueManager.claimForExecution(id, `bench-owner-${guard}`, 60_000);
            assert.ok(job);
        }
        if (++guard > 20) throw new Error("retag benchmark did not finish");
    }
    const elapsedMs = performance.now() - started;
    const labels = locks.takeSqliteWriteLockLabels();
    locks.captureSqliteWriteLockLabels(false);
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    const claims = counts.get("retag:file-claim") ?? 0;
    const settles = (counts.get("retag:settle-and-claim") ?? 0)
        + (counts.get("retag:unchanged") ?? 0)
        + (counts.get("retag:file-settled") ?? 0);
    const replans = counts.get("retag:replan") ?? 0;
    const fileGates = labels.filter(label => label !== "retag:plan").length;
    const perFile = fileGates / FILE_COUNT;
    const filesPerMinute = FILE_COUNT / elapsedMs * 60_000;
    const report = {
        files: FILE_COUNT,
        elapsedMs: Math.round(elapsedMs),
        filesPerMinute: Math.round(filesPerMinute),
        writeGateTransactionsPerFile: Number(perFile.toFixed(4)),
        claims,
        settles,
        replans,
        labels: Object.fromEntries(counts),
    };
    console.log(`RETAG_BENCH ${JSON.stringify(report)}`);
    assert.equal(settles, FILE_COUNT);
    assert.equal(replans, 0);
    assert.equal(claims, Math.ceil(FILE_COUNT / 250));
    assert.ok(perFile <= 1.01, `write-gate transactions per file ${perFile}`);
    const plan = database.db.prepare("SELECT cursor, total, skipped FROM CommandFileWorkPlans WHERE command_id = ?").get(id) as {
        cursor: number; total: number; skipped: number;
    };
    assert.deepEqual(plan, { cursor: FILE_COUNT, total: FILE_COUNT, skipped: FILE_COUNT });
    assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM CommandFileWork WHERE command_id = ? AND status = 'started'").get(id) as { n: number }).n, 0);
});
