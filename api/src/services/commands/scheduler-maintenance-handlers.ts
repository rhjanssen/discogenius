import { CommandTrigger } from "./command-trigger.js";
import { db } from "../../database.js";
import {
    collectHealthDiagnosticsSnapshot,
    runDeepDatabaseHealthCheck,
    type HealthDiagnosticsSnapshot,
} from "./health.js";
import { DiskScanService } from "../mediafiles/library-scan.js";
import { OrganizerService } from "../mediafiles/organizer.js";
import { CommandModel, type CommandModelOf } from "./command-model.js";
import { CommandNames } from "./command-names.js";
import { CommandQueueManager } from "./command-queue-manager.js";
import { ArtistTopTrackService } from "../music/artist-top-track-service.js";
import { AlbumLibraryIndexService } from "../music/album-library-index-service.js";
import { TrackLibraryIndexService } from "../music/track-library-index-service.js";
import {
    refreshArtworkPreferenceCache,
    type ArtworkPreferenceRefreshOptions,
    type ArtworkPreferenceRefreshSummary,
} from "../metadata/artwork-preference-refresh.js";

export interface SchedulerJobDescriptionUpdate {
    progress?: number;
    description?: string;
}

export interface SchedulerMaintenanceHandlerContext {
    updateCommandDescription: (options: SchedulerJobDescriptionUpdate) => void;
    yieldToEventLoop?: () => Promise<void>;
}

export interface ConfigPruneMaintenanceDependencies {
    refreshArtworkPreferenceCache: (
        options: ArtworkPreferenceRefreshOptions,
    ) => Promise<ArtworkPreferenceRefreshSummary>;
    pruneDisabledMetadata: () => Promise<void>;
    reconcileLibraryMetadata: () => Promise<{
        downloaded: number;
        failed: number;
        skipped: number;
    }>;
}

const CONFIG_PRUNE_DEPENDENCIES: ConfigPruneMaintenanceDependencies = {
    refreshArtworkPreferenceCache,
    pruneDisabledMetadata: () => OrganizerService.pruneDisabledMetadata(),
    reconcileLibraryMetadata: () => DiskScanService.fillMissingMetadataFilesForLibrary(),
};

/**
 * Preference flips add a global, durable cache-acquisition phase before the
 * existing ConfigPrune sidecar/embed reconciliation. Without the payload flag,
 * this remains the ordinary two-step ConfigPrune behavior.
 */
