import { db } from "../../database.js";
import type { MonitoringConfig as ConfigMonitoringConfig } from "../config/config.js";
import { getManagedArtists } from "../music/managed-artists.js";
import {ARTIST_WORKFLOW_COMMAND_NAMES, CommandNames} from "./command-names.js";

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
let activeArtistWorkflowStmt: any | null = null;
let warnedJobQueueMissing = false;
let activeLibraryRescanStmt: any | null = null;
let activeHousekeepingStmt: any | null = null;
let activeMonitoringCycleStmt: any | null = null;
let monitoringStateGetStmt: any | null = null;
let monitoringStateUpsertStmt: any | null = null;
let monitoringProgressLoaded = false;

function getPendingArtistJobsStmt() {
    if (!pendingArtistJobsStmt) {
        pendingArtistJobsStmt = db.prepare(`
      SELECT DISTINCT ref_id as artist_id
      FROM commands
      WHERE ref_id IS NOT NULL
        AND name IN (${ARTIST_WORKFLOW_COMMAND_NAMES.map(() => "?").join(", ")})
        AND status IN ('queued', 'started')
    `);
    }

    return pendingArtistJobsStmt;
}

function getActiveLibraryRescanStmt() {
    if (!activeLibraryRescanStmt) {
        activeLibraryRescanStmt = db.prepare(`
      SELECT 1
      FROM commands
      WHERE name = 'RescanFolders'
        AND json_extract(payload, '$.addNewArtists') = 1
        AND status IN ('queued', 'started')
      LIMIT 1
    `);
    }

    return activeLibraryRescanStmt;
}

function getActiveHousekeepingStmt() {
    if (!activeHousekeepingStmt) {
        activeHousekeepingStmt = db.prepare(`
      SELECT 1
      FROM commands
      WHERE name = 'Housekeeping'
        AND status IN ('queued', 'started')
      LIMIT 1
    `);
    }

    return activeHousekeepingStmt;
}

function getActiveMonitoringCycleStmt() {
        if (!activeMonitoringCycleStmt) {
                activeMonitoringCycleStmt = db.prepare(`
            SELECT 1
            FROM commands
            WHERE name IN (?, ?, ?, ?, ?)
                AND json_extract(payload, '$.monitoringCycle') IS NOT NULL
                AND status IN ('queued', 'started')
            LIMIT 1
        `);
        }

        return activeMonitoringCycleStmt;
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
    FROM commands
    WHERE name = ?
      AND status IN ('queued', 'started')
    LIMIT 1
  `).get(taskName);

    return Boolean(row);
}

export function hasActiveHousekeepingTask(): boolean {
    return Boolean(getActiveHousekeepingStmt().get());
}

function getActiveArtistWorkflowStmt() {
    if (!activeArtistWorkflowStmt) {
        activeArtistWorkflowStmt = db.prepare(`
            SELECT 1
            FROM commands
            WHERE name IN (${ARTIST_WORKFLOW_COMMAND_NAMES.map(() => "?").join(", ")})
              AND status IN ('queued', 'started')
            LIMIT 1
        `);
    }

    return activeArtistWorkflowStmt;
}

/**
 * True while any per-artist intake/refresh/curation work (RefreshArtist,
 * RescanFolders, CurateArtist — including the library-wide rescan, which is a
 * RescanFolders) is pending or processing.
 *
 * The terminal DownloadMissing pass queues from the monitored slots that this
 * work produces, so it must wait for the pipeline to drain. Unlike
 * hasActiveMonitoringCycleWorkflow(), this is NOT gated on the monitoringCycle
 * tag — artist *intake* (adding + monitoring an artist) runs the same job types
 * without that tag, and the terminal pass used to race it and queue nothing.
 */
export function hasActiveArtistWorkflowJobs(): boolean {
    return Boolean(getActiveArtistWorkflowStmt().get(...ARTIST_WORKFLOW_COMMAND_NAMES));
}

export function hasActiveMonitoringCycleWorkflow(): boolean {
    return Boolean(getActiveMonitoringCycleStmt().get(
        CommandNames.RefreshMetadata,
        CommandNames.RescanFolders,
        CommandNames.CurateArtist,
        CommandNames.ApplyCuration,
        CommandNames.DownloadMissing,
    ));
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
        const rows = getPendingArtistJobsStmt().all(...ARTIST_WORKFLOW_COMMAND_NAMES) as Array<{ artist_id: string | number | null }>;
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
            console.warn("[Monitoring] commands not ready yet; skipping pending-jobs check");
        }

        return new Set();
    }
}

export function hasActiveArtistWorkflow(): boolean {
    // Only block new monitoring cycles on the orchestrator jobs (RefreshMetadata, ApplyCuration).
    // Per-artist downstream work (RescanFolders, CurateArtist) can overlap with new cycles.
    // This prevents the death spiral where cycles >24h block the next cycle forever.
    return (
        hasActiveTask(CommandNames.RefreshMetadata) ||
        hasActiveTask(CommandNames.ApplyCuration)
    );
}

export function getEffectiveMonitoringRuntimeState(
    configFromFile: ConfigMonitoringConfig,
    options: { isChecking: boolean },
): MonitoringProgress {
    loadMonitoringProgress();

    const workflowActive = options.isChecking || hasActiveMonitoringCycleWorkflow();
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
