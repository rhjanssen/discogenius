import { runRuntimeMaintenance } from "../runtime-maintenance.js";
import { runLowCouplingMaintenanceJob } from "../scheduler-maintenance-handlers.js";
import { queueUpdateLibraryMetadata } from "../scheduler.js";
import { CommandQueueManager } from "../command-queue-manager.js";
import { AlbumLibraryIndexService } from "../../music/album-library-index-service.js";
import { TrackLibraryIndexService } from "../../music/track-library-index-service.js";
import { CommandTrigger } from "../command-trigger.js";
import type {CommandModel} from "../command-model.js";
import type { CommandHandler } from "./handler-context.js";

/**
 * Shared handler for the low-coupling maintenance commands (BulkRefreshArtist,
 * DownloadMissingForce, RescanAllRoots, CheckHealth, CompactDatabase,
 * BackupDatabase, CleanupTempFiles, UpdateLibraryMetadata, ConfigPrune). Each delegates to the
 * maintenance dispatcher, which fans out by command name internally.
 */
export const handleLowCouplingMaintenance: CommandHandler = async (job, ctx) => {
    const command = job as CommandModel;
    await runLowCouplingMaintenanceJob(command, {
        updateCommandDescription: (options) => ctx.updateCommandDescription(command, options),
        yieldToEventLoop: () => ctx.yieldToEventLoop(),
    });
};

export const handleHousekeeping: CommandHandler<"Housekeeping"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: 'Running housekeeping',
    });
    const isCancelled = () => Boolean(CommandQueueManager.get(job.id)?.payload.cancelRequested);
    const summary = await runRuntimeMaintenance({
        isCancelled,
        onProgress: (progress, description) => {
            ctx.updateCommandDescription(job, { progress, description });
        },
        yieldToEventLoop: () => ctx.yieldToEventLoop(),
    });
    const parts = [
        `Removed ${summary.duplicateLibraryFilesRemoved} duplicate media file row(s)`,
        `${summary.staleTrackedAssetsRemoved} stale tracked asset row(s)`,
        `pruned ${summary.historyJobsPruned} old job(s)`,
        `${summary.orphanDownloadFoldersRemoved} orphan download folder(s)`,
        `corrected ${summary.videoQualitiesCorrected} video quality tag(s)`,
        `removed ${summary.unmonitoredFilesRemoved} unmonitored file(s)`,
    ];
    const prefix = summary.timedOut ? "Housekeeping stopped at time limit; " : "";
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: prefix + parts.join(', '),
    });
    if (
        !summary.timedOut
        && (AlbumLibraryIndexService.needsRebuild()
        || TrackLibraryIndexService.needsRebuild())
    ) {
        queueUpdateLibraryMetadata({ trigger: CommandTrigger.Scheduled });
    }
};
