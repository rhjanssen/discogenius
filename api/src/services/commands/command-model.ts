/**
 * Command status, the command-name → body type map, and the persisted command
 * record (`CommandModel`). Command body interfaces live in `command-bodies.ts`.
 */

import { CommandNames, type CommandName } from "./command-names.js";
import type {
    ApplyCurationCommand,
    BulkRefreshArtistCommand,
    CheckHealthCommand,
    BackupDatabaseCommand,
    CheckUpgradesCommand,
    CleanupTempFilesCommand,
    CompactDatabaseCommand,
    ConfigPruneCommand,
    CurateArtistCommand,
    DownloadAlbumCommand,
    DownloadMissingCommand,
    DownloadMissingForceCommand,
    DownloadTrackCommand,
    DownloadVideoCommand,
    HousekeepingCommand,
    ImportDownloadCommand,
    ImportProviderArtistsCommand,
    ImportUnmappedFilesCommand,
    LibraryBulkActionCommand,
    MatchArtistProvidersCommand,
    MoveArtistCommand,
    RefreshAlbumCommand,
    RefreshArtistCommand,
    RefreshMetadataCommand,
    RenameArtistCommand,
    RenameFilesCommand,
    RescanAllRootsCommand,
    RescanFoldersCommand,
    RetagArtistCommand,
    RetagFilesCommand,
    SeedVideoCommand,
    UpdateLibraryMetadataCommand,
} from "./command-bodies.js";

export type CommandStatus = 'queued' | 'started' | 'completed' | 'failed' | 'cancelled';

export interface CommandBodyMap {
    [CommandNames.RefreshArtist]: RefreshArtistCommand;
    [CommandNames.MatchArtistProviders]: MatchArtistProvidersCommand;
    [CommandNames.RefreshAlbum]: RefreshAlbumCommand;
    [CommandNames.RefreshMetadata]: RefreshMetadataCommand;
    [CommandNames.ApplyCuration]: ApplyCurationCommand;
    [CommandNames.DownloadMissing]: DownloadMissingCommand;
    [CommandNames.CheckUpgrades]: CheckUpgradesCommand;
    [CommandNames.Housekeeping]: HousekeepingCommand;
    [CommandNames.DownloadTrack]: DownloadTrackCommand;
    [CommandNames.DownloadVideo]: DownloadVideoCommand;
    [CommandNames.DownloadAlbum]: DownloadAlbumCommand;
    [CommandNames.CurateArtist]: CurateArtistCommand;
    [CommandNames.RescanFolders]: RescanFoldersCommand;
    [CommandNames.ImportDownload]: ImportDownloadCommand;
    [CommandNames.ConfigPrune]: ConfigPruneCommand;
    [CommandNames.MoveArtist]: MoveArtistCommand;
    [CommandNames.RenameFiles]: RenameFilesCommand;
    [CommandNames.RenameArtist]: RenameArtistCommand;
    [CommandNames.RetagFiles]: RetagFilesCommand;
    [CommandNames.RetagArtist]: RetagArtistCommand;
    [CommandNames.BulkRefreshArtist]: BulkRefreshArtistCommand;
    [CommandNames.DownloadMissingForce]: DownloadMissingForceCommand;
    [CommandNames.RescanAllRoots]: RescanAllRootsCommand;
    [CommandNames.CheckHealth]: CheckHealthCommand;
    [CommandNames.CompactDatabase]: CompactDatabaseCommand;
    [CommandNames.BackupDatabase]: BackupDatabaseCommand;
    [CommandNames.CleanupTempFiles]: CleanupTempFilesCommand;
    [CommandNames.UpdateLibraryMetadata]: UpdateLibraryMetadataCommand;
    [CommandNames.ImportProviderArtists]: ImportProviderArtistsCommand;
    [CommandNames.ImportUnmappedFiles]: ImportUnmappedFilesCommand;
    [CommandNames.LibraryBulkAction]: LibraryBulkActionCommand;
    [CommandNames.SeedVideo]: SeedVideoCommand;
}

export type AnyCommandBody = CommandBodyMap[CommandName];

export interface CommandModelRecordBase<T extends CommandName> {
    id: number;
    name: T;
    payload: CommandBodyMap[T];
    status: CommandStatus;
    progress: number;
    priority: number;
    trigger?: number;
    queue_order?: number | null;
    attempts: number;
    /** Durable non-download execution-attempt number, incremented on claim. */
    attempt: number;
    error?: string;
    /** Opaque per-attempt ownership token. It is not a reusable OS thread id. */
    worker_id?: string | null;
    heartbeat_at?: string | null;
    last_progress_at?: string | null;
    progress_phase?: string | null;
    progress_current?: number | null;
    progress_total?: number | null;
    lease_expires_at?: string | null;
    blocked_reason?: string | null;
    retry_after?: string | null;
    last_retry_reason?: string | null;
    ref_id?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    updated_at?: string;
}

export type CommandModelOf<T extends CommandName> = CommandModelRecordBase<T>;
export type CommandModel = { [K in CommandName]: CommandModelOf<K> }[CommandName];
