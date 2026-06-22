import { CommandTrigger } from "../../services/commands/command-trigger.js";
import express, { Request, Response, Router } from 'express';
import {AnyCommandBody, CommandStatus} from "../../services/commands/command-model.js";
import {DOWNLOAD_COMMAND_NAMES, NON_DOWNLOAD_COMMAND_NAMES, CommandNames, CommandName} from "../../services/commands/command-names.js";
import {CommandQueueManager} from "../../services/commands/command-queue-manager.js";
import { downloadProcessor } from '../../services/download/download-processor.js';
import { downloadEvents } from '../../services/download/download-events.js';
import { authMiddleware } from '../../middleware/auth.js';
import { buildStreamingMediaUrl, parseStreamingUrl, type DownloadMediaType } from '../../services/download/download-routing.js';
import { shouldQueueRedownloadForFailedImport } from '../../services/download/download-recovery.js';
import { DownloadQueueQueryService } from '../../services/download/download-queue-query-service.js';
import { looksLikeMusicBrainzMbid, resolveProviderTrackForCanonicalTrack } from '../../services/metadata/provider-track-resolver.js';
import { CurationService } from '../../services/music/curation-service.js';
import { ACTIVITY_FILTERS, getActivityPage } from '../../services/commands/command-history.js';
import { getCommandTypesForQueueCategory, type CommandQueueCategory } from '../../services/commands/command-registry.js';
import { parseActivityFilters, parseListPagination } from '../../utils/activity-query.js';
import {
  getObjectBody,
  getOptionalIdentifier,
  getOptionalInteger,
  getRequiredIdentifier,
  isRequestValidationError,
} from '../../utils/request-validation.js';
import type {
  DownloadAlbumCommand,
  DownloadTrackCommand,
  DownloadVideoCommand,
  ImportDownloadCommand,
} from '../../services/commands/command-bodies.js';

const router: Router = express.Router();

// All queue routes require authentication
router.use(authMiddleware);

// --- HELPER FUNCTIONS ---
function buildRetryResponse(jobType: string, message?: string) {
  return {
    action: jobType === CommandNames.ImportDownload ? 'retry-import' : 'retry-download',
    message: message || (jobType === CommandNames.ImportDownload ? 'Import queued for retry' : 'Download queued for retry'),
  };
}

