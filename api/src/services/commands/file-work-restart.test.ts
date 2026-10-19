import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import type { CommandBodyMap } from "./command-model.js";
import type { CommandName } from "./command-names.js";

const { tempDir } = prepareActiveSchemaEnv("file-work-restart");
const STARTED_AT = "2026-10-18T01:02:03.000Z";

let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let records: typeof import("./command-file-work-repository.js");
let retag: typeof import("./retag-work.js");
let rename: typeof import("./rename-work.js");
let context: typeof import("./command-context.js");
let executor: typeof import("./command-executor.js");
let history: typeof import("./command-history.js");
let registry: typeof import("./command-registry.js");
let policy: typeof import("./command-liveness-policy.js");
let tags: typeof import("../mediafiles/audio-tag-service.js");
let videos: typeof import("../mediafiles/video-tag-service.js");
let renames: typeof import("../mediafiles/rename-track-file-service.js");
let journal: typeof import("../mediafiles/file-mutation-journal.js");
let ids: number[];

before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    records = await import("./command-file-work-repository.js");
    retag = await import("./retag-work.js");
    rename = await import("./rename-work.js");
    context = await import("./command-context.js");
    executor = await import("./command-executor.js");
    history = await import("./command-history.js");
    registry = await import("./command-registry.js");
    policy = await import("./command-liveness-policy.js");
    tags = await import("../mediafiles/audio-tag-service.js");
    videos = await import("../mediafiles/video-tag-service.js");
    renames = await import("../mediafiles/rename-track-file-service.js");
    journal = await import("../mediafiles/file-mutation-journal.js");
    const artist = database.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('restart-artist', 'Bastille')").run().lastInsertRowid;
    const recording = database.db.prepare("INSERT INTO Recordings (foreign_recording_id, mbid, title, artist_mbid) VALUES ('restart-recording', 'restart-recording', 'Pompeii', 'restart-artist')").run().lastInsertRowid;
    ids = [0, 1, 2, 3].map(index => Number(database.db.prepare(`
        INSERT INTO TrackFiles (artist_metadata_id, recording_id, file_path, filename, relative_path, library_root, extension, file_type, library_slot)
        VALUES (?, ?, ?, ?, ?, ?, 'flac', 'track', 'stereo')
    `).run(artist, recording, path.join(tempDir, `restart-${index}.flac`), `restart-${index}.flac`, `restart-${index}.flac`, tempDir).lastInsertRowid));
});

beforeEach(() => {
    executor.CommandExecutor.stop();
    database.db.prepare("DELETE FROM commands").run();
});

after(() => closeActiveSchemaDb(database.dbModule, tempDir));

type CommandRow = {
    status: string;
    attempt: number;
    started_at: string | null;
    progress: number;
    progress_phase: string | null;
    progress_current: number | null;
    progress_total: number | null;
    blocked_reason: string | null;
    error: string | null;
    payload: string;
};

function commandRow(id: number): CommandRow {
    return database.db.prepare(`SELECT status, attempt, started_at, progress, progress_phase, progress_current,
        progress_total, blocked_reason, error, payload FROM commands WHERE id = ?`).get(id) as CommandRow;
}

function claim<T extends CommandName>(name: T, payload: CommandBodyMap[T], worker = "previous-process") {
    const id = queue.CommandQueueManager.push(name, payload);
    const job = queue.CommandQueueManager.claimForExecution(id, worker, 60_000);
    assert.ok(job, `claim failed for ${name}`);
    return job;
}

function stampRunning(id: number, attempt = 4): void {
    database.db.prepare("UPDATE commands SET attempt = ?, started_at = ? WHERE id = ?").run(attempt, STARTED_AT, id);
}

async function bootRecovery(t: TestContext): Promise<void> {
    const loop = t.mock.method(executor.CommandExecutor as unknown as { loop: () => Promise<void> }, "loop", async () => {});
    try {
        await executor.CommandExecutor.start();
        assert.equal(loop.mock.callCount(), 1);
    } finally {
        executor.CommandExecutor.stop();
    }
}

function mockRetagApply(t: TestContext, applied: number[], sequence?: string[]): void {
    t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
        apply: async (fileIds: number[]) => {
            sequence?.push("apply");
            applied.push(...fileIds);
            return { retagged: 0, skipped: 1, missing: 0, errors: [] };
        },
        close: () => {},
    }));
    t.mock.method(tags.AudioTagService, "getRetagWorkIds", () => {
        throw new Error("library scan");
    });
    t.mock.method(videos.VideoTagService, "getFileIdsForArtists", () => {
        throw new Error("library scan");
    });
}

