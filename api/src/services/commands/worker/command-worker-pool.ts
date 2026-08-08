import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { readIntEnv } from "../../../utils/env.js";
import { appEvents, type AppEvent } from "../app-events.js";
import { ownerAcquire, ownerRelease, ownerReleaseAllFor } from "./sqlite-write-lock.js";
import type {CommandModel} from "../command-model.js";
import {
    invalidateAlbumDownloadStatus,
    invalidateAllDownloadState,
    invalidateArtistDownloadStatus,
    invalidateMediaDownloadState,
    invalidateReleaseGroupDownloadStatus,
} from "../../download/download-state.js";
import {
    COMMAND_WORKER_MARKER,
    COMMAND_WORKER_ID,
    type CacheInvalidateTarget,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
} from "./command-worker-protocol.js";

/**
 * Main-thread pool of command worker threads — the off-thread execution backend
 * for the `CommandExecutor` (default THREAD_LIMIT = 3). Each worker runs one
 * command handler at a time on its own OS thread + DB connection, so heavy
 * synchronous better-sqlite3 / CPU work never blocks the main thread's HTTP +
 * SSE loop.
 *
 * Always on in the running app — the pool is started unconditionally at boot
 * with no single/multi toggle. Callers dispatch to the pool when it
 * `isActive()` (i.e. started); otherwise they run the work in-process. The only
 * context where the pool isn't started is unit tests that exercise handler
 * logic directly. See `CommandExecutor`.
 */

/** Optional per-run hooks. `onProgress` receives ImportDownload progress states. */
export interface JobRunOptions {
    onProgress?: (state: unknown) => void;
    leaseMs?: number;
    heartbeatMs?: number;
}

export interface CommandWorkerSnapshot {
    workerId: string;
    busy: boolean;
    currentCommandId: number | null;
    executionToken: string | null;
    lastSeenAt: string;
    commandStartedAt: string | null;
}

export interface CommandWorkerPoolSnapshot {
    started: boolean;
    queuedJobs: number;
    workers: CommandWorkerSnapshot[];
}

/**
 * Marker for jobs interrupted by pool shutdown (deploy/restart), as opposed to
 * jobs that genuinely failed. Callers use this to leave the command row in
 * 'started' so boot recovery re-queues it immediately instead of persisting a
 * failure that waits for the next due-check.
 */
export const POOL_SHUTDOWN_MESSAGE = "Job worker pool shutting down";

export function isPoolShutdownError(error: unknown): boolean {
    return error instanceof Error && error.message === POOL_SHUTDOWN_MESSAGE;
}

interface JobSettle {
    commandId: number;
    executionToken?: string;
    resolve: () => void;
    reject: (error: Error) => void;
    onProgress?: (state: unknown) => void;
    leaseMs?: number;
    heartbeatMs?: number;
}

interface PoolWorker {
    worker: Worker;
    workerId: string;
    busy: boolean;
    lastSeenAt: number;
    commandStartedAt?: number;
    exited: boolean;
    forcedExitError?: Error;
    settle?: JobSettle;
}

interface QueuedJob extends JobSettle {
    job: CommandModel;
}

export class CommandWorkerPool {
    private static workers: PoolWorker[] = [];
    private static queue: QueuedJob[] = [];
    private static started = false;
    private static testWorkerEntryUrl: string | null = null;

    /**
     * Whether the worker pool is running. True in the live app (started at boot),
     * false in unit tests that never call start() — those run handlers in-process.
     * Callers use this to decide between off-thread dispatch and in-process run.
     */
    static isActive(): boolean {
        return this.started;
    }

    /**
     * Resolve how to spawn a worker for the current runtime.
     *
     * Production runs compiled JS under plain node: spawn `command-worker-entry.js`
     * directly. Dev/tests run TypeScript source under tsx, whose loader does not
     * reach worker threads — so spawn the plain-JS `command-worker-bootstrap.mjs`,
     * which registers tsx inside the worker and then imports the `.ts` entry
     * (passed via workerData.__entry). See command-worker-bootstrap.mjs.
     */
    private static resolveSpawn(workerId: string): { entry: string; workerData: Record<string, unknown> } {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const isCompiled = here.includes(`${path.sep}dist${path.sep}`) || here.endsWith(`${path.sep}dist`);
        const baseWorkerData: Record<string, unknown> = {
            [COMMAND_WORKER_MARKER]: true,
            [COMMAND_WORKER_ID]: workerId,
        };

        if (this.testWorkerEntryUrl) {
            return {
                entry: path.join(here, "command-worker-bootstrap.mjs"),
                workerData: {
                    ...baseWorkerData,
                    __entry: this.testWorkerEntryUrl,
                },
            };
        }

        if (isCompiled) {
            return { entry: path.join(here, "command-worker-entry.js"), workerData: baseWorkerData };
        }

        return {
            entry: path.join(here, "command-worker-bootstrap.mjs"),
            workerData: {
                ...baseWorkerData,
                __entry: pathToFileURL(path.join(here, "command-worker-entry.ts")).href,
            },
        };
    }

