import fs from "fs";
import path from "path";
import { db } from "../../database.js";
import { OrganizerService, type OrganizeResult } from "./organizer.js";
import {
    updateAlbumDownloadStatus,
    updateArtistDownloadStatusFromMedia,
} from "../download/download-state.js";
import { AudioTagService } from "./audio-tag-service.js";
import { VideoTagService } from "./video-tag-service.js";
import { getDownloadWorkspacePath, validateDownloadWorkspacePath } from "../download/download-routing.js";
import { getExistingLibraryMediaIds } from "../download/download-recovery.js";
import { HISTORY_EVENT_TYPES, recordHistoryEvent } from "../commands/history-events.js";
import {type CommandModelOf} from "../commands/command-model.js";
import {CommandNames} from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { MetadataIdentityService } from "../metadata/metadata-identity-service.js";
import { ArtistStatisticsService } from "../music/artist-statistics-service.js";
import { ProviderTrackTagSupplementService } from "./provider-track-tag-supplement-service.js";
import { TrackLyricsMaterializer, type TrackLyricsMaterializeResult } from "./track-lyrics-materializer.js";
import { removeEmptyParents } from "./library-files.js";
import { Config } from "../config/config.js";

type ImportDownloadJob = CommandModelOf<typeof CommandNames.ImportDownload>;

export class ImportDownloadCancelledError extends Error {
    constructor(phase: string) {
        super(`Import cancelled at safe boundary: ${phase}`);
        this.name = "ImportDownloadCancelledError";
    }
}

export function isImportDownloadCancelledError(error: unknown): error is ImportDownloadCancelledError {
    return error instanceof ImportDownloadCancelledError;
}

/**
 * Read the persisted cancellation marker as well as terminal/missing command
 * state. Command workers have their own JS heap, so the database marker is the
 * cross-thread half of cooperative import cancellation.
 */
export function isImportDownloadCancellationRequested(commandId: number): boolean {
    const command = CommandQueueManager.get(commandId);
    return !command
        || command.status === "cancelled"
        || command.payload.importCancellationRequested === true;
}

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

const MEDIA_EXTENSIONS = new Set([
    ".flac",
    ".mp3",
    ".m4a",
    ".mp4",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ape",
    ".mp2",
    ".mkv",
    ".mov",
    ".webm",
    ".avi",
]);

function workspaceContainsMediaFiles(dir: string): boolean {
    if (!fs.existsSync(dir)) {
        return false;
    }

    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = `${current}/${entry.name}`;
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (entry.isFile() && MEDIA_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) {
                return true;
            }
        }
    }

    return false;
}

function recoverExistingLibraryImport(
    type: string,
    providerId: string,
    provider?: string | null,
): OrganizeResult | null {
    const recoveredMediaIds = getExistingLibraryMediaIds(type as any, providerId, provider);
    if (recoveredMediaIds.length === 0) {
        return null;
    }

    const expectedTracks = resolveExpectedRecoveredTracks(type, providerId, recoveredMediaIds.length, provider);
    return {
        type,
        providerId,
        processedTrackIds: recoveredMediaIds,
        totalTracksInStaging: recoveredMediaIds.length,
        expectedTracks,
    } as OrganizeResult;
}

function resolveImportHistoryContext(
    type: string,
    providerId: string,
    provider?: string | null,
): ImportHistoryContext {
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
          AND (? IS NULL OR pi.provider = ?)
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(
        firstProviderId,
        entityType,
        provider || null,
        provider || null,
    ) as ImportHistoryContextRow | undefined;

    return {
        artistId: row?.artist_id ?? null,
        albumId: row?.album_id ?? null,
        mediaId: type === "album" ? null : row?.media_id ?? null,
        quality: row?.quality || null,
    };
}

function resolveAffectedArtistId(type: string, providerId: string, provider?: string | null): string | null {
    const entityType = type === "album" ? "album" : type === "video" ? "video" : "track";
    const firstProviderId = providerId.split(";").filter(Boolean)[0] || providerId;
    const row = db.prepare(`
        SELECT COALESCE(CAST(artist.id AS TEXT), pi.artist_mbid) AS artist_id
        FROM ProviderItems pi
        LEFT JOIN Artists artist ON artist.mbid = pi.artist_mbid
        WHERE pi.provider_id = ?
          AND pi.entity_type = ?
          AND (? IS NULL OR pi.provider = ?)
        ORDER BY pi.updated_at DESC
        LIMIT 1
    `).get(
        firstProviderId,
        entityType,
        provider || null,
        provider || null,
    ) as { artist_id?: string | null } | undefined;
    return row?.artist_id ?? null;
}

