import { EventEmitter } from 'events';
import { forwardEventToMain, isCommandWorker } from './worker/command-worker-protocol.js';
import type { ArtistWorkflow } from '../music/artist-workflow.js';
import type { MonitoringPassWorkflowValue } from './command-bodies.js';
import type {AnyCommandBody, CommandStatus} from "./command-model.js";
import type {CommandName} from "./command-names.js";

/**
 * Strongly typed events mapping
 */
export enum AppEvent {
    // Job Queue Events
    COMMAND_ADDED = 'command.added',
    COMMAND_UPDATED = 'command.updated',
    COMMAND_DELETED = 'command.deleted',
    QUEUE_CLEARED = 'queue.cleared',
    HISTORY_ADDED = 'history.added',

    // Scanner Events — Lidarr vocabulary: "refresh" = metadata refresh,
    // "scan" = disk scan. (ArtistRefreshCompleteEvent / ArtistScannedEvent.)
    ARTIST_REFRESH_COMPLETED = 'artist.refresh.completed',
    ARTIST_SCANNED = 'artist.scanned',

    // Config Events
    CONFIG_UPDATED = 'config.updated',

    // File Events
    FILE_ADDED = 'file.added',
    FILE_DELETED = 'file.deleted',
    FILE_UPGRADED = 'file.upgraded',
}

export interface CommandEventPayload {
    id: number;
    type: CommandName;
    status: CommandStatus;
    progress: number;
    payload?: AnyCommandBody;
    error?: string;
}

// Raised when a metadata refresh completes (Lidarr ArtistRefreshCompleteEvent).
export interface ArtistRefreshCompletedEventPayload {
    artistId: string;
    artistName: string;
    workflow?: ArtistWorkflow;
    monitoringCycle?: MonitoringPassWorkflowValue;
    scanLibrary: boolean;
    forceDownloadQueue: boolean;
    trigger: number;
}

// Raised when a disk scan completes (Lidarr ArtistScannedEvent).
export interface ArtistScannedEventPayload {
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

export interface FileChangeEventPayload {
    libraryFileId?: number | null;
    artistId?: string | number | null;
    albumId?: string | number | null;
    mediaId?: string | number | null;
    fileType?: string | null;
    filePath?: string | null;
    previousPath?: string | null;
    previousFilePath?: string | null;
    previousQuality?: string | null;
    replacementPath?: string | null;
    libraryRoot?: string | null;
    quality?: string | null;
    missing?: boolean;
    reason?: string | null;
    timestamp?: string | null;
}

export interface AppEventPayloadMap {
    [AppEvent.COMMAND_ADDED]: CommandEventPayload;
    [AppEvent.COMMAND_UPDATED]: CommandEventPayload;
    [AppEvent.COMMAND_DELETED]: CommandEventPayload;
    [AppEvent.QUEUE_CLEARED]: undefined;
    [AppEvent.HISTORY_ADDED]: Record<string, unknown>;
    [AppEvent.ARTIST_REFRESH_COMPLETED]: ArtistRefreshCompletedEventPayload;
    [AppEvent.ARTIST_SCANNED]: ArtistScannedEventPayload;
    [AppEvent.CONFIG_UPDATED]: Record<string, unknown>;
    [AppEvent.FILE_ADDED]: FileChangeEventPayload;
    [AppEvent.FILE_DELETED]: FileChangeEventPayload;
    [AppEvent.FILE_UPGRADED]: FileChangeEventPayload;
}

class TypedAppEventEmitter extends EventEmitter {
    emit<K extends AppEvent>(event: K, payload?: AppEventPayloadMap[K]): boolean;
    emit(event: string | symbol, payload?: unknown): boolean {
        // When emitted from a command worker thread, forward to the main thread so
        // the SSE stream and main-thread listeners (curation/download) see it.
        // The bridge is a no-op on the main thread. Only string event names are
        // bridgeable (all AppEvent values are strings); symbol events stay local.
        if (typeof event === 'string' && isCommandWorker()) {
            forwardEventToMain(event, payload);
        }
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

export function emitFileAdded(payload: FileChangeEventPayload) {
    appEvents.emit(AppEvent.FILE_ADDED, payload);
}

export function emitFileDeleted(payload: FileChangeEventPayload) {
    appEvents.emit(AppEvent.FILE_DELETED, payload);
}

export function emitFileUpgraded(payload: FileChangeEventPayload) {
    appEvents.emit(AppEvent.FILE_UPGRADED, payload);
}
