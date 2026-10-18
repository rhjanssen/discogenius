import { db } from "../../database.js";
import { parseSqliteDate } from "./command-ordering.js";
import { DOWNLOAD_COMMAND_NAMES } from "./command-names.js";
import { readIntEnv } from "../../utils/env.js";

const DOWNLOAD_COMMAND_PLACEHOLDERS = DOWNLOAD_COMMAND_NAMES.map(() => "?").join(",");

/** A completed download that nobody is importing. The admission watchdog and
 * /health both use this. It is not a per-tick write. */
export function importAdmissionStallMs(): number {
    return readIntEnv("DISCOGENIUS_IMPORT_ADMISSION_STALL_MS", 5 * 60_000, 1_000);
}

export type ImportPendingHandoff = {
    id: number;
    name: string;
    status: string;
    workerId: string | null;
    attempt: number;
    leaseExpiresAt: string | null;
    readyAt: string | null;
    startedAt: string | null;
    createdAt: string | null;
    executionStartedAt: string | null;
    hasImportPayload: boolean;
};

/**
 * One indexed read of queued and started download commands whose payload says
 * importPending. `idx_commands_status_name_started` is (status, name, started_at).
 * The json filters run only on that small set (active downloads plus the few
 * Download* rows the wait queue has claimed), not on the commands table.
 */
export function listImportPendingHandoffs(): ImportPendingHandoff[] {
    const rows = db.prepare(`
        SELECT id, name, status, worker_id, attempt, lease_expires_at, started_at, created_at,
               json_extract(payload, '$.downloadImportHandoff.readyAt') AS ready_at,
               json_extract(payload, '$.downloadImportHandoff.executionStartedAt') AS execution_started_at,
               CASE
                 WHEN json_extract(payload, '$.downloadImportHandoff.importPayload') IS NOT NULL THEN 1
                 ELSE 0
               END AS has_import_payload
        FROM commands INDEXED BY idx_commands_status_name_started
        WHERE status IN ('queued', 'started')
          AND name IN (${DOWNLOAD_COMMAND_PLACEHOLDERS})
          AND json_valid(payload)
          AND json_extract(payload, '$.downloadState.state') = 'importPending'
        ORDER BY id ASC
    `).all(...DOWNLOAD_COMMAND_NAMES) as Array<{
        id: number;
        name: string;
        status: string;
        worker_id: string | null;
        attempt: number;
        lease_expires_at: string | null;
        started_at: string | null;
        created_at: string | null;
        ready_at: string | null;
        execution_started_at: string | null;
        has_import_payload: number;
    }>;
    return rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        status: row.status,
        workerId: row.worker_id,
        attempt: Number(row.attempt) || 0,
        leaseExpiresAt: row.lease_expires_at,
        readyAt: row.ready_at,
        startedAt: row.started_at,
        createdAt: row.created_at,
        executionStartedAt: row.execution_started_at,
        hasImportPayload: row.has_import_payload === 1,
    }));
}

export function importHandoffWaitingSinceMs(row: ImportPendingHandoff): number | null {
    const parsed = parseSqliteDate(row.readyAt || row.startedAt || row.createdAt);
    return parsed > 0 ? parsed : null;
}

function importExecutionIsActive(): boolean {
    return Boolean(db.prepare(`
        SELECT 1
        FROM commands INDEXED BY idx_commands_status_name_started
        WHERE status = 'started'
          AND name IN (${DOWNLOAD_COMMAND_PLACEHOLDERS})
          AND json_valid(payload)
          AND (
            json_extract(payload, '$.downloadState.state') = 'importing'
            OR json_extract(payload, '$.downloadImportHandoff.executionStartedAt') IS NOT NULL
          )
        LIMIT 1
    `).get(...DOWNLOAD_COMMAND_NAMES));
}

/** Completed downloads that have waited longer than the stall threshold while
 * no import is running or has passed the execution marker. */
export function listStrandedImportHandoffs(now: Date = new Date(), stallMs = importAdmissionStallMs()): ImportPendingHandoff[] {
    if (importExecutionIsActive()) return [];
    const cutoff = now.getTime() - stallMs;
    return listImportPendingHandoffs().filter((row) => {
        if (row.executionStartedAt || !row.hasImportPayload) return false;
        const waitingSince = importHandoffWaitingSinceMs(row);
        return waitingSince != null && waitingSince <= cutoff;
    });
}

/** Manual disk work gets first admission, but cannot indefinitely overtake
 * bytes that already finished downloading. Running work is never preempted. */
export function hasAgedImportHandoff(): boolean {
    return Boolean(db.prepare(`
        SELECT 1 FROM commands
        WHERE status = 'started' AND worker_id IS NOT NULL
          AND name IN (${DOWNLOAD_COMMAND_NAMES.map(() => '?').join(',')})
          AND json_valid(payload)
          AND json_extract(payload, '$.downloadState.state') = 'importPending'
          AND julianday(COALESCE(json_extract(payload, '$.downloadImportHandoff.readyAt'), started_at, created_at))
              <= julianday('now', '-1 minute')
        LIMIT 1
    `).get(...DOWNLOAD_COMMAND_NAMES));
}

/** Any finished download waiting for its import slot, regardless of age.
 * Long-running file batches use this to hand the disk over promptly instead of
 * holding it for a fixed slice or re-queuing on a fixed small budget. */
export function hasPendingImportHandoff(): boolean {
    return Boolean(db.prepare(`
        SELECT 1 FROM commands
        WHERE status = 'started' AND worker_id IS NOT NULL
          AND name IN (${DOWNLOAD_COMMAND_NAMES.map(() => '?').join(',')})
          AND json_valid(payload)
          AND json_extract(payload, '$.downloadState.state') = 'importPending'
        LIMIT 1
    `).get(...DOWNLOAD_COMMAND_NAMES));
}