test("checkpoint resume is a property of the command definition", () => {
    assert.equal(registry.getCommandDefinition(queue.CommandNames.RetagArtist).fileWorkCheckpoint, "retag");
    assert.equal(registry.getCommandDefinition(queue.CommandNames.RetagFiles).fileWorkCheckpoint, "retag");
    assert.equal(registry.getCommandDefinition(queue.CommandNames.RenameArtist).fileWorkCheckpoint, "rename");
    assert.equal(registry.getCommandDefinition(queue.CommandNames.RenameFiles).fileWorkCheckpoint, "rename");
    assert.equal(registry.getCommandDefinition(queue.CommandNames.MoveArtist).fileWorkCheckpoint, undefined);
    assert.equal(registry.getCommandDefinition(queue.CommandNames.ImportUnmappedFiles).fileWorkCheckpoint, undefined);
    assert.equal(registry.getCommandDefinition(queue.CommandNames.LibraryBulkAction).fileWorkCheckpoint, undefined);
    assert.equal(registry.getCommandDefinition(queue.CommandNames.ConfigPrune).fileWorkCheckpoint, undefined);
    assert.equal(registry.commandResumesFromFileCheckpoint(queue.CommandNames.RetagArtist), true);
    assert.equal(registry.commandResumesFromFileCheckpoint(queue.CommandNames.MoveArtist), false);
    assert.equal(policy.isInfrastructureRetrySafe(queue.CommandNames.RetagArtist), false);
    assert.equal(policy.resolveInfrastructureMaxAttempts(queue.CommandNames.RetagArtist, 3), 1);
    assert.equal(policy.resolveInfrastructureMaxAttempts(queue.CommandNames.CheckHealth, 3), 3);
});

test("migration keeps an existing plan and adds restart claims without bumping schema 46", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { migrateFileWorkRestartResume } = await import("../../database/schema/file-work-restart-resume.js");
    const raw = new Database(":memory:");
    raw.exec(`
        CREATE TABLE CommandFileWorkPlans (
            command_id INTEGER PRIMARY KEY, operation TEXT NOT NULL, config_revision TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1, total INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
            retagged INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
            missing INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE CommandFileWork (
            command_id INTEGER NOT NULL, generation INTEGER NOT NULL, ordinal INTEGER NOT NULL,
            track_file_id INTEGER NOT NULL, identity_snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (command_id, generation, ordinal));
        CREATE TABLE CommandRenamePlans (
            command_id INTEGER PRIMARY KEY, config_revision TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
            total INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL);
        CREATE TABLE CommandRenameWork (
            command_id INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1, ordinal INTEGER NOT NULL,
            file_id INTEGER NOT NULL, identity_snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (command_id, generation, ordinal));
        CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    `);
    raw.prepare(`INSERT INTO CommandFileWorkPlans (command_id, operation, config_revision, total, cursor)
        VALUES (19285, 'retag', 'old', 24502, 15316)`).run();
    raw.prepare(`INSERT INTO CommandFileWork (command_id, generation, ordinal, track_file_id, identity_snapshot, status)
        VALUES (19285, 1, 15316, 42, '{}', 'pending')`).run();
    raw.prepare(`INSERT INTO CommandRenamePlans (command_id, config_revision, total, cursor, result)
        VALUES (7, 'old', 10, 4, '{}')`).run();
    migrateFileWorkRestartResume(raw);
    const plan = raw.prepare("SELECT cursor, total FROM CommandFileWorkPlans WHERE command_id = 19285").get() as {
        cursor: number; total: number;
    };
    assert.deepEqual(plan, { cursor: 15316, total: 24502 });
    assert.equal((raw.prepare("SELECT restart_claims FROM CommandFileWork WHERE command_id = 19285").get() as { restart_claims: number }).restart_claims, 0);
    const names = (table: string) => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
    assert.equal(names("CommandFileWorkPlans").includes("plan_complete"), false);
    assert.equal(names("CommandRenamePlans").includes("plan_complete"), false);
    assert.equal(names("CommandFileWork").includes("restart_claims"), true);
    assert.equal(names("CommandRenameWork").includes("restart_claims"), true);
    assert.equal((raw.prepare("SELECT value FROM config WHERE key = 'schema.migration.file-work-restart-resume'").get() as { value: string }).value, "applied");
    assert.equal(Number(raw.pragma("user_version", { simple: true })), 0);
    raw.prepare("UPDATE CommandFileWork SET restart_claims = 3 WHERE command_id = 19285").run();
    migrateFileWorkRestartResume(raw);
    assert.deepEqual(raw.prepare("SELECT cursor, total FROM CommandFileWorkPlans WHERE command_id = 19285").get(), { cursor: 15316, total: 24502 });
    assert.equal((raw.prepare("SELECT restart_claims FROM CommandFileWork WHERE command_id = 19285").get() as { restart_claims: number }).restart_claims, 3);
    raw.close();

    const bare = new Database(":memory:");
    bare.exec(`
        CREATE TABLE CommandFileWork (command_id INTEGER PRIMARY KEY);
        CREATE TABLE CommandRenameWork (command_id INTEGER PRIMARY KEY);
    `);
    migrateFileWorkRestartResume(bare);
    migrateFileWorkRestartResume(bare);
    assert.equal((bare.prepare("PRAGMA table_info(CommandFileWork)").all() as Array<{ name: string }>).some(column => column.name === "restart_claims"), true);
    bare.close();

    assert.equal(Number(database.db.pragma("user_version", { simple: true })), 46);
    const held = claim(queue.CommandNames.RetagFiles, { ids: [ids[0]] });
    database.db.prepare(`INSERT INTO CommandFileWorkPlans (command_id, operation, config_revision, total)
        VALUES (?, 'retag', 'later', 1)`).run(held.id);
    migrateFileWorkRestartResume(database.db);
    assert.deepEqual(database.db.prepare("SELECT cursor, total FROM CommandFileWorkPlans WHERE command_id = ?").get(held.id), { cursor: 0, total: 1 });
    assert.equal((database.db.prepare("PRAGMA table_info(CommandFileWorkPlans)").all() as Array<{ name: string }>).some(column => column.name === "plan_complete"), true);
    assert.equal((database.db.prepare("SELECT plan_complete FROM CommandFileWorkPlans WHERE command_id = ?").get(held.id) as { plan_complete: number }).plan_complete, 1);
});

