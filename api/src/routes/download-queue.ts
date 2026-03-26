import express, { Request, Response, Router } from 'express';
import { db } from '../database.js';
import { compareJobsByExecutionOrder, DOWNLOAD_JOB_TYPES, DOWNLOAD_OR_IMPORT_JOB_TYPES, JobTypes, TaskQueueService } from '../services/queue.js';
import { downloadProcessor } from '../services/download-processor.js';
import { downloadEvents } from '../services/download-events.js';
import { authMiddleware } from '../middleware/auth.js';
import { buildStreamingMediaUrl } from '../services/download-routing.js';
import { shouldQueueRedownloadForFailedImport } from '../services/download-recovery.js';
import type {
    DownloadAlbumJobPayload,
    DownloadPlaylistJobPayload,
    DownloadTrackJobPayload,
    DownloadVideoJobPayload,
    ImportDownloadJobPayload,
} from '../services/job-payloads.js';
import type { QueueItemContract, QueueListResponseContract } from '../contracts/status.js';

const router: Router = express.Router();

// All queue routes require authentication
router.use(authMiddleware);

function buildRetryResponse(jobType: string, message?: string) {
    return {
        action: jobType === JobTypes.ImportDownload ? 'retry-import' : 'retry-download',
        message: message || (jobType === JobTypes.ImportDownload ? 'Import queued for retry' : 'Download queued for retry'),
    };
}

function queueRedownloadForImport(jobId: number, payload: ImportDownloadJobPayload, priority: number, trigger: number) {
    const mediaType = payload.type;
    const tidalId = payload.tidalId;
    if (!mediaType || !tidalId) {
        throw new Error('Import retry is missing the media type or TIDAL ID needed to queue a re-download.');
    }

    const url = buildStreamingMediaUrl(mediaType, tidalId);
    const existingJob = TaskQueueService.getByRefId(
        tidalId,
        mediaType === 'video'
            ? JobTypes.DownloadVideo
            : mediaType === 'album'
                ? JobTypes.DownloadAlbum
                : mediaType === 'playlist'
                    ? JobTypes.DownloadPlaylist
                    : JobTypes.DownloadTrack,
    );

    let queuedJobId = existingJob?.id;

    if (queuedJobId === undefined) {
        switch (mediaType) {
            case 'album': {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                    tidalId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    artist: payload.resolved?.artist ?? payload.artist,
                    cover: payload.resolved?.cover ?? payload.cover,
                    album_id: payload.album_id ?? payload.albumId,
                    artist_id: payload.artist_id ?? payload.artistId,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadAlbumJobPayload, tidalId, priority, trigger);
                break;
            }
            case 'video': {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadVideo, {
                    tidalId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    artist: payload.resolved?.artist ?? payload.artist,
                    cover: payload.resolved?.cover ?? payload.cover,
                    album_id: payload.album_id ?? payload.albumId,
                    artist_id: payload.artist_id ?? payload.artistId,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadVideoJobPayload, tidalId, priority, trigger);
                break;
            }
            case 'playlist': {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadPlaylist, {
                    tidalId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    cover: payload.resolved?.cover ?? payload.cover,
                    playlistId: tidalId,
                    playlistName: payload.playlistName ?? payload.resolved?.title ?? payload.title,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadPlaylistJobPayload, tidalId, priority, trigger);
                break;
            }
            case 'track':
            default: {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
                    tidalId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    artist: payload.resolved?.artist ?? payload.artist,
                    cover: payload.resolved?.cover ?? payload.cover,
                    album_id: payload.album_id ?? payload.albumId,
                    artist_id: payload.artist_id ?? payload.artistId,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadTrackJobPayload, tidalId, priority, trigger);
                break;
            }
        }
    }

    if (queuedJobId === undefined || queuedJobId < 0) {
        throw new Error(`Failed to queue a new ${mediaType} download for ${tidalId}.`);
    }

    downloadProcessor.processQueue().catch(err => {
        console.error('[QUEUE-API] Error triggering queue processing:', err);
    });

    return {
        action: 'queue-redownload',
        message: existingJob
            ? (existingJob.status === 'processing' ? 'Download already in progress for this item' : 'Download already queued for this item')
            : 'Re-download queued to recover the failed import',
        jobId: queuedJobId,
        sourceJobId: jobId,
    };
}

