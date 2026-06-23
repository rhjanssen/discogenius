import fs from "fs";
import { db } from "../../database.js";
import { OrganizerService, type OrganizeResult } from "./organizer.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "../download/download-state.js";
import { AudioTagService } from "./audio-tag-service.js";
import { getDownloadWorkspacePath } from "../download/download-routing.js";
import { getExistingLibraryMediaIds } from "../download/download-recovery.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import {CommandModelOf} from "../commands/command-model.js";
import {CommandNames} from "../commands/command-names.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";

type ImportDownloadJob = CommandModelOf<typeof CommandNames.ImportDownload>;

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
    artistId: string | null;
    albumId: string | null;
    mediaId: string | null;
    quality: string | null;
};

type ImportHistoryContextRow = {
    artist_id?: string | null;
    album_id?: string | null;
    media_id?: string | null;
    quality?: string | null;
};

function resolveImportHistoryContext(type: string, providerId: string): ImportHistoryContext {
    const entityType = type === "album" ? "album" : type === "video" ? "video" : "track";
    const firstProviderId = providerId.split(";").filter(Boolean)[0] || providerId;
    const row = db.prepare(`
        SELECT
            COALESCE(CAST(artist.id AS TEXT), pi.artist_mbid) AS artist_id,
            COALESCE(pi.release_group_mbid, pi.release_mbid) AS album_id,
            COALESCE(CAST(pi.track_id AS TEXT), pi.track_mbid, CAST(pi.recording_id AS TEXT), pi.recording_mbid, pi.provider_id) AS media_id,
            pi.quality
        FROM ProviderItems pi
        LEFT JOIN Artists artist ON artist.mbid = pi.artist_mbid
        WHERE pi.provider_id = ?
          AND pi.entity_type = ?
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(firstProviderId, entityType) as ImportHistoryContextRow | undefined;

    return {
        artistId: row?.artist_id ?? null,
        albumId: row?.album_id ?? null,
        mediaId: type === "album" ? null : row?.media_id ?? null,
        quality: row?.quality || null,
    };
}

function resolveAffectedArtistId(type: string, providerId: string): string | null {
    const entityType = type === "album" ? "album" : type === "video" ? "video" : "track";
    const firstProviderId = providerId.split(";").filter(Boolean)[0] || providerId;
    const row = db.prepare(`
        SELECT COALESCE(CAST(artist.id AS TEXT), pi.artist_mbid) AS artist_id
        FROM ProviderItems pi
        LEFT JOIN Artists artist ON artist.mbid = pi.artist_mbid
        WHERE pi.provider_id = ?
          AND pi.entity_type = ?
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(firstProviderId, entityType) as { artist_id?: string | null } | undefined;
    return row?.artist_id ?? null;
}

function resolveExpectedRecoveredTracks(type: string, providerId: string, fallbackCount: number): number {
    if (type !== "album") {
        return Math.max(1, fallbackCount);
    }

    const albumIds = providerId.split(";").filter(Boolean);
    if (albumIds.length === 0) {
        return fallbackCount;
    }

    const row = db.prepare(`
        WITH provider_albums(provider_id) AS (
            VALUES ${albumIds.map(() => "(?)").join(", ")}
        ),
        selected_releases AS (
            SELECT DISTINCT COALESCE(pi.release_mbid, rgs.selected_release_mbid) AS release_mbid
            FROM provider_albums input
            LEFT JOIN ProviderItems pi
              ON pi.provider_id = input.provider_id
             AND pi.entity_type = 'album'
            LEFT JOIN ReleaseGroupSlots rgs
              ON rgs.selected_provider_id = input.provider_id
              OR (
                pi.release_group_mbid IS NOT NULL
                AND rgs.release_group_mbid = pi.release_group_mbid
              )
            WHERE COALESCE(pi.release_mbid, rgs.selected_release_mbid) IS NOT NULL
        )
        SELECT COUNT(DISTINCT track.mbid) AS count
        FROM selected_releases sr
        JOIN Tracks track ON track.release_mbid = sr.release_mbid
        LEFT JOIN Recordings recording ON recording.mbid = track.recording_mbid
        WHERE COALESCE(recording.is_video, 0) = 0
    `).get(...albumIds) as { count?: number } | undefined;

    return Number(row?.count || fallbackCount);
}

function reconcileImportedDownload(type: string, providerId: string, organizeResult: OrganizeResult) {
    if (type === "album") {
        const processedIds = organizeResult.processedTrackIds;
        if (processedIds.length === 0) {
            throw new Error(`No tracks were successfully organized for album ${providerId}`);
        }

        const expected = organizeResult.expectedTracks || 0;
        if (processedIds.length < expected) {
            console.warn(`[ImportDownload] Album ${providerId}: only ${processedIds.length}/${expected} tracks were imported. Partial download.`);
        }

        const albumIds = providerId.split(";").filter(Boolean);
        for (const albumId of albumIds) {
            updateAlbumDownloadStatus(String(albumId));
        }
        return;
    }

    if (type === "video") {
        updateArtistDownloadStatusFromMedia(String(providerId));
        return;
    }

    const row = db.prepare(`
        SELECT release_group_mbid
        FROM ProviderItems
        WHERE provider_id = ?
          AND entity_type = 'track'
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(providerId) as { release_group_mbid?: string | null } | undefined;
    if (row?.release_group_mbid) {
        updateAlbumDownloadStatus(row.release_group_mbid);
    } else {
        updateArtistDownloadStatusFromMedia(String(providerId));
    }
}

export class DownloadedTracksImportService {
    static async process(
        job: ImportDownloadJob,
        options: {
            updateState: (state: ImportDownloadState) => void;
        },
    ): Promise<void> {
    const { type, providerId, resolved, originalJobId, path: payloadPath } = job.payload;

    if (!type || !providerId) {
        throw new Error("ImportDownload job is missing the type or provider ID required to finish import.");
    }

    if (type !== "album" && type !== "track" && type !== "video") {
        throw new Error(`ImportDownload job has unsupported media type: ${type}`);
    }

    const downloadPath = payloadPath || getDownloadWorkspacePath(type, providerId);
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
            const recoveredMediaIds = getExistingLibraryMediaIds(type, providerId);

            if (recoveredMediaIds.length === 0) {
                throw new Error(`Import files for ${type} ${providerId} are no longer available. Re-download the item to retry import.`);
            }

            const expectedTracks = resolveExpectedRecoveredTracks(type, providerId, recoveredMediaIds.length);

            organizeResult = {
                type,
                providerId,
                processedTrackIds: recoveredMediaIds,
                totalTracksInStaging: recoveredMediaIds.length,
                expectedTracks,
            };

            options.updateState({
                progress: 70,
                description: "ImportDownload: recovering existing library files",
                currentFileNum: recoveredMediaIds.length,
                totalFiles: expectedTracks,
                statusMessage: "Recovering import from existing library files",
                state: "importing",
            });
            console.warn(`[ImportDownload] Download workspace missing for ${type} ${providerId}, but imported library file(s) already exist. Recovering import job.`);
        } else {
            options.updateState({
                progress: 15,
                description: "ImportDownload: importing downloaded files",
                statusMessage: "Importing downloaded files",
                state: "importing",
            });
            organizeResult = await OrganizerService.organizeDownload({
                type,
                providerId,
                provider: job.payload.provider || null,
                releaseGroupMbid: job.payload.releaseGroupMbid || null,
                releaseMbid: job.payload.releaseMbid || null,
                albumId: job.payload.albumId || null,
                slot: job.payload.slot || null,
                downloadPath,
                onProgress: (progress) => {
                    const normalizedProgress = progress.phase === "finalizing"
                        ? 72
                        : progress.totalFiles && progress.currentFileNum !== undefined
                            ? Math.max(15, Math.min(70, 15 + Math.round((progress.currentFileNum / Math.max(progress.totalFiles, 1)) * 55)))
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
            progress: 78,
            description: "ImportDownload: reconciling library state",
            currentFileNum: organizeResult.processedTrackIds.length,
            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
            statusMessage: "Reconciling imported library state",
            state: "importing",
        });

        reconcileImportedDownload(type, providerId, organizeResult);

        const affectedArtistId = resolveAffectedArtistId(type, providerId);
        if (affectedArtistId) {
            options.updateState({
                progress: 82,
                description: "ImportDownload: verifying library file records",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Verifying library file records",
                state: "importing",
            });

            // The organizer already creates track_files records for every file
            // it processes (tracks, videos, covers, lyrics, etc.) via upsertLibraryFile().
            // A full DiskScanService.scan() here is unnecessary — it would re-walk the
            // entire artist directory and re-parse every unmapped audio file (1-5s per FLAC).
            // Instead, just verify the imported files are tracked.
            const trackedCount = (db.prepare(
                `SELECT COUNT(*) as count FROM TrackFiles WHERE artist_id = ? AND verified_at IS NOT NULL`,
            ).get(String(affectedArtistId)) as { count: number }).count;

            console.log(`[ImportDownload] Artist ${affectedArtistId}: ${trackedCount} library files tracked after import (skipped full disk scan)`);
        }

        if ((type === "album" || type === "track") && organizeResult.processedTrackIds.length > 0) {
            options.updateState({
                progress: 86,
                description: "ImportDownload: resolving MusicBrainz and AcoustID identity",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Resolving MusicBrainz and AcoustID identity",
                state: "importing",
            });

            try {
                if (type === "album") {
                    const albumIds = providerId.split(";").filter(Boolean);
                    for (const albumId of albumIds) {
                        try {
                            await MetadataIdentityService.resolveAlbum(albumId);
                        } catch (err) {
                            console.warn(`[ImportDownload] Metadata identity resolution failed for album ${albumId}:`, err);
                        }
                    }
                } else {
                    await MetadataIdentityService.resolveTrack(providerId);
                }
            } catch (error) {
                console.warn(`[ImportDownload] Metadata identity resolution failed for ${type} ${providerId}:`, error);
            }

            options.updateState({
                progress: 94,
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
                        `[ImportDownload] Audio tag rules completed with ${retagResult.errors.length} error(s) for ${type} ${providerId}:`,
                        retagResult.errors,
                    );
                }
            } catch (error) {
                console.warn(`[ImportDownload] Failed to apply audio tag rules for ${type} ${providerId}:`, error);
            }
        }

        const historyContext = resolveImportHistoryContext(type, providerId);
        try {
            recordHistoryEvent({
                artistId: historyContext.artistId,
                albumId: historyContext.albumId,
                mediaId: historyContext.mediaId,
                eventType: HISTORY_EVENT_TYPES.DownloadImported,
                quality: historyContext.quality,
                sourceTitle: String(resolved?.title || providerId),
                data: {
                    type,
                    providerId,
                    originalJobId: originalJobId ?? null,
                    processedTrackIds: {
                        count: organizeResult.processedTrackIds.length,
                        expected: organizeResult.expectedTracks ?? organizeResult.totalTracksInStaging ?? null,
                    },
                },
            });
        } catch (historyError) {
            console.warn(`[ImportDownload] Failed to write DownloadImported history event for ${type} ${providerId}:`, historyError);
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
                    sourceTitle: String(resolved?.title || providerId),
                    data: {
                        type,
                        providerId,
                        originalJobId: originalJobId ?? null,
                        processedTrackIds: {
                            count: organizeResult.processedTrackIds.length,
                            expected: expectedProcessedTracks,
                        },
                    },
                });
            } catch (historyError) {
                console.warn(`[ImportDownload] Failed to write AlbumImportIncomplete history event for ${type} ${providerId}:`, historyError);
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
        const historyContext = resolveImportHistoryContext(type, providerId);
        const message = error instanceof Error ? error.message : String(error);
        try {
            recordHistoryEvent({
                artistId: historyContext.artistId,
                albumId: historyContext.albumId,
                mediaId: historyContext.mediaId,
                eventType: HISTORY_EVENT_TYPES.DownloadFailed,
                quality: historyContext.quality,
                sourceTitle: String(resolved?.title || providerId),
                data: {
                    type,
                    providerId,
                    originalJobId: originalJobId ?? null,
                    error: message,
                },
            });
        } catch (historyError) {
            console.warn(`[ImportDownload] Failed to write DownloadFailed history event for ${type} ${providerId}:`, historyError);
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
