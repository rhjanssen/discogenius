import { queueArtistWorkflow } from "./artist-workflow.js";
import { JobTypes, TaskQueueService } from "./queue.js";

/**
 * Browse hydration — queues background metadata enrichment triggered by page navigation.
 *
 * These are system-initiated jobs (trigger=0, priority=0), not user-manual commands.
 * User-triggered scans (trigger=1) always sort ahead of browse hydration at the same
 * priority level, so explicit user work is never starved by page-load background fills.
 *
 * addJob already deduplicates by (type, ref_id) for pending/processing jobs, so calling
 * these functions on page loads is safe — duplicates are dropped automatically.
 */

export function queueArtistBrowseHydration(artistId: string, artistName?: string): number {
    return queueArtistWorkflow({
        artistId,
        artistName: artistName?.trim() || "Unknown Artist",
        workflow: "metadata-refresh",
        trigger: 0,
        priority: 0,
    });
}

export function queueAlbumBrowseHydration(albumId: string): number {
    return TaskQueueService.addJob(
        JobTypes.ScanAlbum,
        {
            albumId,
            forceUpdate: false,
        },
        albumId,
        0,
        0,
    );
}
