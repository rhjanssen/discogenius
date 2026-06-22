import { CommandQueueService, CommandModel, NON_DOWNLOAD_COMMAND_NAMES, DOWNLOAD_OR_IMPORT_COMMAND_NAMES } from "./command-queue.js";
import { CommandManager } from "./command.js";
import { readIntEnv } from "../../utils/env.js";
import { queueNextMonitoringPass } from "./scheduler.js";
import { commandHandlers } from "./handlers/index.js";
import type { CommandHandler, CommandHandlerContext } from "./handlers/index.js";

export { formatHealthCheckDescription } from "./scheduler-maintenance-handlers.js";

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_SCHEDULER_POLL_MS', 2000, 1); // 2 seconds default
const BLOCKED_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_SCHEDULER_BLOCKED_LOG_THROTTLE_MS', 30_000, 0);
const STUCK_JOB_MS = readIntEnv('DISCOGENIUS_SCHEDULER_STUCK_JOB_MS', 0, 0); // 0 = disabled
const STUCK_CLEANUP_INTERVAL_MS = readIntEnv('DISCOGENIUS_SCHEDULER_STUCK_CLEANUP_INTERVAL_MS', 60_000, 1);
const SCHEDULER_THREAD_LIMIT = readIntEnv('DISCOGENIUS_SCHEDULER_THREAD_LIMIT', 3, 1);

/**
 * CommandExecutor - executes queued non-download jobs (scans, curation,
 * maintenance). Analogous to Lidarr's CommandExecutor: it drains the command
 * queue and runs handlers, up to SCHEDULER_THREAD_LIMIT at a time. (The periodic
 * trigger that *enqueues* scheduled tasks lives in scheduler.ts.)
 *
 * Respects command exclusivity rules:
 * - Per-ref-exclusive commands (e.g. only one RefreshArtist/CurateArtist per artist at a time;
 *   different artists can run concurrently up to SCHEDULER_THREAD_LIMIT)
 * - Type-exclusive commands (only one of that type globally; e.g. RefreshMetadata)
 * - Disk-intensive commands (only one at a time)
 * - Exclusive commands (block everything else)
 *
 * Supports bounded concurrency:
 * Up to SCHEDULER_THREAD_LIMIT non-exclusive jobs may run in parallel.
 */
export class CommandExecutor {
    private static isRunning = false;
    private static blockedLogAt = new Map<string, number>();
    private static lastStuckCleanupAt = 0;
    private static activeJobs = new Map<number, Promise<void>>();

    static start() {
        if (this.isRunning) return;
        this.isRunning = true;

        // Recover interrupted non-download jobs after process restart.
        const recovered = CommandQueueService.resetProcessingJobsByTypes(NON_DOWNLOAD_COMMAND_NAMES);
        if (recovered > 0) {
            console.log(`[CommandExecutor] Re-queued ${recovered} interrupted non-download job(s)`);
        }

        console.log("🚀 Command executor started");
        void this.loop();
    }

    static stop() {
        this.isRunning = false;
        this.blockedLogAt.clear();
        this.lastStuckCleanupAt = 0;
        this.activeJobs.clear();
        console.log("🛑 Command executor stopped");
    }