function mapDownloadQueueJob(j: any, queuePosition?: number): QueueItemContract {
    const downloadState = j.payload?.downloadState ?? {};
    const contentType = j.type === JobTypes.DownloadVideo
        ? 'video'
        : j.type === JobTypes.DownloadAlbum
            ? 'album'
            : j.type === JobTypes.ImportDownload
                ? (j.payload?.type || 'track')
                : 'track';
    const tidalId = j.ref_id || j.payload?.tidalId || null;

    let title: string | undefined = j.payload?.title || j.payload?.resolved?.title;
    let artist: string | undefined = j.payload?.artist || j.payload?.resolved?.artist;
    let cover: string | null | undefined = j.payload?.cover ?? j.payload?.resolved?.cover;
    let album_id: string | null | undefined = j.payload?.album_id;
    let album_title: string | null | undefined = j.payload?.album_title;
    let quality: string | null | undefined = j.payload?.quality ?? null;

    if (tidalId && (!title || !artist || cover === undefined || album_id === undefined || album_title === undefined)) {
        try {
            if (contentType === 'album') {
                const row = db.prepare(`
                    SELECT a.title, a.cover, ar.name as artist_name, a.id as album_id, a.quality
                    FROM albums a
                    LEFT JOIN artists ar ON ar.id = a.artist_id
                    WHERE a.id = ?
                `).get(tidalId) as any;
                if (!title) title = row?.title;
                if (!artist) artist = row?.artist_name;
                if (cover === undefined) cover = row?.cover ?? null;
                if (album_id === undefined) album_id = row?.album_id ?? null;
                if (album_title === undefined) album_title = row?.title ?? null;
                if (quality === undefined || quality === null) quality = row?.quality ?? null;
            } else if (contentType === 'video') {
                const row = db.prepare(`
                    SELECT m.title, ar.name as artist_name, m.cover as video_cover, a.id as album_id, a.title as album_title, m.quality
                    FROM media m
                    LEFT JOIN artists ar ON ar.id = m.artist_id
                    LEFT JOIN albums a ON a.id = m.album_id
                    WHERE m.id = ? AND m.type = 'Music Video'
                `).get(tidalId) as any;
                if (!title) title = row?.title;
                if (!artist) artist = row?.artist_name;
                if (cover === undefined) cover = row?.video_cover ?? null;
                if (album_id === undefined) album_id = row?.album_id ?? null;
                if (album_title === undefined) album_title = row?.album_title ?? null;
                if (quality === undefined || quality === null) quality = row?.quality ?? null;
            } else {
                const row = db.prepare(`
                    SELECT m.title, m.version as version, ar.name as artist_name, a.cover as album_cover, a.id as album_id, a.title as album_title, m.quality
                    FROM media m
                    LEFT JOIN artists ar ON ar.id = m.artist_id
                    LEFT JOIN albums a ON a.id = m.album_id
                    WHERE m.id = ?
                `).get(tidalId) as any;
                if (!title) {
                    const base = row?.title;
                    const v = (row?.version || '').toString().trim();
                    title = base && v && !base.toLowerCase().includes(v.toLowerCase()) ? `${base} (${v})` : base;
                }
                if (!artist) artist = row?.artist_name;
                if (cover === undefined) cover = row?.album_cover ?? null;
                if (album_id === undefined) album_id = row?.album_id ?? null;
                if (album_title === undefined) album_title = row?.album_title ?? null;
                if (quality === undefined || quality === null) quality = row?.quality ?? null;
            }
        } catch {
            // ignore lookup failures
        }
    }

    return {
        id: j.id,
        tidalId,
        type: contentType,
        status: j.status,
        stage: j.type === JobTypes.ImportDownload ? 'import' : 'download',
        progress: typeof downloadState.progress === 'number' ? downloadState.progress : j.progress,
        error: j.error,
        created_at: j.created_at,
        updated_at: j.updated_at ?? j.created_at,
        started_at: j.started_at ?? null,
        completed_at: j.completed_at ?? null,
        url: j.payload?.url ?? null,
        path: j.payload?.path ?? null,
        title: title || 'Unknown',
        artist: artist || 'Unknown',
        cover: cover ?? null,
        quality: quality ?? null,
        album_id: album_id ?? null,
        album_title: album_title ?? null,
        currentFileNum: downloadState.currentFileNum,
        totalFiles: downloadState.totalFiles,
        currentTrack: downloadState.currentTrack,
        trackProgress: downloadState.trackProgress,
        trackStatus: downloadState.trackStatus,
        statusMessage: downloadState.statusMessage,
        state: downloadState.state,
        speed: downloadState.speed,
        eta: downloadState.eta,
        size: downloadState.size,
        sizeleft: downloadState.sizeleft,
        tracks: downloadState.tracks,
        queuePosition,
    };
}

