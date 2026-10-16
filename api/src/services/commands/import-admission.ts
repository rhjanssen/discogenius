import { db } from "../../database.js";
import { DOWNLOAD_COMMAND_NAMES } from "./command-names.js";

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
