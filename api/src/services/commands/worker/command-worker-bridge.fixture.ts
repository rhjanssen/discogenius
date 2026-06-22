import { parentPort } from "node:worker_threads";

import { forwardCacheInvalidate, forwardEventToMain, forwardImportProgress, isCommandWorker } from "./command-worker-protocol.js";

/**
 * Test fixture worker for command-worker-bridge.test.ts. Not a *.test.ts file, so the test
 * runner won't execute it directly. It exercises the protocol bridge primitives
 * from inside a real worker thread spawned with the command-worker marker.
 */

if (!parentPort) {
    throw new Error("command-worker-bridge.fixture loaded outside a worker thread");
}

const port = parentPort;

port.on("message", (message: { kind: string; job?: { id: number } }) => {
    if (message.kind !== "run" || !message.job) return;

    // Report whether the marker-based detection works inside the worker.
    port.postMessage({ kind: "probe", isCommandWorker: isCommandWorker() });

    // These forward through parentPort because we're a marked command worker.
    forwardEventToMain("command.updated", { id: message.job.id, status: "started" });
    forwardCacheInvalidate("album", "A1");
    forwardCacheInvalidate("all");
    forwardImportProgress(message.job.id, { progress: 50, state: "importing" });

    port.postMessage({ kind: "done", commandId: message.job.id });
});
