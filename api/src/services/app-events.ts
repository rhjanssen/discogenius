import { EventEmitter } from 'events';
import type { ArtistWorkflow } from './artist-workflow.js';
import type { MonitoringPassWorkflowValue } from './job-payloads.js';
import type { AnyJobPayload, JobStatus, JobType } from './queue.js';

/**
 * Strongly typed events mapping
 */
export enum AppEvent {
    // Job Queue Events
    JOB_ADDED = 'job.added',
    JOB_UPDATED = 'job.updated',
    JOB_DELETED = 'job.deleted',
    QUEUE_CLEARED = 'queue.cleared',

    // Scanner Events
    ARTIST_SCANNED = 'artist.scanned',
    ALBUM_SCANNED = 'album.scanned',
    RESCAN_COMPLETED = 'rescan.completed',

    // Config Events
    CONFIG_UPDATED = 'config.updated',

    // File Events
    FILE_ADDED = 'file.added',
    FILE_DELETED = 'file.deleted',
    FILE_UPGRADED = 'file.upgraded',
}

export interface JobEventPayload {
    id: number;
    type: JobType;
    status: JobStatus;
    progress: number;
    payload?: AnyJobPayload;
    error?: string;
}

export interface ArtistScannedEventPayload {
    artistId: string;
    artistName: string;
    workflow?: ArtistWorkflow;
    monitoringCycle?: MonitoringPassWorkflowValue;
    scanLibrary: boolean;
    forceDownloadQueue: boolean;
    trigger: number;
}

export interface RescanCompletedEventPayload {
    artistId: string;
    artistName: string;
    workflow?: ArtistWorkflow;
    monitoringCycle?: MonitoringPassWorkflowValue;
    skipDownloadQueue: boolean;
    skipCuration: boolean;
    skipMetadataBackfill: boolean;
    forceDownloadQueue: boolean;
    trigger: number;
}

export interface AppEventPayloadMap {
    [AppEvent.JOB_ADDED]: JobEventPayload;
    [AppEvent.JOB_UPDATED]: JobEventPayload;
    [AppEvent.JOB_DELETED]: JobEventPayload;
    [AppEvent.QUEUE_CLEARED]: undefined;
    [AppEvent.ARTIST_SCANNED]: ArtistScannedEventPayload;
    [AppEvent.ALBUM_SCANNED]: Record<string, unknown>;
    [AppEvent.RESCAN_COMPLETED]: RescanCompletedEventPayload;
    [AppEvent.CONFIG_UPDATED]: Record<string, unknown>;
    [AppEvent.FILE_ADDED]: Record<string, unknown>;
    [AppEvent.FILE_DELETED]: Record<string, unknown>;
    [AppEvent.FILE_UPGRADED]: Record<string, unknown>;
}

class TypedAppEventEmitter extends EventEmitter {
    emit<K extends AppEvent>(event: K, payload?: AppEventPayloadMap[K]): boolean;
    emit(event: string | symbol, payload?: unknown): boolean {
        return super.emit(event, payload);
    }

    on<K extends AppEvent>(event: K, listener: (payload: AppEventPayloadMap[K]) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this {
        return super.on(event, listener);
    }

    once<K extends AppEvent>(event: K, listener: (payload: AppEventPayloadMap[K]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this {
        return super.once(event, listener);
    }

    off<K extends AppEvent>(event: K, listener: (payload: AppEventPayloadMap[K]) => void): this;
    off(event: string | symbol, listener: (...args: unknown[]) => void): this {
        return super.off(event, listener);
    }
}

export const appEvents = new TypedAppEventEmitter();
appEvents.setMaxListeners(50);
