/**
 * Command identity — the set of command type names and the groupings used for
 * queue selection/exclusivity. Mirrors Lidarr keeping command identity (the
 * `Command` type names) distinct from the queue manager and the command bodies.
 * Pure constants + type guards; no runtime dependencies.
 */

export const CommandNames = {
    RefreshArtist: 'RefreshArtist',
    RefreshAlbum: 'RefreshAlbum',
    RefreshMetadata: 'RefreshMetadata',
    ApplyCuration: 'ApplyCuration',
    DownloadMissing: 'DownloadMissing',
    CheckUpgrades: 'CheckUpgrades',
    Housekeeping: 'Housekeeping',
    DownloadTrack: 'DownloadTrack',
    DownloadVideo: 'DownloadVideo',
    DownloadAlbum: 'DownloadAlbum',
    CurateArtist: 'CurateArtist',
    RescanFolders: 'RescanFolders',
    ImportDownload: 'ImportDownload',
    ConfigPrune: 'ConfigPrune',
    MoveArtist: 'MoveArtist',
    RenameFiles: 'RenameFiles',
    RenameArtist: 'RenameArtist',
    RetagFiles: 'RetagFiles',
    RetagArtist: 'RetagArtist',
    BulkRefreshArtist: 'BulkRefreshArtist',
    DownloadMissingForce: 'DownloadMissingForce',
    RescanAllRoots: 'RescanAllRoots',
    CheckHealth: 'CheckHealth',
    CompactDatabase: 'CompactDatabase',
    CleanupTempFiles: 'CleanupTempFiles',
    UpdateLibraryMetadata: 'UpdateLibraryMetadata',
} as const;

export type CommandName = typeof CommandNames[keyof typeof CommandNames];

export const DOWNLOAD_COMMAND_NAMES = [
    CommandNames.DownloadTrack,
    CommandNames.DownloadVideo,
    CommandNames.DownloadAlbum,
] as const;

export const DOWNLOAD_OR_IMPORT_COMMAND_NAMES = [
    ...DOWNLOAD_COMMAND_NAMES,
    CommandNames.ImportDownload,
] as const;

export const ARTIST_WORKFLOW_COMMAND_NAMES = [
    CommandNames.RefreshArtist,
    CommandNames.RescanFolders,
    CommandNames.CurateArtist,
] as const;

/**
 * All non-download job types processed by the Scheduler.
 * Used for global priority selection.
 */
export const NON_DOWNLOAD_COMMAND_NAMES = [
    CommandNames.RefreshArtist,
    CommandNames.RefreshAlbum,
    CommandNames.RefreshMetadata,
    CommandNames.ApplyCuration,
    CommandNames.DownloadMissing,
    CommandNames.CheckUpgrades,
    CommandNames.Housekeeping,
    CommandNames.CurateArtist,
    CommandNames.RescanFolders,
    CommandNames.ConfigPrune,
    CommandNames.MoveArtist,
    CommandNames.RenameFiles,
    CommandNames.RenameArtist,
    CommandNames.RetagFiles,
    CommandNames.RetagArtist,
    CommandNames.BulkRefreshArtist,
    CommandNames.DownloadMissingForce,
    CommandNames.RescanAllRoots,
    CommandNames.CheckHealth,
    CommandNames.CompactDatabase,
    CommandNames.CleanupTempFiles,
    CommandNames.UpdateLibraryMetadata,
] as const;

export function isDownloadJobType(type: string): type is typeof DOWNLOAD_COMMAND_NAMES[number] {
    return (DOWNLOAD_COMMAND_NAMES as readonly string[]).includes(type);
}

export function isDownloadOrImportJobType(type: string): type is typeof DOWNLOAD_OR_IMPORT_COMMAND_NAMES[number] {
    return (DOWNLOAD_OR_IMPORT_COMMAND_NAMES as readonly string[]).includes(type);
}

export function isCommandName(value: string): value is CommandName {
    return (Object.values(CommandNames) as string[]).includes(value);
}
