import { db } from "../database.js";
import { JobTypes, TaskQueueService } from "./queue.js";

const PLAYLIST_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QueuePlaylistSyncResult {
    success: true;
    queued: boolean;
    jobId: number;
    commandPath: string;
    message: string;
}

export class PlaylistSyncServiceError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

export function isPlaylistUuid(value: string): boolean {
    return PLAYLIST_UUID_PATTERN.test(String(value || "").trim());
}

function getPlaylistByUuid(playlistUuid: string): { uuid: string } | undefined {
    return db.prepare("SELECT uuid FROM playlists WHERE uuid = ?").get(playlistUuid) as { uuid: string } | undefined;
}

function getActivePlaylistScanJobId(playlistUuid: string): number | null {
    const job = TaskQueueService.getByRefId(playlistUuid, JobTypes.ScanPlaylist);
    if (!job || job.type !== JobTypes.ScanPlaylist) {
        return null;
    }

    return job.id;
}

export function queuePlaylistSyncByUuid(playlistUuidRaw: string): QueuePlaylistSyncResult {
    const playlistUuid = String(playlistUuidRaw || "").trim();

    if (!isPlaylistUuid(playlistUuid)) {
        throw new PlaylistSyncServiceError(400, "Invalid playlist UUID format");
    }

    const playlist = getPlaylistByUuid(playlistUuid);
    if (!playlist) {
        throw new PlaylistSyncServiceError(404, "Playlist not found");
    }

    const existingJobId = getActivePlaylistScanJobId(playlistUuid);
    if (existingJobId !== null) {
        return {
            success: true,
            queued: false,
            jobId: existingJobId,
            commandPath: `/api/queue/${existingJobId}`,
            message: "Playlist sync is already queued or processing",
        };
    }

    const jobId = TaskQueueService.addJob(
        JobTypes.ScanPlaylist,
        { tidalId: playlistUuid },
        playlistUuid,
    );

    if (!Number.isFinite(jobId) || jobId <= 0) {
        throw new PlaylistSyncServiceError(500, "Failed to queue playlist sync");
    }

    return {
        success: true,
        queued: true,
        jobId,
        commandPath: `/api/queue/${jobId}`,
        message: "Playlist sync queued",
    };
}
