import { db } from "../database.js";
import type {
    ApplyCurationJobPayload,
    CheckUpgradesJobPayload,
    ConfigPruneJobPayload,
    CurateArtistJobPayload,
    DownloadAlbumJobPayload,
    DownloadMissingJobPayload,
    DownloadPlaylistJobPayload,
    DownloadTrackJobPayload,
    DownloadVideoJobPayload,
    HousekeepingJobPayload,
    ApplyRenamesJobPayload,
    ApplyRetagsJobPayload,
    ImportDownloadJobPayload,
    QueuePayloadCommon,
    RefreshArtistJobPayload,
    RefreshMetadataJobPayload,
    RescanFoldersJobPayload,
    ScanAlbumJobPayload,
    ScanPlaylistJobPayload,
    RefreshAllMonitoredJobPayload,
    DownloadMissingForceJobPayload,
    RescanAllRootsJobPayload,
    HealthCheckJobPayload,
    CompactDatabaseJobPayload,
    CleanupTempFilesJobPayload,
    UpdateLibraryMetadataJobPayload,
} from "./job-payloads.js";

export const JobTypes = {
    RefreshArtist: 'RefreshArtist',
    ScanAlbum: 'ScanAlbum',
    ScanPlaylist: 'ScanPlaylist',
    RefreshMetadata: 'RefreshMetadata',
    ApplyCuration: 'ApplyCuration',
    DownloadMissing: 'DownloadMissing',
    CheckUpgrades: 'CheckUpgrades',
    Housekeeping: 'Housekeeping',
    DownloadTrack: 'DownloadTrack',
    DownloadVideo: 'DownloadVideo',
    DownloadAlbum: 'DownloadAlbum',
    DownloadPlaylist: 'DownloadPlaylist',
    CurateArtist: 'CurateArtist',
    RescanFolders: 'RescanFolders',
    ImportDownload: 'ImportDownload',
    ConfigPrune: 'ConfigPrune',
    ApplyRenames: 'ApplyRenames',
    ApplyRetags: 'ApplyRetags',
    RefreshAllMonitored: 'RefreshAllMonitored',
    DownloadMissingForce: 'DownloadMissingForce',
    RescanAllRoots: 'RescanAllRoots',
    HealthCheck: 'HealthCheck',
    CompactDatabase: 'CompactDatabase',
    CleanupTempFiles: 'CleanupTempFiles',
    UpdateLibraryMetadata: 'UpdateLibraryMetadata',
} as const;

export type JobType = typeof JobTypes[keyof typeof JobTypes];

export const DOWNLOAD_JOB_TYPES = [
    JobTypes.DownloadTrack,
    JobTypes.DownloadVideo,
    JobTypes.DownloadAlbum,
    JobTypes.DownloadPlaylist,
] as const;

export const DOWNLOAD_OR_IMPORT_JOB_TYPES = [
    ...DOWNLOAD_JOB_TYPES,
    JobTypes.ImportDownload,
] as const;

export const ARTIST_WORKFLOW_JOB_TYPES = [
    JobTypes.RefreshArtist,
    JobTypes.RescanFolders,
    JobTypes.CurateArtist,
] as const;

/**
 * All non-download job types processed by the Scheduler.
 * Used for global priority selection (Lidarr-style CommandQueue).
 */
export const NON_DOWNLOAD_JOB_TYPES = [
    JobTypes.RefreshArtist,
    JobTypes.ScanAlbum,
    JobTypes.ScanPlaylist,
    JobTypes.RefreshMetadata,
    JobTypes.ApplyCuration,
    JobTypes.DownloadMissing,
    JobTypes.CheckUpgrades,
    JobTypes.Housekeeping,
    JobTypes.CurateArtist,
    JobTypes.RescanFolders,
    JobTypes.ConfigPrune,
    JobTypes.ApplyRenames,
    JobTypes.ApplyRetags,
    JobTypes.RefreshAllMonitored,
    JobTypes.DownloadMissingForce,
    JobTypes.RescanAllRoots,
    JobTypes.HealthCheck,
    JobTypes.CompactDatabase,
    JobTypes.CleanupTempFiles,
    JobTypes.UpdateLibraryMetadata,
] as const;

export function isDownloadJobType(type: string): type is typeof DOWNLOAD_JOB_TYPES[number] {
    return (DOWNLOAD_JOB_TYPES as readonly string[]).includes(type);
}

