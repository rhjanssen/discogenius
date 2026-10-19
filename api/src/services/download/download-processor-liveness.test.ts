import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { sqliteWriteMutexWorkerData, forceReleaseSqliteWriteMutexOwner, SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY } from '../../database/sqlite-write-mutex.js';
import { afterEach, beforeEach, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discogenius-download-liveness-'));
process.env.DB_PATH = path.join(tempDir, 'discogenius.download-liveness.test.db');
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DOWNLOAD_RECOVERY_RETRY_MS = '0';
process.env.DISCOGENIUS_DOWNLOAD_NO_PROGRESS_MS = '1000';
process.env.DISCOGENIUS_DOWNLOAD_LEASE_MS = '5000';
process.env.DISCOGENIUS_DOWNLOAD_HEARTBEAT_MS = '1000';

const databaseModule = await import('../../database.js');
databaseModule.initDatabase();
const { db } = databaseModule;
const {
    DownloadProcessor,
    DownloadProcessorWorkerProxy,
    recoverInterruptedDownloadAttempts,
} = await import('./download-processor.js');
const {
    CommandNames,
    CommandQueueManager,
} = await import('../commands/command-queue-manager.js');
const { CommandManager } = await import('../commands/command.js');
const { collectHealthDiagnosticsSnapshot } = await import('../commands/health.js');
const { DownloadWaitQueue } = await import('./download-wait-queue.js');

function resetRows(): void {
    db.prepare('DELETE FROM commands').run();
}

function pushTrack(suffix: string): number {
    return CommandQueueManager.push(
        CommandNames.DownloadTrack,
        {
            provider: 'synthetic',
            providerId: `track-${suffix}`,
            type: 'track',
            title: `Track ${suffix}`,
            artist: 'Lease Fixture',
        },
        `track-${suffix}`,
    );
}

function claim(id: number, owner: string, now = new Date('2026-01-01T00:00:00.000Z')) {
    const claimed = CommandQueueManager.claimForExecution(id, owner, 5_000, now);
    assert.ok(claimed);
    return claimed;
}

beforeEach(resetRows);
afterEach(resetRows);

test('a delayed download wakes at its retry deadline without another queue event', async () => {
    const id = pushTrack('deadline-wake');
    db.prepare('UPDATE commands SET retry_after = ? WHERE id = ?').run(new Date(Date.now() + 100).toISOString(), id);
    const processor = new DownloadProcessor() as any;
    let wakeCount = 0;
    processor.scheduleNext = () => { wakeCount++; };
    try {
        processor.armRetryWake();
        assert.ok(processor.retryWakeTimer);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(wakeCount, 1);
        assert.equal(processor.retryWakeTimer, undefined);
        processor.suspended = true;
        db.prepare('UPDATE commands SET retry_after = ? WHERE id = ?').run(new Date(Date.now() + 100).toISOString(), id);
        processor.armRetryWake();
        assert.equal(processor.retryWakeTimer, undefined, 'shutdown cannot rearm download admission');
    } finally { clearTimeout(processor.retryWakeTimer); }
});

test('a maintenance checkpoint relays disk availability to the dedicated download worker', async () => {
    const { appEvents, AppEvent } = await import('../commands/app-events.js');
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.initialized = true;
    let kicks = 0;
    proxy.kickQueue = () => { kicks++; };
    const events = [AppEvent.COMMAND_UPDATED, AppEvent.COMMAND_ADDED, AppEvent.QUEUE_CLEARED];
    const before = new Map(events.map(event => [event, appEvents.listeners(event)]));
    try {
        proxy.subscribeToQueueEvents();
        appEvents.emit(AppEvent.COMMAND_UPDATED, { id: 99, type: CommandNames.RetagArtist, status: 'queued', progress: 0 });
        assert.equal(kicks, 1);
        appEvents.emit(AppEvent.COMMAND_UPDATED, { id: 99, type: CommandNames.RetagArtist, status: 'started', progress: 0 });
        assert.equal(kicks, 1, 'a busy writer does not trigger an admission loop');
    } finally {
        for (const event of events) {
            for (const listener of appEvents.listeners(event)) {
                if (!before.get(event)!.includes(listener)) appEvents.removeListener(event, listener as (...args: unknown[]) => void);
            }
        }
    }
});

test('a full durable import backlog stops new download claims', () => {
    const wait = DownloadWaitQueue.enqueue({
        refKey: 'backpressure-track',
        mediaKind: 'track',
        commandName: CommandNames.DownloadTrack,
        provider: 'tidal',
        providerId: 'backpressure-track',
        title: 'Backpressure fixture',
        payload: { type: 'track', provider: 'tidal', providerId: 'backpressure-track' },
    });
    try {
        db.prepare(`
            INSERT INTO commands (name, payload, status, priority, created_at, updated_at)
            VALUES ('DownloadTrack', '{"downloadState":{"state":"importPending"}}',
                    'started', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run();
        // The production limit is four. These handoffs are durable but absent
        // from this processor's in-memory pending list after a worker restart.
        db.prepare(`
            INSERT INTO commands (name, payload, status, priority, created_at, updated_at)
            VALUES
              ('DownloadTrack', '{"downloadState":{"state":"importPending"}}', 'started', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ('DownloadTrack', '{"downloadState":{"state":"importPending"}}', 'started', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ('DownloadTrack', '{"downloadState":{"state":"importPending"}}', 'started', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run();
        const processor = new DownloadProcessor() as any;
        processor.scheduleQueueWithWriteLock();
        assert.equal(DownloadWaitQueue.get(wait.id)?.command_id, null);
        assert.equal(processor.activeDownloads.size, 0);
    } finally {
        DownloadWaitQueue.remove(wait.id);
    }
});

test('worker continues blocked admission after releasing its turn and rechecks pause before claiming', async () => {
    for (let i = 0; i < 41; i++) DownloadWaitQueue.enqueue({
        refKey: `blocked-page-${i}`, mediaKind: 'album', commandName: CommandNames.DownloadAlbum,
        planId: 999999, provider: 'tidal', payload: { libraryId: 4, releaseMbid: 'missing' }, notify: false,
    });
    const ready = DownloadWaitQueue.enqueue({
        refKey: 'ready-page', mediaKind: 'track', commandName: CommandNames.DownloadTrack,
        provider: 'tidal', providerId: 'ready-page', payload: { provider: 'tidal', providerId: 'ready-page' }, notify: false,
    });
    const processor = new DownloadProcessor() as any;
    let continuations = 0;
    const dispatched: number[] = [];
    processor.scheduleNext = () => { continuations++; };
    processor.dispatchDownloadPhase = (job: {id:number}) => {
        dispatched.push(job.id);
        processor.activeDownloads.set(job.id, { provider: 'tidal' });
    };
    try {
        await processor.processQueue();
        assert.equal(continuations, 1);
        assert.ok(processor.admissionCursor);
        assert.equal(DownloadWaitQueue.get(ready.id)?.command_id, null);
        processor.isPaused = true;
        await processor.processQueue();
        assert.equal(processor.admissionCursor, null);
        assert.deepEqual(dispatched, []);
        processor.isPaused = false;
        await processor.processQueue();
        await processor.processQueue(false);
        assert.equal(dispatched.length, 1);
        assert.equal(DownloadWaitQueue.get(ready.id)?.command_id, dispatched[0]);
        assert.equal(DownloadWaitQueue.countUnclaimed(), 41);
    } finally {
        processor.suspended = true;
        clearTimeout(processor.retryWakeTimer);
        db.prepare('DELETE FROM DownloadQueue').run();
    }
});

test('an external queue kick restarts admission for new work inserted before the cursor', async () => {
    for (let i = 0; i < 41; i++) DownloadWaitQueue.enqueue({
        refKey: `front-blocked-${i}`, mediaKind: 'album', commandName: CommandNames.DownloadAlbum,
        planId: 999999, provider: 'tidal', payload: {}, notify: false,
    });
    const processor = new DownloadProcessor() as any;
    processor.scheduleNext = () => {};
    const dispatched: number[] = [];
    processor.dispatchDownloadPhase = (job: {id:number}) => {
        dispatched.push(job.id);
        processor.activeDownloads.set(job.id, { provider: 'tidal' });
    };
    try {
        await processor.processQueue();
        assert.ok(processor.admissionCursor);
        const front = DownloadWaitQueue.enqueue({
            refKey: 'new-front', mediaKind: 'track', commandName: CommandNames.DownloadTrack,
            provider: 'tidal', providerId: 'new-front', payload: { provider: 'tidal', providerId: 'new-front' },
            position: 'front', notify: false,
        });
        await processor.processQueue();
        assert.equal(dispatched.length, 1);
        assert.equal(DownloadWaitQueue.get(front.id)?.command_id, dispatched[0]);
    } finally {
        processor.suspended = true;
        clearTimeout(processor.retryWakeTimer);
        db.prepare('DELETE FROM DownloadQueue').run();
    }
});

test('buffered progress persists each exact disc occurrence and never infers completion from list position', () => {
    const id = pushTrack('disc-progress');
    const owner = 'disc-progress-owner';
    claim(id, owner);
    const processor = new DownloadProcessor() as any;
    const tracks = [1, 2, 3].map(volumeNum => ({ title: 'Intro', providerTrackId: '123', trackNum: 1, volumeNum, status: 'queued' }));
    try {
        processor.persistDownloadState(id, { tracks, currentProviderTrackId: '123', currentVolumeNum: 2, trackStatus: 'completed' }, owner);
        processor.persistDownloadState(id, { currentProviderTrackId: '123', currentVolumeNum: 3, trackStatus: 'completed' }, owner);
        const buffered = processor.progressBuffer.get(id).state;
        processor.writeDownloadState(id, buffered, owner);
        assert.deepEqual(CommandQueueManager.get(id)!.payload.downloadState!.tracks!.map(t => t.status), ['queued', 'completed', 'completed']);
        assert.equal(CommandQueueManager.get(id)!.progress, 67, 'Command progress follows the same catalogue fraction as download details');
        processor.writeDownloadState(id, { currentFileNum: 3, totalFiles: 3, state: 'downloading' }, owner);
        assert.deepEqual(CommandQueueManager.get(id)!.payload.downloadState!.tracks!.map(t => t.status), ['queued', 'completed', 'completed']);
    } finally {
        clearTimeout(processor.progressFlushTimer);
        processor.progressBuffer.clear();
    }
});

test('dead download worker requeues a resumable attempt and rejects every late lifecycle write', () => {
    const id = pushTrack('worker-death');
    const original = CommandQueueManager.get(id)!;
    const originalOrder = original.queue_order;
    const originalPriority = original.priority;
    const originalTrigger = original.trigger;
    const firstOwner = 'download-attempt:first';
    claim(id, firstOwner);
    CommandQueueManager.updateState(id, {
        workerId: firstOwner,
        progress: 27,
        progressPhase: 'downloading',
        payloadPatch: {
            downloadState: {
                state: 'downloading',
                progress: 27,
            },
        } as any,
    });

    const recovered = recoverInterruptedDownloadAttempts(
        'Synthetic dedicated worker death',
        new Date('2026-01-01T00:00:10.000Z'),
    );
    assert.deepEqual(recovered, { requeued: 1, failed: 0, ignored: 0 });

    const queued = CommandQueueManager.get(id)!;
    assert.equal(queued.status, 'queued');
    assert.equal(queued.attempt, 1);
    assert.equal(queued.worker_id, null);
    assert.equal(queued.last_retry_reason, 'Synthetic dedicated worker death');
    assert.equal(queued.queue_order, originalOrder);
    assert.equal(queued.priority, originalPriority);
    assert.equal(queued.trigger, originalTrigger);

    const secondOwner = 'download-attempt:replacement';
    claim(id, secondOwner, new Date('2026-01-01T00:00:11.000Z'));
    assert.equal(CommandQueueManager.complete(id, firstOwner), false);
    assert.equal(CommandQueueManager.fail(id, 'late failure', firstOwner), false);
    assert.equal(CommandQueueManager.updateState(id, {
        workerId: firstOwner,
        progress: 99,
    }), null);
    assert.equal(CommandQueueManager.get(id)?.worker_id, secondOwner);
    assert.equal(CommandQueueManager.complete(id, secondOwner), true);
});

test('an interrupted active import fails closed and preserves its staging evidence', () => {
    const id = pushTrack('partial-import');
    const owner = 'download-attempt:importing';
    claim(id, owner);
    const staging = path.join(tempDir, 'partial-import-staging');
    fs.mkdirSync(staging, { recursive: true });
    const stagedFile = path.join(staging, 'track.flac');
    fs.writeFileSync(stagedFile, 'synthetic bytes');

    CommandQueueManager.updateState(id, {
        workerId: owner,
        progressPhase: 'importing',
        payloadPatch: {
            downloadState: { state: 'importing', progress: 80 },
            downloadImportHandoff: {
                importPayload: {
                    type: 'track',
                    provider: 'synthetic',
                    providerId: 'track-partial-import',
                    path: staging,
                },
                resolved: {
                    title: 'Partial import',
                    artist: 'Lease Fixture',
                    cover: null,
                },
                executionStartedAt: '2026-01-01T00:00:01.000Z',
            },
        } as any,
    });

    const recovered = recoverInterruptedDownloadAttempts(
        'Synthetic worker exit during import',
        new Date('2026-01-01T00:00:10.000Z'),
    );
    assert.deepEqual(recovered, { requeued: 0, failed: 1, ignored: 0 });
    const failed = CommandQueueManager.get(id)!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.blocked_reason, 'poisoned command');
    assert.match(failed.error || '', /partially mutated library files/i);
    assert.equal(CommandQueueManager.complete(id, owner), false);
    assert.equal(fs.existsSync(stagedFile), true);
    const repairs = db.prepare("SELECT COUNT(*) AS count FROM commands WHERE name = ?").get(CommandNames.RetagFiles) as { count: number };
    assert.equal(repairs.count, 0, "an import that never recorded file ids does not invent a retag");
});

test("a tag-rule phase that ticks per file is not poisoned while the percent stays put", async () => {
    const id = pushTrack("tag-ticks");
    const owner = "download-attempt:tag-ticks";
    claim(id, owner, new Date());
    const processor = new DownloadProcessor() as any;
    processor.attemptOwners.set(id, owner);
    for (let file = 1; file <= 30; file += 1) {
        processor.persistDownloadState(id, {
            state: "importing",
            progress: 94,
            description: "ImportDownload: applying audio tag rules",
            statusMessage: "Applying audio tag rules",
            currentFileNum: file,
            totalFiles: 477,
            subphaseTick: true,
        }, owner);
    }
    db.prepare(`
        UPDATE commands
        SET last_progress_at = '2020-01-01 00:00:00',
            heartbeat_at = '2020-01-01 00:00:00'
        WHERE id = ?
    `).run(id);
    processor.persistDownloadState(id, {
        state: "importing",
        progress: 94,
        description: "ImportDownload: applying audio tag rules",
        statusMessage: "Applying audio tag rules",
        currentFileNum: 30,
        totalFiles: 477,
        subphaseTick: true,
    }, owner);

    const ticking = CommandQueueManager.get(id)!;
    assert.equal(ticking.progress, 94);
    assert.equal((ticking.payload as { downloadState?: { currentFileNum?: number; totalFiles?: number } }).downloadState?.currentFileNum, 30);
    assert.equal((ticking.payload as { downloadState?: { totalFiles?: number } }).downloadState?.totalFiles, 477);
    assert.notEqual(ticking.last_progress_at, "2020-01-01 00:00:00");
    assert.notEqual(ticking.heartbeat_at, "2020-01-01 00:00:00");
    const progressedAt = Date.parse(
        String(ticking.last_progress_at).includes("T")
            ? String(ticking.last_progress_at)
            : `${String(ticking.last_progress_at).replace(" ", "T")}Z`,
    );

    let terminations = 0;
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.worker = {
        terminate: async () => {
            terminations += 1;
            return 1;
        },
    };
    assert.equal(await proxy.runWatchdogOnce(new Date(progressedAt + 200)), false);
    assert.equal(terminations, 0);
    assert.equal(CommandQueueManager.get(id)?.status, "started");
    assert.equal(CommandQueueManager.get(id)?.blocked_reason ?? null, null);
});

test("a stuck tag-rule phase is poisoned and queues a retag of the files it touched", async () => {
    const id = pushTrack("tag-stuck");
    const owner = "download-attempt:tag-stuck";
    claim(id, owner);
    CommandQueueManager.updateState(id, {
        workerId: owner,
        progress: 94,
        progressPhase: "importing",
        payloadPatch: {
            downloadState: {
                state: "importing",
                progress: 94,
                statusMessage: "Applying audio tag rules",
            },
            downloadImportHandoff: {
                importPayload: {
                    type: "album",
                    provider: "synthetic",
                    providerId: "track-tag-stuck",
                    path: path.join(tempDir, "tag-stuck"),
                },
                resolved: { title: "Golden Earring", artist: "Lease Fixture", cover: null },
                executionStartedAt: "2026-01-01T00:00:01.000Z",
                importTouchedFileIds: [11, 22, 11],
            },
        } as any,
    });
    db.prepare(`
        UPDATE commands
        SET heartbeat_at = '2026-01-01 00:00:09',
            lease_expires_at = '2026-01-01 00:01:00',
            last_progress_at = '2026-01-01 00:00:00'
        WHERE id = ?
    `).run(id);

    let terminations = 0;
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.worker = {
        terminate: async () => {
            terminations += 1;
            return 1;
        },
    };
    assert.equal(await proxy.runWatchdogOnce(new Date("2026-01-01T00:00:10.000Z")), true);
    assert.equal(terminations, 1);

    const recovered = recoverInterruptedDownloadAttempts(
        "Download worker watchdog detected stale execution",
        new Date("2026-01-01T00:00:10.000Z"),
    );
    assert.deepEqual(recovered, { requeued: 0, failed: 1, ignored: 0 });
    const failed = CommandQueueManager.get(id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.blocked_reason, "poisoned command");
    assert.match(failed.error || "", /not replayed/i);
    const repairs = db.prepare("SELECT payload, ref_id FROM commands WHERE name = ?").all(CommandNames.RetagFiles) as Array<{ payload: string; ref_id: string }>;
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].ref_id, `import-tag-repair:${id}`);
    assert.deepEqual(JSON.parse(repairs[0].payload).ids, [11, 22]);
});

test('a durable import-pending handoff is resumed on the same attempt without re-downloading', () => {
    const id = pushTrack('pending-import');
    const firstOwner = 'download-attempt:pending';
    claim(id, firstOwner);
    const staging = path.join(tempDir, 'pending-import-staging');
    CommandQueueManager.updateState(id, {
        workerId: firstOwner,
        progressPhase: 'waiting to import',
        payloadPatch: {
            downloadState: { state: 'importPending', progress: 100 },
            downloadImportHandoff: {
                importPayload: {
                    type: 'track',
                    provider: 'synthetic',
                    providerId: 'track-pending-import',
                    path: staging,
                },
                resolved: {
                    title: 'Pending import',
                    artist: 'Lease Fixture',
                    cover: null,
                },
                executionStartedAt: null,
            },
        } as any,
    });
    const recovered = recoverInterruptedDownloadAttempts(
        'Synthetic restart before import slot',
        new Date('2026-01-01T00:00:10.000Z'),
    );
    assert.deepEqual(recovered, { requeued: 0, failed: 0, ignored: 0 });
    const parked = CommandQueueManager.get(id)!;
    assert.equal(parked.status, 'started');
    assert.equal(parked.attempt, 1);
    assert.equal(parked.worker_id, firstOwner);

    // updateState extended the lease. A dead worker's lease is what lets the
    // scheduler take the handoff without burning an attempt.
    db.prepare('UPDATE commands SET lease_expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 30_000).toISOString(),
        id,
    );
    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);
    processor.scheduleQueueWithWriteLock();

    assert.deepEqual(dispatched.map((entry) => entry.commandId), [id]);
    const replacement = CommandQueueManager.get(id)!;
    assert.equal(replacement.status, 'started');
    assert.equal(replacement.attempt, 1);
    assert.notEqual(replacement.worker_id, firstOwner);
    assert.equal((replacement.payload as { downloadImportHandoff?: { importPayload?: { path?: string } } }).downloadImportHandoff?.importPayload?.path, staging);
    assert.equal(processor.activeDownloads.size, 0);
    assert.equal(processor.pendingImports.length, 0);
});

test('heartbeats renew active download, import-pending, and active-import leases', () => {
    const ids = ['download', 'pending', 'import'].map((suffix) => pushTrack(suffix));
    const owners = ids.map((id, index) => `download-attempt:heartbeat:${index}`);
    ids.forEach((id, index) => claim(id, owners[index]));

    const processor = new DownloadProcessor() as any;
    processor.activeDownloads.set(ids[0], {
        provider: 'synthetic',
        type: 'track',
        providerId: 'track-download',
        workerId: owners[0],
        abortController: new AbortController(),
        cancelRequested: false,
    });
    processor.pendingImports.push({
        commandId: ids[1],
        providerId: 'track-pending',
        type: 'track',
        workerId: owners[1],
        importPayload: { type: 'track', providerId: 'track-pending' },
        resolved: { title: 'Pending', artist: 'Lease Fixture', cover: null },
    });
    processor.activeImports.set(ids[2], {
        providerId: 'track-import',
        type: 'track',
        workerId: owners[2],
        promise: Promise.resolve(),
    });

    const heartbeatAt = new Date('2026-01-01T00:01:00.000Z');
    processor.renewOwnedAttemptLeases(heartbeatAt);
    for (const id of ids) {
        const command = CommandQueueManager.get(id)!;
        assert.equal(command.heartbeat_at, '2026-01-01T00:01:00.000Z');
        assert.equal(command.lease_expires_at, '2026-01-01T00:01:05.000Z');
    }
});

test('watchdog terminates a heartbeating worker whose command stopped making progress', async () => {
    const id = pushTrack('hung');
    const owner = 'download-attempt:hung';
    claim(id, owner);
    db.prepare(`
        UPDATE commands
        SET heartbeat_at = '2026-01-01 00:00:09',
            lease_expires_at = '2026-01-01 00:01:00',
            last_progress_at = '2026-01-01 00:00:00'
        WHERE id = ?
    `).run(id);

    let terminations = 0;
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.worker = {
        terminate: async () => {
            terminations += 1;
            return 1;
        },
    };

    const terminated = await proxy.runWatchdogOnce(
        new Date('2026-01-01T00:00:10.000Z'),
    );
    assert.equal(terminated, true);
    assert.equal(terminations, 1);
    // Recovery occurs only from the physical worker's exit handler, never
    // before termination, so duplicate concurrent execution is impossible.
    assert.equal(CommandQueueManager.get(id)?.worker_id, owner);
});

test('a parked import-pending download keeps its attempt across restart recovery', () => {
    const id = pushTrack('parked-import');
    const owner = 'download-attempt:parked';
    claim(id, owner);
    db.prepare('UPDATE commands SET attempt = 3 WHERE id = ?').run(id);
    CommandQueueManager.updateState(id, {
        workerId: owner,
        progressPhase: 'waiting to import',
        blockedReason: 'waiting on import slot',
        payloadPatch: {
            downloadState: { state: 'importPending', progress: 100 },
            downloadImportHandoff: {
                importPayload: {
                    type: 'track',
                    provider: 'synthetic',
                    providerId: 'track-parked-import',
                    path: path.join(tempDir, 'parked-import-staging'),
                },
                resolved: {
                    title: 'Parked import',
                    artist: 'Lease Fixture',
                    cover: null,
                },
                executionStartedAt: null,
            },
        } as any,
    });

    const recovered = recoverInterruptedDownloadAttempts(
        'Download worker watchdog detected stale execution',
        new Date('2026-01-01T00:00:10.000Z'),
    );
    assert.deepEqual(recovered, { requeued: 0, failed: 0, ignored: 0 });
    const parked = CommandQueueManager.get(id)!;
    assert.equal(parked.status, 'started');
    assert.equal(parked.attempt, 3);
    assert.match(String(parked.payload.downloadState?.state || ''), /importPending/);

    db.prepare('UPDATE commands SET lease_expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 30_000).toISOString(),
        id,
    );
    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);
    processor.scheduleQueueWithWriteLock();

    assert.deepEqual(dispatched.map((entry) => entry.commandId), [id]);
    assert.equal(CommandQueueManager.get(id)!.attempt, 3);
    assert.equal(CommandQueueManager.get(id)!.status, 'started');
});

