import { parentPort } from "node:worker_threads";

import {CommandNames} from "../command-names.js";
import {type CommandModelOf} from "../command-queue-manager.js";
import { executeCommand } from "../command-context.js";
import { DownloadedTracksImportService } from "../../mediafiles/downloaded-tracks-import-service.js";
import { initCurationListeners } from "../../music/curation.listener.js";
import { forwardImportProgress, isCommandWorker, type MainToWorkerMessage, type WorkerToMainMessage } from "./command-worker-protocol.js";

/**
 * Command worker thread entrypoint — one of the pool's real OS threads, the
 * direct analogue of a Lidarr `CommandExecutor` thread. It opens its *own*
 * better-sqlite3 connection (a fresh module instance per thread; WAL allows
 * concurrent readers + one writer) and runs one command at a time.
 *
 * The worker owns the command's *full lifecycle* (markProcessing → handler →
 * complete/fail → next monitoring pass) on its own connection, so the only
 * command-table writes during a scan backlog happen off the main thread and
 * can't block the API's event loop on write-lock contention. The curation
 * chaining listeners run here too, so their follow-up enqueues are off-main as
 * well. The handler's `appEvents` / `download-state` effects ride the protocol
 * bridge back to the main thread (see command-worker-protocol.ts). We never call
 * initDatabase() here — schema setup stays a main-thread, single-writer concern.
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
    try {
        if (job.name === CommandNames.ImportDownload) {
            // Imports are owned by the download processor (it persists
            // complete/fail + emits download-progress SSE). Here we only run the
            // heavy import service and stream progress back via the bridge; its
            // appEvents (FILE_ADDED) + cache invalidations ride the generic bridge.
            await DownloadedTracksImportService.process(
                job as CommandModelOf<typeof CommandNames.ImportDownload>,
                { updateState: (state) => forwardImportProgress(job.id, state) },
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

post({ kind: "ready" });
