import { EventEmitter } from 'events';

/**
 * Global event emitter for download progress updates
 * Used to broadcast real-time updates to SSE clients
 */
class DownloadEventEmitter extends EventEmitter {
    private static instance: DownloadEventEmitter;

    private constructor() {
        super();
        this.setMaxListeners(50); // Allow many SSE connections
    }

    static getInstance(): DownloadEventEmitter {
        if (!DownloadEventEmitter.instance) {
            DownloadEventEmitter.instance = new DownloadEventEmitter();
        }
        return DownloadEventEmitter.instance;
    }

    /**
     * Emit download progress update
     */
    emitProgress(jobId: number, data: DownloadProgressData) {
        this.emit('progress', { jobId, ...data });
    }

    /**
     * Emit download started
     */
    emitStarted(jobId: number, data: DownloadStartedData) {
        this.emit('started', { jobId, ...data });
    }

    /**
     * Emit download completed
     */
    emitCompleted(jobId: number, data: DownloadCompletedData) {
        this.emit('completed', { jobId, ...data });
    }

    /**
     * Emit download failed
     */
    emitFailed(jobId: number, data: DownloadFailedData) {
        this.emit('failed', { jobId, ...data });
    }

    /**
     * Emit queue status change (paused/resumed)
     */
    emitQueueStatus(isPaused: boolean) {
        this.emit('queue-status', { isPaused });
    }
}

/**
 * Download progress data interface - Lidarr-style progress tracking
 * 
 * Progress is reported at two levels:
 * 1. Overall progress (album/playlist level): currentFileNum / totalFiles
 * 2. Item progress (current track): trackProgress 0-100
 */
export interface DownloadProgressData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
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
    state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused';

    /** Track list for album/playlist downloads with per-track status */
    tracks?: { title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }[];

    /** Size information for Lidarr-style display */
    size?: number;  // Total size in bytes (if known)
    sizeleft?: number;  // Remaining size in bytes (if known)
}

export interface DownloadStartedData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    title?: string;
    artist?: string;
    cover?: string | null;
}

export interface DownloadCompletedData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    title?: string;
    artist?: string;
    cover?: string | null;
    path?: string;
}

export interface DownloadFailedData {
    tidalId: string;
    type: 'track' | 'video' | 'album' | 'playlist';
    title?: string;
    artist?: string;
    cover?: string | null;
    error: string;
}

export const downloadEvents = DownloadEventEmitter.getInstance();