test('watchdog ignores a parked import-pending lease', async () => {
    const id = pushTrack('parked-watchdog');
    const owner = 'download-attempt:parked-watchdog';
    claim(id, owner);
    CommandQueueManager.updateState(id, {
        workerId: owner,
        progressPhase: 'waiting to import',
        blockedReason: 'waiting on import slot',
        payloadPatch: {
            downloadState: { state: 'importPending', progress: 100 },
        } as any,
    });
    db.prepare(`
        UPDATE commands
        SET heartbeat_at = '2026-01-01 00:00:00',
            lease_expires_at = '2026-01-01 00:00:01',
            last_progress_at = '2026-01-01 00:00:00'
        WHERE id = ?
    `).run(id);

    let terminations = 0;
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.worker = {
        terminate: async () => {
            terminations += 1;
            return 1;
        },
    };

    const terminated = await proxy.runWatchdogOnce(
        new Date('2026-01-01T00:00:10.000Z'),
    );
    assert.equal(terminated, false);
    assert.equal(terminations, 0);
    assert.equal(CommandQueueManager.get(id)?.status, 'started');
});

test('watchdog does not kill a worker while another writer holds SQLite', async () => {
    const id = pushTrack('mutex-watchdog');
    const owner = 'download-attempt:mutex-watchdog';
    claim(id, owner);
    db.prepare(`
        UPDATE commands
        SET heartbeat_at = '2026-01-01 00:00:00',
            lease_expires_at = '2026-01-01 00:00:01',
            last_progress_at = '2026-01-01 00:00:00'
        WHERE id = ?
    `).run(id);

    let terminations = 0;
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.worker = {
        terminate: async () => {
            terminations += 1;
            return 1;
        },
    };

    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const blocker = databaseModule.withSqliteWriteGate(() => {
        acquired();
        return new Promise<void>((resolve) => { release = resolve; });
    }, 'test:rename-writer');
    await ready;
    try {
        const terminated = await proxy.runWatchdogOnce(
            new Date('2026-01-01T00:00:10.000Z'),
        );
        assert.equal(terminated, false);
        assert.equal(terminations, 0);
    } finally {
        release();
        await blocker;
    }
});