export function isDownloadOrImportJobType(type: string): type is typeof DOWNLOAD_OR_IMPORT_JOB_TYPES[number] {
    return (DOWNLOAD_OR_IMPORT_JOB_TYPES as readonly string[]).includes(type);
}

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface JobPayloadMap {
    [JobTypes.RefreshArtist]: RefreshArtistJobPayload;
    [JobTypes.ScanAlbum]: ScanAlbumJobPayload;
    [JobTypes.ScanPlaylist]: ScanPlaylistJobPayload;
    [JobTypes.RefreshMetadata]: RefreshMetadataJobPayload;
    [JobTypes.ApplyCuration]: ApplyCurationJobPayload;
    [JobTypes.DownloadMissing]: DownloadMissingJobPayload;
    [JobTypes.CheckUpgrades]: CheckUpgradesJobPayload;
    [JobTypes.Housekeeping]: HousekeepingJobPayload;
    [JobTypes.DownloadTrack]: DownloadTrackJobPayload;
    [JobTypes.DownloadVideo]: DownloadVideoJobPayload;
    [JobTypes.DownloadAlbum]: DownloadAlbumJobPayload;
    [JobTypes.DownloadPlaylist]: DownloadPlaylistJobPayload;
    [JobTypes.CurateArtist]: CurateArtistJobPayload;
    [JobTypes.RescanFolders]: RescanFoldersJobPayload;
    [JobTypes.ImportDownload]: ImportDownloadJobPayload;
    [JobTypes.ConfigPrune]: ConfigPruneJobPayload;
    [JobTypes.ApplyRenames]: ApplyRenamesJobPayload;
    [JobTypes.ApplyRetags]: ApplyRetagsJobPayload;
    [JobTypes.RefreshAllMonitored]: RefreshAllMonitoredJobPayload;
    [JobTypes.DownloadMissingForce]: DownloadMissingForceJobPayload;
    [JobTypes.RescanAllRoots]: RescanAllRootsJobPayload;
    [JobTypes.HealthCheck]: HealthCheckJobPayload;
    [JobTypes.CompactDatabase]: CompactDatabaseJobPayload;
    [JobTypes.CleanupTempFiles]: CleanupTempFilesJobPayload;
    [JobTypes.UpdateLibraryMetadata]: UpdateLibraryMetadataJobPayload;
}

export type AnyJobPayload = JobPayloadMap[JobType];

