import express, { Request, Response, Router } from 'express';
import { DOWNLOAD_JOB_TYPES, JobTypes, TaskQueueService } from '../services/queue.js';
import { downloadProcessor } from '../services/download-processor.js';
import { downloadEvents } from '../services/download-events.js';
import { authMiddleware } from '../middleware/auth.js';
import { buildStreamingMediaUrl, parseStreamingUrl, type DownloadMediaType } from '../services/download-routing.js';
import { shouldQueueRedownloadForFailedImport } from '../services/download-recovery.js';
import { DownloadQueueQueryService } from '../services/download-queue-query-service.js';
import { looksLikeMusicBrainzMbid, resolveProviderTrackForCanonicalTrack } from '../services/provider-track-resolver.js';
import type {
    DownloadAlbumJobPayload,
    DownloadTrackJobPayload,
    DownloadVideoJobPayload,
    ImportDownloadJobPayload,
} from '../services/job-payloads.js';

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
    const providerId = payload.providerId;
    if (!mediaType || !providerId) {
        throw new Error('Import retry is missing the media type or provider ID needed to queue a re-download.');
    }
    if (mediaType !== 'track' && mediaType !== 'video' && mediaType !== 'album') {
        throw new Error(`Import retry has unsupported media type: ${mediaType}`);
    }

    const url = buildStreamingMediaUrl(mediaType, providerId);
    const existingJob = TaskQueueService.getByRefId(
        providerId,
        mediaType === 'video'
            ? JobTypes.DownloadVideo
            : mediaType === 'album'
                ? JobTypes.DownloadAlbum
                : JobTypes.DownloadTrack,
    );

    let queuedJobId = existingJob?.id;

    if (queuedJobId === undefined) {
        switch (mediaType) {
            case 'album': {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                    providerId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    artist: payload.resolved?.artist ?? payload.artist,
                    cover: payload.resolved?.cover ?? payload.cover,
                    album_id: payload.album_id ?? payload.albumId,
                    artist_id: payload.artist_id ?? payload.artistId,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadAlbumJobPayload, providerId, priority, trigger);
                break;
            }
            case 'video': {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadVideo, {
                    providerId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    artist: payload.resolved?.artist ?? payload.artist,
                    cover: payload.resolved?.cover ?? payload.cover,
                    album_id: payload.album_id ?? payload.albumId,
                    artist_id: payload.artist_id ?? payload.artistId,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadVideoJobPayload, providerId, priority, trigger);
                break;
            }
            case 'track':
            default: {
                queuedJobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
                    providerId,
                    url,
                    type: mediaType,
                    title: payload.resolved?.title ?? payload.title,
                    artist: payload.resolved?.artist ?? payload.artist,
                    cover: payload.resolved?.cover ?? payload.cover,
                    album_id: payload.album_id ?? payload.albumId,
                    artist_id: payload.artist_id ?? payload.artistId,
                    quality: payload.quality ?? null,
                    qualityProfile: payload.qualityProfile,
                } satisfies DownloadTrackJobPayload, providerId, priority, trigger);
                break;
            }
        }
    }

    if (queuedJobId === undefined || queuedJobId < 0) {
        throw new Error(`Failed to queue a new ${mediaType} download for ${providerId}.`);
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
        } else if (downloadProcessor.isActivelyImporting(jobId)) {
            // Import is running in the background — mark as cancelled in DB.
            // The import will finish its current step but the job record
            // is already cancelled so the result won't matter.
            TaskQueueService.cancel(jobId);
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
        res.json(DownloadQueueQueryService.getQueueStatus());
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
        res.json(DownloadQueueQueryService.getQueue({ limit, offset }));
    } catch (error: any) {
        console.error('[QUEUE-API] Error getting queue:', error);
        res.status(500).json({ error: 'Failed to get queue', message: error.message });
    }
});

router.get('/queue/details', async (req: Request, res: Response) => {
    try {
        const artistId = typeof req.query.artistId === 'string'
            ? req.query.artistId.trim() || undefined
            : undefined;
        const albumIds = String(req.query.albumIds || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
        const providerIds = String(req.query.providerIds || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

        res.json(DownloadQueueQueryService.getQueueDetails({
            artistId,
            albumIds,
            providerIds,
        }));
    } catch (error: any) {
        console.error('[QUEUE-API] Error getting queue details:', error);
        res.status(500).json({ error: 'Failed to get queue details', message: error.message });
    }
});

router.get('/queue/history', async (req: Request, res: Response) => {
    try {
        const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10) || 50));
        const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
        res.json(DownloadQueueQueryService.getQueueHistory({ limit, offset }));
    } catch (error: any) {
        console.error('[QUEUE-API] Error getting queue history:', error);
        res.status(500).json({ error: 'Failed to get queue history', message: error.message });
    }
});

function getQueueRequestString(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

function getQueueRequestStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const values = value
        .map((item) => getQueueRequestString(item))
        .filter((item): item is string => item !== null);

    return values.length > 0 ? values : undefined;
}