test('bounded infrastructure retries poison the third interrupted download attempt', () => {
    const id = pushTrack('poison');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const owner = `download-attempt:poison:${attempt}`;
        const claimSecond = attempt * 2 - 1;
        const recoverySecond = attempt * 2;
        claim(id, owner, new Date(`2026-01-01T00:00:0${claimSecond}.000Z`));
        const result = recoverInterruptedDownloadAttempts(
            `Synthetic interruption ${attempt}`,
            new Date(`2026-01-01T00:00:0${recoverySecond}.000Z`),
        );
        if (attempt < 3) {
            assert.deepEqual(result, { requeued: 1, failed: 0, ignored: 0 });
        } else {
            assert.deepEqual(result, { requeued: 0, failed: 1, ignored: 0 });
        }
    }

    const poisoned = CommandQueueManager.get(id)!;
    assert.equal(poisoned.status, 'failed');
    assert.equal(poisoned.attempt, 3);
    assert.equal(poisoned.blocked_reason, 'poisoned command');
    assert.match(poisoned.error || '', /after 3 execution attempt/);
});

test('initialization schedules recurring download supervision', async () => {
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.request = async () => {};
    proxy.subscribeToQueueEvents = () => {};
    try {
        await proxy.initialize();
        assert.ok(proxy.watchdogTimer, 'production initialization must schedule the watchdog');
    } finally { clearInterval(proxy.watchdogTimer); }
});

