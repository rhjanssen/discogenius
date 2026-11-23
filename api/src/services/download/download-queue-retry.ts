import { db } from "../../database.js";
import { CommandTrigger } from "../commands/command-trigger.js";
import {
  CommandNames,
  isDownloadOrImportJobType,
  type CommandName,
} from "../commands/command-names.js";
import type { CommandModel } from "../commands/command-model.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { downloadProcessor } from "./download-processor.js";
import { DownloadWaitQueue, type DownloadWaitMediaKind } from "./download-wait-queue.js";
import { shouldQueueRedownloadForFailedImport } from "./download-recovery.js";
import { buildStreamingMediaUrl } from "./download-routing.js";
import type { ImportDownloadCommand } from "../commands/command-bodies.js";

export type DownloadRetryResult = {
  status: 200 | 404 | 409 | 422;
  body: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mediaKindFromJob(job: CommandModel): DownloadWaitMediaKind | null {
  if (job.name === CommandNames.DownloadAlbum) return "album";
  if (job.name === CommandNames.DownloadVideo) return "video";
  if (job.name === CommandNames.DownloadTrack) return "track";
  if (job.name === CommandNames.ImportDownload) {
    const kind = optionalString(asRecord(job.payload).type);
    if (kind === "album" || kind === "track" || kind === "video") return kind;
  }
  return null;
}

function commandNameForKind(kind: DownloadWaitMediaKind): typeof CommandNames.DownloadAlbum
  | typeof CommandNames.DownloadTrack
  | typeof CommandNames.DownloadVideo {
  if (kind === "video") return CommandNames.DownloadVideo;
  if (kind === "album") return CommandNames.DownloadAlbum;
  return CommandNames.DownloadTrack;
}

function hasFailedDownloadState(job: CommandModel): boolean {
  const payload = asRecord(job.payload);
  const downloadState = asRecord(payload.downloadState);
  return downloadState.state === "failed" || downloadState.state === "importFailed";
}

function enqueueWaitFromJob(job: CommandModel, position: "front" | "back" = "front"): DownloadRetryResult {
  const payload = asRecord(job.payload);
  const resolved = asRecord(payload.resolved);
  const kind = mediaKindFromJob(job);
  const provider = optionalString(payload.provider);
  const providerId = optionalString(payload.providerId)
    ?? optionalString(job.ref_id)
    ?? optionalString(resolved.providerId);
  if (!kind || !providerId) {
    return {
      status: 422,
      body: {
        error: "Job cannot be retried",
        message: `Job ${job.id} is missing the media type or provider ID needed to queue a download.`,
      },
    };
  }

  const slot = optionalString(payload.slot) ?? optionalString(payload.librarySlot);
  const releaseGroupMbid = optionalString(payload.releaseGroupMbid);
  const refKey = optionalString(job.ref_id)
    ?? (kind === "album" && releaseGroupMbid && slot ? `${releaseGroupMbid}:${slot}` : providerId);

  const rawPlanId = Number(payload.acquisitionPlanId ?? payload.planId);
  const planId = Number.isInteger(rawPlanId) && rawPlanId > 0
    && Boolean(db.prepare("SELECT 1 FROM AcquisitionPlans WHERE id = ?").get(rawPlanId))
    ? rawPlanId
    : null;
  const trackIds = Array.isArray(payload.trackIds)
    ? payload.trackIds
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
    : undefined;

  const {
    downloadState: _downloadState,
    downloadImportHandoff: _downloadImportHandoff,
    authHold: _authHold,
    failedProvider: _failedProvider,
    progress: _progress,
    currentTrack: _currentTrack,
    ...cleanPayload
  } = payload;

  const retryPayload = {
    ...cleanPayload,
    provider: provider ?? undefined,
    providerId,
    url: optionalString(payload.url) ?? buildStreamingMediaUrl(kind, providerId, provider ?? undefined),
    type: kind,
    title: optionalString(payload.title) ?? optionalString(resolved.title),
    artist: optionalString(payload.artist) ?? optionalString(resolved.artist),
    cover: optionalString(payload.cover) ?? optionalString(resolved.cover),
    album_id: optionalString(payload.album_id) ?? optionalString(payload.albumId) ?? optionalString(resolved.albumId),
    artist_id: optionalString(payload.artist_id) ?? optionalString(payload.artistId) ?? optionalString(resolved.artistId),
    quality: optionalString(payload.quality),
  };

  const queued = DownloadWaitQueue.enqueue({
    refKey,
    mediaKind: kind,
    commandName: commandNameForKind(kind),
    planId,
    trackIds: trackIds && trackIds.length > 0 ? trackIds : undefined,
    provider,
    providerId,
    artistId: retryPayload.artist_id,
    albumId: retryPayload.album_id,
    title: retryPayload.title,
    artist: retryPayload.artist,
    cover: retryPayload.cover,
    quality: retryPayload.quality,
    slot,
    payload: retryPayload,
    priority: job.priority,
    trigger: CommandTrigger.Manual,
    position,
  });

  downloadProcessor.processQueue().catch((err) => {
    console.error("[QUEUE-API] Error triggering queue processing:", err);
  });

  return {
    status: 200,
    body: {
      action: job.name === CommandNames.ImportDownload ? "queue-redownload" : "retry-download",
      message: queued.created
        ? (job.name === CommandNames.ImportDownload
          ? "Re-download queued to recover the failed import"
          : "Download queued")
        : (queued.commandId
          ? "Download already in progress for this item"
          : "Download already queued for this item"),
      jobId: queued.id,
      commandId: queued.id,
      sourceJobId: job.id,
    },
  };
}

function retryExistingWait(waitId: number, commandId: number | null): DownloadRetryResult {
  if (commandId == null) {
    downloadProcessor.processQueue().catch((err) => {
      console.error("[QUEUE-API] Error triggering queue processing:", err);
    });
    return {
      status: 200,
      body: {
        action: "retry-download",
        message: "Download already queued",
        jobId: waitId,
      },
    };
  }

  const job = CommandQueueManager.get(commandId);
  if (!job) {
    DownloadWaitQueue.remove(waitId);
    return { status: 404, body: { error: "Job not found", message: `Download job ${commandId} no longer exists.` } };
  }

  if (job.status === "started" && !hasFailedDownloadState(job) && downloadProcessor.isActivelyProcessingJob(commandId)) {
    return {
      status: 409,
      body: {
        error: "Job is processing",
        message: "Wait for the active download to finish or cancel it before retrying",
      },
    };
  }

  if (shouldQueueRedownloadForFailedImport(job)) {
    DownloadWaitQueue.remove(waitId);
    return enqueueWaitFromJob(job);
  }

  CommandQueueManager.retry(commandId);
  downloadProcessor.processQueue().catch((err) => {
    console.error("[QUEUE-API] Error triggering queue processing:", err);
  });
  return {
    status: 200,
    body: {
      action: job.name === CommandNames.ImportDownload ? "retry-import" : "retry-download",
      message: job.name === CommandNames.ImportDownload ? "Import queued for retry" : "Download queued for retry",
      jobId: waitId,
    },
  };
}

/**
 * Retry identifies the ID namespace explicitly: a wait row or a history command.
 * History rows survive after finishClaimed deletes the wait row, so a command
 * id with no wait row re-enqueues a new wait item from the failed payload.
 */
export function retryDownloadQueueItem(id: number, source: "queue" | "history" = "queue"): DownloadRetryResult {
  const wait = source === "history" ? DownloadWaitQueue.getByCommandId(id) : DownloadWaitQueue.get(id);
  if (wait) {
    return retryExistingWait(wait.id, wait.command_id);
  }

  if (source === "queue") {
    return { status: 404, body: { error: "Queue item not found", message: `Queue item ${id} is no longer waiting.` } };
  }

  const job = CommandQueueManager.get(id);
  if (!job || !isDownloadOrImportJobType(job.name as CommandName)) {
    return { status: 404, body: { error: "Job not found", message: `Download job ${id} no longer exists.` } };
  }

  return enqueueWaitFromJob(job);
}