function resolveExpectedRecoveredTracks(
    type: string,
    providerId: string,
    fallbackCount: number,
    provider?: string | null,
): number {
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
             AND (? IS NULL OR pi.provider = ?)
            LEFT JOIN ReleaseGroupSlots rgs
              ON (
                rgs.selected_provider_id = input.provider_id
                OR (
                  pi.release_group_mbid IS NOT NULL
                  AND rgs.release_group_mbid = pi.release_group_mbid
                )
              )
             AND (? IS NULL OR rgs.selected_provider = ?)
            WHERE COALESCE(pi.release_mbid, rgs.selected_release_mbid) IS NOT NULL
        )
        SELECT COUNT(DISTINCT track.mbid) AS count
        FROM selected_releases sr
        JOIN Tracks track ON track.release_mbid = sr.release_mbid
        LEFT JOIN Recordings recording ON recording.mbid = track.recording_mbid
        WHERE (recording.is_video IS NULL OR recording.is_video = 0)
    `).get(
        ...albumIds,
        provider || null,
        provider || null,
        provider || null,
        provider || null,
    ) as { count?: number } | undefined;

    return Number(row?.count || fallbackCount);
}

function reconcileImportedDownload(
    type: string,
    providerId: string,
    organizeResult: OrganizeResult,
    provider?: string | null,
) {
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
            const row = db.prepare(`
                SELECT release_group_mbid
                FROM ProviderItems
                WHERE entity_type = 'album'
                  AND provider_id = ?
                  AND (? IS NULL OR provider = ?)
                ORDER BY updated_at DESC
                LIMIT 1
            `).get(albumId, provider || null, provider || null) as {
                release_group_mbid?: string | null;
            } | undefined;
            updateAlbumDownloadStatus(String(row?.release_group_mbid || albumId));
        }
        return;
    }

    if (type === "video") {
        updateArtistDownloadStatusFromMedia(String(providerId), provider);
        return;
    }

    const row = db.prepare(`
        SELECT release_group_mbid
        FROM ProviderItems
        WHERE provider_id = ?
          AND entity_type = 'track'
          AND (? IS NULL OR provider = ?)
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(providerId, provider || null, provider || null) as { release_group_mbid?: string | null } | undefined;
    if (row?.release_group_mbid) {
        updateAlbumDownloadStatus(row.release_group_mbid);
    } else {
        updateArtistDownloadStatusFromMedia(String(providerId), provider);
    }
}

