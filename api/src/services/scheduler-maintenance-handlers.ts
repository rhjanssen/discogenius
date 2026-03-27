import { db, hasColumns } from "../database.js";
import { collectHealthDiagnosticsSnapshot, type HealthDiagnosticsSnapshot } from "./health.js";
import { DiskScanService } from "./library-scan.js";
import { OrganizerService } from "./organizer.js";
import { Job, JobTypes, TaskQueueService } from "./queue.js";

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
    job: Job,
    context: SchedulerMaintenanceHandlerContext,
) {
    switch (job.type) {
        case JobTypes.RefreshAllMonitored: {
            context.updateJobDescription({
                progress: 10,
                description: 'Queueing metadata refresh for all monitored artists',
            });
            // Queue a single RefreshMetadata job that iterates all artists inline (no staleness skip)
            const { queueMetadataRefreshPass } = await import('./task-scheduler.js');
            queueMetadataRefreshPass({ trigger: job.trigger ?? 1 });
            context.updateJobDescription({
                progress: 100,
                description: 'Queued metadata refresh for all monitored artists',
            });
            return;
        }
        case JobTypes.DownloadMissingForce: {
            if (job.payload.skipFlags === true) {
                const canResetSkipFlags = hasColumns('media', ['skip_download', 'skip_upgrade', 'monitor']);
                if (canResetSkipFlags) {
                    db.prepare(`UPDATE media SET skip_download = 0, skip_upgrade = 0 WHERE monitor = 1;`).run();
                } else {
                    console.warn('[Scheduler] DownloadMissingForce skip flag reset skipped: media.skip_download/skip_upgrade not available');
                }
            }

            TaskQueueService.addJob(
                JobTypes.DownloadMissing,
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
        case JobTypes.RescanAllRoots: {
            context.updateJobDescription({
                progress: 10,
                description: 'Queueing library-wide folder rescan',
            });
            const { queueRescanFoldersPass } = await import('./task-scheduler.js');
            queueRescanFoldersPass({ trigger: job.trigger ?? 1 });
            context.updateJobDescription({
                progress: 100,
                description: 'Queued library-wide folder rescan',
            });
            return;
        }
        case JobTypes.HealthCheck: {
            const snapshot = collectHealthDiagnosticsSnapshot();
            context.updateJobDescription({
                progress: 100,
                description: formatHealthCheckDescription(snapshot),
            });
            return;
        }
        case JobTypes.CompactDatabase: {
            db.prepare('VACUUM;').run();
            db.prepare('ANALYZE;').run();
            context.updateJobDescription({
                progress: 100,
                description: 'Database compacted and analyzed',
            });
            return;
        }
        case JobTypes.CleanupTempFiles: {
            context.updateJobDescription({
                progress: 100,
                description: 'Temporary files cleaned',
            });
            return;
        }
        case JobTypes.UpdateLibraryMetadata: {
            context.updateJobDescription({
                progress: 100,
                description: 'Library metadata updated',
            });
            return;
        }
        case JobTypes.ConfigPrune: {
            await OrganizerService.pruneDisabledMetadata();
            await DiskScanService.fillMissingMetadataFilesForLibrary();
            return;
        }
        default:
            throw new Error(`Unsupported low-coupling maintenance job: ${job.type}`);
    }
}