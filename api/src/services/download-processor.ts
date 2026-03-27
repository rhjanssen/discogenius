import { db } from '../database.js';
import { DOWNLOAD_JOB_TYPES, DOWNLOAD_OR_IMPORT_JOB_TYPES, JobOfType, JobTypes, TaskQueueService } from './queue.js';
import { spawn, ChildProcess } from 'child_process';
import { Config } from './config.js';
import {
    buildTidalDlNgEnv,
    getTidalDlNgCommand,
    parseProgress,
    initializeSettings as initializeTidalDlNgSettings,
    clearHistory,
    syncDiscogeniusSettings,
} from './tidal-dl-ng.js';
import { downloadEvents } from './download-events.js';
import { updateAlbumDownloadStatus } from './download-state.js';
import { readIntEnv } from '../utils/env.js';
import fs from 'fs';
import path from 'path';
import {
    buildStreamingMediaUrl,
    getDownloadBackendForMediaType,
    getDownloadWorkspacePath,
} from './download-routing.js';
import {
    ensureOrpheusRuntime,
    parseOrpheusProgress,
    spawnOrpheusDownload,
    syncOrpheusSettings,
    syncTokenToOrpheusSession,
} from './orpheus.js';
import { scanAlbumShallow, seedTrack, seedVideo } from './scanner.js';
import { loadStoredTidalToken } from './tidal-auth.js';
import type {
    DownloadAlbumJobPayload,
    DownloadMediaType,
    ImportDownloadJobPayload,
    DownloadPlaylistJobPayload,
    DownloadTrackJobPayload,
    DownloadVideoJobPayload,
    ResolvedDownloadMetadata,
} from './job-payloads.js';
import { processImportDownloadJob } from './import-download-service.js';

type DownloadJobPayload = DownloadTrackJobPayload | DownloadVideoJobPayload | DownloadAlbumJobPayload | DownloadPlaylistJobPayload;
type DownloadJobType = Extract<DownloadMediaType, 'track' | 'video' | 'album' | 'playlist'>;
type DownloadOrImportJobPayload = DownloadJobPayload | ImportDownloadJobPayload;

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_DOWNLOAD_POLL_MS', 2000, 1); // 2 seconds default
const MAX_RETRY_ATTEMPTS = readIntEnv('DISCOGENIUS_DOWNLOAD_MAX_RETRY_ATTEMPTS', 3, 1);
const DOWNLOAD_TIMEOUT_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_TIMEOUT_MS', 4 * 60 * 60 * 1000, 0); // 0 = disabled
const DOWNLOAD_IDLE_TIMEOUT_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_IDLE_TIMEOUT_MS', 10 * 60 * 1000, 0); // 0 = disabled
const BUSY_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_BUSY_LOG_THROTTLE_MS', 30_000, 0);
const STUCK_JOB_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_STUCK_JOB_MS', 15 * 60 * 1000, 0); // 0 = disabled
const STUCK_CLEANUP_INTERVAL_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_STUCK_CLEANUP_INTERVAL_MS', 60_000, 1);

// Docker: tidal-dl-ng/ffmpeg installed globally via Dockerfile. Local dev uses PATH + buildTidalDlNgEnv.

/**
 * Enhanced Download Processor with real-time progress tracking
 * Emits events for SSE streaming to frontend
 */

export class DownloadProcessor {
    private processing: boolean = false;
    private isPaused: boolean = false;
    private currentProcess?: ChildProcess;
    private currentJobId?: number;
    private currentTidalId?: string;
    private currentType?: string;
    private currentDownloadPath?: string;
    private pollTimer?: NodeJS.Timeout;
    private cancelCurrentDownload: boolean = false;
    private lastBusyLogAt: number = 0;
    private lastStuckCleanupAt: number = 0;

    private scheduleNext(): void {
        setImmediate(() => {
            this.processQueue().catch((error) => {
                console.error('[DOWNLOAD-PROCESSOR] Error scheduling next queue item:', error);
            });
        });
    }

    private logBusy(): void {
        if (BUSY_LOG_THROTTLE_MS <= 0) return;

        const now = Date.now();
        if (now - this.lastBusyLogAt >= BUSY_LOG_THROTTLE_MS) {
            this.lastBusyLogAt = now;
            console.log('[DOWNLOAD-PROCESSOR] Queue poll skipped: another download is still running');
        }
    }

    private maybeCleanupStuckJobs(): void {
        if (STUCK_JOB_MS <= 0 || this.processing) return;

        const now = Date.now();
        if (now - this.lastStuckCleanupAt < STUCK_CLEANUP_INTERVAL_MS) {
            return;
        }
        this.lastStuckCleanupAt = now;

        const recovered = TaskQueueService.requeueStaleProcessingJobsByTypes({
            types: DOWNLOAD_OR_IMPORT_JOB_TYPES,
            olderThanMs: STUCK_JOB_MS,
            excludeIds: this.currentJobId ? [this.currentJobId] : [],
        });

        if (recovered > 0) {
            console.warn(`[DOWNLOAD-PROCESSOR] Re-queued ${recovered} stale download job(s)`);
        }
    }

