import fs from "fs";
import { db } from "../database.js";
import { OrganizerService, type OrganizeResult } from "./organizer.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "./download-state.js";
import { AudioTagService } from "./audio-tag-service.js";
import { getDownloadWorkspacePath } from "./download-routing.js";
import { getExistingLibraryMediaIds } from "./download-recovery.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "./history-events.js";
import { JobOfType, JobTypes } from "./queue.js";

type ImportDownloadJob = JobOfType<typeof JobTypes.ImportDownload>;

export type ImportDownloadState = {
    progress?: number;
    description?: string;
    currentFileNum?: number;
    totalFiles?: number;
    currentTrack?: string;
    trackProgress?: number;
    trackStatus?: "queued" | "downloading" | "completed" | "error" | "skipped";
    statusMessage?: string;
    state?: "queued" | "downloading" | "completed" | "failed" | "paused" | "importPending" | "importing" | "importFailed";
};

type ImportHistoryContext = {
    artistId: number | null;
    albumId: number | null;
    mediaId: number | null;
    quality: string | null;
};

function resolveImportHistoryContext(type: string, tidalId: string): ImportHistoryContext {
    const fallback: ImportHistoryContext = {
        artistId: null,
        albumId: null,
        mediaId: null,
        quality: null,
    };

    if (type === "album") {
        const albumRow = db.prepare(`
            SELECT id, artist_id, quality
            FROM albums
            WHERE id = ?
        `).get(tidalId) as { id: number; artist_id: number; quality: string | null } | undefined;

        if (!albumRow) {
            return fallback;
        }

        return {
            artistId: albumRow.artist_id,
            albumId: albumRow.id,
            mediaId: null,
            quality: albumRow.quality || null,
        };
    }

    if (type === "track" || type === "video") {
        const mediaRow = db.prepare(`
            SELECT id, artist_id, album_id, quality
            FROM media
            WHERE id = ?
        `).get(tidalId) as {
            id: number;
            artist_id: number;
            album_id: number | null;
            quality: string | null;
        } | undefined;

        if (!mediaRow) {
            return fallback;
        }

        return {
            artistId: mediaRow.artist_id,
            albumId: mediaRow.album_id,
            mediaId: mediaRow.id,
            quality: mediaRow.quality || null,
        };
    }

    return fallback;
}

function clearUpgradeQueue(type: string, tidalId: string) {
    if (type === "playlist") {
        return;
    }

    if (type === "album") {
        db.prepare(`DELETE FROM upgrade_queue WHERE album_id = ?`).run(tidalId);
        return;
    }

    db.prepare(`DELETE FROM upgrade_queue WHERE media_id = ?`).run(tidalId);
}

function resolveAffectedArtistId(type: string, tidalId: string): number | null {
    if (type === "album") {
        return (db.prepare(`SELECT artist_id FROM albums WHERE id = ?`).get(tidalId) as { artist_id?: number | null } | undefined)?.artist_id ?? null;
    }

    return (db.prepare(`SELECT artist_id FROM media WHERE id = ?`).get(tidalId) as { artist_id?: number | null } | undefined)?.artist_id ?? null;
}

function reconcileImportedDownload(type: string, tidalId: string, organizeResult: OrganizeResult) {
    if (type === "playlist") {
        return;
    }

    if (type === "album") {
        const processedIds = organizeResult.processedTrackIds;
        if (processedIds.length === 0) {
            throw new Error(`No tracks were successfully organized for album ${tidalId}`);
        }

        const expected = organizeResult.expectedTracks || 0;
        if (processedIds.length < expected) {
            console.warn(`[ImportDownload] Album ${tidalId}: only ${processedIds.length}/${expected} tracks were imported. Partial download.`);
        }

        updateAlbumDownloadStatus(String(tidalId));
        return;
    }

    if (type === "video") {
        updateArtistDownloadStatusFromMedia(String(tidalId));
        return;
    }

    try {
        const albumRow = db.prepare("SELECT album_id FROM media WHERE id = ?").get(tidalId) as { album_id?: number | null } | undefined;
        if (albumRow?.album_id) {
            updateAlbumDownloadStatus(String(albumRow.album_id));
        } else {
            updateArtistDownloadStatusFromMedia(String(tidalId));
        }
    } catch {
        // Best-effort: skip album update if lookup fails.
    }
}

