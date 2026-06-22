import { CommandNames } from "../command-queue.js";
import type { CommandHandlerRegistry } from "./handler-context.js";
import { handleRefreshArtist, handleRefreshAlbum, handleRefreshMetadata } from "./refresh-handlers.js";
import { handleApplyCuration, handleDownloadMissing, handleCheckUpgrades, handleCurateArtist } from "./curation-handlers.js";
import {
    handleRescanFolders,
    handleMoveArtist,
    handleRenameArtist,
    handleRenameFiles,
    handleRetagArtist,
    handleRetagFiles,
} from "./library-handlers.js";
import { handleHousekeeping, handleLowCouplingMaintenance } from "./maintenance-handlers.js";

export type { CommandHandler, CommandHandlerContext } from "./handler-context.js";

/**
 * Command name → handler. The CommandExecutor resolves and runs the matching
 * handler (Lidarr's IExecute<TCommand> dispatch). The low-coupling maintenance
 * commands share one handler that fans out internally.
 */
export const commandHandlers: CommandHandlerRegistry = {
    [CommandNames.RefreshArtist]: handleRefreshArtist,
    [CommandNames.RefreshAlbum]: handleRefreshAlbum,
    [CommandNames.RefreshMetadata]: handleRefreshMetadata,
    [CommandNames.ApplyCuration]: handleApplyCuration,
    [CommandNames.DownloadMissing]: handleDownloadMissing,
    [CommandNames.CheckUpgrades]: handleCheckUpgrades,
    [CommandNames.CurateArtist]: handleCurateArtist,
    [CommandNames.RescanFolders]: handleRescanFolders,
    [CommandNames.MoveArtist]: handleMoveArtist,
    [CommandNames.RenameArtist]: handleRenameArtist,
    [CommandNames.RenameFiles]: handleRenameFiles,
    [CommandNames.RetagArtist]: handleRetagArtist,
    [CommandNames.RetagFiles]: handleRetagFiles,
    [CommandNames.Housekeeping]: handleHousekeeping,
    [CommandNames.BulkRefreshArtist]: handleLowCouplingMaintenance,
    [CommandNames.DownloadMissingForce]: handleLowCouplingMaintenance,
    [CommandNames.RescanAllRoots]: handleLowCouplingMaintenance,
    [CommandNames.CheckHealth]: handleLowCouplingMaintenance,
    [CommandNames.CompactDatabase]: handleLowCouplingMaintenance,
    [CommandNames.CleanupTempFiles]: handleLowCouplingMaintenance,
    [CommandNames.UpdateLibraryMetadata]: handleLowCouplingMaintenance,
    [CommandNames.ConfigPrune]: handleLowCouplingMaintenance,
};
