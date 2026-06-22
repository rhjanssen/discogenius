import { CommandTrigger } from "../commands/command-trigger.js";
import { appEvents, AppEvent, type ArtistScannedEventPayload, type RescanCompletedEventPayload } from "../commands/app-events.js";
import { CommandNames, CommandQueueService } from "../commands/command-queue.js";
import {
    type ArtistWorkflow,
    buildCurateArtistCommand,
    buildRescanFoldersCommand,
    isArtistWorkflow,
} from "./artist-workflow.js";

function resolveRescanWorkflow(workflow: unknown): Extract<ArtistWorkflow, "refresh-scan" | "library-scan" | "monitoring-intake" | "full-monitoring"> | null {
    if (!isArtistWorkflow(workflow)) {
        return null;
    }

    switch (workflow) {
        case "refresh-scan":
        case "library-scan":
        case "monitoring-intake":
        case "full-monitoring":
            return workflow;
        default:
            return null;
    }
}

function resolveCurationWorkflow(workflow: unknown): Extract<ArtistWorkflow, "curation" | "monitoring-intake" | "full-monitoring"> | null {
    if (!isArtistWorkflow(workflow)) {
        return null;
    }

    switch (workflow) {
        case "curation":
        case "monitoring-intake":
        case "full-monitoring":
            return workflow;
        default:
            return null;
    }
}

export function initCurationListeners() {
    console.log("[Listeners] Initializing curation event listeners");

    // Trigger disk scan after metadata refresh is complete
    appEvents.on(AppEvent.ARTIST_SCANNED, (payload: ArtistScannedEventPayload | undefined) => {
        if (payload?.scanLibrary) {
            const workflow = resolveRescanWorkflow(payload?.workflow);
            if (!workflow) {
                console.warn(`[Listeners] Artist ${payload?.artistId ?? "unknown"} metadata refreshed without a rescan workflow; skipping RescanFolders`);
                return;
            }

            console.log(`[Listeners] Artist ${payload.artistId} metadata refreshed, queueing RescanFolders`);
            CommandQueueService.addJob(
                CommandNames.RescanFolders,
                buildRescanFoldersCommand({
                    artistId: payload.artistId,
                    artistName: payload.artistName,
                    workflow,
                    monitoringCycle: payload.monitoringCycle,
                }),
                payload.artistId,
                0,
                payload.trigger ?? CommandTrigger.Unspecified
            );
        }
    });

    // Trigger missing search/curation after disk scan is complete
    appEvents.on(AppEvent.RESCAN_COMPLETED, (payload: RescanCompletedEventPayload | undefined) => {
        if (!payload) {
            return;
        }

        if (payload?.skipCuration) {
            console.log(`[Listeners] Artist ${payload.artistId} disk scan completed, skipping CurateArtist`);
            return;
        }

        console.log(`[Listeners] Artist ${payload.artistId} disk scan completed, queuing CurateArtist`);
        const workflow = resolveCurationWorkflow(payload.workflow);
        CommandQueueService.addJob(
            CommandNames.CurateArtist,
            workflow
                ? buildCurateArtistCommand({
                    artistId: payload.artistId,
                    artistName: payload.artistName,
                    workflow,
                    monitoringCycle: payload.monitoringCycle,
                })
                : {
                    artistId: payload.artistId,
                    artistName: payload.artistName,
                    monitoringCycle: payload.monitoringCycle,
                    skipDownloadQueue: payload.skipDownloadQueue ?? false,
                    forceDownloadQueue: payload.forceDownloadQueue ?? false,
                },
            payload.artistId,
            0,
            payload.trigger ?? CommandTrigger.Unspecified
        );
    });

    // You can add more decoupled listeners here, e.g. for ALBUM_SCANNED
}