test("album scheduling migration keeps a checkpointed retag and copies the v1 stamp", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { migrateRetagAlbumScheduling } = await import("../../database/schema/retag-album-scheduling.js");
    const raw = new Database(":memory:");
    raw.exec(`
        CREATE TABLE CommandFileWorkPlans (
            command_id INTEGER PRIMARY KEY, operation TEXT NOT NULL, config_revision TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1, total INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
            retagged INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
            missing INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE CommandRenamePlans (
            command_id INTEGER PRIMARY KEY, config_revision TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
            total INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL);
        CREATE TABLE TrackFiles (
            id INTEGER PRIMARY KEY, file_hash TEXT);
        CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    `);
    raw.prepare(`INSERT INTO CommandFileWorkPlans (command_id, operation, config_revision, total, cursor)
        VALUES (19285, 'retag', 'old', 24502, 15316)`).run();
    raw.prepare("INSERT INTO CommandRenamePlans (command_id, config_revision, total, cursor, result) VALUES (7, 'old', 10, 4, '{}')").run();
    raw.prepare("INSERT INTO TrackFiles (id, file_hash) VALUES (1, 'retag:v1:abc'), (2, 'sha256:real')").run();
    const before = Number(raw.pragma("user_version", { simple: true }));
    migrateRetagAlbumScheduling(raw);
    migrateRetagAlbumScheduling(raw);
    assert.equal(Number(raw.pragma("user_version", { simple: true })), before);
    assert.deepEqual(raw.prepare("SELECT cursor, total, plan_complete FROM CommandFileWorkPlans WHERE command_id = 19285").get(), {
        cursor: 15316, total: 24502, plan_complete: 1,
    });
    assert.equal((raw.prepare("SELECT plan_complete FROM CommandRenamePlans WHERE command_id = 7").get() as { plan_complete: number }).plan_complete, 1);
    assert.equal((raw.prepare("SELECT managed_tag_fingerprint FROM TrackFiles WHERE id = 1").get() as { managed_tag_fingerprint: string }).managed_tag_fingerprint, "retag:v1:abc");
    assert.equal((raw.prepare("SELECT managed_tag_fingerprint FROM TrackFiles WHERE id = 2").get() as { managed_tag_fingerprint: string | null }).managed_tag_fingerprint, null);
    assert.equal((raw.prepare("SELECT value FROM config WHERE key = 'schema.migration.retag-album-scheduling'").get() as { value: string }).value, "applied");
    raw.close();
    assert.equal(Number(database.db.pragma("user_version", { simple: true })), 46);
});

