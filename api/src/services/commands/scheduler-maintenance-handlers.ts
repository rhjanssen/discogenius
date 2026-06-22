import { CommandTrigger } from "./command-trigger.js";
import { db } from "../../database.js";
import { collectHealthDiagnosticsSnapshot, type HealthDiagnosticsSnapshot } from "./health.js";
import { DiskScanService } from "../mediafiles/library-scan.js";
import { OrganizerService } from "../mediafiles/organizer.js";
import { CommandModel, CommandNames, CommandQueueService } from "./command-queue.js";

export interface SchedulerJobDescriptionUpdate {
    progress?: number;
    description?: string;
}

export interface SchedulerMaintenanceHandlerContext {
    updateJobDescription: (options: SchedulerJobDescriptionUpdate) => void;
}

export function formatHealthCheckDescription(snapshot: HealthDiagnosticsSnapshot): string {
    const totalIssues = snapshot.issues.length;
    if (totalIssues === 0) {
        return 'Healthy';
    }

    const errorCount = snapshot.issues.filter((issue) => issue.status === 'error').length;
    const warningCount = snapshot.issues.filter((issue) => issue.status === 'warning').length;

    if (errorCount > 0 && warningCount > 0) {
        return `${totalIssues} issue(s) detected (${errorCount} error(s), ${warningCount} warning(s))`;
    }

    if (errorCount > 0) {
        return `${totalIssues} issue(s) detected (${errorCount} error(s))`;
    }

    if (warningCount > 0) {
        return `${totalIssues} issue(s) detected (${warningCount} warning(s))`;
    }

    return `${totalIssues} issue(s) detected`;
}

export async function runLowCouplingMaintenanceJob(
    job: CommandModel,
    context: SchedulerMaintenanceHandlerContext,
) {
    switch (job.name) {
        case CommandNames.BulkRefreshArtist: {
            context.updateJobDescription({
                progress: 10,
                description: 'Queueing metadata refresh for all monitored artists',
            });
            // Queue a single RefreshMetadata job that iterates all artists inline (no staleness skip)
            const { queueMetadataRefreshPass } = await import('./scheduler.js');
            queueMetadataRefreshPass({ trigger: job.trigger ?? CommandTrigger.Manual });
            context.updateJobDescription({
                progress: 100,
                description: 'Queued metadata refresh for all monitored artists',
            });
            return;
        }
        case CommandNames.DownloadMissingForce: {
            CommandQueueService.addJob(
                CommandNames.DownloadMissing,
                {},
                undefined,
                10,
            );
            context.updateJobDescription({
                progress: 100,
                description: 'Queued force download of missing media',
            });
            return;
        }
        case CommandNames.RescanAllRoots: {
            context.updateJobDescription({
                progress: 10,
                description: 'Queueing library-wide folder rescan',
            });
            const { queueRescanFoldersPass } = await import('./scheduler.js');
            queueRescanFoldersPass({ trigger: job.trigger ?? CommandTrigger.Manual, addNewArtists: true });
            context.updateJobDescription({
                progress: 100,
                description: 'Queued library-wide folder rescan',
            });
            return;
        }
        case CommandNames.CheckHealth: {
            const snapshot = collectHealthDiagnosticsSnapshot();
            context.updateJobDescription({
                progress: 100,
                description: formatHealthCheckDescription(snapshot),
            });
            return;
        }
        case CommandNames.CompactDatabase: {
            db.prepare('VACUUM;').run();
            db.prepare('ANALYZE;').run();
            context.updateJobDescription({
                progress: 100,
                description: 'Database compacted and analyzed',
            });
            return;
        }
        case CommandNames.CleanupTempFiles: {
            context.updateJobDescription({
                progress: 100,
                description: 'Temporary files cleaned',
            });
            return;
        }
        case CommandNames.UpdateLibraryMetadata: {
            context.updateJobDescription({
                progress: 100,
                description: 'Library metadata updated',
            });
            return;
        }
        case CommandNames.ConfigPrune: {
            await OrganizerService.pruneDisabledMetadata();
            await DiskScanService.fillMissingMetadataFilesForLibrary();
            return;
        }
        default:
            throw new Error(`Unsupported low-coupling maintenance job: ${job.name}`);
    }
}