export async function runConfigPruneMaintenance(
    job: CommandModelOf<typeof CommandNames.ConfigPrune>,
    context: SchedulerMaintenanceHandlerContext,
    dependencies: ConfigPruneMaintenanceDependencies = CONFIG_PRUNE_DEPENDENCIES,
): Promise<void> {
    const refreshArtworkPreference = job.payload.refreshArtworkPreference === true;
    let artworkSummary: ArtworkPreferenceRefreshSummary | null = null;

    if (refreshArtworkPreference) {
        context.updateCommandDescription({
            progress: 1,
            description: "Refreshing artwork preference across the canonical catalog",
        });
        artworkSummary = await dependencies.refreshArtworkPreferenceCache({
            yieldToEventLoop: context.yieldToEventLoop,
            onProgress: (progress) => {
                const percent = progress.total > 0
                    ? Math.min(85, Math.max(1, Math.round((progress.completed / progress.total) * 85)))
                    : 85;
                context.updateCommandDescription({
                    progress: percent,
                    description:
                        `Refreshing canonical artwork (${progress.completed}/${progress.total}; ` +
                        `${progress.albumsCompleted} album(s), ${progress.artistsCompleted} artist(s))`,
                });
            },
        });
        context.updateCommandDescription({
            progress: 88,
            description:
                `Refreshed artwork for ${artworkSummary.completed}/${artworkSummary.total} ` +
                `catalog item(s)${artworkSummary.failed > 0 ? ` (${artworkSummary.failed} failed)` : ""}`,
        });
    }

    if (refreshArtworkPreference) {
        context.updateCommandDescription({
            progress: 90,
            description: "Pruning metadata disabled by the current configuration",
        });
    }
    await dependencies.pruneDisabledMetadata();

    if (refreshArtworkPreference) {
        context.updateCommandDescription({
            progress: 95,
            description: "Reconciling library artwork sidecars and embedded covers",
        });
    }
    const reconciliation = await dependencies.reconcileLibraryMetadata();

    if (refreshArtworkPreference && artworkSummary) {
        context.updateCommandDescription({
            progress: 100,
            description:
                `Artwork preference applied to ${artworkSummary.completed - artworkSummary.failed}/` +
                `${artworkSummary.total} catalog item(s); reconciled ${reconciliation.downloaded} ` +
                `library metadata file(s), ${reconciliation.failed} failed`,
        });
    }
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
            context.updateCommandDescription({
                progress: 10,
                description: 'Queueing metadata refresh for all monitored artists',
            });
            const { queueMetadataRefreshPass } = await import('./scheduler.js');
            queueMetadataRefreshPass({ trigger: job.trigger ?? CommandTrigger.Manual });
            context.updateCommandDescription({
                progress: 100,
                description: 'Queued metadata refresh for all monitored artists',
            });
            return;
        }
        case CommandNames.DownloadMissingForce: {
            CommandQueueManager.push(
                CommandNames.DownloadMissing,
                {},
                undefined,
                10,
            );
            context.updateCommandDescription({
                progress: 100,
                description: 'Queued force download of missing media',
            });
            return;
        }
        case CommandNames.RescanAllRoots: {
            context.updateCommandDescription({
                progress: 10,
                description: 'Queueing library-wide folder rescan',
            });
            const { queueRescanFoldersPass } = await import('./scheduler.js');
            queueRescanFoldersPass({ trigger: job.trigger ?? CommandTrigger.Manual, addNewArtists: true, filter: "none" });
            context.updateCommandDescription({
                progress: 100,
                description: 'Queued library-wide folder rescan',
            });
            return;
        }
        case CommandNames.CheckHealth: {
            context.updateCommandDescription({
                progress: 10,
                description: "Running deep database integrity checks",
            });
            // CheckHealth executes in the command worker pool in production.
            // Keep quick_check/foreign_key_check off the API event loop and
            // persist the result for lightweight /health reads.
            const deepResult = runDeepDatabaseHealthCheck();
            const snapshot = collectHealthDiagnosticsSnapshot({ deepResult });
            context.updateCommandDescription({
                progress: 100,
                description: formatHealthCheckDescription(snapshot),
            });
            return;
        }
        case CommandNames.CompactDatabase: {
            db.prepare('VACUUM;').run();
            db.prepare('ANALYZE;').run();
            context.updateCommandDescription({
                progress: 100,
                description: 'Database compacted and analyzed',
            });
            return;
        }
        case CommandNames.BackupDatabase: {
            context.updateCommandDescription({ progress: 10, description: 'Creating database backup' });
            const pathModule = await import('path');
            const { executeDatabaseBackup } = await import('./runtime-maintenance.js');
            const { backupPath, prunedCount } = await executeDatabaseBackup();
            const fileName = pathModule.default.basename(backupPath);
            context.updateCommandDescription({
                progress: 100,
                description: `Created database backup ${fileName}` + (prunedCount > 0 ? ` (${prunedCount} old backup(s) pruned)` : ''),
            });
            return;
        }
        case CommandNames.CleanupTempFiles: {
            context.updateCommandDescription({ progress: 10, description: 'Cleaning temporary files' });
            const { pruneOrphanDownloadFolders, pruneStaleTempDirectories } = await import('./runtime-maintenance.js');
            const orphanFolders = pruneOrphanDownloadFolders();
            const tempDirs = pruneStaleTempDirectories();
            context.updateCommandDescription({
                progress: 100,
                description: orphanFolders > 0 || tempDirs > 0
                    ? `Cleaned ${orphanFolders} orphan download folder(s) and ${tempDirs} temp dir(s)`
                    : 'No temporary files to clean',
            });
            return;
        }
        case CommandNames.UpdateLibraryMetadata: {
            let indexedAlbums = 0;
            let indexedTracks = 0;
            if (AlbumLibraryIndexService.needsRebuild()) {
                context.updateCommandDescription({
                    progress: 1,
                    description: 'Building album library index',
                });
                indexedAlbums = (await AlbumLibraryIndexService.rebuildGated(
                    context.yieldToEventLoop,
                    (done, total) => {
                        context.updateCommandDescription({
                            progress: 1,
                            description: `Building album library index (${done}/${total})`,
                        });
                    },
                )).rows;
            }

            if (TrackLibraryIndexService.needsRebuild()) {
                context.updateCommandDescription({
                    progress: 2,
                    description: 'Building track library index',
                });
                indexedTracks = (await TrackLibraryIndexService.rebuildGated(
                    context.yieldToEventLoop,
                )).rows;
            }

            const summary = ArtistTopTrackService.rebuildMissingMonitoredArtists((progress) => {
                const percent = progress.total > 0
                    ? Math.min(99, Math.max(2, Math.round((progress.index / progress.total) * 100)))
                    : 100;
                context.updateCommandDescription({
                    progress: percent,
                    description: `Indexing top tracks (${progress.index}/${progress.total}: ${progress.artistName})`,
                });
            });
            context.updateCommandDescription({
                progress: 100,
                description: indexedAlbums > 0 || indexedTracks > 0 || summary.artists > 0
                    ? `Indexed ${indexedAlbums} album(s), ${indexedTracks} library track(s), and ${summary.rows} top track(s) for ${summary.artists} monitored artist(s)`
                    : 'Library metadata index is current',
            });
            return;
        }
        case CommandNames.ConfigPrune: {
            return runConfigPruneMaintenance(job, context);
        }
        default:
            throw new Error(`Unsupported low-coupling maintenance job: ${job.name}`);
    }
}