    private static async sleep(ms: number) {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Cooperative yield: hand the single Node event loop back to pending I/O
     * (HTTP requests, SSE, timers) between heavy work units. better-sqlite3 is
     * synchronous, so a long inline batch (e.g. scanning 50 artists) would
     * otherwise monopolize the loop and starve the API. This is the
     * single-threaded stand-in for Lidarr's off-thread command execution; the
     * real fix (worker_threads) is tracked in docs/JOB_EXECUTION_THREADING_PLAN.md.
     */
    private static async yieldToEventLoop() {
        await new Promise(resolve => setImmediate(resolve));
    }

    private static updateJobDescription(job: CommandModel, options: { progress?: number; description?: string }) {
        const payloadPatch: Record<string, unknown> = {};
        if (options.description) {
            payloadPatch.description = options.description;
        }

        CommandQueueService.updateState(job.id, {
            progress: options.progress,
            payloadPatch: Object.keys(payloadPatch).length > 0 ? payloadPatch : undefined,
        });
    }

    private static resolveArtistLabel(job: CommandModel) {
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

    private static formatArtistPhaseDescription(job: CommandModel, phase: string, fallback = 'Artist') {
        const subject = this.resolveArtistLabel(job) || fallback;
        return `${subject} · ${phase}`;
    }

    private static formatWorkflowJobLabel(job: CommandModel, fallback: string) {
        const workflow = String(job.payload?.workflow || '').trim();
        const subject = this.resolveArtistLabel(job) || fallback;

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

    private static logBlocked(type: string, reason?: string) {
        const key = `${type}:${reason ?? 'unknown'}`;
        const now = Date.now();
        const last = this.blockedLogAt.get(key) ?? 0;

        if (now - last >= BLOCKED_LOG_THROTTLE_MS) {
            this.blockedLogAt.set(key, now);
            console.log(`[CommandExecutor] Cannot start ${type}: ${reason ?? 'blocked by command rules'}`);
        }
    }

    private static maybeCleanupStuckJobs() {
        if (STUCK_JOB_MS <= 0) return;

        const now = Date.now();
        if (now - this.lastStuckCleanupAt < STUCK_CLEANUP_INTERVAL_MS) {
            return;
        }
        this.lastStuckCleanupAt = now;

        let recovered = 0;
        const excludeIds = [...this.activeJobs.keys()];
        for (const type of NON_DOWNLOAD_COMMAND_NAMES) {
            recovered += CommandQueueService.requeueStaleProcessingJobs({
                typePattern: type,
                olderThanMs: STUCK_JOB_MS,
                excludeIds,
            });
        }

        if (recovered > 0) {
            console.warn(`[CommandExecutor] Re-queued ${recovered} stale processing non-download job(s)`);
        }
    }

    private static async loop() {
        while (this.isRunning) {
            try {
                this.maybeCleanupStuckJobs();

                // Try to fill all available slots
                const slotsAvailable = SCHEDULER_THREAD_LIMIT - this.activeJobs.size;
                if (slotsAvailable > 0) {
                    const candidates = CommandQueueService.getTopPendingJobsByTypes(NON_DOWNLOAD_COMMAND_NAMES, 20);
                    let started = 0;

                    for (const candidate of candidates) {
                        if (started >= slotsAvailable) break;
                        // Skip jobs already being processed
                        if (this.activeJobs.has(candidate.id)) continue;

                        const { canStart, reason } = CommandManager.canStartCommand(
                            candidate.name, candidate.payload, candidate.ref_id,
                            { excludeRunningTypes: DOWNLOAD_OR_IMPORT_COMMAND_NAMES },
                        );
                        if (canStart) {
                            this.startJob(candidate);
                            started++;
                        } else {
                            this.logBlocked(candidate.name, reason);
                        }
                    }
                }

                await this.sleep(POLL_INTERVAL);
            } catch (error) {
                // Defensive catch: never let loop crash due to unexpected worker error.
                console.error('[CommandExecutor] Worker loop error:', error);
                await this.sleep(POLL_INTERVAL);
            }
        }
    }

    private static startJob(job: CommandModel) {
        // Mark as processing synchronously BEFORE launching async work,
        // so the next poll loop won't re-select this job from the DB.
        if (!CommandQueueService.markProcessing(job.id)) {
            return;
        }
        const promise = this.processJob(job).finally(() => {
            this.activeJobs.delete(job.id);
        });
        this.activeJobs.set(job.id, promise);
    }

    private static buildHandlerContext(): CommandHandlerContext {
        return {
            updateJobDescription: (job, options) => this.updateJobDescription(job, options),
            formatArtistPhaseDescription: (job, phase, fallback) => this.formatArtistPhaseDescription(job, phase, fallback),
            formatWorkflowJobLabel: (job, fallback) => this.formatWorkflowJobLabel(job, fallback),
            resolveArtistLabel: (job) => this.resolveArtistLabel(job),
            yieldToEventLoop: () => this.yieldToEventLoop(),
        };
    }

    private static async processJob(job: CommandModel) {
        console.log(`⚙️ Processing Command #${job.id}: ${job.name}`);

        try {
            const handler = commandHandlers[job.name];
            if (handler) {
                await (handler as CommandHandler)(job, this.buildHandlerContext());
            } else {
                console.warn(`CommandExecutor picked up unhandled command: ${job.name}`);
            }

            CommandQueueService.complete(job.id);
            queueNextMonitoringPass(job);
            console.log(`✅ Command #${job.id} completed`);
        } catch (error: any) {
            console.error(`❌ Command #${job.id} failed:`, error);
            CommandQueueService.fail(job.id, error?.message || 'Unknown scheduler error');
            queueNextMonitoringPass(job);
        }
    }
}
