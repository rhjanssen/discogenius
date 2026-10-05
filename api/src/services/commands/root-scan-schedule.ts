import { db } from "../../database.js";
import type { CommandModel } from "./command-model.js";
import { parseScheduledTaskTime } from "../config/schedule-policy.js";

const completionKey = "root_scan_last_completed_at";

/** Called inside the command-completion transaction. Scoped scans do not
 * satisfy the whole-library inventory schedule. History can then be pruned
 * without losing the completion timestamp. */
export function recordRootScanCompletion(job: CommandModel): void {
    if (job.name !== "RescanFolders" || job.status !== "completed" || !job.completed_at
        || job.payload.artistId || (job.payload.artistIds?.length ?? 0) > 0) return;
    db.prepare(`INSERT INTO runtime_controls(control_key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(control_key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`)
        .run(completionKey, job.completed_at);
}

export function rootScanScheduleAnchor(lastQueuedAt: string | null): string | null {
    const row = db.prepare("SELECT value FROM runtime_controls WHERE control_key=?")
        .get(completionKey) as { value: string } | undefined;
    const completed = parseScheduledTaskTime(row?.value ?? null);
    const queued = parseScheduledTaskTime(lastQueuedAt);
    return completed !== null && (queued === null || completed > queued) ? row!.value : lastQueuedAt;
}
