import { randomUUID } from "node:crypto";

import {CommandModel} from "./command-model.js";
import {
    NON_DOWNLOAD_COMMAND_NAMES,
    DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
} from "./command-names.js";
import {
    resolveCommandNoProgressTimeoutMs,
    resolveInfrastructureMaxAttempts,
} from "./command-liveness-policy.js";
import {CommandQueueManager} from "./command-queue-manager.js";
import { runWithAsyncBusyRetry, withSqliteWriteGate } from "../../database.js";
import { CommandManager } from "./command.js";
import { readIntEnv } from "../../utils/env.js";
import { executeCommand } from "./command-context.js";
import { CommandWorkerPool, isPoolShutdownError } from "./worker/command-worker-pool.js";
import { shouldDeferCatalogHydration } from "./command-ordering.js";

export { formatHealthCheckDescription } from "./scheduler-maintenance-handlers.js";

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_SCHEDULER_POLL_MS', 2000, 1); // 2 seconds default
const BLOCKED_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_SCHEDULER_BLOCKED_LOG_THROTTLE_MS', 30_000, 0);
// Five minutes tolerates a long synchronous SQLite/fs call that temporarily
// prevents the worker's timer from firing, while the 30s heartbeat normally
// gives the watchdog much fresher evidence.
const COMMAND_LEASE_MS = readIntEnv('DISCOGENIUS_COMMAND_LEASE_MS', 5 * 60_000, 1_000);
const COMMAND_HEARTBEAT_MS = Math.min(
    readIntEnv('DISCOGENIUS_COMMAND_HEARTBEAT_MS', 30_000, 250),
    Math.max(250, Math.floor(COMMAND_LEASE_MS / 2)),
);
// A positive override is useful for deterministic failure injection. Zero uses
// the conservative command-specific expectations below.
const COMMAND_NO_PROGRESS_MS = readIntEnv('DISCOGENIUS_COMMAND_NO_PROGRESS_MS', 0, 0);
const COMMAND_WATCHDOG_INTERVAL_MS = readIntEnv('DISCOGENIUS_COMMAND_WATCHDOG_INTERVAL_MS', 5_000, 100);
const COMMAND_MAX_ATTEMPTS = readIntEnv('DISCOGENIUS_COMMAND_MAX_ATTEMPTS', 3, 1);
const COMMAND_RETRY_BASE_MS = readIntEnv('DISCOGENIUS_COMMAND_RETRY_BASE_MS', 1_000, 0);
const COMMAND_RETRY_MAX_MS = readIntEnv('DISCOGENIUS_COMMAND_RETRY_MAX_MS', 60_000, 0);
const SCHEDULER_THREAD_LIMIT = readIntEnv('DISCOGENIUS_SCHEDULER_THREAD_LIMIT', 3, 1);

interface ActiveCommandAttempt {
    workerId: string;
    promise: Promise<void>;
}

export interface CommandWatchdogPassResult {
    requeued: number;
    failed: number;
    stale: number;
}

function retryDelayForAttempt(attempt: number, baseMs: number, maxMs: number): number {
    if (baseMs <= 0) return 0;
    return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
}

/**
 * One deterministic lease/no-progress watchdog pass. Exported so recovery can
 * be verified without starting the executor's perpetual polling loop.
 */
export function recoverStaleNonDownloadCommands(options: {
    now?: Date;
    noProgressMs: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
}): CommandWatchdogPassResult {
    const stale = CommandQueueManager.findStaleExecutionLeases({
        types: NON_DOWNLOAD_COMMAND_NAMES,
        now: options.now,
        noProgressMs: options.noProgressMs > 0 ? options.noProgressMs : undefined,
        resolveNoProgressMs: resolveCommandNoProgressTimeoutMs,
    });
    let requeued = 0;
    let failed = 0;

    for (const command of stale) {
        const result = CommandQueueManager.recoverOwnedCommand({
            id: command.id,
            workerId: command.workerId,
            reason: `${command.reason}; last heartbeat ${command.heartbeatAt ?? "never"}, last progress ${command.lastProgressAt ?? "never"}`,
            maxAttempts: resolveInfrastructureMaxAttempts(
                command.name,
                options.maxAttempts,
            ),
            retryDelayMs: retryDelayForAttempt(
                command.attempt,
                options.retryBaseMs,
                options.retryMaxMs,
            ),
            now: options.now,
        });
        if (result.outcome === "not-owner") continue;

        CommandWorkerPool.abortCommand(
            command.id,
            command.workerId,
            `Command watchdog recovered ${command.reason}`,
        );
        if (result.outcome === "requeued") requeued += 1;
        if (result.outcome === "failed") failed += 1;
        console.warn(
            result.outcome === "requeued"
                ? `[CommandExecutor] Re-queued command #${command.id} after ${command.reason} (attempt ${command.attempt})`
                : `[CommandExecutor] Poison-failed command #${command.id} after ${command.reason} (attempt ${command.attempt})`,
        );
    }
    return { requeued, failed, stale: stale.length };
}

