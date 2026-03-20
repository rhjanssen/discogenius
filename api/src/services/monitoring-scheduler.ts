import { db } from "../database.js";
import { getConfigSection, updateConfig, type MonitoringConfig as ConfigMonitoringConfig } from "./config.js";
import { RedundancyService } from "./redundancy.js";
import { scanArtistDeep } from "./scanner.js";
import { JobTypes, TaskQueueService, type Job } from "./queue.js";
import { getManagedArtists, getManagedArtistsDueForRefresh } from "./managed-artists.js";
import { readIntEnv } from "../utils/env.js";
import {
    getArtistsWithPendingJobs,
    getEffectiveMonitoringRuntimeState,
    hasActiveArtistWorkflow,
    hasActiveHousekeepingTask,
    hasActiveTask,
    loadMonitoringProgress,
    saveMonitoringProgress,
} from "./monitoring-state.js";
import {
    getNextMonitoringWindowAtOrAfter,
    isScheduledTaskDue,
    isWithinTimeWindow,
    normalizeArtistIds,
    normalizeMonitoringPassWorkflow,
    parseScheduledTaskTime,
    resolveMonitoringPassWorkflow,
    type MonitoringPassWorkflow,
} from "./monitoring-policy.js";

export type { MonitoringConfig } from "./monitoring-state.js";
export type { MonitoringPassWorkflow } from "./monitoring-policy.js";

let schedulerInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;
let isChecking = false;

let scheduledTaskUpsertStmt: any | null = null;
let scheduledTaskGetStmt: any | null = null;
let scheduledTaskQueueStampStmt: any | null = null;

const SCHEDULED_TASK_TICK_MS = readIntEnv("DISCOGENIUS_TASK_SCHEDULER_TICK_MS", 30 * 1000, 1_000);
const HOUSEKEEPING_INTERVAL_MS = readIntEnv("DISCOGENIUS_HOUSEKEEPING_INTERVAL_MS", 24 * 60 * 60 * 1000, 60_000);
const METADATA_REFRESH_BATCH_SIZE = readIntEnv("DISCOGENIUS_METADATA_REFRESH_BATCH_SIZE", 25, 1);

type ScheduledTaskKey = "refresh-metadata" | "rescan-folders" | "housekeeping";

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

export function getMonitoringStatus(): { running: boolean; checking: boolean; config: import("./monitoring-state.js").MonitoringConfig } {
    const configFromFile = getConfigSection("monitoring");
    const runtimeState = getEffectiveMonitoringRuntimeState(configFromFile, { isChecking });
    const checking = runtimeState.checkInProgress;

    const config: import("./monitoring-state.js").MonitoringConfig = {
        ...configFromFile,
        ...runtimeState,
    };

    return {
        running: isMonitoring,
        checking,
        config,
    };
}

export function updateMonitoringConfig(updates: Partial<ConfigMonitoringConfig>): import("./monitoring-state.js").MonitoringConfig {
    updateConfig("monitoring", updates);
    syncScheduledTasks();

    if (!isMonitoring) {
        startMonitoring();
    }

    return getMonitoringStatus().config;
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
        "metadata-refresh",
        0,
        options.trigger ?? 1,
    );

    if (jobId !== -1) {
        markScheduledTaskQueued("refresh-metadata");
    }

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
} = {}) {
    const monitoringCycle = normalizeMonitoringPassWorkflow(options.monitoringCycle);
    const jobId = TaskQueueService.addJob(
        JobTypes.RescanFolders,
        {
            addNewArtists: true,
            artistIds: normalizeArtistIds(options.artistIds),
            monitorArtist: true,
            fullProcessing: options.fullProcessing ?? false,
            monitoringCycle,
        },
        "rescan-folders",
        0,
        options.trigger ?? 1,
    );

    if (jobId !== -1) {
        markScheduledTaskQueued("rescan-folders");
    }

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
        "apply-curation",
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
    return TaskQueueService.addJob(
        JobTypes.DownloadMissing,
        {
            artistIds: normalizeArtistIds(options.artistIds),
            title: "Queueing missing downloads",
            description: "Adding monitored missing items to the download queue",
            monitoringCycle,
        },
        "download-missing",
        0,
        options.trigger ?? 1,
    );
}

