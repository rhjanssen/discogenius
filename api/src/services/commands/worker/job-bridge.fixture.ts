import { parentPort } from "node:worker_threads";

import { forwardCacheInvalidate, forwardEventToMain, forwardImportProgress, isJobWorker } from "./job-protocol.js";

/**
 * Test fixture worker for job-bridge.test.ts. Not a *.test.ts file, so the test
 * runner won't execute it directly. It exercises the protocol bridge primitives
 * from inside a real worker thread spawned with the job-worker marker.
 */

if (!parentPort) {
    throw new Error("job-bridge.fixture loaded outside a worker thread");
}

const port = parentPort;

port.on("message", (message: { kind: string; job?: { id: number } }) => {
    if (message.kind !== "run" || !message.job) return;

    // Report whether the marker-based detection works inside the worker.
    port.postMessage({ kind: "probe", isJobWorker: isJobWorker() });

    // These forward through parentPort because we're a marked job worker.
    forwardEventToMain("command.updated", { id: message.job.id, status: "started" });
    forwardCacheInvalidate("album", "A1");
    forwardCacheInvalidate("all");
    forwardImportProgress(message.job.id, { progress: 50, state: "importing" });

    port.postMessage({ kind: "done", jobId: message.job.id });
});