/**
 * CommandExecutor - executes queued non-download jobs (scans, curation,
 * maintenance). Drains the command queue and runs handlers, up to
 * SCHEDULER_THREAD_LIMIT at a time. (The periodic trigger that *enqueues*
 * scheduled tasks lives in scheduler.ts.)
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
    private static lastWatchdogAt = 0;
    private static activeJobs = new Map<number, ActiveCommandAttempt>();

    static start() {
        if (this.isRunning) return;
        this.isRunning = true;

        // Recover interrupted non-download jobs after process restart.
        const recovered = CommandQueueManager.recoverInterruptedJobsByTypes({
            types: NON_DOWNLOAD_COMMAND_NAMES,
            reason: "Discogenius process restarted while command was running",
            maxAttempts: COMMAND_MAX_ATTEMPTS,
            resolveMaxAttempts: (name) => resolveInfrastructureMaxAttempts(
                name,
                COMMAND_MAX_ATTEMPTS,
            ),
        });
        if (recovered.requeued > 0 || recovered.failed > 0) {
            console.log(
                `[CommandExecutor] Restart recovery re-queued ${recovered.requeued} and poison-failed ${recovered.failed} interrupted non-download job(s)`,
            );
        }

        console.log("🚀 Command executor started");
        void this.loop();
    }

    static stop() {
        this.isRunning = false;
        this.blockedLogAt.clear();
        this.lastWatchdogAt = 0;
        this.activeJobs.clear();
        console.log("🛑 Command executor stopped");
    }

    private static async sleep(ms: number) {
        await new Promise(resolve => setTimeout(resolve, ms));
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

    private static async maybeRecoverStaleJobs() {
        const now = Date.now();
        if (now - this.lastWatchdogAt < COMMAND_WATCHDOG_INTERVAL_MS) {
            return;
        }
        this.lastWatchdogAt = now;

        // Under the process-global gate. Without it these queue writes raced
        // three refresh workers for SQLite's single writer lock and lost:
        // better-sqlite3 is synchronous, so each lost race froze the event loop
        // for a full busy_timeout — measured at a 1.0s median and 5s worst case,
        // which is the server "hanging" under refresh load. Waiting for the gate
        // is a promise, so the loop keeps serving while it waits.
        await withSqliteWriteGate(() => recoverStaleNonDownloadCommands({
            noProgressMs: COMMAND_NO_PROGRESS_MS,
            maxAttempts: COMMAND_MAX_ATTEMPTS,
            retryBaseMs: COMMAND_RETRY_BASE_MS,
            retryMaxMs: COMMAND_RETRY_MAX_MS,
        }), "commands:recover-stale");
    }

    private static async loop() {
        while (this.isRunning) {
            try {
                await this.maybeRecoverStaleJobs();

                // Try to fill all available slots
                const executorSlots = SCHEDULER_THREAD_LIMIT - this.activeJobs.size;
                // Imports share this pool. Do not claim a durable command until
                // a physical worker is actually available; a claimed command
                // sitting in the pool's safety queue has no worker heartbeat
                // and would look falsely stale during a long import.
                const poolSlots = CommandWorkerPool.isActive()
                    ? CommandWorkerPool.getSnapshot().workers.filter((worker) => !worker.busy).length
                    : executorSlots;
                const slotsAvailable = Math.min(executorSlots, poolSlots);
                if (slotsAvailable > 0) {
                    // Per-type cap keeps the candidate window diverse: a deep
                    // single-type backlog (intake queues hundreds of
                    // RefreshArtist) would otherwise fill all 20 rows, and with
                    // that type concurrency-capped the remaining slots idle
                    // while eligible other-type commands sit just past the
                    // window. THREAD_LIMIT + 2 leaves headroom for candidates
                    // blocked by per-ref exclusivity.
                    const candidates = CommandQueueManager.getTopPendingJobsByTypes(
                        NON_DOWNLOAD_COMMAND_NAMES, 20, SCHEDULER_THREAD_LIMIT + 2);
                    let started = 0;

                    for (const candidate of candidates) {
                        if (started >= slotsAvailable) break;
                        // Skip jobs already being processed
                        if (this.activeJobs.has(candidate.id)) continue;

                        const remainingSlotsIncludingThis = slotsAvailable - started;
                        if (shouldDeferCatalogHydration({
                            candidateName: candidate.name,
                            remainingSlotsIncludingThis,
                            pendingNames: candidates
                                .filter((other) => other.id !== candidate.id && !this.activeJobs.has(other.id))
                                .map((other) => other.name),
                        })) {
                            this.logBlocked(
                                candidate.name,
                                "Keeping one worker free for queued operator work",
                            );
                            continue;
                        }

                        const { canStart, reason } = CommandManager.canStartCommand(
                            candidate.name, candidate.payload, candidate.ref_id,
                            { excludeRunningTypes: DOWNLOAD_OR_IMPORT_COMMAND_NAMES },
                        );
                        if (canStart) {
                            await this.startJob(candidate);
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

    private static async startJob(job: CommandModel) {
        // The claim must still complete before the next candidate is evaluated,
        // so exclusivity (per-ref / type / library-wide) stays race-free — the
        // caller awaits this, and the candidate loop is the only thing claiming.
        //
        // It runs under the process-global write gate. This is the write the
        // profiler caught blocking the event loop hardest (a 1.0s median wait,
        // 5s worst case) because it competed with three refresh workers for
        // SQLite's single writer lock and had a deliberately short busy timeout.
        // Inside the gate there is exactly one writer, so the wait is a promise
        // rather than a frozen server.
        const workerId = `command-attempt:${process.pid}:${job.id}:${randomUUID()}`;
        const claimedJob = await withSqliteWriteGate(() => CommandQueueManager.claimForExecution(
            job.id,
            workerId,
            COMMAND_LEASE_MS,
        ), "commands:claim");
        if (!claimedJob) {
            return;
        }
        // Catch every command failure, log it, and move on — a failed command
        // must never take down the executor. Here that means the job promise
        // must never reject unhandled (an escaped rejection aborts the whole
        // Node process).
        const promise = this.processJob(claimedJob)
            .catch(async (error: unknown) => {
                if (isPoolShutdownError(error)) {
                    // Deploy/restart interruption, not a failure: leave the row
                    // 'started' so boot recovery re-queues it immediately.
                    console.log(`[CommandExecutor] Command #${claimedJob.id} (${claimedJob.name}) interrupted by shutdown; will re-queue on next start`);
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[CommandExecutor] Command #${claimedJob.id} (${claimedJob.name}) worker interrupted:`, message);
                try {
                    const recovered = await runWithAsyncBusyRetry(
                        () => CommandQueueManager.recoverOwnedCommand({
                            id: claimedJob.id,
                            workerId,
                            reason: `worker stopped: ${message}`,
                            maxAttempts: resolveInfrastructureMaxAttempts(
                                claimedJob.name,
                                COMMAND_MAX_ATTEMPTS,
                            ),
                            retryDelayMs: retryDelayForAttempt(
                                claimedJob.attempt,
                                COMMAND_RETRY_BASE_MS,
                                COMMAND_RETRY_MAX_MS,
                            ),
                        }),
                    );
                    if (recovered.outcome === "requeued") {
                        console.warn(`[CommandExecutor] Re-queued command #${claimedJob.id} after worker interruption`);
                    } else if (recovered.outcome === "failed") {
                        console.error(`[CommandExecutor] Command #${claimedJob.id} exhausted ${recovered.attempt} infrastructure attempt(s)`);
                    }
                } catch (persistError) {
                    console.error(
                        `[CommandExecutor] Could not persist recovery for command #${claimedJob.id}; it stays 'started' and is recovered on restart:`,
                        persistError,
                    );
                }
            })
            .finally(() => {
                const active = this.activeJobs.get(claimedJob.id);
                if (active?.workerId === workerId) {
                    this.activeJobs.delete(claimedJob.id);
                }
            });
        this.activeJobs.set(claimedJob.id, { workerId, promise });
    }

    /**
     * Run a command's full lifecycle. In the live app the worker pool is running,
     * so the command executes on a real OS thread (worker_threads) — the direct
     * off-thread CommandExecutor — and *all* of its
     * command-table writes after the atomic main-thread claim
     * (heartbeat/complete/fail/next-pass) happen on the worker's connection,
     * never blocking the main HTTP+SSE loop. When the pool isn't
     * running (unit tests calling processJob directly), the lifecycle runs inline
     * on the main thread via the same executeCommand path.
     */
    private static async processJob(job: CommandModel) {
        if (CommandWorkerPool.isActive()) {
            await CommandWorkerPool.run(job, {
                leaseMs: COMMAND_LEASE_MS,
                heartbeatMs: COMMAND_HEARTBEAT_MS,
            });
        } else {
            await executeCommand(job);
        }
    }
}