export class DownloadedTracksImportService {
    static async process(
        job: ImportDownloadJob,
        options: {
            updateState: (state: ImportDownloadState) => void;
            /** Checked only at boundaries where stopping cannot roll back or corrupt an in-flight file move. */
            isCancelled?: () => boolean;
        },
    ): Promise<void> {
    const { type, providerId, resolved, originalJobId, path: payloadPath } = job.payload;
    const provider = String(job.payload.provider || "").trim() || null;

    if (!type || !providerId) {
        throw new Error("ImportDownload job is missing the type or provider ID required to finish import.");
    }

    if (type !== "album" && type !== "track" && type !== "video") {
        throw new Error(`ImportDownload job has unsupported media type: ${type}`);
    }

    const downloadPath = payloadPath
        ? validateDownloadWorkspacePath(payloadPath)
        : getDownloadWorkspacePath(type, providerId, provider || undefined);
    let shouldCleanupDownloadPath = false;

    const cancellationCheckpoint = (phase: string): void => {
        if (options.isCancelled?.()) {
            throw new ImportDownloadCancelledError(phase);
        }
    };

    options.updateState({
        progress: 5,
        description: "ImportDownload: preparing import",
        statusMessage: "Preparing import",
        state: "importing",
    });

    try {
        cancellationCheckpoint("preparing import");
        let organizeResult: OrganizeResult;
        const workspaceHasMedia = workspaceContainsMediaFiles(downloadPath);
        if (!workspaceHasMedia) {
            const recovered = recoverExistingLibraryImport(type, providerId, provider);
            if (!recovered) {
                throw new Error(`Import files for ${type} ${providerId} are no longer available. Re-download the item to retry import.`);
            }

            organizeResult = recovered;

            options.updateState({
                progress: 70,
                description: "ImportDownload: recovering existing library files",
                currentFileNum: recovered.processedTrackIds.length,
                totalFiles: recovered.expectedTracks,
                statusMessage: "Recovering import from existing library files",
                state: "importing",
            });
            console.warn(`[ImportDownload] Download workspace missing or empty for ${type} ${providerId}, but imported library file(s) already exist. Recovering import job.`);
        } else {
            cancellationCheckpoint("before organizing downloaded files");
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
                canonicalTrackMbid: job.payload.canonicalTrackMbid || null,
                canonicalRecordingMbid: job.payload.canonicalRecordingMbid || null,
                albumId: job.payload.albumId || null,
                albumTitle: job.payload.albumTitle || job.payload.album_title || null,
                slot: job.payload.slot || null,
                trackNumber: job.payload.trackNumber ?? null,
                volumeNumber: job.payload.volumeNumber ?? null,
                trackOffers: Array.isArray(job.payload.trackOffers) ? job.payload.trackOffers : undefined,
                downloadPath,
                onProgress: (progress) => {
                    // Organizer progress is emitted before each album track move
                    // and after a completed track. Those are safe boundaries:
                    // already-organized library files stay in place, while the
                    // untouched remainder can be removed with the staging root.
                    cancellationCheckpoint(`organizing downloaded files (${progress.phase})`);
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
                        trackStatus: progress.trackStatus ?? (progress.phase === "finalizing" ? "completed" : progress.currentTrack ? "downloading" : undefined),
                        statusMessage: progress.statusMessage,
                        state: "importing",
                    });
                },
            });
        }

        cancellationCheckpoint("after organizing downloaded files");

        options.updateState({
            progress: 78,
            description: "ImportDownload: reconciling library state",
            currentFileNum: organizeResult.processedTrackIds.length,
            totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
            statusMessage: "Reconciling imported library state",
            state: "importing",
        });

        reconcileImportedDownload(type, providerId, organizeResult, provider);
        cancellationCheckpoint("after reconciling library state");

        const affectedArtistId = resolveAffectedArtistId(type, providerId, provider);
        if (affectedArtistId) {
            cancellationCheckpoint("before refreshing artist statistics");
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
            ArtistStatisticsService.refresh([affectedArtistId]);
            cancellationCheckpoint("after refreshing artist statistics");
        }

        if ((type === "album" || type === "track") && organizeResult.processedTrackIds.length > 0) {
            cancellationCheckpoint("before resolving metadata identity");
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
                        cancellationCheckpoint(`before resolving album identity ${albumId}`);
                        try {
                            await MetadataIdentityService.resolveAlbum(albumId, { provider });
                        } catch (err) {
                            console.warn(`[ImportDownload] Metadata identity resolution failed for album ${albumId}:`, err);
                        }
                        cancellationCheckpoint(`after resolving album identity ${albumId}`);
                    }
                } else {
                    await MetadataIdentityService.resolveTrack(providerId, { provider });
                    cancellationCheckpoint("after resolving track identity");
                }
            } catch (error) {
                if (isImportDownloadCancelledError(error)) throw error;
                console.warn(`[ImportDownload] Metadata identity resolution failed for ${type} ${providerId}:`, error);
            }

            cancellationCheckpoint("before refreshing provider tag supplements");
            try {
                await ProviderTrackTagSupplementService.refresh({
                    providerId: job.payload.provider || null,
                    albumProviderIds: type === "album" ? providerId.split(";").filter(Boolean) : [],
                    trackProviderIds: type === "track" ? [providerId] : [],
                });
            } catch (error) {
                // Loudness/copyright are provider supplements. Their absence
                // must not prevent importing otherwise valid media.
                console.warn(`[ImportDownload] Failed to refresh provider tag supplements for ${type} ${providerId}:`, error);
            }
            cancellationCheckpoint("after refreshing provider tag supplements");

            let lyricResult: TrackLyricsMaterializeResult | null = null;
            cancellationCheckpoint("before materializing lyrics");
            try {
                lyricResult = await TrackLyricsMaterializer.materializeForMediaIds(
                    organizeResult.processedTrackIds,
                    provider,
                );
                if (lyricResult.discovered > 0) {
                    console.log(
                        `[ImportDownload] Lyrics resolved for ${lyricResult.discovered} track(s); ` +
                        `${lyricResult.saved} new sidecar(s) saved`,
                    );
                }
            } catch (error) {
                // Lyrics are optional media extras. A provider outage must not
                // roll back otherwise valid audio already placed in the library.
                console.warn(`[ImportDownload] Failed to materialize lyrics for ${type} ${providerId}:`, error);
            }
            cancellationCheckpoint("after materializing lyrics");

            options.updateState({
                progress: 94,
                description: "ImportDownload: applying audio tag rules",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.expectedTracks || organizeResult.totalTracksInStaging,
                statusMessage: "Applying audio tag rules",
                state: "importing",
            });

            cancellationCheckpoint("before applying audio tag rules");
            try {
                const retagResult = await AudioTagService.applyForMediaIds(
                    organizeResult.processedTrackIds,
                    {
                        provider,
                        includeExternalLyrics: lyricResult !== null,
                        lyricsByProviderMedia: lyricResult?.lyricsByProviderMedia,
                    },
                );
                if (retagResult.errors.length > 0) {
                    console.warn(
                        `[ImportDownload] Audio tag rules completed with ${retagResult.errors.length} error(s) for ${type} ${providerId}:`,
                        retagResult.errors,
                    );
                }
            } catch (error) {
                console.warn(`[ImportDownload] Failed to apply audio tag rules for ${type} ${providerId}:`, error);
            }
            cancellationCheckpoint("after applying audio tag rules");
        }

        if (type === "video" && organizeResult.processedTrackIds.length > 0) {
            cancellationCheckpoint("before applying video tag rules");
            options.updateState({
                progress: 94,
                description: "ImportDownload: applying video tag rules",
                currentFileNum: organizeResult.processedTrackIds.length,
                totalFiles: organizeResult.totalTracksInStaging,
                statusMessage: "Applying video tag rules",
                state: "importing",
            });
            const retagResult = await VideoTagService.applyForProviderIds(
                organizeResult.processedTrackIds,
                provider,
            );
            if (retagResult.errors.length > 0) {
                console.warn(`[ImportDownload] Video tag rules completed with ${retagResult.errors.length} error(s) for ${providerId}:`, retagResult.errors);
            }
            cancellationCheckpoint("after applying video tag rules");
        }

        cancellationCheckpoint("before recording import history");
        const historyContext = resolveImportHistoryContext(type, providerId, provider);
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
        const trackOfferCount = Array.isArray(job.payload.trackOffers) ? job.payload.trackOffers.length : 0;
        const acquisitionMode = String(job.payload.acquisitionMode || "").trim();
        const isTrackOffersJob = acquisitionMode === "trackOffers" || trackOfferCount > 0;
        // Soft-incomplete for normal full-album downloads (bonus files, etc.).
        // Hybrid trackOffers must not green-check when most catalog tracks never landed.
        const softIncomplete = type === "album"
            && !isTrackOffersJob
            && expectedProcessedTracks > 0
            && organizeResult.processedTrackIds.length < expectedProcessedTracks;
        const hardIncomplete = type === "album"
            && isTrackOffersJob
            && trackOfferCount > 0
            && organizeResult.processedTrackIds.length < trackOfferCount;

        if (softIncomplete || hardIncomplete) {
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
                            expected: isTrackOffersJob
                                ? trackOfferCount
                                : expectedProcessedTracks,
                        },
                    },
                });
            } catch (historyError) {
                console.warn(`[ImportDownload] Failed to write AlbumImportIncomplete history event for ${type} ${providerId}:`, historyError);
            }
        }

        if (hardIncomplete) {
            const processed = organizeResult.processedTrackIds.length;
            throw new Error(
                `Hybrid album import incomplete for ${providerId}: organized ${processed}/${trackOfferCount} offered tracks. ` +
                `Refusing to mark the job complete.`,
            );
        }

        cancellationCheckpoint("before completing import");
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
        if (isImportDownloadCancelledError(error)) {
            // Only the validated download workspace is disposable. Files already
            // moved into a configured library root are deliberately preserved.
            shouldCleanupDownloadPath = true;
            throw error;
        }

        const historyContext = resolveImportHistoryContext(type, providerId, provider);
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
                removeEmptyParents(path.dirname(downloadPath), Config.getDownloadPath());
            } catch {
                // ignore cleanup errors
            }
        }
    }
    }
}
