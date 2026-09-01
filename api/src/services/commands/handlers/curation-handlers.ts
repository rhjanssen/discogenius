import { CurationService } from "../../music/curation-service.js";
import { UpgraderService } from "../../mediafiles/upgrader.js";
import { getManagedArtists } from "../../music/managed-artists.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import { appEvents, AppEvent } from "../app-events.js";
import { CommandTrigger } from "../command-trigger.js";
import { CommandQueueManager } from "../command-queue-manager.js";
import type { CommandHandler } from "./handler-context.js";
import { clearAcquisitionPlanningRevision } from "../../music/acquisition-planning-control.js";

export const handleApplyCuration: CommandHandler<"ApplyCuration"> = async (job, ctx) => {
    const baseLabel = "Managed artists";
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: `${baseLabel} - preparing curation`,
    });

    const selectedCurationArtistIds = Array.isArray(job.payload.artistIds)
        ? job.payload.artistIds.map((id: any) => String(id))
        : undefined;
    const artists = getManagedArtists({ orderByLastScanned: true, artistIds: selectedCurationArtistIds });

    let curated = 0;
    let errors = 0;

    for (let i = 0; i < artists.length; i++) {
        const artist = artists[i];
        const artistId = String(artist.id);
        const artistName = String((artist as any).name || '').trim();

        const progress = Math.min(90, 10 + Math.round(((i + 1) / artists.length) * 80));
        ctx.updateCommandDescription(job, {
            progress,
            description: `${baseLabel} - curating ${artistName || 'artist'} (${i + 1}/${artists.length})`,
        });

        try {
            await CurationService.processAll(artistId);
            ArtistStatisticsService.refresh([artistId]);
            curated++;
            await ctx.yieldToEventLoop();
        } catch (error: any) {
            errors++;
            console.error(`[CommandExecutor] ApplyCuration: failed to curate ${artistName} (${artistId}):`, error?.message);
        }
    }

    // A scoped curation only rebuilt part of the library, so it must not clear
    // the global provider-priority revision. The next scheduled global pass
    // will still bring every other monitored edition up to date.
    if (errors === 0 && !selectedCurationArtistIds && job.payload.providerPriorityRevision) {
        clearAcquisitionPlanningRevision(job.payload.providerPriorityRevision);
    }

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Curated ${curated} artist(s)${errors > 0 ? `, ${errors} error(s)` : ''} (${artists.length} total)`,
    });
};

export const handleCheckUpgrades: CommandHandler<"CheckUpgrades"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 10,
        description: "Tracked files - comparing against quality profile cutoffs",
    });
    const result = await UpgraderService.checkUpgrades(true);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Queued ${result.details.length} upgrade candidate(s)`,
    });
};

export const handleCurateArtist: CommandHandler<"CurateArtist"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 10,
        description: ctx.formatArtistPhaseDescription(job, "applying release monitoring rules"),
    });
    // Curation only selects slots and acquisition plans. The workflow
    // orchestrator owns any later DownloadMissing command.
    await CurationService.processAll(job.payload.artistId);
    ctx.updateCommandDescription(job, {
        progress: 90,
        description: ctx.formatArtistPhaseDescription(job, "updating artist statistics"),
    });
    ArtistStatisticsService.refresh([job.payload.artistId]);

    if (job.worker_id && !CommandQueueManager.isExecutionOwner(job.id, job.worker_id)) {
        return;
    }
    appEvents.emit(AppEvent.ARTIST_CURATED, {
        commandId: job.id,
        workerId: job.worker_id ?? undefined,
        artistId: job.payload.artistId,
        artistName: job.payload.artistName,
        workflow: job.payload.workflow,
        monitoringCycle: job.payload.monitoringCycle,
        trigger: job.trigger ?? CommandTrigger.Unspecified,
        priority: job.priority ?? 0,
    });
};
