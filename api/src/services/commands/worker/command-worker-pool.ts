import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { readIntEnv } from "../../../utils/env.js";
import { appEvents, type AppEvent } from "../app-events.js";
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
    type CacheInvalidateTarget,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
} from "./command-worker-protocol.js";

/**
 * Main-thread pool of command worker threads — the off-thread execution backend for
 * the `CommandExecutor`, modelled on Lidarr's `THREAD_LIMIT = 3` real-thread
 * `CommandExecutor`. Each worker runs one command handler at a time on its own
 * OS thread + DB connection, so heavy synchronous better-sqlite3 / CPU work
 * never blocks the main thread's HTTP + SSE loop.
 *
 * Always on in the running app — the pool is started unconditionally at boot,
 * mirroring Lidarr's `CommandExecutor`, which spawns its thread pool on
 * ApplicationStartedEvent with no single/multi toggle. Callers dispatch to the
 * pool when it `isActive()` (i.e. started); otherwise they run the work
 * in-process. The only context where the pool isn't started is unit tests that
 * exercise handler logic directly (cf. Lidarr's CommandExecutorFixture, which
 * runs `IExecute` handlers in-process without the real thread pool). See
 * `CommandExecutor`.
 */

/** Optional per-run hooks. `onProgress` receives ImportDownload progress states. */
export interface JobRunOptions {
    onProgress?: (state: unknown) => void;
}

interface JobSettle {
    commandId: number;
    resolve: () => void;
    reject: (error: Error) => void;
    onProgress?: (state: unknown) => void;
}

interface PoolWorker {
    worker: Worker;
    busy: boolean;
    settle?: JobSettle;
}

interface QueuedJob extends JobSettle {
    job: CommandModel;
}

export class CommandWorkerPool {
    private static workers: PoolWorker[] = [];
    private static queue: QueuedJob[] = [];
    private static started = false;

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
    private static resolveSpawn(): { entry: string; workerData: Record<string, unknown> } {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const isCompiled = here.includes(`${path.sep}dist${path.sep}`) || here.endsWith(`${path.sep}dist`);
        const baseWorkerData: Record<string, unknown> = { [COMMAND_WORKER_MARKER]: true };

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

    static async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        // Fail anything still queued; in-flight jobs are rejected on worker exit.
        for (const queued of this.queue.splice(0)) {
            queued.reject(new Error("Job worker pool shutting down"));
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
            const queued: QueuedJob = { job, commandId: job.id, resolve, reject, onProgress: options.onProgress };
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
        entry.settle = { commandId: queued.commandId, resolve: queued.resolve, reject: queued.reject, onProgress: queued.onProgress };
        entry.worker.postMessage({ kind: "run", job: queued.job } satisfies MainToWorkerMessage);
    }

    private static drainQueue(entry: PoolWorker): void {
        const next = this.queue.shift();
        if (next) {
            this.assign(entry, next);
        }
    }

    private static spawnWorker(): void {
        const { entry, workerData } = this.resolveSpawn();
        const worker = new Worker(entry, { workerData });
        const poolWorker: PoolWorker = { worker, busy: false };

        worker.on("message", (message: WorkerToMainMessage) => this.handleMessage(poolWorker, message));
        worker.on("error", (error) => this.handleWorkerExit(poolWorker, error));
        worker.on("exit", (code) => {
            if (code !== 0) {
                this.handleWorkerExit(poolWorker, new Error(`Job worker exited with code ${code}`));
            }
        });

        this.workers.push(poolWorker);
    }

    private static handleMessage(entry: PoolWorker, message: WorkerToMainMessage): void {
        switch (message.kind) {
            case "ready":
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
        entry.busy = false;
        entry.settle = undefined;

        if (settle && settle.commandId === commandId) {
            if (error) settle.reject(error);
            else settle.resolve();
        }

        this.drainQueue(entry);
    }

    private static handleWorkerExit(entry: PoolWorker, error: Error): void {
        // Reject the in-flight job (if any) and replace the dead worker so the
        // pool stays at full size.
        const settle = entry.settle;
        entry.settle = undefined;
        if (settle) {
            settle.reject(error);
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
}