    private async hasDownloadedMediaFiles(downloadPath?: string): Promise<boolean> {
        if (!downloadPath) return false;
        try {
            await fs.promises.access(downloadPath);
        } catch {
            return false;
        }

        const walk = async (dir: string): Promise<boolean> => {
            try {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (await walk(fullPath)) return true;
                        continue;
                    }

                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.flac', '.m4a', '.mp3', '.aac', '.wav', '.ogg', '.opus', '.aif', '.aiff', '.mp4', '.mkv', '.mov', '.m4v', '.webm', '.ts'].includes(ext)) {
                        return true;
                    }
                }
            } catch {
                // Ignore dir read errors
            }
            return false;
        };

        return walk(downloadPath);
    }

    private async cleanupDownloadSourcePath(): Promise<void> {
        if (!this.currentDownloadPath) {
            return;
        }

        try {
            await fs.promises.rm(this.currentDownloadPath, { recursive: true, force: true });
            console.log(`[DOWNLOAD-PROCESSOR] Cleaned up download source path: ${this.currentDownloadPath}`);
        } catch {
            // ignore cleanup errors
        }

        this.currentDownloadPath = undefined;
    }

    private hasAlbumMetadataReady(albumId: string): boolean {
        const row = db.prepare(`
            SELECT
                a.id,
                a.title,
                a.artist_id,
                ar.name as artist_name,
                a.num_tracks,
                COUNT(m.id) as track_count
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
            LEFT JOIN media m ON m.album_id = a.id AND m.type != 'Music Video'
            WHERE a.id = ?
            GROUP BY a.id, a.title, a.artist_id, ar.name, a.num_tracks
        `).get(albumId) as any;

        if (!row?.id || !row?.title || !row?.artist_id || !row?.artist_name) {
            return false;
        }

        const expectedTracks = Number(row.num_tracks || 0);
        const trackCount = Number(row.track_count || 0);
        if (expectedTracks <= 0) {
            return trackCount > 0;
        }

        return trackCount >= expectedTracks;
    }

    private hasTrackMetadataReady(trackId: string): boolean {
        const row = db.prepare(`
            SELECT m.id, m.title, m.artist_id, m.album_id, a.id as album_exists
            FROM media m
            LEFT JOIN albums a ON a.id = m.album_id
            WHERE m.id = ?
        `).get(trackId) as any;

        return Boolean(row?.id && row?.title && row?.artist_id && row?.album_id && row?.album_exists);
    }

    private hasVideoMetadataReady(videoId: string): boolean {
        const row = db.prepare(`
            SELECT id, title, artist_id
            FROM media
            WHERE id = ? AND type = 'Music Video'
        `).get(videoId) as any;

        return Boolean(row?.id && row?.title && row?.artist_id);
    }

    private async ensureMetadataReady(
        tidalId: string,
        type: 'track' | 'video' | 'album' | 'playlist',
    ): Promise<void> {
        switch (type) {
            case 'album':
                if (!this.hasAlbumMetadataReady(tidalId)) {
                    console.log(`[DOWNLOAD-PROCESSOR] Album ${tidalId} is missing complete metadata; running album scan before download`);
                    await scanAlbumShallow(tidalId, {
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                }
                return;
            case 'track':
                if (!this.hasTrackMetadataReady(tidalId)) {
                    console.log(`[DOWNLOAD-PROCESSOR] Track ${tidalId} is missing metadata; seeding track before download`);
                    await seedTrack(tidalId, {
                        includeSimilarArtists: false,
                        seedSimilarArtists: false,
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                }
                return;
            case 'video':
                if (!this.hasVideoMetadataReady(tidalId)) {
                    console.log(`[DOWNLOAD-PROCESSOR] Video ${tidalId} is missing metadata; seeding video before download`);
                    await seedVideo(tidalId, {
                        includeSimilarArtists: false,
                        seedSimilarArtists: false,
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                }
                return;
            default:
                return;
        }
    }

    private resolveDownloadMetadata(
        tidalId: string,
        type: DownloadJobType,
        payload: DownloadJobPayload,
    ): Required<ResolvedDownloadMetadata> {
        const fallbackTitle = payload?.title;
        const fallbackArtist = payload?.artist;
        const fallbackCover = payload?.cover ?? null;

        try {
            if (type === 'album') {
                const row = db.prepare(`
                    SELECT a.title, a.cover, ar.name as artist_name
                    FROM albums a
                    LEFT JOIN artists ar ON ar.id = a.artist_id
                    WHERE a.id = ?
                `).get(tidalId) as any;
                return {
                    title: fallbackTitle || row?.title || 'Unknown',
                    artist: fallbackArtist || row?.artist_name || 'Unknown',
                    cover: fallbackCover ?? row?.cover ?? null,
                };
            }

            if (type === 'video') {
                const row = db.prepare(`
                    SELECT m.title, m.cover as video_cover, ar.name as artist_name, a.cover as album_cover
                    FROM media m
                    LEFT JOIN artists ar ON ar.id = m.artist_id
                    LEFT JOIN albums a ON a.id = m.album_id
                    WHERE m.id = ? AND m.type = 'Music Video'
                `).get(tidalId) as any;
                return {
                    title: fallbackTitle || row?.title || 'Unknown',
                    artist: fallbackArtist || row?.artist_name || 'Unknown',
                    cover: fallbackCover ?? row?.video_cover ?? row?.album_cover ?? null,
                };
            }

            const row = db.prepare(`
                SELECT m.title, ar.name as artist_name, a.cover as album_cover
                FROM media m
                LEFT JOIN artists ar ON ar.id = m.artist_id
                LEFT JOIN albums a ON a.id = m.album_id
                WHERE m.id = ?
            `).get(tidalId) as any;
            return {
                title: fallbackTitle || row?.title || 'Unknown',
                artist: fallbackArtist || row?.artist_name || 'Unknown',
                cover: fallbackCover ?? row?.album_cover ?? null,
            };
        } catch {
            return { title: fallbackTitle || 'Unknown', artist: fallbackArtist || 'Unknown', cover: fallbackCover };
        }
    }

    private persistDownloadState(jobId: number, state: {
        progress?: number;
        description?: string;
        currentFileNum?: number;
        totalFiles?: number;
        currentTrack?: string;
        trackProgress?: number;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        statusMessage?: string;
        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
        speed?: string;
        eta?: string;
        size?: number;
        sizeleft?: number;
        tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];
    }) {
        const payloadPatch: Record<string, unknown> = {
            downloadState: {
                progress: state.progress,
                currentFileNum: state.currentFileNum,
                totalFiles: state.totalFiles,
                currentTrack: state.currentTrack,
                trackProgress: state.trackProgress,
                trackStatus: state.trackStatus,
                statusMessage: state.statusMessage,
                state: state.state,
                speed: state.speed,
                eta: state.eta,
                size: state.size,
                sizeleft: state.sizeleft,
                tracks: state.tracks,
            },
        };

        if (state.description) {
            payloadPatch.description = state.description;
        }

        TaskQueueService.updateState(jobId, {
            progress: state.progress,
            payloadPatch,
        });
    }

    async initialize() {
        console.log('[DOWNLOAD-PROCESSOR] Initializing...');

        // Optional: start in paused mode (useful for LAN testing / avoiding background load)
        if (process.env.DISCOGENIUS_START_PAUSED === '1') {
            this.isPaused = true;
        }

        // Initialize download backends with current settings
        try {
            await initializeTidalDlNgSettings();
            await syncOrpheusSettings();
            console.log('[DOWNLOAD-PROCESSOR] Download backend settings initialized');
        } catch (error) {
            console.warn('[DOWNLOAD-PROCESSOR] Could not initialize download backend settings:', error);
            // Continue anyway - settings might already be configured
        }

        // Reset any items that were "downloading" (processing) during crash/restart
        // This ensures interrupted downloads are safely re-queued on app startup
        try {
            // Query for jobs that were stuck in processing state (likely from crash/restart)
            const stuckJobs = db.prepare(`
                SELECT id, type, ref_id, payload, created_at, started_at 
                FROM job_queue 
                WHERE status = 'processing' AND type IN (${DOWNLOAD_OR_IMPORT_JOB_TYPES.map(() => '?').join(',')})
                ORDER BY started_at ASC
            `).all(...DOWNLOAD_OR_IMPORT_JOB_TYPES) as any[];

            if (stuckJobs.length > 0) {
                // Log details of what we're recovering (for diagnostic purposes)
                console.log(`[DOWNLOAD-PROCESSOR] Found ${stuckJobs.length} interrupted download job(s) from previous crash/restart:`);
                stuckJobs.forEach(job => {
                    console.log(`  - [${job.id}] ${job.type} ${job.ref_id}: "${(() => { try { const parsed = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload; return parsed?.title || "unknown"; } catch { return "unknown"; } })()}" (started ${new Date(job.started_at).toISOString()})`);
                });

                // Reset to pending state - will be picked up by next processQueue() call
                const recovered = TaskQueueService.resetProcessingJobsByTypes(DOWNLOAD_OR_IMPORT_JOB_TYPES);
                console.log(`[DOWNLOAD-PROCESSOR] Successfully re-queued ${recovered} interrupted download/import job(s) to pending state`);
            }
        } catch (error) {
            console.error('[DOWNLOAD-PROCESSOR] Error during restart recovery:', error);
            // Non-fatal: continue with normal operation; jobs may be recovered on next cleanup cycle
        }

        // We no longer rely on a background poll loop for the download queue.
        // It's purely event-driven: triggered on app startup, when items are added, or when the previous item finishes.
        await this.processQueue();
    }

    async processQueue(): Promise<void> {
        if (process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') {
            return;
        }

        if (this.isPaused) {
            return;
        }

        if (this.processing) {
            this.logBusy();
            return;
        }

        this.maybeCleanupStuckJobs();

        const job = TaskQueueService.getNextJobByTypes(DOWNLOAD_OR_IMPORT_JOB_TYPES);

        if (!job) {
            return;
        }

        // Check retry limit - if job has exceeded max attempts, fail permanently
        if (job.attempts >= MAX_RETRY_ATTEMPTS) {
            console.warn(`[DOWNLOAD-PROCESSOR] Job #${job.id} exceeded max retries (${job.attempts}/${MAX_RETRY_ATTEMPTS}), marking as permanently failed`);
            TaskQueueService.fail(job.id, `Exceeded maximum retry attempts (${MAX_RETRY_ATTEMPTS})`);
            // Continue to next job without recursive await chains.
            this.scheduleNext();
            return;
        }

        this.processing = true;
        this.cancelCurrentDownload = false;
        this.currentJobId = job.id;
        const isImportJob = job.type === JobTypes.ImportDownload;
        const importPayload = isImportJob ? job.payload as ImportDownloadJobPayload : null;
        const tidalId = String(importPayload?.tidalId || job.ref_id || job.payload?.tidalId || '');
        const type: DownloadJobType = isImportJob
            ? importPayload?.type as DownloadJobType
            : job.type === JobTypes.DownloadVideo
                ? 'video'
                : job.type === JobTypes.DownloadAlbum
                    ? 'album'
                    : job.type === JobTypes.DownloadPlaylist
                        ? 'playlist'
                        : 'track';

        if (!type) {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid type: ${job.type}`);
            TaskQueueService.fail(job.id, `Invalid job type - cannot ${isImportJob ? 'import' : 'download'}`);
            this.processing = false;
            this.currentJobId = undefined;
            this.scheduleNext();
            return;
        }

        // Validate tidalId before processing
        if (!tidalId || tidalId === 'undefined' || tidalId === 'null') {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid tidalId: ${tidalId}`);
            TaskQueueService.fail(job.id, `Invalid tidalId - cannot ${isImportJob ? 'import' : 'download'}`);
            this.processing = false;
            this.currentJobId = undefined;
            // Process next item
            this.scheduleNext();
            return;
        }
        this.currentTidalId = tidalId;
        this.currentType = type;
        this.currentDownloadPath = undefined;
        let payload = job.payload as DownloadOrImportJobPayload;

        console.log(`[DOWNLOAD-PROCESSOR] Processing Job #${job.id}: ${job.type} (ref: ${tidalId})`);

        TaskQueueService.markProcessing(job.id);
        let resolved = {
            title: importPayload?.resolved?.title || payload?.title || 'Unknown',
            artist: importPayload?.resolved?.artist || payload?.artist || 'Unknown',
            cover: importPayload?.resolved?.cover ?? payload?.cover ?? null,
        };

        if (isImportJob) {
            const emitImportProgress = (state: Parameters<typeof this.persistDownloadState>[1]) => {
                this.persistDownloadState(job.id, state);
                downloadEvents.emitProgress(job.id, {
                    tidalId,
                    type,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                    progress: state.progress ?? job.progress ?? 0,
                    currentFileNum: state.currentFileNum,
                    totalFiles: state.totalFiles,
                    currentTrack: state.currentTrack,
                    trackProgress: state.trackProgress,
                    trackStatus: state.trackStatus,
                    statusMessage: state.statusMessage,
                    state: state.state,
                });
            };

            try {
                await processImportDownloadJob(job as JobOfType<typeof JobTypes.ImportDownload>, {
                    updateState: emitImportProgress,
                });

                TaskQueueService.complete(job.id);
                downloadEvents.emitCompleted(job.id, {
                    tidalId,
                    type,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                });
                console.log(`[DOWNLOAD-PROCESSOR] Successfully imported ${type} ${tidalId}`);
            } catch (error: any) {
                console.error(`[DOWNLOAD-PROCESSOR] Failed to import job #${job.id}:`, error);
                this.persistDownloadState(job.id, {
                    progress: job.progress,
                    description: `ImportDownload: ${error?.message || 'Import failed'}`,
                    statusMessage: error?.message || 'Import failed',
                    state: 'importFailed',
                });
                TaskQueueService.fail(job.id, error?.message || 'Unknown import error');
                downloadEvents.emitFailed(job.id, {
                    tidalId,
                    type,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                    error: error?.message || 'Unknown import error',
                    state: 'importFailed',
                });
            } finally {
                this.processing = false;
                this.currentProcess = undefined;
                this.currentJobId = undefined;
                this.currentTidalId = undefined;
                this.currentType = undefined;
                this.cancelCurrentDownload = false;
                this.scheduleNext();
            }

            return;
        }

        try {
            this.persistDownloadState(job.id, {
                progress: 0,
                state: 'queued',
                statusMessage: 'Preparing metadata...',
            });

            await this.ensureMetadataReady(tidalId, type);

            resolved = this.resolveDownloadMetadata(tidalId, type, payload);
            payload = { ...((payload as DownloadJobPayload) || {}), title: resolved.title, artist: resolved.artist, cover: resolved.cover };
            job.payload = payload as DownloadJobPayload;

            this.persistDownloadState(job.id, {
                progress: 0,
                state: 'downloading',
                statusMessage: 'Starting download...',
            });
            downloadEvents.emitStarted(job.id, {
                tidalId,
                type,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
            });

            await this.downloadItem(job.id, tidalId, type, payload);

            // Check if the item-specific download path has any media files before attempting organization.
            // tidal-dl-ng may skip all items (e.g. "already in history") and exit successfully
            // without producing any new files.
            if (!await this.hasDownloadedMediaFiles(this.currentDownloadPath)) {
                // tidal-dl-ng exited 0 but downloaded nothing.
                // Check if content already exists in library — if so, treat as already-imported.
                if (type === 'album') {
                    const row = db.prepare(
                        `SELECT COUNT(DISTINCT m.id) as total,
                                COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN m.id END) as done
                         FROM media m
                         LEFT JOIN library_files lf
                           ON lf.media_id = m.id
                          AND lf.file_type = 'track'
                         WHERE m.album_id = ? AND m.type != 'Music Video'`
                    ).get(tidalId) as any;

                    if (payload?.reason !== 'upgrade' && row && row.total > 0 && row.done > 0) {
                        // Album has at least some tracks downloaded.  tidal-dl-ng
                        // couldn't add anything new (items skipped or unavailable).
                        const pct = Math.round(row.done / row.total * 100);
                        console.log(
                            `[DOWNLOAD-PROCESSOR] Download workspace empty but album ${tidalId} already has ${row.done}/${row.total} tracks downloaded (${pct}%). ` +
                            `Remaining tracks may be unavailable on TIDAL — treating as complete.`
                        );

                        // Mark undownloadable tracks so the queue doesn't re-queue endlessly
                        updateAlbumDownloadStatus(String(tidalId));

                        TaskQueueService.complete(job.id);
                        await this.cleanupDownloadSourcePath();

                        downloadEvents.emitCompleted(job.id, {
                            tidalId, type,
                            title: resolved.title,
                            artist: resolved.artist,
                            cover: resolved.cover,
                        });

                        return;
                    }
                } else if (type === 'track' || type === 'video') {
                    const row = db.prepare(`
                        SELECT 1
                        FROM library_files
                        WHERE media_id = ?
                          AND file_type = ?
                        LIMIT 1
                    `).get(tidalId, type === 'video' ? 'video' : 'track') as any;

                    if (payload?.reason !== 'upgrade' && row) {
                        console.log(`[DOWNLOAD-PROCESSOR] Download workspace empty but ${type} ${tidalId} is already downloaded — marking job as complete.`);
                        TaskQueueService.complete(job.id);
                        await this.cleanupDownloadSourcePath();

                        downloadEvents.emitCompleted(job.id, {
                            tidalId, type,
                            title: resolved.title,
                            artist: resolved.artist,
                            cover: resolved.cover,
                        });

                        return;
                    }
                }

                // Nothing in library either — something is genuinely wrong
                throw new Error(
                    `tidal-dl-ng finished successfully but no files were downloaded for ${type} ${tidalId}. ` +
                    `All items may have been skipped (already in tidal-dl-ng history or unavailable on TIDAL).`
                );
            }

            // Organize into library (dispatched to the import/finalization queue)
            TaskQueueService.addJob(JobTypes.ImportDownload, {
                type,
                tidalId,
                path: this.currentDownloadPath,
                resolved,
                originalJobId: job.id
            }, tidalId, Math.max(job.priority, 100), job.trigger, job.queue_order);

            TaskQueueService.complete(job.id);

            // The ImportDownload job will clean up the item workspace after import.
            this.currentDownloadPath = undefined;

            // Note: We do NOT emit completed event here, it will be emitted by ImportDownload
            console.log(`[DOWNLOAD-PROCESSOR] Successfully downloaded ${type} ${tidalId} - dispatched to import queue`);
        } catch (error: any) {
            if (this.cancelCurrentDownload && this.isPaused) {
                const current = TaskQueueService.getById(job.id);
                if (current?.status === 'processing') {
                    console.log(`[DOWNLOAD-PROCESSOR] Download job #${job.id} interrupted by pause; returning to queue`);
                    TaskQueueService.retry(job.id);
                } else {
                    console.log(`[DOWNLOAD-PROCESSOR] Download job #${job.id} interrupted by pause; keeping status=${current?.status ?? 'unknown'}`);
                }
            } else {
                console.error(`[DOWNLOAD-PROCESSOR] Failed to download job #${job.id}:`, error);
                const currentJob = TaskQueueService.getById(job.id);
                this.persistDownloadState(job.id, {
                    progress: currentJob?.progress ?? job.progress,
                    state: 'failed',
                    statusMessage: error?.message || 'Unknown download error',
                });
                TaskQueueService.fail(job.id, error?.message || 'Unknown download error');

                // Emit failed event
                downloadEvents.emitFailed(job.id, {
                    tidalId,
                    type,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                    error: error?.message || 'Unknown download error',
                });
            }

            // Cleanup failed downloads so the next attempt gets a clean item workspace.
            await this.cleanupDownloadSourcePath();
        } finally {
            this.processing = false;
            this.currentProcess = undefined;
            this.currentJobId = undefined;
            this.currentTidalId = undefined;
            this.currentType = undefined;
            this.cancelCurrentDownload = false;

            // Process next item
            this.scheduleNext();
        }
    }

    private async downloadItem(
        jobId: number,
        id: string,
        type: DownloadJobType,
        payload: DownloadJobPayload
    ): Promise<void> {
        const downloadPath = getDownloadWorkspacePath(type, id);
        this.currentDownloadPath = downloadPath;

        // Ensure the target subtree is empty before starting.
        try {
            await fs.promises.rm(downloadPath, { recursive: true, force: true });
        } catch {
            // ignore
        }
        await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });

        return new Promise((resolve, reject) => {
            const tidalUrl = buildStreamingMediaUrl(type, id);
            const backend = getDownloadBackendForMediaType(type);

            console.log(`[DOWNLOAD-PROCESSOR] Downloading ${type} ${id} from ${tidalUrl} via ${backend}`);

            const qualityConfig = Config.getQualityConfig();
            console.log(
                `[DOWNLOAD-PROCESSOR] Using current settings: audio=${qualityConfig?.audio_quality || 'max'}, ` +
                `video=${qualityConfig?.video_quality || 'fhd'}`
            );

            const configureAndDownload = async () => {
                try {
                    let downloadProcess: ChildProcess;
                    if (backend === 'tidal-dl-ng') {
                        clearHistory();
                        await syncDiscogeniusSettings(downloadPath);
                        const env = buildTidalDlNgEnv();
                        const args = ['dl', tidalUrl];
                        console.log(`[DOWNLOAD-PROCESSOR] Running: tidal-dl-ng ${args.join(' ')}`);
                        console.log(`[DOWNLOAD-PROCESSOR] Download path: ${downloadPath}`);
                        const cmd = getTidalDlNgCommand();
                        downloadProcess = spawn(cmd.command, [...cmd.args, ...args], { env });
                    } else {
                        const token = loadStoredTidalToken();
                        if (!token?.access_token) {
                            throw new Error('TIDAL authentication is required before starting Orpheus downloads');
                        }
                        await ensureOrpheusRuntime();
                        await syncTokenToOrpheusSession(token);
                        await syncOrpheusSettings(downloadPath);
                        console.log(`[DOWNLOAD-PROCESSOR] Running: orpheus.py download tidal ${type} ${id}`);
                        console.log(`[DOWNLOAD-PROCESSOR] Download path: ${downloadPath}`);
                        downloadProcess = await spawnOrpheusDownload(type as 'track' | 'album' | 'playlist', id, downloadPath);
                    }

                    this.currentProcess = downloadProcess;

                    let settled = false;
                    let hardTimeout: NodeJS.Timeout | undefined;
                    let idleTimeout: NodeJS.Timeout | undefined;

                    const clearTimeouts = () => {
                        if (hardTimeout) {
                            clearTimeout(hardTimeout);
                            hardTimeout = undefined;
                        }
                        if (idleTimeout) {
                            clearTimeout(idleTimeout);
                            idleTimeout = undefined;
                        }
                    };

                    const finish = (error?: Error) => {
                        if (settled) return;
                        settled = true;
                        clearTimeouts();

                        if (error) {
                            // If this was an upgrade and it failed, mark it 'skipped' to avoid infinite loops
                            try {
                                if (type === 'album') {
                                    db.prepare(`UPDATE upgrade_queue SET status = 'skipped' WHERE album_id = ? AND status = 'pending'`).run(id);
                                } else {
                                    db.prepare(`UPDATE upgrade_queue SET status = 'skipped' WHERE media_id = ? AND status = 'pending'`).run(id);
                                }
                            } catch (e) {
                                console.error(`[DOWNLOAD-PROCESSOR] Failed to update upgrade_queue skip-list for ${id}:`, e);
                            }
                            reject(error);
                        } else {
                            resolve();
                        }
                    };

                    const resetIdleTimeout = () => {
                        if (DOWNLOAD_IDLE_TIMEOUT_MS <= 0) return;
                        if (idleTimeout) clearTimeout(idleTimeout);

                        idleTimeout = setTimeout(() => {
                            if (settled) return;
                            const message = `Download idle timeout (${DOWNLOAD_IDLE_TIMEOUT_MS}ms) for job ${jobId}`;
                            console.error(`[DOWNLOAD-PROCESSOR] ${message}`);
                            if (!downloadProcess.killed) {
                                downloadProcess.kill('SIGKILL');
                            }
                            finish(new Error(message));
                        }, DOWNLOAD_IDLE_TIMEOUT_MS);
                    };

                    if (DOWNLOAD_TIMEOUT_MS > 0) {
                        hardTimeout = setTimeout(() => {
                            if (settled) return;
                            const message = `Download timeout (${DOWNLOAD_TIMEOUT_MS}ms) for job ${jobId}`;
                            console.error(`[DOWNLOAD-PROCESSOR] ${message}`);
                            if (!downloadProcess.killed) {
                                downloadProcess.kill('SIGKILL');
                            }
                            finish(new Error(message));
                        }, DOWNLOAD_TIMEOUT_MS);
                    }

                    resetIdleTimeout();

                    let lastProgress = 0;
                    let completedTracks = 0;
                    let totalTracks = 0;
                    const trackProgress: Map<string, number> = new Map();
                    let currentTrackName = '';
                    let statusMessage = '';

                    // Pre-fetch track list and total count from DB for album downloads
                    // so we don't rely on tidal-dl-ng list progress output (which some forks don't emit)
                    type AlbumTrackInfo = { title: string; trackNum: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' };
                    let albumTracks: AlbumTrackInfo[] = [];
                    let currentTrackIndex = -1;
                    if (type === 'album') {
                        try {
                            const rows = db.prepare(`
                                SELECT m.title,
                                       m.version,
                                       m.track_number as track_num,
                                       COALESCE(m.volume_number, 1) as volume_num,
                                       ar.name as artist_name
                                FROM media m
                                LEFT JOIN artists ar ON ar.id = m.artist_id
                                WHERE m.album_id = ? AND m.type != 'Music Video'
                                ORDER BY m.volume_number, m.track_number
                            `).all(id) as any[];
                            if (rows.length > 0) {
                                totalTracks = rows.length;
                                const hasMultipleVolumes = rows.some((row) => Number(row.volume_num || 1) > 1);
                                albumTracks = rows.map((row) => {
                                    const normalizedVersion = String(row.version || '').trim();
                                    const baseTitle = normalizedVersion && !row.title?.toLowerCase().includes(normalizedVersion.toLowerCase())
                                        ? `${row.title} (${normalizedVersion})`
                                        : row.title;
                                    return {
                                        title: row.artist_name ? `${row.artist_name} - ${baseTitle}` : baseTitle,
                                        trackNum: hasMultipleVolumes
                                            ? (Number(row.volume_num || 1) * 100) + Number(row.track_num || 0)
                                            : Number(row.track_num || 0),
                                        status: 'queued' as const,
                                    };
                                });
                            }
                        } catch (e) {
                            console.warn(`[DOWNLOAD-PROCESSOR] Could not pre-fetch album tracks for ${id}:`, e);
                        }
                    }

                    // Helper to mark a track as completed/downloading in the albumTracks list
                    const normalizeTrackMatchText = (value: string) => value
                        .toLowerCase()
                        .replace(/^[^-]+\s-\s/, '')
                        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
                        .replace(/[^a-z0-9]+/g, ' ')
                        .trim();

                    const updateAlbumTrackStatus = (
                        trackTitle: string,
                        status: 'downloading' | 'completed' | 'error' | 'skipped',
                        preferredIndex?: number,
                    ) => {
                        if (albumTracks.length === 0) return;

                        if (preferredIndex !== undefined && preferredIndex >= 0 && preferredIndex < albumTracks.length) {
                            albumTracks[preferredIndex].status = status;
                            return;
                        }

                        const normalizedIncoming = normalizeTrackMatchText(trackTitle);
                        const idx = albumTracks.findIndex((track) => {
                            if (track.status === 'completed' || track.status === 'error' || track.status === 'skipped') {
                                return false;
                            }

                            const normalizedTrack = normalizeTrackMatchText(track.title);
                            return normalizedIncoming === normalizedTrack
                                || normalizedIncoming.includes(normalizedTrack)
                                || normalizedTrack.includes(normalizedIncoming);
                        });

                        if (idx >= 0) {
                            albumTracks[idx].status = status;
                        }
                    };

                    const emitDownloadProgress = (state: {
                        progress: number;
                        currentFileNum?: number;
                        totalFiles?: number;
                        currentTrack?: string;
                        trackProgress?: number;
                        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
                        statusMessage?: string;
                        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
                        speed?: string;
                        eta?: string;
                        size?: number;
                        sizeleft?: number;
                        tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];
                    }) => {
                        this.persistDownloadState(jobId, state);
                        downloadEvents.emitProgress(jobId, {
                            tidalId: id,
                            type,
                            title: payload.title,
                            artist: payload.artist,
                            cover: payload.cover,
                            progress: state.progress,
                            currentFileNum: state.currentFileNum,
                            totalFiles: state.totalFiles,
                            currentTrack: state.currentTrack,
                            trackProgress: state.trackProgress,
                            trackStatus: state.trackStatus,
                            statusMessage: state.statusMessage,
                            state: state.state,
                            speed: state.speed,
                            eta: state.eta,
                            size: state.size,
                            sizeleft: state.sizeleft,
                            tracks: state.tracks,
                        });
                    };

                    const handleOrpheusProgress = (progress: ReturnType<typeof parseOrpheusProgress>) => {
                        if (!progress) {
                            return false;
                        }

                        if (progress.statusMessage) {
                            statusMessage = progress.statusMessage;
                        }

                        if (progress.currentTrack && progress.totalTracks) {
                            totalTracks = progress.totalTracks;
                            completedTracks = Math.max(0, progress.currentTrack - 1);
                            currentTrackIndex = Math.max(0, progress.currentTrack - 1);
                            const overallProgress = Math.round((completedTracks / progress.totalTracks) * 100);
                            lastProgress = Math.max(lastProgress, overallProgress);
                            emitDownloadProgress({
                                progress: overallProgress,
                                currentFileNum: progress.currentTrack,
                                totalFiles: progress.totalTracks,
                                currentTrack: currentTrackName || undefined,
                                state: 'downloading',
                                statusMessage,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        if (progress.currentTrackName) {
                            currentTrackName = progress.currentTrackName;
                            updateAlbumTrackStatus(progress.currentTrackName, 'downloading', currentTrackIndex);
                            emitDownloadProgress({
                                progress: lastProgress,
                                currentFileNum: totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : 1,
                                totalFiles: totalTracks || undefined,
                                currentTrack: currentTrackName,
                                trackStatus: 'downloading',
                                state: 'downloading',
                                statusMessage: progress.statusMessage || statusMessage,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        if (progress.trackProgress !== undefined) {
                            if (currentTrackName) {
                                trackProgress.set(currentTrackName, progress.trackProgress);
                                updateAlbumTrackStatus(currentTrackName, 'downloading', currentTrackIndex);
                            }

                            const currentFileNum = totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : 1;
                            const overallProgress = totalTracks > 0
                                ? Math.round(((completedTracks + progress.trackProgress / 100) / totalTracks) * 100)
                                : progress.trackProgress;
                            lastProgress = Math.max(lastProgress, overallProgress);
                            emitDownloadProgress({
                                progress: overallProgress,
                                currentFileNum,
                                totalFiles: totalTracks || undefined,
                                currentTrack: currentTrackName || undefined,
                                trackProgress: progress.trackProgress,
                                trackStatus: currentTrackName ? 'downloading' : undefined,
                                state: 'downloading',
                                statusMessage,
                                speed: progress.speed,
                                eta: progress.eta,
                                size: progress.size,
                                sizeleft: progress.sizeleft,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        if (progress.isTrackComplete) {
                            completedTracks += 1;
                            if (currentTrackName) {
                                trackProgress.set(currentTrackName, 100);
                                updateAlbumTrackStatus(currentTrackName, 'completed', currentTrackIndex);
                            }
                            const overallProgress = totalTracks > 0
                                ? Math.round((completedTracks / totalTracks) * 100)
                                : 100;
                            lastProgress = Math.max(lastProgress, overallProgress);
                            emitDownloadProgress({
                                progress: overallProgress,
                                currentFileNum: completedTracks,
                                totalFiles: totalTracks || undefined,
                                currentTrack: currentTrackName || undefined,
                                trackProgress: currentTrackName ? 100 : undefined,
                                trackStatus: currentTrackName ? 'completed' : undefined,
                                state: 'downloading',
                                statusMessage: progress.statusMessage || statusMessage,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        if (progress.isTrackFailed) {
                            if (currentTrackName) {
                                updateAlbumTrackStatus(currentTrackName, 'error', currentTrackIndex);
                            }
                            emitDownloadProgress({
                                progress: lastProgress,
                                currentFileNum: totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : 1,
                                totalFiles: totalTracks || undefined,
                                currentTrack: currentTrackName || undefined,
                                trackStatus: currentTrackName ? 'error' : undefined,
                                state: 'downloading',
                                statusMessage: progress.statusMessage || statusMessage,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        if (progress.isEntityComplete) {
                            emitDownloadProgress({
                                progress: 100,
                                currentFileNum: totalTracks || completedTracks,
                                totalFiles: totalTracks || completedTracks,
                                state: 'completed',
                                statusMessage: progress.statusMessage || statusMessage,
                                tracks: albumTracks.length > 0 ? albumTracks.map(t => ({
                                    ...t,
                                    status: t.status === 'error' || t.status === 'skipped' ? t.status : 'completed' as const,
                                })) : undefined,
                            });
                        }

                        return true;
                    };

                    const handleTidalDlNgProgress = (progress: ReturnType<typeof parseProgress>) => {
                        if (!progress) {
                            return false;
                        }

                        const fallbackTrackTitle = currentTrackName || payload.title || payload.albumTitle || payload.playlistName;

                        if (progress.statusMessage) {
                            statusMessage = progress.statusMessage;
                        }

                        if (progress.totalTracks && progress.currentTrack) {
                            totalTracks = progress.totalTracks;
                            currentTrackIndex = Math.max(0, progress.currentTrack - 1);
                            const overallProgress = Math.round((progress.currentTrack / progress.totalTracks) * 100);

                            if (overallProgress !== lastProgress) {
                                lastProgress = overallProgress;
                                emitDownloadProgress({
                                    progress: overallProgress,
                                    currentFileNum: progress.currentTrack,
                                    totalFiles: progress.totalTracks,
                                    currentTrack: progress.listName || currentTrackName,
                                    state: progress.state || 'downloading',
                                    statusMessage,
                                    tracks: albumTracks.length > 0 ? albumTracks : undefined,
                                });
                            }
                        }

                        if (progress.isComplete && progress.trackTitle) {
                            completedTracks += 1;
                            trackProgress.set(progress.trackTitle, 100);
                            currentTrackName = progress.trackTitle;
                            updateAlbumTrackStatus(progress.trackTitle, progress.state === 'failed' ? 'error' : 'completed', currentTrackIndex);

                            const overallProgress = totalTracks > 0
                                ? Math.round((completedTracks / totalTracks) * 100)
                                : Math.round((completedTracks / Math.max(completedTracks, 1)) * 100);

                            emitDownloadProgress({
                                progress: overallProgress,
                                currentFileNum: completedTracks,
                                totalFiles: totalTracks,
                                currentTrack: progress.trackTitle,
                                trackProgress: 100,
                                trackStatus: progress.state === 'failed' ? 'error' : 'completed',
                                state: progress.state || 'downloading',
                                statusMessage: progress.statusMessage || `Downloaded: ${progress.trackTitle}`,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        } else if (progress.progress > 0 && progress.trackTitle) {
                            trackProgress.set(progress.trackTitle, progress.progress);
                            currentTrackName = progress.trackTitle;
                            updateAlbumTrackStatus(progress.trackTitle, 'downloading', currentTrackIndex);

                            const overallProgress = totalTracks > 0
                                ? Math.round(((completedTracks + progress.progress / 100) / totalTracks) * 100)
                                : progress.progress;

                            if (overallProgress !== lastProgress) {
                                lastProgress = overallProgress;
                                emitDownloadProgress({
                                    progress: overallProgress,
                                    currentFileNum: completedTracks + 1,
                                    totalFiles: totalTracks || undefined,
                                    currentTrack: progress.trackTitle,
                                    trackProgress: progress.progress,
                                    trackStatus: 'downloading',
                                    state: 'downloading',
                                    statusMessage,
                                    tracks: albumTracks.length > 0 ? albumTracks : undefined,
                                });
                            }
                        } else if (progress.progress > lastProgress) {
                            lastProgress = progress.progress;
                            emitDownloadProgress({
                                progress: progress.progress,
                                currentFileNum: totalTracks > 0 ? Math.min(totalTracks, completedTracks + 1) : undefined,
                                totalFiles: totalTracks || undefined,
                                currentTrack: fallbackTrackTitle || undefined,
                                trackProgress: fallbackTrackTitle ? progress.progress : undefined,
                                trackStatus: fallbackTrackTitle ? 'downloading' : undefined,
                                state: progress.state || 'downloading',
                                statusMessage,
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        if (progress.isListComplete && progress.listName) {
                            totalTracks = completedTracks;
                            emitDownloadProgress({
                                progress: 100,
                                currentFileNum: completedTracks,
                                totalFiles: completedTracks,
                                state: 'completed',
                                statusMessage: `Finished: ${progress.listName}`,
                                tracks: albumTracks.length > 0 ? albumTracks.map(t => ({
                                    ...t,
                                    status: t.status === 'error' || t.status === 'skipped' ? t.status : 'completed' as const,
                                })) : undefined,
                            });
                        }

                        if (progress.statusMessage && !progress.trackTitle && !progress.totalTracks && !progress.isListComplete) {
                            emitDownloadProgress({
                                progress: lastProgress,
                                currentFileNum: completedTracks > 0 ? completedTracks : undefined,
                                totalFiles: totalTracks || undefined,
                                currentTrack: fallbackTrackTitle || undefined,
                                trackProgress: fallbackTrackTitle
                                    ? (currentTrackName ? trackProgress.get(currentTrackName) : lastProgress)
                                    : undefined,
                                trackStatus: fallbackTrackTitle ? 'downloading' : undefined,
                                statusMessage: progress.statusMessage,
                                state: progress.state || 'downloading',
                                tracks: albumTracks.length > 0 ? albumTracks : undefined,
                            });
                        }

                        return true;
                    };

                    const handleBackendProgressLine = (line: string) => {
                        if (backend === 'tidal-dl-ng') {
                            return handleTidalDlNgProgress(parseProgress(line));
                        }

                        return handleOrpheusProgress(parseOrpheusProgress(line));
                    };

                    downloadProcess.stdout?.on("data", (data: Buffer) => {
                        try {
                            resetIdleTimeout();

                            const output = data.toString();
                            const lines = output.split(/\r?\n|\r/g);

                            for (const line of lines) {
                                if (!line.trim()) continue;
                                console.log(`[${backend}] ${line}`);
                                if (handleBackendProgressLine(line)) {
                                    continue;
                                }
                            }
                        } catch (error: any) {
                            const message = `Failed to parse download output for job ${jobId}: ${error?.message || 'unknown parser error'}`;
                            console.error(`[DOWNLOAD-PROCESSOR] ${message}`);
                            if (!downloadProcess.killed) {
                                downloadProcess.kill('SIGKILL');
                            }
                            finish(new Error(message));
                        }
                    });

                    let stderrOutput = '';
                    downloadProcess.stderr?.on("data", (data: Buffer) => {
                        try {
                            resetIdleTimeout();

                            const output = data.toString();
                            stderrOutput += output;
                            const lines = output.split(/\r?\n|\r/g);
                            let handledProgress = false;

                            if (backend === 'orpheus' || backend === 'tidal-dl-ng') {
                                for (const line of lines) {
                                    if (!line.trim()) {
                                        continue;
                                    }

                                    handledProgress = handleBackendProgressLine(line) || handledProgress;
                                }
                            }

                            if (!handledProgress && !output.includes('WARNING') && !output.includes('ffmpeg version')) {
                                console.error(`[${backend} stderr] ${output}`);
                            }
                        } catch (error: any) {
                            const message = `Failed to process stderr for job ${jobId}: ${error?.message || 'unknown stderr error'}`;
                            console.error(`[DOWNLOAD-PROCESSOR] ${message}`);
                            if (!downloadProcess.killed) {
                                downloadProcess.kill('SIGKILL');
                            }
                            finish(new Error(message));
                        }
                    });

                    downloadProcess.on("close", (code) => {
                        if (settled) return;

                        if (code === 0) {
                            this.persistDownloadState(jobId, {
                                progress: 100,
                                currentFileNum: completedTracks,
                                totalFiles: totalTracks || completedTracks,
                                currentTrack: currentTrackName || undefined,
                                trackProgress: currentTrackName ? trackProgress.get(currentTrackName) : undefined,
                                trackStatus: currentTrackName ? 'completed' : undefined,
                                state: 'completed',
                                statusMessage: statusMessage || 'Download completed',
                                tracks: albumTracks.length > 0 ? albumTracks.map(t => ({
                                    ...t,
                                    status: t.status === 'error' || t.status === 'skipped' ? t.status : 'completed' as const,
                                })) : undefined,
                            });
                            downloadEvents.emitProgress(jobId, {
                                tidalId: id,
                                type,
                                title: payload.title,
                                artist: payload.artist,
                                cover: payload.cover,
                                progress: 100,
                                currentFileNum: completedTracks,
                                totalFiles: totalTracks || completedTracks,
                                state: 'completed',
                                tracks: albumTracks.length > 0 ? albumTracks.map(t => ({
                                    ...t,
                                    status: t.status === 'error' || t.status === 'skipped' ? t.status : 'completed' as const,
                                })) : undefined,
                            });
                            finish();
                        } else {
                            // Include stderr in error message for better debugging
                            const errorDetails = stderrOutput.trim().slice(-500); // Last 500 chars
                            finish(new Error(`${backend} exited with code ${code}${errorDetails ? `: ${errorDetails}` : ''}`));
                        }
                    });

                    downloadProcess.on("error", (error) => {
                        finish(new Error(`Failed to start ${backend}: ${error.message}`));
                    });
                } catch (error: any) {
                    reject(error);
                }
            };

            configureAndDownload();
        });
    }

    async pause(): Promise<void> {
        console.log('[DOWNLOAD-PROCESSOR] Pausing queue...');
        this.isPaused = true;

        if (this.processing && this.currentJobId) {
            console.log(`[DOWNLOAD-PROCESSOR] Cancelling current job: ${this.currentJobId}`);
            this.cancelCurrentDownload = true;

            if (this.currentProcess && !this.currentProcess.killed) {
                this.currentProcess.kill();
            }
        }

        downloadEvents.emitQueueStatus(true);
        console.log('[DOWNLOAD-PROCESSOR] Queue paused');
    }

    async resume(): Promise<void> {
        if (process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') {
            // Ensure QA / LAN testing can't accidentally start real downloads.
            this.isPaused = true;
            downloadEvents.emitQueueStatus(true);
            return;
        }

        console.log('[DOWNLOAD-PROCESSOR] Resuming queue...');
        this.isPaused = false;

        downloadEvents.emitQueueStatus(false);
        // Wake the queue loop without blocking the caller on a full download lifecycle.
        this.scheduleNext();
    }

    isActivelyProcessingJob(jobId: number): boolean {
        return this.processing && this.currentJobId === jobId;
    }

    getStatus(): {
        isPaused: boolean;
        processing: boolean;
        currentJobId?: number;
        currentTidalId?: string;
        currentType?: string;
    } {
        return {
            isPaused: this.isPaused,
            processing: this.processing,
            currentJobId: this.currentJobId,
            currentTidalId: this.currentTidalId,
            currentType: this.currentType,
        };
    }
}

export const downloadProcessor = new DownloadProcessor();
