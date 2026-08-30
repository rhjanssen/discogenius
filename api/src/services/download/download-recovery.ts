import fs from "fs";
import { db } from "../../database.js";
import type { ImportDownloadCommand } from "../commands/command-bodies.js";
import { resolveStoredLibraryPath } from "../mediafiles/library-paths.js";
import { getDownloadWorkspacePath, validateDownloadWorkspacePath, type DownloadMediaType } from "./download-routing.js";
import {CommandNames} from "../commands/command-names.js";
import {type CommandModel} from "../commands/command-queue-manager.js";

const REDOWNLOAD_IMPORT_HINT = 're-download the item to retry import';

function isDownloadMediaType(value: unknown): value is DownloadMediaType {
    return value === 'album' || value === 'track' || value === 'video';
}

function isImportDownloadJob(job: CommandModel): job is CommandModel & { type: typeof CommandNames.ImportDownload; payload: ImportDownloadCommand } {
    return job.name === CommandNames.ImportDownload;
}

export type ExistingLibraryFile = {
    /** Exact TrackFiles row — the operation identity recovery must report. */
    trackFileId: number;
    /** Canonical media id (Tracks.id for audio, Recordings.id for video). */
    mediaId: string;
};

/**
 * Files already present in the library for this provider resource, with the
 * exact TrackFiles row for each. Callers that attach per-file facts need the row
 * id, not just the media id.
 */
export function getExistingLibraryFiles(
    type: DownloadMediaType,
    providerId: string,
    provider: string,
    libraryId?: number | null,
): ExistingLibraryFile[] {
    const normalizedProvider = String(provider || "").trim();
    if (!normalizedProvider) {
        throw new Error("Download recovery requires the provider identity.");
    }
    const rows = type === 'album'
        ? db.prepare(`
                SELECT
                    lf.id AS track_file_id,
                    lf.file_path,
                    lf.library_root,
                    CAST(lf.track_id AS TEXT) AS media_id
                FROM ProviderItems provider_release
                JOIN ProviderEditionMatches release_match
                  ON release_match.provider_edition_item_id = provider_release.id
                 AND release_match.match_state = 'accepted'
                JOIN LibraryEditions library_release
                  ON library_release.edition_id = release_match.edition_id
                JOIN Tracks track
                  ON track.album_edition_id = library_release.edition_id
                JOIN TrackFiles lf
                  ON lf.library_id = library_release.library_id
                 AND lf.track_id = track.id
                 AND lf.file_class = 'audio'
                WHERE provider_release.provider_id = ?
                  AND provider_release.entity_type = 'release'
                  AND provider_release.provider = ?
                  AND (? IS NULL OR lf.library_id = ?)
            `).all(
                providerId,
                normalizedProvider,
                libraryId ?? null,
                libraryId ?? null,
            ) as Array<{ track_file_id: number; file_path: string; library_root: string; media_id: string | number | null }>
        : type === 'track'
          ? db.prepare(`
                SELECT
                    lf.id AS track_file_id,
                    lf.file_path,
                    lf.library_root,
                    CAST(lf.track_id AS TEXT) AS media_id
                FROM ProviderItems provider_track
                JOIN ProviderEditionMembers release_member
                  ON release_member.member_item_id = provider_track.id
                JOIN ProviderTrackMatches track_match
                  ON track_match.provider_edition_member_id = release_member.id
                 AND track_match.match_state = 'accepted'
                JOIN TrackFiles lf
                  ON lf.track_id = track_match.track_id
                 AND lf.file_class = 'audio'
                WHERE provider_track.provider_id = ?
                  AND provider_track.entity_type = 'track'
                  AND provider_track.provider = ?
                  AND (? IS NULL OR lf.library_id = ?)
            `).all(
                providerId,
                normalizedProvider,
                libraryId ?? null,
                libraryId ?? null,
            ) as Array<{ track_file_id: number; file_path: string; library_root: string; media_id: string | number | null }>
          : db.prepare(`
                SELECT
                    lf.id AS track_file_id,
                    lf.file_path,
                    lf.library_root,
                    CAST(lf.recording_id AS TEXT) AS media_id
                FROM ProviderItems provider_video
                JOIN ProviderVideoMatches video_match
                  ON video_match.provider_video_item_id = provider_video.id
                 AND video_match.match_state = 'accepted'
                JOIN TrackFiles lf
                  ON lf.recording_id = video_match.recording_id
                 AND lf.file_class = 'video'
                WHERE provider_video.provider_id = ?
                  AND provider_video.entity_type = 'video'
                  AND provider_video.provider = ?
                  AND (? IS NULL OR lf.library_id = ?)
            `).all(
                providerId,
                normalizedProvider,
                libraryId ?? null,
                libraryId ?? null,
            ) as Array<{ track_file_id: number; file_path: string; library_root: string; media_id: string | number | null }>;

    return rows
        .filter((row) => {
            const resolvedPath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
            });
            return fs.existsSync(resolvedPath);
        })
        .map((row) => ({ trackFileId: Number(row.track_file_id), mediaId: String(row.media_id || "") }))
        .filter((entry) => Boolean(entry.mediaId) && Number.isInteger(entry.trackFileId));
}

/** Media ids only, for callers that just need presence or a count. */
export function getExistingLibraryMediaIds(
    type: DownloadMediaType,
    providerId: string,
    provider: string,
    libraryId?: number | null,
): string[] {
    return getExistingLibraryFiles(type, providerId, provider, libraryId).map((entry) => entry.mediaId);
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

    const downloadPath = job.payload.path
        ? validateDownloadWorkspacePath(job.payload.path)
        : getDownloadWorkspacePath(mediaType, providerId, job.payload.provider);
    if (fs.existsSync(downloadPath)) {
        return false;
    }

    return getExistingLibraryMediaIds(
        mediaType,
        providerId,
        job.payload.provider,
        job.payload.libraryId,
    ).length === 0;
}
