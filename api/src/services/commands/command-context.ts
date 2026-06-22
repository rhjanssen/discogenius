import {CommandQueueManager, type CommandModel} from "./command-queue-manager.js";
import type { CommandHandlerContext } from "./handlers/index.js";

/**
 * Shared command-execution helpers.
 *
 * Both execution paths use these identical semantics:
 *  - the inline `CommandExecutor` (single event loop, the legacy/fallback path), and
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

/** Build the per-command handler context (Lidarr's per-command service scope). */
export function buildHandlerContext(): CommandHandlerContext {
    return {
        updateCommandDescription: (job, options) => updateCommandDescription(job, options),
        formatArtistPhaseDescription: (job, phase, fallback) => formatArtistPhaseDescription(job, phase, fallback),
        formatWorkflowCommandLabel: (job, fallback) => formatWorkflowCommandLabel(job, fallback),
        resolveArtistLabel: (job) => resolveArtistLabel(job),
        yieldToEventLoop: () => yieldToEventLoop(),
    };
}