    static start(): void {
        if (this.started) return;
        this.started = true;

        const size = Math.max(1, readIntEnv("DISCOGENIUS_SCHEDULER_THREAD_LIMIT", 3, 1));
        for (let i = 0; i < size; i++) {
            this.spawnWorker();
        }
        console.log(`🧵 Command worker pool started (${size} thread${size === 1 ? "" : "s"})`);
    }

    /**
     * Test seam for deterministic crash/hang fixtures. It cannot replace a
     * running pool and is deliberately not read from runtime configuration.
     */
    static configureTestWorkerEntry(entryUrl: string | null): void {
        if (this.started) {
            throw new Error("Cannot replace the command worker entry while the pool is running");
        }
        this.testWorkerEntryUrl = entryUrl;
    }

    static async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        // Reject anything still queued; in-flight jobs are rejected on worker exit.
        for (const queued of this.queue.splice(0)) {
            queued.reject(new Error(POOL_SHUTDOWN_MESSAGE));
        }

        const workers = this.workers.splice(0);
        await Promise.all(workers.map(async (entry) => {
            try {
                entry.worker.postMessage({ kind: "shutdown" } satisfies MainToWorkerMessage);
                await entry.worker.terminate();
            } catch {
                // best-effort shutdown
            }
        }));
        console.log("🧵 Command worker pool stopped");
    }

    /**
     * Run a command on a worker thread. Resolves when the handler completes,
     * rejects if it throws or the worker dies. Queues if all workers are busy
     * (the CommandExecutor already bounds concurrency to the pool size, so the
     * queue is a safety valve rather than the normal path).
     */
    static run(job: CommandModel, options: JobRunOptions = {}): Promise<void> {
        if (!this.started) {
            // Lazily start so callers don't depend on init ordering.
            this.start();
        }
        return new Promise<void>((resolve, reject) => {
            const queued: QueuedJob = {
                job,
                commandId: job.id,
                resolve,
                reject,
                onProgress: options.onProgress,
                leaseMs: options.leaseMs,
                heartbeatMs: options.heartbeatMs,
            };
            const idle = this.workers.find((entry) => !entry.busy);
            if (idle) {
                this.assign(idle, queued);
            } else {
                this.queue.push(queued);
            }
        });
    }

    private static assign(entry: PoolWorker, queued: QueuedJob): void {
        entry.busy = true;
        entry.commandStartedAt = Date.now();
        entry.settle = {
            commandId: queued.commandId,
            executionToken: queued.job.worker_id ?? undefined,
            resolve: queued.resolve,
            reject: queued.reject,
            onProgress: queued.onProgress,
            leaseMs: queued.leaseMs,
            heartbeatMs: queued.heartbeatMs,
        };
        entry.worker.postMessage({
            kind: "run",
            job: queued.job,
            leaseMs: queued.leaseMs,
            heartbeatMs: queued.heartbeatMs,
        } satisfies MainToWorkerMessage);
    }

    private static drainQueue(entry: PoolWorker): void {
        const next = this.queue.shift();
        if (next) {
            this.assign(entry, next);
        }
    }

    private static spawnWorker(): void {
        const workerId = `command-worker:${process.pid}:${randomUUID()}`;
        const { entry, workerData } = this.resolveSpawn(workerId);
        const worker = new Worker(entry, { workerData });
        const poolWorker: PoolWorker = {
            worker,
            workerId,
            busy: false,
            lastSeenAt: Date.now(),
            exited: false,
        };

        worker.on("message", (message: WorkerToMainMessage) => this.handleMessage(poolWorker, message));
        worker.on("error", (error) => this.handleWorkerExit(poolWorker, error));
        worker.on("exit", (code) => {
            this.handleWorkerExit(
                poolWorker,
                new Error(
                    code === 0
                        ? "Job worker exited unexpectedly with code 0"
                        : `Job worker exited with code ${code}`,
                ),
            );
        });

        this.workers.push(poolWorker);
    }

    private static handleMessage(entry: PoolWorker, message: WorkerToMainMessage): void {
        // `error` and `exit` can both fire for one worker. Once the first signal
        // recovered its command and removed the worker, ignore all late
        // messages from that physical thread.
        if (entry.exited) return;
        entry.lastSeenAt = Date.now();
        switch (message.kind) {
            case "ready":
                break;
            // The process-global SQLite write lock is owned here; workers ask
            // for it over the bridge so they wait asynchronously and keep
            // heartbeating. See sqlite-write-lock.ts.
            case "writeLockAcquire":
                ownerAcquire(message.requestId, entry.workerId, () => {
                    if (entry.exited) {
                        // Granted to a worker that died while queued — hand it
                        // straight back rather than wedging every other writer.
                        ownerRelease(message.requestId);
                        return;
                    }
                    entry.worker.postMessage({
                        kind: "writeLockGranted",
                        requestId: message.requestId,
                    } satisfies MainToWorkerMessage);
                }, message.label);
                break;
            case "writeLockRelease":
                ownerRelease(message.requestId);
                break;
            case "heartbeat":
                // The worker itself renewed the durable DB lease. This message
                // provides independent worker last-seen/current-command
                // evidence for diagnostics and watchdog decisions.
                if (
                    entry.settle
                    && entry.settle.commandId === message.commandId
                    && (!message.physicalWorkerId || message.physicalWorkerId === entry.workerId)
                ) {
                    entry.lastSeenAt = Date.parse(message.sentAt) || Date.now();
                }
                break;
            case "event":
                // Re-emit on the main appEvents so SSE + main-thread listeners
                // (curation/download) see worker-originated events.
                appEvents.emit(message.event as AppEvent, message.payload as never);
                break;
            case "cacheInvalidate":
                this.applyCacheInvalidate(message.target, message.key);
                break;
            case "importProgress":
                if (entry.settle && entry.settle.commandId === message.commandId) {
                    entry.settle.onProgress?.(message.state);
                }
                break;
            case "done":
                this.finishJob(entry, message.commandId, null);
                break;
            case "error":
                this.finishJob(entry, message.commandId, new Error(message.message));
                break;
        }
    }

    private static applyCacheInvalidate(target: CacheInvalidateTarget, key?: string): void {
        switch (target) {
            case "album":
                if (key) invalidateAlbumDownloadStatus(key);
                break;
            case "releaseGroup":
                if (key) invalidateReleaseGroupDownloadStatus(key);
                break;
            case "artist":
                if (key) invalidateArtistDownloadStatus(key);
                break;
            case "media":
                if (key) invalidateMediaDownloadState(key);
                break;
            case "all":
                invalidateAllDownloadState();
                break;
        }
    }

    private static finishJob(entry: PoolWorker, commandId: number, error: Error | null): void {
        const settle = entry.settle;
        // A late result must never release a worker that is already associated
        // with a different command.
        if (!settle || settle.commandId !== commandId) {
            return;
        }
        entry.busy = false;
        entry.commandStartedAt = undefined;
        entry.settle = undefined;

        if (error) settle.reject(error);
        else settle.resolve();

        this.drainQueue(entry);
    }

    private static handleWorkerExit(entry: PoolWorker, error: Error): void {
        if (entry.exited) return;
        entry.exited = true;
        // A worker that dies holding the write lock would otherwise stop the
        // whole process writing, forever.
        ownerReleaseAllFor(entry.workerId);
        // Reject the in-flight job (if any) and replace the dead worker so the
        // pool stays at full size. When the pool is stopping (deploy/restart),
        // the worker exit is expected — report it as a shutdown interruption so
        // the executor leaves the command 'started' for boot re-queue instead of
        // marking it failed.
        const settle = entry.settle;
        entry.settle = undefined;
        entry.commandStartedAt = undefined;
        if (settle) {
            settle.reject(this.started ? (entry.forcedExitError ?? error) : new Error(POOL_SHUTDOWN_MESSAGE));
        }

        const index = this.workers.indexOf(entry);
        if (index !== -1) {
            this.workers.splice(index, 1);
        }

        if (this.started) {
            console.error("🧵 Command worker died, respawning:", error.message);
            this.spawnWorker();
            // A freshly spawned worker is idle — pull any queued work onto it.
            const replacement = this.workers[this.workers.length - 1];
            if (replacement) this.drainQueue(replacement);
        }
    }

    /**
     * Terminate the worker currently executing a specific owned attempt. The
     * pool exit handler rejects that run and immediately restores capacity.
     */
    static abortCommand(commandId: number, executionToken?: string, reason = "Command execution aborted"): boolean {
        const queuedIndex = this.queue.findIndex((candidate) => (
            candidate.commandId === commandId
            && (!executionToken || candidate.job.worker_id === executionToken)
        ));
        if (queuedIndex !== -1) {
            const [queued] = this.queue.splice(queuedIndex, 1);
            queued.reject(new Error(reason));
            return true;
        }

        const entry = this.workers.find((candidate) => {
            if (candidate.settle?.commandId !== commandId) return false;
            if (!executionToken) return true;
            const queuedToken = this.getExecutionToken(candidate);
            return queuedToken === executionToken;
        });
        if (!entry || entry.exited) return false;

        const abortError = new Error(reason);
        entry.forcedExitError = abortError;
        const termination = entry.worker.terminate();
        // Retire the ownership synchronously so a `done` message racing the
        // asynchronous terminate cannot free this worker or receive a queued
        // replacement command.
        this.handleWorkerExit(entry, abortError);
        void termination.catch((error) => {
            this.handleWorkerExit(entry, error instanceof Error ? error : new Error(String(error)));
        });
        return true;
    }

    static getSnapshot(): CommandWorkerPoolSnapshot {
        return {
            started: this.started,
            queuedJobs: this.queue.length,
            workers: this.workers.map((entry) => ({
                workerId: entry.workerId,
                busy: entry.busy,
                currentCommandId: entry.settle?.commandId ?? null,
                executionToken: this.getExecutionToken(entry),
                lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
                commandStartedAt: entry.commandStartedAt == null
                    ? null
                    : new Date(entry.commandStartedAt).toISOString(),
            })),
        };
    }

    private static getExecutionToken(entry: PoolWorker): string | null {
        return entry.settle?.executionToken ?? null;
    }
}
