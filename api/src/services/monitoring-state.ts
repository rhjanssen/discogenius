import { db } from "../database.js";
import type { MonitoringConfig as ConfigMonitoringConfig } from "./config.js";
import { getManagedArtists } from "./managed-artists.js";
import { ARTIST_WORKFLOW_JOB_TYPES, JobTypes } from "./queue.js";

export interface MonitoringProgress {
    lastCheckTimestamp: string | null;
    checkInProgress: boolean;
    progressArtistIndex: number;
}

export type MonitoringConfig = ConfigMonitoringConfig & MonitoringProgress;

interface MonitoringStateRow {
    state_key: string;
    last_check_timestamp?: string | null;
    check_in_progress: number;
    progress_artist_index: number;
}

let monitoringProgress: MonitoringProgress = {
    lastCheckTimestamp: null,
    checkInProgress: false,
    progressArtistIndex: 0,
};

let pendingArtistJobsStmt: any | null = null;
let warnedJobQueueMissing = false;
let activeLibraryRescanStmt: any | null = null;
let activeHousekeepingStmt: any | null = null;
let monitoringStateGetStmt: any | null = null;
let monitoringStateUpsertStmt: any | null = null;
let monitoringProgressLoaded = false;

function getPendingArtistJobsStmt() {
    if (!pendingArtistJobsStmt) {
        pendingArtistJobsStmt = db.prepare(`
      SELECT DISTINCT ref_id as artist_id
      FROM job_queue
      WHERE ref_id IS NOT NULL
        AND type IN (${ARTIST_WORKFLOW_JOB_TYPES.map(() => "?").join(", ")})
        AND status IN ('pending', 'processing')
    `);
    }

    return pendingArtistJobsStmt;
}

function getActiveLibraryRescanStmt() {
    if (!activeLibraryRescanStmt) {
        activeLibraryRescanStmt = db.prepare(`
      SELECT 1
      FROM job_queue
      WHERE type = 'RescanFolders'
        AND json_extract(payload, '$.addNewArtists') = 1
        AND status IN ('pending', 'processing')
      LIMIT 1
    `);
    }

    return activeLibraryRescanStmt;
}

function getActiveHousekeepingStmt() {
    if (!activeHousekeepingStmt) {
        activeHousekeepingStmt = db.prepare(`
      SELECT 1
      FROM job_queue
      WHERE type = 'Housekeeping'
        AND status IN ('pending', 'processing')
      LIMIT 1
    `);
    }

    return activeHousekeepingStmt;
}

function getMonitoringStateGetStmt() {
    if (!monitoringStateGetStmt) {
        monitoringStateGetStmt = db.prepare(`
      SELECT state_key, last_check_timestamp, check_in_progress, progress_artist_index
      FROM monitoring_runtime_state
      WHERE state_key = ?
    `);
    }

    return monitoringStateGetStmt;
}

function getMonitoringStateUpsertStmt() {
    if (!monitoringStateUpsertStmt) {
        monitoringStateUpsertStmt = db.prepare(`
      INSERT INTO monitoring_runtime_state (
        state_key,
        last_check_timestamp,
        check_in_progress,
        progress_artist_index,
        updated_at
      )
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(state_key) DO UPDATE SET
        last_check_timestamp = excluded.last_check_timestamp,
        check_in_progress = excluded.check_in_progress,
        progress_artist_index = excluded.progress_artist_index,
        updated_at = CURRENT_TIMESTAMP
    `);
    }

    return monitoringStateUpsertStmt;
}

export function hasActiveTask(taskName: string): boolean {
    const row = db.prepare(`
    SELECT 1
    FROM job_queue
    WHERE type = ?
      AND status IN ('pending', 'processing')
    LIMIT 1
  `).get(taskName);

    return Boolean(row);
}

export function hasActiveHousekeepingTask(): boolean {
    return Boolean(getActiveHousekeepingStmt().get());
}

export function loadMonitoringProgress(): MonitoringProgress {
    if (monitoringProgressLoaded) {
        return monitoringProgress;
    }

    const row = getMonitoringStateGetStmt().get("monitoring") as MonitoringStateRow | undefined;

    if (row) {
        monitoringProgress = {
            lastCheckTimestamp: row.last_check_timestamp ?? null,
            checkInProgress: Boolean(row.check_in_progress),
            progressArtistIndex: Math.max(0, Number(row.progress_artist_index ?? 0) || 0),
        };
    }

    monitoringProgressLoaded = true;
    return monitoringProgress;
}

function persistMonitoringProgress() {
    loadMonitoringProgress();

    getMonitoringStateUpsertStmt().run(
        "monitoring",
        monitoringProgress.lastCheckTimestamp,
        monitoringProgress.checkInProgress ? 1 : 0,
        monitoringProgress.progressArtistIndex,
    );
}

export function saveMonitoringProgress(artistIndex: number, checkInProgress: boolean) {
    const current = loadMonitoringProgress();
    monitoringProgress = {
        progressArtistIndex: artistIndex,
        checkInProgress,
        lastCheckTimestamp: checkInProgress ? new Date().toISOString() : current.lastCheckTimestamp,
    };
    persistMonitoringProgress();
}

export function getArtistsWithPendingJobs(): Set<string> {
    try {
        const rows = getPendingArtistJobsStmt().all(...ARTIST_WORKFLOW_JOB_TYPES) as Array<{ artist_id: string | number | null }>;
        const pending = new Set(rows.filter((row) => row.artist_id !== null).map((row) => String(row.artist_id)));

        const libraryRescanActive = Boolean(getActiveLibraryRescanStmt().get());
        if (libraryRescanActive) {
            for (const artist of getManagedArtists()) {
                pending.add(String(artist.id));
            }
        }

        return pending;
    } catch (_error) {
        if (!warnedJobQueueMissing) {
            warnedJobQueueMissing = true;
            console.warn("[Monitoring] job_queue not ready yet; skipping pending-jobs check");
        }

        return new Set();
    }
}

export function hasActiveArtistWorkflow(): boolean {
    return (
        hasActiveTask(JobTypes.RefreshMetadata) ||
        Boolean(getActiveLibraryRescanStmt().get()) ||
        hasActiveTask(JobTypes.ApplyCuration) ||
        hasActiveTask(JobTypes.DownloadMissing) ||
        getArtistsWithPendingJobs().size > 0
    );
}

export function getEffectiveMonitoringRuntimeState(
    configFromFile: ConfigMonitoringConfig,
    options: { isChecking: boolean },
): MonitoringProgress {
    loadMonitoringProgress();

    const workflowActive = options.isChecking || hasActiveArtistWorkflow();
    const persistedInProgress = monitoringProgress.checkInProgress;

    if (persistedInProgress && !workflowActive) {
        monitoringProgress = {
            ...monitoringProgress,
            checkInProgress: false,
            progressArtistIndex: 0,
        };
        persistMonitoringProgress();
    }

    return {
        lastCheckTimestamp: monitoringProgress.lastCheckTimestamp ?? configFromFile.last_check ?? null,
        checkInProgress: workflowActive || monitoringProgress.checkInProgress,
        progressArtistIndex: workflowActive ? monitoringProgress.progressArtistIndex : 0,
    };
}
