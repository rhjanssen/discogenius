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
 * How many times an in-flight file may be found claimed-but-unsettled across
 * process restarts before that file is recorded as an error and skipped.
 * The command itself continues. This is not the command-level attempt budget.
 */
export const FILE_CHECKPOINT_RESTART_LIMIT = 5;

export const FILE_CHECKPOINT_RESUME_PHASE = "resumed after restart";

export const FILE_CHECKPOINT_POISON_ERROR =
  `Skipped after ${FILE_CHECKPOINT_RESTART_LIMIT} restarts without settling`;

/**
 * Generic infrastructure retries. These commands either have no per-file
 * checkpoint, or (retag / rename) must not be replayed by this attempt budget.
 * Retag and rename resume through `fileWorkCheckpoint` on the command
 * definition: that path keeps settled rows and bounds a poison file. Calling
 * the generic retry here would either redo work blindly or poison-fail the
 * whole command after a few restarts, so they stay fail-closed on this path.
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
