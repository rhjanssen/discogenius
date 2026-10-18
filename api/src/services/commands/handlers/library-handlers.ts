import { db, withSqliteWriteGate } from "../../../database.js";
import { getConfigSection } from "../../config/config.js";
import { DiskScanService } from "../../mediafiles/library-scan.js";
import { parseScanFileFilter } from "../../mediafiles/scan-file-filter.js";
import { MoveArtistService } from "../../mediafiles/move-artist-service.js";
import { RenameTrackFileService } from "../../mediafiles/rename-track-file-service.js";
import { AudioTagService } from "../../mediafiles/audio-tag-service.js";
import { parseFileSelectionIds } from "../../mediafiles/file-selection.js";
import { VideoTagService } from "../../mediafiles/video-tag-service.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import { resolveArtistMetadataId } from "../../music/managed-artists.js";
import { appEvents, AppEvent } from "../app-events.js";
import { CommandTrigger } from "../command-trigger.js";
import { CommandQueueManager } from "../command-queue-manager.js";
import type { ScanResult } from "../../mediafiles/library-scan.js";
import type { CommandHandler } from "./handler-context.js";
import { runRetagWorkUnit } from "../retag-work.js";
import { runRenameWorkUnit } from "../rename-work.js";
import { fileCheckpointResumePrefix } from "../command-file-checkpoint.js";
import { runScanWorkUnit } from "../scan-work.js";
import { runRootInventoryWorkUnit } from "../root-inventory-work.js";

/**
 * Report what the scan actually reconciled in the file table, so "Completed"
 * carries the removed/added/updated deltas (Lidarr-style) rather than a generic
 * "scanning finished" line. When nothing changed, say so explicitly instead of
 * leaving a stale in-progress message.
 */
function formatReconcileSummary(prefix: string, result: ScanResult, reviewFiles = 0, sidecarFiles = 0): string {
    const changed = result.orphansRemoved + result.filesIndexed + result.filesUpdated + sidecarFiles;
    if (changed === 0 && reviewFiles === 0 && !result.discovery?.artistsAdded.length) {
        return `${prefix} - up to date, no file changes`;
    }
    return (
        `${prefix} - ${result.orphansRemoved} removed, ` +
        `${result.filesIndexed} added, ${result.filesUpdated} updated`
    );
}

/**
 * Cover.jpg / album.nfo / lyrics are disk artifacts, not catalog hydration.
 * RescanFolders repairs covers/NFO and indexes existing lyrics unless a test sets
 * skipMetadataBackfill. The backfill is invoked in sidecar-only mode: embedded
 * covers, thumbnails, and container tags remain import/Retag responsibilities.
 */
async function fillSidecarMetadata(
    artistIds: string[],
    skip: boolean | undefined,
    onProgress: (description: string) => void,
    progressPrefix: string,
): Promise<void> {
    if (skip) return;
    onProgress(`${progressPrefix} - checking sidecar files`);
    if (artistIds.length > 0) {
        for (const artistId of artistIds) {
            await DiskScanService.fillMissingMetadataFiles(artistId);
        }
        return;
    }
    await DiskScanService.fillMissingMetadataFilesForLibrary();
}