function queueRedownloadForImport(commandId: number, payload: ImportDownloadCommand, priority: number, trigger: number) {
  const mediaType = payload.type;
  const providerId = payload.providerId;
  if (!mediaType || !providerId) {
    throw new Error('Import retry is missing the media type or provider ID needed to queue a re-download.');
  }
  if (mediaType !== 'track' && mediaType !== 'video' && mediaType !== 'album') {
    throw new Error(`Import retry has unsupported media type: ${mediaType}`);
  }

  const url = buildStreamingMediaUrl(mediaType, providerId);
  const existingJob = CommandQueueManager.getByRefId(
    providerId,
    mediaType === 'video'
      ? CommandNames.DownloadVideo
      : mediaType === 'album'
        ? CommandNames.DownloadAlbum
        : CommandNames.DownloadTrack,
  );

  let queuedJobId = existingJob?.id;

  if (queuedJobId === undefined) {
    switch (mediaType) {
      case 'album': {
        queuedJobId = CommandQueueManager.push(CommandNames.DownloadAlbum, {
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
        } satisfies DownloadAlbumCommand, providerId, priority, trigger);
        break;
      }
      case 'video': {
        queuedJobId = CommandQueueManager.push(CommandNames.DownloadVideo, {
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
        } satisfies DownloadVideoCommand, providerId, priority, trigger);
        break;
      }
      case 'track':
      default: {
        queuedJobId = CommandQueueManager.push(CommandNames.DownloadTrack, {
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
        } satisfies DownloadTrackCommand, providerId, priority, trigger);
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
      ? (existingJob.status === 'started' ? 'Download already in progress for this item' : 'Download already queued for this item')
      : 'Re-download queued to recover the failed import',
    commandId: queuedJobId,
    sourceJobId: commandId,
  };
}

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

// --- ACTIVE DOWNLOAD QUEUE ENDPOINTS ---

/**
 * GET /api/v1/queue
 * List all active download queue items
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '100'), 10) || 100));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
    res.json(DownloadQueueQueryService.getQueue({ limit, offset }));
  } catch (error: any) {
    console.error('[QUEUE-API] Error getting queue:', error);
    res.status(500).json({ error: 'Failed to get queue', message: error.message });
  }
});

/**
 * POST /api/v1/queue
 * Add a new item to the download queue
 */
router.post('/', async (req: Request, res: Response) => {
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
          error: 'provider match missing',
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
    let commandId: number;
    if (contentType === 'album') {
      commandId = CommandQueueManager.push(CommandNames.DownloadAlbum, {
        ...payload,
        type: 'album',
      } satisfies DownloadAlbumCommand, queueRefId);
    } else if (contentType === 'video') {
      commandId = CommandQueueManager.push(CommandNames.DownloadVideo, {
        ...payload,
        type: 'video',
      } satisfies DownloadVideoCommand, queueRefId);
    } else {
      commandId = CommandQueueManager.push(CommandNames.DownloadTrack, {
        ...payload,
        type: 'track',
      } satisfies DownloadTrackCommand, queueRefId);
    }

    // Trigger queue processing if not already running
    downloadProcessor.processQueue().catch(err => {
      console.error('[QUEUE-API] Error triggering queue processing:', err);
    });

    res.json({ id: commandId, message: 'Added to download queue' });
  } catch (error: any) {
    console.error('[QUEUE-API] Error adding to queue:', error);
    res.status(500).json({ error: 'Failed to add to queue', message: error.message });
  }
});

/**
 * DELETE /api/v1/queue/:id
 * Delete/cancel a specific queue item
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const commandId = parseInt(String(id), 10);

    if (isNaN(commandId)) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }

    const job = CommandQueueManager.get(commandId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status === 'started' || downloadProcessor.isActivelyProcessingJob(commandId)) {
      return res.status(409).json({
        error: 'Job is processing',
        message: 'Pause or cancel the active download before deleting this queue item',
      });
    }

    CommandQueueManager.deleteCommand(commandId);
    res.json({ message: 'Job deleted' });
  } catch (error: any) {
    console.error('[QUEUE-API] Error deleting job:', error);
    res.status(500).json({ error: 'Failed to delete job', message: error.message });
  }
});

/**
 * POST /api/v1/queue/:id/retry
 * Retry a failed download queue item
 */
router.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const commandId = parseInt(String(id), 10);

    if (isNaN(commandId)) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }

    const job = CommandQueueManager.get(commandId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status === 'started' || downloadProcessor.isActivelyProcessingJob(commandId)) {
      return res.status(409).json({
        error: 'Job is processing',
        message: 'Wait for the active download to finish or cancel it before retrying',
      });
    }

    if (shouldQueueRedownloadForFailedImport(job)) {
      return res.json(queueRedownloadForImport(job.id, job.payload as ImportDownloadCommand, job.priority, job.trigger ?? CommandTrigger.Unspecified));
    }

    CommandQueueManager.retry(commandId);

    // Trigger queue processing
    downloadProcessor.processQueue().catch(err => {
      console.error('[QUEUE-API] Error triggering queue processing:', err);
    });

    res.json(buildRetryResponse(job.name));
  } catch (error: any) {
    console.error('[QUEUE-API] Error retrying job:', error);
    res.status(500).json({ error: 'Failed to retry job', message: error.message });
  }
});

/**
 * GET /api/v1/queue/status
 * Get active download queue status (isPaused, processing, currentItem)
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json(DownloadQueueQueryService.getQueueStatus());
  } catch (error: any) {
    console.error('[QUEUE-API] Error getting status:', error);
    res.status(500).json({ error: 'Failed to get status', message: error.message });
  }
});

/**
 * GET /api/v1/queue/details
 * Get download queue details for specific artists/albums
 */
