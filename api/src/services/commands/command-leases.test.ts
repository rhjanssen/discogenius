import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-command-leases-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.command-leases.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_SCHEDULER_THREAD_LIMIT = "1";

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("./command-queue-manager.js");
let poolModule: typeof import("./worker/command-worker-pool.js");

before(async () => {
    dbModule = await import("../../database.js");
    queueModule = await import("./command-queue-manager.js");
    poolModule = await import("./worker/command-worker-pool.js");
    dbModule.initDatabase();
});

beforeEach(async () => {
    if (poolModule.CommandWorkerPool.isActive()) {
        await poolModule.CommandWorkerPool.stop();
    }
    poolModule.CommandWorkerPool.configureTestWorkerEntry(null);
    dbModule.db.prepare("DELETE FROM commands").run();
});

after(async () => {
    if (poolModule.CommandWorkerPool.isActive()) {
        await poolModule.CommandWorkerPool.stop();
    }
    poolModule.CommandWorkerPool.configureTestWorkerEntry(null);
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function queueCommand(
    behavior = "complete",
    durationMs = 25,
): number {
    return queueModule.CommandQueueManager.push(
        queueModule.CommandNames.CheckHealth,
        { testBehavior: behavior, testDurationMs: durationMs } as any,
        undefined,
    );
}

function queueNamedCommand(
    name: typeof queueModule.CommandNames[keyof typeof queueModule.CommandNames],
    payload: Record<string, unknown>,
    refId?: string,
): number {
    return queueModule.CommandQueueManager.push(name as any, payload as any, refId);
}

function claim(
    id: number,
    workerId: string,
    now: Date,
    leaseMs = 100,
) {
    const job = queueModule.CommandQueueManager.claimForExecution(
        id,
        workerId,
        leaseMs,
        now,
    );
    assert.ok(job, "expected queued command to be claimed");
    return job;
}

async function waitFor(
    predicate: () => boolean,
    message: string,
    timeoutMs = 3_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(message);
}

test("healthy long-running attempt renews its lease and progress is ownership guarded", () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const id = queueCommand();
    const job = claim(id, "attempt-healthy", started, 1_000);

    assert.equal(job.attempt, 1);
    assert.equal(job.worker_id, "attempt-healthy");
    assert.equal(job.heartbeat_at, started.toISOString());
    assert.equal(job.last_progress_at, started.toISOString());

    assert.equal(
        queueModule.CommandQueueManager.renewLease(
            id,
            "attempt-healthy",
            1_000,
            new Date("2026-01-01T00:00:00.800Z"),
        ),
        true,
    );
    assert.deepEqual(
        queueModule.CommandQueueManager.findStaleExecutionLeases({
            types: [queueModule.CommandNames.CheckHealth],
            now: new Date("2026-01-01T00:00:01.200Z"),
        }),
        [],
    );

    assert.equal(
        queueModule.CommandQueueManager.updateState(id, {
            workerId: "wrong-attempt",
            progress: 50,
            progressPhase: "must be ignored",
        }),
        null,
    );
    const updated = queueModule.CommandQueueManager.updateState(id, {
        workerId: "attempt-healthy",
        progress: 50,
        progressPhase: "validating",
        progressCurrent: 5,
        progressTotal: 10,
    });
    assert.equal(updated?.progress, 50);
    assert.equal(updated?.progress_phase, "validating");
    assert.equal(updated?.progress_current, 5);
    assert.equal(updated?.progress_total, 10);
    assert.ok(updated?.last_progress_at);
});

test("stopped heartbeat expires the lease and recovery persists reason and backoff", () => {
    const started = new Date("2099-01-01T00:00:00.000Z");
    const id = queueCommand("hang");
    claim(id, "attempt-stopped", started, 100);

    const stale = queueModule.CommandQueueManager.findStaleExecutionLeases({
        types: [queueModule.CommandNames.CheckHealth],
        now: new Date("2099-01-01T00:00:00.101Z"),
    });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].reason, "lease expired");

    const recovered = queueModule.CommandQueueManager.recoverOwnedCommand({
        id,
        workerId: "attempt-stopped",
        reason: "heartbeat stopped",
        maxAttempts: 3,
        retryDelayMs: 250,
        now: new Date("2099-01-01T00:00:00.101Z"),
    });
    assert.equal(recovered.outcome, "requeued");
    assert.equal(recovered.attempt, 1);
    assert.equal(recovered.retryAfter, "2099-01-01T00:00:00.351Z");

    const row = queueModule.CommandQueueManager.get(id);
    assert.equal(row?.status, "queued");
    assert.equal(row?.worker_id, null);
    assert.equal(row?.last_retry_reason, "heartbeat stopped");
    assert.equal(row?.blocked_reason, "retry scheduled");
    assert.equal(row?.retry_after, "2099-01-01T00:00:00.351Z");
    assert.equal(
        queueModule.CommandQueueManager.getTopPendingJobsByTypes(
            [queueModule.CommandNames.CheckHealth],
        ).some((job) => job.id === id),
        false,
        "retry backoff must keep the queued command ineligible",
    );
});