export const handleRescanFolders: CommandHandler<"RescanFolders"> = async (job, ctx) => {
    const addNewArtists = job.payload.addNewArtists ?? false;
    const artistIds = Array.isArray(job.payload.artistIds) && job.payload.artistIds.length > 0
        ? job.payload.artistIds.map((id) => String(id)).filter(Boolean)
        : (job.payload.artistId ? [String(job.payload.artistId)] : []);
    const perArtist = artistIds.length > 0;
    const filter = parseScanFileFilter(
        job.payload.filter,
        perArtist ? "matched" : "known",
    );

    const baseLabel = perArtist ? ctx.formatWorkflowCommandLabel(job, "Rescan folders") : "Scanning library root folders";
    const scanResult = await runScanWorkUnit(job,
        () => perArtist ? artistIds : DiskScanService.getScanArtistIds(),
        async (artistId, cursor, total) => {
            const progress = (fraction: number) => Math.floor(5 + ((cursor + fraction) / Math.max(total, 1)) * 85);
            const result = await DiskScanService.scan({
                artistIds: [artistId], filter,
                trackUnmappedFiles: job.payload.trackUnmappedFiles ?? true,
                onProgress: event => ctx.updateCommandDescription(job, {
                    progress: progress(Math.max(0, Math.min(1, event.progress / 100)) * 0.8),
                    description: `${baseLabel} - ${event.message} (${cursor + 1}/${total})`,
                }),
            });
            await fillSidecarMetadata([artistId], job.payload.skipMetadataBackfill,
                description => ctx.updateCommandDescription(job, { progress: progress(0.85), description }), baseLabel);
            ctx.updateCommandDescription(job, {
                progress: progress(0.95), description: `${baseLabel} - updating artist statistics (${cursor + 1}/${total})`,
            });
            await ArtistStatisticsService.refreshAsync([artistId]);
            ctx.updateCommandDescription(job, { progress: progress(1), description: `${baseLabel} - processed ${cursor + 1}/${total} artists` });
            return result;
        },
        perArtist ? null : async () => {
            if (job.payload.trackUnmappedFiles !== false) await runRootInventoryWorkUnit(job, ctx);
            return DiskScanService.pruneUnmappedFiles();
        },
        addNewArtists ? () => DiskScanService.discoverNewArtists(
            event => ctx.updateCommandDescription(job, {
                progress: 90, description: `${baseLabel} - ${event.message}`,
            }), {
                monitorArtist: job.payload.monitorArtist ?? getConfigSection("monitoring").monitor_new_artists,
                fullProcessing: job.payload.fullProcessing ?? false,
                trigger: job.trigger ?? CommandTrigger.Unspecified,
            },
        ) : undefined,
    );

    const reviewFiles = (CommandQueueManager.get(job.id)?.payload.rootInventory?.reviewFiles ?? 0)
        + (scanResult.discovery?.reviewFilesAdded ?? 0);
    const sidecarFiles = CommandQueueManager.get(job.id)?.payload.rootInventory?.sidecarFiles ?? 0;
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: formatReconcileSummary(baseLabel, scanResult, reviewFiles, sidecarFiles)
            + (reviewFiles ? `; ${reviewFiles} file${reviewFiles === 1 ? "" : "s"} added for review` : "")
            + (sidecarFiles ? `; ${sidecarFiles} sidecar${sidecarFiles === 1 ? "" : "s"} linked` : "")
            + (scanResult.discovery?.artistsAdded.length ? `; ${scanResult.discovery.artistsAdded.length} new artists identified` : ""),
    });

    if (job.worker_id && (!CommandQueueManager.isExecutionOwner(job.id, job.worker_id)
        || CommandQueueManager.get(job.id)?.payload.cancelRequested)) {
        return;
    }

    for (const artistId of perArtist ? artistIds : []) {
        appEvents.emit(AppEvent.ARTIST_SCANNED, {
            commandId: job.id,
            workerId: job.worker_id ?? undefined,
            artistId,
            artistName: job.payload.artistName ?? "",
            workflow: job.payload.workflow,
            monitoringCycle: job.payload.monitoringCycle,
            skipCuration: job.payload.skipCuration ?? false,
            skipMetadataBackfill: job.payload.skipMetadataBackfill ?? false,
            trigger: job.trigger ?? CommandTrigger.Unspecified,
            priority: job.priority,
        });
    }
};