/**
 * DELETE /api/remove
 * Cancel/Remove item from queue
 */
router.delete('/remove', async (req: Request, res: Response) => {
    try {
        const { id } = req.body;

        if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: "Invalid request", message: "id must be a positive integer job ID" });
        }

        const jobId: number = id;
        const jobExists = TaskQueueService.getById(jobId);
        if (!jobExists) {
            return res.status(404).json({ error: "Not found", message: "Job not found in queue" });
        }

        // Check if this job is currently being processed
        const status = downloadProcessor.getStatus();
        if (status.currentJobId === jobId) {
            // Pause to cancel current download
            await downloadProcessor.pause();
            TaskQueueService.cancel(jobId);
            await downloadProcessor.resume();
        } else {
            TaskQueueService.cancel(jobId);
        }

        res.sendStatus(204);
    } catch (error: any) {
        console.error('[QUEUE-API] Error removing from queue:', error);
        res.status(500).json({ error: 'Failed to remove from queue', message: error.message });
    }
});

/**
 * DELETE /api/remove-all
 * Clear entire download queue (pending and failed only, not currently processing)
 */
router.delete('/remove-all', async (_req: Request, res: Response) => {
    try {
        TaskQueueService.clearDownloadJobs();
        res.sendStatus(204);
    } catch (error: any) {
        console.error('[QUEUE-API] Error clearing queue:', error);
        res.status(500).json({ error: 'Failed to clear queue', message: error.message });
    }
});

/**
 * DELETE /api/remove-finished
 * Remove all finished/failed items
 */
router.delete('/remove-finished', async (_req: Request, res: Response) => {
    try {
        TaskQueueService.clearFinishedByTypes([
            JobTypes.DownloadAlbum,
            JobTypes.DownloadTrack,
            JobTypes.DownloadVideo,
            JobTypes.DownloadPlaylist,
            JobTypes.ImportDownload,
        ]);
        res.sendStatus(204);
    } catch (error: any) {
        console.error('[QUEUE-API] Error clearing finished:', error);
        res.status(500).json({ error: 'Failed to clear finished items', message: error.message });
    }
});

/**
 * POST /api/queue/pause
 * Pause download queue
 */
router.post('/queue/pause', async (_req: Request, res: Response) => {
    try {
        await downloadProcessor.pause();
        res.sendStatus(204);
    } catch (error: any) {
        console.error('[QUEUE-API] Error pausing queue:', error);
        res.status(500).json({ error: 'Failed to pause queue', message: error.message });
    }
});

/**
 * POST /api/queue/resume
 * Resume download queue
 */
