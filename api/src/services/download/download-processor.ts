import { db } from '../../database.js';
import { DOWNLOAD_JOB_TYPES, DOWNLOAD_OR_IMPORT_JOB_TYPES, JobOfType, JobTypes, TaskQueueService } from '../jobs/queue.js';
import { Config } from '../config/config.js';
import { downloadEvents } from './download-events.js';
import { updateAlbumDownloadStatus } from './download-state.js';
import { downloadBackendRegistry } from './download-backend.js';
import { readIntEnv } from '../../utils/env.js';
import fs from 'fs';
import path from 'path';
import {
    getDownloadWorkspacePath,
    getDefaultStreamingSource,
} from './download-routing.js';
import { MediaSeedService } from '../music/media-seed-service.js';
import { RefreshAlbumService } from "../music/refresh-album-service.js";
import { streamingProviderManager } from '../providers/index.js';
import type {
    DownloadAlbumJobPayload,
    DownloadMediaType,
    ImportDownloadJobPayload,
    DownloadTrackJobPayload,
    DownloadVideoJobPayload,
    ResolvedDownloadMetadata,
} from '../jobs/job-payloads.js';
import { DownloadedTracksImportService } from '../mediafiles/downloaded-tracks-import-service.js';
import { appEvents, AppEvent, type JobEventPayload } from '../jobs/app-events.js';

type DownloadJobPayload = DownloadTrackJobPayload | DownloadVideoJobPayload | DownloadAlbumJobPayload;
type DownloadJobType = Extract<DownloadMediaType, 'track' | 'video' | 'album'>;
type DownloadOrImportJobPayload = DownloadJobPayload | ImportDownloadJobPayload;

type CanonicalProviderOffer = {
    provider?: string | null;
    provider_id?: string | null;
    entity_type?: string | null;
    artist_mbid?: string | null;
    release_group_mbid?: string | null;
    release_mbid?: string | null;
    track_mbid?: string | null;
    recording_mbid?: string | null;
    provider_title?: string | null;
    provider_quality?: string | null;
    asset_id?: string | null;
    provider_data?: string | null;
    slot_provider_data?: string | null;
    slot_quality?: string | null;
    selected_release_mbid?: string | null;
    canonical_album_title?: string | null;
    canonical_track_title?: string | null;
    canonical_recording_title?: string | null;
    artist_name?: string | null;
};

const POLL_INTERVAL = readIntEnv('DISCOGENIUS_DOWNLOAD_POLL_MS', 2000, 1); // 2 seconds default
const MAX_RETRY_ATTEMPTS = readIntEnv('DISCOGENIUS_DOWNLOAD_MAX_RETRY_ATTEMPTS', 3, 1);
const DOWNLOAD_TIMEOUT_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_TIMEOUT_MS', 4 * 60 * 60 * 1000, 0); // 0 = disabled
const DOWNLOAD_IDLE_TIMEOUT_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_IDLE_TIMEOUT_MS', 10 * 60 * 1000, 0); // 0 = disabled
const BUSY_LOG_THROTTLE_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_BUSY_LOG_THROTTLE_MS', 30_000, 0);
const STUCK_JOB_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_STUCK_JOB_MS', 15 * 60 * 1000, 0); // 0 = disabled
const STUCK_CLEANUP_INTERVAL_MS = readIntEnv('DISCOGENIUS_DOWNLOAD_STUCK_CLEANUP_INTERVAL_MS', 60_000, 1);
const MAX_CONCURRENT_IMPORTS = readIntEnv('DISCOGENIUS_MAX_CONCURRENT_IMPORTS', 2, 1);