test('failed worker recovery clears stale activity and the watchdog retries before restarting', async () => {
    const id = pushTrack('recovery-retry');
    claim(id, 'download-attempt:dead');
    const proxy = new DownloadProcessorWorkerProxy() as any;
    proxy.initialized = true;
    proxy.status.activeDownloadIds = [id];
    proxy.status.processing = true;
    let starts = 0;
    proxy.request = async (kind: string) => { if (kind === 'initialize') starts++; };
    const recover = CommandQueueManager.recoverOwnedCommand;
    try {
        CommandQueueManager.recoverOwnedCommand = () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); };
        await proxy.recoverAndRestart('worker exited');
        assert.equal(proxy.getStatus().processing, false);
        assert.deepEqual(proxy.getStatus().activeDownloadIds, []);
        assert.match(proxy.getStatus().recoveryMessage, /restarting/);
        assert.equal(starts, 0);
        assert.equal(CommandQueueManager.get(id)?.worker_id, 'download-attempt:dead');
        CommandQueueManager.recoverOwnedCommand = recover;
        await proxy.runWatchdogOnce(new Date(Date.now() + 61_000));
        await proxy.restartInFlight;
        assert.equal(starts, 1);
        assert.equal(CommandQueueManager.get(id)?.status, 'queued');
        assert.equal(proxy.getStatus().recoveryMessage, undefined);
    } finally { CommandQueueManager.recoverOwnedCommand = recover; }
});


