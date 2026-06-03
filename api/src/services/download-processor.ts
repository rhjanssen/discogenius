import { db } from '../database.js';
import { DOWNLOAD_JOB_TYPES, DOWNLOAD_OR_IMPORT_JOB_TYPES, JobOfType, JobTypes, TaskQueueService } from './queue.js';
import { Config } from './config.js';
import { downloadEvents } from './download-events.js';
import { updateAlbumDownloadStatus } from './download-state.js';
import { readIntEnv } from '../utils/env.js';
import fs from 'fs';
import path from 'path';
import {
    getDownloadWorkspacePath,
    getDefaultStreamingSource,
} from './download-routing.js';
import { MediaSeedService } from './media-seed-service.js';
import { RefreshAlbumService } from "./refresh-album-service.js";
import { streamingProviderManager } from './providers/index.js';
import type {
    DownloadAlbumJobPayload,
    DownloadMediaType,
    ImportDownloadJobPayload,
    DownloadTrackJobPayload,
    DownloadVideoJobPayload,
    ResolvedDownloadMetadata,
} from './job-payloads.js';
import { DownloadedTracksImportService } from './downloaded-tracks-import-service.js';
import { appEvents, AppEvent, type JobEventPayload } from './app-events.js';

type DownloadJobPayload = DownloadTrackJobPayload | DownloadVideoJobPayload | DownloadAlbumJobPayload;
type DownloadJobType = Extract<DownloadMediaType, 'track' | 'video' | 'album'>;
type DownloadOrImportJobPayload = DownloadJobPayload | ImportDownloadJobPayload;

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_DOWNLOAD_POLL_MS', 2000, 1); // 2 seconds default
const MAX_RETRY_ATTEMPTS = readIntEnv('DISCOGENIUS_DOWNLOAD_MAX_RETRY_ATTEMPTS', 3, 1);
const DOWNLOAD_TIMEOUT_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_TIMEOUT_MS', 4 * 60 * 60 * 1000, 0); // 0 = disabled
const DOWNLOAD_IDLE_TIMEOUT_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_IDLE_TIMEOUT_MS', 10 * 60 * 1000, 0); // 0 = disabled
const BUSY_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_BUSY_LOG_THROTTLE_MS', 30_000, 0);
const STUCK_JOB_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_STUCK_JOB_MS', 15 * 60 * 1000, 0); // 0 = disabled
const STUCK_CLEANUP_INTERVAL_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_STUCK_CLEANUP_INTERVAL_MS', 60_000, 1);
const MAX_CONCURRENT_IMPORTS = readIntEnv('DISCOGENIUS_MAX_CONCURRENT_IMPORTS', 2, 1);

// Docker: tidal-dl-ng/ffmpeg installed globally via Dockerfile. Local dev uses PATH + buildTidalDlNgEnv.

/**
 * Enhanced Download Processor with real-time progress tracking
 * Emits events for SSE streaming to frontend
 */

/** States that must be flushed to DB immediately (terminal / transition states). */
const IMMEDIATE_FLUSH_STATES = new Set<string>([
    'completed', 'failed', 'importFailed', 'importPending', 'importing',
]);

/** Minimum interval between DB writes for a single job's progress (ms). */
const PROGRESS_WRITE_INTERVAL_MS = 1_000;

function formatQueueTimestamp(value: unknown): string {
    if (!value) return "unknown";
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return "unknown";
    return date.toISOString();
}

export class DownloadProcessor {
    private processing: boolean = false;
    private isPaused: boolean = false;
    private currentAbortController?: AbortController;
    private currentJobId?: number;
    private currentProviderId?: string;
    private currentType?: string;
    private currentDownloadPath?: string;
    private pollTimer?: NodeJS.Timeout;
    private cancelCurrentDownload: boolean = false;
    private lastBusyLogAt: number = 0;
    private lastStuckCleanupAt: number = 0;
    private queueEventsSubscribed: boolean = false;

    /** Tracks the active import job (runs in its own slot alongside downloads, Tidarr-style). */
    private activeImports = new Map<number, { providerId: string; type: string; promise: Promise<void> }>();

    // ── Progress write coalescing ───────────────────────────────────
    // Buffers the latest in-flight progress state per job and flushes
    // to SQLite at most once per PROGRESS_WRITE_INTERVAL_MS, reducing
    // DB round-trips from every CLI progress tick to ≤1/s per job.
    // Terminal states (completed/failed/…) always flush immediately.
    private progressBuffer = new Map<number, Parameters<DownloadProcessor['writeDownloadState']>[1]>();
    private progressFlushTimer?: NodeJS.Timeout;