test("startup recovery resumes a mid-retag checkpoint and finishes only the unsettled files", async (t) => {
    const job = claim(queue.CommandNames.RetagArtist, { artistId: "restart-artist" });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare(ids));
    database.db.prepare(`UPDATE CommandFileWork SET status = 'settled', skipped = 1, intent_path = ?, settled_at = '2026-10-18T00:00:00.000Z'
        WHERE command_id = ? AND ordinal = ?`).run("settled-0", job.id, 0);
    database.db.prepare(`UPDATE CommandFileWork SET status = 'settled', skipped = 1, intent_path = ?, settled_at = '2026-10-18T00:00:00.000Z'
        WHERE command_id = ? AND ordinal = ?`).run("settled-1", job.id, 1);
    database.db.prepare(`UPDATE CommandFileWork SET status = 'started', intent_path = 'in-flight', restart_claims = 0
        WHERE command_id = ? AND ordinal = ?`).run(job.id, 2);
    database.db.prepare("UPDATE CommandFileWorkPlans SET cursor = 2, skipped = 2 WHERE command_id = ?").run(job.id);
    stampRunning(job.id, 4);
    const move = claim(queue.CommandNames.MoveArtist, {
        artistId: "9", sourcePath: "/tmp/from", destinationPath: "/tmp/to", moveFiles: false,
    }, "move-owner");

    const sequence: string[] = [];
    const applied: number[] = [];
    const originalJournal = journal.FileMutationJournal.recoverPending;
    t.mock.method(journal.FileMutationJournal, "recoverPending", async () => {
        sequence.push("journal");
        return originalJournal.call(journal.FileMutationJournal);
    });
    const originalRequeue = queue.CommandQueueManager.requeueFromCheckpoint;
    t.mock.method(queue.CommandQueueManager, "requeueFromCheckpoint", function requeue(this: unknown, ...args: unknown[]) {
        sequence.push("requeue");
        return originalRequeue.apply(queue.CommandQueueManager, args as never);
    });
    mockRetagApply(t, applied, sequence);
    const planned = t.mock.method(records.CommandFileWorkRepository, "create");

    await bootRecovery(t);

    const resumed = commandRow(job.id);
    const payload = JSON.parse(resumed.payload) as { description?: string; restartResume?: { settled: number; total: number; skippedFiles: number } };
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.attempt, 4);
    assert.equal(resumed.started_at, STARTED_AT);
    assert.equal(resumed.progress, 50);
    assert.equal(resumed.progress_phase, "resumed after restart");
    assert.equal(resumed.progress_current, 2);
    assert.equal(resumed.progress_total, 4);
    assert.equal(resumed.blocked_reason, "resumed after restart");
    assert.equal(payload.description, "Retag — resumed after restart, 2/4 files already settled");
    assert.deepEqual(payload.restartResume, {
        version: 1,
        reason: "Discogenius process restarted while command was running",
        settled: 2,
        total: 4,
        skippedFiles: 0,
        count: 1,
    });
    const visible = history.getActivityPage({ statuses: ["queued"], types: ["RetagArtist"], categories: ["scans"] });
    const item = visible.items.find(entry => entry.id === job.id);
    assert.equal(item?.statusMessage, "Resumed after restart");
    assert.equal(item?.description, payload.description);
    const inFlight = database.db.prepare(`SELECT status, restart_claims, intent_path FROM CommandFileWork
        WHERE command_id = ? AND ordinal = 2`).get(job.id) as { status: string; restart_claims: number; intent_path: string };
    assert.deepEqual(inFlight, { status: "pending", restart_claims: 1, intent_path: "in-flight" });
    assert.equal(commandRow(move.id).status, "failed");
    assert.equal(commandRow(move.id).blocked_reason, "poisoned command");
    assert.match(commandRow(move.id).error ?? "", /execution attempt/);
    assert.equal(sequence[0], "journal");
    assert.ok(sequence.includes("requeue"));
    assert.equal(planned.mock.callCount(), 0);
    const settledBefore = database.db.prepare(`SELECT ordinal, track_file_id, status, intent_path, skipped, error FROM CommandFileWork
        WHERE command_id = ? AND ordinal < 2 ORDER BY ordinal`).all(job.id);

    const next = queue.CommandQueueManager.claimForExecution(job.id, "resume-owner", 60_000);
    assert.ok(next);
    const claimed = commandRow(job.id);
    assert.equal(claimed.started_at, STARTED_AT);
    assert.equal(claimed.progress_current, 2);
    assert.equal(claimed.progress_total, 4);
    assert.equal(claimed.attempt, 5);
    await context.executeCommand(next);
    assert.deepEqual(applied, [ids[2], ids[3]]);
    assert.ok(sequence.indexOf("journal") < sequence.indexOf("apply"));
    assert.ok(sequence.lastIndexOf("requeue") < sequence.indexOf("apply"));
    assert.deepEqual(database.db.prepare(`SELECT ordinal, track_file_id, status, intent_path, skipped, error FROM CommandFileWork
        WHERE command_id = ? AND ordinal < 2 ORDER BY ordinal`).all(job.id), settledBefore);
    const plan = records.CommandFileWorkRepository.get(job.id)!;
    assert.equal(plan.cursor, 4);
    assert.equal(plan.total, 4);
    assert.equal(plan.skipped, 4);
    assert.equal(plan.retagged, 0);
    assert.equal(plan.missing, 0);
    assert.equal(plan.error_count, 0);
    assert.deepEqual(records.CommandFileWorkRepository.errors(job.id), []);
    assert.equal(commandRow(job.id).status, "completed");
    assert.equal(commandRow(job.id).progress, 100);
    assert.equal(planned.mock.callCount(), 0);
    assert.equal((database.db.prepare("SELECT restart_claims FROM CommandFileWork WHERE command_id = ? AND ordinal = 2").get(job.id) as { restart_claims: number }).restart_claims, 1);
});

test("a crash during the tag write is claimed before the file is opened", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids: [ids[0]] });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0]]));
    t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
        apply: async () => { throw new Error("process killed during write"); },
        close: () => {},
    }));
    await assert.rejects(
        retag.runRetagWorkUnit(job, context.buildHandlerContext(), () => { throw new Error("must not reselect"); }),
        /process killed during write/,
    );
    assert.equal((database.db.prepare("SELECT status, restart_claims FROM CommandFileWork WHERE command_id = ?").get(job.id) as { status: string; restart_claims: number }).status, "started");
    await bootRecovery(t);
    const row = database.db.prepare("SELECT status, restart_claims FROM CommandFileWork WHERE command_id = ?").get(job.id) as { status: string; restart_claims: number };
    assert.deepEqual(row, { status: "pending", restart_claims: 1 });
    assert.equal(commandRow(job.id).status, "queued");
    assert.match(JSON.parse(commandRow(job.id).payload).description as string, /resumed after restart/);
});

