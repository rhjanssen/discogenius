import { JobTypes, TaskQueueService, Job, NON_DOWNLOAD_JOB_TYPES } from "./queue.js";
import { scanAlbumShallow, scanArtistDeep, scanPlaylist } from "./scanner.js";
import { RedundancyService } from "./redundancy.js";
import { CommandManager } from "./command.js";
import { LibraryFilesService } from "./library-files.js";
import { DiskScanService } from "./library-scan.js";
import { readIntEnv } from "../utils/env.js";
import { OrganizerService } from "./organizer.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "./download-state.js";
import { downloadEvents } from "./download-events.js";
import { db } from "../database.js";
import fs from "fs";
import { Config } from "./config.js";
import { UpgraderService } from "./upgrader.js";
import { appEvents, AppEvent } from "./app-events.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { getDownloadWorkspacePath } from "./download-routing.js";
import { getArtistWorkflowLabel } from "./artist-workflow.js";
import { runRuntimeMaintenance } from "./runtime-maintenance.js";
import { queueManagedArtistsWorkflow } from "./artist-workflow.js";
import { getManagedArtists } from "./managed-artists.js";
import { queueNextMonitoringPass } from "./monitoring-scheduler.js";
import { AudioTagMaintenanceService } from "./audio-tag-maintenance.js";
import { getExistingLibraryMediaIds } from "./download-recovery.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_SCHEDULER_POLL_MS', 2000, 1); // 2 seconds default
const BLOCKED_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_SCHEDULER_BLOCKED_LOG_THROTTLE_MS', 30_000, 0);
const STUCK_JOB_MS = readIntEnv('DISCOGENIUS_SCHEDULER_STUCK_JOB_MS', 0, 0); // 0 = disabled
const STUCK_CLEANUP_INTERVAL_MS = readIntEnv('DISCOGENIUS_SCHEDULER_STUCK_CLEANUP_INTERVAL_MS', 60_000, 1);
const SCHEDULER_THREAD_LIMIT = readIntEnv('DISCOGENIUS_SCHEDULER_THREAD_LIMIT', 3, 1); // Lidarr uses 3


