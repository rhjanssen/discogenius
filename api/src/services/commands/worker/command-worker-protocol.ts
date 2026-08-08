import { isMainThread, parentPort, workerData } from "node:worker_threads";

import type {CommandModel} from "../command-model.js";

/**
 * Message protocol + thread bridge for off-thread job execution.
 *
 * Node runs JS on one event loop per thread, so a worker thread sees none of
 * the main thread's in-process singletons — the `appEvents` emitter (which
 * feeds SSE and the curation/download listeners) and the `download-state`
 * caches. This module is the single bridge across that boundary:
 *
 *   worker  --postMessage-->  main
 *     • every appEvents emit  ->  re-emitted on the main appEvents (SSE + listeners)
 *     • every cache invalidate -> applied to the main download-state caches
 *
 * It is intentionally dependency-light (only `node:worker_threads` + a type) so
 * it can be imported by hot-path modules (`app-events`, `download-state`)
 * without dragging in the command/handler graph or risking an import cycle.
 *
 * See `CommandWorkerPool`.
 */

/** Marker placed in `workerData` when *we* spawn a command worker. */
export const COMMAND_WORKER_MARKER = "discogeniusCommandWorker" as const;
export const COMMAND_WORKER_ID = "discogeniusCommandWorkerId" as const;
const DOWNLOAD_WORKER_MARKER = "discogeniusDownloadWorker" as const;

/** download-state cache families the bridge can invalidate across threads. */
export type CacheInvalidateTarget = "album" | "releaseGroup" | "artist" | "media" | "all";

/** worker → main messages. */
export type WorkerToMainMessage =
    | { kind: "ready"; physicalWorkerId?: string }
    | {
        kind: "heartbeat";
        commandId: number;
        workerId: string;
        physicalWorkerId?: string;
        renewed: boolean;
        sentAt: string;
      }
    | { kind: "event"; event: string; payload: unknown }
    | { kind: "cacheInvalidate"; target: CacheInvalidateTarget; key?: string }
    | { kind: "importProgress"; commandId: number; state: unknown }
    | { kind: "done"; commandId: number }
    | { kind: "error"; commandId: number; message: string }
    // The process-global SQLite write lock lives on the main thread; see
    // sqlite-write-lock.ts for why a worker-local mutex cannot work.
    | { kind: "writeLockAcquire"; requestId: string; label?: string }
    | { kind: "writeLockRelease"; requestId: string };

/** main → worker messages. */
export type MainToWorkerMessage =
    | { kind: "run"; job: CommandModel; leaseMs?: number; heartbeatMs?: number }
    | { kind: "shutdown" }
    | { kind: "writeLockGranted"; requestId: string };

/**
 * True only inside a worker thread that *we* spawned for job execution. Other
 * (hypothetical) worker_threads usage won't trip this, so the forwarders below
 * stay inert outside the command-worker context.
 */
export function isCommandWorker(): boolean {
    return !isMainThread && !!parentPort && (workerData as Record<string, unknown> | null)?.[COMMAND_WORKER_MARKER] === true;
}

export function getCommandWorkerId(): string | undefined {
    if (!isCommandWorker()) return undefined;
    const value = (workerData as Record<string, unknown> | null)?.[COMMAND_WORKER_ID];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBridgeWorker(): boolean {
    if (isMainThread || !parentPort) return false;
    const data = workerData as Record<string, unknown> | null;
    return data?.[COMMAND_WORKER_MARKER] === true || data?.[DOWNLOAD_WORKER_MARKER] === true;
}

function postToMain(message: WorkerToMainMessage): void {
    // Guarded by isBridgeWorker() so this is a cheap no-op on the main thread.
    if (!isBridgeWorker() || !parentPort) return;
    parentPort.postMessage(message);
}

/**
 * Forward an appEvents emission to the main thread. No-op on the main thread.
 * Called from the `appEvents` emit chokepoint so *all* event types are bridged
 * with one hook (COMMAND_*, ARTIST_REFRESH_COMPLETE, ARTIST_SCANNED, FILE_*, …).
 */
export function forwardEventToMain(event: string, payload: unknown): void {
    postToMain({ kind: "event", event, payload });
}

/**
 * Forward a download-state cache invalidation to the main thread. No-op on the
 * main thread. Keeps the main thread's 30s read-through stats caches coherent
 * with writes performed on the worker.
 */
export function forwardCacheInvalidate(target: CacheInvalidateTarget, key?: string): void {
    postToMain({ kind: "cacheInvalidate", target, key });
}

/**
 * Forward an ImportDownload progress update to the main thread, where the
 * download processor relays it to the download-progress SSE stream
 * (`download-events`) and persists job state. No-op on the main thread.
 */
export function forwardImportProgress(commandId: number, state: unknown): void {
    postToMain({ kind: "importProgress", commandId, state });
}