test("a crash after one settle leaves exactly the next file claimed", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids: [ids[0], ids[1], ids[2]] });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0], ids[1], ids[2]]));
    let opened = 0;
    t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
        apply: async (fileIds: number[]) => {
            opened += 1;
            if (opened === 2) throw new Error("process killed during write");
            assert.deepEqual(fileIds, [ids[0]]);
            return { retagged: 0, skipped: 1, missing: 0, errors: [] };
        },
        close: () => {},
    }));
    await assert.rejects(
        retag.runRetagWorkUnit(job, context.buildHandlerContext(), () => { throw new Error("must not reselect"); }),
        /process killed during write/,
    );
    assert.deepEqual(database.db.prepare("SELECT ordinal, status FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id), [
        { ordinal: 0, status: "started" },
        { ordinal: 1, status: "started" },
        { ordinal: 2, status: "started" },
    ]);
    await bootRecovery(t);
    assert.deepEqual(database.db.prepare("SELECT ordinal, status, restart_claims FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id), [
        { ordinal: 0, status: "pending", restart_claims: 1 },
        { ordinal: 1, status: "pending", restart_claims: 1 },
        { ordinal: 2, status: "pending", restart_claims: 1 },
    ]);
    assert.equal(commandRow(job.id).status, "queued");
});

test("a second create leaves the existing plan unchanged", () => {
    const job = claim(queue.CommandNames.RetagFiles, { ids });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0], ids[1]]));
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare(ids));
    const rows = database.db.prepare("SELECT track_file_id FROM CommandFileWork WHERE command_id = ? ORDER BY ordinal").all(job.id) as Array<{ track_file_id: number }>;
    assert.deepEqual(rows.map(row => row.track_file_id), [ids[0], ids[1]]);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.total, 2);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 0);
});

test("a file that crashes across restarts is skipped and the command still completes", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids: [ids[0], ids[1]] });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0], ids[1]]));
    database.db.prepare(`UPDATE CommandFileWork SET status = 'settled', skipped = 1 WHERE command_id = ? AND ordinal = 0`).run(job.id);
    database.db.prepare(`UPDATE CommandFileWork SET status = 'started', restart_claims = ? WHERE command_id = ? AND ordinal = 1`)
        .run(policy.FILE_CHECKPOINT_RESTART_LIMIT - 1, job.id);
    database.db.prepare("UPDATE CommandFileWorkPlans SET cursor = 1, skipped = 1 WHERE command_id = ?").run(job.id);
    stampRunning(job.id, 3);
    const applied: number[] = [];
    mockRetagApply(t, applied);
    await bootRecovery(t);
    const poisoned = database.db.prepare(`SELECT status, restart_claims, skipped, error FROM CommandFileWork
        WHERE command_id = ? AND ordinal = 1`).get(job.id) as { status: string; restart_claims: number; skipped: number; error: string };
    assert.equal(poisoned.status, "settled");
    assert.equal(poisoned.restart_claims, policy.FILE_CHECKPOINT_RESTART_LIMIT);
    assert.equal(poisoned.skipped, 1);
    assert.equal(JSON.parse(poisoned.error)[0], policy.FILE_CHECKPOINT_POISON_ERROR);
    assert.equal(commandRow(job.id).status, "queued");
    const next = queue.CommandQueueManager.claimForExecution(job.id, "resume-owner", 60_000)!;
    await context.executeCommand(next);
    assert.deepEqual(applied, []);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM CommandFileWork WHERE command_id = ? AND generation = 2").get(job.id) as { n: number }).n, 0);
    const plan = records.CommandFileWorkRepository.get(job.id)!;
    assert.equal(plan.cursor, 2);
    assert.equal(plan.skipped, 2);
    assert.equal(plan.error_count, 1);
    assert.deepEqual(records.CommandFileWorkRepository.errors(job.id), [{ id: ids[1], error: policy.FILE_CHECKPOINT_POISON_ERROR }]);
    assert.equal(commandRow(job.id).status, "completed");
    assert.equal(commandRow(job.id).error, null);
});

test("a file under the restart bound is reclaimed and processed", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids: [ids[0]] });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0]]));
    database.db.prepare("UPDATE CommandFileWork SET status = 'started', restart_claims = ? WHERE command_id = ?")
        .run(policy.FILE_CHECKPOINT_RESTART_LIMIT - 2, job.id);
    stampRunning(job.id, 2);
    const applied: number[] = [];
    mockRetagApply(t, applied);
    await bootRecovery(t);
    assert.equal((database.db.prepare("SELECT status, restart_claims FROM CommandFileWork WHERE command_id = ?").get(job.id) as { status: string; restart_claims: number }).restart_claims, policy.FILE_CHECKPOINT_RESTART_LIMIT - 1);
    const next = queue.CommandQueueManager.claimForExecution(job.id, "resume-owner", 60_000)!;
    await context.executeCommand(next);
    assert.deepEqual(applied, [ids[0]]);
    assert.equal(commandRow(job.id).status, "completed");
    assert.equal(records.CommandFileWorkRepository.errors(job.id).length, 0);
});

