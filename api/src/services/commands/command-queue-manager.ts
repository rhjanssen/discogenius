import { CommandTrigger } from "./command-trigger.js";
import { db } from "../../database.js";
import type {
    CommandBodyCommon,
    ImportDownloadCommand,
    ImportProviderArtistsCommand,
    RefreshArtistCommand,
} from "./command-bodies.js";
import {
    CommandNames,
    DOWNLOAD_COMMAND_NAMES,
    DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
    isDownloadJobType,
    type CommandName,
} from "./command-names.js";
import type { CommandBodyMap, CommandModel, CommandStatus } from "./command-model.js";
import {
    buildDurableQueueOrderClause,
    buildExecutionOrderClause,
    buildHistoryOrderClause,
    buildLiveActivityOrderClause,
    buildTypeInClause,
    hydrateJobRow,
    parseSqliteDate,
    safeParsePayload,
} from "./command-ordering.js";

// The command vocabulary, persisted model, and ordering helpers were split into
// command-names.ts / command-model.ts / command-ordering.ts. Re-export them so
// existing `from "./command-queue.js"` imports keep working unchanged.
export {
    CommandNames,
    DOWNLOAD_COMMAND_NAMES,
    DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
    ARTIST_WORKFLOW_COMMAND_NAMES,
    NON_DOWNLOAD_COMMAND_NAMES,
    isDownloadJobType,
    isDownloadOrImportJobType,
    isCommandName,
} from "./command-names.js";
export type { CommandName } from "./command-names.js";
export type {
    CommandStatus,
    CommandBodyMap,
    AnyCommandBody,
    CommandModelOf,
    CommandModel,
} from "./command-model.js";
export {
    compareJobsByExecutionOrder,
    compareJobsByDurableQueueOrder,
    sortJobsByExecutionOrder,
} from "./command-ordering.js";

import { appEvents, AppEvent, CommandEventPayload } from "./app-events.js";

// ---------------------------------------------------------------------------
// Throttled COMMAND_UPDATED emission (debounced broadcast)
// ---------------------------------------------------------------------------
// Structural status changes (processing, completed, failed, cancelled) emit
// immediately. Progress / description-only updates are coalesced so that at
// most one COMMAND_UPDATED is emitted per job per second.
const COMMAND_UPDATE_THROTTLE_MS = 1000;
const commandUpdateBuffer = new Map<number, { payload: CommandEventPayload; timer: ReturnType<typeof setTimeout> }>();
const TERMINAL_COMMAND_STATUSES = new Set<CommandStatus>(["completed", "failed", "cancelled"]);

/**
 * Emit COMMAND_UPDATED for progress/description changes at most once per second
 * per job.  The first call for a given job emits immediately; subsequent calls
 * within the throttle window are coalesced and flushed when the timer fires.
 */
function emitThrottledCommandUpdate(payload: CommandEventPayload): void {
    const existing = commandUpdateBuffer.get(payload.id);
    if (existing) {
        // Already have a pending timer — just update the buffered payload
        existing.payload = payload;
        return;
    }

    // First call for this job — emit immediately, then start throttle window
    appEvents.emit(AppEvent.COMMAND_UPDATED, payload);
    const timer = setTimeout(() => {
        const buffered = commandUpdateBuffer.get(payload.id);
        commandUpdateBuffer.delete(payload.id);
        if (buffered) {
            appEvents.emit(AppEvent.COMMAND_UPDATED, buffered.payload);
        }
    }, COMMAND_UPDATE_THROTTLE_MS);
    if (timer.unref) timer.unref();
    commandUpdateBuffer.set(payload.id, { payload, timer });
}

/** Flush and clear any pending throttled update for a job (used before
 *  structural events that must not be preceded by a stale progress update). */
function clearCommandUpdateThrottle(commandId: number): void {
    const existing = commandUpdateBuffer.get(commandId);
    if (existing) {
        clearTimeout(existing.timer);
        commandUpdateBuffer.delete(commandId);
    }
}

function getDownloadContentType(type: string, payload: CommandBodyCommon): string | null {
    if (type === CommandNames.DownloadTrack) return "track";
    if (type === CommandNames.DownloadVideo) return "video";
    if (type === CommandNames.DownloadAlbum) return "album";
    if (type === CommandNames.ImportDownload) {
        const payloadType = String((payload as Partial<ImportDownloadCommand>).type || "").trim();
        return payloadType || null;
    }
    return null;
}

function findActiveImportForDownload(type: CommandName, payload: CommandBodyCommon, refId?: string): number | null {
    if (!refId || !isDownloadJobType(type)) return null;

    const incomingType = getDownloadContentType(type, payload);
    if (!incomingType) return null;

    const rows = db.prepare(`
        SELECT id, payload
        FROM commands
        WHERE name = ? AND ref_id = ? AND status IN ('queued', 'started')
        ORDER BY created_at ASC, id ASC
    `).all(CommandNames.ImportDownload, refId) as Array<{ id: number; payload: unknown }>;

    for (const row of rows) {
        const existingPayload = safeParsePayload(row.payload, row.id);
        if (getDownloadContentType(CommandNames.ImportDownload, existingPayload) === incomingType) {
            return row.id;
        }
    }

    return null;
}

function normalizeRefreshArtistPayload(
    payload: Partial<RefreshArtistCommand>,
): RefreshArtistCommand {
    const hydrateAlbumTracks = Boolean(payload.hydrateAlbumTracks ?? payload.monitorAlbums);
    const hydrateCatalog = payload.hydrateCatalog ?? true;
    const scanLibrary = payload.scanLibrary
        ?? (payload.workflow === "refresh-scan"
            || payload.workflow === "monitoring-intake"
            || payload.workflow === "full-monitoring");
    return {
        artistId: String(payload.artistId ?? ""),
        artistName: String(payload.artistName ?? ""),
        workflow: payload.workflow ?? "metadata-refresh",
        monitorArtist: Boolean(payload.monitorArtist),
        monitorAlbums: hydrateAlbumTracks,
        hydrateCatalog: Boolean(hydrateCatalog),
        hydrateAlbumTracks,
        scanLibrary: Boolean(scanLibrary),
        forceDownloadQueue: Boolean(payload.forceDownloadQueue),
        forceUpdate: Boolean(payload.forceUpdate),
        monitoringCycle: payload.monitoringCycle,
    };
}

