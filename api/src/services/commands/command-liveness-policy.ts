import { CommandNames, type CommandName } from "./command-names.js";

/**
 * Maximum healthy interval without a phase/progress transition. Heartbeats
 * prove the worker loop is alive; this expectation catches a handler that keeps
 * heartbeating while awaiting a promise that will never resolve. Disk and
 * maintenance commands get much wider windows than network/catalog stages.
 */
export function resolveCommandNoProgressTimeoutMs(name: CommandName): number {
    const minute = 60_000;
    switch (name) {
        case CommandNames.RefreshArtist:
        case CommandNames.MatchArtistProviders:
        case CommandNames.RefreshAlbum:
        case CommandNames.ImportProviderArtists:
        case CommandNames.SeedVideo:
            return 30 * minute;

        case CommandNames.RescanFolders:
        case CommandNames.RescanAllRoots:
        case CommandNames.MoveArtist:
        case CommandNames.RenameFiles:
        case CommandNames.RenameArtist:
        case CommandNames.RetagFiles:
        case CommandNames.RetagArtist:
        case CommandNames.ImportUnmappedFiles:
        case CommandNames.LibraryBulkAction:
        case CommandNames.CompactDatabase:
        case CommandNames.BackupDatabase:
        case CommandNames.UpdateLibraryMetadata:
            return 4 * 60 * minute;

        default:
            return 60 * minute;
    }
}

/**
 * These commands can leave externally visible filesystem mutations between
 * durable DB checkpoints. Until they have an operation journal, an automatic
 * replay after worker death could double-move, overwrite, or retag the wrong
 * bytes. Fail the interrupted attempt visibly; a human may inspect and retry.
 */
export function isInfrastructureRetrySafe(name: CommandName): boolean {
    switch (name) {
        case CommandNames.MoveArtist:
        case CommandNames.RenameFiles:
        case CommandNames.RenameArtist:
        case CommandNames.RetagFiles:
        case CommandNames.RetagArtist:
        case CommandNames.ImportUnmappedFiles:
        case CommandNames.LibraryBulkAction:
        case CommandNames.ConfigPrune:
            return false;
        default:
            return true;
    }
}

export function resolveInfrastructureMaxAttempts(
    name: CommandName,
    configuredMaxAttempts: number,
): number {
    return isInfrastructureRetrySafe(name)
        ? Math.max(1, configuredMaxAttempts)
        : 1;
}