export const handleMoveArtist: CommandHandler<"MoveArtist"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
        progress: 5,
        description: 'Move Artist - moving artist folders into the stored artist path',
    });
    if (!job.payload.artistId) {
        throw new Error("MoveArtist job missing artistId");
    }
    if (!job.payload.sourcePath) {
        throw new Error("MoveArtist job missing sourcePath");
    }
    const result = MoveArtistService.executeMoveArtistJob({
        artistId: job.payload.artistId,
        sourcePath: job.payload.sourcePath,
        destinationPath: job.payload.destinationPath,
    });
    await ArtistStatisticsService.refreshAsync([job.payload.artistId]);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Moved artist folders in ${result.movedRoots} root(s), updated ${result.updatedFiles} tracked file(s), cleaned ${result.cleanedDirectories} empty folder(s)`,
    });
};

export const handleRenameArtist: CommandHandler<"RenameArtist"> = async (job, ctx) => {
    const renameResume = fileCheckpointResumePrefix(job.payload);
    ctx.updateCommandDescription(job, {
        progress: Math.max(1, job.progress),
        description: renameResume ? `Rename - ${renameResume}choosing files` : "Rename - choosing files",
    });
    const requestedIds = Array.isArray(job.payload.artistIds) && job.payload.artistIds.length > 0
        ? job.payload.artistIds
        : (job.payload.artistId ? [job.payload.artistId] : []);
    const seenArtists = new Set<string>();
    const artistIds: string[] = [];
    for (const requestedId of requestedIds) {
        const key = String(resolveArtistMetadataId(String(requestedId)) ?? requestedId);
        if (seenArtists.has(key)) continue;
        seenArtists.add(key);
        artistIds.push(key);
    }
    if (artistIds.length === 0) throw new Error("RenameArtist requires at least one artist id");
    const result = await runRenameWorkUnit(job, ctx, async () => {
        const ids: number[] = [];
        for (let index = 0; index < artistIds.length; index += 1) {
            ids.push(...RenameTrackFileService.getRenameWorkIds({ artistId: artistIds[index] }));
            ctx.updateCommandDescription(job, {
                progress: Math.max(1, Math.min(4, Math.floor(((index + 1) / artistIds.length) * 4))),
                description: `Rename - choosing files ${index + 1}/${artistIds.length}`,
            });
            await ctx.yieldToEventLoop();
        }
        return ids;
    }, true);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Renamed ${result.renamed} file(s), ${result.conflicts} conflict(s), ${result.missing} missing, ${result.errors.length} error(s), ${result.cleanedDirectories} empty folder(s) cleaned`,
    });
    throwOnFileErrors("Rename", result.errors, result.renamed + result.skipped + result.missing);
};

export const handleRenameFiles: CommandHandler<"RenameFiles"> = async (job, ctx) => {
    const ids = parseFileSelectionIds(job.payload.ids);
    if (!ids && (job.payload.applyAll !== true || ![
        job.payload.artistId, job.payload.albumId, job.payload.editionId, job.payload.releaseMbid, job.payload.libraryRoot,
    ].some(value => value != null && String(value).trim()))) {
        throw new Error("RenameFiles requires file identifiers or an explicit artist/album/edition/root scope");
    }
    const renameResume = fileCheckpointResumePrefix(job.payload);
    ctx.updateCommandDescription(job, {
        progress: Math.max(5, job.progress),
        description: renameResume ? `Rename Files - ${renameResume}applying rename plan` : "Rename Files - applying rename plan",
    });
    const explicitIds = Boolean(ids);
    const result = await runRenameWorkUnit(job, ctx, () => explicitIds
        ? ids!
        : RenameTrackFileService.getRenameWorkIds({
            artistId: job.payload.artistId,
            albumId: job.payload.albumId,
            editionId: job.payload.editionId,
            releaseMbid: job.payload.releaseMbid,
            libraryRoot: job.payload.libraryRoot,
            fileTypes: job.payload.fileTypes,
        }), !explicitIds);
    // Renaming changes paths, not library counts or file sizes.
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Renamed ${result.renamed} file(s), ${result.conflicts} conflict(s), ${result.missing} missing, ${result.errors.length} error(s), ${result.cleanedDirectories} empty folder(s) cleaned`,
    });
    throwOnFileErrors("Rename", result.errors, result.renamed + result.skipped + result.missing);
};

function throwOnFileErrors(
    operation: string,
    errors: Array<{ id: number; error: string }>,
    succeeded = 0,
): void {
    if (errors.length === 0) return;
    // Lidarr finishes the command when some files succeeded. A single
    // unreadable extra must not fail a library-wide rename after hours of work.
    if (succeeded > 0) return;
    const sample = errors.slice(0, 5).map(item => `file #${item.id}: ${item.error}`).join("; ");
    throw new Error(`${operation} finished with ${errors.length} file error(s). ${sample}`);
}

