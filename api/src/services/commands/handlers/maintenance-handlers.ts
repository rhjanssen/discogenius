import { runRuntimeMaintenance } from "../runtime-maintenance.js";
import { runLowCouplingMaintenanceJob } from "../scheduler-maintenance-handlers.js";
import type {CommandModel} from "../command-model.js";
import type { CommandHandler } from "./handler-context.js";

/**
 * Shared handler for the low-coupling maintenance commands (BulkRefreshArtist,
 * DownloadMissingForce, RescanAllRoots, CheckHealth, CompactDatabase,
 * CleanupTempFiles, UpdateLibraryMetadata, ConfigPrune). Each delegates to the
 * maintenance dispatcher, which fans out by command name internally.
 */
export const handleLowCouplingMaintenance: CommandHandler = async (job, ctx) => {
    const command = job as CommandModel;
    await runLowCouplingMaintenanceJob(command, {
        updateCommandDescription: (options) => ctx.updateCommandDescription(command, options),
    });
};

export const handleHousekeeping: CommandHandler<"Housekeeping"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 10,
        description: 'Running housekeeping and optimizing the database',
    });
    const summary = runRuntimeMaintenance();
    const parts = [
        `Removed ${summary.duplicateLibraryFilesRemoved} duplicate media file row(s)`,
        `${summary.staleTrackedAssetsRemoved} stale tracked asset row(s)`,
        `repaired ${summary.mediaMonitorRepairs + summary.albumMonitorRepairs} monitor state gap(s)`,
        `pruned ${summary.historyJobsPruned} old job(s)`,
        `and optimized the database`,
    ];
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: parts.join(', '),
    });
};