test("opt-in no-progress detection respects a persisted blocked reason", () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const id = queueCommand("hang-heartbeat");
    claim(id, "attempt-no-progress", started, 60_000);

    const stale = queueModule.CommandQueueManager.findStaleExecutionLeases({
        types: [queueModule.CommandNames.CheckHealth],
        now: new Date("2026-01-01T00:00:00.101Z"),
        noProgressMs: 100,
    });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].reason, "progress stopped");

    assert.ok(queueModule.CommandQueueManager.updateState(id, {
        workerId: "attempt-no-progress",
        blockedReason: "waiting on provider",
    }));
    assert.deepEqual(
        queueModule.CommandQueueManager.findStaleExecutionLeases({
            types: [queueModule.CommandNames.CheckHealth],
            now: new Date("2026-01-01T00:00:00.200Z"),
            noProgressMs: 100,
        }),
        [],
    );
});

test("watchdog pass requeues a live-owner attempt whose configured progress expectation expired", async () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T00:00:01.001Z");
    const id = queueCommand("hang-heartbeat");
    claim(id, "attempt-watchdog", started, 60_000);
    assert.equal(
        queueModule.CommandQueueManager.renewLease(
            id,
            "attempt-watchdog",
            60_000,
            new Date("2026-01-01T00:00:01.000Z"),
        ),
        true,
    );

    const executorModule = await import("./command-executor.js");
    const result = executorModule.recoverStaleNonDownloadCommands({
        now,
        noProgressMs: 100,
        maxAttempts: 3,
        retryBaseMs: 0,
        retryMaxMs: 0,
    });
    assert.deepEqual(result, { requeued: 1, failed: 0, stale: 1 });
    const recovered = queueModule.CommandQueueManager.get(id);
    assert.equal(recovered?.status, "queued");
    assert.match(recovered?.last_retry_reason ?? "", /^progress stopped;/);
});

test("default policy recovers a heartbeat-alive never-resolving catalog handler", async () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T00:30:00.001Z");
    const id = queueNamedCommand(
        queueModule.CommandNames.RefreshArtist,
        {
            artistId: "artist-default-policy",
            artistName: "Artist",
            workflow: "metadata-refresh",
        },
        "artist-default-policy",
    );
    claim(id, "attempt-default-policy", started, 60_000);
    // The worker is demonstrably alive immediately before the watchdog pass,
    // but its command phase has not advanced for the catalog-stage expectation.
    assert.equal(
        queueModule.CommandQueueManager.renewLease(
            id,
            "attempt-default-policy",
            5 * 60_000,
            new Date(now.getTime() - 1),
        ),
        true,
    );

    const executorModule = await import("./command-executor.js");
    const result = executorModule.recoverStaleNonDownloadCommands({
        now,
        noProgressMs: 0,
        maxAttempts: 3,
        retryBaseMs: 0,
        retryMaxMs: 0,
    });
    assert.deepEqual(result, { requeued: 1, failed: 0, stale: 1 });
    assert.match(
        queueModule.CommandQueueManager.get(id)?.last_retry_reason ?? "",
        /^progress stopped;/,
    );

    const policyModule = await import("./command-liveness-policy.js");
    assert.equal(
        policyModule.resolveCommandNoProgressTimeoutMs(queueModule.CommandNames.RefreshArtist),
        30 * 60_000,
    );
    assert.equal(
        policyModule.resolveCommandNoProgressTimeoutMs(queueModule.CommandNames.RescanFolders),
        4 * 60 * 60_000,
    );
});

test("filesystem mutations fail closed instead of replaying without an operation journal", async () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T00:00:00.101Z");
    const id = queueNamedCommand(
        queueModule.CommandNames.MoveArtist,
        { artistId: "artist-unsafe", destinationRoot: "D:\\disposable" },
        "artist-unsafe",
    );
    claim(id, "attempt-unsafe", started, 60_000);
    assert.equal(
        queueModule.CommandQueueManager.renewLease(
            id,
            "attempt-unsafe",
            60_000,
            new Date(now.getTime() - 1),
        ),
        true,
    );

    const executorModule = await import("./command-executor.js");
    const result = executorModule.recoverStaleNonDownloadCommands({
        now,
        noProgressMs: 100,
        maxAttempts: 3,
        retryBaseMs: 0,
        retryMaxMs: 0,
    });
    assert.deepEqual(result, { requeued: 0, failed: 1, stale: 1 });
    const failed = queueModule.CommandQueueManager.get(id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.attempt, 1);
    assert.equal(failed?.blocked_reason, "poisoned command");
});