router.post('/queue/resume', async (_req: Request, res: Response) => {
    try {
        await downloadProcessor.resume();
        res.sendStatus(204);
    } catch (error: any) {
        console.error('[QUEUE-API] Error resuming queue:', error);
        res.status(500).json({ error: 'Failed to resume queue', message: error.message });
    }
});

/**
 * GET /api/queue/status
 * Get queue status (isPaused, processing, currentItem)
 */
router.get('/queue/status', async (_req: Request, res: Response) => {
    try {
        const status = downloadProcessor.getStatus();
        const stats = TaskQueueService.getStats();

        res.json({
            ...status,
            stats
        });
    } catch (error: any) {
        console.error('[QUEUE-API] Error getting status:', error);
        res.status(500).json({ error: 'Failed to get status', message: error.message });
    }
});

/**
 * GET /api/queue
 * List all queue items
 */
router.get('/queue', async (req: Request, res: Response) => {
    try {
        const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '100'), 10) || 100));
        const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

        const pendingDownloadJobs = TaskQueueService.listJobsByTypesAndStatuses(
            DOWNLOAD_JOB_TYPES,
            ['pending'],
            TaskQueueService.countJobsByTypesAndStatuses(DOWNLOAD_JOB_TYPES, ['pending']),
            0,
            { orderBy: 'execution' },
        ).sort(compareJobsByExecutionOrder);

        const queuePositionById = new Map<number, number>(
            pendingDownloadJobs.map((job, index) => [job.id, index + 1]),
        );

        // Lidarr-style queue surfaces only live work.
        // Completed/failed jobs belong in activity/history, not the live queue.
        // Include ImportDownload so items remain visible while import/finalization is still running.
        const jobs = TaskQueueService.listJobsByTypesAndStatuses(
            DOWNLOAD_OR_IMPORT_JOB_TYPES,
            ['pending', 'processing'],
            5000,
            0,
            { orderBy: 'execution' },
        ).sort((left, right) => {
            const leftProcessing = left.status === 'processing';
            const rightProcessing = right.status === 'processing';
            if (leftProcessing !== rightProcessing) {
                return leftProcessing ? -1 : 1;
            }

            const leftImportPending = !leftProcessing && left.type === JobTypes.ImportDownload;
            const rightImportPending = !rightProcessing && right.type === JobTypes.ImportDownload;
            if (leftImportPending !== rightImportPending) {
                return leftImportPending ? -1 : 1;
            }

            if (!leftProcessing && !rightProcessing) {
                const leftQueuePosition = queuePositionById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
                const rightQueuePosition = queuePositionById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
                if (leftQueuePosition !== rightQueuePosition) {
                    return leftQueuePosition - rightQueuePosition;
                }
            }

            return compareJobsByExecutionOrder(left, right);
        });

        const total = jobs.length;
        const mapped = jobs
            .slice(offset, offset + limit)
            .map((job) => mapDownloadQueueJob(job, queuePositionById.get(job.id)));

        const payload: QueueListResponseContract = {
            items: mapped,
            total,
            limit,
            offset,
            hasMore: offset + mapped.length < total,
        };
        res.json(payload);
    } catch (error: any) {
        console.error('[QUEUE-API] Error getting queue:', error);
        res.status(500).json({ error: 'Failed to get queue', message: error.message });
    }
});