function normalizeDownloadMediaType(value: unknown): DownloadMediaType | null {
    const normalized = getQueueRequestString(value)?.toLowerCase();
    return normalized === 'track' || normalized === 'video' || normalized === 'album'
        ? normalized
        : null;
}

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
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const url = getQueueRequestString(body.url);
        const requestedType = normalizeDownloadMediaType(body.type);
        const requestedProviderId = getQueueRequestString(body.providerId);

        const parsedUrl = url ? parseStreamingUrl(url) : null;
        const contentType = requestedType ?? parsedUrl?.type ?? 'track';
        const releaseGroupMbid = getQueueRequestString(body.releaseGroupMbid);
        let canonicalTrackMbid = getQueueRequestString(body.canonicalTrackMbid);
        const canonicalRecordingMbid = getQueueRequestString(body.canonicalRecordingMbid);
        let resolvedProviderId = requestedProviderId ?? parsedUrl?.sourceId ?? null;
        let resolvedProvider = getQueueRequestString(body.provider) ?? parsedUrl?.streamingSource ?? 'tidal';
        let resolvedSlot = getQueueRequestString(body.slot);
        let resolvedQuality = getQueueRequestString(body.quality);

        if (contentType === 'track' && resolvedProviderId && looksLikeMusicBrainzMbid(resolvedProviderId)) {
            canonicalTrackMbid ||= resolvedProviderId;
            resolvedProviderId = null;
        }

        if (contentType === 'track' && !resolvedProviderId) {
            const resolvedTrack = await resolveProviderTrackForCanonicalTrack({
                releaseGroupMbid,
                canonicalTrackMbid,
                canonicalRecordingMbid,
                provider: resolvedProvider,
                slot: resolvedSlot,
                title: getQueueRequestString(body.title),
            });
            if (!resolvedTrack) {
                return res.status(409).json({
                    error: 'Provider match missing',
                    message: 'This MusicBrainz track is not matched to a provider track yet. Refresh and curate the artist before downloading.',
                });
            }
            resolvedProvider = resolvedTrack.provider;
            resolvedProviderId = resolvedTrack.providerTrackId;
            resolvedSlot = resolvedSlot ?? resolvedTrack.slot;
            resolvedQuality = resolvedQuality ?? resolvedTrack.quality;
        }

        if (!url && !requestedProviderId && !resolvedProviderId) {
            return res.status(400).json({
                error: 'Either url, providerId, or a resolvable canonical track is required',
            });
        }

        if (!resolvedProviderId) {
            return res.status(400).json({ error: 'Unable to determine providerId' });
        }

        const payload = {
            provider: resolvedProvider,
            providerId: resolvedProviderId,
            url: url || buildStreamingMediaUrl(contentType, resolvedProviderId),
            type: contentType,
            releaseGroupMbid: releaseGroupMbid ?? undefined,
            canonicalTrackMbid: canonicalTrackMbid ?? undefined,
            canonicalRecordingMbid: canonicalRecordingMbid ?? undefined,
            slot: resolvedSlot ?? undefined,
            title: getQueueRequestString(body.title) ?? undefined,
            artist: getQueueRequestString(body.artist) ?? getQueueRequestString(body.artistName) ?? undefined,
            artists: getQueueRequestStringArray(body.artists),
            artistId: getQueueRequestString(body.artistId) ?? undefined,
            artist_id: getQueueRequestString(body.artist_id) ?? getQueueRequestString(body.artistId) ?? undefined,
            albumId: getQueueRequestString(body.albumId) ?? getQueueRequestString(body.releaseGroupMbid) ?? undefined,
            album_id: getQueueRequestString(body.album_id) ?? getQueueRequestString(body.albumId) ?? getQueueRequestString(body.releaseGroupMbid) ?? undefined,
            albumTitle: getQueueRequestString(body.albumTitle) ?? undefined,
            album_title: getQueueRequestString(body.album_title) ?? getQueueRequestString(body.albumTitle) ?? undefined,
            cover: getQueueRequestString(body.cover) ?? undefined,
            quality: resolvedQuality,
            description: getQueueRequestString(body.description) ?? undefined,
        };

        const queueRefId = contentType === 'album' && payload.releaseGroupMbid && payload.slot
            ? `${payload.releaseGroupMbid}:${payload.slot}`
            : resolvedProviderId;
        let jobId: number;
        if (contentType === 'album') {
            jobId = TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                ...payload,
                type: 'album',
            } satisfies DownloadAlbumJobPayload, queueRefId);
        } else if (contentType === 'video') {
            jobId = TaskQueueService.addJob(JobTypes.DownloadVideo, {
                ...payload,
                type: 'video',
            } satisfies DownloadVideoJobPayload, queueRefId);
        } else {
            jobId = TaskQueueService.addJob(JobTypes.DownloadTrack, {
                ...payload,
                type: 'track',
            } satisfies DownloadTrackJobPayload, queueRefId);
        }


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
    sendEvent('status', DownloadQueueQueryService.getQueueStatus());

    const initialProgress = DownloadQueueQueryService.getActiveProgressSnapshots();
    if (initialProgress.length > 0) {
        sendEvent('progress-batch', initialProgress);
    }

    // Listen for download events
    const onProgressBatch = (data: any) => sendEvent('progress-batch', data);
    const onStarted = (data: any) => sendEvent('started', data);
    const onCompleted = (data: any) => sendEvent('completed', data);
    const onFailed = (data: any) => sendEvent('failed', data);
    const onQueueStatus = (data: any) => sendEvent('queue-status', data);

    downloadEvents.on('progress-batch', onProgressBatch);
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
        downloadEvents.off('progress-batch', onProgressBatch);
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
            JobTypes.ImportDownload,
        ]);
        res.json({ message: 'Finished download jobs cleared' });
    } catch (error: any) {
        console.error('[QUEUE-API] Error clearing completed:', error);
        res.status(500).json({ error: 'Failed to clear completed', message: error.message });
    }
});

export default router;