test("infrastructure retries are bounded and a poison command fails visibly", () => {
    const id = queueCommand("hang");
    const base = Date.parse("2026-01-01T00:00:00.000Z");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const now = new Date(base + attempt * 1_000);
        const workerId = `attempt-${attempt}`;
        const job = claim(id, workerId, now, 100);
        assert.equal(job.attempt, attempt);
        const recovered = queueModule.CommandQueueManager.recoverOwnedCommand({
            id,
            workerId,
            reason: `worker died on attempt ${attempt}`,
            maxAttempts: 3,
            retryDelayMs: 0,
            now: new Date(now.getTime() + 101),
        });
        assert.equal(recovered.outcome, attempt < 3 ? "requeued" : "failed");
    }

    const poisoned = queueModule.CommandQueueManager.get(id);
    assert.equal(poisoned?.status, "failed");
    assert.equal(poisoned?.attempt, 3);
    assert.equal(poisoned?.blocked_reason, "poisoned command");
    assert.match(poisoned?.error ?? "", /stopped after 3 execution attempt/);
    assert.equal(poisoned?.last_retry_reason, "worker died on attempt 3");
});

test("a recovered stale worker cannot progress, complete, fail, or recover the replacement attempt", () => {
    const id = queueCommand();
    const first = claim(id, "attempt-old", new Date("2026-01-01T00:00:00.000Z"), 100);
    assert.equal(first.attempt, 1);
    assert.equal(
        queueModule.CommandQueueManager.recoverOwnedCommand({
            id,
            workerId: "attempt-old",
            reason: "old worker stopped",
            maxAttempts: 3,
            retryDelayMs: 0,
            now: new Date("2026-01-01T00:00:00.101Z"),
        }).outcome,
        "requeued",
    );

    const replacement = claim(id, "attempt-new", new Date("2026-01-01T00:00:00.200Z"), 100);
    assert.equal(replacement.attempt, 2);
    assert.equal(queueModule.CommandQueueManager.complete(id, "attempt-old"), false);
    assert.equal(queueModule.CommandQueueManager.fail(id, "late failure", "attempt-old"), false);
    assert.equal(
        queueModule.CommandQueueManager.updateState(id, {
            workerId: "attempt-old",
            progress: 99,
            progressPhase: "late progress",
        }),
        null,
    );
    assert.equal(
        queueModule.CommandQueueManager.recoverOwnedCommand({
            id,
            workerId: "attempt-old",
            reason: "duplicate watchdog",
            maxAttempts: 3,
            retryDelayMs: 0,
        }).outcome,
        "not-owner",
    );

    const stillOwned = queueModule.CommandQueueManager.get(id);
    assert.equal(stillOwned?.status, "started");
    assert.equal(stillOwned?.worker_id, "attempt-new");
    assert.equal(stillOwned?.progress, 0);
    assert.equal(queueModule.CommandQueueManager.complete(id, "attempt-new"), true);
});

test("restart recovery records evidence and honors the poison limit", () => {
    const retryId = queueCommand();
    claim(retryId, "restart-attempt-1", new Date("2026-01-01T00:00:00.000Z"), 100);

    const poisonId = queueCommand();
    dbModule.db.prepare("UPDATE commands SET attempt = 2 WHERE id = ?").run(poisonId);
    claim(poisonId, "restart-attempt-3", new Date("2026-01-01T00:00:00.000Z"), 100);

    const recovered = queueModule.CommandQueueManager.recoverInterruptedJobsByTypes({
        types: [queueModule.CommandNames.CheckHealth],
        reason: "process restarted",
        maxAttempts: 3,
        now: new Date("2026-01-01T00:00:01.000Z"),
    });
    assert.deepEqual(recovered, { requeued: 1, failed: 1 });
    assert.equal(queueModule.CommandQueueManager.get(retryId)?.last_retry_reason, "process restarted");
    assert.equal(queueModule.CommandQueueManager.get(poisonId)?.status, "failed");
    assert.equal(queueModule.CommandQueueManager.get(poisonId)?.blocked_reason, "poisoned command");
});

