import {CommandNames} from "../command-names.js";
import type { IExecuteCommand } from "./i-execute-command.js";
import {
    RefreshArtistCommand,
    MatchArtistProvidersCommand,
    RefreshAlbumCommand,
    RefreshMetadataCommand,
    SeedVideoCommand,
    ApplyCurationCommand,
    DownloadMissingCommand,
    CheckUpgradesCommand,
    CurateArtistCommand,
    RescanFoldersCommand,
    MoveArtistCommand,
    RenameArtistCommand,
    RenameFilesCommand,
    RetagArtistCommand,
    RetagFilesCommand,
    HousekeepingCommand,
    MaintenanceCommand,
    ImportProviderArtistsCommand,
    ImportUnmappedFilesCommand,
    LibraryBulkActionCommand
} from "./index.js";

/**
 * Command name → executor registry.
 * Maps queue command names to IExecuteCommand implementations.
 */
export const commandExecutors: Record<string, IExecuteCommand<any>> = {
    [CommandNames.RefreshArtist]: new RefreshArtistCommand(),
    [CommandNames.MatchArtistProviders]: new MatchArtistProvidersCommand(),
    [CommandNames.RefreshAlbum]: new RefreshAlbumCommand(),
    [CommandNames.RefreshMetadata]: new RefreshMetadataCommand(),
    [CommandNames.SeedVideo]: new SeedVideoCommand(),
    [CommandNames.ApplyCuration]: new ApplyCurationCommand(),
    [CommandNames.DownloadMissing]: new DownloadMissingCommand(),
    [CommandNames.CheckUpgrades]: new CheckUpgradesCommand(),
    [CommandNames.CurateArtist]: new CurateArtistCommand(),
    [CommandNames.RescanFolders]: new RescanFoldersCommand(),
    [CommandNames.MoveArtist]: new MoveArtistCommand(),
    [CommandNames.RenameArtist]: new RenameArtistCommand(),
    [CommandNames.RenameFiles]: new RenameFilesCommand(),
    [CommandNames.RetagArtist]: new RetagArtistCommand(),
    [CommandNames.RetagFiles]: new RetagFilesCommand(),
    [CommandNames.Housekeeping]: new HousekeepingCommand(),
    [CommandNames.BulkRefreshArtist]: new MaintenanceCommand(),
    [CommandNames.DownloadMissingForce]: new MaintenanceCommand(),
    [CommandNames.RescanAllRoots]: new MaintenanceCommand(),
    [CommandNames.CheckHealth]: new MaintenanceCommand(),
    [CommandNames.CompactDatabase]: new MaintenanceCommand(),
    [CommandNames.BackupDatabase]: new MaintenanceCommand(),
    [CommandNames.CleanupTempFiles]: new MaintenanceCommand(),
    [CommandNames.UpdateLibraryMetadata]: new MaintenanceCommand(),
    [CommandNames.ConfigPrune]: new MaintenanceCommand(),
    [CommandNames.ImportProviderArtists]: new ImportProviderArtistsCommand(),
    [CommandNames.ImportUnmappedFiles]: new ImportUnmappedFilesCommand(),
    [CommandNames.LibraryBulkAction]: new LibraryBulkActionCommand(),
};