test('download failure and import completion wait for a contended writer while progress remains responsive', { timeout: 30_000 }, async () => {
    const failedId = pushTrack('contended-failure');
    const completedId = pushTrack('contended-import-completion');
    claim(failedId, 'failed-owner');
    claim(completedId, 'completed-owner');
    const processor = new DownloadProcessor() as any;
    const mutexData = sqliteWriteMutexWorkerData();
    const writer = new Worker(new URL('../commands/worker/command-worker-bootstrap.mjs', import.meta.url), {
        workerData: { ...mutexData, mode: 'hold', name: 'test:provider-rematch', __entry: new URL('../../database/sqlite-write-mutex.fixture.ts', import.meta.url).href },
    });
    try {
        await new Promise<void>((resolve, reject) => {
            writer.on('message', message => { if (message.kind === 'acquired') resolve(); });
            writer.once('error', reject);
        });
        const pendingFailure = processor.failAttempt(failedId, 'Provider unavailable', { state: 'failed', statusMessage: 'Provider unavailable' }, 'failed-owner');
        const pendingCompletion = processor.completeAttempt(completedId, 'completed-owner');
        // Exceed the synchronous worker timeout that previously killed the worker.
        // The event loop must keep servicing heartbeat/progress callbacks meanwhile.
        let ticks = 0;
        const timer = setInterval(() => {
            ticks++;
            processor.persistDownloadState(completedId, { state: 'importing', progress: ticks }, 'completed-owner');
        }, 100);
        try {
            await new Promise(resolve => setTimeout(resolve, 15_100));
            assert.ok(ticks > 50, `Only ${ticks} heartbeat opportunities while waiting`);
            assert.equal(CommandQueueManager.get(failedId)?.status, 'started');
            assert.equal(CommandQueueManager.get(completedId)?.status, 'started');
        } finally { clearInterval(timer); }
        const exit = once(writer, 'exit');
        writer.postMessage('release');
        assert.equal(await pendingFailure, true);
        assert.ok(await pendingCompletion);
        await exit;
        assert.equal(CommandQueueManager.get(failedId)?.status, 'failed');
        assert.equal(CommandQueueManager.get(failedId)?.error, 'Provider unavailable');
        assert.equal(CommandQueueManager.get(failedId)?.payload.downloadState?.state, 'failed');
        assert.equal(CommandQueueManager.get(completedId)?.status, 'completed');
        assert.equal(CommandQueueManager.get(completedId)?.payload.downloadState?.state, 'completed');
        assert.equal(CommandQueueManager.get(completedId)?.payload.downloadState?.progress, 100);
        processor.flushProgressBuffer();
        assert.equal(CommandQueueManager.get(completedId)?.status, 'completed', 'Late buffered progress cannot reopen a terminal attempt');
        assert.equal(CommandQueueManager.get(completedId)?.payload.downloadState?.state, 'completed');
    } finally {
        await writer.terminate();
        forceReleaseSqliteWriteMutexOwner(Number(mutexData[SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY]));
        clearInterval(processor.progressFlushTimer);
        processor.progressBuffer.clear();
    }
});