test("a rename checkpoint resumes settled files and a poison rename file does not fail the command", async (t) => {
    const job = claim(queue.CommandNames.RenameArtist, { artistId: "restart-artist" });
    let capture = false;
    const renamed: number[] = [];
    t.mock.method(renames.RenameTrackFileService, "executeRenameFiles", async (fileIds: number[]) => {
        if (capture) renamed.push(...fileIds);
        return { renamed: 0, skipped: 0, conflicts: 0, missing: 1, cleanedDirectories: 0, errors: [] };
    });
    t.mock.method(renames.RenameTrackFileService, "getRenameWorkIds", () => {
        throw new Error("library scan");
    });
    await rename.runRenameWorkUnit(job, context.buildHandlerContext(), () => [ids[0], ids[1]], true);
    const aggregate = JSON.parse((database.db.prepare("SELECT result FROM CommandRenamePlans WHERE command_id = ?").get(job.id) as { result: string }).result) as { missing: number };
    aggregate.missing = 1;
    database.db.prepare("UPDATE CommandRenamePlans SET cursor = 1, result = ? WHERE command_id = ?").run(JSON.stringify(aggregate), job.id);
    database.db.prepare("UPDATE CommandRenameWork SET status = 'started', result = NULL, restart_claims = 0 WHERE command_id = ? AND ordinal = 1").run(job.id);
    stampRunning(job.id, 4);
    await bootRecovery(t);
    assert.equal(commandRow(job.id).status, "queued");
    assert.match(JSON.parse(commandRow(job.id).payload).description as string, /resumed after restart, 1\/2 files already settled/);
    assert.equal((database.db.prepare("SELECT status FROM CommandRenameWork WHERE command_id = ? AND ordinal = 0").get(job.id) as { status: string }).status, "settled");
    assert.deepEqual(database.db.prepare("SELECT status, restart_claims FROM CommandRenameWork WHERE command_id = ? AND ordinal = 1").get(job.id), {
        status: "pending", restart_claims: 1,
    });
    capture = true;
    const next = queue.CommandQueueManager.claimForExecution(job.id, "resume-owner", 60_000)!;
    await context.executeCommand(next);
    assert.deepEqual(renamed, [ids[1]]);
    assert.equal(commandRow(job.id).status, "completed");
});

test("a poison rename file is skipped and the command still completes", async (t) => {
    const poison = claim(queue.CommandNames.RenameArtist, { artistId: "restart-artist" });
    let armed = false;
    let poisonCalls = 0;
    t.mock.method(renames.RenameTrackFileService, "executeRenameFiles", async (fileIds: number[]) => {
        if (armed) poisonCalls += fileIds.length;
        return { renamed: 0, skipped: 0, conflicts: 0, missing: 1, cleanedDirectories: 0, errors: [] };
    });
    t.mock.method(renames.RenameTrackFileService, "getRenameWorkIds", () => {
        throw new Error("library scan");
    });
    await rename.runRenameWorkUnit(poison, context.buildHandlerContext(), () => [ids[2]], true);
    database.db.prepare(`UPDATE CommandRenameWork SET status = 'started', restart_claims = ?, result = NULL WHERE command_id = ?`)
        .run(policy.FILE_CHECKPOINT_RESTART_LIMIT - 1, poison.id);
    database.db.prepare("UPDATE CommandRenamePlans SET cursor = 0, result = ? WHERE command_id = ?")
        .run(JSON.stringify({ renamed: 0, skipped: 0, conflicts: 0, missing: 0, cleanedDirectories: 0, errors: [] }), poison.id);
    stampRunning(poison.id, 4);
    armed = true;
    await bootRecovery(t);
    const resumedPoison = queue.CommandQueueManager.claimForExecution(poison.id, "resume-owner", 60_000)!;
    await context.executeCommand(resumedPoison);
    assert.equal(poisonCalls, 0);
    assert.equal(commandRow(poison.id).status, "completed");
    const stored = JSON.parse((database.db.prepare("SELECT result FROM CommandRenameWork WHERE command_id = ?").get(poison.id) as { result: string }).result) as {
        skipped: number; errors: Array<{ error: string }>;
    };
    assert.equal(stored.skipped, 1);
    assert.equal(stored.errors[0].error, policy.FILE_CHECKPOINT_POISON_ERROR);
});

test("generic recovery still poison-fails a checkpoint command when the checkpoint path is not used", () => {
    const job = claim(queue.CommandNames.RetagArtist, { artistId: "restart-artist" });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0]]));
    records.CommandFileWorkRepository.begin(job.id, job.worker_id!);
    const outcome = queue.CommandQueueManager.recoverOwnedCommand({
        id: job.id,
        workerId: job.worker_id!,
        reason: "process interrupted",
        maxAttempts: 1,
        retryDelayMs: 0,
    });
    assert.equal(outcome.outcome, "failed");
    assert.equal(commandRow(job.id).blocked_reason, "poisoned command");
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, 0);
});

test("a retag with no plan yet is requeued and plans once", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids });
    stampRunning(job.id, 5);
    const applied: number[] = [];
    mockRetagApply(t, applied);
    const planned = t.mock.method(records.CommandFileWorkRepository, "openPlan");
    await bootRecovery(t);
    assert.equal(commandRow(job.id).status, "queued");
    assert.equal(commandRow(job.id).progress, 1);
    assert.match(JSON.parse(commandRow(job.id).payload).description as string, /choosing files/);
    const next = queue.CommandQueueManager.claimForExecution(job.id, "resume-owner", 60_000)!;
    await context.executeCommand(next);
    assert.equal(planned.mock.callCount(), 1);
    assert.deepEqual(applied, ids);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.total, ids.length);
    assert.equal(records.CommandFileWorkRepository.get(job.id)?.cursor, ids.length);
    assert.equal(commandRow(job.id).status, "completed");
});

