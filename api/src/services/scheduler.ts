import { JobTypes, TaskQueueService, Job, NON_DOWNLOAD_JOB_TYPES } from "./queue.js";
import { scanAlbumShallow, scanArtistDeep, scanPlaylist } from "./scanner.js";
import { RedundancyService } from "./redundancy.js";
import { CommandManager } from "./command.js";
import { LibraryFilesService } from "./library-files.js";
import { DiskScanService } from "./library-scan.js";
import { readIntEnv } from "../utils/env.js";
import { OrganizerService } from "./organizer.js";
import { Config } from "./config.js";
import { UpgraderService } from "./upgrader.js";
import { appEvents, AppEvent } from "./app-events.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { getArtistWorkflowLabel } from "./artist-workflow.js";
import { runRuntimeMaintenance } from "./runtime-maintenance.js";
import { queueManagedArtistsWorkflow } from "./artist-workflow.js";
import { getManagedArtists } from "./managed-artists.js";
import { queueNextMonitoringPass } from "./monitoring-scheduler.js";
import { AudioTagMaintenanceService } from "./audio-tag-maintenance.js";
import { db } from "../database.js";

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_SCHEDULER_POLL_MS', 2000, 1); // 2 seconds default
const BLOCKED_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_SCHEDULER_BLOCKED_LOG_THROTTLE_MS', 30_000, 0);
const STUCK_JOB_MS = readIntEnv('DISCOGENIUS_SCHEDULER_STUCK_JOB_MS', 0, 0); // 0 = disabled
const STUCK_CLEANUP_INTERVAL_MS = readIntEnv('DISCOGENIUS_SCHEDULER_STUCK_CLEANUP_INTERVAL_MS', 60_000, 1);
const SCHEDULER_THREAD_LIMIT = readIntEnv('DISCOGENIUS_SCHEDULER_THREAD_LIMIT', 3, 1); // Lidarr uses 3


/**
 * Scheduler - Handles non-download jobs (scans, curation, maintenance)
 *
 * Respects command exclusivity rules:
 * - Per-ref-exclusive commands (e.g. only one RefreshArtist/CurateArtist per artist at a time;
 *   different artists can run concurrently up to SCHEDULER_THREAD_LIMIT)
 * - Type-exclusive commands (only one of that type globally; e.g. RefreshMetadata)
 * - Disk-intensive commands (only one at a time)
 * - Exclusive commands (block everything else)
 *
 * Supports bounded concurrency (Lidarr THREAD_LIMIT style):
 * Up to SCHEDULER_THREAD_LIMIT non-exclusive jobs may run in parallel.
 */
export class Scheduler {
    private static isRunning = false;
    private static blockedLogAt = new Map<string, number>();
    private static lastStuckCleanupAt = 0;
    private static activeJobs = new Map<number, Promise<void>>();

    static start() {
        if (this.isRunning) return;
        this.isRunning = true;

        // Recover interrupted non-download jobs after process restart.
        const recovered = TaskQueueService.resetProcessingJobsByTypes(NON_DOWNLOAD_JOB_TYPES);
        if (recovered > 0) {
            console.log(`[Scheduler] Re-queued ${recovered} interrupted non-download job(s)`);
        }

        console.log("🚀 Scheduler started");
        void this.loop();
    }

    static stop() {
        this.isRunning = false;
        this.blockedLogAt.clear();
        this.lastStuckCleanupAt = 0;
        this.activeJobs.clear();
        console.log("🛑 Scheduler stopped");
    }

