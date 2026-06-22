import { parentPort } from "node:worker_threads";

import {CommandNames} from "../command-names.js";
import {type CommandModelOf} from "../command-queue-manager.js";
import { commandHandlers } from "../handlers/index.js";
import type { CommandHandler } from "../handlers/index.js";
import { buildHandlerContext } from "../command-context.js";
import { DownloadedTracksImportService } from "../../mediafiles/downloaded-tracks-import-service.js";
import { forwardImportProgress, isCommandWorker, type MainToWorkerMessage, type WorkerToMainMessage } from "./command-worker-protocol.js";

/**
 * Job worker thread entrypoint — the off-thread analogue of one of Lidarr's
 * `CommandExecutor` threads. It opens its *own* better-sqlite3 connection (a
 * fresh module instance per thread; WAL allows concurrent readers + one writer)
 * and runs a single command handler at a time.
 *
 * The main thread owns the queue/exclusivity/slot logic and the command's
 * state transitions (start/complete/fail); this worker only *executes the
 * handler*. Progress emits and follow-up enqueues the handler performs go
 * through `appEvents` / `download-state`, which the protocol bridge forwards
 * back to the main thread (see command-worker-protocol.ts). We never call initDatabase()
 * here — migrations stay a main-thread, single-writer concern.
 */

if (!parentPort || !isCommandWorker()) {
    throw new Error("command-worker-entry loaded outside a Discogenius command worker thread");
}

const port = parentPort;

function post(message: WorkerToMainMessage): void {
    port.postMessage(message);
}

async function runJob(message: Extract<MainToWorkerMessage, { kind: "run" }>): Promise<void> {
    const job = message.job;
    try {
        if (job.name === CommandNames.ImportDownload) {
            // Imports aren't in the command-handler registry (the download
            // processor owns their orchestration); run the heavy import service
            // here and stream progress back via the bridge. The import service's
            // own appEvents (FILE_ADDED) + download-state cache invalidations are
            // already forwarded by the generic bridge.
            await DownloadedTracksImportService.process(
                job as CommandModelOf<typeof CommandNames.ImportDownload>,
                { updateState: (state) => forwardImportProgress(job.id, state) },
            );
        } else {
            const handler = commandHandlers[job.name];
            if (handler) {
                await (handler as CommandHandler)(job, buildHandlerContext());
            } else {
                console.warn(`[command-worker] picked up unhandled command: ${job.name}`);
            }
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