router.get('/details', async (req: Request, res: Response) => {
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

/**
 * GET /api/v1/queue/history
 * Get history of finished download items
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
    res.json(DownloadQueueQueryService.getQueueHistory({ limit, offset }));
  } catch (error: any) {
    console.error('[QUEUE-API] Error getting queue history:', error);
    res.status(500).json({ error: 'Failed to get queue history', message: error.message });
  }
});

/**
 * POST /api/v1/queue/reorder
 * Reorder pending download items in the queue
 */
router.post('/reorder', async (req: Request, res: Response) => {
  try {
    const rawJobIds: unknown[] = Array.isArray(req.body?.commandIds) ? req.body.commandIds : [];
    const parsedJobIds = rawJobIds.map((value: unknown) => parseInt(String(value), 10));

    if (parsedJobIds.some((value) => !Number.isInteger(value) || value <= 0)) {
      return res.status(400).json({
        error: 'Invalid reorder set',
        message: 'commandIds must contain only positive integer ids',
      });
    }

    const distinctJobIds = Array.from(new Set(parsedJobIds));
    if (distinctJobIds.length !== parsedJobIds.length) {
      return res.status(400).json({
        error: 'Invalid reorder set',
        message: 'commandIds must not contain duplicate ids',
      });
    }

    const commandIds = distinctJobIds;
    const beforeJobId = req.body?.beforeJobId == null ? undefined : parseInt(String(req.body.beforeJobId), 10);
    const afterJobId = req.body?.afterJobId == null ? undefined : parseInt(String(req.body.afterJobId), 10);

    if (commandIds.length === 0) {
      return res.status(400).json({ error: 'Missing queue items', message: 'commandIds must contain one or more pending queue item ids' });
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

    CommandQueueManager.reorderPendingJobs(commandIds, {
      beforeJobId,
      afterJobId,
      types: DOWNLOAD_COMMAND_NAMES,
    });

    res.json({ message: 'Queue reordered' });
  } catch (error: any) {
    console.error('[QUEUE-API] Error reordering queue:', error);
    res.status(409).json({ error: 'Failed to reorder queue', message: error.message });
  }
});

/**
 * POST /api/v1/queue/clear-completed
 * Clear all completed download queue items
 */
router.post('/clear-completed', async (_req: Request, res: Response) => {
  try {
    CommandQueueManager.clearFinishedByTypes([
      CommandNames.DownloadAlbum,
      CommandNames.DownloadTrack,
      CommandNames.DownloadVideo,
      CommandNames.ImportDownload,
    ]);
    res.json({ message: 'Finished download jobs cleared' });
  } catch (error: any) {
    console.error('[QUEUE-API] Error clearing completed:', error);
    res.status(500).json({ error: 'Failed to clear completed', message: error.message });
  }
});

/**
 * POST /api/v1/queue/pause
 * Pause download queue execution
 */
router.post('/pause', async (_req: Request, res: Response) => {
  try {
    await downloadProcessor.pause();
    res.sendStatus(204);
  } catch (error: any) {
    console.error('[QUEUE-API] Error pausing queue:', error);
    res.status(500).json({ error: 'Failed to pause queue', message: error.message });
  }
});

/**
 * POST /api/v1/queue/resume
 * Resume download queue execution
 */
router.post('/resume', async (_req: Request, res: Response) => {
  try {
    await downloadProcessor.resume();
    res.sendStatus(204);
  } catch (error: any) {
    console.error('[QUEUE-API] Error resuming queue:', error);
    res.status(500).json({ error: 'Failed to resume queue', message: error.message });
  }
});

/**
 * GET /api/v1/queue/progress-stream
 * SSE endpoint for real-time progress updates
 */
router.get('/progress-stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('status', DownloadQueueQueryService.getQueueStatus());

  const initialProgress = DownloadQueueQueryService.getActiveProgressSnapshots();
  if (initialProgress.length > 0) {
    sendEvent('progress-batch', initialProgress);
  }

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

  const heartbeat = setInterval(() => {
    sendEvent('heartbeat', { timestamp: Date.now() });
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    downloadEvents.off('progress-batch', onProgressBatch);
    downloadEvents.off('started', onStarted);
    downloadEvents.off('completed', onCompleted);
    downloadEvents.off('failed', onFailed);
    downloadEvents.off('queue-status', onQueueStatus);
  });
});

// --- LEGACY/CONVENIENCE DOWNLOAD DELETION ROUTES ---

/**
 * DELETE /api/v1/queue/remove
 * Cancel/Remove item from queue
 */
router.delete('/remove', async (req: Request, res: Response) => {
  try {
    const { id } = req.body;

    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid request', message: 'id must be a positive integer job ID' });
    }

    const commandId: number = id;
    const jobExists = CommandQueueManager.get(commandId);
    if (!jobExists) {
      return res.status(404).json({ error: 'Not found', message: 'Job not found in queue' });
    }

    const status = downloadProcessor.getStatus();
    if (status.currentJobId === commandId) {
      await downloadProcessor.pause();
      CommandQueueManager.cancel(commandId);
      await downloadProcessor.resume();
    } else if (downloadProcessor.isActivelyImporting(commandId)) {
      CommandQueueManager.cancel(commandId);
    } else {
      CommandQueueManager.cancel(commandId);
    }

    res.sendStatus(204);
  } catch (error: any) {
    console.error('[QUEUE-API] Error removing from queue:', error);
    res.status(500).json({ error: 'Failed to remove from queue', message: error.message });
  }
});

/**
 * DELETE /api/v1/queue/remove-all
 * Clear entire download queue
 */
router.delete('/remove-all', async (_req: Request, res: Response) => {
  try {
    CommandQueueManager.clearDownloadJobs();
    res.sendStatus(204);
  } catch (error: any) {
    console.error('[QUEUE-API] Error clearing queue:', error);
    res.status(500).json({ error: 'Failed to clear queue', message: error.message });
  }
});

/**
 * DELETE /api/v1/queue/remove-finished
 * Remove all finished/failed download items
 */
router.delete('/remove-finished', async (_req: Request, res: Response) => {
  try {
    CommandQueueManager.clearFinishedByTypes([
      CommandNames.DownloadAlbum,
      CommandNames.DownloadTrack,
      CommandNames.DownloadVideo,
      CommandNames.ImportDownload,
    ]);
    res.sendStatus(204);
  } catch (error: any) {
    console.error('[QUEUE-API] Error clearing finished:', error);
    res.status(500).json({ error: 'Failed to clear finished items', message: error.message });
  }
});


// --- TASK QUEUE ENDPOINTS (NON-DOWNLOAD COMMANDS) ---
const allowedJobTypes = new Set<string>(NON_DOWNLOAD_COMMAND_NAMES);
const defaultTaskStatuses: readonly CommandStatus[] = ['queued', 'started', 'completed', 'failed', 'cancelled'];
const taskCategories: readonly CommandQueueCategory[] = ['scans', 'other'];

function normalizeTaskStatusFilterValue(status: string): string {
  return status === 'running' ? 'processing' : status;
}

/**
 * GET /api/v1/queue/tasks
 * Get task queue items
 */
router.get('/tasks', (req: Request, res: Response) => {
  const { limit, offset } = parseListPagination(req.query as Record<string, unknown>);

  const filtersResult = parseActivityFilters({
    query: req.query as Record<string, unknown>,
    defaultStatuses: defaultTaskStatuses,
    defaultCategories: taskCategories,
    allowedStatuses: ACTIVITY_FILTERS.statuses,
    allowedCategories: taskCategories,
    unsupportedLabel: 'task',
    normalizeStatus: normalizeTaskStatusFilterValue,
    getSupportedTypes: (categories) => categories.flatMap((category) => getCommandTypesForQueueCategory(category)),
    isTypeAllowed: (type) => allowedJobTypes.has(type),
  });

  if ('error' in filtersResult) {
    return res.status(400).json(filtersResult.error);
  }

  const { statuses, categories, types } = filtersResult.value;

  const page = getActivityPage({
    limit,
    offset,
    statuses: statuses as Array<(typeof ACTIVITY_FILTERS.statuses)[number]>,
    categories,
    types,
  });

  return res.json({
    items: page.items,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
  });
});

/**
 * POST /api/v1/queue/tasks/add (or POST /api/v1/queue/tasks)
 * Add non-download task to queue
 */
router.post('/tasks/add', (req: Request, res: Response) => {
  try {
    const body = getObjectBody(req.body);
    const type = getRequiredIdentifier(body, 'type');
    if (!allowedJobTypes.has(type)) {
      return res.status(400).json({ error: 'Unsupported job type' });
    }

    const payload = getObjectBody(body.payload, 'payload must be a JSON object');
    const priority = getOptionalInteger(body, 'priority') ?? 0;
    const refId = getOptionalIdentifier(body, 'ref_id');

    const id = CommandQueueManager.push(type as CommandName, payload as AnyCommandBody, refId, priority);
    res.json({ id, message: 'Task added' });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// Alias POST /api/v1/queue/tasks to POST /api/v1/queue/tasks/add
router.post('/tasks', (req: Request, res: Response) => {
  try {
    const body = getObjectBody(req.body);
    const type = getRequiredIdentifier(body, 'type');
    if (!allowedJobTypes.has(type)) {
      return res.status(400).json({ error: 'Unsupported job type' });
    }

    const payload = getObjectBody(body.payload, 'payload must be a JSON object');
    const priority = getOptionalInteger(body, 'priority') ?? 0;
    const refId = getOptionalIdentifier(body, 'ref_id');

    const id = CommandQueueManager.push(type as CommandName, payload as AnyCommandBody, refId, priority);
    res.json({ id, message: 'Task added' });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/v1/queue/tasks/clear-completed
 * Clear completed non-download tasks
 */
router.post('/tasks/clear-completed', (_req: Request, res: Response) => {
  CommandQueueManager.clearFinishedByTypes([...NON_DOWNLOAD_COMMAND_NAMES]);
  res.json({ message: 'Completed tasks cleared' });
});

/**
 * POST /api/v1/queue/tasks/:id/retry
 * Retry a failed non-download task
 */
router.post('/tasks/:id/retry', (req: Request, res: Response) => {
  const { id } = req.params;
  const commandId = parseInt(String(id), 10);
  if (Number.isNaN(commandId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = CommandQueueManager.get(commandId);
  if (!job) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!allowedJobTypes.has(job.name)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (job.status === 'started') {
    return res.status(409).json({ error: 'Task is processing' });
  }

  CommandQueueManager.retry(commandId);
  res.json({ message: 'Task retried' });
});

/**
 * DELETE /api/v1/queue/tasks/:id
 * Cancel a specific non-download task
 */
router.delete('/tasks/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const commandId = parseInt(String(id), 10);
  if (Number.isNaN(commandId)) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  const job = CommandQueueManager.get(commandId);
  if (!job) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!allowedJobTypes.has(job.name)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (job.status === 'started') {
    return res.status(409).json({ error: 'Task is processing' });
  }

  CommandQueueManager.cancel(commandId);
  res.json({ message: 'Task cancelled' });
});

/**
 * POST /api/v1/queue/tasks/process-monitored
 * Process monitored items (curation workflow trigger)
 */
router.post('/tasks/process-monitored', async (req: Request, res: Response) => {
  try {
    const body = getObjectBody(req.body ?? {});
    const artistId = getOptionalIdentifier(body, 'artistId');
    const queued = await CurationService.queueMonitoredItems(artistId);
    const count = queued.albums + queued.tracks + queued.videos;
    res.json({
      message: `Added ${count} item(s) to download queue (${queued.albums} albums, ${queued.tracks} tracks, ${queued.videos} videos)`,
      count,
      ...queued,
    });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
