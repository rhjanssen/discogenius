import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { forwardCacheInvalidate, forwardEventToMain, isJobWorker, JOB_WORKER_MARKER } from "./job-protocol.js";

interface CollectedMessage {
    kind: string;
    [key: string]: unknown;
}

test("bridge forwarders are inert on the main thread", () => {
    assert.equal(isJobWorker(), false, "main thread is not a job worker");
    // No parentPort on the main thread — these must be safe no-ops, not throws.
    assert.doesNotThrow(() => forwardEventToMain("command.updated", { id: 1 }));
    assert.doesNotThrow(() => forwardCacheInvalidate("all"));
});

test("job bridge forwards events + cache invalidations across the thread boundary", async () => {
    // Spawn through the same bootstrap the pool uses in dev/tests: a plain-JS
    // shim that registers tsx inside the worker, then imports the .ts fixture
    // (whose .js-suffixed imports would otherwise not resolve in the worker).
    const bootstrapUrl = new URL("./job-worker-bootstrap.mjs", import.meta.url);
    const fixtureUrl = new URL("./job-bridge.fixture.ts", import.meta.url);
    const worker = new Worker(bootstrapUrl, {
        workerData: { [JOB_WORKER_MARKER]: true, __entry: fixtureUrl.href },
    });

    const messages: CollectedMessage[] = [];
    const finished = new Promise<void>((resolve, reject) => {
        worker.on("message", (message: CollectedMessage) => {
            messages.push(message);
            if (message.kind === "done") resolve();
        });
        worker.on("error", reject);
    });

    worker.postMessage({ kind: "run", job: { id: 42, name: "RefreshArtist", payload: {} } });
    await finished;
    await worker.terminate();

    // The workerData marker makes isJobWorker() true inside a spawned job worker.
    const probe = messages.find((m) => m.kind === "probe");
    assert.equal(probe?.isJobWorker, true, "isJobWorker() should be true inside the spawned worker");

    // appEvents emissions are bridged as {kind:'event', event, payload}.
    const event = messages.find((m) => m.kind === "event");
    assert.ok(event, "expected a forwarded event message");
    assert.equal(event.event, "command.updated");
    assert.deepEqual(event.payload, { id: 42, status: "started" });

    // download-state invalidations are bridged as {kind:'cacheInvalidate', target, key?}.
    const albumInvalidation = messages.find((m) => m.kind === "cacheInvalidate" && m.target === "album");
    assert.ok(albumInvalidation, "expected an album cache invalidation");
    assert.equal(albumInvalidation.key, "A1");
    assert.ok(
        messages.some((m) => m.kind === "cacheInvalidate" && m.target === "all"),
        "expected an all-cache invalidation",
    );

    // ImportDownload progress is bridged as {kind:'importProgress', jobId, state}.
    const importProgress = messages.find((m) => m.kind === "importProgress");
    assert.ok(importProgress, "expected a forwarded import progress message");
    assert.equal(importProgress.jobId, 42);
    assert.deepEqual(importProgress.state, { progress: 50, state: "importing" });
});
