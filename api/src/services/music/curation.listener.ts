import { CommandTrigger } from "../commands/command-trigger.js";
import {
    appEvents,
    AppEvent,
    type ArtistCuratedEventPayload,
    type ArtistRefreshCompleteEventPayload,
    type ArtistScannedEventPayload,
} from "../commands/app-events.js";
import {CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import {
    type ArtistWorkflow,
    buildCurateArtistCommand,
    buildRescanFoldersCommand,
    isArtistWorkflow,
    nextArtistWorkflowPriority,
} from "./artist-workflow.js";
import { queueDownloadMissingPass } from "../commands/scheduler.js";

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
    appEvents.on(AppEvent.ARTIST_REFRESH_COMPLETE, (payload: ArtistRefreshCompleteEventPayload | undefined) => {
        if (
            payload?.commandId != null
            && payload.workerId
            && !CommandQueueManager.isExecutionOwner(payload.commandId, payload.workerId)
        ) {
            console.warn(`[Listeners] Ignoring stale refresh completion from command #${payload.commandId}`);
            return;
        }
        if (payload?.scanLibrary) {
            const workflow = resolveRescanWorkflow(payload?.workflow);
            if (!workflow) {
                console.warn(`[Listeners] Artist ${payload?.artistId ?? "unknown"} metadata refreshed without a rescan workflow; skipping RescanFolders`);
                return;
            }

            console.log(`[Listeners] Artist ${payload.artistId} metadata refreshed, queueing RescanFolders`);
            CommandQueueManager.push(
                CommandNames.RescanFolders,
                buildRescanFoldersCommand({
                    artistId: payload.artistId,
                    artistName: payload.artistName,
                    workflow,
                    monitoringCycle: payload.monitoringCycle,
                    filter: payload.metadataChanged || payload.isNewArtist ? "matched" : "known",
                }),
                payload.artistId,
                nextArtistWorkflowPriority(payload.priority),
                payload.trigger ?? CommandTrigger.Unspecified
            );
        }
    });

    // Trigger missing search/curation after disk scan is complete
    appEvents.on(AppEvent.ARTIST_SCANNED, (payload: ArtistScannedEventPayload | undefined) => {
        if (!payload) {
            return;
        }
        if (
            payload.commandId != null
            && payload.workerId
            && !CommandQueueManager.isExecutionOwner(payload.commandId, payload.workerId)
        ) {
            console.warn(`[Listeners] Ignoring stale scan completion from command #${payload.commandId}`);
            return;
        }

        if (payload?.skipCuration) {
            console.log(`[Listeners] Artist ${payload.artistId} disk scan completed, skipping CurateArtist`);
            return;
        }

        console.log(`[Listeners] Artist ${payload.artistId} disk scan completed, queuing CurateArtist`);
        const workflow = resolveCurationWorkflow(payload.workflow);
        CommandQueueManager.push(
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
                },
            payload.artistId,
            nextArtistWorkflowPriority(payload.priority),
            payload.trigger ?? CommandTrigger.Unspecified
        );
    });

    // Monitored artist intake is a scoped workflow, so its completion queues a
    // scoped wanted check. Full monitoring has one app-wide terminal pass in the
    // scheduler and must not fan out duplicate per-artist DownloadMissing jobs.
    appEvents.on(AppEvent.ARTIST_CURATED, (payload: ArtistCuratedEventPayload | undefined) => {
        if (!payload || payload.workflow !== "monitoring-intake") return;
        if (
            payload.commandId != null
            && payload.workerId
            && !CommandQueueManager.isExecutionOwner(payload.commandId, payload.workerId)
        ) {
            console.warn(`[Listeners] Ignoring stale curation completion from command #${payload.commandId}`);
            return;
        }

        queueDownloadMissingPass({
            artistIds: [String(payload.artistId)],
            trigger: payload.trigger ?? CommandTrigger.Unspecified,
            priority: nextArtistWorkflowPriority(payload.priority),
        });
    });

    // You can add more decoupled listeners here, e.g. for AlbumImported.
}