function areEquivalentRefreshArtistPayloads(
    left: RefreshArtistCommand,
    right: RefreshArtistCommand,
): boolean {
    return left.artistId === right.artistId
        && left.monitorArtist === right.monitorArtist
        && left.hydrateCatalog === right.hydrateCatalog
        && left.hydrateAlbumTracks === right.hydrateAlbumTracks
        && left.scanLibrary === right.scanLibrary
        && left.forceDownloadQueue === right.forceDownloadQueue
        && left.forceUpdate === right.forceUpdate;
}

function findActiveProviderArtistImport(payload: Partial<ImportProviderArtistsCommand>): { id: number; priority: number; status: CommandStatus } | null {
    const providerId = String(payload.providerId || "").trim();
    const category = String(payload.importCategory || "followed-artists").trim();
    const listId = String(payload.importListId || "").trim();

    const rows = db.prepare(`
        SELECT id, payload, priority, status FROM commands
        WHERE name = ? AND status IN('queued', 'started')
    `).all(CommandNames.ImportProviderArtists) as Array<{ id: number; payload: unknown; priority: number; status: CommandStatus }>;

    for (const existing of rows) {
        const existingPayload = safeParsePayload(existing.payload, existing.id) as Partial<ImportProviderArtistsCommand>;
        const existingProviderId = String(existingPayload.providerId || "").trim();
        const existingCategory = String(existingPayload.importCategory || "followed-artists").trim();
        const existingListId = String(existingPayload.importListId || "").trim();

        if (
            existingProviderId === providerId
            && existingCategory === category
            && existingListId === listId
        ) {
            return { id: existing.id, priority: Number(existing.priority) || 0, status: existing.status };
        }
    }

    return null;
}

export type CommandLeaseRecoveryOutcome = "requeued" | "failed" | "not-owner";

export interface CommandLeaseRecoveryResult {
    outcome: CommandLeaseRecoveryOutcome;
    attempt: number;
    retryAfter: string | null;
}

export interface StaleCommandLease {
    id: number;
    name: CommandName;
    workerId: string;
    attempt: number;
    reason: "lease expired" | "progress stopped";
    heartbeatAt: string | null;
    lastProgressAt: string | null;
    leaseExpiresAt: string | null;
}

export interface CommandLeaseMetrics {
    started: number;
    expiredLeases: number;
    retryScheduled: number;
    noProgress: number;
    oldestHeartbeatAgeMs: number | null;
    oldestEligibleQueuedAgeMs: number | null;
}

function leaseTimestamp(value: Date): string {
    return value.toISOString();
}

function leaseExpiry(now: Date, leaseMs: number): string {
    return leaseTimestamp(new Date(now.getTime() + Math.max(1, leaseMs)));
}

