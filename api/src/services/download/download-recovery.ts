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

export function getExistingLibraryMediaIds(
    type: DownloadMediaType,
    providerId: string,
    provider?: string | null,
): string[] {
    const normalizedProvider = String(provider || "").trim() || null;
    const rows = type === 'album'
        ? db.prepare(`
                SELECT
                    lf.file_path,
                    lf.library_root,
                    CAST(lf.track_id AS TEXT) AS media_id
                FROM ProviderItems provider_release
                JOIN ProviderReleaseMatches release_match
                  ON release_match.provider_release_item_id = provider_release.id
                 AND release_match.match_state = 'accepted'
                JOIN LibraryReleases library_release
                  ON library_release.release_id = release_match.release_id
                JOIN Tracks track
                  ON track.album_release_id = library_release.release_id
                JOIN TrackFiles lf
                  ON lf.library_id = library_release.library_id
                 AND lf.track_id = track.id
                 AND lf.file_class = 'audio'
                WHERE provider_release.provider_id = ?
                  AND provider_release.entity_type IN ('release', 'album')
                  AND (? IS NULL OR provider_release.provider = ?)
            `).all(
                providerId,
                normalizedProvider,
                normalizedProvider,
            ) as Array<{ file_path: string; library_root: string; media_id: string | number | null }>
        : type === 'track'
          ? db.prepare(`
                SELECT
                    lf.file_path,
                    lf.library_root,
                    CAST(lf.track_id AS TEXT) AS media_id
                FROM ProviderItems provider_track
                JOIN ProviderReleaseMembers release_member
                  ON release_member.member_item_id = provider_track.id
                JOIN ProviderTrackMatches track_match
                  ON track_match.provider_release_member_id = release_member.id
                 AND track_match.match_state = 'accepted'
                JOIN TrackFiles lf
                  ON lf.track_id = track_match.track_id
                 AND lf.file_class = 'audio'
                WHERE provider_track.provider_id = ?
                  AND provider_track.entity_type = 'track'
                  AND (? IS NULL OR provider_track.provider = ?)
            `).all(
                providerId,
                normalizedProvider,
                normalizedProvider,
            ) as Array<{ file_path: string; library_root: string; media_id: string | number | null }>
          : db.prepare(`
                SELECT
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
                  AND (? IS NULL OR provider_video.provider = ?)
            `).all(
                providerId,
                normalizedProvider,
                normalizedProvider,
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

    const downloadPath = job.payload.path
        ? validateDownloadWorkspacePath(job.payload.path)
        : getDownloadWorkspacePath(mediaType, providerId, job.payload.provider);
    if (fs.existsSync(downloadPath)) {
        return false;
    }

    return getExistingLibraryMediaIds(mediaType, providerId, job.payload.provider).length === 0;
}