test("stale Artist completion events cannot chain a replacement execution", async () => {
    const eventsModule = await import("./app-events.js");
    const listenerModule = await import("../music/curation.listener.js");
    listenerModule.initCurationListeners();

    const id = queueCommand();
    claim(id, "artist-attempt-old", new Date("2026-01-01T00:00:00.000Z"), 100);
    assert.equal(
        queueModule.CommandQueueManager.recoverOwnedCommand({
            id,
            workerId: "artist-attempt-old",
            reason: "lease expired",
            maxAttempts: 3,
            retryDelayMs: 0,
            now: new Date("2026-01-01T00:00:00.101Z"),
        }).outcome,
        "requeued",
    );
    claim(id, "artist-attempt-new", new Date("2026-01-01T00:00:00.200Z"), 100);

    eventsModule.appEvents.emit(eventsModule.AppEvent.ARTIST_REFRESH_COMPLETE, {
        commandId: id,
        workerId: "artist-attempt-old",
        artistId: "artist-1",
        artistName: "Artist",
        workflow: "monitoring-intake",
        scanLibrary: true,
        metadataChanged: true,
        isNewArtist: false,
        trigger: 2,
        priority: 0,
    });

    const chained = queueModule.CommandQueueManager.all("%", "queued", 20)
        .filter((job) => (
            job.name === queueModule.CommandNames.RescanFolders
            || job.name === queueModule.CommandNames.CurateArtist
        ));
    assert.deepEqual(chained, []);
});

