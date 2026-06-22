import fs from "fs";
import { db } from "../../database.js";
import type { ImportDownloadCommand } from "../commands/command-bodies.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { getDownloadWorkspacePath, type DownloadMediaType } from "./download-routing.js";
import { CommandNames, type CommandModel } from "../commands/command-queue.js";

const REDOWNLOAD_IMPORT_HINT = 're-download the item to retry import';

function isDownloadMediaType(value: unknown): value is DownloadMediaType {
    return value === 'album' || value === 'track' || value === 'video';
}

function isImportDownloadJob(job: CommandModel): job is CommandModel & { type: typeof CommandNames.ImportDownload; payload: ImportDownloadCommand } {
    return job.name === CommandNames.ImportDownload;
}

export function getExistingLibraryMediaIds(
    type: DownloadMediaType,
    providerId: string,
): string[] {
    const albumIds = providerId.split(";").filter(Boolean);
    const rows = type === 'album'
        ? (albumIds.length > 0
            ? db.prepare(`
                WITH provider_albums(provider_id) AS (
                    VALUES ${albumIds.map(() => "(?)").join(", ")}
                ),
                selected_releases AS (
                    SELECT DISTINCT
                        COALESCE(pi.release_mbid, rgs.selected_release_mbid) AS release_mbid,
                        COALESCE(rgs.slot, pi.library_slot, 'stereo') AS library_slot
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
                SELECT
                    lf.file_path,
                    lf.library_root,
                    COALESCE(lf.canonical_track_mbid, lf.canonical_recording_mbid, lf.provider_id) AS media_id
                FROM selected_releases sr
                JOIN Tracks track ON track.release_mbid = sr.release_mbid
                JOIN TrackFiles lf
                  ON (
                    lf.canonical_track_mbid = track.mbid
                    OR (
                      lf.canonical_track_mbid IS NULL
                      AND lf.canonical_recording_mbid = track.recording_mbid
                    )
                  )
                 AND lf.file_type = 'track'
                 AND lf.library_slot = sr.library_slot
            `).all(...albumIds) as Array<{ file_path: string; library_root: string; media_id: string | number | null }>
            : [])
        : db.prepare(`
                SELECT
                    lf.file_path,
                    lf.library_root,
                    COALESCE(lf.canonical_track_mbid, lf.canonical_recording_mbid, lf.provider_id) AS media_id
                FROM ProviderItems pi
                JOIN TrackFiles lf
                  ON lf.provider = pi.provider
                 AND lf.provider_entity_type = pi.entity_type
                 AND lf.provider_id = pi.provider_id
                 AND lf.file_type = ?
                WHERE pi.provider_id = ?
                  AND pi.entity_type = ?
            `).all(
            type === 'video' ? 'video' : 'track',
            providerId,
            type === 'video' ? 'video' : 'track',
        ) as Array<{ file_path: string; library_root: string; media_id: string | number | null }>;

    return rows
        .filter((row) => {
            const resolvedPath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
            });
            return fs.existsSync(resolvedPath);
        })
        .map((row) => String(row.media_id || ""))
        .filter(Boolean);
}

export function shouldQueueRedownloadForFailedImport(job: CommandModel): boolean {
    if (!isImportDownloadJob(job) || job.status !== 'failed') {
        return false;
    }

    const mediaType = job.payload?.type;
    const providerId = job.payload?.providerId;
    if (!isDownloadMediaType(mediaType) || !providerId) {
        return false;
    }

    const combinedFailureText = `${job.error ?? ''}\n${job.payload?.downloadState?.statusMessage ?? ''}`.toLowerCase();
    if (combinedFailureText.includes(REDOWNLOAD_IMPORT_HINT)) {
        return true;
    }

    const downloadPath = job.payload.path || getDownloadWorkspacePath(mediaType, providerId);
    if (fs.existsSync(downloadPath)) {
        return false;
    }

    return getExistingLibraryMediaIds(mediaType, providerId).length === 0;
}