function handoffPayload(suffix: string, readyAt: string, executionStartedAt: string | null) {
    return {
        downloadState: { state: 'importPending', progress: 100 },
        downloadImportHandoff: {
            readyAt,
            importPayload: {
                type: 'track',
                provider: 'deezer',
                providerId: `track-${suffix}`,
                path: path.join(tempDir, `staging-${suffix}`),
            },
            resolved: { title: suffix, artist: 'Lease Fixture', cover: null },
            executionStartedAt,
        },
    };
}

/** The 18 Oct 2026 incident row: started, importPending, handoff persisted, lease still live. */
function seedImportHandoff(suffix: string, options: {
    owner?: string;
    lease?: 'live' | 'dead';
    progressPhase?: string;
    executionStartedAt?: string | null;
    readyAt?: string;
} = {}) {
    const id = pushTrack(suffix);
    const owner = options.owner ?? `download-attempt:${process.pid}:${id}:${suffix}`;
    claim(id, owner);
    const readyAt = options.readyAt ?? new Date(Date.now() - 10 * 60_000).toISOString();
    CommandQueueManager.updateState(id, {
        workerId: owner,
        progressPhase: options.progressPhase ?? 'waiting to import',
        blockedReason: 'waiting on import slot',
        payloadPatch: handoffPayload(suffix, readyAt, options.executionStartedAt ?? null) as any,
    });
    const live = options.lease !== 'dead';
    const heartbeat = live ? new Date() : new Date(Date.now() - 120_000);
    const expires = live ? new Date(Date.now() + 90_000) : new Date(Date.now() - 30_000);
    db.prepare(`
        UPDATE commands SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ?
    `).run(heartbeat.toISOString(), expires.toISOString(), id);
    const row = CommandQueueManager.get(id)!;
    return { id, owner, attempt: row.attempt, workerId: row.worker_id! };
}

