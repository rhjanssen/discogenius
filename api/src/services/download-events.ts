import { EventEmitter } from 'events';

/**
 * Event emitter with built-in throttling.
 *
 * Design:
 * - Structural events (started, completed, failed) emit immediately.
 * - Progress events are throttled to at most once per PROGRESS_EMIT_INTERVAL_MS
 *   per job. The latest progress snapshot is always buffered so the most recent
 *   state is never lost — it will be flushed on the next tick.
 * - Queue-status events are debounced over QUEUE_STATUS_DEBOUNCE_MS (5 s).
 */

const PROGRESS_EMIT_INTERVAL_MS = 1_000;
const QUEUE_STATUS_DEBOUNCE_MS = 5_000;

class DownloadEventEmitter extends EventEmitter {
    private static instance: DownloadEventEmitter;

    // --- Progress throttle state (per-job) ---
    private progressBuffer = new Map<number, DownloadProgressData>();
    private progressLastEmit = new Map<number, number>();
    private progressFlushTimer: ReturnType<typeof setInterval> | undefined;

    // --- Queue-status debounce state ---
    private queueStatusTimer: ReturnType<typeof setTimeout> | undefined;
    private queueStatusPending: boolean | null = null;

    private constructor() {
        super();
        this.setMaxListeners(50);
    }

    static getInstance(): DownloadEventEmitter {
        if (!DownloadEventEmitter.instance) {
            DownloadEventEmitter.instance = new DownloadEventEmitter();
        }
        return DownloadEventEmitter.instance;
    }

    // ---- Progress (throttled) -------------------------------------------------

    /**
     * Buffer a progress update. If the job hasn't emitted within the throttle
     * window the event is sent immediately; otherwise it is buffered and flushed
     * by the periodic timer.
     *
     * Structural state transitions (completed, failed, importPending, importing,
     * importFailed) bypass the throttle and emit immediately so the frontend
     * can react without delay.
     */
    emitProgress(jobId: number, data: DownloadProgressData) {
        const IMMEDIATE_STATES = new Set(['completed', 'failed', 'importPending', 'importing', 'importFailed']);
        if (data.state && IMMEDIATE_STATES.has(data.state)) {
            this.progressBuffer.delete(jobId);
            this.progressLastEmit.set(jobId, Date.now());
            this.emit('progress-batch', [{ jobId, ...data }]);
            return;
        }

        const now = Date.now();
        const lastEmit = this.progressLastEmit.get(jobId) ?? 0;

        if (now - lastEmit >= PROGRESS_EMIT_INTERVAL_MS) {
            this.progressBuffer.delete(jobId);
            this.progressLastEmit.set(jobId, now);
            this.emit('progress-batch', [{ jobId, ...data }]);
        } else {
            this.progressBuffer.set(jobId, data);
        }

        this.ensureProgressFlushTimer();
    }

    private ensureProgressFlushTimer(): void {
        if (this.progressFlushTimer) return;
        this.progressFlushTimer = setInterval(() => {
            this.flushProgressBuffer();
        }, PROGRESS_EMIT_INTERVAL_MS);
        this.progressFlushTimer.unref();
    }

    private flushProgressBuffer(): void {
        if (this.progressBuffer.size === 0) {
            if (this.progressFlushTimer) {
                clearInterval(this.progressFlushTimer);
                this.progressFlushTimer = undefined;
            }
            return;
        }

        const now = Date.now();
        const batch: Array<DownloadProgressData & { jobId: number }> = [];
        for (const [jobId, data] of this.progressBuffer) {
            this.progressLastEmit.set(jobId, now);
            batch.push({ jobId, ...data });
        }
        this.progressBuffer.clear();
        this.emit('progress-batch', batch);
    }

    /** Clean up throttle state for a finished job. */
    clearJob(jobId: number): void {
        this.progressBuffer.delete(jobId);
        this.progressLastEmit.delete(jobId);
    }

    // ---- Structural events (immediate) ----------------------------------------

    emitStarted(jobId: number, data: DownloadStartedData) {
        this.emit('started', { jobId, ...data });
    }

    emitCompleted(jobId: number, data: DownloadCompletedData) {
        this.clearJob(jobId);
        this.emit('completed', { jobId, ...data });
    }

    emitFailed(jobId: number, data: DownloadFailedData) {
        this.clearJob(jobId);
        this.emit('failed', { jobId, ...data });
    }

    // ---- Queue status (debounced, 5 s) ---------------------------------

    emitQueueStatus(isPaused: boolean) {
        this.queueStatusPending = isPaused;

        if (this.queueStatusTimer) {
            return;
        }

        this.queueStatusTimer = setTimeout(() => {
            this.queueStatusTimer = undefined;
            if (this.queueStatusPending !== null) {
                this.emit('queue-status', { isPaused: this.queueStatusPending });
                this.queueStatusPending = null;
            }
        }, QUEUE_STATUS_DEBOUNCE_MS);
    }
}

/**
 * Download progress data interface
 *
 * Progress is reported at two levels:
 * 1. Overall progress (album/playlist level): currentFileNum / totalFiles
 * 2. Item progress (current track): trackProgress 0-100
 */
export interface DownloadProgressData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    quality?: string | null;
    title?: string;
    artist?: string;
    cover?: string | null;

    /** Overall progress percentage 0-100 */
    progress: number;

    /** Download speed if available (e.g., "1.2 MB/s") */
    speed?: string;

    /** Estimated time remaining if available (e.g., "00:23") */
    eta?: string;

    /** Current file being downloaded (full path or name) */
    currentFile?: string;

    /** Total number of files to download (for albums/playlists) */
    totalFiles?: number;

    /** Current file number being downloaded (1-based) */
    currentFileNum?: number;

    /** Current track name being downloaded */
    currentTrack?: string;

    /** Progress of current track 0-100 */
    trackProgress?: number;

    /** Status of current track download */
    trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';

    /** Status message (e.g., "Switching to Atmos...", "Rate limited...") */
    statusMessage?: string;

    /** Overall download state */
    state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';

    /** Track list for album/playlist downloads with per-track status */
    tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];

    /** Size information */
    size?: number;  // Total size in bytes (if known)
    sizeleft?: number;  // Remaining size in bytes (if known)
}

export interface DownloadStartedData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    quality?: string | null;
    title?: string;
    artist?: string;
    cover?: string | null;
}

export interface DownloadCompletedData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    quality?: string | null;
    title?: string;
    artist?: string;
    cover?: string | null;
    path?: string;
}

export interface DownloadFailedData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    quality?: string | null;
    title?: string;
    artist?: string;
    cover?: string | null;
    error: string;
    state?: 'failed' | 'importFailed';
}

export const downloadEvents = DownloadEventEmitter.getInstance();
