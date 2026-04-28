import { Config } from "./config.js";
import { DiskScanService, type ScanOptions, type ScanResult } from "./library-scan.js";
import { queueRescanFoldersPass } from "./task-scheduler.js";

export type RootScanSsePayload =
    | { type: "progress"; message: string }
    | { type: "complete"; result: ScanResult }
    | { type: "error"; message: string };

type QueueRootScanInput = {
    fullProcessing?: unknown;
    monitorArtist?: unknown;
    trigger?: number;
};

type RunImmediateRootScanInput = {
    monitorArtist?: unknown;
    sendEvent: (event: RootScanSsePayload) => void;
};

type RootScanRouteServiceDeps = {
    queueRootScanPass: (options: Parameters<typeof queueRescanFoldersPass>[0]) => number;
    scan: (options: ScanOptions) => Promise<ScanResult>;
    getDefaultMonitorNewArtists: () => boolean;
};

function coerceOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export function createRootScanRouteService(deps: RootScanRouteServiceDeps) {
    let immediateRootScanInProgress = false;

    return {
        queueRootScan(input: QueueRootScanInput = {}) {
            return deps.queueRootScanPass({
                trigger: input.trigger ?? 1,
                fullProcessing: input.fullProcessing === true,
                addNewArtists: true,
                monitorArtist: coerceOptionalBoolean(input.monitorArtist),
            });
        },

        async runImmediateRootScan(input: RunImmediateRootScanInput): Promise<void> {
            if (immediateRootScanInProgress) {
                input.sendEvent({
                    type: "error",
                    message: "A root folder scan is already running. Wait for it to finish before starting another.",
                });
                return;
            }

            immediateRootScanInProgress = true;

            try {
                const monitorArtist = coerceOptionalBoolean(input.monitorArtist)
                    ?? deps.getDefaultMonitorNewArtists();

                const result = await deps.scan({
                    addNewArtists: true,
                    monitorNewArtists: monitorArtist,
                    onProgress: (event) => {
                        input.sendEvent({ type: "progress", message: event.message });
                    },
                });

                input.sendEvent({ type: "complete", result });
            } catch (error) {
                input.sendEvent({ type: "error", message: toErrorMessage(error) });
            } finally {
                immediateRootScanInProgress = false;
            }
        },
    };
}

export const rootScanRouteService = createRootScanRouteService({
    queueRootScanPass: queueRescanFoldersPass,
    scan: (options) => DiskScanService.scan(options),
    getDefaultMonitorNewArtists: () => Config.getMonitoringConfig().monitor_new_artists,
});
