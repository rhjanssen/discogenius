import fs from "fs";
import { db } from "../database.js";
import type { ImportDownloadJobPayload } from "./job-payloads.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { getDownloadWorkspacePath, type DownloadMediaType } from "./download-routing.js";
import { JobTypes, type Job } from "./queue.js";

const REDOWNLOAD_IMPORT_HINT = 're-download the item to retry import';

function isDownloadMediaType(value: unknown): value is DownloadMediaType {
    return value === 'album' || value === 'track' || value === 'video' || value === 'playlist';
}

function isImportDownloadJob(job: Job): job is Job & { type: typeof JobTypes.ImportDownload; payload: ImportDownloadJobPayload } {
    return job.type === JobTypes.ImportDownload;
}

export function getExistingLibraryMediaIds(
    type: DownloadMediaType,
    tidalId: string,
): string[] {
    if (type === 'playlist') {
        return [];
    }

    const rows = type === 'album'
        ? db.prepare(`
                SELECT lf.file_path, lf.library_root, m.id as media_id
                FROM library_files lf
                JOIN media m ON m.id = lf.media_id
                WHERE m.album_id = ? AND lf.file_type = 'track'
            `).all(tidalId) as Array<{ file_path: string; library_root: string; media_id: number }>
        : db.prepare(`
                SELECT file_path, library_root, media_id
                FROM library_files
                WHERE media_id = ? AND file_type = ?
            `).all(
            tidalId,
            type === 'video' ? 'video' : 'track',
        ) as Array<{ file_path: string; library_root: string; media_id: number }>;

    return rows
        .filter((row) => {
            const resolvedPath = resolveStoredLibraryPath({
                filePath: row.file_path,
                libraryRoot: row.library_root,
            });
            return fs.existsSync(resolvedPath);
        })
        .map((row) => String(row.media_id));
}

export function shouldQueueRedownloadForFailedImport(job: Job): boolean {
    if (!isImportDownloadJob(job) || job.status !== 'failed') {
        return false;
    }

    const mediaType = job.payload?.type;
    const tidalId = job.payload?.tidalId;
    if (!isDownloadMediaType(mediaType) || !tidalId) {
        return false;
    }

    const combinedFailureText = `${job.error ?? ''}\n${job.payload?.downloadState?.statusMessage ?? ''}`.toLowerCase();
    if (combinedFailureText.includes(REDOWNLOAD_IMPORT_HINT)) {
        return true;
    }

    const downloadPath = job.payload.path || getDownloadWorkspacePath(mediaType, tidalId);
    if (fs.existsSync(downloadPath)) {
        return false;
    }

    return getExistingLibraryMediaIds(mediaType, tidalId).length === 0;
}