router.post('/queue/reorder', async (req: Request, res: Response) => {
    try {
        const rawJobIds: unknown[] = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
        const parsedJobIds = rawJobIds.map((value: unknown) => parseInt(String(value), 10));

        if (parsedJobIds.some((value) => !Number.isInteger(value) || value <= 0)) {
            return res.status(400).json({
                error: 'Invalid reorder set',
                message: 'jobIds must contain only positive integer ids',
            });
        }

        const distinctJobIds = Array.from(new Set(parsedJobIds));
        if (distinctJobIds.length !== parsedJobIds.length) {
            return res.status(400).json({
                error: 'Invalid reorder set',
                message: 'jobIds must not contain duplicate ids',
            });
        }

        const jobIds = distinctJobIds;
        const beforeJobId = req.body?.beforeJobId == null ? undefined : parseInt(String(req.body.beforeJobId), 10);
        const afterJobId = req.body?.afterJobId == null ? undefined : parseInt(String(req.body.afterJobId), 10);

        if (jobIds.length === 0) {
            return res.status(400).json({ error: 'Missing queue items', message: 'jobIds must contain one or more pending queue item ids' });
        }

        if (beforeJobId != null && (!Number.isInteger(beforeJobId) || beforeJobId <= 0)) {
            return res.status(400).json({
                error: 'Invalid reorder request',
                message: 'beforeJobId must be a positive integer when provided',
            });
        }

        if (afterJobId != null && (!Number.isInteger(afterJobId) || afterJobId <= 0)) {
            return res.status(400).json({
                error: 'Invalid reorder request',
                message: 'afterJobId must be a positive integer when provided',
            });
        }

        if ((beforeJobId == null && afterJobId == null) || (beforeJobId != null && afterJobId != null)) {
            return res.status(400).json({ error: 'Invalid reorder request', message: 'Provide exactly one of beforeJobId or afterJobId' });
        }

        TaskQueueService.reorderPendingJobs(jobIds, {
            beforeJobId,
            afterJobId,
            types: DOWNLOAD_JOB_TYPES,
        });

        res.json({ message: 'Queue reordered' });
    } catch (error: any) {
        console.error('[QUEUE-API] Error reordering queue:', error);
        res.status(409).json({ error: 'Failed to reorder queue', message: error.message });
    }
});

/**
 * POST /api/queue
 * Add a new item to the download queue
 */
router.post('/queue', async (req: Request, res: Response) => {
    try {
        const { url, type, tidalId } = req.body;

        if (!url && !tidalId) {
            return res.status(400).json({ error: 'Either url or tidalId is required' });
        }

        const parsedType =
            typeof type === 'string' && (type === 'track' || type === 'video' || type === 'album')
                ? type
                : null;

        // Parse URL if provided (use to infer missing pieces, but don't override explicit params)
        const urlMatch = typeof url === 'string' ? url.match(/\/(track|video|album)\/(\d+)/) : null;
        const urlType = urlMatch ? (urlMatch[1] as 'track' | 'video' | 'album') : null;
        const urlTidalId = urlMatch ? urlMatch[2] : null;

        const contentType: 'track' | 'video' | 'album' = parsedType ?? urlType ?? 'track';
        const resolvedTidalId = (tidalId ?? urlTidalId)?.toString?.() ?? null;

        if (!resolvedTidalId) {
            return res.status(400).json({ error: 'Unable to determine tidalId' });
        }

        const jobType =
            contentType === 'video' ? JobTypes.DownloadVideo : contentType === 'album' ? JobTypes.DownloadAlbum : JobTypes.DownloadTrack;

        // Create payload
        const payload = {
            tidalId: resolvedTidalId,
            url: url || `https://listen.tidal.com/${contentType}/${resolvedTidalId}`,
            type: contentType,
        };

        // Add to queue
        const jobId = TaskQueueService.addJob(jobType, payload, resolvedTidalId);


        // Trigger queue processing if not already running
        downloadProcessor.processQueue().catch(err => {
            console.error('[QUEUE-API] Error triggering queue processing:', err);
        });

        res.json({ id: jobId, message: 'Added to download queue' });
    } catch (error: any) {
        console.error('[QUEUE-API] Error adding to queue:', error);
        res.status(500).json({ error: 'Failed to add to queue', message: error.message });
    }
});

/**
 * GET /api/queue/progress-stream
 * SSE endpoint for real-time download progress updates
 */
