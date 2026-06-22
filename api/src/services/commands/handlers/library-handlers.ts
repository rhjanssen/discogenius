import { DiskScanService } from "../../mediafiles/library-scan.js";
import { MoveArtistService } from "../../mediafiles/move-artist-service.js";
import { RenameTrackFileService } from "../../mediafiles/rename-track-file-service.js";
import { AudioTagService } from "../../mediafiles/audio-tag-service.js";
import { appEvents, AppEvent } from "../app-events.js";
import { CommandTrigger } from "../command-trigger.js";
import type { CommandHandler } from "./handler-context.js";

export const handleRescanFolders: CommandHandler<"RescanFolders"> = async (job, ctx) => {
    const artistId = job.payload.artistId;
    const addNewArtists = job.payload.addNewArtists ?? false;

    if (artistId && !addNewArtists) {
        // Per-artist scan (existing behavior)
        const baseLabel = ctx.formatWorkflowJobLabel(job, "Rescan folders");

        // Step 1: Disk scan — reconcile track_files with disk reality
        await DiskScanService.scan({
            artistIds: [artistId],
            trackUnmappedFiles: job.payload.trackUnmappedFiles ?? true,
            onProgress: (event) => {
                ctx.updateJobDescription(job, {
                    progress: event.progress,
                    description: `${baseLabel} - ${event.message}`,
                });
            },
        });

        // Step 2: Optional metadata backfill.
        // Manual/local-only scans stop after reconciling files and importing from disk.
        if (!(job.payload.skipMetadataBackfill ?? false)) {
            ctx.updateJobDescription(job, {
                progress: 90,
                description: `${baseLabel} - backfilling metadata files`,
            });
            await DiskScanService.fillMissingMetadataFiles(artistId);
        }

        ctx.updateJobDescription(job, {
            progress: 95,
            description: `${baseLabel} - finalizing`,
        });

        // Step 3: Emit completion so artist curation cascades when requested
        appEvents.emit(AppEvent.ARTIST_SCANNED, {
            artistId,
            artistName: job.payload.artistName ?? "",
            workflow: job.payload.workflow,
            monitoringCycle: job.payload.monitoringCycle,
            skipDownloadQueue: job.payload.skipDownloadQueue ?? false,
            skipCuration: job.payload.skipCuration ?? false,
            skipMetadataBackfill: job.payload.skipMetadataBackfill ?? false,
            forceDownloadQueue: job.payload.forceDownloadQueue ?? false,
            trigger: job.trigger ?? CommandTrigger.Unspecified,
        });
    } else {
        // Library-wide scan (RescanFolders with addNewArtists)
        ctx.updateJobDescription(job, {
            progress: 5,
            description: "Scanning library root folders",
        });
        await DiskScanService.scan({
            addNewArtists: addNewArtists,
            monitorNewArtists: job.payload.monitorArtist ?? true,
            fullProcessing: job.payload.fullProcessing ?? false,
            trackUnmappedFiles: job.payload.trackUnmappedFiles ?? true,
            trigger: job.trigger ?? CommandTrigger.Unspecified,
            onProgress: (event) => {
                ctx.updateJobDescription(job, {
                    progress: event.progress ?? 50,
                    description: `Scanning library root folders - ${event.message}`,
                });
            },
        });
        ctx.updateJobDescription(job, {
            progress: 95,
            description: "Scanning library root folders - finalizing",
        });
    }
};

export const handleMoveArtist: CommandHandler<"MoveArtist"> = async (job, ctx) => {
    ctx.updateJobDescription(job, {
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
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Moved artist folders in ${result.movedRoots} root(s), updated ${result.updatedFiles} tracked file(s), cleaned ${result.cleanedDirectories} empty folder(s)`,
    });
};

export const handleRenameArtist: CommandHandler<"RenameArtist"> = async (job, ctx) => {
    ctx.updateJobDescription(job, {
        progress: 5,
        description: 'Rename Artist - applying artist-wide rename plan',
    });
    const artistIds = Array.isArray(job.payload.artistIds) && job.payload.artistIds.length > 0
        ? job.payload.artistIds
        : (job.payload.artistId ? [job.payload.artistId] : []);
    let renamed = 0;
    let conflicts = 0;
    let missing = 0;
    let cleanedDirectories = 0;
    for (const artistId of artistIds) {
        const result = RenameTrackFileService.executeRenameArtist({ artistId });
        renamed += result.renamed;
        conflicts += result.conflicts;
        missing += result.missing;
        cleanedDirectories += result.cleanedDirectories;
        await ctx.yieldToEventLoop();
    }
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Renamed ${renamed} file(s), ${conflicts} conflict(s), ${missing} missing, ${cleanedDirectories} empty folder(s) cleaned`,
    });
};

export const handleRenameFiles: CommandHandler<"RenameFiles"> = async (job, ctx) => {
    ctx.updateJobDescription(job, {
        progress: 5,
        description: 'Rename Files - applying rename plan',
    });
    const result = Array.isArray(job.payload.ids) && job.payload.ids.length > 0
        ? RenameTrackFileService.executeRenameFiles(job.payload.ids)
        : RenameTrackFileService.executeRenameFilesByQuery({
            artistId: job.payload.artistId,
            albumId: job.payload.albumId,
            libraryRoot: job.payload.libraryRoot,
            fileTypes: job.payload.fileTypes,
        });
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Renamed ${result.renamed} file(s), ${result.conflicts} conflict(s), ${result.missing} missing, ${result.cleanedDirectories} empty folder(s) cleaned`,
    });
};

export const handleRetagArtist: CommandHandler<"RetagArtist"> = async (job, ctx) => {
    ctx.updateJobDescription(job, {
        progress: 5,
        description: 'Retag Artist - applying artist-wide audio tag plan',
    });
    const artistIds = Array.isArray(job.payload.artistIds) && job.payload.artistIds.length > 0
        ? job.payload.artistIds
        : (job.payload.artistId ? [job.payload.artistId] : []);
    let retagged = 0;
    let missing = 0;
    const errors: Array<{ id: number; error: string }> = [];
    for (const artistId of artistIds) {
        const result = await AudioTagService.applyByQuery({ artistId });
        retagged += result.retagged;
        missing += result.missing;
        errors.push(...result.errors);
        await ctx.yieldToEventLoop();
    }
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Retagged ${retagged} file(s), ${missing} missing, ${errors.length} error(s)`,
    });
};

export const handleRetagFiles: CommandHandler<"RetagFiles"> = async (job, ctx) => {
    ctx.updateJobDescription(job, {
        progress: 5,
        description: 'Retag Files - applying audio tag plan',
    });
    const result = Array.isArray(job.payload.ids) && job.payload.ids.length > 0
        ? await AudioTagService.apply(job.payload.ids)
        : await AudioTagService.applyByQuery({
            artistId: job.payload.artistId,
            albumId: job.payload.albumId,
        });
    ctx.updateJobDescription(job, {
        progress: 100,
        description: `Retagged ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
    });
};