export class CommandQueueManager {
    /**
     * Add a job to the queue
     */
    static push<T extends CommandName>(
        type: T,
        payload: CommandBodyMap[T],
        refId?: string,
        priority: number = 0,
        trigger: number = CommandTrigger.Unspecified,
        queueOrder?: number | null,
    ): number {
        // Validate download jobs have valid providerId
        if (isDownloadJobType(type)) {
            const providerId = payload?.providerId || refId;
            if (!providerId || providerId === 'undefined' || providerId === 'null') {
                console.warn(`[TaskQueue] Rejecting ${type} job with invalid providerId: `, payload);
                return -1; // Return invalid ID to indicate rejection
            }
        }

        if (type === CommandNames.ImportProviderArtists) {
            const activeImport = findActiveProviderArtistImport(payload as ImportProviderArtistsCommand);
            if (activeImport !== null) {
                if (activeImport.status === "queued" && priority > activeImport.priority) {
                    db.prepare(`
                        UPDATE commands
                        SET priority = ?, trigger = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status = 'queued'
                    `).run(priority, trigger, activeImport.id);
                }
                console.log(`[TaskQueue] ${type} already exists with equivalent source selection, skipping duplicate.`);
                return activeImport.id;
            }
        }

	        // Enforce uniqueness for active jobs if refId is provided
	        if (refId) {
	            const activeImportId = findActiveImportForDownload(type, payload as CommandBodyCommon, refId);
	            if (activeImportId !== null) {
	                console.log(`[TaskQueue] Import for ${type} ${refId} is already pending or processing, skipping duplicate download.`);
	                return activeImportId;
	            }

	            if (type === CommandNames.RefreshArtist) {
	                const incomingPayload = normalizeRefreshArtistPayload(payload as RefreshArtistCommand);
                const existingRefreshJobs = db.prepare(`
                    SELECT id, payload FROM commands
                    WHERE name = ? AND ref_id = ? AND status IN('queued', 'started')
                `).all(type, refId) as Array<{ id: number; payload: unknown }>;

                // Command equality: dedupe by equivalent command body, not just artist ref.
                for (const existing of existingRefreshJobs) {
                    const existingPayload = normalizeRefreshArtistPayload(
                        safeParsePayload(existing.payload, existing.id) as Partial<RefreshArtistCommand>,
                    );

                    if (areEquivalentRefreshArtistPayloads(existingPayload, incomingPayload)) {
                        console.log(`[TaskQueue] Job ${type} for ${refId} already exists with equivalent payload, skipping duplicate.`);
                        return existing.id;
                    }
                }
            } else {
                const existing = db.prepare(`
                    SELECT id FROM commands
                    WHERE name = ? AND ref_id = ? AND status IN('queued', 'started')
                `).get(type, refId) as { id: number } | undefined;

                if (existing) {
                    console.log(`[TaskQueue] Job ${type} for ${refId} already exists, skipping duplicate.`);
                    return existing.id;
                }
            }
        }

        const insert = db.prepare(`
               INSERT INTO commands(name, ref_id, payload, priority, trigger, queue_order, status, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

        const normalizedQueueOrder = Number.isInteger(queueOrder) && (queueOrder as number) > 0
            ? (queueOrder as number)
            : null;
        const info = insert.run(type, refId || null, JSON.stringify(payload), priority, trigger, normalizedQueueOrder);
        const newId = info.lastInsertRowid as number;
        db.prepare(`
            UPDATE commands
            SET queue_order = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND queue_order IS NULL
        `).run(newId, newId);
        appEvents.emit(AppEvent.COMMAND_ADDED, { id: newId, type, status: 'queued', progress: 0, payload } as CommandEventPayload);
        return newId;
    }

    static all(
        typePattern: string = '%',
        statusPattern: string = '%',
        limit: number = 50,
        offset: number = 0,
        options: { orderBy?: 'created_desc' | 'execution' | 'history' | 'live_activity' | 'queue_order' } = {},
    ): CommandModel[] {
        const orderBy = options.orderBy === 'execution'
            ? buildExecutionOrderClause()
            : options.orderBy === 'history'
                ? buildHistoryOrderClause()
                : options.orderBy === 'live_activity'
                    ? buildLiveActivityOrderClause()
                    : options.orderBy === 'queue_order'
                        ? buildDurableQueueOrderClause()
                        : 'created_at DESC, id DESC';
        const jobs = db.prepare(`
SELECT * FROM commands 
            WHERE name LIKE ? AND status LIKE ?
            ORDER BY ${orderBy}
LIMIT ? OFFSET ?
    `).all(typePattern, statusPattern, limit, offset) as any[];

        return jobs
            .map((job) => hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is CommandModel => job !== null);
    }

    static listJobsByTypesAndStatuses(
        types: readonly CommandName[],
        statuses: readonly CommandStatus[],
        limit: number = 200,
        offset: number = 0,
        options: { orderBy?: 'created_desc' | 'execution' | 'history' | 'live_activity' | 'queue_order' } = {},
    ): CommandModel[] {
        if (types.length === 0 || statuses.length === 0) {
            return [];
        }

        const typePlaceholders = buildTypeInClause(types);
        const statusPlaceholders = statuses.map(() => '?').join(',');
        const orderBy = options.orderBy === 'execution'
            ? buildExecutionOrderClause()
            : options.orderBy === 'history'
                ? buildHistoryOrderClause()
                : options.orderBy === 'live_activity'
                    ? buildLiveActivityOrderClause()
                    : options.orderBy === 'queue_order'
                        ? buildDurableQueueOrderClause()
                        : 'created_at DESC, id DESC';
        // Sort ids only, then fetch the page. Sorting full rows drags every
        // multi-KB payload through the sorter, which costs seconds once the
        // backlog reaches tens of thousands of commands.
        const jobs = db.prepare(`
            SELECT * FROM commands
            WHERE id IN (
                SELECT id FROM commands
                WHERE name IN (${typePlaceholders})
                  AND status IN (${statusPlaceholders})
                ORDER BY ${orderBy}
                LIMIT ? OFFSET ?
            )
            ORDER BY ${orderBy}
        `).all(...types, ...statuses, limit, offset) as any[];

        return jobs
            .map((job) => hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is CommandModel => job !== null);
    }

    static countJobsByTypesAndStatuses(
        types: readonly CommandName[],
        statuses: readonly CommandStatus[],
    ): number {
        if (types.length === 0 || statuses.length === 0) {
            return 0;
        }

        const typePlaceholders = buildTypeInClause(types);
        const statusPlaceholders = statuses.map(() => '?').join(',');
        const row = db.prepare(`
            SELECT COUNT(*) as count
            FROM commands
            WHERE name IN (${typePlaceholders})
              AND status IN (${statusPlaceholders})
        `).get(...types, ...statuses) as { count?: number } | undefined;

        return Number(row?.count || 0);
    }

    static countJobs(typePattern: string = '%', statusPattern: string = '%'): number {
        const result = db.prepare(`
            SELECT COUNT(*) as count
            FROM commands
            WHERE name LIKE ? AND status LIKE ?
        `).get(typePattern, statusPattern) as { count?: number } | undefined;

        return Number(result?.count || 0);
    }

    /**
     * Get paginated job history
     */
    static getHistory(limit: number = 50, offset: number = 0): CommandModel[] {
        const jobs = db.prepare(`
            SELECT * FROM commands 
            WHERE status IN('completed', 'failed', 'cancelled')
            ORDER BY COALESCE(started_at, created_at) DESC
LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

        return jobs
            .map((job) => hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is CommandModel => job !== null);
    }

    /**
     * Get next pending job matching a flexible type pattern.
     * e.g. 'DOWNLOAD_%' or 'SCAN_%' or exact 'RefreshArtist'
     */
    static getNextJob(typePattern: string = '%'): CommandModel | null {
        // Find highest priority, oldest pending job matching type
        const job = db.prepare(`
            SELECT * FROM commands 
            WHERE status = 'queued' AND name LIKE ?
            ORDER BY 
${buildExecutionOrderClause()}
            LIMIT 1
        `).get(typePattern) as any;

        if (!job) return null;

        return hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    static getNextJobByTypes(types: readonly CommandName[]): CommandModel | null {
        if (types.length === 0) {
            return null;
        }

        const placeholders = buildTypeInClause(types);
        const job = db.prepare(`
            SELECT * FROM commands
            WHERE status = 'queued'
              AND name IN (${placeholders})
              AND (retry_after IS NULL OR julianday(retry_after) <= julianday('now'))
            ORDER BY
${buildExecutionOrderClause()}
            LIMIT 1
        `).get(...types) as any;

        if (!job) return null;

        return hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Return the top-N pending jobs across all given types, sorted globally by priority.
     * Used by the Scheduler for CommandQueue selection:
     * the caller iterates the list and picks the first job that passes exclusivity checks.
     *
     * `perTypeLimit` caps how many candidates any single command type contributes
     * to the window. Without it, a deep backlog of one type (e.g. hundreds of
     * queued RefreshArtist during intake) fills the whole window; if that type is
     * concurrency-capped, every other queued type is starved out of consideration
     * and worker slots idle. The per-type rank keeps a deep backlog of one
     * type from starving every other queued type out of the bounded SQL window.
     */
    static getTopPendingJobsByTypes(types: readonly CommandName[], limit: number = 20, perTypeLimit?: number): CommandModel[] {
        if (types.length === 0) return [];

        const placeholders = buildTypeInClause(types);
        const rows = (perTypeLimit && perTypeLimit > 0
            ? db.prepare(`
                SELECT * FROM (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY name
                        ORDER BY
${buildExecutionOrderClause()}
                    ) AS __type_rank
                    FROM commands
                    WHERE status = 'queued'
                      AND name IN (${placeholders})
                      AND (retry_after IS NULL OR julianday(retry_after) <= julianday('now'))
                )
                WHERE __type_rank <= ?
                ORDER BY
${buildExecutionOrderClause()}
                LIMIT ?
            `).all(...types, perTypeLimit, limit)
            : db.prepare(`
                SELECT * FROM commands
                WHERE status = 'queued'
                  AND name IN (${placeholders})
                  AND (retry_after IS NULL OR julianday(retry_after) <= julianday('now'))
                ORDER BY
${buildExecutionOrderClause()}
                LIMIT ?
            `).all(...types, limit)) as any[];

        return rows
            .map((row) => {
                delete row.__type_rank;
                return hydrateJobRow(row as { name: string; payload: unknown; id: number } & Record<string, unknown>);
            })
            .filter((job): job is CommandModel => job !== null);
    }

    /**
     * Atomically claim a queued non-download command for one execution attempt.
     *
     * `workerId` is a fresh, opaque token for this exact attempt. Every
     * lifecycle write from the worker must carry it, preventing a worker whose
     * lease was recovered from completing or advancing the replacement attempt.
     */
    static claimForExecution(
        id: number,
        workerId: string,
        leaseMs: number,
        now: Date = new Date(),
    ): CommandModel | null {
        const startedAt = leaseTimestamp(now);
        const expiresAt = leaseExpiry(now, leaseMs);
        const claim = db.transaction(() => {
            const result = db.prepare(`
                UPDATE commands
                SET
                    status = 'started',
                    started_at = ?,
                    completed_at = NULL,
                    updated_at = ?,
                    worker_id = ?,
                    attempt = attempt + 1,
                    heartbeat_at = ?,
                    last_progress_at = ?,
                    progress_phase = 'starting',
                    progress_current = progress,
                    progress_total = 100,
                    lease_expires_at = ?,
                    blocked_reason = NULL,
                    retry_after = NULL,
                    error = NULL
                WHERE id = ?
                  AND status = 'queued'
                  AND (retry_after IS NULL OR julianday(retry_after) <= julianday(?))
            `).run(
                startedAt,
                startedAt,
                workerId,
                startedAt,
                startedAt,
                expiresAt,
                id,
                startedAt,
            );
            if (result.changes === 0) return null;
            return this.get(id);
        });

        const job = claim();
        if (!job) return null;
        clearCommandUpdateThrottle(id);
        appEvents.emit(AppEvent.COMMAND_UPDATED, {
            id,
            type: job.name,
            status: "started",
            progress: job.progress,
            payload: job.payload,
        } as CommandEventPayload);
        return job;
    }

    static markProcessing(id: number): boolean {
        const result = db.prepare(`
            UPDATE commands
            SET status = 'started', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'queued'
        `).run(id);
        if (result.changes === 0) return false;
        clearCommandUpdateThrottle(id);
        const job = this.get(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'started', progress: job.progress } as CommandEventPayload);
        return true;
    }

    static isExecutionOwner(id: number, workerId: string): boolean {
        const row = db.prepare(`
            SELECT 1 AS owned
            FROM commands
            WHERE id = ? AND status = 'started' AND worker_id = ?
        `).get(id, workerId) as { owned: number } | undefined;
        return row?.owned === 1;
    }

    static renewLease(
        id: number,
        workerId: string,
        leaseMs: number,
        now: Date = new Date(),
    ): boolean {
        const heartbeatAt = leaseTimestamp(now);
        const result = db.prepare(`
            UPDATE commands
            SET heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'started' AND worker_id = ?
        `).run(heartbeatAt, leaseExpiry(now, leaseMs), id, workerId);
        return result.changes === 1;
    }

    static updateProgress(id: number, progress: number, workerId?: string) {
        const ownershipClause = workerId ? " AND status = 'started' AND worker_id = ?" : " AND status NOT IN ('completed', 'failed', 'cancelled')";
        const params: unknown[] = [progress, progress, id];
        if (workerId) params.push(workerId);
        const result = db.prepare(`
            UPDATE commands
            SET
                progress = ?,
                progress_current = ?,
                progress_total = COALESCE(progress_total, 100),
                last_progress_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?${ownershipClause}
        `).run(...params);
        if (result.changes === 0) return;
        const job = this.get(id);
        if (job) emitThrottledCommandUpdate({ id, type: job.name, status: job.status, progress } as CommandEventPayload);
    }

    static updateState(id: number, options: {
        progress?: number | null;
        payloadPatch?: Partial<CommandBodyCommon>;
        workerId?: string;
        progressPhase?: string | null;
        progressCurrent?: number | null;
        progressTotal?: number | null;
        blockedReason?: string | null;
    }) {
        const current = this.get(id);
        if (!current) return null;
        if (TERMINAL_COMMAND_STATUSES.has(current.status)) return current;
        if (options.workerId && (current.status !== "started" || current.worker_id !== options.workerId)) {
            return null;
        }

        const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
        const params: unknown[] = [];
        let advancesProgress = false;

        if (options.progress !== undefined) {
            updates.push("progress = ?");
            params.push(options.progress);
            updates.push("progress_current = ?");
            params.push(options.progress);
            updates.push("progress_total = COALESCE(progress_total, 100)");
            advancesProgress = true;
        }

        if (options.payloadPatch) {
            const basePayload = current.payload;
            const nextPayload = {
                ...basePayload,
                ...options.payloadPatch,
            };
            updates.push("payload = ?");
            params.push(JSON.stringify(nextPayload));
        }

        if (options.progressPhase !== undefined) {
            updates.push("progress_phase = ?");
            params.push(options.progressPhase);
            advancesProgress = true;
        }
        if (options.progressCurrent !== undefined) {
            updates.push("progress_current = ?");
            params.push(options.progressCurrent);
            advancesProgress = true;
        }
        if (options.progressTotal !== undefined) {
            updates.push("progress_total = ?");
            params.push(options.progressTotal);
            advancesProgress = true;
        }
        if (options.blockedReason !== undefined) {
            updates.push("blocked_reason = ?");
            params.push(options.blockedReason);
        }
        if (advancesProgress) {
            updates.push("last_progress_at = CURRENT_TIMESTAMP");
            if (options.blockedReason === undefined) {
                updates.push("blocked_reason = NULL");
            }
        }

        if (updates.length === 1) {
            return current;
        }

        params.push(id);
        let ownershipClause = " AND status NOT IN ('completed', 'failed', 'cancelled')";
        if (options.workerId) {
            ownershipClause = " AND status = 'started' AND worker_id = ?";
            params.push(options.workerId);
        }
        const result = db.prepare(`UPDATE commands SET ${updates.join(", ")} WHERE id = ?${ownershipClause}`).run(...params);
        if (result.changes === 0) return null;

        const updated = this.get(id);
        if (updated) {
            emitThrottledCommandUpdate({
                id,
                type: updated.name,
                status: updated.status,
                progress: updated.progress,
                payload: updated.payload,
            } as CommandEventPayload);
        }

        return updated;
    }

    static complete(id: number, workerId?: string): boolean {
        const ownershipClause = workerId
            ? "status = 'started' AND worker_id = ?"
            : "status NOT IN ('completed', 'failed', 'cancelled')";
        const params: unknown[] = [id];
        if (workerId) params.push(workerId);
        const result = db.prepare(`
            UPDATE commands
            SET
                status = 'completed',
                progress = 100,
                progress_current = COALESCE(progress_total, 100),
                progress_total = COALESCE(progress_total, 100),
                progress_phase = 'completed',
                blocked_reason = NULL,
                lease_expires_at = NULL,
                retry_after = NULL,
                completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND ${ownershipClause}
        `).run(...params);
        if (result.changes === 0) return false;
        clearCommandUpdateThrottle(id);
        const job = this.get(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'completed', progress: 100 } as CommandEventPayload);
        return true;
    }

    static fail(id: number, error: string, workerId?: string): boolean {
        const ownershipClause = workerId
            ? "status = 'started' AND worker_id = ?"
            : "status NOT IN ('completed', 'failed', 'cancelled')";
        const params: unknown[] = [error, id];
        if (workerId) params.push(workerId);
        const result = db.prepare(`
            UPDATE commands 
            SET
                status = 'failed',
                error = ?,
                attempts = attempts + 1,
                progress_phase = 'failed',
                blocked_reason = 'failed',
                lease_expires_at = NULL,
                retry_after = NULL,
                completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND ${ownershipClause}
        `).run(...params);
        if (result.changes === 0) return false;
        clearCommandUpdateThrottle(id);
        const job = this.get(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'failed', progress: job.progress, error } as CommandEventPayload);
        return true;
    }

