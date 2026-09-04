import { parentPort } from "node:worker_threads";

import {CommandNames} from "../command-names.js";
import {CommandQueueManager, type CommandModelOf} from "../command-queue-manager.js";
import { executeCommand } from "../command-context.js";
import {
    DownloadedTracksImportService,
    isImportDownloadCancellationRequested,
} from "../../mediafiles/downloaded-tracks-import-service.js";
import { clearConfigCache } from "../../config/config.js";
import { catalogProviderRegistry } from "../../catalog/index.js";
import { withSqliteWriteGate } from "../../../database.js";
import { initCurationListeners } from "../../music/curation.listener.js";
import {
    forwardImportProgress,
    getCommandWorkerId,
    isCommandWorker,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
} from "./command-worker-protocol.js";

/**
 * Command worker thread entrypoint — one of the pool's real OS threads.
 * It opens its *own* better-sqlite3 connection (a fresh module instance per
 * thread; WAL allows concurrent readers + one writer) and runs one command at
 * a time.
 *
 * The main executor atomically claims an attempt, then this worker owns its
 * heartbeat, handler, ownership-guarded outcome, and monitoring handoff on its
 * own connection. Heavy command-table/domain writes therefore remain off the
 * API event loop. The curation chaining listeners run here too, so their
 * follow-up enqueues are off-main as well. The handler's `appEvents` /
 * `download-state` effects ride the protocol bridge back to the main thread.
 * We never call initDatabase() here — schema setup stays a main-thread,
 * single-writer concern.
 */

if (!parentPort || !isCommandWorker()) {
    throw new Error("command-worker-entry loaded outside a Discogenius command worker thread");
}

const port = parentPort;

// Chain RefreshArtist → RescanFolders → CurateArtist from inside the worker, so
// the listener's addJob enqueues run on this worker's connection (off-main).
initCurationListeners();

function post(message: WorkerToMainMessage): void {
    port.postMessage(message);
}

async function runJob(message: Extract<MainToWorkerMessage, { kind: "run" }>): Promise<void> {
    const job = message.job;
    const leaseMs = Math.max(1_000, message.leaseMs ?? 60_000);
    const physicalWorkerId = getCommandWorkerId();

    if (job.worker_id) {
        post({
            kind: "heartbeat",
            commandId: job.id,
            workerId: job.worker_id,
            physicalWorkerId,
            renewed: true,
            sentAt: new Date().toISOString(),
        });
    }

    // Settings are written on the main thread. Workers keep a process-local
    // config cache *and* a catalog-provider registry, so without a refresh they
    // keep boot-time defaults (Servarr catalog, include_videos=false, old
    // naming templates) forever. Catalog source lives on the registry, not in
    // the config cache — clearing the cache alone is not enough.
    clearConfigCache();
    catalogProviderRegistry.refreshFromConfig();
    try {
        if (job.name === CommandNames.ImportDownload) {
            // Imports are owned by the download processor (it persists
            // complete/fail + emits download-progress SSE). Here we only run the
            // heavy import service and stream progress back via the bridge; its
            // appEvents (FILE_ADDED) + cache invalidations ride the generic bridge.
            await DownloadedTracksImportService.process(
                job as CommandModelOf<typeof CommandNames.ImportDownload>,
                {
                    updateState: (state) => forwardImportProgress(job.id, state),
                    isCancelled: () => isImportDownloadCancellationRequested(job.id),
                },
            );
        } else {
            // Regular command: run the full lifecycle on this worker's
            // connection. executeCommand persists complete/fail itself and never
            // throws, so reaching here always means the lifecycle ran.
            await executeCommand(job);
        }
        post({ kind: "done", commandId: job.id });
    } catch (error: any) {
        post({ kind: "error", commandId: job.id, message: error?.message || "Unknown command worker error" });
    }
}

port.on("message", (message: MainToWorkerMessage) => {
    switch (message.kind) {
        case "run":
            // Errors are reported back via the "error" message inside runJob;
            // the catch here only guards against synchronous dispatch faults.
            void runJob(message).catch((error: any) => {
                post({ kind: "error", commandId: message.job.id, message: error?.message || "Unknown command worker error" });
            });
            break;
        case "shutdown":
            port.close();
            break;
    }
});

post({ kind: "ready", physicalWorkerId: getCommandWorkerId() });
