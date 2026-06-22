import { CommandTrigger } from "./command-trigger.js";
import { db } from "../../database.js";
import type {
    ApplyCurationCommand,
    CheckUpgradesCommand,
    CheckHealthCommand,
    BulkRefreshArtistCommand,
    CleanupTempFilesCommand,
    CompactDatabaseCommand,
    ConfigPruneCommand,
    CurateArtistCommand,
    DownloadAlbumCommand,
    DownloadMissingCommand,
    DownloadMissingForceCommand,
    DownloadTrackCommand,
    DownloadVideoCommand,
    HousekeepingCommand,
    ImportDownloadCommand,
    MoveArtistCommand,
    CommandBodyCommon,
    RefreshArtistCommand,
    RefreshMetadataCommand,
    RefreshAlbumCommand,
    RenameArtistCommand,
    RenameFilesCommand,
    RescanFoldersCommand,
    RescanAllRootsCommand,
    RetagArtistCommand,
    RetagFilesCommand,
    UpdateLibraryMetadataCommand,
} from "./command-bodies.js";

export const CommandNames = {
    RefreshArtist: 'RefreshArtist',
    RefreshAlbum: 'RefreshAlbum',
    RefreshMetadata: 'RefreshMetadata',
    ApplyCuration: 'ApplyCuration',
    DownloadMissing: 'DownloadMissing',
    CheckUpgrades: 'CheckUpgrades',
    Housekeeping: 'Housekeeping',
    DownloadTrack: 'DownloadTrack',
    DownloadVideo: 'DownloadVideo',
    DownloadAlbum: 'DownloadAlbum',
    CurateArtist: 'CurateArtist',
    RescanFolders: 'RescanFolders',
    ImportDownload: 'ImportDownload',
    ConfigPrune: 'ConfigPrune',
    MoveArtist: 'MoveArtist',
    RenameFiles: 'RenameFiles',
    RenameArtist: 'RenameArtist',
    RetagFiles: 'RetagFiles',
    RetagArtist: 'RetagArtist',
    BulkRefreshArtist: 'BulkRefreshArtist',
    DownloadMissingForce: 'DownloadMissingForce',
    RescanAllRoots: 'RescanAllRoots',
    CheckHealth: 'CheckHealth',
    CompactDatabase: 'CompactDatabase',
    CleanupTempFiles: 'CleanupTempFiles',
    UpdateLibraryMetadata: 'UpdateLibraryMetadata',
} as const;

export type CommandName = typeof CommandNames[keyof typeof CommandNames];

export const DOWNLOAD_COMMAND_NAMES = [
    CommandNames.DownloadTrack,
    CommandNames.DownloadVideo,
    CommandNames.DownloadAlbum,
] as const;

export const DOWNLOAD_OR_IMPORT_COMMAND_NAMES = [
    ...DOWNLOAD_COMMAND_NAMES,
    CommandNames.ImportDownload,
] as const;

export const ARTIST_WORKFLOW_COMMAND_NAMES = [
    CommandNames.RefreshArtist,
    CommandNames.RescanFolders,
    CommandNames.CurateArtist,
] as const;

/**
 * All non-download job types processed by the Scheduler.
 * Used for global priority selection.
 */
export const NON_DOWNLOAD_COMMAND_NAMES = [
    CommandNames.RefreshArtist,
    CommandNames.RefreshAlbum,
    CommandNames.RefreshMetadata,
    CommandNames.ApplyCuration,
    CommandNames.DownloadMissing,
    CommandNames.CheckUpgrades,
    CommandNames.Housekeeping,
    CommandNames.CurateArtist,
    CommandNames.RescanFolders,
    CommandNames.ConfigPrune,
    CommandNames.MoveArtist,
    CommandNames.RenameFiles,
    CommandNames.RenameArtist,
    CommandNames.RetagFiles,
    CommandNames.RetagArtist,
    CommandNames.BulkRefreshArtist,
    CommandNames.DownloadMissingForce,
    CommandNames.RescanAllRoots,
    CommandNames.CheckHealth,
    CommandNames.CompactDatabase,
    CommandNames.CleanupTempFiles,
    CommandNames.UpdateLibraryMetadata,
] as const;

export function isDownloadJobType(type: string): type is typeof DOWNLOAD_COMMAND_NAMES[number] {
    return (DOWNLOAD_COMMAND_NAMES as readonly string[]).includes(type);
}

