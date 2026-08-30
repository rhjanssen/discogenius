import { db } from "../../../database.js";
import { getConfigSection } from "../../config/config.js";
import { DiskScanService } from "../../mediafiles/library-scan.js";
import { parseScanFileFilter } from "../../mediafiles/scan-file-filter.js";
import { MoveArtistService } from "../../mediafiles/move-artist-service.js";
import { RenameTrackFileService } from "../../mediafiles/rename-track-file-service.js";
import { AudioTagService } from "../../mediafiles/audio-tag-service.js";
import { VideoTagService } from "../../mediafiles/video-tag-service.js";
import { ArtistStatisticsService } from "../../music/artist-statistics-service.js";
import { appEvents, AppEvent } from "../app-events.js";
import { CommandTrigger } from "../command-trigger.js";
import { CommandQueueManager } from "../command-queue-manager.js";
import type { ScanResult } from "../../mediafiles/library-scan.js";
import type { CommandHandler } from "./handler-context.js";

/**
 * Report what the scan actually reconciled in the file table, so "Completed"
 * carries the removed/added/updated deltas (Lidarr-style) rather than a generic
 * "scanning finished" line. When nothing changed, say so explicitly instead of
 * leaving a stale in-progress message.
 */
function formatReconcileSummary(prefix: string, result: ScanResult): string {
    const changed = result.orphansRemoved + result.filesIndexed + result.filesUpdated;
    if (changed === 0) {
        return `${prefix} - up to date, no file changes`;
    }
    return (
        `${prefix} - ${result.orphansRemoved} removed, ` +
        `${result.filesIndexed} added, ${result.filesUpdated} updated`
    );
}