export function queueNextMonitoringPass(job: Pick<Job, "type" | "payload" | "trigger">) {
    const monitoringCycle = resolveMonitoringPassWorkflow(job.payload?.monitoringCycle);
    if (!monitoringCycle) {
        return;
    }

    switch (job.type) {
        case JobTypes.RefreshMetadata:
            if (monitoringCycle === "full-cycle") {
                queueRescanFoldersPass({
                    trigger: job.trigger ?? 0,
                    fullProcessing: true,
                    monitoringCycle,
                });
                return;
            }

            queueCurationPass({
                trigger: job.trigger ?? 0,
                monitoringCycle,
            });
            return;
        case JobTypes.RescanFolders:
            // Only chain monitoring phases for library-wide scans (not per-artist)
            if (job.payload?.addNewArtists) {
                queueCurationPass({
                    trigger: job.trigger ?? 0,
                    monitoringCycle,
                });
            }
            return;
        case JobTypes.ApplyCuration:
            queueDownloadMissingPass({
                trigger: job.trigger ?? 0,
                monitoringCycle,
            });
            return;
        default:
            return;
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
            key: "refresh-metadata",
            name: "Refresh Metadata",
            taskName: JobTypes.RefreshMetadata,
            intervalMinutes: refreshIntervalMinutes,
            enabled: Boolean(config.enable_active_monitoring),
        },
        {
            key: "rescan-folders",
            name: "Rescan Folders",
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
        getScheduledTaskUpsertStmt().run(
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

export function getScheduledTaskSnapshots(): ScheduledTaskSnapshot[] {
    syncScheduledTasks();

    return getScheduledTaskDefinitions().map((definition) => {
        const task = getScheduledTask(definition.key);
        const lastQueuedAt = task?.last_queued_at ?? null;
        const parsedLastQueued = parseScheduledTaskTime(lastQueuedAt);
        const nextDueAt = parsedLastQueued !== null
            ? parsedLastQueued + definition.intervalMinutes * 60_000
            : Date.now();

        const monitoringConfig = getMonitoringStatus().config;
        const nextRunAt = definition.enabled
            ? (definition.key === "refresh-metadata" || definition.key === "rescan-folders"
                ? getNextMonitoringWindowAtOrAfter(nextDueAt, monitoringConfig.start_hour, monitoringConfig.duration_hours)
                : new Date(nextDueAt).toISOString())
            : null;

        return {
            key: definition.key,
            name: definition.name,
            taskName: definition.taskName,
            intervalMinutes: definition.intervalMinutes,
            enabled: definition.enabled,
            lastQueuedAt,
            nextRunAt,
            active: hasActiveTask(definition.taskName),
        };
    });
}

function queueDueScheduledTasks() {
    syncScheduledTasks();

    for (const definition of getScheduledTaskDefinitions()) {
        if (!definition.enabled) {
            continue;
        }

        const task = getScheduledTask(definition.key);
        if (!isScheduledTaskDue(definition.intervalMinutes, task?.last_queued_at ?? null)) {
            continue;
        }

        if (definition.key === "refresh-metadata") {
            const monitoringConfig = getMonitoringStatus().config;
            if (!isWithinTimeWindow(monitoringConfig.start_hour, monitoringConfig.duration_hours)) {
                continue;
            }

            if (isChecking || hasActiveArtistWorkflow()) {
                continue;
            }

            isChecking = true;
            saveMonitoringProgress(0, true);
            const jobId = queueMetadataRefreshPass({ trigger: 2, dueOnly: true });
            if (jobId !== -1) {
                markScheduledTaskQueued(definition.key);
                updateConfig("monitoring", { last_check: new Date().toISOString() });
                console.log("🔍 Scheduled metadata refresh queued");
            }
            isChecking = false;
            saveMonitoringProgress(0, false);
            continue;
        }

        if (definition.key === "rescan-folders") {
            const monitoringConfig = getMonitoringStatus().config;
            if (!isWithinTimeWindow(monitoringConfig.start_hour, monitoringConfig.duration_hours)) {
                continue;
            }

            if (isChecking || hasActiveArtistWorkflow()) {
                continue;
            }

            const jobId = queueRescanFoldersPass({
                trigger: 2,
                fullProcessing: true,
                monitoringCycle: "root-scan-cycle",
            });
            if (jobId !== -1) {
                markScheduledTaskQueued(definition.key);
                console.log("📂 Scheduled root folder scan queued");
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
            await scanArtistDeep(artist.id, {
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

            await scanArtistDeep(artist.id, {
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
            const queued = await RedundancyService.queueMonitoredItems(String(artist.id));
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
