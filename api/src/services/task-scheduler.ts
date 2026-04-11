import { db } from "../database.js";
import { getConfigSection, updateConfig, type MonitoringConfig as ConfigMonitoringConfig } from "./config.js";
import { CurationService } from "./curation-service.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { JobTypes, TaskQueueService, type Job } from "./queue.js";
import { getManagedArtists, getManagedArtistsDueForRefresh } from "./managed-artists.js";
import { readIntEnv } from "../utils/env.js";
import {
    getArtistsWithPendingJobs,
    getEffectiveMonitoringRuntimeState,
    hasActiveHousekeepingTask,
    hasActiveMonitoringCycleWorkflow,
    hasActiveTask,
    loadMonitoringProgress,
    saveMonitoringProgress,
} from "./task-state.js";
import {
    getNextMonitoringWindowAtOrAfter,
    isScheduledTaskDue,
    isWithinTimeWindow,
    normalizeArtistIds,
    normalizeMonitoringPassWorkflow,
    parseScheduledTaskTime,
    resolveMonitoringPassWorkflow,
    type MonitoringPassWorkflow,
} from "./schedule-policy.js";

export type { MonitoringConfig } from "./task-state.js";
export type { MonitoringPassWorkflow } from "./schedule-policy.js";

let schedulerInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;
let isChecking = false;

let scheduledTaskUpsertStmt: any | null = null;
let scheduledTaskGetStmt: any | null = null;
let scheduledTaskQueueStampStmt: any | null = null;
let activeMonitoringDownloadPassStmt: any | null = null;

const SCHEDULED_TASK_TICK_MS = readIntEnv("DISCOGENIUS_TASK_SCHEDULER_TICK_MS", 30 * 1000, 1_000);
const HOUSEKEEPING_INTERVAL_MS = readIntEnv("DISCOGENIUS_HOUSEKEEPING_INTERVAL_MS", 24 * 60 * 60 * 1000, 60_000);
const METADATA_REFRESH_BATCH_SIZE = readIntEnv("DISCOGENIUS_METADATA_REFRESH_BATCH_SIZE", 50, 1);

export type ScheduledTaskKey = "monitoring-cycle" | "housekeeping";

interface ScheduledTaskDefinition {
    key: ScheduledTaskKey;
    name: string;
    taskName: typeof JobTypes.RefreshMetadata | typeof JobTypes.RescanFolders | typeof JobTypes.Housekeeping;
    intervalMinutes: number;
    enabled: boolean;
}

interface ScheduledTaskRow {
    task_key: ScheduledTaskKey;
    name: string;
    interval_minutes: number;
    enabled: number;
    last_queued_at?: string | null;
}

export interface ScheduledTaskSnapshot {
    key: ScheduledTaskKey;
    name: string;
    taskName: string;
    intervalMinutes: number;
    enabled: boolean;
    lastQueuedAt: string | null;
    nextRunAt: string | null;
    active: boolean;
}

function getScheduledTaskUpsertStmt() {
    if (!scheduledTaskUpsertStmt) {
        scheduledTaskUpsertStmt = db.prepare(`
      INSERT INTO scheduled_tasks (task_key, name, interval_minutes, enabled, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(task_key) DO UPDATE SET
        name = excluded.name,
        interval_minutes = excluded.interval_minutes,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `);
    }
    return scheduledTaskUpsertStmt;
}

function getScheduledTaskGetStmt() {
    if (!scheduledTaskGetStmt) {
        scheduledTaskGetStmt = db.prepare(`
      SELECT task_key, name, interval_minutes, enabled, last_queued_at
      FROM scheduled_tasks
      WHERE task_key = ?
    `);
    }
    return scheduledTaskGetStmt;
}

function getScheduledTaskQueueStampStmt() {
    if (!scheduledTaskQueueStampStmt) {
        scheduledTaskQueueStampStmt = db.prepare(`
      UPDATE scheduled_tasks
      SET last_queued_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = ?
    `);
    }
    return scheduledTaskQueueStampStmt;
}

