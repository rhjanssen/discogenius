import { isSqliteBusyError, runWithAsyncBusyRetry } from "../../database.js";
import {CommandQueueManager, type CommandModel} from "./command-queue-manager.js";
import { commandExecutors } from "./executors/registry.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";
import {
    resolveInfrastructureMaxAttempts,
} from "./command-liveness-policy.js";
import { queueNextMonitoringPass } from "./scheduler.js";
import { normalizeUnclassifiedRemoteError } from "../../utils/remote-operation-error.js";

const COMMAND_MAX_ATTEMPTS = 3;
const COMMAND_RETRY_BASE_MS = 1_000;
const COMMAND_RETRY_MAX_MS = 60_000;

function retryDelayForAttempt(attempt: number): number {
    return Math.min(COMMAND_RETRY_MAX_MS, COMMAND_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
}

/**
 * Shared command-execution helpers.
 *
 * Both execution paths use these identical semantics:
 *  - the inline `CommandExecutor` (single event loop), and
 *  - the off-thread `command-worker-entry` (real OS thread via worker_threads).
 *
 * They only depend on `CommandQueueManager` (DB + event emit) and `setImmediate`,
 * so they are safe to run on a worker thread — which is the whole point of
 * keeping them out of the `CommandExecutor` class. See
 * `CommandExecutor` / `CommandWorkerPool`.
 */

export function updateCommandDescription(
    job: CommandModel,
    options: { progress?: number; description?: string },
): void {
    const payloadPatch: Record<string, unknown> = {};
    if (options.description) {
        payloadPatch.description = options.description;
    }

    CommandQueueManager.updateState(job.id, {
        progress: options.progress,
        payloadPatch: Object.keys(payloadPatch).length > 0 ? payloadPatch : undefined,
        workerId: job.worker_id ?? undefined,
        progressPhase: options.description,
        progressCurrent: options.progress,
        progressTotal: options.progress == null ? undefined : 100,
    });
}

export function resolveArtistLabel(job: CommandModel): string {
    const payloadArtist = String(job.payload?.artistName || "").trim();
    if (payloadArtist && payloadArtist.toLowerCase() !== 'unknown artist') {
        return payloadArtist;
    }

    const workflow = String(job.payload?.workflow || "").trim();
    switch (workflow) {
        case 'monitoring-intake':
        case 'full-monitoring':
            return '';
        case 'refresh-scan':
            return '';
        case 'metadata-refresh':
            return 'artist metadata';
        case 'library-scan':
            return 'library folders';
        default:
            return '';
    }
}

export function formatArtistPhaseDescription(job: CommandModel, phase: string, fallback = 'Artist'): string {
    const subject = resolveArtistLabel(job) || fallback;
    return `${subject} · ${phase}`;
}

export function formatWorkflowCommandLabel(job: CommandModel, fallback: string): string {
    const workflow = String(job.payload?.workflow || '').trim();
    const subject = resolveArtistLabel(job) || fallback;

    switch (workflow) {
        case 'monitoring-intake':
        case 'full-monitoring':
            return `Monitoring ${subject}`;
        case 'refresh-scan':
            return `Refreshing ${subject}`;
        case 'metadata-refresh':
            return `Refreshing metadata for ${subject}`;
        case 'library-scan':
            return `Scanning ${subject}`;
        case 'curation':
            return `Curating ${subject}`;
        default:
            return subject;
    }
}

/**
 * Cooperative yield: hand the single Node event loop back to pending I/O
 * (HTTP requests, SSE, timers) between heavy work units. better-sqlite3 is
 * synchronous, so a long inline batch (e.g. scanning 50 artists) would
 * otherwise monopolize the loop and starve the API. On a worker thread this
 * yields the *worker's* loop (so its own progress emits / cancel checks fire),
 * while the main thread is already free regardless.
 */
export function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

/** Build the per-command handler context (progress helpers + cooperative yield). */
export function buildHandlerContext(): CommandHandlerContext {
    return {
        updateCommandDescription: (job, options) => updateCommandDescription(job, options),
        formatArtistPhaseDescription: (job, phase, fallback) => formatArtistPhaseDescription(job, phase, fallback),
        formatWorkflowCommandLabel: (job, fallback) => formatWorkflowCommandLabel(job, fallback),
        resolveArtistLabel: (job) => resolveArtistLabel(job),
        yieldToEventLoop: () => yieldToEventLoop(),
    };
}

/**
 * Execute a claimed command's lifecycle — run handler → complete/fail → queue
 * the next monitoring pass — entirely on the calling thread's DB connection.
 *
 * Running complete/fail/next-pass here (rather than on the main thread) is what
 * keeps the main event loop free under a scan backlog: those writes happen on
 * worker connections, so a contended write never blocks the HTTP/SSE loop. The
 * synchronous *claim* (markProcessing) stays on the main `CommandExecutor` so
 * exclusivity (canStartCommand reads `status='started'`) is race-free; this
 * function assumes the command is already claimed. In the live app it runs on a
 * worker thread (`command-worker-entry`); in unit tests (no worker pool) it runs
 * inline on the main thread.
 *
 * Never throws — handler failures are caught and persisted via `fail`,
 * except SQLITE_BUSY on retry-safe commands, which is re-queued.
 */
export async function persistCommandOutcome(
    job: CommandModel,
    handlerError: unknown,
): Promise<"completed" | "failed" | "requeued" | false> {
    if (!handlerError) {
        const completed = await runWithAsyncBusyRetry(
            () => CommandQueueManager.complete(job.id, job.worker_id ?? undefined),
        );
        if (completed) {
            console.log(`[Queue] Command #${job.id} completed`);
            return "completed";
        }
        return false;
    }

    const classified = normalizeUnclassifiedRemoteError(handlerError);
    const message = classified?.message
        ?? (handlerError instanceof Error ? handlerError.message : "Unknown command error");

    if (
        isSqliteBusyError(handlerError)
        && job.worker_id
        && resolveInfrastructureMaxAttempts(job.name, COMMAND_MAX_ATTEMPTS) > 1
    ) {
        const recovered = await runWithAsyncBusyRetry(
            () => CommandQueueManager.recoverOwnedCommand({
                id: job.id,
                workerId: job.worker_id as string,
                reason: `sqlite busy: ${message}`,
                maxAttempts: resolveInfrastructureMaxAttempts(job.name, COMMAND_MAX_ATTEMPTS),
                retryDelayMs: retryDelayForAttempt(job.attempt),
            }),
        );
        if (recovered.outcome === "requeued") {
            console.warn(`[Queue] Re-queued command #${job.id} after SQLITE_BUSY`);
            return "requeued";
        }
        if (recovered.outcome === "failed") {
            console.error(`[Queue] Command #${job.id} exhausted SQLITE_BUSY retries`);
            return "failed";
        }
        return false;
    }

    const failed = await runWithAsyncBusyRetry(
        () => CommandQueueManager.fail(job.id, message, job.worker_id ?? undefined),
    );
    return failed ? "failed" : false;
}

export async function executeCommand(job: CommandModel): Promise<void> {
    console.log(`[Queue] Processing Command #${job.id}: ${job.name}`);
    let handlerError: unknown = null;
    try {
        const executor = commandExecutors[job.name];
        if (executor) {
            await executor.execute(job, buildHandlerContext());
        } else {
            console.warn(`CommandExecutor picked up unhandled command: ${job.name}`);
        }
    } catch (error) {
        handlerError = error;
        console.error(`[Queue] Command #${job.id} failed:`, error);
    }

    // Persist the outcome with an async busy-retry that yields this thread's
    // loop between attempts. This must never throw past here: under heavy write
    // load the complete/fail UPDATE itself can hit SQLITE_BUSY, and an escaped
    // error here previously rode the worker bridge back to the main thread as an
    // unhandled rejection and aborted the whole process. If the write still
    // fails after retries, the row stays 'started' and is recovered as an
    // interrupted job on the next executor start.
    let outcome: "completed" | "failed" | "requeued" | false = false;
    try {
        outcome = await persistCommandOutcome(job, handlerError);
    } catch (persistError) {
        console.error(`[Queue] Could not persist outcome for command #${job.id} (${job.name}):`, persistError);
    }

    if (outcome === "completed" || outcome === "failed") {
        try {
            queueNextMonitoringPass(job);
        } catch (chainError) {
            console.error(`[Queue] Failed to queue next monitoring pass after command #${job.id}:`, chainError);
        }
    } else if (job.worker_id && outcome === false) {
        console.warn(
            `[Queue] Ignoring stale outcome/chaining for command #${job.id}; execution ownership changed`,
        );
    }
}