test("five resumes with no cursor progress fail the command", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids });
    stampRunning(job.id, 2);
    const planned = t.mock.method(records.CommandFileWorkRepository, "create");
    for (let resume = 1; resume < policy.FILE_CHECKPOINT_COMMAND_STALL_LIMIT; resume += 1) {
        await bootRecovery(t);
        const row = commandRow(job.id);
        assert.equal(row.status, "queued");
        assert.equal(row.attempt, 2);
        const marker = JSON.parse(row.payload).restartResume as { count: number; settled: number };
        assert.equal(marker.count, resume);
        assert.equal(marker.settled, 0);
        database.db.prepare("UPDATE commands SET status = 'started', worker_id = 'previous-process' WHERE id = ?").run(job.id);
    }
    await bootRecovery(t);
    const failed = commandRow(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempt, 2);
    assert.equal(failed.blocked_reason, policy.FILE_CHECKPOINT_COMMAND_STALL_REASON);
    assert.equal(failed.error, policy.fileCheckpointCommandStallError(policy.FILE_CHECKPOINT_COMMAND_STALL_LIMIT));
    assert.equal(JSON.parse(failed.payload).restartResume.count, policy.FILE_CHECKPOINT_COMMAND_STALL_LIMIT);
    assert.equal(planned.mock.callCount(), 0);
    assert.equal(records.CommandFileWorkRepository.get(job.id), undefined);
});

test("cursor progress resets the restart stall count", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids: [ids[0], ids[1]] });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0], ids[1]]));
    database.db.prepare("UPDATE CommandFileWork SET status = 'started' WHERE command_id = ? AND ordinal = 0").run(job.id);
    stampRunning(job.id, 3);
    await bootRecovery(t);
    assert.equal(JSON.parse(commandRow(job.id).payload).restartResume.count, 1);

    database.db.prepare("UPDATE CommandFileWork SET status = 'settled', skipped = 1 WHERE command_id = ? AND ordinal = 0").run(job.id);
    database.db.prepare("UPDATE CommandFileWork SET status = 'started' WHERE command_id = ? AND ordinal = 1").run(job.id);
    database.db.prepare("UPDATE CommandFileWorkPlans SET cursor = 1, skipped = 1 WHERE command_id = ?").run(job.id);
    database.db.prepare("UPDATE commands SET status = 'started', worker_id = 'previous-process' WHERE id = ?").run(job.id);
    await bootRecovery(t);
    const progressed = JSON.parse(commandRow(job.id).payload).restartResume as { count: number; settled: number };
    assert.equal(commandRow(job.id).status, "queued");
    assert.equal(commandRow(job.id).attempt, 3);
    assert.equal(progressed.settled, 1);
    assert.equal(progressed.count, 0);

    database.db.prepare("UPDATE commands SET status = 'started', worker_id = 'previous-process' WHERE id = ?").run(job.id);
    await bootRecovery(t);
    const again = JSON.parse(commandRow(job.id).payload).restartResume as { count: number; settled: number };
    assert.equal(commandRow(job.id).status, "queued");
    assert.equal(again.settled, 1);
    assert.equal(again.count, 1);
});

test("skipping a poison file counts as checkpoint progress", async (t) => {
    const job = claim(queue.CommandNames.RetagFiles, { ids: [ids[0]] });
    records.CommandFileWorkRepository.create(job.id, job.worker_id!, retag.retagPlanRevision(), records.CommandFileWorkRepository.prepare([ids[0]]));
    database.db.prepare("UPDATE CommandFileWork SET status = 'started', restart_claims = ? WHERE command_id = ?")
        .run(policy.FILE_CHECKPOINT_RESTART_LIMIT - 1, job.id);
    const payload = JSON.parse(commandRow(job.id).payload) as { restartResume?: unknown };
    payload.restartResume = {
        version: 1,
        reason: "earlier restart",
        settled: 0,
        total: 1,
        skippedFiles: 0,
        count: policy.FILE_CHECKPOINT_COMMAND_STALL_LIMIT - 1,
    };
    database.db.prepare("UPDATE commands SET payload = ? WHERE id = ?").run(JSON.stringify(payload), job.id);
    stampRunning(job.id, 4);
    await bootRecovery(t);
    const row = commandRow(job.id);
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 4);
    assert.notEqual(row.blocked_reason, policy.FILE_CHECKPOINT_COMMAND_STALL_REASON);
    const resume = JSON.parse(row.payload).restartResume as { count: number; settled: number };
    assert.equal(resume.settled, 1);
    assert.equal(resume.count, 0);
    const file = database.db.prepare("SELECT status, error FROM CommandFileWork WHERE command_id = ?").get(job.id) as { status: string; error: string };
    assert.equal(file.status, "settled");
    assert.equal(JSON.parse(file.error)[0], policy.FILE_CHECKPOINT_POISON_ERROR);
});

