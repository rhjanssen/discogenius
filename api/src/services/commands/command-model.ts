/**
 * Command status, the command-name → body type map, and the persisted command
 * record (`CommandModel`). Mirrors Lidarr's `CommandStatus.cs` + `CommandModel.cs`
 * (the body interfaces themselves live in `command-bodies.ts`, ≈ Lidarr's
 * individual `*Command.cs` files).
 */

import { CommandNames, type CommandName } from "./command-names.js";
import type {
    ApplyCurationCommand,
    BulkRefreshArtistCommand,
    CheckHealthCommand,
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
    UpdateLibraryMetadataCommand,
} from "./command-bodies.js";

export type CommandStatus = 'queued' | 'started' | 'completed' | 'failed' | 'cancelled';

export interface CommandBodyMap {
    [CommandNames.RefreshArtist]: RefreshArtistCommand;
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
    [CommandNames.CleanupTempFiles]: CleanupTempFilesCommand;
    [CommandNames.UpdateLibraryMetadata]: UpdateLibraryMetadataCommand;
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
    error?: string;
    ref_id?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    updated_at?: string;
}

export type CommandModelOf<T extends CommandName> = CommandModelRecordBase<T>;
export type CommandModel = { [K in CommandName]: CommandModelOf<K> }[CommandName];