export function isDownloadOrImportJobType(type: string): type is typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES[number] {
    return (DOWNLOAD_OR_IMPORT_COMMAND_NAMES as readonly string[]).includes(type);
}

export type CommandStatus = 'queued' | 'started' | 'completed' | 'failed' | 'cancelled';

export interface CommandBodyMap {
    [CommandNames.RefreshArtist]: RefreshArtistCommand;
    [CommandNames.RefreshAlbum]: RefreshAlbumCommand;
    [CommandNames.RefreshMetadata]: RefreshMetadataCommand;
    [CommandNames.ApplyCuration]: ApplyCurationCommand;
    [CommandNames.DownloadMissing]: DownloadMissingCommand;
    [CommandNames.CheckUpgrades]: CheckUpgradesCommand;
    [CommandNames.Housekeeping]: HousekeepingCommand;
    [CommandNames.DownloadTrack]: DownloadTrackCommand;
    [CommandNames.DownloadVideo]: DownloadVideoCommand;
    [CommandNames.DownloadAlbum]: DownloadAlbumCommand;
    [CommandNames.CurateArtist]: CurateArtistCommand;
    [CommandNames.RescanFolders]: RescanFoldersCommand;
    [CommandNames.ImportDownload]: ImportDownloadCommand;
    [CommandNames.ConfigPrune]: ConfigPruneCommand;
    [CommandNames.MoveArtist]: MoveArtistCommand;
    [CommandNames.RenameFiles]: RenameFilesCommand;
    [CommandNames.RenameArtist]: RenameArtistCommand;
    [CommandNames.RetagFiles]: RetagFilesCommand;
    [CommandNames.RetagArtist]: RetagArtistCommand;
    [CommandNames.BulkRefreshArtist]: BulkRefreshArtistCommand;
    [CommandNames.DownloadMissingForce]: DownloadMissingForceCommand;
    [CommandNames.RescanAllRoots]: RescanAllRootsCommand;
    [CommandNames.CheckHealth]: CheckHealthCommand;
    [CommandNames.CompactDatabase]: CompactDatabaseCommand;
    [CommandNames.CleanupTempFiles]: CleanupTempFilesCommand;
    [CommandNames.UpdateLibraryMetadata]: UpdateLibraryMetadataCommand;
}

export type AnyCommandBody = CommandBodyMap[CommandName];

interface CommandModelRecordBase<T extends CommandName> {
    id: number;
    name: T;
    payload: CommandBodyMap[T];
    status: CommandStatus;
    progress: number;
    priority: number;
    trigger?: number;
    queue_order?: number | null;
    attempts: number;
    error?: string;
    ref_id?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    updated_at?: string;
}

export type CommandModelOf<T extends CommandName> = CommandModelRecordBase<T>;
export type CommandModel = { [K in CommandName]: CommandModelOf<K> }[CommandName];

import { appEvents, AppEvent, CommandEventPayload } from "./app-events.js";

// ---------------------------------------------------------------------------
// Throttled COMMAND_UPDATED emission (Lidarr-style debounce)
// ---------------------------------------------------------------------------
// Structural status changes (processing, completed, failed, cancelled) emit
// immediately. Progress / description-only updates are coalesced so that at
// most one COMMAND_UPDATED is emitted per job per second.
const JOB_UPDATE_THROTTLE_MS = 1000;
const jobUpdateBuffer = new Map<number, { payload: CommandEventPayload; timer: ReturnType<typeof setTimeout> }>();
const TERMINAL_JOB_STATUSES = new Set<CommandStatus>(["completed", "failed", "cancelled"]);

/**
 * Emit COMMAND_UPDATED for progress/description changes at most once per second
 * per job.  The first call for a given job emits immediately; subsequent calls
 * within the throttle window are coalesced and flushed when the timer fires.
 */
