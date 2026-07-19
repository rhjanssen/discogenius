import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from '../../database.js';
import {CommandModelOf} from "../commands/command-model.js";
import { DOWNLOAD_COMMAND_NAMES, DOWNLOAD_OR_IMPORT_COMMAND_NAMES, CommandNames } from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { getConfigSection } from '../config/config.js';
import { downloadEvents } from './download-events.js';
import {
    invalidateAlbumDownloadStatus,
    invalidateAllDownloadState,
    invalidateArtistDownloadStatus,
    invalidateMediaDownloadState,
    invalidateReleaseGroupDownloadStatus,
    updateAlbumDownloadStatus,
} from './download-state.js';
import { downloadBackendRegistry } from './download-backend.js';
import { readIntEnv } from '../../utils/env.js';
import fs from 'fs';
import path from 'path';
import {
    getDownloadWorkspacePath,
    getDefaultStreamingSource,
} from '../download/download-routing.js';
import {
    isKnownProviderVideoOffer,
    resolvePreferredVideoOffer,
} from '../music/video-offer-resolver.js';
import { MediaSeedService } from '../music/media-seed-service.js';
import { RefreshAlbumService } from "../music/refresh-album-service.js";
import { AlbumQueryService } from "../music/album-query-service.js";
import { streamingProviderManager } from '../providers/index.js';
import type {
    DownloadAlbumCommand,
    DownloadMediaType,
    DownloadStatePayload,
    DownloadTrackStateEntry,
    ImportDownloadCommand,
    DownloadTrackCommand,
    DownloadVideoCommand,
    ResolvedDownloadMetadata,
} from '../commands/command-bodies.js';
import { DownloadedTracksImportService } from '../mediafiles/downloaded-tracks-import-service.js';
import { appEvents, AppEvent, type CommandEventPayload } from '../commands/app-events.js';
import { CommandWorkerPool } from '../commands/worker/command-worker-pool.js';
import type { CacheInvalidateTarget } from '../commands/worker/command-worker-protocol.js';
import {
    albumCoverLocalUrl,
    renderableProviderArtworkUrl,
    videoCoverLocalUrl,
} from '../metadata/media-cover-service.js';

type DownloadCommand = DownloadTrackCommand | DownloadVideoCommand | DownloadAlbumCommand;
type DownloadJobType = Extract<DownloadMediaType, 'track' | 'video' | 'album'>;
type DownloadOrImportCommand = DownloadCommand | ImportDownloadCommand;

function resetTracksForImportState(tracks?: DownloadTrackStateEntry[]): DownloadTrackStateEntry[] | undefined {
    if (!tracks?.length) {
        return undefined;
    }

    return tracks.map((track) => ({
        ...track,
        status: track.status === 'skipped' ? 'skipped' : 'queued',
    }));
}

type CanonicalProviderOffer = {
    provider?: string | null;
    slot_cover?: string | null;
    provider_cover?: string | null;
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
    provider_artist_name?: string | null;
    slot_provider_artist_name?: string | null;
    slot_provider_title?: string | null;
    slot_quality?: string | null;
    selected_release_mbid?: string | null;
    canonical_album_title?: string | null;
    canonical_track_title?: string | null;
    canonical_recording_title?: string | null;
    canonical_recording_id?: number | null;
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
export const DOWNLOAD_WORKER_MARKER = "discogeniusDownloadWorker" as const;

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

function isSqliteBusyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED') {
        return true;
    }
    const message = (error as { message?: string }).message;
    return typeof message === 'string' && /database( table)? is locked/i.test(message);
}

type QueueTrackRow = { title: string; trackNum?: number; status: string; providerTrackId?: string };

function applyTrackStatusByProviderId<T extends QueueTrackRow>(
    tracks: T[],
    statusByProviderTrackId: Record<string, string>,
): T[] | null {
    const updates = new Map<string, string>();
    for (const [providerTrackId, status] of Object.entries(statusByProviderTrackId)) {
        const key = String(providerTrackId || "").trim();
        if (key) {
            updates.set(key, status);
        }
    }

    if (updates.size === 0) {
        return null;
    }

    let changed = false;
    const next = tracks.map((track) => {
        const key = String(track.providerTrackId || "").trim();
        const status = key ? updates.get(key) : undefined;
        if (!status || track.status === status || (track.status === 'completed' && status !== 'completed')) {
            return track;
        }
        changed = true;
        return { ...track, status };
    });

    return changed ? next : null;
}

/**
 * Normalize a reported or catalog track title for matching: drop a leading
 * "Artist - " prefix (import filenames), lowercase, and reduce punctuation
 * to spaces so "Save My Love - Acoustic Version" matches
 * "Save My Love (Acoustic Version)". Keep in sync with the client-side copy
 * in QueueStatusProvider.
 */