function stubImportDispatch(processor: any, dispatched: Array<{ commandId: number; workerId: string }>) {
    processor.dispatchImportPhase = (entry: { commandId: number; workerId: string; providerId: string; type: string }) => {
        dispatched.push({ commandId: entry.commandId, workerId: entry.workerId });
        processor.activeImports.set(entry.commandId, {
            providerId: entry.providerId,
            type: entry.type,
            workerId: entry.workerId,
            promise: Promise.resolve(),
        });
    };
}

test('a started importPending handoff missing from memory starts on the next tick without a new attempt', () => {
    const row = seedImportHandoff('incident-missing');
    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);

    processor.scheduleQueueWithWriteLock();

    assert.deepEqual(dispatched.map((entry) => entry.commandId), [row.id]);
    assert.equal(dispatched[0]?.workerId, row.owner);
    const current = CommandQueueManager.get(row.id)!;
    assert.equal(current.status, 'started');
    assert.equal(current.attempt, row.attempt, 're-adopting a live handoff must not burn a retry');
    assert.equal(current.worker_id, row.owner);
    assert.equal(processor.activeDownloads.size, 0);
});

test('a stranded import does not block a queued RetagArtist', () => {
    const row = seedImportHandoff('retag-after-import');
    const retag = CommandQueueManager.push(CommandNames.RetagArtist, { artistId: 'bastille' } as any, 'bastille');
    const retagStart = CommandManager.canStartCommand(CommandNames.RetagArtist, { artistId: 'bastille' }, 'bastille');
    assert.equal(retagStart.canStart, true);
    const backup = CommandManager.canStartCommand(CommandNames.BackupDatabase);
    assert.equal(backup.canStart, false);
    assert.match(backup.reason || '', /completed download is waiting for disk admission/);

    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);
    processor.scheduleQueueWithWriteLock();

    assert.deepEqual(dispatched.map((entry) => entry.commandId), [row.id]);
    assert.equal(CommandQueueManager.complete(row.id, row.owner), true);
    assert.equal(CommandManager.canStartCommand(CommandNames.BackupDatabase).canStart, true);
    assert.equal(CommandQueueManager.get(retag)?.status, 'queued');
});

test('an unclaimable import head does not block the next handoff', () => {
    // scheduleQueueWithWriteLock used to break() when claimImportForExecution
    // returned false, so every handoff behind that head stayed unscheduled.
    const head = seedImportHandoff('unclaimable-head', { lease: 'live' });
    const next = seedImportHandoff('claimable-next', { lease: 'live' });
    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);
    processor.pendingImports.push(
        {
            commandId: head.id,
            providerId: 'track-unclaimable-head',
            type: 'track',
            workerId: head.owner,
            importPayload: { type: 'track', provider: 'deezer', providerId: 'track-unclaimable-head', path: path.join(tempDir, 'staging-unclaimable-head') },
            resolved: { title: 'unclaimable-head', artist: 'Lease Fixture', cover: null },
        },
        {
            commandId: next.id,
            providerId: 'track-claimable-next',
            type: 'track',
            workerId: next.owner,
            importPayload: { type: 'track', provider: 'deezer', providerId: 'track-claimable-next', path: path.join(tempDir, 'staging-claimable-next') },
            resolved: { title: 'claimable-next', artist: 'Lease Fixture', cover: null },
        },
    );

    const claimImport = CommandQueueManager.claimImportForExecution.bind(CommandQueueManager);
    CommandQueueManager.claimImportForExecution = (id: number, workerId: string) => {
        if (id === head.id) return false;
        return claimImport(id, workerId);
    };
    try {
        processor.scheduleQueueWithWriteLock();
    } finally {
        CommandQueueManager.claimImportForExecution = claimImport;
    }

    assert.deepEqual(dispatched.map((entry) => entry.commandId), [next.id]);
    const blocked = CommandQueueManager.get(head.id)!;
    assert.equal(blocked.status, 'started');
    assert.equal(blocked.attempt, head.attempt);
    assert.equal(blocked.worker_id, head.owner);
    assert.equal(blocked.progress_phase, 'waiting to import');
    assert.equal(
        processor.pendingImports.some((entry: { commandId: number }) => entry.commandId === head.id),
        true,
        'a refused head stays queued until it can claim',
    );
});

test('an owner mismatch keeps the replayable handoff and imports it on the same attempt', () => {
    // scheduleQueueWithWriteLock used to shift() this entry when isExecutionOwner
    // failed (download-processor.ts) and wrote no terminal or requeue state.
    const row = seedImportHandoff('owner-shift');
    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);
    processor.pendingImports.push({
        commandId: row.id,
        providerId: 'track-owner-shift',
        type: 'track',
        workerId: 'stale-memory-owner',
        importPayload: { type: 'track', provider: 'deezer', providerId: 'track-owner-shift', path: path.join(tempDir, 'staging-owner-shift') },
        resolved: { title: 'owner-shift', artist: 'Lease Fixture', cover: null },
    });

    processor.scheduleQueueWithWriteLock();

    assert.deepEqual(dispatched.map((entry) => entry.commandId), [row.id]);
    const current = CommandQueueManager.get(row.id)!;
    assert.equal(current.status, 'started');
    assert.equal(current.worker_id, row.owner);
    assert.equal(current.attempt, row.attempt);
    assert.equal(current.payload.downloadState?.state, 'importPending');
});