export class DownloadedTracksImportService {
    static async process(
        job: ImportDownloadJob,
        options: {
            updateState: (state: ImportDownloadState) => void;
        },
    ): Promise<void> {
    const { type, tidalId, resolved, originalJobId, path: payloadPath } = job.payload;

    if (!type || !tidalId) {
        throw new Error("ImportDownload job is missing the type or TIDAL ID required to finish import.");
    }

    const downloadPath = payloadPath || getDownloadWorkspacePath(type as "album" | "track" | "video" | "playlist", tidalId);
    let shouldCleanupDownloadPath = false;

    options.updateState({
        progress: 5,
        description: "ImportDownload: preparing import",
        statusMessage: "Preparing import",
        state: "importing",
    });

    try {
        let organizeResult: OrganizeResult;
        if (!fs.existsSync(downloadPath)) {
            const recoveredMediaIds = getExistingLibraryMediaIds(type, tidalId);

            if (recoveredMediaIds.length === 0) {
                throw new Error(`Import files for ${type} ${tidalId} are no longer available. Re-download the item to retry import.`);
            }

            const expectedTracks = type === "album"
                ? Number((db.prepare(`SELECT COUNT(*) as count FROM media WHERE album_id = ? AND type != 'Music Video'`).get(tidalId) as { count?: number } | undefined)?.count || recoveredMediaIds.length)
                : 1;

            organizeResult = {
                type,
                tidalId,
                processedTrackIds: recoveredMediaIds,
                totalTracksInStaging: recoveredMediaIds.length,
                expectedTracks,
            };

            options.updateState({
                progress: 85,
                description: "ImportDownload: recovering existing library files",
                currentFileNum: recoveredMediaIds.length,
                totalFiles: expectedTracks,
                statusMessage: "Recovering import from existing library files",
                state: "importing",
            });
            console.warn(`[ImportDownload] Download workspace missing for ${type} ${tidalId}, but imported library file(s) already exist. Recovering import job.`);
        } else {
            options.updateState({
                progress: 15,
                description: "ImportDownload: importing downloaded files",
                statusMessage: "Importing downloaded files",
                state: "importing",
            });
            organizeResult = await OrganizerService.organizeDownload({
                type,
                tidalId,
                downloadPath,
                onProgress: (progress) => {
                    const normalizedProgress = progress.phase === "finalizing"
                        ? 90
                        : progress.totalFiles && progress.currentFileNum !== undefined
                            ? Math.max(15, Math.min(85, 15 + Math.round((progress.currentFileNum / Math.max(progress.totalFiles, 1)) * 70)))
                            : 35;

                    options.updateState({
                        progress: normalizedProgress,
                        description: `ImportDownload: ${progress.statusMessage || "Importing downloaded files"}`,
                        currentFileNum: progress.currentFileNum,
                        totalFiles: progress.totalFiles,
                        currentTrack: progress.currentTrack,
                        trackProgress: progress.totalFiles === 1 && progress.currentFileNum === 1 ? 100 : undefined,
                        trackStatus: progress.phase === "finalizing" ? "completed" : progress.currentTrack ? "downloading" : undefined,
                        statusMessage: progress.statusMessage,
                        state: "importing",
                    });
                },
            });
        }

        options.updateState({
            progress: 92,
            description: "ImportDownload: reconciling library state",
            currentFileNum: organizeResult.processedTrackIds.length,
            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
            statusMessage: "Reconciling imported library state",
            state: "importing",
        });

        reconcileImportedDownload(type, tidalId, organizeResult);
        clearUpgradeQueue(type, tidalId);

        const affectedArtistId = resolveAffectedArtistId(type, tidalId);
        if (affectedArtistId) {
            options.updateState({
                progress: 97,
                description: "ImportDownload: verifying library file records",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Verifying library file records",
                state: "importing",
            });

            // The organizer already creates library_files records for every file
            // it processes (tracks, videos, covers, lyrics, etc.) via upsertLibraryFile().
            // A full DiskScanService.scan() here is unnecessary — it would re-walk the
            // entire artist directory and re-parse every unmapped audio file (1-5s per FLAC).
            // Instead, just verify the imported files are tracked.
            const trackedCount = (db.prepare(
                `SELECT COUNT(*) as count FROM library_files WHERE artist_id = ? AND verified_at IS NOT NULL`,
            ).get(String(affectedArtistId)) as { count: number }).count;

            console.log(`[ImportDownload] Artist ${affectedArtistId}: ${trackedCount} library files tracked after import (skipped full disk scan)`);
        }

        if ((type === "album" || type === "track") && organizeResult.processedTrackIds.length > 0) {
            options.updateState({
                progress: 99,
                description: "ImportDownload: applying audio tag rules",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Applying audio tag rules",
                state: "importing",
            });

            try {
                const retagResult = await AudioTagService.applyForMediaIds(organizeResult.processedTrackIds);
                if (retagResult.errors.length > 0) {
                    console.warn(
                        `[ImportDownload] Audio tag rules completed with ${retagResult.errors.length} error(s) for ${type} ${tidalId}:`,
                        retagResult.errors,
                    );
                }
            } catch (error) {
                console.warn(`[ImportDownload] Failed to apply audio tag rules for ${type} ${tidalId}:`, error);
            }
        }

        const historyContext = resolveImportHistoryContext(type, tidalId);
        try {
            recordHistoryEvent({
                artistId: historyContext.artistId,
                albumId: historyContext.albumId,
                mediaId: historyContext.mediaId,
                eventType: HISTORY_EVENT_TYPES.DownloadImported,
                quality: historyContext.quality,
                sourceTitle: String(resolved?.title || tidalId),
                data: {
                    type,
                    tidalId,
                    originalJobId: originalJobId ?? null,
                    processedTrackIds: {
                        count: organizeResult.processedTrackIds.length,
                        expected: organizeResult.expectedTracks ?? organizeResult.totalTracksInStaging ?? null,
                    },
                },
            });
        } catch (historyError) {
            console.warn(`[ImportDownload] Failed to write DownloadImported history event for ${type} ${tidalId}:`, historyError);
        }

        const expectedProcessedTracks = organizeResult.expectedTracks ?? 0;
        if (type === "album" && expectedProcessedTracks > 0 && organizeResult.processedTrackIds.length < expectedProcessedTracks) {
            try {
                recordHistoryEvent({
                    artistId: historyContext.artistId,
                    albumId: historyContext.albumId,
                    mediaId: historyContext.mediaId,
                    eventType: HISTORY_EVENT_TYPES.AlbumImportIncomplete,
                    quality: historyContext.quality,
                    sourceTitle: String(resolved?.title || tidalId),
                    data: {
                        type,
                        tidalId,
                        originalJobId: originalJobId ?? null,
                        processedTrackIds: {
                            count: organizeResult.processedTrackIds.length,
                            expected: expectedProcessedTracks,
                        },
                    },
                });
            } catch (historyError) {
                console.warn(`[ImportDownload] Failed to write AlbumImportIncomplete history event for ${type} ${tidalId}:`, historyError);
            }
        }

        options.updateState({
            progress: 100,
            description: "ImportDownload: completed",
            currentFileNum: organizeResult.processedTrackIds.length,
            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
            statusMessage: "Import completed",
            state: "completed",
        });

        shouldCleanupDownloadPath = true;
    } catch (error) {
        try {
            clearUpgradeQueue(type, tidalId);
        } catch (cleanupError) {
            console.error(`[ImportDownload] Failed to reset upgrade_queue after import failure for ${type} ${tidalId}:`, cleanupError);
        }

        const historyContext = resolveImportHistoryContext(type, tidalId);
        const message = error instanceof Error ? error.message : String(error);
        try {
            recordHistoryEvent({
                artistId: historyContext.artistId,
                albumId: historyContext.albumId,
                mediaId: historyContext.mediaId,
                eventType: HISTORY_EVENT_TYPES.DownloadFailed,
                quality: historyContext.quality,
                sourceTitle: String(resolved?.title || tidalId),
                data: {
                    type,
                    tidalId,
                    originalJobId: originalJobId ?? null,
                    error: message,
                },
            });
        } catch (historyError) {
            console.warn(`[ImportDownload] Failed to write DownloadFailed history event for ${type} ${tidalId}:`, historyError);
        }

        throw error;
    } finally {
        if (shouldCleanupDownloadPath) {
            try {
                fs.rmSync(downloadPath, { recursive: true, force: true });
            } catch {
                // ignore cleanup errors
            }
        }
    }
    }
}