test("a rename killed after the move restores the file and renames it once", async (t) => {
    const source = path.join(tempDir, "rename-crash", "source.flac");
    const dest = path.join(tempDir, "rename-crash", "dest.flac");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "rename crash fixture");
    const artist = (database.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'restart-artist'").get() as { id: number }).id;
    const recording = (database.db.prepare("SELECT id FROM Recordings WHERE mbid = 'restart-recording'").get() as { id: number }).id;
    const fileId = Number(database.db.prepare(`
        INSERT INTO TrackFiles (artist_metadata_id, recording_id, file_path, filename, relative_path, library_root, extension, file_type, library_slot)
        VALUES (?, ?, ?, 'source.flac', 'source.flac', ?, 'flac', 'track', 'stereo')
    `).run(artist, recording, source, path.dirname(source)).lastInsertRowid);
    const job = claim(queue.CommandNames.RenameFiles, { ids: [fileId] });
    let phase: "crash" | "resume" = "crash";
    let resumeMoves = 0;
    const originalMove = journal.FileMutationJournal.move.bind(journal.FileMutationJournal);
    t.mock.method(journal.FileMutationJournal, "move", async (id: string) => {
        if (phase === "resume") resumeMoves += 1;
        return originalMove(id);
    });
    t.mock.method(renames.RenameTrackFileService, "executeRenameFiles", async (fileIds: number[]) => {
        assert.deepEqual(fileIds, [fileId]);
        if (phase === "crash") {
            const intent = await journal.FileMutationJournal.prepare("TrackFiles", fileId, source, source, dest);
            await journal.FileMutationJournal.move(intent);
            throw new Error("process killed after move");
        }
        assert.equal(fs.existsSync(source), true);
        assert.equal(fs.existsSync(dest), false);
        assert.equal(journal.FileMutationJournal.hasPending(), false);
        const intent = await journal.FileMutationJournal.prepare("TrackFiles", fileId, source, source, dest);
        await journal.FileMutationJournal.move(intent);
        database.db.transaction(() => {
            journal.FileMutationJournal.assertBeforeCommit(intent);
            database.db.prepare("UPDATE TrackFiles SET file_path = ? WHERE id = ?").run(dest, fileId);
            journal.FileMutationJournal.markCommitted(intent);
        })();
        await journal.FileMutationJournal.recoverOne(intent);
        return { renamed: 1, skipped: 0, conflicts: 0, missing: 0, cleanedDirectories: 0, errors: [] };
    });

    await assert.rejects(
        rename.runRenameWorkUnit(job, context.buildHandlerContext(), () => [fileId], false),
        /process killed after move/,
    );
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(dest, "utf8"), "rename crash fixture");
    assert.equal((database.db.prepare("SELECT file_path FROM TrackFiles WHERE id = ?").get(fileId) as { file_path: string }).file_path, source);
    assert.equal((database.db.prepare("SELECT status FROM CommandRenameWork WHERE command_id = ?").get(job.id) as { status: string }).status, "started");
    assert.equal(journal.FileMutationJournal.hasPending(), true);

    const sequence: string[] = [];
    const originalRecover = journal.FileMutationJournal.recoverPending.bind(journal.FileMutationJournal);
    t.mock.method(journal.FileMutationJournal, "recoverPending", async () => {
        const errors = await originalRecover();
        assert.deepEqual(errors, []);
        assert.equal(fs.readFileSync(source, "utf8"), "rename crash fixture");
        assert.equal(fs.existsSync(dest), false);
        sequence.push("journal");
        return errors;
    });
    const originalRequeue = queue.CommandQueueManager.requeueFromCheckpoint;
    t.mock.method(queue.CommandQueueManager, "requeueFromCheckpoint", function requeue(this: unknown, ...args: unknown[]) {
        sequence.push("requeue");
        return originalRequeue.apply(queue.CommandQueueManager, args as never);
    });

    phase = "resume";
    await bootRecovery(t);
    assert.deepEqual(sequence, ["journal", "requeue"]);
    assert.equal(journal.FileMutationJournal.hasPending(), false);
    assert.equal(resumeMoves, 0);
    assert.deepEqual(database.db.prepare("SELECT status, restart_claims FROM CommandRenameWork WHERE command_id = ?").get(job.id), {
        status: "pending", restart_claims: 1,
    });
    assert.equal(commandRow(job.id).status, "queued");

    const next = queue.CommandQueueManager.claimForExecution(job.id, "resume-owner", 60_000)!;
    await context.executeCommand(next);
    assert.equal(resumeMoves, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(dest, "utf8"), "rename crash fixture");
    assert.equal((database.db.prepare("SELECT file_path FROM TrackFiles WHERE id = ?").get(fileId) as { file_path: string }).file_path, dest);
    assert.equal(journal.FileMutationJournal.hasPending(), false);
    assert.equal(commandRow(job.id).status, "completed");
    const stored = JSON.parse((database.db.prepare("SELECT result FROM CommandRenameWork WHERE command_id = ?").get(job.id) as { result: string }).result) as { renamed: number };
    assert.equal(stored.renamed, 1);
});