function emitThrottledJobUpdate(payload: CommandEventPayload): void {
    const existing = jobUpdateBuffer.get(payload.id);
    if (existing) {
        // Already have a pending timer — just update the buffered payload
        existing.payload = payload;
        return;
    }

    // First call for this job — emit immediately, then start throttle window
    appEvents.emit(AppEvent.COMMAND_UPDATED, payload);
    const timer = setTimeout(() => {
        const buffered = jobUpdateBuffer.get(payload.id);
        jobUpdateBuffer.delete(payload.id);
        if (buffered) {
            appEvents.emit(AppEvent.COMMAND_UPDATED, buffered.payload);
        }
    }, JOB_UPDATE_THROTTLE_MS);
    if (timer.unref) timer.unref();
    jobUpdateBuffer.set(payload.id, { payload, timer });
}

/** Flush and clear any pending throttled update for a job (used before
 *  structural events that must not be preceded by a stale progress update). */
function clearJobUpdateThrottle(jobId: number): void {
    const existing = jobUpdateBuffer.get(jobId);
    if (existing) {
        clearTimeout(existing.timer);
        jobUpdateBuffer.delete(jobId);
    }
}

function isObjectPayload(value: unknown): value is CommandBodyCommon {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeParsePayload(raw: unknown, jobId?: number): CommandBodyCommon {
    if (isObjectPayload(raw)) return raw;
    if (typeof raw !== 'string') return {};

    try {
        const parsed = JSON.parse(raw);
        return isObjectPayload(parsed) ? parsed : {};
    } catch (error) {
        console.warn(`[Queue] Failed to parse payload for job ${jobId ?? 'unknown'}; using empty payload`, error);
        return {};
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
        includeSimilarArtists: Boolean(payload.includeSimilarArtists),
        seedSimilarArtists: Boolean(payload.seedSimilarArtists),
        forceDownloadQueue: Boolean(payload.forceDownloadQueue),
        forceUpdate: Boolean(payload.forceUpdate),
        expandCreditedArtists: payload.expandCreditedArtists !== false,
    };
}

function areEquivalentRefreshArtistPayloads(
    left: RefreshArtistCommand,
    right: RefreshArtistCommand,
): boolean {
    return left.artistId === right.artistId
        && left.artistName === right.artistName
        && left.workflow === right.workflow
        && left.monitorArtist === right.monitorArtist
        && left.hydrateCatalog === right.hydrateCatalog
        && left.hydrateAlbumTracks === right.hydrateAlbumTracks
        && left.scanLibrary === right.scanLibrary
        && left.includeSimilarArtists === right.includeSimilarArtists
        && left.seedSimilarArtists === right.seedSimilarArtists
        && left.forceDownloadQueue === right.forceDownloadQueue
        && left.forceUpdate === right.forceUpdate
        && left.expandCreditedArtists === right.expandCreditedArtists;
}

export function isCommandName(value: string): value is CommandName {
    return (Object.values(CommandNames) as string[]).includes(value);
}

function buildTypeInClause(types: readonly string[]): string {
    return types.map(() => '?').join(',');
}

function parseSqliteDate(value: unknown): number {
    if (!value) {
        return 0;
    }

    if (typeof value === "string") {
        const normalized = value.includes("T") || value.includes("Z")
            ? value
            : value.replace(" ", "T") + "Z";
        return new Date(normalized).getTime() || 0;
    }

    return new Date(value as string | number | Date).getTime() || 0;
}

function buildColumnName(column: string, alias?: string): string {
    return alias ? `${alias}.${column}` : column;
}

function buildExecutionOrderClause(alias?: string): string {
    const priority = buildColumnName("priority", alias);
    const trigger = buildColumnName("trigger", alias);
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                ${priority} DESC,
                ${trigger} DESC,
                COALESCE(${queueOrder}, 2147483647) ASC,
                ${createdAt} ASC,
                ${id} ASC
            `;
}

function buildDurableQueueOrderClause(alias?: string): string {
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                COALESCE(${queueOrder}, 2147483647) ASC,
                ${createdAt} ASC,
                ${id} ASC
            `;
}

function buildLiveActivityOrderClause(alias?: string): string {
    const status = buildColumnName("status", alias);
    const priority = buildColumnName("priority", alias);
    const trigger = buildColumnName("trigger", alias);
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const startedAt = buildColumnName("started_at", alias);
    const updatedAt = buildColumnName("updated_at", alias);
    const id = buildColumnName("id", alias);

    return `
                CASE
                    WHEN ${status} = 'started' THEN 0
                    WHEN ${status} = 'queued' THEN 1
                    ELSE 2
                END ASC,
                CASE
                    WHEN ${status} = 'started' THEN COALESCE(${updatedAt}, ${startedAt}, ${createdAt})
                END DESC,
                CASE
                    WHEN ${status} = 'started' THEN ${id}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN ${priority}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN ${trigger}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN COALESCE(${queueOrder}, 2147483647)
                END ASC,
                CASE
                    WHEN ${status} = 'queued' THEN ${createdAt}
                END ASC,
                CASE
                    WHEN ${status} = 'queued' THEN ${id}
                END ASC,
                ${id} DESC
            `;
}

function buildHistoryOrderClause(alias?: string): string {
    const completedAt = buildColumnName("completed_at", alias);
    const updatedAt = buildColumnName("updated_at", alias);
    const startedAt = buildColumnName("started_at", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                ${completedAt} DESC,
                ${updatedAt} DESC,
                ${startedAt} DESC,
                ${createdAt} DESC,
                ${id} DESC
            `;
}

function hydrateJobRow(row: { name: string; payload: unknown; id: number } & Record<string, unknown>): CommandModel | null {
    if (!isCommandName(row.name)) {
        console.warn(`[TaskQueue] Encountered unknown job type ${String(row.name)} for job ${row.id}; skipping typed hydration`);
        return null;
    }

    return {
        ...(row as Omit<CommandModelRecordBase<CommandName>, 'payload'> & { payload: unknown }),
        name: row.name,
        payload: safeParsePayload(row.payload, row.id) as AnyCommandBody,
    } as CommandModel;
}

export function compareJobsByExecutionOrder(left: CommandModel, right: CommandModel): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }

    const leftTrigger = left.trigger ?? CommandTrigger.Unspecified;
    const rightTrigger = right.trigger ?? CommandTrigger.Unspecified;
    if (leftTrigger !== rightTrigger) {
        return rightTrigger - leftTrigger;
    }

    const leftQueueOrder = left.queue_order ?? Number.MAX_SAFE_INTEGER;
    const rightQueueOrder = right.queue_order ?? Number.MAX_SAFE_INTEGER;
    if (leftQueueOrder !== rightQueueOrder) {
        return leftQueueOrder - rightQueueOrder;
    }

    const leftCreatedAt = parseSqliteDate(left.created_at);
    const rightCreatedAt = parseSqliteDate(right.created_at);
    if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }

    return left.id - right.id;
}

export function compareJobsByDurableQueueOrder(left: CommandModel, right: CommandModel): number {
    const leftQueueOrder = left.queue_order ?? Number.MAX_SAFE_INTEGER;
    const rightQueueOrder = right.queue_order ?? Number.MAX_SAFE_INTEGER;
    if (leftQueueOrder !== rightQueueOrder) {
        return leftQueueOrder - rightQueueOrder;
    }

    const leftCreatedAt = parseSqliteDate(left.created_at);
    const rightCreatedAt = parseSqliteDate(right.created_at);
    if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }

    return left.id - right.id;
}

export function sortJobsByExecutionOrder<T extends CommandModel>(jobs: T[]): T[] {
    return jobs.sort(compareJobsByExecutionOrder);
}

export class CommandQueueService {
    /**
     * Add a job to the queue
     */
    static addJob<T extends CommandName>(
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

    static listJobs(
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
        const jobs = db.prepare(`
            SELECT * FROM commands
            WHERE name IN (${typePlaceholders})
              AND status IN (${statusPlaceholders})
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
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
            WHERE status = 'queued' AND name IN (${placeholders})
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
     */
    static getTopPendingJobsByTypes(types: readonly CommandName[], limit: number = 20): CommandModel[] {
        if (types.length === 0) return [];

        const placeholders = buildTypeInClause(types);
        const rows = db.prepare(`
            SELECT * FROM commands
            WHERE status = 'queued' AND name IN (${placeholders})
            ORDER BY
${buildExecutionOrderClause()}
            LIMIT ?
        `).all(...types, limit) as any[];

        return rows
            .map((row) => hydrateJobRow(row as { name: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is CommandModel => job !== null);
    }

    static markProcessing(id: number): boolean {
        const result = db.prepare(`
            UPDATE commands
            SET status = 'started', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'queued'
        `).run(id);
        if (result.changes === 0) return false;
        clearJobUpdateThrottle(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'started', progress: job.progress } as CommandEventPayload);
        return true;
    }

    static updateProgress(id: number, progress: number) {
        const result = db.prepare("UPDATE commands SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')").run(progress, id);
        if (result.changes === 0) return;
        const job = this.getById(id);
        if (job) emitThrottledJobUpdate({ id, type: job.name, status: job.status, progress } as CommandEventPayload);
    }

    static updateState(id: number, options: { progress?: number; payloadPatch?: Partial<CommandBodyCommon> }) {
        const current = this.getById(id);
        if (!current) return null;
        if (TERMINAL_JOB_STATUSES.has(current.status)) return current;

        const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
        const params: unknown[] = [];

        if (options.progress !== undefined) {
            updates.push("progress = ?");
            params.push(options.progress);
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

        if (updates.length === 1) {
            return current;
        }

        params.push(id);
        db.prepare(`UPDATE commands SET ${updates.join(", ")} WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`).run(...params);

        const updated = this.getById(id);
        if (updated) {
            emitThrottledJobUpdate({
                id,
                type: updated.name,
                status: updated.status,
                progress: updated.progress,
                payload: updated.payload,
            } as CommandEventPayload);
        }

        return updated;
    }

    static complete(id: number) {
        const result = db.prepare("UPDATE commands SET status = 'completed', progress = 100, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')").run(id);
        if (result.changes === 0) return;
        clearJobUpdateThrottle(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'completed', progress: 100 } as CommandEventPayload);
    }

    static fail(id: number, error: string) {
        const result = db.prepare(`
            UPDATE commands 
            SET status = 'failed', error = ?, attempts = attempts + 1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
    `).run(error, id);
        if (result.changes === 0) return;
        clearJobUpdateThrottle(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'failed', progress: job.progress, error } as CommandEventPayload);
    }

    static cancel(id: number) {
        db.prepare("UPDATE commands SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        clearJobUpdateThrottle(id);
        const job = this.getById(id);
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
                attempts = 0,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE id = ?
	    `).run(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.COMMAND_UPDATED, { id, type: job.name, status: 'queued', progress: 0 } as CommandEventPayload);
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
    static requeueStaleProcessingJobs(options: {
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

    static clearFinished(typePattern: string = '%') {
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

    /**
     * Boost a pending job to manual/high priority
     */
    static boostToManual(typePattern: string, refId: string, priority: number = 1): number {
        const result = db.prepare(`
            UPDATE commands
            SET priority = ?, trigger = , updated_at = CURRENT_TIMESTAMP
            WHERE status = 'queued' AND name LIKE ? AND ref_id = ?
    `).run(priority, typePattern, refId);

        return result.changes;
    }

    static reorderPendingJobs(
        jobIds: number[],
        options: {
            beforeJobId?: number;
            afterJobId?: number;
            types?: readonly CommandName[];
        } = {},
    ): number {
        const normalizedJobIds = jobIds.filter((jobId) => Number.isInteger(jobId) && jobId > 0);
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
        const movingJobs = distinctJobIds.map((jobId) => pendingById.get(jobId)).filter((job): job is CommandModel => job != null);

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
            SET queue_order = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND (queue_order IS NULL OR queue_order != ?)
        `);

        const tx = db.transaction(() => {
            reorderedJobs.forEach((job, index) => {
                const queueOrder = index + 1;
                updateQueueOrder.run(queueOrder, job.id, queueOrder);
            });
        });

        tx();
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
    static getById(id: number): CommandModel | null {
        const job = db.prepare(`SELECT * FROM commands WHERE id = ? `).get(id) as any;

        if (!job) return null;

        return hydrateJobRow(job as { name: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Clear all download jobs (pending/failed)
     */
    static clearDownloadJobs() {
        const placeholders = buildTypeInClause(DOWNLOAD_OR_IMPORT_COMMAND_NAMES);
        db.prepare(`DELETE FROM commands WHERE name IN (${placeholders}) AND status IN ('queued', 'failed')`).run(...DOWNLOAD_OR_IMPORT_COMMAND_NAMES);
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
    static deleteJob(id: number) {
        const job = this.getById(id);
        db.prepare("DELETE FROM commands WHERE id = ?").run(id);
        if (job) appEvents.emit(AppEvent.COMMAND_DELETED, { id, type: job.name, status: job.status, progress: job.progress } as CommandEventPayload);
    }
}