function normalizeTrackTitleForMatch(value: string): string {
    return value
        .toLowerCase()
        .replace(/^[^-]+\s-\s/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Apply provider-reported per-title statuses to catalog track rows. Reported
 * titles are "<track title> <quality suffix>" (downloads) or file-derived
 * names (imports); match normalized prefixes and prefer the longest (most
 * specific) catalog title. Returns null when nothing matched so the caller
 * can fall back to index-based inference.
 */
function applyTrackStatusByTitle<T extends QueueTrackRow>(
    tracks: T[],
    statusByTitle: Record<string, string>,
): T[] | null {
    const updates = new Map<number, string>();
    for (const [reportedTitle, status] of Object.entries(statusByTitle)) {
        const reported = normalizeTrackTitleForMatch(reportedTitle);
        if (!reported) continue;
        let bestIdx = -1;
        let bestLen = 0;
        tracks.forEach((track, idx) => {
            const title = normalizeTrackTitleForMatch(String(track.title || ""));
            if (title && (reported.startsWith(title) || title.startsWith(reported)) && title.length > bestLen) {
                bestIdx = idx;
                bestLen = title.length;
            }
        });
        if (bestIdx >= 0) {
            updates.set(bestIdx, status);
        }
    }

    if (updates.size === 0) {
        return null;
    }

    return tracks.map((track, idx) => {
        const status = updates.get(idx);
        if (!status) return track;
        // Never regress a row that already finished.
        if (track.status === 'completed' && status !== 'completed') return track;
        return { ...track, status };
    });
}

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

    /** Tracks the active import phase per command (runs in its own slot alongside downloads, Tidarr-style). */
    private activeImports = new Map<number, { providerId: string; type: string; promise: Promise<void> }>();
    private explicitlyCancelledDownloads = new Set<number>();

    // Download commands whose download phase finished and are waiting for an
    // import slot. The command stays 'started' throughout (one queue entity
    // spanning download → import, Lidarr TrackedDownload-style); it only leaves
    // the active queue for History when the import completes/fails. Rebuilt from
    // scratch on restart — interrupted commands are re-queued by crash recovery.
    private pendingImports: Array<{
        commandId: number;
        providerId: string;
        type: DownloadJobType;
        importPayload: ImportDownloadCommand;
        resolved: { title: string; artist: string; cover: string | null };
    }> = [];

    // ── Progress write coalescing ───────────────────────────────────
    // Buffers the latest in-flight progress state per job and flushes
    // to SQLite at most once per PROGRESS_WRITE_INTERVAL_MS, reducing
    // DB round-trips from every CLI progress tick to ≤1/s per job.
    // Terminal states (completed/failed/…) always flush immediately.
    private progressBuffer = new Map<number, Parameters<DownloadProcessor['writeDownloadState']>[1]>();
    private progressFlushTimer?: NodeJS.Timeout;
    private lastProgressBusyLogAt: number = 0;

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
    private dispatchImportPhase(entry: {
        commandId: number;
        providerId: string;
        type: DownloadJobType;
        importPayload: ImportDownloadCommand;
        resolved: { title: string; artist: string; cover: string | null };
    }): void {
        const { commandId, providerId, type, importPayload, resolved } = entry;

        const command = CommandQueueManager.get(commandId);
        if (!command || command.status !== 'started') {
            // Cancelled/deleted while waiting for a slot — nothing to import.
            this.scheduleNext();
            return;
        }

        console.log(`[DOWNLOAD-PROCESSOR] Importing command #${commandId}: ${type} ${providerId} (${this.activeImports.size + 1}/${MAX_CONCURRENT_IMPORTS} slots)`);

        const emitImportProgress = (state: Parameters<typeof this.persistDownloadState>[1]) => {
            this.persistDownloadState(commandId, state);
            const currentJob = CommandQueueManager.get(commandId);
            const currentDownloadState = (currentJob?.payload?.downloadState as DownloadStatePayload | undefined) ?? {};
            const tracks = state.tracks ?? currentDownloadState.tracks;
            downloadEvents.emitProgress(commandId, {
                providerId,
                type,
                quality: importPayload?.quality ?? null,
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                progress: state.progress ?? currentJob?.progress ?? 0,
                currentFileNum: state.currentFileNum,
                totalFiles: state.totalFiles,
                currentTrack: state.currentTrack,
                currentProviderTrackId: state.currentProviderTrackId,
                currentTrackNum: state.currentTrackNum,
                currentVolumeNum: state.currentVolumeNum,
                trackProgress: state.trackProgress,
                trackStatus: state.trackStatus,
                statusMessage: state.statusMessage,
                state: state.state,
                tracks,
            });
        };

        // The import runs the ImportDownload handler on the same command id.
        // We pass a transient job whose NAME selects the import handler on the
        // worker (or the inline import service), while the persisted command row
        // stays the DownloadAlbum/Track/Video command in its import phase — so
        // there is exactly one queue entity for the whole lifecycle.
        const importJob = {
            ...command,
            name: CommandNames.ImportDownload,
            payload: importPayload,
        } as CommandModelOf<typeof CommandNames.ImportDownload>;

        const isCancelled = () => {
            return this.explicitlyCancelledDownloads.has(commandId) || this.cancelCurrentDownload;
        };

        const importPromise = (async () => {
            try {
                if (CommandWorkerPool.isActive()) {
                    // Run the heavy import (metadata parse + matching + tagging +
                    // sync DB writes) on a worker thread so it never blocks the
                    // main thread's HTTP/SSE loop. Progress streams back via the
                    // bridge to the same emitImportProgress sink used inline.
                    await CommandWorkerPool.run(importJob, {
                        onProgress: (state: any) => emitImportProgress(state as Parameters<typeof emitImportProgress>[0]),
                    });
                } else {
                    await DownloadedTracksImportService.process(importJob, {
                        updateState: emitImportProgress,
                        isCancelled,
                    });
                }

                CommandQueueManager.complete(commandId);
                this.activeImports.delete(commandId);
                downloadEvents.emitCompleted(commandId, {
                    providerId,
                    type,
                    quality: importPayload?.quality ?? null,
                    title: resolved.title,
                    artist: resolved.artist,
                    cover: resolved.cover,
                });
                console.log(`[DOWNLOAD-PROCESSOR] Completed download+import for ${type} ${providerId} (command #${commandId})`);
            } catch (error: any) {
                if (error?.name === 'ImportDownloadCancelledError' || error?.constructor?.name === 'ImportDownloadCancelledError') {
                    console.log(`[DOWNLOAD-PROCESSOR] Import command #${commandId} cancelled (${error.message})`);
                    CommandQueueManager.cancel(commandId);
                    
                    const downloadPath = importPayload.path;
                    if (downloadPath) {
                        try {
                            if (fs.existsSync(downloadPath)) {
                                fs.rmSync(downloadPath, { recursive: true, force: true });
                            }
                        } catch (e) {
                            console.warn(`[DOWNLOAD-PROCESSOR] Failed to clean up path ${downloadPath} after cancellation:`, e);
                        }
                    }
                } else {
                    console.error(`[DOWNLOAD-PROCESSOR] Failed to import command #${commandId}:`, error);
                    this.persistDownloadState(commandId, {
                        progress: command.progress,
                        description: `Import: ${error?.message || 'Import failed'}`,
                        statusMessage: error?.message || 'Import failed',
                        state: 'importFailed',
                    });
                    CommandQueueManager.fail(commandId, error?.message || 'Unknown import error');
                    downloadEvents.emitFailed(commandId, {
                        providerId,
                        type,
                        quality: importPayload?.quality ?? null,
                        title: resolved.title,
                        artist: resolved.artist,
                        cover: resolved.cover,
                        error: error?.message || 'Unknown import error',
                        state: 'importFailed',
                    });
                }
            } finally {
                this.activeImports.delete(commandId);
                downloadEvents.emitQueueStatus(this.isPaused);
                // An import slot freed up — check for more pending imports/downloads.
                this.scheduleNext();
            }
        })();

        this.activeImports.set(commandId, { providerId, type, promise: importPromise });
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

        const recovered = CommandQueueManager.requeueStaleProcessingJobsByTypes({
            types: DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
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

    private resolvePayloadProvider(payload?: DownloadCommand): string {
        return this.pickString((payload as Record<string, unknown> | undefined)?.streamingSource)
            || this.pickString(payload?.provider)
            || getDefaultStreamingSource();
    }

    private resolveCanonicalProviderOffer(
        providerId: string,
        type: DownloadJobType,
        payload?: DownloadCommand,
    ): CanonicalProviderOffer | null {
        const entityType = type === 'album' ? 'album' : type === 'video' ? 'video' : 'track';
        const provider = this.resolvePayloadProvider(payload);
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
                    pi.provider_artist_name AS provider_artist_name,
                    rgs.provider_artist_name AS slot_provider_artist_name,
                    rgs.provider_title AS slot_provider_title,
                    rgs.cover AS slot_cover,
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
                WHERE pi.provider = ?
                  AND pi.provider_id = ?
                  AND pi.entity_type = 'album'
                  AND (? IS NULL OR pi.release_group_mbid = ?)
                ORDER BY CASE WHEN rgs.slot = ? THEN 0 ELSE 1 END, pi.updated_at DESC
                LIMIT 1
            `).get(slot, slot, provider, providerId, releaseGroupMbid, releaseGroupMbid, slot) as CanonicalProviderOffer | undefined;

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
                        rgs.provider_artist_name AS slot_provider_artist_name,
                        rgs.provider_title AS slot_provider_title,
                        rgs.cover AS slot_cover,
                        rgs.quality AS slot_quality,
                        rgs.selected_release_mbid,
                        rg.title AS canonical_album_title,
                        am.name AS artist_name
                    FROM ReleaseGroupSlots rgs
                    LEFT JOIN Albums rg ON rg.mbid = rgs.release_group_mbid
                    LEFT JOIN ArtistMetadata am ON am.mbid = COALESCE(rgs.artist_mbid, rg.artist_mbid)
                    WHERE rgs.release_group_mbid = ?
                      AND rgs.selected_provider = ?
                      AND rgs.selected_provider_id = ?
                      AND rgs.slot = ?
                    LIMIT 1
                `).get(releaseGroupMbid, provider, providerId, slot) as CanonicalProviderOffer | undefined;
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
                pi.cover AS provider_cover,
                pi.provider_artist_name AS provider_artist_name,
                rg.title AS canonical_album_title,
                t.title AS canonical_track_title,
                r.title AS canonical_recording_title,
                r.id AS canonical_recording_id,
                am.name AS artist_name
            FROM ProviderItems pi
            LEFT JOIN Albums rg ON rg.mbid = pi.release_group_mbid
            LEFT JOIN Tracks t ON t.mbid = pi.track_mbid
            LEFT JOIN Recordings r ON r.mbid = pi.recording_mbid
            LEFT JOIN ArtistMetadata am ON am.mbid = pi.artist_mbid
            WHERE pi.provider = ?
              AND pi.provider_id = ?
              AND pi.entity_type = ?
            ORDER BY pi.updated_at DESC
            LIMIT 1
        `).get(provider, providerId, entityType) as CanonicalProviderOffer | undefined;
        return row ?? null;
    }

    private hasAlbumMetadataReady(albumId: string, payload?: DownloadCommand): boolean {
        const canonicalOffer = this.resolveCanonicalProviderOffer(albumId, 'album', payload);
        return Boolean(canonicalOffer);
    }

    private hasTrackMetadataReady(trackId: string, payload?: DownloadCommand): boolean {
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

    private hasVideoMetadataReady(videoId: string, payload?: DownloadCommand): boolean {
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
        payload?: DownloadCommand,
    ): Promise<void> {
        switch (type) {
            case 'album': {
                const albumIds = providerId.split(";").filter(Boolean);
                for (const subAlbumId of albumIds) {
                    if (!this.hasAlbumMetadataReady(subAlbumId, payload)) {
                        console.log(`[DOWNLOAD-PROCESSOR] Album ${subAlbumId} is missing complete metadata; refreshing album metadata before download`);
                        await RefreshAlbumService.refreshMetadata(subAlbumId, {
                            includeSimilarAlbums: false,
                            seedSimilarAlbums: false,
                            provider: (payload as any)?.streamingSource || payload?.provider,
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
                        provider: (payload as any)?.streamingSource || payload?.provider,
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
                        provider: (payload as any)?.streamingSource || (payload as any)?.provider || undefined,
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
        payload: DownloadCommand,
    ): Required<ResolvedDownloadMetadata> {
        const fallbackTitle = payload?.title;
        const fallbackArtist = payload?.artist;
        const fallbackCover = payload?.cover ?? null;

        try {
            const canonicalOffer = this.resolveCanonicalProviderOffer(providerId, type, payload);
            if (canonicalOffer) {
                const title = type === 'album'
                    ? canonicalOffer.canonical_album_title
                    : type === 'video'
                        ? canonicalOffer.canonical_recording_title
                        : canonicalOffer.canonical_track_title || canonicalOffer.canonical_recording_title;
                const providerCover = fallbackCover
                    ?? canonicalOffer.slot_cover
                    ?? canonicalOffer.provider_cover
                    ?? canonicalOffer.asset_id
                    ?? null;
                const canonicalCover = type === 'video'
                    ? videoCoverLocalUrl(canonicalOffer.canonical_recording_id)
                    : albumCoverLocalUrl({ albumMbid: canonicalOffer.release_group_mbid });
                const cover = canonicalCover
                    ?? renderableProviderArtworkUrl(providerCover, canonicalOffer.provider);

                return {
                    title: fallbackTitle || title || canonicalOffer.slot_provider_title || canonicalOffer.provider_title || 'Unknown',
                    artist: fallbackArtist
                        || canonicalOffer.artist_name
                        || canonicalOffer.slot_provider_artist_name
                        || canonicalOffer.provider_artist_name
                        || 'Unknown',
                    cover,
                };
            }

            return {
                title: fallbackTitle || 'Unknown',
                artist: fallbackArtist || 'Unknown',
                cover: renderableProviderArtworkUrl(fallbackCover, payload?.provider),
            };
        } catch {
            return {
                title: fallbackTitle || 'Unknown',
                artist: fallbackArtist || 'Unknown',
                cover: renderableProviderArtworkUrl(fallbackCover, payload?.provider),
            };
        }
    }

    private resolveDownloadQuality(
        providerId: string,
        type: DownloadJobType,
        payload: DownloadCommand,
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
        payload: DownloadCommand,
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
        payload: DownloadCommand,
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

    private persistDownloadState(commandId: number, state: {
        progress?: number;
        description?: string;
        currentFileNum?: number;
        totalFiles?: number;
        currentTrack?: string;
        currentProviderTrackId?: string;
        currentTrackNum?: number;
        currentVolumeNum?: number;
        trackProgress?: number;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        trackStatusByProviderTrackId?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        trackStatusByTitle?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        statusMessage?: string;
        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
        speed?: string;
        eta?: string;
        size?: number;
        sizeleft?: number;
        tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }[];
    }) {
        // Merge into any buffered snapshot instead of replacing it: progress
        // events are partial (a per-track update carries no statusMessage; a
        // status line carries no trackProgress), and only the state present at
        // the flush tick gets written. Replacement would let a later generic
        // line wipe the per-track fields before they ever persist.
        const buffered = this.progressBuffer.get(commandId);
        const merged: Record<string, unknown> = buffered ? { ...buffered } : {};
        // A new current track invalidates the previous track's progress; don't
        // let the old percent bleed onto the next track.
        if (
            (state.currentProviderTrackId !== undefined && state.currentProviderTrackId !== merged.currentProviderTrackId)
            || (state.currentProviderTrackId === undefined && state.currentTrack !== undefined && state.currentTrack !== merged.currentTrack)
        ) {
            delete merged.trackProgress;
            delete merged.trackStatus;
        }
        for (const [key, value] of Object.entries(state)) {
            if (value !== undefined) {
                merged[key] = value;
            }
        }
        // Accumulate per-title statuses across the buffer window: tiddl runs
        // parallel downloads, so several tracks can change state between two
        // flushes and only the latest scalar snapshot would survive otherwise.
        if (state.currentProviderTrackId && state.trackStatus) {
            const bufferedById = (buffered as { trackStatusByProviderTrackId?: Record<string, string> } | undefined)?.trackStatusByProviderTrackId;
            merged.trackStatusByProviderTrackId = {
                ...bufferedById,
                [state.currentProviderTrackId]: state.trackStatus,
            };
        }
        if (state.currentTrack && state.trackStatus) {
            const bufferedByTitle = (buffered as { trackStatusByTitle?: Record<string, string> } | undefined)?.trackStatusByTitle;
            merged.trackStatusByTitle = {
                ...bufferedByTitle,
                [state.currentTrack]: state.trackStatus,
            };
        }
        const snapshot = merged as typeof state;

        // Terminal / transition states bypass the buffer and write immediately.
        if (state.state && IMMEDIATE_FLUSH_STATES.has(state.state)) {
            // Flush any pending buffered state for this job first so the
            // immediate write always represents the latest snapshot.
            this.progressBuffer.delete(commandId);
            if (!this.tryWriteDownloadState(commandId, snapshot)) {
                this.progressBuffer.set(commandId, snapshot);
                this.ensureProgressFlushTimer();
            }
            return;
        }

        // Buffer the latest in-flight progress for this job.
        this.progressBuffer.set(commandId, snapshot);
        this.ensureProgressFlushTimer();
    }

    private getProgressTracksForEvent(commandId: number, stateTracks?: {
        title: string;
        trackNum?: number;
        status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        providerTrackId?: string;
    }[]): {
        title: string;
        trackNum?: number;
        status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        providerTrackId?: string;
    }[] | undefined {
        if (stateTracks?.length) {
            return stateTracks;
        }

        const bufferedTracks = this.progressBuffer.get(commandId)?.tracks;
        if (Array.isArray(bufferedTracks) && bufferedTracks.length > 0) {
            return bufferedTracks;
        }

        const currentJob = CommandQueueManager.get(commandId);
        const currentDownloadState = (currentJob?.payload?.downloadState as Record<string, unknown> | undefined) || {};
        const storedTracks = currentDownloadState.tracks;
        return Array.isArray(storedTracks) && storedTracks.length > 0
            ? storedTracks as ReturnType<DownloadProcessor['getProgressTracksForEvent']>
            : undefined;
    }

    /** Unconditionally write download state to the database. */
    private writeDownloadState(commandId: number, state: {
        progress?: number;
        description?: string;
        currentFileNum?: number;
        totalFiles?: number;
        currentTrack?: string;
        currentProviderTrackId?: string;
        currentTrackNum?: number;
        currentVolumeNum?: number;
        trackProgress?: number;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        trackStatusByProviderTrackId?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        trackStatusByTitle?: Record<string, 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'>;
        statusMessage?: string;
        state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
        speed?: string;
        eta?: string;
        size?: number;
        sizeleft?: number;
        tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }[];
    }) {
        const currentJob = CommandQueueManager.get(commandId);
        const currentDownloadState = (currentJob?.payload?.downloadState as Record<string, unknown> | undefined) || {};

        let mergedTracks = state.tracks ?? currentDownloadState.tracks as any[];

        // Prefer provider-id updates from the tiddl wrapper. Title-level
        // updates remain as a fallback for legacy/partial progress events
        // because tiddl downloads tracks in parallel, so
        // "rows before currentFileNum are complete" mismarks in-flight rows).
        // Fall back to currentFileNum index inference only when neither exact
        // identity nor titles match the catalog tracklist.
        const providerAdjustedTracks = mergedTracks && state.trackStatusByProviderTrackId
            ? applyTrackStatusByProviderId(mergedTracks, state.trackStatusByProviderTrackId)
            : null;
        const titleAdjustedTracks = !providerAdjustedTracks && mergedTracks && state.trackStatusByTitle
            ? applyTrackStatusByTitle(mergedTracks, state.trackStatusByTitle)
            : null;

        if (mergedTracks && state.state === 'completed') {
            mergedTracks = mergedTracks.map((track: any) => ({
                ...track,
                status: track.status === 'error' || track.status === 'skipped' ? track.status : 'completed',
            }));
        } else if (providerAdjustedTracks) {
            mergedTracks = providerAdjustedTracks;
        } else if (titleAdjustedTracks) {
            mergedTracks = titleAdjustedTracks;
        } else if (mergedTracks && typeof state.currentFileNum === 'number') {
            const currentNum = state.currentFileNum;
            const statusState = state.state;
            mergedTracks = mergedTracks.map((t: any, idx: number) => {
                const trackIdx = idx + 1;
                let newStatus = t.status;
                if (trackIdx < currentNum) newStatus = 'completed';
                else if (trackIdx === currentNum && state.trackStatus === 'completed') newStatus = 'completed';
                else if (
                    trackIdx === currentNum
                    && (
                        statusState === 'downloading'
                        || statusState === 'importing'
                        || statusState === 'importPending'
                        || state.trackStatus === 'downloading'
                    )
                ) newStatus = 'downloading';
                return { ...t, status: newStatus };
            });
        }

        const payloadPatch: Record<string, unknown> = {
            downloadState: {
                ...currentDownloadState,
                progress: state.progress ?? currentDownloadState.progress,
                currentFileNum: state.currentFileNum ?? currentDownloadState.currentFileNum,
                totalFiles: state.totalFiles ?? currentDownloadState.totalFiles,
                currentTrack: state.currentTrack ?? currentDownloadState.currentTrack,
                currentProviderTrackId: state.currentProviderTrackId ?? currentDownloadState.currentProviderTrackId,
                currentTrackNum: state.currentTrackNum ?? currentDownloadState.currentTrackNum,
                currentVolumeNum: state.currentVolumeNum ?? currentDownloadState.currentVolumeNum,
                trackProgress: state.trackProgress ?? currentDownloadState.trackProgress,
                trackStatus: state.trackStatus ?? currentDownloadState.trackStatus,
                statusMessage: state.statusMessage ?? currentDownloadState.statusMessage,
                state: state.state ?? currentDownloadState.state,
                speed: state.speed ?? currentDownloadState.speed,
                eta: state.eta ?? currentDownloadState.eta,
                size: state.size ?? currentDownloadState.size,
                sizeleft: state.sizeleft ?? currentDownloadState.sizeleft,
                tracks: mergedTracks,
            },
        };

        if (state.description) {
            payloadPatch.description = state.description;
        }

        CommandQueueManager.updateState(commandId, {
            progress: state.progress,
            payloadPatch,
        });
    }

    private tryWriteDownloadState(commandId: number, state: Parameters<DownloadProcessor['writeDownloadState']>[1]): boolean {
        try {
            this.writeDownloadState(commandId, state);
            return true;
        } catch (error) {
            if (!isSqliteBusyError(error)) {
                throw error;
            }

            const now = Date.now();
            if (now - this.lastProgressBusyLogAt > 10_000) {
                this.lastProgressBusyLogAt = now;
                console.warn('[DOWNLOAD-PROCESSOR] Progress state write deferred because SQLite is busy');
            }
            return false;
        }
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

        for (const [commandId, state] of Array.from(this.progressBuffer)) {
            if (this.tryWriteDownloadState(commandId, state)) {
                this.progressBuffer.delete(commandId);
            }
        }

        if (this.progressBuffer.size === 0 && this.progressFlushTimer) {
            clearInterval(this.progressFlushTimer);
            this.progressFlushTimer = undefined;
        }
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
            appEvents.on(AppEvent.COMMAND_ADDED, (event: CommandEventPayload) => {
                if (DOWNLOAD_OR_IMPORT_COMMAND_NAMES.includes(event.type as (typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES)[number])) {
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
                SELECT id, name, ref_id, payload, created_at, started_at 
                FROM commands 
                WHERE status = 'started' AND name IN (${DOWNLOAD_OR_IMPORT_COMMAND_NAMES.map(() => '?').join(',')})
                ORDER BY started_at ASC
            `).all(...DOWNLOAD_OR_IMPORT_COMMAND_NAMES) as any[];

            if (stuckJobs.length > 0) {
                // Log details of what we're recovering (for diagnostic purposes)
                console.log(`[DOWNLOAD-PROCESSOR] Found ${stuckJobs.length} interrupted download job(s) from previous crash/restart:`);
                stuckJobs.forEach(job => {
                    console.log(`  - [${job.id}] ${job.name} ${job.ref_id}: "${(() => { try { const parsed = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload; return parsed?.title || "unknown"; } catch { return "unknown"; } })()}" (started ${formatQueueTimestamp(job.started_at)})`);
                });

                // Reset to pending state - will be picked up by next processQueue() call
                const recovered = CommandQueueManager.resetProcessingJobsByTypes(DOWNLOAD_OR_IMPORT_COMMAND_NAMES);
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

        // ── Import slot: imports run alongside downloads (Lidarr/Tidarr pattern) ──
        // Downloads and imports use separate slots so importing never blocks the
        // next download from starting. Import phases belong to download commands
        // that finished downloading (this.pendingImports) — there is no separate
        // ImportDownload queue row.
        while (this.activeImports.size < MAX_CONCURRENT_IMPORTS && this.pendingImports.length > 0) {
            const entry = this.pendingImports.shift();
            if (!entry) break;
            if (this.activeImports.has(entry.commandId)) continue;
            this.dispatchImportPhase(entry);
        }

        // ── Download slot: only one download at a time ──
        if (this.processing) {
            this.logBusy();
            return;
        }

        const job = CommandQueueManager.getNextJobByTypes(DOWNLOAD_COMMAND_NAMES);

        if (!job) {
            return;
        }

        // Check retry limit - if job has exceeded max attempts, fail permanently
        if (job.attempts >= MAX_RETRY_ATTEMPTS) {
            console.warn(`[DOWNLOAD-PROCESSOR] Job #${job.id} exceeded max retries (${job.attempts}/${MAX_RETRY_ATTEMPTS}), marking as permanently failed`);
            CommandQueueManager.fail(job.id, `Exceeded maximum retry attempts (${MAX_RETRY_ATTEMPTS})`);
            // Continue to next job without recursive await chains.
            this.scheduleNext();
            return;
        }

        this.processing = true;
        this.cancelCurrentDownload = false;
        this.currentJobId = job.id;
        let providerId = String(
            (job.payload as DownloadCommand | undefined)?.providerId
            || job.payload?.providerId
            || job.ref_id
            || '',
        );
        const type: DownloadJobType = job.name === CommandNames.DownloadVideo
            ? 'video'
            : job.name === CommandNames.DownloadAlbum
                ? 'album'
                : 'track';

        if (!type) {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid type: ${job.name}`);
            CommandQueueManager.fail(job.id, `Invalid job type - cannot download`);
            this.processing = false;
            this.currentJobId = undefined;
            this.scheduleNext();
            return;
        }

        // Validate providerId before processing
        if (!providerId || providerId === 'undefined' || providerId === 'null') {
            console.warn(`[DOWNLOAD-PROCESSOR] Skipping job #${job.id} with invalid providerId: ${providerId}`);
            CommandQueueManager.fail(job.id, `Invalid providerId - cannot download`);
            this.processing = false;
            this.currentJobId = undefined;
            // Process next item
            this.scheduleNext();
            return;
        }
        this.currentProviderId = providerId;
        this.currentType = type;
        this.currentDownloadPath = undefined;
        let payload = job.payload as DownloadOrImportCommand;

        console.log(`[DOWNLOAD-PROCESSOR] Processing Job #${job.id}: ${job.name} (ref: ${providerId})`);

        if (!CommandQueueManager.markProcessing(job.id)) {
            console.log(`[DOWNLOAD-PROCESSOR] Job #${job.id} is no longer pending; skipping dispatch.`);
            this.processing = false;
            this.currentJobId = undefined;
            this.currentProviderId = undefined;
            this.currentType = undefined;
            this.scheduleNext();
            return;
        }
        // Video references dedupe across providers, so payloads (including
        // retried ones persisted before an offer existed) may carry a canonical
        // Recordings id instead of a provider catalog id. Resolve to the
        // preferred provider's VIDEO offer before seeding or downloading.
        if (type === 'video') {
            const payloadProvider = (payload as any)?.streamingSource || (payload as any)?.provider || null;
            if (!isKnownProviderVideoOffer(payloadProvider, providerId)) {
                const offer = resolvePreferredVideoOffer(providerId);
                if (offer) {
                    console.log(`[DOWNLOAD-PROCESSOR] Resolved video reference ${providerId} to ${offer.provider} offer ${offer.providerId}`);
                    providerId = offer.providerId;
                    payload = {
                        ...((payload as DownloadCommand) || {}),
                        provider: offer.provider,
                        streamingSource: offer.provider,
                        providerId: offer.providerId,
                    } as unknown as DownloadOrImportCommand;
                    this.currentProviderId = providerId;
                }
            }
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

            await this.ensureMetadataReady(providerId, type, payload as DownloadCommand);

            resolved = this.resolveDownloadMetadata(providerId, type, payload);
            const resolvedQuality = this.resolveDownloadQuality(providerId, type, payload);
            payload = {
                ...((payload as DownloadCommand) || {}),
                title: resolved.title,
                artist: resolved.artist,
                cover: resolved.cover,
                quality: payload.quality ?? resolvedQuality,
            };
            job.payload = payload as DownloadCommand;

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

            // Initialize the tracklist for UI indicators from the canonical
            // MusicBrainz release. Provider rows are still used for the hard
            // provider track id, but display text must stay catalog-native.
            let initialTracks: { title: string; trackNum?: number; status: 'queued'; providerTrackId?: string }[] | undefined;
            try {
                const formatTrackDisplayTitle = (title: string | null | undefined, version?: string | null) => {
                    const baseTitle = String(title || '').trim() || 'Unknown Track';
                    const normalizedVersion = String(version || '').trim();
                    if (!normalizedVersion || baseTitle.toLowerCase().includes(normalizedVersion.toLowerCase())) {
                        return baseTitle;
                    }
                    return `${baseTitle} (${normalizedVersion})`;
                };

                if (type === 'track' || type === 'video') {
                    initialTracks = [{ title: resolved.title, status: 'queued', providerTrackId: providerId }];
                } else if (type === 'album') {
                    if (payload.releaseGroupMbid) {
                        const albumTracks = await AlbumQueryService.getAlbumTracks(payload.releaseGroupMbid);
                        initialTracks = albumTracks.map(t => ({
                            title: formatTrackDisplayTitle(t.title, t.version),
                            trackNum: t.track_number,
                            status: 'queued',
                            providerTrackId: t.preview_provider_track_id ?? undefined,
                        }));
                    }

                    if (!initialTracks?.length) {
                        const providerRows = db.prepare(`
                            SELECT
                                CAST(provider_id AS TEXT) AS provider_id,
                                title,
                                version,
                                CAST(json_extract(match_evidence, '$.trackPosition') AS INTEGER) AS track_number
                            FROM ProviderItems
                            WHERE provider = ?
                              AND entity_type = 'track'
                              AND provider_album_id = ?
                            ORDER BY
                                CAST(json_extract(match_evidence, '$.mediumPosition') AS INTEGER),
                                CAST(json_extract(match_evidence, '$.trackPosition') AS INTEGER),
                                provider_id
                        `).all(this.resolvePayloadProvider(payload), providerId) as Array<{ provider_id: string; title: string | null; version: string | null; track_number: number | null }>;

                        initialTracks = providerRows.map((row) => ({
                            title: formatTrackDisplayTitle(row.title, row.version),
                            trackNum: row.track_number ?? undefined,
                            status: 'queued',
                            providerTrackId: row.provider_id,
                        }));
                    }
                }
            } catch (error) {
                console.warn(`[DOWNLOAD-PROCESSOR] Failed to fetch initial tracks for job #${job.id}:`, error);
            }

            if (initialTracks && initialTracks.length > 0) {
                this.persistDownloadState(job.id, {
                    tracks: initialTracks,
                });
            }

            await this.downloadItem(job.id, providerId, type, payload);

            // Check if the item-specific download path has any media files before attempting organization.
            // tiddl may skip all items (already downloaded or unavailable) and exit successfully
            // without producing any new files.
            if (!await this.hasDownloadedMediaFiles(this.currentDownloadPath)) {
                // The downloader exited 0 but downloaded nothing.
                // Check if content already exists in library — if so, treat as already-imported.
                if (type === 'album') {
                    const row = this.getCanonicalAlbumDownloadProgress(providerId, payload as DownloadCommand);

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

                        CommandQueueManager.complete(job.id);
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
                    const alreadyDownloaded = this.isCanonicalProviderItemDownloaded(providerId, type, payload as DownloadCommand);

                    if (payload?.reason !== 'upgrade' && alreadyDownloaded) {
                        console.log(`[DOWNLOAD-PROCESSOR] Download workspace empty but ${type} ${providerId} is already downloaded — marking job as complete.`);
                        CommandQueueManager.complete(job.id);
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

            const completedDownloadState = (CommandQueueManager.get(job.id)?.payload?.downloadState as DownloadStatePayload | undefined) ?? {};
            const importTracks = resetTracksForImportState(completedDownloadState.tracks ?? initialTracks);

            // Download finished — transition THIS command into its import phase.
            // The command stays 'started' (one queue entity spans download →
            // import, Lidarr TrackedDownload-style); it moves to History only when
            // the import completes/fails. No separate ImportDownload row, so the UI
            // shows one row advancing by state instead of a download row vanishing
            // and an import row appearing.
            const importPayload: ImportDownloadCommand = {
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
            } as ImportDownloadCommand;

            this.persistDownloadState(job.id, {
                state: 'importPending',
                statusMessage: 'Waiting to import',
                tracks: importTracks,
                totalFiles: completedDownloadState.totalFiles,
            });

            this.pendingImports.push({
                commandId: job.id,
                providerId,
                type,
                importPayload,
                resolved,
            });

            // Ownership of the workspace passes to the import phase, which cleans
            // it up after import. Clear the download-slot pointer so the next
            // download can start without deleting this command's files.
            this.currentDownloadPath = undefined;

            console.log(`[DOWNLOAD-PROCESSOR] Downloaded ${type} ${providerId} — queued import phase for command #${job.id}`);
        } catch (error: any) {
            if (this.cancelCurrentDownload && this.isPaused) {
                const current = CommandQueueManager.get(job.id);
                if (current?.status === 'started') {
                    console.log(`[DOWNLOAD-PROCESSOR] Download job #${job.id} interrupted by pause; returning to queue`);
                    CommandQueueManager.retry(job.id);
                } else {
                    console.log(`[DOWNLOAD-PROCESSOR] Download job #${job.id} interrupted by pause; keeping status=${current?.status ?? 'unknown'}`);
                }
            } else {
                console.error(`[DOWNLOAD-PROCESSOR] Failed to download job #${job.id}:`, error);
                const currentJob = CommandQueueManager.get(job.id);
                this.persistDownloadState(job.id, {
                    progress: currentJob?.progress ?? job.progress,
                    state: 'failed',
                    statusMessage: error?.message || 'Unknown download error',
                });
                CommandQueueManager.fail(job.id, error?.message || 'Unknown download error');

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

            // Keep the workspace across retries so the downloader resumes and
            // skips already-completed items; only a permanently failed job
            // (retries exhausted) gets its workspace cleaned up.
            const jobAttempts = CommandQueueManager.get(job.id)?.attempts ?? job.attempts;
            if (jobAttempts >= MAX_RETRY_ATTEMPTS) {
                await this.cleanupDownloadSourcePath();
            }
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
        commandId: number,
        id: string,
        type: DownloadJobType,
        payload: DownloadCommand
    ): Promise<void> {
        // Download commands carry the slot's selected provider as `provider`
        // (queue-route payloads may use `streamingSource`); only fall back to
        // the default provider when neither is present.
        const providerId = (payload as any).streamingSource || (payload as any).provider || getDefaultStreamingSource();
        const baseDownloadPath = getDownloadWorkspacePath(type, id, providerId);
        const downloadPath = path.join(baseDownloadPath, `job_${commandId}`);
        this.currentDownloadPath = downloadPath;
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
            this.persistDownloadState(commandId, state);
            downloadEvents.emitProgress(commandId, {
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
                currentProviderTrackId: state.currentProviderTrackId,
                currentTrackNum: state.currentTrackNum,
                currentVolumeNum: state.currentVolumeNum,
                trackProgress: state.trackProgress,
                trackStatus: state.trackStatus,
                statusMessage: state.statusMessage,
                state: state.state,
                speed: state.speed,
                eta: state.eta,
                size: state.size,
                sizeleft: state.sizeleft,
                tracks: this.getProgressTracksForEvent(commandId, state.tracks),
            });
        };

        const checkCancelInterval = setInterval(() => {
            if (this.cancelCurrentDownload) {
                console.log(`[DOWNLOAD-PROCESSOR] Job #${commandId} cancelled, aborting provider download...\n`);
                controller.abort();
                clearInterval(checkCancelInterval);
            }
        }, 500);

        try {
            const metadataConfig = getConfigSection("metadata");

            await backend.download({
                provider: providerId,
                entityType: type as "album" | "track" | "video",
                providerId: id,
                downloadPath,
                quality: payload.quality,
                slot,
                metadata: {
                    artwork_preference: metadataConfig.artwork_preference,
                    save_lyrics: metadataConfig.save_lyrics,
                }
            }, {
                signal,
                onProgress,
            });
        } finally {
            clearInterval(checkCancelInterval);
            this.currentAbortController = undefined;
        }
    }

    /**
     * Cancel one queue item without pausing unrelated downloads.
     *
     * Provider downloads transition to cancelled before their AbortSignal is
     * fired. Active imports retain their started status as a duplicate-work
     * barrier while a persisted cancellation marker drains them to the next safe
     * checkpoint. Their cancellation only resolves after staging cleanup; files
     * already organized into a library root are deliberately not rolled back.
     */
    async cancelJob(commandId: number): Promise<void> {
        const currentJob = CommandQueueManager.get(commandId);
        if (!currentJob) {
            return;
        }

        if (this.processing && this.currentJobId === commandId) {
            this.cancelCurrentDownload = true;
            this.explicitlyCancelledDownloads.add(commandId);
            if (this.currentAbortController) {
                this.currentAbortController.abort();
            }
            CommandQueueManager.cancel(commandId);
        } else if (this.activeImports.has(commandId)) {
            // Cannot abort active import; mark as cancelled for when it finishes
            this.explicitlyCancelledDownloads.add(commandId);
            db.prepare("UPDATE commands SET payload = json_set(COALESCE(payload, '{}'), '$.importCancellationRequested', json('true')) WHERE id = ?").run(commandId);
            await this.activeImports.get(commandId)?.promise;
        } else if (currentJob.status === 'queued' || currentJob.status === 'started') {
            CommandQueueManager.cancel(commandId);
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

    isActivelyProcessingJob(commandId: number): boolean {
        return (this.processing && this.currentJobId === commandId) || this.activeImports.has(commandId);
    }

    getStatus(): {
        isPaused: boolean;
        processing: boolean;
        currentJobId?: number;
        currentProviderId?: string;
        currentType?: string;
        activeImports: number;
        activeImportIds: number[];
    } {
        return {
            isPaused: this.isPaused,
            processing: this.processing,
            currentJobId: this.currentJobId,
            currentProviderId: this.currentProviderId,
            currentType: this.currentType,
            activeImports: this.activeImports.size,
            activeImportIds: Array.from(this.activeImports.keys()),
        };
    }

    isActivelyImporting(commandId: number): boolean {
        return this.activeImports.has(commandId);
    }
}

type DownloadProcessorStatus = ReturnType<DownloadProcessor['getStatus']>;

type DownloadWorkerRequestKind = 'initialize' | 'processQueue' | 'pause' | 'resume' | 'cancelJob';

type DownloadWorkerToMainMessage =
    | { kind: 'ready' }
    | { kind: 'status'; status: DownloadProcessorStatus }
    | { kind: 'downloadEvent'; event: string; payload: unknown }
    | { kind: 'event'; event: string; payload: unknown }
    | { kind: 'cacheInvalidate'; target: CacheInvalidateTarget; key?: string }
    | { kind: 'response'; requestId: number; ok: true }
    | { kind: 'response'; requestId: number; ok: false; error: string };

type DownloadWorkerRequest = {
    kind: DownloadWorkerRequestKind;
    requestId: number;
    commandId?: number;
};

function resolveDownloadWorkerSpawn(): { entry: string; workerData: Record<string, unknown> } {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const isCompiled = here.includes(`${path.sep}dist${path.sep}`) || here.endsWith(`${path.sep}dist`);
    const workerData: Record<string, unknown> = { [DOWNLOAD_WORKER_MARKER]: true };

    if (isCompiled) {
        return {
            entry: path.join(here, 'download-processor-worker-entry.js'),
            workerData,
        };
    }

    return {
        entry: path.join(here, '..', 'commands', 'worker', 'command-worker-bootstrap.mjs'),
        workerData: {
            ...workerData,
            __entry: pathToFileURL(path.join(here, 'download-processor-worker-entry.ts')).href,
        },
    };
}

class DownloadProcessorWorkerProxy {
    private worker?: Worker;
    private nextRequestId = 1;
    private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    private initialized = false;
    private stopping = false;
    private status: DownloadProcessorStatus = {
        isPaused: process.env.DISCOGENIUS_START_PAUSED === '1',
        processing: false,
        activeImports: 0,
        activeImportIds: [],
    };

    async initialize(): Promise<void> {
        this.initialized = true;
        this.subscribeToQueueEvents();
        await this.request('initialize');
    }

    // The worker's own COMMAND_ADDED listener only hears events emitted inside
    // that thread. Enqueues from the main thread (routes) and from command
    // workers (upgrader, monitoring) surface on the main appEvents emitter, so
    // the proxy must relay them into the download worker as a queue kick.
    private queueEventsSubscribed = false;

    private subscribeToQueueEvents(): void {
        if (this.queueEventsSubscribed) return;
        this.queueEventsSubscribed = true;
        appEvents.on(AppEvent.COMMAND_ADDED, (event: CommandEventPayload) => {
            if (!this.initialized || process.env.DISCOGENIUS_DISABLE_DOWNLOADS === '1') return;
            if (!DOWNLOAD_OR_IMPORT_COMMAND_NAMES.includes(event.type as (typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES)[number])) return;
            void this.processQueue().catch((error) => {
                console.error('[DOWNLOAD-PROCESSOR] Failed to relay queue kick to download worker:', error);
            });
        });
    }

    async processQueue(): Promise<void> {
        await this.request('processQueue');
    }

    async pause(): Promise<void> {
        await this.request('pause');
    }

    async resume(): Promise<void> {
        await this.request('resume');
    }

    async cancelJob(commandId: number): Promise<void> {
        await this.request('cancelJob', commandId);
    }

    isActivelyProcessingJob(commandId: number): boolean {
        return this.status.currentJobId === commandId || this.status.activeImportIds.includes(commandId);
    }

    getStatus(): DownloadProcessorStatus {
        return { ...this.status, activeImportIds: [...this.status.activeImportIds] };
    }

    isActivelyImporting(commandId: number): boolean {
        return this.status.activeImportIds.includes(commandId);
    }

    private request(kind: DownloadWorkerRequestKind, commandId?: number): Promise<void> {
        // Only initialize() may spawn the worker. Control calls before boot
        // (tests exercising the upgrader, shutdown with downloads disabled)
        // must not start a download thread — a live worker also keeps the
        // process alive, which hangs the node test runner.
        if (kind !== 'initialize' && !this.initialized) {
            return Promise.resolve();
        }

        const worker = this.ensureWorker();
        const requestId = this.nextRequestId++;
        return new Promise<void>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            worker.postMessage({ kind, requestId, commandId } satisfies DownloadWorkerRequest);
        });
    }

    private ensureWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }

        const { entry, workerData } = resolveDownloadWorkerSpawn();
        const worker = new Worker(entry, { workerData });
        // The API server's HTTP listener keeps the process alive; the worker
        // must never be the thing pinning it (shutdown calls process.exit).
        worker.unref();
        this.worker = worker;
        this.stopping = false;

        worker.on('message', (message: DownloadWorkerToMainMessage) => this.handleMessage(message));
        worker.on('error', (error) => {
            console.error('[DOWNLOAD-PROCESSOR] Worker error:', error);
        });
        worker.on('exit', (code) => {
            this.worker = undefined;
            const error = new Error(`Download processor worker exited with code ${code}`);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();

            if (!this.stopping && this.initialized) {
                console.error('[DOWNLOAD-PROCESSOR] Worker exited unexpectedly; restarting download worker');
                void this.initialize().catch((restartError) => {
                    console.error('[DOWNLOAD-PROCESSOR] Failed to restart download worker:', restartError);
                });
            }
        });

        return worker;
    }

    private handleMessage(message: DownloadWorkerToMainMessage): void {
        switch (message.kind) {
            case 'ready':
                break;
            case 'status':
                this.status = {
                    ...message.status,
                    activeImportIds: message.status.activeImportIds ?? [],
                };
                break;
            case 'downloadEvent':
                downloadEvents.emit(message.event, message.payload);
                break;
            case 'event':
                appEvents.emit(message.event as AppEvent, message.payload as never);
                break;
            case 'cacheInvalidate':
                this.applyCacheInvalidate(message.target, message.key);
                break;
            case 'response': {
                const pending = this.pending.get(message.requestId);
                if (!pending) return;
                this.pending.delete(message.requestId);
                if (message.ok) {
                    pending.resolve();
                } else {
                    pending.reject(new Error(message.error));
                }
                break;
            }
        }
    }

    private applyCacheInvalidate(target: CacheInvalidateTarget, key?: string): void {
        switch (target) {
            case 'album':
                if (key) invalidateAlbumDownloadStatus(key);
                break;
            case 'releaseGroup':
                if (key) invalidateReleaseGroupDownloadStatus(key);
                break;
            case 'artist':
                if (key) invalidateArtistDownloadStatus(key);
                break;
            case 'media':
                if (key) invalidateMediaDownloadState(key);
                break;
            case 'all':
                invalidateAllDownloadState();
                break;
        }
    }
}

// Command workers must not run their own download loop: an enqueue there
// already bridges COMMAND_ADDED to the main thread, whose proxy kicks the
// dedicated download worker. This stub keeps accidental processQueue() calls
// (e.g. the upgrader) from claiming jobs inside a command worker.
class DownloadProcessorCommandWorkerStub {
    async initialize(): Promise<void> {}

    async processQueue(): Promise<void> {}

    async pause(): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    async resume(): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    async cancelJob(_commandId: number): Promise<void> {
        throw new Error('Download processor controls are unavailable inside command workers');
    }

    isActivelyProcessingJob(_commandId: number): boolean {
        return false;
    }

    isActivelyImporting(_commandId: number): boolean {
        return false;
    }

    getStatus(): DownloadProcessorStatus {
        return {
            isPaused: false,
            processing: false,
            activeImports: 0,
            activeImportIds: [],
        };
    }
}

const isDownloadWorkerThread = !isMainThread
    && (workerData as Record<string, unknown> | null)?.[DOWNLOAD_WORKER_MARKER] === true;

export const downloadProcessor = isMainThread
    ? new DownloadProcessorWorkerProxy()
    : isDownloadWorkerThread
        ? new DownloadProcessor()
        : new DownloadProcessorCommandWorkerStub();
