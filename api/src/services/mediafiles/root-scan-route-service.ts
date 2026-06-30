import { CommandTrigger } from "../commands/command-trigger.js";
import { queueRescanFoldersPass } from "../commands/scheduler.js";

type QueueRootScanInput = {
    fullProcessing?: unknown;
    monitorArtist?: unknown;
    trigger?: number;
};

type RootScanRouteServiceDeps = {
    queueRootScanPass: (options: Parameters<typeof queueRescanFoldersPass>[0]) => number;
};

function coerceOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

export function createRootScanRouteService(deps: RootScanRouteServiceDeps) {
    return {
        queueRootScan(input: QueueRootScanInput = {}) {
            return deps.queueRootScanPass({
                trigger: input.trigger ?? CommandTrigger.Manual,
                fullProcessing: input.fullProcessing === true,
                addNewArtists: true,
                monitorArtist: coerceOptionalBoolean(input.monitorArtist),
            });
        },
    };
}

export const rootScanRouteService = createRootScanRouteService({
    queueRootScanPass: queueRescanFoldersPass,
});