/**
 * Cover.jpg / album.nfo / lyrics are disk artifacts, not catalog hydration.
 * RescanFolders repairs missing sidecars unless a test explicitly sets
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
    onProgress(`${progressPrefix} - backfilling metadata files`);
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
    const perArtist = artistIds.length > 0 && !addNewArtists;
    const filter = parseScanFileFilter(
        job.payload.filter,
        perArtist ? "matched" : "known",
    );

    if (perArtist) {
        const baseLabel = ctx.formatWorkflowCommandLabel(job, "Rescan folders");
        const scanResult = await DiskScanService.scan({
            artistIds,
            filter,
            trackUnmappedFiles: job.payload.trackUnmappedFiles ?? true,
            onProgress: (event) => {
                ctx.updateCommandDescription(job, {
                    progress: event.progress,
                    description: `${baseLabel} - ${event.message}`,
                });
            },
        });

        await fillSidecarMetadata(
            artistIds,
            job.payload.skipMetadataBackfill,
            (description) => ctx.updateCommandDescription(job, { progress: 90, description }),
            baseLabel,
        );

        ctx.updateCommandDescription(job, {
            progress: 95,
            description: `${baseLabel} - updating artist statistics`,
        });
        ArtistStatisticsService.refresh(artistIds);

        ctx.updateCommandDescription(job, {
            progress: 100,
            description: formatReconcileSummary(baseLabel, scanResult),
        });

        if (job.worker_id && !CommandQueueManager.isExecutionOwner(job.id, job.worker_id)) {
            return;
        }

        for (const artistId of artistIds) {
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
        return;
    }

    ctx.updateCommandDescription(job, {
        progress: 5,
        description: "Scanning library root folders",
    });
    const scanResult = await DiskScanService.scan({
        artistIds: artistIds.length > 0 ? artistIds : undefined,
        filter,
        addNewArtists: addNewArtists,
        monitorNewArtists: job.payload.monitorArtist ?? getConfigSection("monitoring").monitor_new_artists,
        fullProcessing: job.payload.fullProcessing ?? false,
        trackUnmappedFiles: job.payload.trackUnmappedFiles ?? true,
        trigger: job.trigger ?? CommandTrigger.Unspecified,
        onProgress: (event) => {
            ctx.updateCommandDescription(job, {
                progress: event.progress ?? 50,
                description: `Scanning library root folders - ${event.message}`,
            });
        },
    });
    await fillSidecarMetadata(
        artistIds,
        job.payload.skipMetadataBackfill,
        (description) => ctx.updateCommandDescription(job, { progress: 90, description }),
        "Scanning library root folders",
    );

    ctx.updateCommandDescription(job, {
        progress: 95,
        description: "Scanning library root folders - updating artist statistics",
    });
    ArtistStatisticsService.refresh(artistIds.length > 0 ? artistIds : undefined);

    ctx.updateCommandDescription(job, {
        progress: 100,
        description: formatReconcileSummary("Scanning library root folders", scanResult),
    });
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
    ArtistStatisticsService.refresh([job.payload.artistId]);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Moved artist folders in ${result.movedRoots} root(s), updated ${result.updatedFiles} tracked file(s), cleaned ${result.cleanedDirectories} empty folder(s)`,
    });
};

export const handleRenameArtist: CommandHandler<"RenameArtist"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
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
        ArtistStatisticsService.refresh([artistId]);
        renamed += result.renamed;
        conflicts += result.conflicts;
        missing += result.missing;
        cleanedDirectories += result.cleanedDirectories;
        await ctx.yieldToEventLoop();
    }
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Renamed ${renamed} file(s), ${conflicts} conflict(s), ${missing} missing, ${cleanedDirectories} empty folder(s) cleaned`,
    });
};

export const handleRenameFiles: CommandHandler<"RenameFiles"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
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
    // An id-only rename does not change library counts. Passing undefined here
    // used to trigger a full-library statistics rebuild after moving even one
    // file, leaving RenameFiles stuck at 5% for minutes on large catalogs.
    if (job.payload.artistId) {
        ArtistStatisticsService.refresh([job.payload.artistId]);
    }
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Renamed ${result.renamed} file(s), ${result.conflicts} conflict(s), ${result.missing} missing, ${result.cleanedDirectories} empty folder(s) cleaned`,
    });
};

// Throttled per-file retag progress reporter: "Retag Files - writing file x/y"
// with a 5..95% ramp. Caps DB/SSE writes to ~50 updates regardless of file count.
function makeRetagProgress(
    ctx: Parameters<CommandHandler<"RetagFiles">>[1],
    // Shared by RetagFiles and RetagArtist handlers; the job command name differs.
    job: Parameters<CommandHandler<"RetagFiles" | "RetagArtist">>[0],
    label: string,
) {
    let lastReported = 0;
    return (completed: number, total: number) => {
        const step = Math.max(1, Math.floor(total / 50));
        if (completed !== total && completed - lastReported < step) return;
        lastReported = completed;
        ctx.updateCommandDescription(job, {
            progress: 5 + Math.floor((completed / Math.max(total, 1)) * 90),
            description: `${label} - writing file ${completed}/${total}`,
        });
    };
}

export const handleRetagArtist: CommandHandler<"RetagArtist"> = async (job, ctx) => {
    ctx.updateCommandDescription(job, {
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
        const result = await AudioTagService.applyByQuery({ artistId, onProgress: makeRetagProgress(ctx, job, 'Retag Artist') });
        ArtistStatisticsService.refresh([artistId]);
        retagged += result.retagged;
        missing += result.missing;
        errors.push(...result.errors);
        await ctx.yieldToEventLoop();
    }
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Retagged ${retagged} file(s), ${missing} missing, ${errors.length} error(s)`,
    });
};

export const handleRetagFiles: CommandHandler<"RetagFiles"> = async (job, ctx) => {
    if (job.payload.stripOnly === true) {
        ctx.updateCommandDescription(job, {
            progress: 5,
            description: 'Strip Tags - removing embedded metadata',
        });
        let result;
        if (Array.isArray(job.payload.ids) && job.payload.ids.length > 0) {
            result = await AudioTagService.stripTags(job.payload.ids);
        } else {
            result = await AudioTagService.stripTagsByScope({
                artistId: job.payload.artistId,
                albumId: job.payload.albumId,
            });
        }
        ArtistStatisticsService.refresh(job.payload.artistId ? [job.payload.artistId] : undefined);
        ctx.updateCommandDescription(job, {
            progress: 100,
            description: `Stripped tags on ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
        });
        return;
    }

    ctx.updateCommandDescription(job, {
        progress: 5,
        description: 'Retag Files - applying media tag plan',
    });
    let result;
    if (Array.isArray(job.payload.ids) && job.payload.ids.length > 0) {
        const marks = job.payload.ids.map(() => "?").join(",");
        const videoIds = (db.prepare(`SELECT id FROM TrackFiles WHERE file_type = 'video' AND id IN (${marks})`).all(...job.payload.ids) as Array<{ id: number }>).map((row) => row.id);
        const videoSet = new Set(videoIds);
        const audioIds = job.payload.ids.filter((id) => !videoSet.has(id));
        const emptyResult = { retagged: 0, skipped: 0, missing: 0, errors: [] as Array<{ id: number; error: string }> };
        // A file-specific repair must remain local and deterministic. Missing
        // lyrics are handled by the metadata backfill, not one network request
        // per file while a RetagFiles command owns the worker.
        const audioResult = audioIds.length > 0
            ? await AudioTagService.apply(audioIds, { includeExternalLyrics: false, onProgress: makeRetagProgress(ctx, job, 'Retag Files') })
            : emptyResult;
        const videoResult = { ...emptyResult, errors: [] as Array<{ id: number; error: string }> };
        for (let index = 0; index < videoIds.length; index++) {
            const status = (db.prepare("SELECT status FROM commands WHERE id = ?").get(job.id) as { status?: string } | undefined)?.status;
            if (status === "cancelled") return;
            ctx.updateCommandDescription(job, {
                progress: 5 + Math.floor(((index + 1) / Math.max(videoIds.length, 1)) * 90),
                description: `Retag Files - writing video ${index + 1}/${videoIds.length}`,
            });
            const itemResult = await VideoTagService.apply([videoIds[index]]);
            videoResult.retagged += itemResult.retagged;
            videoResult.skipped += itemResult.skipped;
            videoResult.missing += itemResult.missing;
            videoResult.errors.push(...itemResult.errors);
            await ctx.yieldToEventLoop();
        }
        result = {
            retagged: audioResult.retagged + videoResult.retagged,
            skipped: audioResult.skipped + videoResult.skipped,
            missing: audioResult.missing + videoResult.missing,
            errors: [...audioResult.errors, ...videoResult.errors],
        };
    } else {
        result = Array.isArray(job.payload.mediaIds) && job.payload.mediaIds.length > 0
            ? await AudioTagService.applyForMediaIds(job.payload.mediaIds, { onProgress: makeRetagProgress(ctx, job, 'Retag Files') })
            : await AudioTagService.applyByQuery({
                artistId: job.payload.artistId,
                albumId: job.payload.albumId,
                onProgress: makeRetagProgress(ctx, job, 'Retag Files'),
            });
    }
    ArtistStatisticsService.refresh(job.payload.artistId ? [job.payload.artistId] : undefined);
    ctx.updateCommandDescription(job, {
        progress: 100,
        description: `Retagged ${result.retagged} file(s), ${result.missing} missing, ${result.errors.length} error(s)`,
    });
};