    private static async sleep(ms: number) {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private static updateJobDescription(job: Job, options: { progress?: number; description?: string }) {
        const payloadPatch: Record<string, unknown> = {};
        if (options.description) {
            payloadPatch.description = options.description;
        }

        TaskQueueService.updateState(job.id, {
            progress: options.progress,
            payloadPatch: Object.keys(payloadPatch).length > 0 ? payloadPatch : undefined,
        });
    }

    private static resolveArtistLabel(job: Job) {
        const payloadArtist = String(job.payload?.artistName || "").trim();
        if (payloadArtist && payloadArtist.toLowerCase() !== 'unknown artist') {
            return payloadArtist;
        }

        const workflow = String(job.payload?.workflow || "").trim();
        switch (workflow) {
            case 'monitoring-intake':
            case 'full-monitoring':
                return '';
            case 'refresh-scan':
                return '';
            case 'metadata-refresh':
                return 'artist metadata';
            case 'library-scan':
                return 'library folders';
            default:
                return '';
        }
    }

    private static formatArtistPhaseDescription(job: Job, phase: string, fallback = 'Artist') {
        const subject = this.resolveArtistLabel(job) || fallback;
        return `${subject} · ${phase}`;
    }

    private static formatWorkflowJobLabel(job: Job, fallback: string) {
        const workflow = String(job.payload?.workflow || '').trim();
        const subject = this.resolveArtistLabel(job) || fallback;

        switch (workflow) {
            case 'monitoring-intake':
            case 'full-monitoring':
                return `Monitoring ${subject}`;
            case 'refresh-scan':
                return `Refreshing ${subject}`;
            case 'metadata-refresh':
                return `Refreshing metadata for ${subject}`;
            case 'library-scan':
                return `Scanning ${subject}`;
            case 'curation':
                return `Curating ${subject}`;
            default:
                return subject;
        }
    }

    private static logBlocked(type: string, reason?: string) {
        const key = `${type}:${reason ?? 'unknown'}`;
        const now = Date.now();
        const last = this.blockedLogAt.get(key) ?? 0;

        if (now - last >= BLOCKED_LOG_THROTTLE_MS) {
            this.blockedLogAt.set(key, now);
            console.log(`[Scheduler] Cannot start ${type}: ${reason ?? 'blocked by command rules'}`);
        }
    }

    private static maybeCleanupStuckJobs() {
        if (STUCK_JOB_MS <= 0) return;

        const now = Date.now();
        if (now - this.lastStuckCleanupAt < STUCK_CLEANUP_INTERVAL_MS) {
            return;
        }
        this.lastStuckCleanupAt = now;

        let recovered = 0;
        const excludeIds = [...this.activeJobs.keys()];
        for (const type of NON_DOWNLOAD_JOB_TYPES) {
            recovered += TaskQueueService.requeueStaleProcessingJobs({
                typePattern: type,
                olderThanMs: STUCK_JOB_MS,
                excludeIds,
            });
        }

        if (recovered > 0) {
            console.warn(`[Scheduler] Re-queued ${recovered} stale processing non-download job(s)`);
        }
    }

    private static async loop() {
        while (this.isRunning) {
            try {
                this.maybeCleanupStuckJobs();

                // Try to fill all available slots (Lidarr THREAD_LIMIT style)
                const slotsAvailable = SCHEDULER_THREAD_LIMIT - this.activeJobs.size;
                if (slotsAvailable > 0) {
                    const candidates = TaskQueueService.getTopPendingJobsByTypes(NON_DOWNLOAD_JOB_TYPES, 20);
                    let started = 0;

                    for (const candidate of candidates) {
                        if (started >= slotsAvailable) break;
                        // Skip jobs already being processed
                        if (this.activeJobs.has(candidate.id)) continue;

                        const { canStart, reason } = CommandManager.canStartCommand(candidate.type, candidate.payload, candidate.ref_id);
                        if (canStart) {
                            this.startJob(candidate);
                            started++;
                        } else {
                            this.logBlocked(candidate.type, reason);
                        }
                    }
                }

                await this.sleep(POLL_INTERVAL);
            } catch (error) {
                // Defensive catch: never let loop crash due to unexpected worker error.
                console.error('[Scheduler] Worker loop error:', error);
                await this.sleep(POLL_INTERVAL);
            }
        }
    }

    private static startJob(job: Job) {
        // Mark as processing synchronously BEFORE launching async work,
        // so the next poll loop won't re-select this job from the DB.
        TaskQueueService.markProcessing(job.id);
        const promise = this.processJob(job).finally(() => {
            this.activeJobs.delete(job.id);
        });
        this.activeJobs.set(job.id, promise);
    }

    private static async processJob(job: Job) {
        console.log(`⚙️ Processing Job #${job.id}: ${job.type}`);

        try {
            switch (job.type) {
                case JobTypes.RefreshArtist:
                    this.updateJobDescription(job, {
                        progress: 5,
                        description: this.formatArtistPhaseDescription(job, "preparing artist refresh"),
                    });
                    await scanArtistDeep(job.payload.artistId, {
                        monitorArtist: job.payload.monitorArtist ?? job.payload.monitor ?? false,
                        monitorAlbums: job.payload.monitorAlbums,
                        hydrateCatalog: job.payload.hydrateCatalog,
                        hydrateAlbumTracks: job.payload.hydrateAlbumTracks,
                        includeSimilarArtists: job.payload.includeSimilarArtists ?? true,
                        seedSimilarArtists: job.payload.seedSimilarArtists ?? false,
                        forceUpdate: job.payload.forceUpdate ?? false,
                        progress: (event) => {
                            if (event.kind === "status") {
                                this.updateJobDescription(job, {
                                    progress: 10,
                                    description: this.formatArtistPhaseDescription(job, "refreshing metadata"),
                                });
                                return;
                            }

                            if (event.kind === "albums_total") {
                                this.updateJobDescription(job, {
                                    progress: event.total > 0 ? 15 : 75,
                                    description: event.total > 0
                                        ? this.formatArtistPhaseDescription(job, `indexing releases (0/${event.total})`)
                                        : this.formatArtistPhaseDescription(job, "no releases found"),
                                });
                                return;
                            }

                            if (event.kind === "album") {
                                const total = Math.max(event.total, 1);
                                const progress = Math.min(45, 15 + Math.round((event.index / total) * 30));
                                this.updateJobDescription(job, {
                                    progress,
                                    description: this.formatArtistPhaseDescription(job, `indexing releases (${event.index}/${event.total})`),
                                });
                            }

                            if (event.kind === "album_tracks") {
                                const total = Math.max(event.total, 1);
                                const progress = Math.min(85, 45 + Math.round((event.index / total) * 40));
                                this.updateJobDescription(job, {
                                    progress,
                                    description: this.formatArtistPhaseDescription(job, `scanning tracks (${event.index}/${event.total}: ${event.title})`),
                                });
                            }
                        },
                    });
                    this.updateJobDescription(job, {
                        progress: 90,
                        description: this.formatArtistPhaseDescription(job, "finalizing version groups"),
                    });

                    // Emit event so decoupled listeners (like curation.listener) can chain the redundancy check
                    appEvents.emit(AppEvent.ARTIST_SCANNED, {
                        artistId: job.payload.artistId,
                        artistName: job.payload.artistName,
                        workflow: job.payload.workflow,
                        scanLibrary: job.payload.scanLibrary ?? false,
                        forceDownloadQueue: job.payload.forceDownloadQueue ?? false,
                        trigger: job.trigger ?? 0
                    });
                    break;
                case JobTypes.ScanAlbum:
                    // SCAN_ALBUM means: ensure album SHALLOW metadata (tracks + review + similar)
                    await scanAlbumShallow(job.payload.albumId, {
                        forceUpdate: Boolean(job.payload?.forceUpdate),
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                    break;
                case JobTypes.ScanPlaylist:
                    {
                        const playlistId = job.payload.tidalId;
                        if (!playlistId) {
                            throw new Error('ScanPlaylist job missing tidalId');
                        }

                        await scanPlaylist(String(playlistId), {
                            forceUpdate: Boolean(job.payload?.forceUpdate),
                        });
                        break;
                    }
                case JobTypes.RefreshMetadata: {
                    const baseLabel = "Managed artists";
                    this.updateJobDescription(job, {
                        progress: 5,
                        description: `${baseLabel} - preparing metadata refresh`,
                    });
                    const result = queueManagedArtistsWorkflow("metadata-refresh", {
                        trigger: job.trigger ?? 0,
                        artistIds: Array.isArray(job.payload.artistIds)
                            ? job.payload.artistIds.map((artistId) => String(artistId))
                            : undefined,
                        includeRootScan: false,
                        onProgress: (event) => {
                            if (event.total === 0) {
                                return;
                            }

                            this.updateJobDescription(job, {
                                progress: Math.min(90, 10 + Math.round((event.processed / event.total) * 80)),
                                description: event.artistName
                                    ? `${baseLabel} - queueing metadata refresh jobs for ${event.artistName} (${event.processed}/${event.total})`
                                    : `${baseLabel} - queueing metadata refresh jobs (${event.processed}/${event.total})`,
                            });
                        },
                    });
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: result.artists > 0
                            ? `Queued metadata refresh for ${result.artists} managed artist(s)`
                            : "No managed artists available for metadata refresh",
                    });
                    break;
                }
                case JobTypes.ApplyCuration: {
                    const baseLabel = "Managed artists";
                    this.updateJobDescription(job, {
                        progress: 5,
                        description: `${baseLabel} - preparing curation`,
                    });
                    const result = queueManagedArtistsWorkflow("curation", {
                        trigger: job.trigger ?? 0,
                        artistIds: Array.isArray(job.payload.artistIds)
                            ? job.payload.artistIds.map((artistId) => String(artistId))
                            : undefined,
                        includeRootScan: false,
                        onProgress: (event) => {
                            if (event.total === 0) {
                                return;
                            }

                            this.updateJobDescription(job, {
                                progress: Math.min(90, 10 + Math.round((event.processed / event.total) * 80)),
                                description: event.artistName
                                    ? `${baseLabel} - queueing curation jobs for ${event.artistName} (${event.processed}/${event.total})`
                                    : `${baseLabel} - queueing curation jobs (${event.processed}/${event.total})`,
                            });
                        },
                    });
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: result.artists > 0
                            ? `Queued curation for ${result.artists} managed artist(s)`
                            : "No managed artists available for curation",
                    });
                    break;
                }
                case JobTypes.DownloadMissing: {
                    const selectedArtistIds = Array.isArray(job.payload.artistIds)
                        ? job.payload.artistIds.map((artistId) => String(artistId))
                        : undefined;
                    const artists = getManagedArtists({ artistIds: selectedArtistIds }) as Array<{ id: string | number; name?: string }>;
                    let totalAlbums = 0;
                    let totalTracks = 0;
                    let totalVideos = 0;

                    if (artists.length > 0) {
                        this.updateJobDescription(job, {
                            progress: 5,
                            description: `Managed artists - checking monitored items (0/${artists.length})`,
                        });
                    }

                    for (let index = 0; index < artists.length; index += 1) {
                        const artist = artists[index];
                        const artistName = String((artist as { name?: string }).name || "").trim();
                        this.updateJobDescription(job, {
                            progress: Math.min(90, 10 + Math.round((index / Math.max(artists.length, 1)) * 80)),
                            description: artistName
                                ? `Managed artists - checking monitored items for ${artistName} (${index + 1}/${artists.length})`
                                : `Managed artists - checking monitored items (${index + 1}/${artists.length})`,
                        });

                        const queued = await RedundancyService.queueMonitoredItems(String(artist.id));
                        totalAlbums += queued.albums;
                        totalTracks += queued.tracks;
                        totalVideos += queued.videos;
                    }

                    const total = totalAlbums + totalTracks + totalVideos;
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: `Queued ${total} download(s) (${totalAlbums} albums, ${totalTracks} tracks, ${totalVideos} videos)`,
                    });
                    break;
                }
                case JobTypes.CheckUpgrades: {
                    const result = await UpgraderService.checkUpgrades(true);
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: `Queued ${result.details.length} upgrade candidate(s)`,
                    });
                    break;
                }
                case JobTypes.CurateArtist:
                    await RedundancyService.processAll(
                        job.payload.artistId,
                        {
                            skipDownloadQueue: job.payload.skipDownloadQueue ?? false,
                            forceDownloadQueue: job.payload.forceDownloadQueue ?? false,
                        }
                    );
                    await UpgraderService.checkUpgrades(false, String(job.payload.artistId));
                    break;
                case JobTypes.RescanFolders: {
                    const artistId = job.payload.artistId;
                    const addNewArtists = job.payload.addNewArtists ?? false;

                    if (artistId && !addNewArtists) {
                        // Per-artist scan (existing behavior)
                        const baseLabel = this.formatWorkflowJobLabel(job, "Rescan folders");

                        // Step 1: Disk scan — reconcile library_files with disk reality
                        await DiskScanService.scan({
                            artistIds: [artistId],
                            onProgress: (event) => {
                                this.updateJobDescription(job, {
                                    progress: event.progress,
                                    description: `${baseLabel} - ${event.message}`,
                                });
                            },
                        });

                        // Step 2: Optional metadata backfill.
                        // Manual/local-only scans stop after reconciling files and importing from disk.
                        if (!(job.payload.skipMetadataBackfill ?? false)) {
                            this.updateJobDescription(job, {
                                progress: 90,
                                description: `${baseLabel} - backfilling metadata files`,
                            });
                            await DiskScanService.fillMissingMetadataFiles(artistId);
                        }

                        this.updateJobDescription(job, {
                            progress: 95,
                            description: `${baseLabel} - finalizing`,
                        });

                        // Step 3: Emit completion so artist curation cascades when requested
                        appEvents.emit(AppEvent.RESCAN_COMPLETED, {
                            artistId,
                            artistName: job.payload.artistName ?? "",
                            workflow: job.payload.workflow,
                            skipDownloadQueue: job.payload.skipDownloadQueue ?? false,
                            skipCuration: job.payload.skipCuration ?? false,
                            skipMetadataBackfill: job.payload.skipMetadataBackfill ?? false,
                            forceDownloadQueue: job.payload.forceDownloadQueue ?? false,
                            trigger: job.trigger ?? 0
                        });
                    } else {
                        // Library-wide scan (RescanFolders with addNewArtists)
                        this.updateJobDescription(job, {
                            progress: 5,
                            description: "Scanning library root folders",
                        });
                        await DiskScanService.scan({
                            addNewArtists: addNewArtists,
                            monitorNewArtists: job.payload.monitorArtist ?? true,
                            fullProcessing: job.payload.fullProcessing ?? false,
                            trigger: job.trigger ?? 0,
                            onProgress: (event) => {
                                this.updateJobDescription(job, {
                                    progress: event.progress ?? 50,
                                    description: `Scanning library root folders - ${event.message}`,
                                });
                            },
                        });
                        this.updateJobDescription(job, {
                            progress: 95,
                            description: "Scanning library root folders - finalizing",
                        });
                    }
                    break;
                }
                case JobTypes.RefreshAllMonitored: {
                    const monitored = getManagedArtists({ includeLibraryFiles: false });
                    let queued = 0;
                    for (const artist of monitored) {
                        TaskQueueService.addJob(
                            JobTypes.RefreshArtist,
                            {
                                artistId: String(artist.id),
                                artistName: artist.name,
                                workflow: 'metadata-refresh',
                                monitorArtist: Boolean(artist.monitor),
                                hydrateCatalog: true,
                                hydrateAlbumTracks: true,
                                scanLibrary: true,
                                forceDownloadQueue: false,
                                forceUpdate: true,
                            } as any,
                            String(artist.id),
                            0
                        );
                        queued++;
                    }
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: `Queued refresh for ${queued} monitored artist(s)`,
                    });
                    break;
                }
                case JobTypes.DownloadMissingForce: {
                    if ((job.payload as any).skipFlags === true) {
                        db.prepare(`UPDATE media SET skip_download = 0, skip_upgrade = 0 WHERE monitor = 1;`).run();
                    }
                    TaskQueueService.addJob(
                        JobTypes.DownloadMissing,
                        {},
                        undefined,
                        10
                    );
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: 'Queued force download of missing media',
                    });
                    break;
                }
                case JobTypes.RescanAllRoots: {
                    const roots = db.prepare(`SELECT id FROM root_folders WHERE enabled = 1`).all() as any[];
                    for (const root of roots) {
                        TaskQueueService.addJob(
                            JobTypes.RescanFolders,
                            {
                                addNewArtists: (job.payload as any).addNewArtists ?? false,
                            },
                            undefined,
                            0
                        );
                    }
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: `Queued scan for ${roots.length} root folder(s)`,
                    });
                    break;
                }
                case JobTypes.HealthCheck: {
                    const issues: string[] = [];

                    this.updateJobDescription(job, {
                        progress: 100,
                        description: issues.length > 0 ? `${issues.length} issue(s) detected` : 'Healthy',
                    });
                    break;
                }
                case JobTypes.CompactDatabase: {
                    db.prepare('VACUUM;').run();
                    db.prepare('ANALYZE;').run();
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: 'Database compacted and analyzed',
                    });
                    break;
                }
                case JobTypes.CleanupTempFiles: {
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: 'Temporary files cleaned',
                    });
                    break;
                }
                case JobTypes.UpdateLibraryMetadata: {
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: 'Library metadata updated',
                    });
                    break;
                }
                case JobTypes.ConfigPrune: {
                    // Apply metadata preferences to the existing library:
                    // remove disabled sidecars and restore newly enabled ones.
                    await OrganizerService.pruneDisabledMetadata();
                    await DiskScanService.fillMissingMetadataFilesForLibrary();
                    break;
                }
                case JobTypes.ApplyRenames: {
                    this.updateJobDescription(job, {
                        progress: 5,
                        description: 'Library files - applying rename plan',
                    });
                    const result = Array.isArray(job.payload.ids) && job.payload.ids.length > 0
                        ? LibraryFilesService.applyRenames(job.payload.ids)
                        : LibraryFilesService.applyRenamesByQuery({
                            artistId: job.payload.artistId,
                            albumId: job.payload.albumId,
                            libraryRoot: job.payload.libraryRoot,
                            fileTypes: job.payload.fileTypes,
                        });
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: `Renamed ${result.renamed} file(s), ${result.conflicts} conflict(s), ${result.missing} missing, ${result.cleanedDirectories} empty folder(s) cleaned`,
                    });
                    break;
                }
                case JobTypes.ApplyRetags: {
                    this.updateJobDescription(job, {
                        progress: 5,
                        description: 'Library files - applying retag plan',
                    });
                    const result = Array.isArray(job.payload.ids) && job.payload.ids.length > 0
                        ? await AudioTagMaintenanceService.apply(job.payload.ids)
                        : await AudioTagMaintenanceService.applyByQuery({
                            artistId: job.payload.artistId,
                            albumId: job.payload.albumId,
                        });
                    this.updateJobDescription(job, {
                        progress: 100,
                        description: `Retagged ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
                    });
                    break;
                }
                case JobTypes.Housekeeping: {
                    runRuntimeMaintenance();
                    break;
                }
                default:
                    // If we accidentally picked up a download job or unknown
                    console.warn(`Scheduler picked up unhandled job type: ${job.type}`);
            }

            TaskQueueService.complete(job.id);
            queueNextMonitoringPass(job);
            console.log(`✅ Job #${job.id} completed`);

        } catch (error: any) {
            console.error(`❌ Job #${job.id} failed:`, error);
            TaskQueueService.fail(job.id, error?.message || 'Unknown scheduler error');
        }
    }
}







