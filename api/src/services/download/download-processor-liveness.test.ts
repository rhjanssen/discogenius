import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});

test('a durable import-pending handoff is claimed by a fresh attempt without re-downloading', () => {
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
    recoverInterruptedDownloadAttempts(
        'Synthetic restart before import slot',
        new Date('2026-01-01T00:00:10.000Z'),
    );

    const processor = new DownloadProcessor() as any;
    processor.claimRecoveredImportHandoffs();

    const replacement = CommandQueueManager.get(id)!;
    assert.equal(replacement.status, 'started');
    assert.equal(replacement.attempt, 2);
    assert.notEqual(replacement.worker_id, firstOwner);
    assert.equal(processor.pendingImports.length, 1);
    assert.equal(processor.pendingImports[0].importPayload.path, staging);
    assert.equal(processor.activeDownloads.size, 0);
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