test('a dead-owner import handoff is adopted once when two schedulers run', () => {
    const row = seedImportHandoff('dead-owner', {
        owner: 'download-attempt:1:dead-owner',
        lease: 'dead',
    });
    const first = new DownloadProcessor() as any;
    const second = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(first, dispatched);
    stubImportDispatch(second, dispatched);

    first.scheduleQueueWithWriteLock();
    second.scheduleQueueWithWriteLock();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.commandId, row.id);
    const current = CommandQueueManager.get(row.id)!;
    assert.equal(current.attempt, row.attempt);
    assert.equal(current.status, 'started');
    assert.notEqual(current.worker_id, row.owner);
    assert.equal((current.payload as { downloadImportHandoff?: { executionStartedAt?: string | null } }).downloadImportHandoff?.executionStartedAt ?? null, null);
});

function totalChanges(): number {
    const row = db.prepare('SELECT total_changes() AS n').get() as { n: number };
    return Number(row.n);
}

test('a scheduling pass does not write when every handoff is already in memory', () => {
    const processor = new DownloadProcessor() as any;
    const empty = totalChanges();
    processor.scheduleQueueWithWriteLock();
    assert.equal(totalChanges(), empty, 'an empty import pass is a read');

    const row = seedImportHandoff('steady-memory');
    processor.pendingImports.push({
        commandId: row.id,
        providerId: 'track-steady-memory',
        type: 'track',
        workerId: row.owner,
        importPayload: {
            type: 'track',
            provider: 'deezer',
            providerId: 'track-steady-memory',
            path: path.join(tempDir, 'staging-steady-memory'),
        },
        resolved: { title: 'steady-memory', artist: 'Lease Fixture', cover: null },
    });
    processor.activeImports.set(-1, {
        providerId: 'slot-a',
        type: 'track',
        workerId: 'slot-a',
        promise: Promise.resolve(),
    });
    processor.activeImports.set(-2, {
        providerId: 'slot-b',
        type: 'track',
        workerId: 'slot-b',
        promise: Promise.resolve(),
    });
    const held = totalChanges();
    processor.scheduleQueueWithWriteLock();
    assert.equal(totalChanges(), held, 'reconcile does not write while the handoff is already queued');
    assert.equal(processor.pendingImports.some((entry: { commandId: number }) => entry.commandId === row.id), true);
    const current = CommandQueueManager.get(row.id)!;
    assert.equal(current.attempt, row.attempt);
    assert.equal(current.worker_id, row.owner);
    assert.equal(current.progress_phase, 'waiting to import');
});

test('import admission watchdog raises and clears the imports health signal', async () => {
    const row = seedImportHandoff('admission-watchdog', {
        readyAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    const raised = collectHealthDiagnosticsSnapshot();
    assert.equal(raised.subsystems.imports.status, 'error');
    assert.match(raised.subsystems.imports.message, new RegExp(`#${row.id}`));
    assert.equal(raised.issues.some((issue) => issue.scope === 'imports.health'), true);

    const processor = new DownloadProcessor() as any;
    const dispatched: Array<{ commandId: number; workerId: string }> = [];
    stubImportDispatch(processor, dispatched);
    let schedules = 0;
    processor.scheduleNext = () => { schedules += 1; };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map((part) => String(part)).join(' '));
    };
    try {
        processor.runImportAdmissionWatchdog();
        processor.runImportAdmissionWatchdog();
        assert.equal(schedules, 2, 'each watchdog fire schedules once and does not loop');
        assert.match(errors.join('\n'), new RegExp(`#${row.id}`));
    } finally {
        console.error = originalError;
    }

    await processor.processQueue();
    assert.deepEqual(dispatched.map((entry) => entry.commandId), [row.id]);
    assert.equal(dispatched[0]?.workerId, row.owner);
    assert.equal(CommandQueueManager.get(row.id)!.attempt, row.attempt);

    processor.runImportAdmissionWatchdog();
    assert.equal(schedules, 2, 'an active import is not scheduled again');

    assert.equal(CommandQueueManager.complete(row.id, row.owner), true);
    processor.activeImports.clear();
    const cleared = collectHealthDiagnosticsSnapshot();
    assert.equal(cleared.subsystems.imports.status, 'ok');
    assert.equal(cleared.issues.some((issue) => issue.scope === 'imports.health'), false);
    processor.runImportAdmissionWatchdog();
    assert.equal(schedules, 2, 'a cleared handoff does not schedule again');
});

test('import progress counts organized files rather than previously completed downloads', () => {
    const id = pushTrack('import-progress');
    const owner = 'import-progress-owner';
    claim(id, owner);
    const processor = new DownloadProcessor() as any;
    const tracks = Array.from({ length: 25 }, (_, index) => ({ title: 'Track ' + index, providerTrackId: String(index), trackNum: index + 1, volumeNum: 1, status: 'completed' }));
    processor.writeDownloadState(id, { state: 'downloading', tracks, progress: 100, totalFiles: 25, currentFileNum: 25 }, owner);
    processor.writeDownloadState(id, { state: 'importing', progress: 17, totalFiles: 25, currentFileNum: 1 }, owner);
    const current = CommandQueueManager.get(id)!;
    assert.equal(current.progress, 17);
    assert.equal(current.payload.downloadState!.currentFileNum, 1);
    assert.equal(current.payload.downloadState!.totalFiles, 25);
    processor.writeDownloadState(id, { state: 'importing', progress: 86, currentFileNum: 25 }, owner);
    assert.equal(CommandQueueManager.get(id)!.progress, 86, 'metadata finalization must not turn into 100% before completion');
});