// Docker: tiddl/ffmpeg installed globally via Dockerfile. Local dev resolves them from PATH (TIDDL_BIN override supported).

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

    private parseProviderData(value: unknown): Record<string, unknown> {
        if (!value) return {};
        if (typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        if (typeof value !== 'string') return {};

        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    }

    private pickString(value: unknown): string | null {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        return null;
    }

    private pickNestedString(record: Record<string, unknown>, key: string): string | null {
        return this.pickString(record[key]);
    }

    private resolveCanonicalProviderOffer(
        providerId: string,
        type: DownloadJobType,
        payload?: DownloadJobPayload,
    ): CanonicalProviderOffer | null {
        const entityType = type === 'album' ? 'album' : type === 'video' ? 'video' : 'track';
        const releaseGroupMbid = this.pickString(payload?.releaseGroupMbid);
        const slot = this.pickString(payload?.slot) || 'stereo';

        if (type === 'album') {
            const row = db.prepare(`
                SELECT
                    pi.provider,
                    pi.provider_id,
                    pi.entity_type,
                    pi.artist_mbid,
                    pi.release_group_mbid,
                    pi.release_mbid,
                    pi.title AS provider_title,
                    pi.quality AS provider_quality,
                    pi.asset_id,
                    pi.data AS provider_data,
                    rgs.provider_data AS slot_provider_data,
                    rgs.quality AS slot_quality,
                    rgs.selected_release_mbid,
                    rg.title AS canonical_album_title,
                    am.name AS artist_name
                FROM ProviderItems pi
                LEFT JOIN ReleaseGroupSlots rgs
                  ON rgs.selected_provider = pi.provider
                 AND rgs.selected_provider_id = pi.provider_id
                 AND rgs.release_group_mbid = pi.release_group_mbid
                 AND (? IS NULL OR rgs.slot = ?)
                LEFT JOIN Albums rg
                  ON rg.mbid = COALESCE(pi.release_group_mbid, rgs.release_group_mbid)
                LEFT JOIN ArtistMetadata am
                  ON am.mbid = COALESCE(pi.artist_mbid, rgs.artist_mbid, rg.artist_mbid)
                WHERE pi.provider_id = ?
                  AND pi.entity_type = 'album'
                  AND (? IS NULL OR pi.release_group_mbid = ?)
                ORDER BY CASE WHEN rgs.slot = ? THEN 0 ELSE 1 END, pi.updated_at DESC
                LIMIT 1
            `).get(slot, slot, providerId, releaseGroupMbid, releaseGroupMbid, slot) as CanonicalProviderOffer | undefined;

            if (row) return row;

            if (releaseGroupMbid) {
                const slotRow = db.prepare(`
                    SELECT
                        rgs.selected_provider AS provider,
                        rgs.selected_provider_id AS provider_id,
                        'album' AS entity_type,
                        rgs.artist_mbid,
                        rgs.release_group_mbid,
                        rgs.selected_release_mbid AS release_mbid,
                        rgs.provider_data AS slot_provider_data,
                        rgs.quality AS slot_quality,
                        rgs.selected_release_mbid,
                        rg.title AS canonical_album_title,
                        am.name AS artist_name
                    FROM ReleaseGroupSlots rgs
                    LEFT JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
                    LEFT JOIN ArtistMetadata am ON am.mbid = COALESCE(rgs.artist_mbid, rg.artist_mbid)
                    WHERE rgs.release_group_mbid = ?
                      AND rgs.selected_provider_id = ?
                      AND rgs.slot = ?
                    LIMIT 1
                `).get(releaseGroupMbid, providerId, slot) as CanonicalProviderOffer | undefined;
                return slotRow ?? null;
            }

            return null;
        }

        const row = db.prepare(`
            SELECT
                pi.provider,
                pi.provider_id,
                pi.entity_type,
                pi.artist_mbid,
                pi.release_group_mbid,
                pi.release_mbid,
                pi.track_mbid,
                pi.recording_mbid,
                pi.title AS provider_title,
                pi.quality AS provider_quality,
                pi.asset_id,
                pi.data AS provider_data,
                rg.title AS canonical_album_title,
                t.title AS canonical_track_title,
                r.title AS canonical_recording_title,
                am.name AS artist_name
            FROM ProviderItems pi
            LEFT JOIN Albums rg ON rg.mbid = pi.release_group_mbid
            LEFT JOIN Tracks t ON t.mbid = pi.track_mbid
            LEFT JOIN Recordings r ON r.mbid = pi.recording_mbid
            LEFT JOIN ArtistMetadata am ON am.mbid = pi.artist_mbid
            WHERE pi.provider_id = ?
              AND pi.entity_type = ?
            ORDER BY pi.updated_at DESC
            LIMIT 1
        `).get(providerId, entityType) as CanonicalProviderOffer | undefined;
        return row ?? null;
    }

    private hasAlbumMetadataReady(albumId: string, payload?: DownloadJobPayload): boolean {
        const canonicalOffer = this.resolveCanonicalProviderOffer(albumId, 'album', payload);
        return Boolean(canonicalOffer);
    }

    private hasTrackMetadataReady(trackId: string, payload?: DownloadJobPayload): boolean {
        const canonicalOffer = this.resolveCanonicalProviderOffer(trackId, 'track', payload);
        if (canonicalOffer) {
            return Boolean(
                canonicalOffer.provider_id
                && (canonicalOffer.provider_title || canonicalOffer.canonical_track_title || canonicalOffer.canonical_recording_title)
                && (canonicalOffer.artist_mbid || canonicalOffer.artist_name)
            );
        }

        return false;
    }

    private hasVideoMetadataReady(videoId: string, payload?: DownloadJobPayload): boolean {
        const canonicalOffer = this.resolveCanonicalProviderOffer(videoId, 'video', payload);
        if (canonicalOffer) {
            return Boolean(
                canonicalOffer.provider_id
                && (canonicalOffer.provider_title || canonicalOffer.canonical_recording_title)
                && (canonicalOffer.artist_mbid || canonicalOffer.artist_name)
            );
        }

        return false;
    }

    private async ensureMetadataReady(
        providerId: string,
        type: 'track' | 'video' | 'album',
        payload?: DownloadJobPayload,
    ): Promise<void> {
        switch (type) {
            case 'album': {
                const albumIds = providerId.split(";").filter(Boolean);
                for (const subAlbumId of albumIds) {
                    if (!this.hasAlbumMetadataReady(subAlbumId, payload)) {
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
                if (!this.hasTrackMetadataReady(providerId, payload)) {
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
                if (!this.hasVideoMetadataReady(providerId, payload)) {
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
            const canonicalOffer = this.resolveCanonicalProviderOffer(providerId, type, payload);
            if (canonicalOffer) {
                const providerData = this.parseProviderData(canonicalOffer.provider_data);
                const slotProviderData = this.parseProviderData(canonicalOffer.slot_provider_data);
                const providerArtist = this.parseProviderData(providerData.artist);
                const slotArtist = this.parseProviderData(slotProviderData.artist);
                const title = type === 'album'
                    ? canonicalOffer.canonical_album_title
                    : type === 'video'
                        ? canonicalOffer.canonical_recording_title
                        : canonicalOffer.canonical_track_title || canonicalOffer.canonical_recording_title;
                const cover = fallbackCover
                    ?? this.pickNestedString(slotProviderData, 'cover')
                    ?? canonicalOffer.asset_id
                    ?? this.pickNestedString(providerData, 'cover')
                    ?? null;

                return {
                    title: fallbackTitle || title || canonicalOffer.provider_title || 'Unknown',
                    artist: fallbackArtist
                        || canonicalOffer.artist_name
                        || this.pickNestedString(slotArtist, 'name')
                        || this.pickNestedString(providerArtist, 'name')
                        || this.pickNestedString(slotProviderData, 'artist')
                        || this.pickNestedString(providerData, 'artist')
                        || 'Unknown',
                    cover,
                };
            }

            return {
                title: fallbackTitle || 'Unknown',
                artist: fallbackArtist || 'Unknown',
                cover: fallbackCover,
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
            const canonicalOffer = this.resolveCanonicalProviderOffer(providerId, type, payload);
            if (canonicalOffer) {
                return canonicalOffer.slot_quality ?? canonicalOffer.provider_quality ?? null;
            }
            return null;
        } catch {
            return null;
        }
    }

    private getCanonicalAlbumDownloadProgress(
        providerId: string,
        payload: DownloadJobPayload,
    ): { total: number; done: number } | null {
        const canonicalOffer = this.resolveCanonicalProviderOffer(providerId, 'album', payload);
        const releaseGroupMbid = this.pickString(payload?.releaseGroupMbid) || canonicalOffer?.release_group_mbid;
        const releaseMbid = this.pickString(payload?.releaseMbid)
            || canonicalOffer?.selected_release_mbid
            || canonicalOffer?.release_mbid;
        const slot = this.pickString(payload?.slot) || 'stereo';

        if (!releaseGroupMbid && !releaseMbid) {
            return null;
        }

        const row = releaseMbid
            ? db.prepare(`
                SELECT
                    COUNT(DISTINCT t.mbid) AS total,
                    COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN t.mbid END) AS done
                FROM Tracks t
                LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
                LEFT JOIN TrackFiles lf
                  ON (
                    lf.canonical_track_mbid = t.mbid
                    OR (
                      lf.canonical_track_mbid IS NULL
                      AND lf.canonical_recording_mbid = t.recording_mbid
                    )
                  )
                 AND lf.file_type = 'track'
                 AND lf.library_slot = ?
                WHERE t.release_mbid = ?
                  AND COALESCE(r.is_video, 0) = 0
            `).get(slot, releaseMbid) as { total?: number; done?: number } | undefined
            : db.prepare(`
                SELECT
                    COUNT(DISTINCT pi.provider_id) AS total,
                    COUNT(DISTINCT CASE WHEN lf.id IS NOT NULL THEN pi.provider_id END) AS done
                FROM ProviderItems pi
                LEFT JOIN TrackFiles lf
                  ON lf.provider = pi.provider
                 AND lf.provider_entity_type = pi.entity_type
                 AND lf.provider_id = pi.provider_id
                 AND lf.file_type = 'track'
                 AND lf.library_slot = pi.library_slot
                WHERE pi.release_group_mbid = ?
                  AND pi.entity_type = 'track'
                  AND pi.library_slot = ?
            `).get(releaseGroupMbid, slot) as { total?: number; done?: number } | undefined;

        if (!row) return null;
        return {
            total: Number(row.total || 0),
            done: Number(row.done || 0),
        };
    }

    private isCanonicalProviderItemDownloaded(
        providerId: string,
        type: Extract<DownloadJobType, 'track' | 'video'>,
        payload: DownloadJobPayload,
    ): boolean {
        const canonicalOffer = this.resolveCanonicalProviderOffer(providerId, type, payload);
        if (!canonicalOffer) {
            return false;
        }

        const fileType = type === 'video' ? 'video' : 'track';
        const row = db.prepare(`
            SELECT 1
            FROM TrackFiles lf
            WHERE lf.file_type = ?
              AND (
                (lf.provider = ? AND lf.provider_entity_type = ? AND lf.provider_id = ?)
                OR (? IS NOT NULL AND lf.canonical_track_mbid = ?)
                OR (? IS NOT NULL AND lf.canonical_recording_mbid = ?)
              )
            LIMIT 1
        `).get(
            fileType,
            canonicalOffer.provider,
            canonicalOffer.entity_type,
            providerId,
            canonicalOffer.track_mbid,
            canonicalOffer.track_mbid,
            canonicalOffer.recording_mbid,
            canonicalOffer.recording_mbid,
        ) as { 1?: number } | undefined;

        return Boolean(row);
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

        const isImportingThisProvider = Array.from(this.activeImports.values()).some(
            importJob => importJob.providerId === providerId
        );

        if (isImportingThisProvider) {
            // Delay downloading if the same provider is currently being imported,
            // to prevent wiping the workspace before the import has finished renaming files.
            this.processing = false;
            this.currentJobId = undefined;
            this.currentProviderId = undefined;
            this.currentType = undefined;
            setTimeout(() => this.scheduleNext(), 2000);
            return;
        }

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

            await this.ensureMetadataReady(providerId, type, payload as DownloadJobPayload);

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
            // tiddl may skip all items (already downloaded or unavailable) and exit successfully
            // without producing any new files.
            if (!await this.hasDownloadedMediaFiles(this.currentDownloadPath)) {
                // The downloader exited 0 but downloaded nothing.
                // Check if content already exists in library — if so, treat as already-imported.
                if (type === 'album') {
                    const row = this.getCanonicalAlbumDownloadProgress(providerId, payload as DownloadJobPayload);

                    if (payload?.reason !== 'upgrade' && row && row.total > 0 && row.done > 0) {
                        // Album has at least some tracks downloaded.  The downloader
                        // couldn't add anything new (items skipped or unavailable).
                        const pct = Math.round(row.done / row.total * 100);
                        console.log(
                            `[DOWNLOAD-PROCESSOR] Download workspace empty but album ${providerId} already has ${row.done}/${row.total} tracks downloaded (${pct}%). ` +
                            `Remaining tracks may be unavailable on TIDAL — treating as complete.`
                        );

                        // Mark undownloadable tracks so the queue doesn't re-queue endlessly
                        updateAlbumDownloadStatus(String(payload.releaseGroupMbid || providerId));

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
                    const alreadyDownloaded = this.isCanonicalProviderItemDownloaded(providerId, type, payload as DownloadJobPayload);

                    if (payload?.reason !== 'upgrade' && alreadyDownloaded) {
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
                    `tiddl finished successfully but no files were downloaded for ${type} ${providerId}. ` +
                    `All items may have been skipped (already downloaded or unavailable on TIDAL).`
                );
            }

            // Organize into library (dispatched to the import/finalization queue)
            TaskQueueService.addJob(JobTypes.ImportDownload, {
                provider: payload.provider,
                providerId: payload.providerId ?? providerId,
                releaseGroupMbid: payload.releaseGroupMbid,
                releaseMbid: payload.releaseMbid,
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

            downloadEvents.emitCompleted(job.id, {
                providerId,
                type,
                quality: payload.quality ?? null,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                silent: true,
            });

            // The ImportDownload job will clean up the item workspace after import.
            this.currentDownloadPath = undefined;

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
        const slot = (payload as any).slot || 'stereo';
        const capability = type === 'video' ? 'video' : (slot === 'spatial' ? 'spatial' : 'stereo');

        const backend = downloadBackendRegistry.resolve(providerId, capability);
        if (!backend) {
            throw new Error(`No download backend found for provider ${providerId} with capability ${capability}`);
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
            await backend.download({
                provider: providerId,
                entityType: type as "album" | "track" | "video",
                providerId: id,
                downloadPath,
                quality: payload.quality,
            }, {
                signal,
                onProgress,
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
