import assert from "node:assert/strict";
import test from "node:test";
import { createRootScanRouteService, type RootScanSsePayload } from "./root-scan-route-service.js";
import type { ScanOptions, ScanResult } from "./library-scan.js";

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });

    return { promise, resolve, reject };
}

test("root scan route service queues root scans with route-compatible defaults", () => {
    let queuedOptions: Record<string, unknown> | undefined;
    const service = createRootScanRouteService({
        queueRootScanPass: (options) => {
            queuedOptions = options as Record<string, unknown>;
            return 42;
        },
        scan: async () => {
            throw new Error("scan should not run while queueing");
        },
        getDefaultMonitorNewArtists: () => false,
    });

    const jobId = service.queueRootScan({
        fullProcessing: true,
        monitorArtist: "not-a-boolean",
    });

    assert.equal(jobId, 42);
    assert.deepEqual(queuedOptions, {
        trigger: 1,
        fullProcessing: true,
        monitorArtist: undefined,
    });
});

test("root scan route service streams progress and completion using the monitoring config default", async () => {
    const events: RootScanSsePayload[] = [];
    let receivedOptions: ScanOptions | undefined;
    const result: ScanResult = {
        artists: 3,
        orphansRemoved: 1,
        filesIndexed: 2,
        filesUpdated: 4,
        downloadFlagsReset: 0,
        unmappedOrphans: 5,
    };
    const service = createRootScanRouteService({
        queueRootScanPass: () => {
            throw new Error("queue should not run during immediate scan");
        },
        scan: async (options) => {
            receivedOptions = options;
            options.onProgress?.({
                phase: "discovery",
                message: "Discovering new artist folders",
                progress: 70,
            });
            return result;
        },
        getDefaultMonitorNewArtists: () => false,
    });

    await service.runImmediateRootScan({
        monitorArtist: undefined,
        sendEvent: (event) => {
            events.push(event);
        },
    });

    assert.equal(receivedOptions?.addNewArtists, true);
    assert.equal(receivedOptions?.monitorNewArtists, false);
    assert.equal(typeof receivedOptions?.onProgress, "function");
    assert.deepEqual(events, [
        { type: "progress", message: "Discovering new artist folders" },
        { type: "complete", result },
    ]);
});

test("root scan route service rejects concurrent immediate scans and releases the lock after completion", async () => {
    const firstScan = createDeferred<ScanResult>();
    const firstEvents: RootScanSsePayload[] = [];
    const secondEvents: RootScanSsePayload[] = [];
    let scanCalls = 0;

    const service = createRootScanRouteService({
        queueRootScanPass: () => {
            throw new Error("queue should not run during immediate scan");
        },
        scan: async () => {
            scanCalls += 1;
            return firstScan.promise;
        },
        getDefaultMonitorNewArtists: () => true,
    });

    const firstRun = service.runImmediateRootScan({
        monitorArtist: true,
        sendEvent: (event) => {
            firstEvents.push(event);
        },
    });

    await Promise.resolve();

    await service.runImmediateRootScan({
        monitorArtist: true,
        sendEvent: (event) => {
            secondEvents.push(event);
        },
    });

    assert.equal(scanCalls, 1);
    assert.deepEqual(secondEvents, [
        {
            type: "error",
            message: "A root folder scan is already running. Wait for it to finish before starting another.",
        },
    ]);

    firstScan.resolve({
        artists: 0,
        orphansRemoved: 0,
        filesIndexed: 0,
        filesUpdated: 0,
        downloadFlagsReset: 0,
        unmappedOrphans: 0,
    });
    await firstRun;

    assert.deepEqual(firstEvents, [
        {
            type: "complete",
            result: {
                artists: 0,
                orphansRemoved: 0,
                filesIndexed: 0,
                filesUpdated: 0,
                downloadFlagsReset: 0,
                unmappedOrphans: 0,
            },
        },
    ]);

    await service.runImmediateRootScan({
        monitorArtist: true,
        sendEvent: (event) => {
            firstEvents.push(event);
        },
    });

    assert.equal(scanCalls, 2);
});