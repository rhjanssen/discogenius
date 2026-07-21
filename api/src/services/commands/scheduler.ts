import { CommandTrigger } from "./command-trigger.js";
import { db } from "../../database.js";
import { getConfigSection, updateConfig, type MonitoringConfig as ConfigMonitoringConfig } from "../config/config.js";
import { CurationService } from "../music/curation-service.js";
import { DownloadMissingService } from "../music/download-missing-service.js";
import { RefreshArtistService } from "../music/refresh-artist-service.js";
import {CommandNames} from "./command-names.js";
import {CommandQueueManager, type CommandModel} from "./command-queue-manager.js";
import { getManagedArtists, getManagedArtistsDueForRefresh } from "../music/managed-artists.js";
import { readIntEnv } from "../../utils/env.js";
import {
    getArtistsWithPendingJobs,
    getEffectiveMonitoringRuntimeState,
    hasActiveArtistWorkflowJobs,
    hasActiveHousekeepingTask,
    hasActiveMonitoringCycleWorkflow,
    hasActiveTask,
    loadMonitoringProgress,
    saveMonitoringProgress,
    stampMonitoringCompleted,
} from "./task-state.js";
import {
    isScheduledTaskDue,
    normalizeArtistIds,
    normalizeMonitoringPassWorkflow,
    parseScheduledTaskTime,
    resolveMonitoringPassWorkflow,
    type MonitoringPassWorkflow,
} from "../config/schedule-policy.js";

export type { MonitoringConfig } from "./task-state.js";
export type { MonitoringPassWorkflow } from "../config/schedule-policy.js";

let schedulerInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;
let isChecking = false;

let scheduledTaskUpsertStmt: any | null = null;
let scheduledTaskGetStmt: any | null = null;
let scheduledTaskQueueStampStmt: any | null = null;
let activeMonitoringDownloadPassStmt: any | null = null;

const SCHEDULED_TASK_TICK_MS = readIntEnv("DISCOGENIUS_TASK_SCHEDULER_TICK_MS", 30 * 1000, 1_000);
const HOUSEKEEPING_INTERVAL_MS = readIntEnv("DISCOGENIUS_HOUSEKEEPING_INTERVAL_MS", 24 * 60 * 60 * 1000, 60_000);
const MONITORING_DUE_CHECK_INTERVAL_MINUTES = readIntEnv("DISCOGENIUS_MONITORING_DUE_CHECK_INTERVAL_MINUTES", 24 * 60, 1);

export type ScheduledTaskKey = "monitoring-cycle" | "root-scan" | "housekeeping";

interface ScheduledTaskDefinition {
    key: ScheduledTaskKey;
    name: string;
    taskName: typeof CommandNames.RefreshMetadata | typeof CommandNames.RescanFolders | typeof CommandNames.Housekeeping;
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
            FROM commands
            WHERE name = ?
                AND json_extract(payload, '$.monitoringCycle') IS NOT NULL
                AND status IN ('queued', 'started')
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
    const runtimeState = getEffectiveMonitoringRuntimeState({ isChecking });
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
        intervalMinutes: MONITORING_DUE_CHECK_INTERVAL_MINUTES,
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
        const pendingArtistIds = getArtistsWithPendingJobs();
        return getManagedArtistsDueForRefresh({
            artistIds,
        }).filter((artist) => !pendingArtistIds.has(String(artist.id)));
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
    const artists = selectMetadataRefreshArtists({
        artistIds: options.artistIds,
        dueOnly: options.dueOnly,
    });
    // Lidarr's scheduled RefreshArtist command considers the complete managed
    // artist set in one daily pass. Discogenius fans that pass out into durable
    // per-artist commands, but keeps the same all-due semantics; queue equality
    // and the pending-id filter above prevent duplicate work.
    const queuedArtists = artists;
    const queuedArtistIds = queuedArtists.map((artist) => String(artist.id));
    const artistLabel = options.dueOnly ? "due managed artist(s)" : "managed artist(s)";
    const refId = monitoringCycle ? `metadata-refresh:${monitoringCycle}` : "metadata-refresh";
    const commandId = CommandQueueManager.push(
        CommandNames.RefreshMetadata,
        {
            title: "Refreshing metadata",
            description: queuedArtists.length > 0
                ? `Queueing metadata refresh for ${queuedArtists.length} ${artistLabel}`
                : (options.dueOnly ? "No managed artists are due for metadata refresh" : "Queueing metadata refresh"),
            artistIds: queuedArtistIds,
            expectedArtists: queuedArtists.length,
            monitoringCycle,
        },
        refId,
        0,
        options.trigger ?? CommandTrigger.Manual,
    );

    return commandId;
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
    const commandId = CommandQueueManager.push(
        CommandNames.RescanFolders,
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
        options.trigger ?? CommandTrigger.Manual,
    );