function getActiveMonitoringDownloadPassStmt() {
        if (!activeMonitoringDownloadPassStmt) {
                activeMonitoringDownloadPassStmt = db.prepare(`
            SELECT 1
            FROM job_queue
            WHERE type = ?
                AND json_extract(payload, '$.monitoringCycle') IS NOT NULL
                AND status IN ('pending', 'processing')
            LIMIT 1
        `);
        }

        return activeMonitoringDownloadPassStmt;
}

function getScheduledTaskInsertStmt() {
    return db.prepare(`
      INSERT OR IGNORE INTO scheduled_tasks (task_key, name, interval_minutes, enabled, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
}

function getScheduledTaskUpdateStmt() {
    return db.prepare(`
      UPDATE scheduled_tasks
      SET name = ?,
          interval_minutes = ?,
          enabled = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = ?
    `);
}

export function getMonitoringStatus(): { running: boolean; checking: boolean; config: import("./task-state.js").MonitoringConfig } {
    const configFromFile = getConfigSection("monitoring");
    const runtimeState = getEffectiveMonitoringRuntimeState(configFromFile, { isChecking });
    const checking = runtimeState.checkInProgress;

    const config: import("./task-state.js").MonitoringConfig = {
        ...configFromFile,
        ...runtimeState,
    };

    return {
        running: isMonitoring,
        checking,
        config,
    };
}

export function updateMonitoringConfig(updates: Partial<ConfigMonitoringConfig>): import("./task-state.js").MonitoringConfig {
    updateConfig("monitoring", updates);
    const config = getMonitoringStatus().config;

    updateScheduledTask("monitoring-cycle", {
        enabled: config.enable_active_monitoring,
        intervalMinutes: Math.max(1, config.scan_interval_hours * 60),
    });

    if (!isMonitoring) {
        startMonitoring();
    }

    return config;
}

function selectMetadataRefreshArtists(options: {
    artistIds?: string[];
    dueOnly?: boolean;
}) {
    const artistIds = normalizeArtistIds(options.artistIds);
    if (options.dueOnly) {
        return getManagedArtistsDueForRefresh({
            artistIds,
            refreshDays: getConfigSection("monitoring").artist_refresh_days,
        });
    }

    return getManagedArtists({ orderByLastScanned: true, artistIds });
}

export function queueMetadataRefreshPass(options: {
    trigger?: number;
    monitoringCycle?: MonitoringPassWorkflow;
    dueOnly?: boolean;
    artistIds?: string[];
} = {}) {
    const monitoringCycle = normalizeMonitoringPassWorkflow(options.monitoringCycle);
    const selectedArtistIds = normalizeArtistIds(options.artistIds) ?? [];
    const artists = selectMetadataRefreshArtists({
        artistIds: options.artistIds,
        dueOnly: options.dueOnly,
    });
    const shouldBatchDueRefresh = Boolean(options.dueOnly) && selectedArtistIds.length === 0;
    const queuedArtists = shouldBatchDueRefresh
        ? artists.slice(0, METADATA_REFRESH_BATCH_SIZE)
        : artists;
    const queuedArtistIds = queuedArtists.map((artist) => String(artist.id));
    const artistLabel = options.dueOnly ? "due managed artist(s)" : "managed artist(s)";
    const refId = monitoringCycle ? `metadata-refresh:${monitoringCycle}` : "metadata-refresh";
    const jobId = TaskQueueService.addJob(
        JobTypes.RefreshMetadata,
        {
            title: "Refreshing metadata",
            description: queuedArtists.length > 0
                ? shouldBatchDueRefresh && queuedArtists.length < artists.length
                    ? `Queueing metadata refresh for ${queuedArtists.length} of ${artists.length} ${artistLabel}`
                    : `Queueing metadata refresh for ${queuedArtists.length} ${artistLabel}`
                : (options.dueOnly ? "No managed artists are due for metadata refresh" : "Queueing metadata refresh"),
            artistIds: queuedArtistIds,
            expectedArtists: queuedArtists.length,
            monitoringCycle,
        },
        refId,
        0,
        options.trigger ?? 1,
    );

    return jobId;
}

export function queueMonitoringCyclePass(options: { trigger?: number; includeRootScan?: boolean } = {}) {
    return queueMetadataRefreshPass({
        trigger: options.trigger,
        dueOnly: true,
        monitoringCycle: (options.includeRootScan ?? true) ? "full-cycle" : "curation-cycle",
    });
}

export function queueRescanFoldersPass(options: {
    trigger?: number;
    fullProcessing?: boolean;
    monitoringCycle?: Extract<MonitoringPassWorkflow, "full-cycle" | "root-scan-cycle">;
    artistIds?: string[];
    monitorArtist?: boolean;
    addNewArtists?: boolean;
    trackUnmappedFiles?: boolean;
} = {}) {
    const monitoringCycle = normalizeMonitoringPassWorkflow(options.monitoringCycle);
    const refId = monitoringCycle ? `rescan-folders:${monitoringCycle}` : "rescan-folders";
    const jobId = TaskQueueService.addJob(
        JobTypes.RescanFolders,
        {
            addNewArtists: options.addNewArtists ?? false,
            artistIds: normalizeArtistIds(options.artistIds),
            monitorArtist: options.monitorArtist ?? true,
            fullProcessing: options.fullProcessing ?? false,
            trackUnmappedFiles: options.trackUnmappedFiles ?? true,
            monitoringCycle,
        },
        refId,
        0,
        options.trigger ?? 1,
    );

    return jobId;
}

export function queueCurationPass(options: {
    trigger?: number;
    monitoringCycle?: MonitoringPassWorkflow;
    artistIds?: string[];
} = {}) {
    const monitoringCycle = normalizeMonitoringPassWorkflow(options.monitoringCycle);
    const artistIds = normalizeArtistIds(options.artistIds);
    const artists = getManagedArtists({ orderByLastScanned: true, artistIds });
    const refId = monitoringCycle ? `apply-curation:${monitoringCycle}` : "apply-curation";
    return TaskQueueService.addJob(
        JobTypes.ApplyCuration,
        {
            title: "Applying curation",
            description: artists.length > 0
                ? `Queueing curation for ${artists.length} managed artist(s)`
                : "Queueing curation",
            artistIds,
            expectedArtists: artists.length,
            monitoringCycle,
        },
        refId,
        0,
        options.trigger ?? 1,
    );
}

export function queueDownloadMissingPass(options: {
    trigger?: number;
    monitoringCycle?: MonitoringPassWorkflow;
    artistIds?: string[];
} = {}) {
    const monitoringCycle = normalizeMonitoringPassWorkflow(options.monitoringCycle);
    const refId = monitoringCycle ? `download-missing:${monitoringCycle}` : "download-missing";
    return TaskQueueService.addJob(
        JobTypes.DownloadMissing,
        {
            artistIds: normalizeArtistIds(options.artistIds),
            title: "Queueing missing downloads",
            description: "Adding monitored missing items to the download queue",
            monitoringCycle,
        },
        refId,
        0,
        options.trigger ?? 1,
    );
}

function hasActiveMonitoringCycleDownloadPass(): boolean {
    return Boolean(getActiveMonitoringDownloadPassStmt().get(JobTypes.DownloadMissing));
}

function markMonitoringCycleCompleted() {
    markScheduledTaskQueued("monitoring-cycle");
    updateConfig("monitoring", { last_check: new Date().toISOString() });
}

export function queueNextMonitoringPass(job: Pick<Job, "type" | "payload" | "trigger">) {
    const monitoringCycle = resolveMonitoringPassWorkflow(job.payload?.monitoringCycle);
    if (!monitoringCycle) {
        return;
    }

    switch (job.type) {
        case JobTypes.RefreshMetadata:
            // Per-artist curation is handled by the event-driven pipeline:
            // ARTIST_SCANNED → RescanFolders → RESCAN_COMPLETED → CurateArtist.
            // Only queue the library-wide root scan if full-cycle; DownloadMissing
            // is deferred until all monitoring-originated follow-up work drains.
            if (monitoringCycle === "full-cycle") {
                queueRescanFoldersPass({
                    trigger: job.trigger ?? 0,
                    fullProcessing: true,
                    trackUnmappedFiles: false,
                    monitoringCycle,
                    addNewArtists: false,
                });
            }
            break;
        case JobTypes.RescanFolders:
            break;
        case JobTypes.ApplyCuration:
            // Manual ApplyCuration still chains to DownloadMissing
            queueDownloadMissingPass({
                trigger: job.trigger ?? 0,
                monitoringCycle,
            });
            return;
        default:
            break;
    }

    if (hasActiveMonitoringCycleWorkflow()) {
        return;
    }

    if (job.type === JobTypes.DownloadMissing) {
        markMonitoringCycleCompleted();
        return;
    }

    if (!hasActiveMonitoringCycleDownloadPass()) {
        queueDownloadMissingPass({
            trigger: job.trigger ?? 0,
            monitoringCycle,
        });
    }
}

export function queueCheckUpgradesPass(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.CheckUpgrades,
        {
            title: "Checking upgrades",
            description: "Scanning the library for quality upgrades",
        },
        "check-upgrades",
        0,
        options.trigger ?? 1,
    );
}

export function queueHousekeepingPass(options: { trigger?: number } = {}) {
    const trigger = options.trigger ?? 2;
    const jobId = TaskQueueService.addJob(
        JobTypes.Housekeeping,
        {
            title: "Running housekeeping",
            description: "Cleaning runtime state and stale library records",
        },
        "housekeeping",
        0,
        trigger,
    );
    if (jobId !== -1) {
        markScheduledTaskQueued("housekeeping");
    }
    return jobId;
}

function getScheduledTaskDefinitions(): ScheduledTaskDefinition[] {
    const { config } = getMonitoringStatus();
    const refreshIntervalMinutes = Math.max(1, config.scan_interval_hours * 60);

    return [
        {
            key: "monitoring-cycle",
            name: "Monitoring Cycle",
            taskName: JobTypes.RescanFolders,
            intervalMinutes: refreshIntervalMinutes,
            enabled: Boolean(config.enable_active_monitoring),
        },
        {
            key: "housekeeping",
            name: "Housekeeping",
            taskName: JobTypes.Housekeeping,
            intervalMinutes: Math.max(1, Math.round(HOUSEKEEPING_INTERVAL_MS / 60_000)),
            enabled: true,
        },
    ];
}
function syncScheduledTasks() {
    const definitions = getScheduledTaskDefinitions();

    for (const definition of definitions) {
        getScheduledTaskInsertStmt().run(
            definition.key,
            definition.name,
            definition.intervalMinutes,
            definition.enabled ? 1 : 0,
        );
    }

    db.prepare(`
    DELETE FROM scheduled_tasks
    WHERE task_key NOT IN (${definitions.map(() => "?").join(", ")})
  `).run(...definitions.map((definition) => definition.key));
}

function getScheduledTask(taskKey: ScheduledTaskKey): ScheduledTaskRow | null {
    return (getScheduledTaskGetStmt().get(taskKey) as ScheduledTaskRow | undefined) ?? null;
}

function markScheduledTaskQueued(taskKey: ScheduledTaskKey) {
    getScheduledTaskQueueStampStmt().run(taskKey);
}

function getScheduledTaskDefinitionByKey(taskKey: ScheduledTaskKey): ScheduledTaskDefinition | null {
    return getScheduledTaskDefinitions().find((definition) => definition.key === taskKey) ?? null;
}

function getEffectiveScheduledTaskDefinition(definition: ScheduledTaskDefinition) {
    const task = getScheduledTask(definition.key);
    return {
        ...definition,
        name: task?.name ?? definition.name,
        intervalMinutes: task?.interval_minutes ?? definition.intervalMinutes,
        enabled: task ? Boolean(task.enabled) : definition.enabled,
        lastQueuedAt: task?.last_queued_at ?? null,
    };
}

function getScheduledTaskActiveState(definition: ScheduledTaskDefinition): boolean {
    switch (definition.key) {
        case "monitoring-cycle":
            return hasActiveMonitoringCycleWorkflow();
        case "housekeeping":
            return hasActiveHousekeepingTask();
        default:
            return hasActiveTask(definition.taskName);
    }
}

export function updateScheduledTask(taskKey: ScheduledTaskKey, updates: { enabled?: boolean; intervalMinutes?: number }) {
    syncScheduledTasks();

    const definition = getScheduledTaskDefinitionByKey(taskKey);
    if (!definition) {
        throw new Error(`Unknown scheduled task: ${taskKey}`);
    }

    const current = getScheduledTask(taskKey);
    const nextEnabled = updates.enabled ?? (current ? Boolean(current.enabled) : definition.enabled);
    const nextIntervalMinutes = updates.intervalMinutes ?? (current ? current.interval_minutes : definition.intervalMinutes);

    getScheduledTaskUpdateStmt().run(
        definition.name,
        nextIntervalMinutes,
        nextEnabled ? 1 : 0,
        taskKey,
    );

    const updated = getScheduledTask(taskKey);
    if (!updated) {
        throw new Error(`Failed to update scheduled task: ${taskKey}`);
    }

    const effective = getEffectiveScheduledTaskDefinition(definition);
    return {
        key: definition.key,
        name: definition.name,
        taskName: definition.taskName,
        intervalMinutes: updated.interval_minutes,
        enabled: Boolean(updated.enabled),
        lastQueuedAt: updated.last_queued_at ?? null,
        nextRunAt: effective.enabled
            ? (definition.key === "monitoring-cycle"
                ? getNextMonitoringWindowAtOrAfter(
                    (parseScheduledTaskTime(updated.last_queued_at ?? null) ?? Date.now()) + updated.interval_minutes * 60_000,
                    getMonitoringStatus().config.start_hour,
                    getMonitoringStatus().config.duration_hours,
                )
                : new Date((parseScheduledTaskTime(updated.last_queued_at ?? null) ?? Date.now()) + updated.interval_minutes * 60_000).toISOString())
            : null,
        active: getScheduledTaskActiveState(definition),
    };
}

export function getScheduledTaskSnapshots(): ScheduledTaskSnapshot[] {
    syncScheduledTasks();

    return getScheduledTaskDefinitions().map((definition) => {
        const effective = getEffectiveScheduledTaskDefinition(definition);
        const task = getScheduledTask(definition.key);
        const lastQueuedAt = effective.lastQueuedAt;
        const parsedLastQueued = parseScheduledTaskTime(lastQueuedAt);
        const nextDueAt = parsedLastQueued !== null
            ? parsedLastQueued + effective.intervalMinutes * 60_000
            : Date.now();

        const monitoringConfig = getMonitoringStatus().config;
        const nextRunAt = effective.enabled
            ? (definition.key === "monitoring-cycle"
                ? getNextMonitoringWindowAtOrAfter(nextDueAt, monitoringConfig.start_hour, monitoringConfig.duration_hours)
                : new Date(nextDueAt).toISOString())
            : null;

        return {
            key: definition.key,
            name: definition.name,
            taskName: definition.taskName,
            intervalMinutes: effective.intervalMinutes,
            enabled: effective.enabled,
            lastQueuedAt,
            nextRunAt,
            active: getScheduledTaskActiveState(definition),
        };
    });
}

function queueDueScheduledTasks() {
    syncScheduledTasks();

    for (const definition of getScheduledTaskDefinitions()) {
        const effective = getEffectiveScheduledTaskDefinition(definition);

        if (!effective.enabled) {
            continue;
        }

        if (!isScheduledTaskDue(effective.intervalMinutes, effective.lastQueuedAt ?? null)) {
            continue;
        }

        if (definition.key === "monitoring-cycle") {
            const monitoringConfig = getMonitoringStatus().config;
            if (!isWithinTimeWindow(monitoringConfig.start_hour, monitoringConfig.duration_hours)) {
                continue;
            }

            if (isChecking || hasActiveMonitoringCycleWorkflow()) {
                continue;
            }

            isChecking = true;
            saveMonitoringProgress(0, true);
            try {
                const jobId = queueMonitoringCyclePass({ trigger: 2, includeRootScan: true });
                if (jobId !== -1) {
                    console.log("🔄 Scheduled monitoring cycle queued");
                }
            } finally {
                isChecking = false;
                saveMonitoringProgress(0, false);
            }

            continue;
        }

        if (definition.key === "housekeeping") {
            if (hasActiveHousekeepingTask()) {
                continue;
            }

            const jobId = queueHousekeepingPass({ trigger: 2 });
            if (jobId !== -1) {
                markScheduledTaskQueued(definition.key);
                console.log("🧹 Scheduled housekeeping queued");
            }
        }
    }
}
export function startMonitoring() {
    if (isMonitoring) {
        console.log("⚠️  Monitoring already running");
        return;
    }

    loadMonitoringProgress();
    syncScheduledTasks();

    const { config } = getMonitoringStatus();
    console.log(`🔍 Starting scheduled task runner (Refresh metadata and root folder scan every ${config.scan_interval_hours}h inside ${config.start_hour}:00-${config.start_hour + config.duration_hours}:00, housekeeping every ${Math.round(HOUSEKEEPING_INTERVAL_MS / 3_600_000)}h)`);
    isMonitoring = true;

    const tick = () => {
        try {
            queueDueScheduledTasks();
        } catch (error) {
            console.error("[Monitoring] Scheduler tick failed:", error);
        }
    };

    tick();
    schedulerInterval = setInterval(tick, SCHEDULED_TASK_TICK_MS);
}

export function stopMonitoring() {
    if (!isMonitoring) {
        console.log("⚠️  Monitoring not running");
        return;
    }

    console.log("🛑 Stopping artist monitoring");
    isMonitoring = false;
    isChecking = false;

    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
}

export async function checkNow(): Promise<{ newAlbums: number; artists: number }> {
    console.log("🔍 Manual metadata refresh triggered (TIDAL data only, no curation/downloads)");

    const artists = getManagedArtists({ orderByLastScanned: true }) as any[];

    if (artists.length === 0) {
        console.log("📭 No artists with monitored items");
        return { newAlbums: 0, artists: 0 };
    }

    const artistsWithPendingJobs = getArtistsWithPendingJobs();

    const totalNewAlbums = 0;
    const scanTargets = artists;

    for (const artist of scanTargets) {
        if (artistsWithPendingJobs.has(String(artist.id))) {
            console.log(`  Skipping ${artist.name} (pending scan/curation job)`);
            continue;
        }

        try {
            console.log(`  Checking ${artist.name}...`);
            const isMonitored = Boolean(artist.monitor);
            await RefreshArtistService.scanDeep(artist.id, {
                monitorArtist: isMonitored,
                hydrateCatalog: true,
                hydrateAlbumTracks: false,
                includeSimilarArtists: false,
                seedSimilarArtists: false,
            });
        } catch (error) {
            console.error(`  ❌ Error checking ${artist.name}:`, error);
        }
    }

    console.log(`✅ Manual metadata refresh complete: scanned ${artists.length} artist(s)`);
    return { newAlbums: totalNewAlbums, artists: artists.length };
}

export async function queueCheckNow(): Promise<{ success: boolean; jobId?: number }> {
    const jobId = TaskQueueService.addJob(
        "RefreshMetadata",
        {
            title: "Refreshing TIDAL metadata",
            description: "Scanning TIDAL for new releases",
        },
        "refresh_metadata_manual",
        1,
        1,
    );

    return { success: jobId > 0, jobId };
}

export async function checkNowStreaming(sendEvent: (event: string, data: any) => void): Promise<{ newAlbums: number; artists: number }> {
    sendEvent("status", { message: "Refreshing TIDAL metadata..." });

    const artists = getManagedArtists({ orderByLastScanned: true }) as any[];

    if (artists.length === 0) {
        sendEvent("status", { message: "No artists with monitored items found" });
        sendEvent("complete", { newAlbums: 0, artists: 0 });
        return { newAlbums: 0, artists: 0 };
    }

    const artistsWithPendingJobs = getArtistsWithPendingJobs();

    const scanTargets = artists;
    const monitoredCount = artists.filter((artist: any) => artist.monitor).length;
    sendEvent("total", { total: scanTargets.length, monitored: monitoredCount });

    let skippedCount = 0;

    for (let index = 0; index < scanTargets.length; index += 1) {
        const artist = scanTargets[index];

        if (artistsWithPendingJobs.has(String(artist.id))) {
            console.log(`[Monitoring] Skipping ${artist.name} (id=${artist.id}) - pending scan/curation job`);
            sendEvent("artist-skipped", {
                name: artist.name,
                reason: "pending_jobs",
                progress: index + 1,
                total: scanTargets.length,
            });
            skippedCount += 1;
            continue;
        }

        try {
            const isMonitored = Boolean(artist.monitor);
            sendEvent("artist-progress", {
                name: artist.name,
                progress: index + 1,
                total: scanTargets.length,
            });

            await RefreshArtistService.scanDeep(artist.id, {
                monitorArtist: isMonitored,
                hydrateCatalog: true,
                hydrateAlbumTracks: false,
                includeSimilarArtists: false,
                seedSimilarArtists: false,
            });

            sendEvent("artist-checked", {
                name: artist.name,
                progress: index + 1,
                total: scanTargets.length,
            });
        } catch (error) {
            console.error(`Error checking ${artist.name}:`, error);
            sendEvent("error", {
                message: `Failed to check ${artist.name}`,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    sendEvent("complete", { artists: artists.length, skipped: skippedCount });
    return { newAlbums: 0, artists: artists.length };
}

export async function downloadMissing(): Promise<{ albums: number; tracks: number; videos: number }> {
    console.log("📥 Queueing downloads for all monitored artists...");

    const monitoredArtists = getManagedArtists();

    if (monitoredArtists.length === 0) {
        console.log("📭 No monitored artists");
        return { albums: 0, tracks: 0, videos: 0 };
    }

    let totalAlbums = 0;
    let totalTracks = 0;
    let totalVideos = 0;

    for (const artist of monitoredArtists) {
        try {
            const queued = await CurationService.queueMonitoredItems(String(artist.id));
            totalAlbums += queued.albums;
            totalTracks += queued.tracks;
            totalVideos += queued.videos;

            const total = queued.albums + queued.tracks + queued.videos;
            if (total > 0) {
                console.log(`  📥 ${artist.name}: ${queued.albums} albums, ${queued.tracks} tracks, ${queued.videos} videos`);
            }
        } catch (error) {
            console.error(`  ❌ Error queueing downloads for ${artist.name}:`, error);
        }
    }

    console.log(`✅ Download queue complete: ${totalAlbums} albums, ${totalTracks} tracks, ${totalVideos} videos`);
    return { albums: totalAlbums, tracks: totalTracks, videos: totalVideos };
}
















// ============================================================================
// Phase 1: Manual Command Queue Functions
// ============================================================================

export function queueBulkRefreshArtist(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.BulkRefreshArtist,
        {},
        'bulk-refresh-artist',
        10,  // manual trigger boost
        options.trigger ?? 1,
    );
}

export function queueDownloadMissingForce(options: { trigger?: number } = {}) {
    const skipFlags = true;  // Clear skip_* flags before queueing DownloadMissing
    return TaskQueueService.addJob(
        JobTypes.DownloadMissingForce,
        { skipFlags },
        'download-missing-force',
        10,  // manual trigger boost
        options.trigger ?? 1,
    );
}

export function queueRescanAllRoots(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.RescanAllRoots,
        { addNewArtists: false },
        'rescan-all-roots',
        10,  // manual trigger boost
        options.trigger ?? 1,
    );
}

export function queueCheckHealth(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.CheckHealth,
        {},
        'check-health',
        0,
        options.trigger ?? 1,
    );
}

export function queueCompactDatabase(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.CompactDatabase,
        {},
        'compact-database',
        0,
        options.trigger ?? 1,
    );
}

export function queueCleanupTempFiles(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.CleanupTempFiles,
        {},
        'cleanup-temp-files',
        0,
        options.trigger ?? 1,
    );
}

export function queueUpdateLibraryMetadata(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.UpdateLibraryMetadata,
        {},
        'update-library-metadata',
        0,
        options.trigger ?? 1,
    );
}
export function queueConfigPrune(options: { trigger?: number } = {}) {
    return TaskQueueService.addJob(
        JobTypes.ConfigPrune,
        {},
        'config-prune',
        0,
        options.trigger ?? 1,
    );
}