test("pool abort recovers a never-resolving command and restores worker capacity", async () => {
    const fixtureExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const fixtureUrl = new URL(`./worker/command-worker-liveness.fixture${fixtureExt}`, import.meta.url);
    poolModule.CommandWorkerPool.configureTestWorkerEntry(fixtureUrl.href);
    poolModule.CommandWorkerPool.start();

    const id = queueCommand("hang-heartbeat");
    const claimed = claim(id, "attempt-hang", new Date(), 300);
    const claimedHeartbeatAt = claimed.heartbeat_at;
    const running = poolModule.CommandWorkerPool.run(claimed, {
        leaseMs: 300,
        heartbeatMs: 30,
    });

    await waitFor(
        () => poolModule.CommandWorkerPool.getSnapshot().workers.some(
            (worker) => worker.currentCommandId === id && worker.executionToken === "attempt-hang",
        ),
        "worker never accepted hanging command",
    );
    await waitFor(
        () => queueModule.CommandQueueManager.get(id)?.heartbeat_at !== claimedHeartbeatAt,
        "worker never renewed the durable command lease",
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(
        queueModule.CommandQueueManager.findStaleExecutionLeases({
            types: [queueModule.CommandNames.CheckHealth],
        }),
        [],
        "healthy heartbeats should keep a long-running command leased",
    );

    assert.equal(
        poolModule.CommandWorkerPool.abortCommand(id, "attempt-hang", "test watchdog abort"),
        true,
    );
    await assert.rejects(running, /test watchdog abort/);
    const recovery = queueModule.CommandQueueManager.recoverOwnedCommand({
        id,
        workerId: "attempt-hang",
        reason: "never-resolving handler",
        maxAttempts: 3,
        retryDelayMs: 0,
    });
    assert.equal(recovery.outcome, "requeued");

    await waitFor(
        () => {
            const snapshot = poolModule.CommandWorkerPool.getSnapshot();
            return snapshot.workers.length === 1 && snapshot.workers[0].busy === false;
        },
        "worker capacity was not restored after abort",
    );

    const replacementId = queueCommand("complete", 20);
    const replacement = claim(replacementId, "attempt-replacement", new Date(), 200);
    await poolModule.CommandWorkerPool.run(replacement, { leaseMs: 200, heartbeatMs: 20 });
    assert.equal(queueModule.CommandQueueManager.complete(replacementId, "attempt-replacement"), true);
});

test("worker death rejects the owned attempt and the pool respawns capacity", async () => {
    const fixtureExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const fixtureUrl = new URL(`./worker/command-worker-liveness.fixture${fixtureExt}`, import.meta.url);
    poolModule.CommandWorkerPool.configureTestWorkerEntry(fixtureUrl.href);
    poolModule.CommandWorkerPool.start();

    const crashId = queueCommand("crash");
    const crashed = claim(crashId, "attempt-crash", new Date(), 500);
    await assert.rejects(
        poolModule.CommandWorkerPool.run(crashed, { leaseMs: 500, heartbeatMs: 20 }),
        /exited with code 19/,
    );
    assert.equal(
        queueModule.CommandQueueManager.recoverOwnedCommand({
            id: crashId,
            workerId: "attempt-crash",
            reason: "worker exited with code 19",
            maxAttempts: 3,
            retryDelayMs: 0,
        }).outcome,
        "requeued",
    );

    await waitFor(
        () => {
            const snapshot = poolModule.CommandWorkerPool.getSnapshot();
            return snapshot.workers.length === 1 && !snapshot.workers[0].busy;
        },
        "pool did not respawn after worker death",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
        poolModule.CommandWorkerPool.getSnapshot().workers.length,
        1,
        "worker error+exit signals must produce exactly one replacement",
    );

    const healthyId = queueCommand("complete", 10);
    const healthy = claim(healthyId, "attempt-after-crash", new Date(), 200);
    await poolModule.CommandWorkerPool.run(healthy, { leaseMs: 200, heartbeatMs: 20 });
    assert.equal(queueModule.CommandQueueManager.complete(healthyId, "attempt-after-crash"), true);
});

test("an unexpected clean worker exit is recovered and capacity is restored", async () => {
    const fixtureExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const fixtureUrl = new URL(`./worker/command-worker-liveness.fixture${fixtureExt}`, import.meta.url);
    poolModule.CommandWorkerPool.configureTestWorkerEntry(fixtureUrl.href);
    poolModule.CommandWorkerPool.start();

    const exitId = queueCommand("exit-zero");
    const exited = claim(exitId, "attempt-exit-zero", new Date(), 500);
    await assert.rejects(
        poolModule.CommandWorkerPool.run(exited, { leaseMs: 500, heartbeatMs: 20 }),
        /exited unexpectedly with code 0/,
    );
    assert.equal(
        queueModule.CommandQueueManager.recoverOwnedCommand({
            id: exitId,
            workerId: "attempt-exit-zero",
            reason: "worker exited unexpectedly with code 0",
            maxAttempts: 3,
            retryDelayMs: 0,
        }).outcome,
        "requeued",
    );
    await waitFor(
        () => {
            const snapshot = poolModule.CommandWorkerPool.getSnapshot();
            return snapshot.workers.length === 1 && !snapshot.workers[0].busy;
        },
        "pool did not recover an unexpected clean exit",
    );
});

test("active progress updates automatically extend lease and prevent watchdog recovery within noProgressMs", () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const id = queueCommand("hang");
    claim(id, "attempt-progressing", started, 1_000);

    // Initial state: lease expires at started + 1000ms
    const initialJob = queueModule.CommandQueueManager.get(id);
    const initialExpiry = initialJob?.lease_expires_at;
    assert.ok(initialExpiry);

    // Advance progress at 500ms
    queueModule.CommandQueueManager.updateState(id, {
        workerId: "attempt-progressing",
        progress: 25,
        progressPhase: "processing chunk 1",
    });

    const updatedJob = queueModule.CommandQueueManager.get(id);
    assert.ok(updatedJob?.lease_expires_at);
    // Lease must have been extended
    assert.ok(
        new Date(updatedJob!.lease_expires_at!).getTime() >= new Date(initialExpiry!).getTime(),
        "lease_expires_at should be extended on progress update",
    );

    // Even if lease expired past now, active progress within noProgressMs protects the worker
    const simulatedNow = new Date("2026-01-01T00:01:00.000Z");
    const stale = queueModule.CommandQueueManager.findStaleExecutionLeases({
        types: [queueModule.CommandNames.CheckHealth],
        now: simulatedNow,
        noProgressMs: 300_000, // 5 minutes progress timeout
    });

    assert.equal(
        stale.length,
        0,
        "worker actively making progress within noProgressMs must not be killed as lease expired",
    );
});

test("command history sorts earlier ISO-formatted failures below later space-delimited completions", () => {
    // Insert an earlier failed command with ISO timestamp (00:47:25)
    dbModule.db.prepare(`
        INSERT INTO commands (name, payload, priority, status, created_at, started_at, completed_at)
        VALUES ('CheckHealth', '{}', 1, 'failed', '2026-09-03T00:47:25.821Z', '2026-09-03T00:47:25.821Z', '2026-09-03T00:47:25.821Z')
    `).run();

    // Insert a later completed command with SQLite standard space-delimited timestamp (12:06:43)
    dbModule.db.prepare(`
        INSERT INTO commands (name, payload, priority, status, created_at, started_at, completed_at)
        VALUES ('CheckHealth', '{}', 1, 'completed', '2026-09-03 12:06:00', '2026-09-03 12:06:10', '2026-09-03 12:06:43')
    `).run();

    const history = queueModule.CommandQueueManager.getHistory(10, 0);
    assert.ok(history.length >= 2);
    // The later completed command (12:06) must sort FIRST, before the midnight failure (00:47)
    assert.equal(history[0].status, "completed");
    assert.equal(history[1].status, "failed");
});