router.get('/queue/progress-stream', (req: Request, res: Response) => {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial status
    const status = downloadProcessor.getStatus();
    const stats = TaskQueueService.getStats();
    sendEvent('status', { ...status, stats });

    // Listen for download events
    const onProgress = (data: any) => sendEvent('progress', data);
    const onStarted = (data: any) => sendEvent('started', data);
    const onCompleted = (data: any) => sendEvent('completed', data);
    const onFailed = (data: any) => sendEvent('failed', data);
    const onQueueStatus = (data: any) => sendEvent('queue-status', data);

    downloadEvents.on('progress', onProgress);
    downloadEvents.on('started', onStarted);
    downloadEvents.on('completed', onCompleted);
    downloadEvents.on('failed', onFailed);
    downloadEvents.on('queue-status', onQueueStatus);

    // Heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        sendEvent('heartbeat', { timestamp: Date.now() });
    }, 30000);

    // Clean up on client disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        downloadEvents.off('progress', onProgress);
        downloadEvents.off('started', onStarted);
        downloadEvents.off('completed', onCompleted);
        downloadEvents.off('failed', onFailed);
        downloadEvents.off('queue-status', onQueueStatus);
    });

});

/**
 * DELETE /api/queue/:id
 * Delete a specific queue item
 */
router.delete('/queue/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const jobId = parseInt(String(id), 10);

        if (isNaN(jobId)) {
            return res.status(400).json({ error: 'Invalid job ID' });
        }

        const job = TaskQueueService.getById(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        if (job.status === 'processing' || downloadProcessor.isActivelyProcessingJob(jobId)) {
            return res.status(409).json({
                error: 'Job is processing',
                message: 'Pause or cancel the active download before deleting this queue item',
            });
        }

        TaskQueueService.deleteJob(jobId);
        res.json({ message: 'Job deleted' });
    } catch (error: any) {
        console.error('[QUEUE-API] Error deleting job:', error);
        res.status(500).json({ error: 'Failed to delete job', message: error.message });
    }
});

/**
 * POST /api/queue/:id/retry
 * Retry a failed queue item
 */
router.post('/queue/:id/retry', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const jobId = parseInt(String(id), 10);

        if (isNaN(jobId)) {
            return res.status(400).json({ error: 'Invalid job ID' });
        }

        const job = TaskQueueService.getById(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        if (job.status === 'processing' || downloadProcessor.isActivelyProcessingJob(jobId)) {
            return res.status(409).json({
                error: 'Job is processing',
                message: 'Wait for the active download to finish or cancel it before retrying',
            });
        }

        if (shouldQueueRedownloadForFailedImport(job)) {
            return res.json(queueRedownloadForImport(job.id, job.payload as ImportDownloadJobPayload, job.priority, job.trigger ?? 0));
        }

        TaskQueueService.retry(jobId);

        // Trigger queue processing
        downloadProcessor.processQueue().catch(err => {
            console.error('[QUEUE-API] Error triggering queue processing:', err);
        });

        res.json(buildRetryResponse(job.type));
    } catch (error: any) {
        console.error('[QUEUE-API] Error retrying job:', error);
        res.status(500).json({ error: 'Failed to retry job', message: error.message });
    }
});

/**
 * POST /api/queue/clear-completed
 * Clear all completed items from the queue
 */
router.post('/queue/clear-completed', async (_req: Request, res: Response) => {
    try {
        TaskQueueService.clearFinishedByTypes([
            JobTypes.DownloadAlbum,
            JobTypes.DownloadTrack,
            JobTypes.DownloadVideo,
            JobTypes.DownloadPlaylist,
            JobTypes.ImportDownload,
        ]);
        res.json({ message: 'Finished download jobs cleared' });
    } catch (error: any) {
        console.error('[QUEUE-API] Error clearing completed:', error);
        res.status(500).json({ error: 'Failed to clear completed', message: error.message });
    }
});

export default router;
