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
  status: 200 | 404 | 409;
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

function enqueueWaitFromJob(job: CommandModel, position: "front" | "back" = "front") {
  const payload = asRecord(job.payload);
  const resolved = asRecord(payload.resolved);
  const kind = mediaKindFromJob(job);
  const providerId = optionalString(payload.providerId)
    ?? optionalString(job.ref_id)
    ?? optionalString(resolved.providerId);
  if (!kind || !providerId) {
    throw new Error("Retry is missing the media type or provider ID needed to queue a download.");
  }

  const retryPayload = {
    ...payload,
    providerId,
    url: optionalString(payload.url) ?? buildStreamingMediaUrl(kind, providerId),
    type: kind,
    title: optionalString(payload.title) ?? optionalString(resolved.title),
    artist: optionalString(payload.artist) ?? optionalString(resolved.artist),
    cover: optionalString(payload.cover) ?? optionalString(resolved.cover),
    album_id: optionalString(payload.album_id) ?? optionalString(payload.albumId) ?? optionalString(resolved.albumId),
    artist_id: optionalString(payload.artist_id) ?? optionalString(payload.artistId) ?? optionalString(resolved.artistId),
    quality: optionalString(payload.quality),
  };

  const queued = DownloadWaitQueue.enqueue({
    refKey: providerId,
    mediaKind: kind,
    commandName: commandNameForKind(kind),
    provider: optionalString(payload.provider),
    providerId,
    artistId: retryPayload.artist_id,
    albumId: retryPayload.album_id,
    title: retryPayload.title,
    artist: retryPayload.artist,
    cover: retryPayload.cover,
    quality: retryPayload.quality,
    slot: optionalString(payload.slot) ?? optionalString(payload.librarySlot),
    payload: retryPayload,
    priority: job.priority,
    trigger: job.trigger ?? CommandTrigger.Unspecified,
    position,
  });

  downloadProcessor.processQueue().catch((err) => {
    console.error("[QUEUE-API] Error triggering queue processing:", err);
  });

  return {
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
    return { status: 404, body: { error: "Job not found" } };
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
    return {
      status: 200,
      body: enqueueWaitFromJob(job),
    };
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
 * Retry accepts either a wait-row id (live queue) or a command id (history).
 * History rows survive after finishClaimed deletes the wait row, so a command
 * id with no wait row re-enqueues a new wait item from the failed payload.
 */
export function retryDownloadQueueItem(id: number): DownloadRetryResult {
  const wait = DownloadWaitQueue.get(id) ?? DownloadWaitQueue.getByCommandId(id);
  if (wait) {
    return retryExistingWait(wait.id, wait.command_id);
  }

  const job = CommandQueueManager.get(id);
  if (!job || !isDownloadOrImportJobType(job.name as CommandName)) {
    return { status: 404, body: { error: "Job not found" } };
  }

  try {
    return { status: 200, body: enqueueWaitFromJob(job) };
  } catch (error) {
    return {
      status: 404,
      body: {
        error: "Job not found",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
