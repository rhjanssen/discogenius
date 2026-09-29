import { createHash } from "node:crypto";
import { withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import type { ScanResult } from "../mediafiles/library-scan.js";
import type { CommandModelOf } from "./command-model.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { CommandContinuation } from "./command-continuation.js";

const counters = ["artists", "orphansRemoved", "filesIndexed", "filesUpdated", "downloadFlagsReset", "unmappedOrphans"] as const;

/** Reconciliation is idempotent within an artist. Settle its counts before
 * releasing admission; root discovery is deliberately a separate legacy path. */
export async function runScanWorkUnit(
    job: CommandModelOf<"RescanFolders">,
    resolveIds: () => string[],
    scanArtist: (id: string, cursor: number, total: number) => Promise<ScanResult>,
    cleanup: (() => Promise<number>) | null,
): Promise<ScanResult> {
    const owner = job.worker_id;
    if (!owner || !CommandQueueManager.isExecutionOwner(job.id, owner)) throw new Error("Scan execution ownership changed");
    const configRevision = createHash("sha256").update(JSON.stringify({
        path: getConfigSection("path"), metadata: getConfigSection("metadata"), filtering: getConfigSection("filtering"),
    })).digest("hex");
    let plan = job.payload.scanWork;
    const persist = async () => withSqliteWriteGate(() => {
        if (!CommandQueueManager.updateState(job.id, { workerId: owner, payloadPatch: { scanWork: plan } })) {
            throw new Error("Scan execution ownership changed");
        }
    }, "scan:checkpoint");
    if (!plan) {
        plan = { version: 1, configRevision, artistIds: [...new Set(resolveIds())], cursor: 0,
            result: { artists: 0, orphansRemoved: 0, filesIndexed: 0, filesUpdated: 0, downloadFlagsReset: 0, unmappedOrphans: 0 },
            cleanupDone: false };
        await persist();
    }
    if (plan.version !== 1 || !Array.isArray(plan.artistIds) || plan.artistIds.some(id => typeof id !== "string" || !id.trim())
        || new Set(plan.artistIds).size !== plan.artistIds.length
        || !Number.isSafeInteger(plan.cursor) || plan.cursor < 0 || plan.cursor > plan.artistIds.length
        || typeof plan.cleanupDone !== "boolean" || !plan.result
        || counters.some(key => !Number.isSafeInteger(plan.result[key]) || plan.result[key] < 0)
        || plan.result.artists !== plan.cursor || (plan.cleanupDone && plan.cursor !== plan.artistIds.length)) {
        throw new Error("Invalid scan checkpoint");
    }
    if (plan.configRevision !== configRevision) throw new Error("Scan settings changed. Start a new scan with the current settings.");
    if (CommandQueueManager.get(job.id)?.payload.cancelRequested) throw new Error("Scan cancellation requested");
    if (plan.cursor < plan.artistIds.length) {
        const result = await scanArtist(plan.artistIds[plan.cursor], plan.cursor, plan.artistIds.length);
        if (result.artists !== 1 || counters.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)) {
            throw new Error("Invalid artist scan result");
        }
        for (const key of counters) plan.result[key] += result[key];
        plan.cursor++;
        await persist();
        if (plan.cursor < plan.artistIds.length || cleanup) throw new CommandContinuation({});
    }
    if (!plan.cleanupDone) {
        if (cleanup) plan.result.unmappedOrphans += await cleanup();
        plan.cleanupDone = true;
        await persist();
    }
    return plan.result;
}