    static cancel(id: number) {
        db.prepare("UPDATE commands SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        clearCommandUpdateThrottle(id);
        const job = this.get(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'cancelled', progress: job.progress } as CommandEventPayload);
    }

    /**
     * Cancel all pending (non-processing) jobs of given types for a specific artist.
     * Used to prevent stale queued jobs from conflicting with an inline manual scan.
     * Returns the number of jobs cancelled.
     */
    static cancelPendingForArtist(artistId: string, types: CommandName[]): number {
        if (types.length === 0) return 0;
        const placeholders = types.map(() => '?').join(',');
        const result = db.prepare(`
            UPDATE commands
            SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE ref_id = ? AND name IN (${placeholders}) AND status = 'queued'
    `).run(artistId, ...types);
        const cancelled = (result as any).changes || 0;
        if (cancelled > 0) {
            console.log(`[TaskQueue] Cancelled ${cancelled} pending job(s) for artist ${artistId}(types: ${types.join(', ')})`);
        }
        return cancelled;
    }

    static retry(id: number) {
        db.prepare(`
            UPDATE commands 
            SET status = 'queued', error = NULL, progress = 0, started_at = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP,
                attempts = 0, attempt = 0, worker_id = NULL, heartbeat_at = NULL,
                last_progress_at = NULL, progress_phase = NULL, progress_current = NULL,
                progress_total = NULL, lease_expires_at = NULL, blocked_reason = NULL,
                retry_after = NULL, last_retry_reason = NULL,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE id = ?
	    `).run(id);
        const job = this.get(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'queued', progress: 0 } as CommandEventPayload);
    }

    /**
     * Return a pause-interrupted download to its exact durable queue position.
     *
     * A queue pause is not a failed attempt and not a user-requested retry:
     * preserve attempts, queue_order, priority, trigger, and resumable download
     * state. Only the transient running claim is released.
     */
    static requeuePausedDownload(id: number): boolean {
        const result = db.prepare(`
            UPDATE commands
            SET
                status = 'queued',
                started_at = NULL,
                completed_at = NULL,
                error = NULL,
                payload = json_set(
                    COALESCE(payload, '{}'),
                    '$.downloadState.state', 'paused',
                    '$.downloadState.statusMessage', 'Paused by user'
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'started'
              AND name IN (${buildTypeInClause(DOWNLOAD_COMMAND_NAMES)})
        `).run(id, ...DOWNLOAD_COMMAND_NAMES);
        if (result.changes === 0) return false;

        clearCommandUpdateThrottle(id);
        const job = this.get(id);
        if (job) {
            appEvents.emit(AppEvent.COMMAND_UPDATED, {
                id,
                type: job.name,
                status: 'queued',
                progress: job.progress,
                payload: job.payload,
            } as CommandEventPayload);
        }
        return true;
    }

    /**
     * Recover one infrastructure-interrupted non-download attempt. Ownership is
     * part of the UPDATE predicate so two watchdog signals, or a late worker
     * result racing recovery, can produce only one state transition.
     */
    static recoverOwnedCommand(options: {
        id: number;
        workerId: string;
        reason: string;
        maxAttempts: number;
        retryDelayMs: number;
        now?: Date;
    }): CommandLeaseRecoveryResult {
        const now = options.now ?? new Date();
        const nowTimestamp = leaseTimestamp(now);
        const retryAfter = leaseTimestamp(new Date(now.getTime() + Math.max(0, options.retryDelayMs)));
        const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));

        const recover = db.transaction((): CommandLeaseRecoveryResult => {
            const current = db.prepare(`
                SELECT attempt
                FROM commands
                WHERE id = ? AND status = 'started' AND worker_id = ?
            `).get(options.id, options.workerId) as { attempt: number } | undefined;
            if (!current) {
                return { outcome: "not-owner", attempt: 0, retryAfter: null };
            }

            const attempt = Number(current.attempt) || 0;
            if (attempt >= maxAttempts) {
                const poisonError = `Command stopped after ${attempt} execution attempt(s): ${options.reason}`;
                const result = db.prepare(`
                    UPDATE commands
                    SET
                        status = 'failed',
                        error = ?,
                        completed_at = ?,
                        updated_at = ?,
                        progress_phase = 'failed',
                        blocked_reason = 'poisoned command',
                        lease_expires_at = NULL,
                        retry_after = NULL,
                        last_retry_reason = ?
                    WHERE id = ? AND status = 'started' AND worker_id = ?
                `).run(
                    poisonError,
                    nowTimestamp,
                    nowTimestamp,
                    options.reason,
                    options.id,
                    options.workerId,
                );
                if (result.changes === 0) {
                    return { outcome: "not-owner", attempt, retryAfter: null };
                }
                return { outcome: "failed", attempt, retryAfter: null };
            }

            const result = db.prepare(`
                UPDATE commands
                SET
                    status = 'queued',
                    started_at = NULL,
                    completed_at = NULL,
                    updated_at = ?,
                    progress = 0,
                    progress_phase = 'retry scheduled',
                    progress_current = 0,
                    progress_total = 100,
                    worker_id = NULL,
                    heartbeat_at = NULL,
                    lease_expires_at = NULL,
                    blocked_reason = 'retry scheduled',
                    retry_after = ?,
                    last_retry_reason = ?,
                    error = ?
                WHERE id = ? AND status = 'started' AND worker_id = ?
            `).run(
                nowTimestamp,
                retryAfter,
                options.reason,
                options.reason,
                options.id,
                options.workerId,
            );
            if (result.changes === 0) {
                return { outcome: "not-owner", attempt, retryAfter: null };
            }
            return { outcome: "requeued", attempt, retryAfter };
        });

        const outcome = recover();
        if (outcome.outcome !== "not-owner") {
            clearCommandUpdateThrottle(options.id);
            const job = this.get(options.id);
            if (job) {
                appEvents.emit(AppEvent.COMMAND_UPDATED, {
                    id: options.id,
                    type: job.name,
                    status: job.status,
                    progress: job.progress,
                    payload: job.payload,
                    error: job.error,
                } as CommandEventPayload);
            }
        }
        return outcome;
    }

    /**
     * Deterministically recover attempts left `started` by a process restart.
     * There are no live workers at executor startup, so a NULL legacy owner is
     * also safe to recover. Attempt and reason evidence remain persisted.
     */
    static recoverInterruptedJobsByTypes(options: {
        types: readonly CommandName[];
        reason: string;
        maxAttempts: number;
        resolveMaxAttempts?: (name: CommandName) => number;
        retryDelayMs?: number;
        now?: Date;
    }): { requeued: number; failed: number } {
        if (options.types.length === 0) return { requeued: 0, failed: 0 };
        const rows = db.prepare(`
            SELECT id, name, worker_id, attempt
            FROM commands
            WHERE status = 'started'
              AND name IN (${buildTypeInClause(options.types)})
            ORDER BY id ASC
        `).all(...options.types) as Array<{
            id: number;
            name: CommandName;
            worker_id: string | null;
            attempt: number;
        }>;

        let requeued = 0;
        let failed = 0;
        for (const row of rows) {
            const restartOwner = row.worker_id || `restart-recovery:${row.id}`;
            if (!row.worker_id) {
                db.prepare(`
                    UPDATE commands
                    SET worker_id = ?
                    WHERE id = ? AND status = 'started' AND worker_id IS NULL
                `).run(restartOwner, row.id);
            }
            const result = this.recoverOwnedCommand({
                id: row.id,
                workerId: restartOwner,
                reason: options.reason,
                maxAttempts: options.resolveMaxAttempts?.(row.name) ?? options.maxAttempts,
                retryDelayMs: options.retryDelayMs ?? 0,
                now: options.now,
            });
            if (result.outcome === "requeued") requeued += 1;
            if (result.outcome === "failed") failed += 1;
        }
        return { requeued, failed };
    }

    static findStaleExecutionLeases(options: {
        types: readonly CommandName[];
        now?: Date;
        noProgressMs?: number;
        resolveNoProgressMs?: (name: CommandName) => number;
    }): StaleCommandLease[] {
        if (options.types.length === 0) return [];
        const now = options.now ?? new Date();
        const rows = db.prepare(`
            SELECT
                id, name, worker_id, attempt, heartbeat_at, last_progress_at,
                lease_expires_at, blocked_reason
            FROM commands
            WHERE status = 'started'
              AND worker_id IS NOT NULL
              AND name IN (${buildTypeInClause(options.types)})
            ORDER BY COALESCE(lease_expires_at, last_progress_at) ASC, id ASC
        `).all(...options.types) as Array<{
            id: number;
            name: CommandName;
            worker_id: string;
            attempt: number;
            heartbeat_at: string | null;
            last_progress_at: string | null;
            lease_expires_at: string | null;
            blocked_reason: string | null;
        }>;

        return rows.flatMap((row): StaleCommandLease[] => {
            const leaseExpired = row.lease_expires_at != null
                && parseSqliteDate(row.lease_expires_at) <= now.getTime();
            const noProgressMs = Math.max(
                0,
                options.noProgressMs
                    ?? options.resolveNoProgressMs?.(row.name)
                    ?? 0,
            );
            const progressStopped = noProgressMs > 0
                && row.blocked_reason == null
                && row.last_progress_at != null
                && parseSqliteDate(row.last_progress_at) <= now.getTime() - noProgressMs;
            if (!leaseExpired && !progressStopped) return [];
            return [{
                id: row.id,
                name: row.name,
                workerId: row.worker_id,
                attempt: Number(row.attempt) || 0,
                reason: leaseExpired ? "lease expired" : "progress stopped",
                heartbeatAt: row.heartbeat_at,
                lastProgressAt: row.last_progress_at,
                leaseExpiresAt: row.lease_expires_at,
            }];
        });
    }

    static getLeaseMetrics(options: {
        types: readonly CommandName[];
        noProgressMs?: number;
        resolveNoProgressMs?: (name: CommandName) => number;
        now?: Date;
    }): CommandLeaseMetrics {
        if (options.types.length === 0) {
            return {
                started: 0,
                expiredLeases: 0,
                retryScheduled: 0,
                noProgress: 0,
                oldestHeartbeatAgeMs: null,
                oldestEligibleQueuedAgeMs: null,
            };
        }
        const now = options.now ?? new Date();
        const nowTimestamp = leaseTimestamp(now);
        const noProgressMs = Math.max(0, options.noProgressMs ?? 0);
        const cutoff = leaseTimestamp(new Date(now.getTime() - noProgressMs));
        const row = db.prepare(`
            SELECT
                SUM(CASE WHEN status = 'started' THEN 1 ELSE 0 END) AS started,
                SUM(CASE
                    WHEN status = 'started'
                     AND lease_expires_at IS NOT NULL
                     AND julianday(lease_expires_at) <= julianday(?)
                    THEN 1 ELSE 0 END
                ) AS expired_leases,
                SUM(CASE
                    WHEN status = 'queued'
                     AND retry_after IS NOT NULL
                     AND julianday(retry_after) > julianday(?)
                    THEN 1 ELSE 0 END
                ) AS retry_scheduled,
                SUM(CASE
                    WHEN status = 'started'
                     AND ? > 0
                     AND last_progress_at IS NOT NULL
                     AND julianday(last_progress_at) <= julianday(?)
                     AND blocked_reason IS NULL
                    THEN 1 ELSE 0 END
                ) AS no_progress,
                MIN(CASE WHEN status = 'started' THEN heartbeat_at END) AS oldest_heartbeat_at,
                MIN(CASE
                    WHEN status = 'queued'
                     AND (retry_after IS NULL OR julianday(retry_after) <= julianday(?))
                    THEN created_at END
                ) AS oldest_eligible_created_at
            FROM commands
            WHERE name IN (${buildTypeInClause(options.types)})
              AND status IN ('queued', 'started')
        `).get(
            nowTimestamp,
            nowTimestamp,
            noProgressMs,
            cutoff,
            nowTimestamp,
            ...options.types,
        ) as {
            started: number | null;
            expired_leases: number | null;
            retry_scheduled: number | null;
            no_progress: number | null;
            oldest_heartbeat_at: string | null;
            oldest_eligible_created_at: string | null;
        };

        const ageMs = (timestamp: string | null): number | null => {
            if (!timestamp) return null;
            const parsed = Date.parse(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);
            return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : null;
        };
        return {
            started: Number(row.started) || 0,
            expiredLeases: Number(row.expired_leases) || 0,
            retryScheduled: Number(row.retry_scheduled) || 0,
            noProgress: options.resolveNoProgressMs
                ? this.findStaleExecutionLeases({
                    types: options.types,
                    now,
                    noProgressMs: options.noProgressMs,
                    resolveNoProgressMs: options.resolveNoProgressMs,
                }).filter((command) => command.reason === "progress stopped").length
                : Number(row.no_progress) || 0,
            oldestHeartbeatAgeMs: ageMs(row.oldest_heartbeat_at),
            oldestEligibleQueuedAgeMs: ageMs(row.oldest_eligible_created_at),
        };
    }

    /**
     * Recover interrupted jobs from previous process crash/restart.
     * Moves processing jobs back to pending so workers can pick them up again.
     */
    static resetProcessingJobs(typePattern: string = '%'): number {
        const result = db.prepare(`
            UPDATE commands
            SET status = 'queued', started_at = NULL, progress = 0, updated_at = CURRENT_TIMESTAMP,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE status = 'started' AND name LIKE ?
    `).run(typePattern);

        return result.changes;
    }

    static resetProcessingJobsByTypes(types: readonly CommandName[]): number {
        if (types.length === 0) {
            return 0;
        }

        const placeholders = buildTypeInClause(types);
        const result = db.prepare(`
            UPDATE commands
            SET status = 'queued', started_at = NULL, progress = 0, updated_at = CURRENT_TIMESTAMP,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE status = 'started' AND name IN (${placeholders})
        `).run(...types);

        return result.changes;
    }

    /**
     * Re-queue stale processing jobs that have not advanced for a configured duration.
     *
     * Disabled when olderThanMs <= 0.
     */
    static requeue(options: {
        typePattern?: string;
        olderThanMs: number;
        note?: string;
        excludeIds?: number[];
    }): number {
        const {
            typePattern = '%',
            olderThanMs,
            note = 'Stale processing job re-queued',
            excludeIds = [],
        } = options;

        if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
            return 0;
        }

        const staleSeconds = Math.max(1, Math.floor(olderThanMs / 1000));
        const ageModifier = `-${staleSeconds} seconds`;

        const excludeClause = excludeIds.length > 0
            ? ` AND id NOT IN(${excludeIds.map(() => '?').join(',')})`
            : '';

        const params: Array<string | number> = [note, typePattern, ageModifier, ...excludeIds];

        const result = db.prepare(`
            UPDATE commands
            SET
                status = 'queued',
                started_at = NULL,
                completed_at = NULL,
                progress = 0,
                error = CASE WHEN error IS NULL OR error = '' THEN ? ELSE error END,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState'),
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'started'
              AND name LIKE ?
              AND COALESCE(started_at, updated_at, created_at) <= datetime('now', ?)
              ${excludeClause}
        `).run(...params);

        return result.changes;
    }

    static requeueStaleProcessingJobsByTypes(options: {
        types: readonly CommandName[];
        olderThanMs: number;
        note?: string;
        excludeIds?: number[];
    }): number {
        const {
            types,
            olderThanMs,
            note = 'Stale processing job re-queued',
            excludeIds = [],
        } = options;

        if (types.length === 0 || !Number.isFinite(olderThanMs) || olderThanMs <= 0) {
            return 0;
        }

        const staleSeconds = Math.max(1, Math.floor(olderThanMs / 1000));
        const ageModifier = `-${staleSeconds} seconds`;
        const typeClause = buildTypeInClause(types);
        const excludeClause = excludeIds.length > 0
            ? ` AND id NOT IN(${excludeIds.map(() => '?').join(',')})`
            : '';
        const params: Array<string | number> = [note, ...types, ageModifier, ...excludeIds];

        const result = db.prepare(`
            UPDATE commands
            SET
                status = 'queued',
                started_at = NULL,
                completed_at = NULL,
                progress = 0,
                error = CASE WHEN error IS NULL OR error = '' THEN ? ELSE error END,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState'),
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'started'
              AND name IN (${typeClause})
              AND COALESCE(started_at, updated_at, created_at) <= datetime('now', ?)
              ${excludeClause}
        `).run(...params);

        return result.changes;
    }

    static getStats() {
        return db.prepare(`
            SELECT name, status, COUNT(*) as count 
            FROM commands 
            GROUP BY name, status
    `).all();
    }

    static clearCompleted() {
        db.prepare("DELETE FROM commands WHERE status IN ('completed', 'cancelled')").run();
        appEvents.emit(AppEvent.QUEUE_CLEARED);
    }

    static cleanCommands(typePattern: string = '%') {
        db.prepare(`
            DELETE FROM commands
            WHERE name LIKE ? AND status IN ('completed', 'failed', 'cancelled')
        `).run(typePattern);
        appEvents.emit(AppEvent.QUEUE_CLEARED);
    }

    static clearFinishedByTypes(types: string[]) {
        if (types.length === 0) {
            return;
        }

        const placeholders = types.map(() => '?').join(',');
        db.prepare(`
            DELETE FROM commands
            WHERE name IN (${placeholders}) AND status IN ('completed', 'failed', 'cancelled')
        `).run(...types);
        appEvents.emit(AppEvent.QUEUE_CLEARED);
    }

    static reorderPendingJobs(
        commandIds: number[],
        options: {
            beforeJobId?: number;
            afterJobId?: number;
            types?: readonly CommandName[];
        } = {},
    ): number {
        const normalizedJobIds = commandIds.filter((commandId) => Number.isInteger(commandId) && commandId > 0);
        if (normalizedJobIds.length === 0) {
            throw new Error("Queue reorder requires one or more valid pending queue item ids.");
        }

        const distinctJobIds = Array.from(new Set(normalizedJobIds));
        if (distinctJobIds.length !== normalizedJobIds.length) {
            throw new Error("Queue reorder set contains duplicate queue item ids.");
        }

        const { beforeJobId, afterJobId } = options;
        if ((beforeJobId == null && afterJobId == null) || (beforeJobId != null && afterJobId != null)) {
            throw new Error("Queue reorder requires exactly one anchor: beforeJobId or afterJobId.");
        }

        const types = options.types ?? DOWNLOAD_COMMAND_NAMES;
        const pendingJobs = this.listJobsByTypesAndStatuses(
            types,
            ['queued'],
            this.countJobsByTypesAndStatuses(types, ['queued']),
            0,
            { orderBy: 'execution' },
        );

        const pendingById = new Map(pendingJobs.map((job) => [job.id, job]));
        const movingSet = new Set(distinctJobIds);
        const movingJobs = distinctJobIds.map((commandId) => pendingById.get(commandId)).filter((job): job is CommandModel => job != null);

        if (movingJobs.length !== distinctJobIds.length) {
            throw new Error("Only pending download queue items can be reordered.");
        }

        const anchorJobId = beforeJobId ?? afterJobId;
        if (anchorJobId == null || movingSet.has(anchorJobId)) {
            throw new Error("Queue reorder anchor must be a different pending queue item.");
        }

        if (!pendingById.has(anchorJobId)) {
            throw new Error("Queue reorder anchor is not in the pending download queue.");
        }

        const anchorJob = pendingById.get(anchorJobId);
        if (!anchorJob) {
            throw new Error("Queue reorder anchor could not be resolved.");
        }

        const remainingJobs = pendingJobs.filter((job) => !movingSet.has(job.id));
        const anchorIndex = remainingJobs.findIndex((job) => job.id === anchorJobId);
        if (anchorIndex === -1) {
            throw new Error("Queue reorder anchor could not be resolved.");
        }

        const insertIndex = beforeJobId != null ? anchorIndex : anchorIndex + 1;
        const reorderedJobs = [
            ...remainingJobs.slice(0, insertIndex),
            ...movingJobs,
            ...remainingJobs.slice(insertIndex),
        ];

        const updateQueueOrder = db.prepare(`
            UPDATE commands
            SET
              queue_order = ?,
              priority = ?,
              trigger = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'queued'
        `);

        const tx = db.transaction(() => {
            reorderedJobs.forEach((job, index) => {
                const queueOrder = index + 1;
                // Execution order intentionally sorts priority/trigger before
                // queue_order so newly queued interactive work can start ahead
                // of background acquisitions. Once a user explicitly moves a
                // row, however, that move must become the effective execution
                // order as well as the visible order. Align the moved block to
                // the anchor's execution class; otherwise a drag across a
                // trigger/priority boundary is immediately undone by the next
                // query and the downloader still selects the old first item.
                const isMoving = movingSet.has(job.id);
                updateQueueOrder.run(
                    queueOrder,
                    isMoving ? anchorJob.priority : job.priority,
                    isMoving ? (anchorJob.trigger ?? CommandTrigger.Unspecified) : (job.trigger ?? CommandTrigger.Unspecified),
                    job.id,
                );
            });
        });

        tx();
        // A reorder changes queue membership order but no single command's status,
        // so nothing else fires. Without this, the query service keeps serving its
        // cached snapshot and the client never refetches — the drag appears to do
        // nothing. QUEUE_CLEARED invalidates the server snapshot and reaches the
        // client as `queue.cleared`, prompting an immediate refetch in the new order.
        appEvents.emit(AppEvent.QUEUE_CLEARED);
        return reorderedJobs.length;
    }

    /**
     * Get job by ref_id (e.g., Tidal ID)
     */
    static getByRefId(refId: string, typePattern: string = '%'): CommandModel | null {
        const job = db.prepare(`
            SELECT * FROM commands 
            WHERE ref_id = ? AND name LIKE ? AND status IN('queued', 'started')
            ORDER BY created_at DESC
            LIMIT 1
        `).get(refId, typePattern) as any;

        if (!job) return null;

        return hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Get job by ID
     */
    static get(id: number): CommandModel | null {
        const job = db.prepare(`SELECT * FROM commands WHERE id = ? `).get(id) as any;

        if (!job) return null;

        return hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Clear all jobs of a specific type pattern
     */
    static clearByType(typePattern: string) {
        db.prepare("DELETE FROM commands WHERE name LIKE ? AND status IN ('queued', 'failed', 'completed', 'cancelled')").run(typePattern);
    }

    /**
     * Delete a specific job by ID
     */
    static deleteCommand(id: number) {
        const job = this.get(id);
        db.prepare("DELETE FROM commands WHERE id = ?").run(id);
        if (job) appEvents.emit(AppEvent.COMMAND_DELETED, { id, type: job.name, status: job.status, progress: job.progress } as CommandEventPayload);
    }
}