    private scheduleNext(): void {
        setImmediate(() => {
            this.processQueue().catch((error) => {
                console.error('[DOWNLOAD-PROCESSOR] Error scheduling next queue item:', error);
            });
        });
    }

    /**
     * Fire-and-forget an import job. Runs in a dedicated import slot alongside
     * the download slot (Lidarr/Tidarr-style: 1 download + 1 import in parallel).
     */
    private dispatchImportJob(job: ReturnType<typeof TaskQueueService.getNextJobByTypes> & {}): void {
        const importPayload = job.payload as ImportDownloadJobPayload;
        const providerId = String(importPayload?.providerId || job.ref_id || '');
        const rawType = String(importPayload?.type || 'track');
        const type: DownloadJobType = rawType === 'album' || rawType === 'video' ? rawType : 'track';

        if (!providerId || providerId === 'undefined' || providerId === 'null') {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping import job #${job.id} with invalid providerId: ${providerId}`);
            TaskQueueService.fail(job.id, 'Invalid providerId - cannot import');
            return;
        }

        const resolved = {
            title: importPayload?.resolved?.title || (job.payload as any)?.title || 'Unknown',
            artist: importPayload?.resolved?.artist || (job.payload as any)?.artist || 'Unknown',
            cover: importPayload?.resolved?.cover ?? (job.payload as any)?.cover ?? null,
        };

        if (!TaskQueueService.markProcessing(job.id)) {
            console.log(`[DOWNLOAD-PROCESSOR] Import job #${job.id} is no longer pending; skipping dispatch.`);
            return;
        }
        console.log(`[DOWNLOAD-PROCESSOR] Dispatching import job #${job.id}: ${type} ${providerId} (${this.activeImports.size + 1}/${MAX_CONCURRENT_IMPORTS} slots)`);

        const emitImportProgress = (state: Parameters<typeof this.persistDownloadState>[1]) => {
            this.persistDownloadState(job.id, state);
            downloadEvents.emitProgress(job.id, {
                providerId,
                type,
                quality: importPayload?.quality ?? null,
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

        const importPromise = (async () => {
            try {
                await DownloadedTracksImportService.process(job as JobOfType<typeof JobTypes.ImportDownload>, {
                    updateState: emitImportProgress,
                });

                TaskQueueService.complete(job.id);
                downloadEvents.emitCompleted(job.id, {
                    providerId,
                    type,
                    quality: importPayload?.quality ?? null,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                });
                console.log(`[DOWNLOAD-PROCESSOR] Successfully imported ${type} ${providerId}`);
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
                    providerId,
                    type,
                    quality: importPayload?.quality ?? null,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                    error: error?.message || 'Unknown import error',
                    state: 'importFailed',
                });
            } finally {
                this.activeImports.delete(job.id);
                // An import slot freed up — check for more pending imports/downloads.
                this.scheduleNext();
            }
        })();

        this.activeImports.set(job.id, { providerId, type, promise: importPromise });
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

        const excludeIds = [
            ...(this.currentJobId ? [this.currentJobId] : []),
            ...this.activeImports.keys(),
        ];

        const recovered = TaskQueueService.requeueStaleProcessingJobsByTypes({
            types: DOWNLOAD_OR_IMPORT_JOB_TYPES,
            olderThanMs: STUCK_JOB_MS,
            excludeIds,
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
            FROM ProviderAlbums a
            LEFT JOIN Artists ar ON ar.id = a.artist_id
            LEFT JOIN ProviderMedia m ON m.album_id = a.id AND m.type != 'Music Video'
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
            FROM ProviderMedia m
            LEFT JOIN ProviderAlbums a ON a.id = m.album_id
            WHERE m.id = ?
        `).get(trackId) as any;

        return Boolean(row?.id && row?.title && row?.artist_id && row?.album_id && row?.album_exists);
    }

    private hasVideoMetadataReady(videoId: string): boolean {
        const row = db.prepare(`
            SELECT id, title, artist_id
            FROM ProviderMedia
            WHERE id = ? AND type = 'Music Video'
        `).get(videoId) as any;

        return Boolean(row?.id && row?.title && row?.artist_id);
    }

    private async ensureMetadataReady(
        providerId: string,
        type: 'track' | 'video' | 'album',
    ): Promise<void> {
        switch (type) {
            case 'album': {
                const albumIds = providerId.split(";").filter(Boolean);
                for (const subAlbumId of albumIds) {
                    if (!this.hasAlbumMetadataReady(subAlbumId)) {
                        console.log(`[DOWNLOAD-PROCESSOR] Album ${subAlbumId} is missing complete metadata; running album scan before download`);
                        await RefreshAlbumService.scanShallow(subAlbumId, {
                            includeSimilarAlbums: false,
                            seedSimilarAlbums: false,
                        });
                    }
                }
                return;
            }
            case 'track':
                if (!this.hasTrackMetadataReady(providerId)) {
                    console.log(`[DOWNLOAD-PROCESSOR] Track ${providerId} is missing metadata; seeding track before download`);
                    await MediaSeedService.seedTrack(providerId, {
                        includeSimilarArtists: false,
                        seedSimilarArtists: false,
                        includeSimilarAlbums: false,
                        seedSimilarAlbums: false,
                    });
                }
                return;
            case 'video':
                if (!this.hasVideoMetadataReady(providerId)) {
                    console.log(`[DOWNLOAD-PROCESSOR] Video ${providerId} is missing metadata; seeding video before download`);
                    await MediaSeedService.seedVideo(providerId, {
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
        providerId: string,
        type: DownloadJobType,
        payload: DownloadJobPayload,
    ): Required<ResolvedDownloadMetadata> {
        const fallbackTitle = payload?.title;
        const fallbackArtist = payload?.artist;
        const fallbackCover = payload?.cover ?? null;

        try {
            if (type === 'album') {
                const albumIds = providerId.split(";").filter(Boolean);
                const titles: string[] = [];
                let artistName = 'Unknown';
                let cover: string | null = null;
                for (const subAlbumId of albumIds) {
                    const row = db.prepare(`
                        SELECT a.title, a.cover, ar.name as artist_name
                        FROM ProviderAlbums a
                        LEFT JOIN Artists ar ON ar.id = a.artist_id
                        WHERE a.id = ?
                    `).get(subAlbumId) as any;
                    if (row) {
                        if (row.title) titles.push(row.title);
                        if (row.artist_name) artistName = row.artist_name;
                        if (!cover && row.cover) cover = row.cover;
                    }
                }
                return {
                    title: fallbackTitle || (titles.length > 0 ? titles.join(" / ") : 'Unknown'),
                    artist: fallbackArtist || artistName,
                    cover: fallbackCover ?? cover ?? null,
                };
            }

            if (type === 'video') {
                const row = db.prepare(`
                    SELECT m.title, m.cover as video_cover, ar.name as artist_name, a.cover as album_cover
                    FROM ProviderMedia m
                    LEFT JOIN Artists ar ON ar.id = m.artist_id
                    LEFT JOIN ProviderAlbums a ON a.id = m.album_id
                    WHERE m.id = ? AND m.type = 'Music Video'
                `).get(providerId) as any;
                return {
                    title: fallbackTitle || row?.title || 'Unknown',
                    artist: fallbackArtist || row?.artist_name || 'Unknown',
                    cover: fallbackCover ?? row?.video_cover ?? row?.album_cover ?? null,
                };
            }

            const row = db.prepare(`
                SELECT m.title, ar.name as artist_name, a.cover as album_cover
                FROM ProviderMedia m
                LEFT JOIN Artists ar ON ar.id = m.artist_id
                LEFT JOIN ProviderAlbums a ON a.id = m.album_id
                WHERE m.id = ?
            `).get(providerId) as any;
            return {
                title: fallbackTitle || row?.title || 'Unknown',
                artist: fallbackArtist || row?.artist_name || 'Unknown',
                cover: fallbackCover ?? row?.album_cover ?? null,
            };
        } catch {
            return {
                title: fallbackTitle || 'Unknown',
                artist: fallbackArtist || 'Unknown',
                cover: fallbackCover,
            };
        }
    }

    private resolveDownloadQuality(
        providerId: string,
        type: DownloadJobType,
        payload: DownloadJobPayload,
    ): string | null {
        if (payload?.quality) {
            return payload.quality;
        }

        try {
            if (type === 'album') {
                const firstId = providerId.split(";")[0];
                const row = db.prepare(`
                    SELECT quality
                    FROM ProviderAlbums
                    WHERE id = ?
                `).get(firstId) as { quality?: string | null } | undefined;
                return row?.quality ?? null;
            }

            const row = db.prepare(`
                SELECT quality
                FROM ProviderMedia
                WHERE id = ?
            `).get(providerId) as { quality?: string | null } | undefined;
            return row?.quality ?? null;
        } catch {
            return null;
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
        // Terminal / transition states bypass the buffer and write immediately.
        if (state.state && IMMEDIATE_FLUSH_STATES.has(state.state)) {
            // Flush any pending buffered state for this job first so the
            // immediate write always represents the latest snapshot.
            this.progressBuffer.delete(jobId);
            this.writeDownloadState(jobId, state);
            return;
        }

        // Buffer the latest in-flight progress for this job.
        this.progressBuffer.set(jobId, state);
        this.ensureProgressFlushTimer();
    }

    /** Unconditionally write download state to the database. */
    private writeDownloadState(jobId: number, state: {
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

    /** Start the periodic flush timer if not already running. */
    private ensureProgressFlushTimer(): void {
        if (this.progressFlushTimer) return;
        this.progressFlushTimer = setInterval(() => {
            this.flushProgressBuffer();
        }, PROGRESS_WRITE_INTERVAL_MS);
        this.progressFlushTimer.unref(); // Don't keep process alive just for this timer
    }

    /** Flush all buffered progress states to the database. */
    flushProgressBuffer(): void {
        if (this.progressBuffer.size === 0) {
            // Nothing left to flush — stop the timer.
            if (this.progressFlushTimer) {
                clearInterval(this.progressFlushTimer);
                this.progressFlushTimer = undefined;
            }
            return;
        }

        for (const [jobId, state] of this.progressBuffer) {
            this.writeDownloadState(jobId, state);
        }
        this.progressBuffer.clear();
    }

    async initialize() {
        console.log('[DOWNLOAD-PROCESSOR] Initializing...');

        // Optional: start in paused mode (useful for LAN testing / avoiding background load)
        if (process.env.DISCOGENIUS_START_PAUSED === '1') {
            this.isPaused = true;
        }

        // Initialize download backends with current settings
        try {
            await streamingProviderManager.syncProviderCredentials();
            await streamingProviderManager.syncProviderSettings();
            console.log('[DOWNLOAD-PROCESSOR] Download backend settings initialized');
        } catch (error) {
            console.warn('[DOWNLOAD-PROCESSOR] Could not initialize download backend settings:', error);
            // Continue anyway - settings might already be configured
        }

        if (!this.queueEventsSubscribed) {
            appEvents.on(AppEvent.JOB_ADDED, (event: JobEventPayload) => {
                if (DOWNLOAD_OR_IMPORT_JOB_TYPES.includes(event.type as (typeof DOWNLOAD_OR_IMPORT_JOB_TYPES)[number])) {
                    this.scheduleNext();
                }
            });
            this.queueEventsSubscribed = true;
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
                    console.log(`  - [${job.id}] ${job.type} ${job.ref_id}: "${(() => { try { const parsed = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload; return parsed?.title || "unknown"; } catch { return "unknown"; } })()}" (started ${formatQueueTimestamp(job.started_at)})`);
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

        this.maybeCleanupStuckJobs();

        // ── Import slot: 1 import runs alongside downloads (Lidarr/Tidarr pattern) ──
        // Downloads and imports use separate slots so importing never blocks
        // the next download from starting.
        while (this.activeImports.size < MAX_CONCURRENT_IMPORTS) {
            const importJob = TaskQueueService.getNextJobByTypes([JobTypes.ImportDownload]);
            if (!importJob) break;

            if (importJob.attempts >= MAX_RETRY_ATTEMPTS) {
                console.warn(`[DOWNLOAD-PROCESSOR] Import job #${importJob.id} exceeded max retries (${importJob.attempts}/${MAX_RETRY_ATTEMPTS}), marking as permanently failed`);
                TaskQueueService.fail(importJob.id, `Exceeded maximum retry attempts (${MAX_RETRY_ATTEMPTS})`);
                continue;
            }

            this.dispatchImportJob(importJob);
        }

        // ── Download slot: only one download at a time ──
        if (this.processing) {
            this.logBusy();
            return;
        }

        const job = TaskQueueService.getNextJobByTypes(DOWNLOAD_JOB_TYPES);

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
        const providerId = String(
            (job.payload as DownloadJobPayload | undefined)?.providerId
            || job.payload?.providerId
            || job.ref_id
            || '',
        );
        const type: DownloadJobType = job.type === JobTypes.DownloadVideo
            ? 'video'
            : job.type === JobTypes.DownloadAlbum
                ? 'album'
                : 'track';

        if (!type) {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid type: ${job.type}`);
            TaskQueueService.fail(job.id, `Invalid job type - cannot download`);
            this.processing = false;
            this.currentJobId = undefined;
            this.scheduleNext();
            return;
        }

        // Validate providerId before processing
        if (!providerId || providerId === 'undefined' || providerId === 'null') {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid providerId: ${providerId}`);
            TaskQueueService.fail(job.id, `Invalid providerId - cannot download`);
            this.processing = false;
            this.currentJobId = undefined;
            // Process next item
            this.scheduleNext();
            return;
        }
        this.currentProviderId = providerId;
        this.currentType = type;
        this.currentDownloadPath = undefined;
        let payload = job.payload as DownloadOrImportJobPayload;

        console.log(`[DOWNLOAD-PROCESSOR] Processing Job #${job.id}: ${job.type} (ref: ${providerId})`);

        if (!TaskQueueService.markProcessing(job.id)) {
            console.log(`[DOWNLOAD-PROCESSOR] Job #${job.id} is no longer pending; skipping dispatch.`);
            this.processing = false;
            this.currentJobId = undefined;
            this.currentProviderId = undefined;
            this.currentType = undefined;
            this.scheduleNext();
            return;
        }
        let resolved = {
            title: payload?.title || 'Unknown',
            artist: payload?.artist || 'Unknown',
            cover: payload?.cover ?? null,
        };

        try {
            this.persistDownloadState(job.id, {
                progress: 0,
                state: 'queued',
                statusMessage: 'Preparing metadata...',
            });

            await this.ensureMetadataReady(providerId, type);

            resolved = this.resolveDownloadMetadata(providerId, type, payload);
            const resolvedQuality = this.resolveDownloadQuality(providerId, type, payload);
            payload = {
                ...((payload as DownloadJobPayload) || {}),
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                quality: payload.quality ?? resolvedQuality,
            };
            job.payload = payload as DownloadJobPayload;

            this.persistDownloadState(job.id, {
                progress: 0,
                state: 'downloading',
                statusMessage: 'Starting download...',
            });
            downloadEvents.emitStarted(job.id, {
                providerId,
                type,
                quality: payload.quality ?? null,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
            });

            await this.downloadItem(job.id, providerId, type, payload);

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
                         FROM ProviderMedia m
                         LEFT JOIN TrackFiles lf
                           ON lf.media_id = m.id
                          AND lf.file_type = 'track'
                         WHERE m.album_id = ? AND m.type != 'Music Video'`
                    ).get(providerId) as any;

                    if (payload?.reason !== 'upgrade' && row && row.total > 0 && row.done > 0) {
                        // Album has at least some tracks downloaded.  tidal-dl-ng
                        // couldn't add anything new (items skipped or unavailable).
                        const pct = Math.round(row.done / row.total * 100);
                        console.log(
                            `[DOWNLOAD-PROCESSOR] Download workspace empty but album ${providerId} already has ${row.done}/${row.total} tracks downloaded (${pct}%). ` +
                            `Remaining tracks may be unavailable on TIDAL — treating as complete.`
                        );

                        // Mark undownloadable tracks so the queue doesn't re-queue endlessly
                        updateAlbumDownloadStatus(String(providerId));

                        TaskQueueService.complete(job.id);
                        await this.cleanupDownloadSourcePath();

                        downloadEvents.emitCompleted(job.id, {
                            providerId, type,
                            quality: payload.quality ?? null,
                            title: resolved.title,
                            artist: resolved.artist,
                            cover: resolved.cover,
                        });

                        return;
                    }
                } else if (type === 'track' || type === 'video') {
                    const row = db.prepare(`
                        SELECT 1
                        FROM TrackFiles
                        WHERE media_id = ?
                          AND file_type = ?
                        LIMIT 1
                    `).get(providerId, type === 'video' ? 'video' : 'track') as any;

                    if (payload?.reason !== 'upgrade' && row) {
                        console.log(`[DOWNLOAD-PROCESSOR] Download workspace empty but ${type} ${providerId} is already downloaded — marking job as complete.`);
                        TaskQueueService.complete(job.id);
                        await this.cleanupDownloadSourcePath();

                        downloadEvents.emitCompleted(job.id, {
                            providerId, type,
                            quality: payload.quality ?? null,
                            title: resolved.title,
                            artist: resolved.artist,
                            cover: resolved.cover,
                        });

                        return;
                    }
                }

                // Nothing in library either — something is genuinely wrong
                throw new Error(
                    `tidal-dl-ng finished successfully but no files were downloaded for ${type} ${providerId}. ` +
                    `All items may have been skipped (already in tidal-dl-ng history or unavailable on TIDAL).`
                );
            }

            // Organize into library (dispatched to the import/finalization queue)
            TaskQueueService.addJob(JobTypes.ImportDownload, {
                provider: payload.provider,
                providerId: payload.providerId ?? providerId,
                releaseGroupMbid: payload.releaseGroupMbid,
                canonicalTrackMbid: payload.canonicalTrackMbid,
                canonicalRecordingMbid: payload.canonicalRecordingMbid,
                slot: payload.slot,
                type,
                path: this.currentDownloadPath,
                quality: payload.quality ?? null,
                qualityProfile: payload.qualityProfile,
                title: payload.title,
                artist: payload.artist,
                artists: payload.artists,
                artistId: payload.artistId,
                artist_id: payload.artist_id,
                albumId: payload.albumId,
                album_id: payload.album_id,
                albumTitle: payload.albumTitle,
                album_title: payload.album_title,
                cover: payload.cover,
                url: payload.url,
                resolved,
                originalJobId: job.id
            }, providerId, Math.max(job.priority, 100), job.trigger, job.queue_order);

            TaskQueueService.complete(job.id);

            // The ImportDownload job will clean up the item workspace after import.
            this.currentDownloadPath = undefined;

            // Note: We do NOT emit completed event here, it will be emitted by ImportDownload
            console.log(`[DOWNLOAD-PROCESSOR] Successfully downloaded ${type} ${providerId} - dispatched to import queue`);
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
                    providerId,
                    type,
                    quality: payload.quality ?? null,
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
            this.currentAbortController = undefined;
            this.currentJobId = undefined;
            this.currentProviderId = undefined;
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

        const providerId = (payload as any).streamingSource || getDefaultStreamingSource();
        const provider = streamingProviderManager.getStreamingProvider(providerId);

        if (!provider.downloadItem) {
            throw new Error(`Provider ${providerId} does not support downloads`);
        }

        const controller = new AbortController();
        this.currentAbortController = controller;
        const signal = controller.signal;

        const onProgress = (state: any) => {
            this.persistDownloadState(jobId, state);
            downloadEvents.emitProgress(jobId, {
                providerId: id,
                type,
                quality: payload.quality ?? null,
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

        const checkCancelInterval = setInterval(() => {
            if (this.cancelCurrentDownload) {
                console.log(`[DOWNLOAD-PROCESSOR] Job #${jobId} cancelled, aborting provider download...\n`);
                controller.abort();
                clearInterval(checkCancelInterval);
            }
        }, 500);

        try {
            await provider.downloadItem(id, type, downloadPath, {
                signal,
                onProgress,
                quality: payload.quality,
            });
        } finally {
            clearInterval(checkCancelInterval);
            this.currentAbortController = undefined;
        }
    }

    async pause(): Promise<void> {
        console.log('[DOWNLOAD-PROCESSOR] Pausing queue...');
        this.isPaused = true;

        // Flush any buffered progress writes before pausing/shutdown.
        this.flushProgressBuffer();

        if (this.processing && this.currentJobId) {
            console.log(`[DOWNLOAD-PROCESSOR] Cancelling current job: ${this.currentJobId}`);
            this.cancelCurrentDownload = true;

            if (this.currentAbortController) {
                this.currentAbortController.abort();
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
        return (this.processing && this.currentJobId === jobId) || this.activeImports.has(jobId);
    }

    getStatus(): {
        isPaused: boolean;
        processing: boolean;
        currentJobId?: number;
        currentProviderId?: string;
        currentType?: string;
        activeImports: number;
    } {
        return {
            isPaused: this.isPaused,
            processing: this.processing,
            currentJobId: this.currentJobId,
            currentProviderId: this.currentProviderId,
            currentType: this.currentType,
            activeImports: this.activeImports.size,
        };
    }

    isActivelyImporting(jobId: number): boolean {
        return this.activeImports.has(jobId);
    }
}

export const downloadProcessor = new DownloadProcessor();