    return commandId;
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
    return CommandQueueManager.push(
        CommandNames.ApplyCuration,
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
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueDownloadMissingPass(options: {
    trigger?: number;
    monitoringCycle?: MonitoringPassWorkflow;
    artistIds?: string[];
} = {}) {
    const monitoringCycle = normalizeMonitoringPassWorkflow(options.monitoringCycle);
    const refId = monitoringCycle ? `download-missing:${monitoringCycle}` : "download-missing";
    return CommandQueueManager.push(
        CommandNames.DownloadMissing,
        {
            artistIds: normalizeArtistIds(options.artistIds),
            title: "Queueing missing downloads",
            description: "Adding monitored missing items to the download queue",
            monitoringCycle,
        },
        refId,
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}

function hasActiveMonitoringCycleDownloadPass(): boolean {
    return Boolean(getActiveMonitoringDownloadPassStmt().get(CommandNames.DownloadMissing));
}

function markMonitoringCycleCompleted() {
    trySyncScheduledTasks();
    markScheduledTaskQueued("monitoring-cycle");
    stampMonitoringCompleted();
}

export function queueNextMonitoringPass(job: Pick<CommandModel, "name" | "payload" | "trigger">) {
    const monitoringCycle = resolveMonitoringPassWorkflow(job.payload?.monitoringCycle);
    if (!monitoringCycle) {
        return;
    }
    const expectedArtists = typeof job.payload?.expectedArtists === "number"
        ? job.payload.expectedArtists
        : undefined;

    switch (job.name) {
        case CommandNames.RefreshMetadata:
            if (expectedArtists === 0) {
                markMonitoringCycleCompleted();
                return;
            }
            // Per-artist matching and curation are event-driven. Root-folder
            // inventory is an independent daily RescanFolders task, matching
            // Lidarr's separate RefreshArtist and RescanFolders schedules.
            break;
        case CommandNames.RescanFolders:
            break;
        case CommandNames.ApplyCuration:
            if (expectedArtists === 0) {
                markMonitoringCycleCompleted();
                return;
            }
            // Monitoring-cycle curation explicitly chains to the terminal download pass.
            queueDownloadMissingPass({
                trigger: job.trigger ?? CommandTrigger.Unspecified,
                monitoringCycle,
            });
            return;
        default:
            break;
    }

    // Defer the terminal download pass until both the cycle's own tagged jobs
    // AND any in-flight artist intake/refresh/curation work have drained. The
    // latter (untagged RefreshArtist/RescanFolders/CurateArtist) is what produces
    // the monitored slots DownloadMissing queues from; without this guard the
    // cycle's DownloadMissing could fire mid-intake and queue nothing.
    if (hasActiveMonitoringCycleWorkflow() || hasActiveArtistWorkflowJobs()) {
        return;
    }

    if (job.name === CommandNames.DownloadMissing) {
        markMonitoringCycleCompleted();
        return;
    }

    if (!hasActiveMonitoringCycleDownloadPass()) {
        queueDownloadMissingPass({
            trigger: job.trigger ?? CommandTrigger.Unspecified,
            monitoringCycle,
        });
    }
}

export function queueCheckUpgradesPass(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.CheckUpgrades,
        {
            title: "Checking upgrades",
            description: "Scanning the library for quality upgrades",
        },
        "check-upgrades",
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueHousekeepingPass(options: { trigger?: number } = {}) {
    const trigger = options.trigger ?? CommandTrigger.Scheduled;
    const commandId = CommandQueueManager.push(
        CommandNames.Housekeeping,
        {
            title: "Running housekeeping",
            description: "Cleaning runtime state and stale library records",
        },
        "housekeeping",
        0,
        trigger,
    );
    if (commandId !== -1) {
        markScheduledTaskQueued("housekeeping");
    }
    return commandId;
}

function getScheduledTaskDefinitions(): ScheduledTaskDefinition[] {
    const { config } = getMonitoringStatus();

    return [
        {
            key: "monitoring-cycle",
            name: "Refresh Artists",
            taskName: CommandNames.RefreshMetadata,
            intervalMinutes: MONITORING_DUE_CHECK_INTERVAL_MINUTES,
            enabled: Boolean(config.enable_active_monitoring),
        },
        {
            key: "root-scan",
            name: "Rescan Folders",
            taskName: CommandNames.RescanFolders,
            intervalMinutes: 24 * 60,
            enabled: true,
        },
        {
            key: "housekeeping",
            name: "Housekeeping",
            taskName: CommandNames.Housekeeping,
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

function trySyncScheduledTasks(): boolean {
    try {
        syncScheduledTasks();
        return true;
    } catch (error) {
        if (error && typeof error === "object" && (error as { code?: string }).code === "SQLITE_BUSY") {
            console.warn("[Monitoring] Scheduled task sync skipped because SQLite is busy; retrying on the next tick");
            return false;
        }
        throw error;
    }
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
        case "root-scan":
            return hasActiveTask(CommandNames.RescanFolders);
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
            ? new Date((parseScheduledTaskTime(updated.last_queued_at ?? null) ?? Date.now()) + updated.interval_minutes * 60_000).toISOString()
            : null,
        active: getScheduledTaskActiveState(definition),
    };
}

export function getScheduledTaskSnapshots(): ScheduledTaskSnapshot[] {
    // Read path (GET /system/task): sync opportunistically but never fail the
    // request over write-lock contention — the rows are already synced at boot
    // and on every scheduler tick, and the INSERT/DELETE here runs on the
    // fail-fast main thread, which used to 500 the task list exactly when the
    // user most wants to see what's running.
    trySyncScheduledTasks();

    return getScheduledTaskDefinitions().map((definition) => {
        const effective = getEffectiveScheduledTaskDefinition(definition);
        const task = getScheduledTask(definition.key);
        const lastQueuedAt = effective.lastQueuedAt;
        const parsedLastQueued = parseScheduledTaskTime(lastQueuedAt);
        const nextDueAt = parsedLastQueued !== null
            ? parsedLastQueued + effective.intervalMinutes * 60_000
            : Date.now();

        const nextRunAt = effective.enabled ? new Date(nextDueAt).toISOString() : null;

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
    if (!trySyncScheduledTasks()) {
        return;
    }

    for (const definition of getScheduledTaskDefinitions()) {
        const effective = getEffectiveScheduledTaskDefinition(definition);

        if (!effective.enabled) {
            continue;
        }

        if (!isScheduledTaskDue(effective.intervalMinutes, effective.lastQueuedAt ?? null)) {
            continue;
        }

        if (definition.key === "monitoring-cycle") {
            if (isChecking || hasActiveMonitoringCycleWorkflow()) {
                continue;
            }

            isChecking = true;
            saveMonitoringProgress(0, true);
            try {
                const commandId = queueMonitoringCyclePass({ trigger: CommandTrigger.Scheduled, includeRootScan: true });
                if (commandId !== -1) {
                    // Stamp at queue time (like Lidarr measures the next run from when
                    // the task fires) so a cycle that fails to fully complete still
                    // won't re-queue every tick. markMonitoringCycleCompleted()
                    // refreshes it again when the full chain drains.
                    markScheduledTaskQueued("monitoring-cycle");
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

            const commandId = queueHousekeepingPass({ trigger: CommandTrigger.Scheduled });
            if (commandId !== -1) {
                markScheduledTaskQueued(definition.key);
                console.log("🧹 Scheduled housekeeping queued");
            }
            continue;
        }

        if (definition.key === "root-scan") {
            if (hasActiveTask(CommandNames.RescanFolders)) {
                continue;
            }
            const commandId = queueRescanFoldersPass({
                trigger: CommandTrigger.Scheduled,
                fullProcessing: false,
                addNewArtists: false,
            });
            if (commandId !== -1) {
                markScheduledTaskQueued(definition.key);
                console.log("📁 Scheduled root-folder rescan queued");
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
    trySyncScheduledTasks();

    const { config } = getMonitoringStatus();
    console.log(`🔍 Starting scheduled task runner (artist refresh and root scan every ${MONITORING_DUE_CHECK_INTERVAL_MINUTES}m, housekeeping every ${Math.round(HOUSEKEEPING_INTERVAL_MS / 3_600_000)}h)`);
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
            await RefreshArtistService.refreshArtist(artist.id, {
                monitorArtist: isMonitored,
                hydrateCatalog: true,
                hydrateAlbumTracks: false,
            });
        } catch (error) {
            console.error(`  ❌ Error checking ${artist.name}:`, error);
        }
    }

    console.log(`✅ Manual metadata refresh complete: scanned ${artists.length} artist(s)`);
    return { newAlbums: totalNewAlbums, artists: artists.length };
}

export async function queueCheckNow(): Promise<{ success: boolean; commandId?: number }> {
    const commandId = CommandQueueManager.push(
        "RefreshMetadata",
        {
            title: "Refreshing provider metadata",
            description: "Refreshing MusicBrainz metadata and provider availability",
        },
        "refresh_metadata_manual",
        1,
        1,
    );

    return { success: commandId > 0, commandId };
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
            const queued = await DownloadMissingService.queueMonitoredItems(String(artist.id));
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
    return CommandQueueManager.push(
        CommandNames.BulkRefreshArtist,
        {},
        'bulk-refresh-artist',
        10,  // manual trigger boost
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueDownloadMissingForce(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.DownloadMissingForce,
        {},
        'download-missing-force',
        10,  // manual trigger boost
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueRescanAllRoots(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.RescanAllRoots,
        { addNewArtists: false },
        'rescan-all-roots',
        10,  // manual trigger boost
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueCheckHealth(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.CheckHealth,
        {},
        'check-health',
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueCompactDatabase(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.CompactDatabase,
        {},
        'compact-database',
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueCleanupTempFiles(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.CleanupTempFiles,
        {},
        'cleanup-temp-files',
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}

export function queueUpdateLibraryMetadata(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.UpdateLibraryMetadata,
        {},
        'update-library-metadata',
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}
export function queueConfigPrune(options: { trigger?: number } = {}) {
    return CommandQueueManager.push(
        CommandNames.ConfigPrune,
        {},
        'config-prune',
        0,
        options.trigger ?? CommandTrigger.Manual,
    );
}