/**
 * Scheduler - Handles non-download jobs (scans, imports, redundancy checks)
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

    private static updateDownloadQueueState(job: Job, options: {
        progress?: number;
        description?: string;
        currentFileNum?: number;
        totalFiles?: number;
        currentTrack?: string;
        trackProgress?: number;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        statusMessage?: string;
        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
    }) {
        const payloadPatch: Record<string, unknown> = {};
        if (options.description) {
            payloadPatch.description = options.description;
        }

        payloadPatch.downloadState = {
            ...(job.payload?.downloadState && typeof job.payload.downloadState === 'object' ? job.payload.downloadState : {}),
            progress: options.progress,
            currentFileNum: options.currentFileNum,
            totalFiles: options.totalFiles,
            currentTrack: options.currentTrack,
            trackProgress: options.trackProgress,
            trackStatus: options.trackStatus,
            statusMessage: options.statusMessage,
            state: options.state,
        };

        const updated = TaskQueueService.updateState(job.id, {
            progress: options.progress,
            payloadPatch,
        });

        if (updated) {
            job.payload = updated.payload;
            job.progress = updated.progress;
        }
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
                case JobTypes.ImportDownload: {
                    const { type, tidalId, resolved, originalJobId, path: payloadPath } = job.payload;
                    const downloadPath = payloadPath || getDownloadWorkspacePath(type as 'album' | 'track' | 'video' | 'playlist', tidalId);
                    let shouldCleanupDownloadPath = false;

                    const resolveImportHistoryContext = () => {
                        const fallback = {
                            artistId: null as number | null,
                            albumId: null as number | null,
                            mediaId: null as number | null,
                            quality: null as string | null,
                        };

                        if (type === 'album') {
                            const albumRow = db.prepare(`
                                SELECT id, artist_id, quality
                                FROM albums
                                WHERE id = ?
                            `).get(tidalId) as { id: number; artist_id: number; quality: string | null } | undefined;

                            if (!albumRow) {
                                return fallback;
                            }

                            return {
                                artistId: albumRow.artist_id,
                                albumId: albumRow.id,
                                mediaId: null,
                                quality: albumRow.quality || null,
                            };
                        }

                        if (type === 'track' || type === 'video') {
                            const mediaRow = db.prepare(`
                                SELECT id, artist_id, album_id, quality
                                FROM media
                                WHERE id = ?
                            `).get(tidalId) as {
                                id: number;
                                artist_id: number;
                                album_id: number | null;
                                quality: string | null;
                            } | undefined;

                            if (!mediaRow) {
                                return fallback;
                            }

                            return {
                                artistId: mediaRow.artist_id,
                                albumId: mediaRow.album_id,
                                mediaId: mediaRow.id,
                                quality: mediaRow.quality || null,
                            };
                        }

                        return fallback;
                    };

                    this.updateDownloadQueueState(job, {
                        progress: 5,
                        description: 'ImportDownload: preparing import',
                        statusMessage: 'Preparing import',
                        state: 'importing',
                    });

                    try {
                        let organizeResult;
                        if (!fs.existsSync(downloadPath)) {
                            const recoveredMediaIds = getExistingLibraryMediaIds(type, tidalId);

                            if (recoveredMediaIds.length === 0) {
                                throw new Error(`Import files for ${type} ${tidalId} are no longer available. Re-download the item to retry import.`);
                            }

                            const expectedTracks = type === 'album'
                                ? Number((db.prepare(`SELECT COUNT(*) as count FROM media WHERE album_id = ? AND type != 'Music Video'`).get(tidalId) as any)?.count || recoveredMediaIds.length)
                                : 1;

                            organizeResult = {
                                type,
                                tidalId,
                                processedTrackIds: recoveredMediaIds,
                                totalTracksInStaging: recoveredMediaIds.length,
                                expectedTracks,
                            };
                            this.updateDownloadQueueState(job, {
                                progress: 85,
                                description: 'ImportDownload: recovering existing library files',
                                currentFileNum: recoveredMediaIds.length,
                                totalFiles: expectedTracks,
                                statusMessage: 'Recovering import from existing library files',
                                state: 'importing',
                            });
                            console.warn(`[Scheduler] Download workspace missing for ${type} ${tidalId}, but imported library file(s) already exist. Recovering ImportDownload job.`);
                        } else {
                            this.updateDownloadQueueState(job, {
                                progress: 15,
                                description: 'ImportDownload: importing downloaded files',
                                statusMessage: 'Importing downloaded files',
                                state: 'importing',
                            });
                            organizeResult = await OrganizerService.organizeDownload({
                                type,
                                tidalId,
                                downloadPath,
                                onProgress: (progress) => {
                                    const normalizedProgress = progress.phase === 'finalizing'
                                        ? 90
                                        : progress.totalFiles && progress.currentFileNum !== undefined
                                            ? Math.max(15, Math.min(85, 15 + Math.round((progress.currentFileNum / Math.max(progress.totalFiles, 1)) * 70)))
                                            : 35;

                                    this.updateDownloadQueueState(job, {
                                        progress: normalizedProgress,
                                        description: `ImportDownload: ${progress.statusMessage || 'Importing downloaded files'}`,
                                        currentFileNum: progress.currentFileNum,
                                        totalFiles: progress.totalFiles,
                                        currentTrack: progress.currentTrack,
                                        trackProgress: progress.totalFiles === 1 && progress.currentFileNum === 1 ? 100 : undefined,
                                        trackStatus: progress.phase === 'finalizing' ? 'completed' : progress.currentTrack ? 'downloading' : undefined,
                                        statusMessage: progress.statusMessage,
                                        state: 'importing',
                                    });
                                },
                            });
                        }

                        this.updateDownloadQueueState(job, {
                            progress: 92,
                            description: 'ImportDownload: reconciling library state',
                            currentFileNum: organizeResult.processedTrackIds.length,
                            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                            statusMessage: 'Reconciling imported library state',
                            state: 'importing',
                        });

                        if (type === 'album') {
                            const processedIds = organizeResult.processedTrackIds;
                            if (processedIds.length === 0) {
                                throw new Error(`No tracks were successfully organized for album ${tidalId}`);
                            }

                            const expected = organizeResult.expectedTracks || 0;
                            if (processedIds.length < expected) {
                                console.warn(`[Scheduler] Album ${tidalId}: Only ${processedIds.length}/${expected} tracks were downloaded. Partial download.`);
                            }

                            updateAlbumDownloadStatus(String(tidalId));
                        } else if (type === 'video') {
                            updateArtistDownloadStatusFromMedia(String(tidalId));
                        } else {
                            try {
                                const albumRow = db.prepare("SELECT album_id FROM media WHERE id = ?").get(tidalId) as { album_id?: number | null } | undefined;
                                if (albumRow?.album_id) {
                                    updateAlbumDownloadStatus(String(albumRow.album_id));
                                } else {
                                    updateArtistDownloadStatusFromMedia(String(tidalId));
                                }
                            } catch {
                                // Best-effort: skip album update if lookup fails.
                            }
                        }

                        // Clear any pending upgrade_queue entry now that the download succeeded
                        if (type === 'album') {
                            db.prepare(`DELETE FROM upgrade_queue WHERE album_id = ?`).run(tidalId);
                        } else {
                            db.prepare(`DELETE FROM upgrade_queue WHERE media_id = ?`).run(tidalId);
                        }

                        const affectedArtistId = type === 'album'
                            ? (db.prepare(`SELECT artist_id FROM albums WHERE id = ?`).get(tidalId) as { artist_id?: number | null } | undefined)?.artist_id
                            : (db.prepare(`SELECT artist_id FROM media WHERE id = ?`).get(tidalId) as { artist_id?: number | null } | undefined)?.artist_id;

                        // Reconcile library_files against the actual disk state after import/replacement.
                        // This keeps quality/path metadata correct when a download replaces an existing file.
                        if (affectedArtistId) {
                            this.updateDownloadQueueState(job, {
                                progress: 97,
                                description: 'ImportDownload: refreshing library file records',
                                currentFileNum: organizeResult.processedTrackIds.length,
                                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                                statusMessage: 'Refreshing library file records',
                                state: 'importing',
                            });
                            await DiskScanService.scan({ artistIds: [String(affectedArtistId)] });
                        }

                        if ((type === 'album' || type === 'track') && organizeResult.processedTrackIds.length > 0) {
                            this.updateDownloadQueueState(job, {
                                progress: 99,
                                description: 'ImportDownload: applying audio tag rules',
                                currentFileNum: organizeResult.processedTrackIds.length,
                                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                                statusMessage: 'Applying audio tag rules',
                                state: 'importing',
                            });

                            try {
                                await AudioTagMaintenanceService.applyForMediaIds(organizeResult.processedTrackIds);
                            } catch (error) {
                                console.warn(`[Scheduler] Failed to apply audio tag rules for ${type} ${tidalId}:`, error);
                            }
                        }

                        const historyContext = resolveImportHistoryContext();
                        try {
                            recordHistoryEvent({
                                artistId: historyContext.artistId,
                                albumId: historyContext.albumId,
                                mediaId: historyContext.mediaId,
                                eventType: HISTORY_EVENT_TYPES.DownloadImported,
                                quality: historyContext.quality,
                                sourceTitle: String(resolved?.title || tidalId),
                                data: {
                                    type,
                                    tidalId,
                                    originalJobId: originalJobId ?? null,
                                    processedTrackIds: {
                                        count: organizeResult.processedTrackIds.length,
                                        expected: organizeResult.expectedTracks ?? organizeResult.totalTracksInStaging ?? null,
                                    },
                                },
                            });
                        } catch (historyError) {
                            console.warn(`[Scheduler] Failed to write DownloadImported history event for ${type} ${tidalId}:`, historyError);
                        }

                        const expectedProcessedTracks = organizeResult.expectedTracks ?? 0;
                        if (
                            type === 'album'
                            && expectedProcessedTracks > 0
                            && organizeResult.processedTrackIds.length < expectedProcessedTracks
                        ) {
                            try {
                                recordHistoryEvent({
                                    artistId: historyContext.artistId,
                                    albumId: historyContext.albumId,
                                    mediaId: historyContext.mediaId,
                                    eventType: HISTORY_EVENT_TYPES.AlbumImportIncomplete,
                                    quality: historyContext.quality,
                                    sourceTitle: String(resolved?.title || tidalId),
                                    data: {
                                        type,
                                        tidalId,
                                        originalJobId: originalJobId ?? null,
                                        processedTrackIds: {
                                            count: organizeResult.processedTrackIds.length,
                                            expected: expectedProcessedTracks,
                                        },
                                    },
                                });
                            } catch (historyError) {
                                console.warn(`[Scheduler] Failed to write AlbumImportIncomplete history event for ${type} ${tidalId}:`, historyError);
                            }
                        }

                        this.updateDownloadQueueState(job, {
                            progress: 100,
                            description: 'ImportDownload: completed',
                            currentFileNum: organizeResult.processedTrackIds.length,
                            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                            statusMessage: 'Import completed',
                            state: 'completed',
                        });

                        // Emit completed event using original download job ID
                        downloadEvents.emitCompleted(originalJobId || job.id, {
                            tidalId,
                            type,
                            title: resolved?.title,
                            artist: resolved?.artist,
                            cover: resolved?.cover,
                        });

                        // Keep staged files on failed imports so retries can reuse them.
                        // Cleanup only once the import workflow has fully completed.
                        shouldCleanupDownloadPath = true;

                        console.log(`[Scheduler] Successfully processed download ${type} ${tidalId}`);
                    } catch (error) {
                        // upgrade_queue is a transient worklist. If import/post-processing fails,
                        // clear the rows so a later retry can be recomputed from actual library state.
                        try {
                            if (type === 'album') {
                                db.prepare(`DELETE FROM upgrade_queue WHERE album_id = ?`).run(tidalId);
                            } else {
                                db.prepare(`DELETE FROM upgrade_queue WHERE media_id = ?`).run(tidalId);
                            }
                        } catch (cleanupError) {
                            console.error(`[Scheduler] Failed to reset upgrade_queue after ImportDownload failure for ${type} ${tidalId}:`, cleanupError);
                        }

                        const historyContext = resolveImportHistoryContext();
                        const message = error instanceof Error ? error.message : String(error);
                        try {
                            recordHistoryEvent({
                                artistId: historyContext.artistId,
                                albumId: historyContext.albumId,
                                mediaId: historyContext.mediaId,
                                eventType: HISTORY_EVENT_TYPES.DownloadFailed,
                                quality: historyContext.quality,
                                sourceTitle: String(resolved?.title || tidalId),
                                data: {
                                    type,
                                    tidalId,
                                    originalJobId: originalJobId ?? null,
                                    error: message,
                                },
                            });
                        } catch (historyError) {
                            console.warn(`[Scheduler] Failed to write DownloadFailed history event for ${type} ${tidalId}:`, historyError);
                        }

                        throw error;
                    } finally {
                        if (shouldCleanupDownloadPath) {
                            try { fs.rmSync(downloadPath, { recursive: true, force: true }); } catch { /* ignore */ }
                        }
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
                }                case JobTypes.ConfigPrune: {
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
            if (job.type === JobTypes.ImportDownload) {
                this.updateDownloadQueueState(job, {
                    progress: job.progress,
                    description: `ImportDownload: ${error?.message || 'Import failed'}`,
                    statusMessage: error?.message || 'Import failed',
                    state: 'importFailed',
                });
            }
            TaskQueueService.fail(job.id, error?.message || 'Unknown scheduler error');
        }
    }
}