export const handleRetagArtist: CommandHandler<"RetagArtist"> = async (job, ctx) => {
    const retagResume = fileCheckpointResumePrefix(job.payload);
    ctx.updateCommandDescription(job, {
        progress: Math.max(5, job.progress),
        description: retagResume
            ? `Retag Artist - ${retagResume}${job.payload.restartResume?.settled ?? 0}/${job.payload.restartResume?.total ?? 0} files already settled`
            : "Retag Artist - applying artist-wide tag plan",
    });
    const artistIds = Array.isArray(job.payload.artistIds) && job.payload.artistIds.length > 0
        ? job.payload.artistIds
        : (job.payload.artistId ? [job.payload.artistId] : []);
    if (artistIds.length === 0) {
        throw new Error("RetagArtist requires at least one artist id");
    }
    const result = await runRetagWorkUnit(job, ctx, () => [
        ...AudioTagService.getRetagWorkIds({ artistIds }),
        ...VideoTagService.getFileIdsForArtists(artistIds),
    ]);
    if (result.retagged > 0) await ArtistStatisticsService.refreshAsync(artistIds);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Retagged ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
    });
    throwOnFileErrors("Retag", result.errors, result.retagged + result.skipped + result.missing);
};

export const handleRetagFiles: CommandHandler<"RetagFiles"> = async (job, ctx) => {
    const ids = parseFileSelectionIds(job.payload.ids);
    if (!ids && (job.payload.applyAll !== true || ![
        job.payload.artistId, job.payload.albumId, job.payload.editionId, job.payload.releaseMbid,
    ].some(value => value != null && String(value).trim()))) {
        throw new Error("RetagFiles requires file identifiers or an explicit artist/album/edition scope");
    }
    const affectedArtists = AudioTagService.getAffectedArtistIds(job.payload);
    if (job.payload.stripOnly === true) {
        const stripResume = fileCheckpointResumePrefix(job.payload);
        ctx.updateCommandDescription(job, {
            progress: Math.max(5, job.progress),
            description: stripResume ? `Strip Tags - ${stripResume}removing embedded metadata` : "Strip Tags - removing embedded metadata",
        });
        const result = await runRetagWorkUnit(job, ctx, () =>
            ids
                ? ids
                : AudioTagService.getRetagWorkIds({
                    artistId: job.payload.artistId,
                    albumId: job.payload.albumId,
                    editionId: job.payload.editionId,
                    releaseMbid: job.payload.releaseMbid,
                }), true);
        if (result.retagged > 0 && affectedArtists.length > 0) await ArtistStatisticsService.refreshAsync(affectedArtists);
        ctx.updateCommandDescription(job, {
            progress: 100,
            description: `Stripped tags on ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
        });
        throwOnFileErrors("Strip tags", result.errors, result.retagged + result.skipped + result.missing);
        return;
    }

    const filesResume = fileCheckpointResumePrefix(job.payload);
    ctx.updateCommandDescription(job, {
        progress: Math.max(5, job.progress),
        description: filesResume
            ? `Retag Files - ${filesResume}${job.payload.restartResume?.settled ?? 0}/${job.payload.restartResume?.total ?? 0} files already settled`
            : "Retag Files - applying media tag plan",
    });
    const result = await runRetagWorkUnit(job, ctx, () =>
        ids
            ? ids
            : AudioTagService.getRetagWorkIds({
                artistId: job.payload.artistId,
                albumId: job.payload.albumId,
                editionId: job.payload.editionId,
                releaseMbid: job.payload.releaseMbid,
            }),
    );
    if (result.retagged > 0 && affectedArtists.length > 0) await ArtistStatisticsService.refreshAsync(affectedArtists);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Retagged ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
    });
    throwOnFileErrors("Retag", result.errors, result.retagged + result.skipped + result.missing);
};