interface JobRecordBase<T extends JobType> {
    id: number;
    type: T;
    payload: JobPayloadMap[T];
    status: JobStatus;
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

export type JobOfType<T extends JobType> = JobRecordBase<T>;
export type Job = { [K in JobType]: JobOfType<K> }[JobType];

import { appEvents, AppEvent, JobEventPayload } from "./app-events.js";

function isObjectPayload(value: unknown): value is QueuePayloadCommon {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeParsePayload(raw: unknown, jobId?: number): QueuePayloadCommon {
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

function normalizeRefreshArtistPayload(
    payload: Partial<RefreshArtistJobPayload>,
): RefreshArtistJobPayload {
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
    };
}

function areEquivalentRefreshArtistPayloads(
    left: RefreshArtistJobPayload,
    right: RefreshArtistJobPayload,
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
        && left.forceUpdate === right.forceUpdate;
}

export function isJobType(value: string): value is JobType {
    return (Object.values(JobTypes) as string[]).includes(value);
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
                    WHEN ${status} = 'processing' THEN 0
                    WHEN ${status} = 'pending' THEN 1
                    ELSE 2
                END ASC,
                CASE
                    WHEN ${status} = 'processing' THEN COALESCE(${updatedAt}, ${startedAt}, ${createdAt})
                END DESC,
                CASE
                    WHEN ${status} = 'processing' THEN ${id}
                END DESC,
                CASE
                    WHEN ${status} = 'pending' THEN ${priority}
                END DESC,
                CASE
                    WHEN ${status} = 'pending' THEN ${trigger}
                END DESC,
                CASE
                    WHEN ${status} = 'pending' THEN COALESCE(${queueOrder}, 2147483647)
                END ASC,
                CASE
                    WHEN ${status} = 'pending' THEN ${createdAt}
                END ASC,
                CASE
                    WHEN ${status} = 'pending' THEN ${id}
                END ASC,
                ${id} DESC
            `;
}

function hydrateJobRow(row: { type: string; payload: unknown; id: number } & Record<string, unknown>): Job | null {
    if (!isJobType(row.type)) {
        console.warn(`[TaskQueue] Encountered unknown job type ${String(row.type)} for job ${row.id}; skipping typed hydration`);
        return null;
    }

    return {
        ...(row as Omit<JobRecordBase<JobType>, 'payload'> & { payload: unknown }),
        type: row.type,
        payload: safeParsePayload(row.payload, row.id) as AnyJobPayload,
    } as Job;
}

export function compareJobsByExecutionOrder(left: Job, right: Job): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }

    const leftTrigger = left.trigger ?? 0;
    const rightTrigger = right.trigger ?? 0;
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

export function compareJobsByDurableQueueOrder(left: Job, right: Job): number {
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

export function sortJobsByExecutionOrder<T extends Job>(jobs: T[]): T[] {
    return jobs.sort(compareJobsByExecutionOrder);
}

export class TaskQueueService {
    /**
     * Add a job to the queue
     */
    static addJob<T extends JobType>(
        type: T,
        payload: JobPayloadMap[T],
        refId?: string,
        priority: number = 0,
        trigger: number = 0,
        queueOrder?: number | null,
    ): number {
        // Validate download jobs have valid tidalId
        if (isDownloadJobType(type)) {
            const tidalId = payload?.tidalId || refId;
            if (!tidalId || tidalId === 'undefined' || tidalId === 'null') {
                console.warn(`[TaskQueue] Rejecting ${type} job with invalid tidalId: `, payload);
                return -1; // Return invalid ID to indicate rejection
            }
        }

        // Enforce uniqueness for active jobs if refId is provided
        if (refId) {
            if (type === JobTypes.RefreshArtist) {
                const incomingPayload = normalizeRefreshArtistPayload(payload as RefreshArtistJobPayload);
                const existingRefreshJobs = db.prepare(`
                    SELECT id, payload FROM job_queue
                    WHERE type = ? AND ref_id = ? AND status IN('pending', 'processing')
                `).all(type, refId) as Array<{ id: number; payload: unknown }>;

                // Mirror Lidarr-style command equality: dedupe by equivalent command body, not just artist ref.
                for (const existing of existingRefreshJobs) {
                    const existingPayload = normalizeRefreshArtistPayload(
                        safeParsePayload(existing.payload, existing.id) as Partial<RefreshArtistJobPayload>,
                    );

                    if (areEquivalentRefreshArtistPayloads(existingPayload, incomingPayload)) {
                        console.log(`[TaskQueue] Job ${type} for ${refId} already exists with equivalent payload, skipping duplicate.`);
                        return existing.id;
                    }
                }
            } else {
                const existing = db.prepare(`
                    SELECT id FROM job_queue
                    WHERE type = ? AND ref_id = ? AND status IN('pending', 'processing')
                `).get(type, refId) as { id: number } | undefined;

                if (existing) {
                    console.log(`[TaskQueue] Job ${type} for ${refId} already exists, skipping duplicate.`);
                    return existing.id;
                }
            }
        }

        const insert = db.prepare(`
               INSERT INTO job_queue(type, ref_id, payload, priority, trigger, queue_order, status, created_at, updated_at)
VALUES(?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

        const normalizedQueueOrder = Number.isInteger(queueOrder) && (queueOrder as number) > 0
            ? (queueOrder as number)
            : null;
        const info = insert.run(type, refId || null, JSON.stringify(payload), priority, trigger, normalizedQueueOrder);
        const newId = info.lastInsertRowid as number;
        db.prepare(`
            UPDATE job_queue
            SET queue_order = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND queue_order IS NULL
        `).run(newId, newId);
        appEvents.emit(AppEvent.JOB_ADDED, { id: newId, type, status: 'pending', progress: 0, payload } as JobEventPayload);
        return newId;
    }

    static listJobs(
        typePattern: string = '%',
        statusPattern: string = '%',
        limit: number = 50,
        offset: number = 0,
        options: { orderBy?: 'created_desc' | 'execution' | 'live_activity' | 'queue_order' } = {},
    ): Job[] {
        const orderBy = options.orderBy === 'execution'
            ? buildExecutionOrderClause()
            : options.orderBy === 'live_activity'
                ? buildLiveActivityOrderClause()
                : options.orderBy === 'queue_order'
                    ? buildDurableQueueOrderClause()
                    : 'created_at DESC, id DESC';
        const jobs = db.prepare(`
SELECT * FROM job_queue 
            WHERE type LIKE ? AND status LIKE ?
            ORDER BY ${orderBy}
LIMIT ? OFFSET ?
    `).all(typePattern, statusPattern, limit, offset) as any[];

        return jobs
            .map((job) => hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is Job => job !== null);
    }

    static listJobsByTypesAndStatuses(
        types: readonly JobType[],
        statuses: readonly JobStatus[],
        limit: number = 200,
        offset: number = 0,
        options: { orderBy?: 'created_desc' | 'execution' | 'live_activity' | 'queue_order' } = {},
    ): Job[] {
        if (types.length === 0 || statuses.length === 0) {
            return [];
        }

        const typePlaceholders = buildTypeInClause(types);
        const statusPlaceholders = statuses.map(() => '?').join(',');
        const orderBy = options.orderBy === 'execution'
            ? buildExecutionOrderClause()
            : options.orderBy === 'live_activity'
                ? buildLiveActivityOrderClause()
                : options.orderBy === 'queue_order'
                    ? buildDurableQueueOrderClause()
                    : 'created_at DESC, id DESC';
        const jobs = db.prepare(`
            SELECT * FROM job_queue
            WHERE type IN (${typePlaceholders})
              AND status IN (${statusPlaceholders})
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `).all(...types, ...statuses, limit, offset) as any[];

        return jobs
            .map((job) => hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is Job => job !== null);
    }

    static countJobsByTypesAndStatuses(
        types: readonly JobType[],
        statuses: readonly JobStatus[],
    ): number {
        if (types.length === 0 || statuses.length === 0) {
            return 0;
        }

        const typePlaceholders = buildTypeInClause(types);
        const statusPlaceholders = statuses.map(() => '?').join(',');
        const row = db.prepare(`
            SELECT COUNT(*) as count
            FROM job_queue
            WHERE type IN (${typePlaceholders})
              AND status IN (${statusPlaceholders})
        `).get(...types, ...statuses) as { count?: number } | undefined;

        return Number(row?.count || 0);
    }

    static countJobs(typePattern: string = '%', statusPattern: string = '%'): number {
        const result = db.prepare(`
            SELECT COUNT(*) as count
            FROM job_queue
            WHERE type LIKE ? AND status LIKE ?
        `).get(typePattern, statusPattern) as { count?: number } | undefined;

        return Number(result?.count || 0);
    }

    /**
     * Get paginated job history
     */
    static getHistory(limit: number = 50, offset: number = 0): Job[] {
        const jobs = db.prepare(`
            SELECT * FROM job_queue 
            WHERE status IN('completed', 'failed', 'cancelled')
            ORDER BY COALESCE(started_at, created_at) DESC
LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

        return jobs
            .map((job) => hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is Job => job !== null);
    }

    /**
     * Get next pending job matching a flexible type pattern.
     * e.g. 'DOWNLOAD_%' or 'SCAN_%' or exact 'RefreshArtist'
     */
    static getNextJob(typePattern: string = '%'): Job | null {
        // Find highest priority, oldest pending job matching type
        const job = db.prepare(`
            SELECT * FROM job_queue 
            WHERE status = 'pending' AND type LIKE ?
            ORDER BY 
${buildExecutionOrderClause()}
            LIMIT 1
        `).get(typePattern) as any;

        if (!job) return null;

        return hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    static getNextJobByTypes(types: readonly JobType[]): Job | null {
        if (types.length === 0) {
            return null;
        }

        const placeholders = buildTypeInClause(types);
        const job = db.prepare(`
            SELECT * FROM job_queue
            WHERE status = 'pending' AND type IN (${placeholders})
            ORDER BY
${buildExecutionOrderClause()}
            LIMIT 1
        `).get(...types) as any;

        if (!job) return null;

        return hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Return the top-N pending jobs across all given types, sorted globally by priority.
     * Used by the Scheduler to implement Lidarr-style CommandQueue selection:
     * the caller iterates the list and picks the first job that passes exclusivity checks.
     */
    static getTopPendingJobsByTypes(types: readonly JobType[], limit: number = 20): Job[] {
        if (types.length === 0) return [];

        const placeholders = buildTypeInClause(types);
        const rows = db.prepare(`
            SELECT * FROM job_queue
            WHERE status = 'pending' AND type IN (${placeholders})
            ORDER BY
${buildExecutionOrderClause()}
            LIMIT ?
        `).all(...types, limit) as any[];

        return rows
            .map((row) => hydrateJobRow(row as { type: string; payload: unknown; id: number } & Record<string, unknown>))
            .filter((job): job is Job => job !== null);
    }

    static markProcessing(id: number) {
        db.prepare("UPDATE job_queue SET status = 'processing', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.JOB_UPDATED, { id, type: job.type, status: 'processing', progress: job.progress } as JobEventPayload);
    }

    static updateProgress(id: number, progress: number) {
        db.prepare("UPDATE job_queue SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(progress, id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.JOB_UPDATED, { id, type: job.type, status: job.status, progress } as JobEventPayload);
    }

    static updateState(id: number, options: { progress?: number; payloadPatch?: Partial<QueuePayloadCommon> }) {
        const current = this.getById(id);
        if (!current) return null;

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
        db.prepare(`UPDATE job_queue SET ${updates.join(", ")} WHERE id = ?`).run(...params);

        const updated = this.getById(id);
        if (updated) {
            appEvents.emit(AppEvent.JOB_UPDATED, {
                id,
                type: updated.type,
                status: updated.status,
                progress: updated.progress,
                payload: updated.payload,
            } as JobEventPayload);
        }

        return updated;
    }

    static complete(id: number) {
        db.prepare("UPDATE job_queue SET status = 'completed', progress = 100, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.JOB_UPDATED, { id, type: job.type, status: 'completed', progress: 100 } as JobEventPayload);
    }

    static fail(id: number, error: string) {
        db.prepare(`
            UPDATE job_queue 
            SET status = 'failed', error = ?, attempts = attempts + 1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
    `).run(error, id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.JOB_UPDATED, { id, type: job.type, status: 'failed', progress: job.progress, error } as JobEventPayload);
    }

    static cancel(id: number) {
        db.prepare("UPDATE job_queue SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.JOB_UPDATED, { id, type: job.type, status: 'cancelled', progress: job.progress } as JobEventPayload);
    }

    /**
     * Cancel all pending (non-processing) jobs of given types for a specific artist.
     * Used to prevent stale queued jobs from conflicting with an inline manual scan.
     * Returns the number of jobs cancelled.
     */
    static cancelPendingForArtist(artistId: string, types: JobType[]): number {
        if (types.length === 0) return 0;
        const placeholders = types.map(() => '?').join(',');
        const result = db.prepare(`
            UPDATE job_queue
            SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE ref_id = ? AND type IN (${placeholders}) AND status = 'pending'
    `).run(artistId, ...types);
        const cancelled = (result as any).changes || 0;
        if (cancelled > 0) {
            console.log(`[TaskQueue] Cancelled ${cancelled} pending job(s) for artist ${artistId}(types: ${types.join(', ')})`);
        }
        return cancelled;
    }

    static retry(id: number) {
        db.prepare(`
            UPDATE job_queue 
            SET status = 'pending', error = NULL, progress = 0, started_at = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE id = ?
    `).run(id);
        const job = this.getById(id);
        if (job) appEvents.emit(AppEvent.JOB_UPDATED, { id, type: job.type, status: 'pending', progress: 0 } as JobEventPayload);
    }

    /**
     * Recover interrupted jobs from previous process crash/restart.
     * Moves processing jobs back to pending so workers can pick them up again.
     */
    static resetProcessingJobs(typePattern: string = '%'): number {
        const result = db.prepare(`
            UPDATE job_queue
            SET status = 'pending', started_at = NULL, progress = 0, updated_at = CURRENT_TIMESTAMP,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE status = 'processing' AND type LIKE ?
    `).run(typePattern);

        return result.changes;
    }

    static resetProcessingJobsByTypes(types: readonly JobType[]): number {
        if (types.length === 0) {
            return 0;
        }

        const placeholders = buildTypeInClause(types);
        const result = db.prepare(`
            UPDATE job_queue
            SET status = 'pending', started_at = NULL, progress = 0, updated_at = CURRENT_TIMESTAMP,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState')
            WHERE status = 'processing' AND type IN (${placeholders})
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
            UPDATE job_queue
            SET
                status = 'pending',
                started_at = NULL,
                completed_at = NULL,
                progress = 0,
                error = CASE WHEN error IS NULL OR error = '' THEN ? ELSE error END,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState'),
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing'
              AND type LIKE ?
              AND COALESCE(started_at, updated_at, created_at) <= datetime('now', ?)
              ${excludeClause}
        `).run(...params);

        return result.changes;
    }

    static requeueStaleProcessingJobsByTypes(options: {
        types: readonly JobType[];
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
            UPDATE job_queue
            SET
                status = 'pending',
                started_at = NULL,
                completed_at = NULL,
                progress = 0,
                error = CASE WHEN error IS NULL OR error = '' THEN ? ELSE error END,
                payload = json_remove(COALESCE(payload, '{}'), '$.downloadState'),
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing'
              AND type IN (${typeClause})
              AND COALESCE(started_at, updated_at, created_at) <= datetime('now', ?)
              ${excludeClause}
        `).run(...params);

        return result.changes;
    }

    static getStats() {
        return db.prepare(`
            SELECT type, status, COUNT(*) as count 
            FROM job_queue 
            GROUP BY type, status
    `).all();
    }

    static clearCompleted() {
        db.prepare("DELETE FROM job_queue WHERE status IN ('completed', 'cancelled')").run();
        appEvents.emit(AppEvent.QUEUE_CLEARED);
    }

    static clearFinished(typePattern: string = '%') {
        db.prepare(`
            DELETE FROM job_queue
            WHERE type LIKE ? AND status IN ('completed', 'failed', 'cancelled')
        `).run(typePattern);
        appEvents.emit(AppEvent.QUEUE_CLEARED);
    }

    static clearFinishedByTypes(types: string[]) {
        if (types.length === 0) {
            return;
        }

        const placeholders = types.map(() => '?').join(',');
        db.prepare(`
            DELETE FROM job_queue
            WHERE type IN (${placeholders}) AND status IN ('completed', 'failed', 'cancelled')
        `).run(...types);
        appEvents.emit(AppEvent.QUEUE_CLEARED);
    }

    /**
     * Boost a pending job to manual/high priority (Lidarr-style "user is looking at it")
     */
    static boostToManual(typePattern: string, refId: string, priority: number = 1): number {
        const result = db.prepare(`
            UPDATE job_queue
            SET priority = ?, trigger = 1, updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending' AND type LIKE ? AND ref_id = ?
    `).run(priority, typePattern, refId);

        return result.changes;
    }

    static reorderPendingJobs(
        jobIds: number[],
        options: {
            beforeJobId?: number;
            afterJobId?: number;
            types?: readonly JobType[];
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

        const types = options.types ?? DOWNLOAD_JOB_TYPES;
        const pendingJobs = this.listJobsByTypesAndStatuses(
            types,
            ['pending'],
            this.countJobsByTypesAndStatuses(types, ['pending']),
            0,
            { orderBy: 'execution' },
        );

        const pendingById = new Map(pendingJobs.map((job) => [job.id, job]));
        const movingSet = new Set(distinctJobIds);
        const movingJobs = distinctJobIds.map((jobId) => pendingById.get(jobId)).filter((job): job is Job => job != null);

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
            UPDATE job_queue
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
    static getByRefId(refId: string, typePattern: string = '%'): Job | null {
        const job = db.prepare(`
            SELECT * FROM job_queue 
            WHERE ref_id = ? AND type LIKE ? AND status IN('pending', 'processing')
            ORDER BY created_at DESC
            LIMIT 1
        `).get(refId, typePattern) as any;

        if (!job) return null;

        return hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Get job by ID
     */
    static getById(id: number): Job | null {
        const job = db.prepare(`SELECT * FROM job_queue WHERE id = ? `).get(id) as any;

        if (!job) return null;

        return hydrateJobRow(job as { type: string; payload: unknown; id: number } & Record<string, unknown>);
    }

    /**
     * Clear all download jobs (pending/failed)
     */
    static clearDownloadJobs() {
        const placeholders = buildTypeInClause(DOWNLOAD_OR_IMPORT_JOB_TYPES);
        db.prepare(`DELETE FROM job_queue WHERE type IN (${placeholders}) AND status IN ('pending', 'failed')`).run(...DOWNLOAD_OR_IMPORT_JOB_TYPES);
    }

    /**
     * Clear all jobs of a specific type pattern
     */
    static clearByType(typePattern: string) {
        db.prepare("DELETE FROM job_queue WHERE type LIKE ? AND status IN ('pending', 'failed', 'completed', 'cancelled')").run(typePattern);
    }

    /**
     * Delete a specific job by ID
     */
    static deleteJob(id: number) {
        const job = this.getById(id);
        db.prepare("DELETE FROM job_queue WHERE id = ?").run(id);
        if (job) appEvents.emit(AppEvent.JOB_DELETED, { id, type: job.type, status: job.status, progress: job.progress } as JobEventPayload);
    }
}

