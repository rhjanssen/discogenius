import { buildStreamingMediaUrl } from "./download-routing.js";
import { getConfigSection } from "./config.js";
import type {
  DownloadAlbumJobPayload,
  DownloadTrackJobPayload,
  DownloadVideoJobPayload,
} from "./job-payloads.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import {
  WantedQueryService,
  type WantedItem,
} from "./wanted-query-service.js";

export interface QueueWantedItemsOptions {
  artistId?: string;
  includeVideos?: boolean;
  priority?: number;
  trigger?: number;
  batchSize?: number;
}

export interface QueueWantedItemsResult {
  albums: number;
  tracks: number;
  videos: number;
}

const DEFAULT_BATCH_SIZE = 500;

export class WantedQueueService {
  static queueWantedItems(options: QueueWantedItemsOptions = {}): QueueWantedItemsResult {
    const includeVideos = options.includeVideos ?? getConfigSection("filtering")?.include_videos !== false;
    const batchSize = clampBatchSize(options.batchSize);
    const counts: QueueWantedItemsResult = { albums: 0, tracks: 0, videos: 0 };
    let offset = 0;

    while (true) {
      const page = WantedQueryService.listWanted({
        artistId: options.artistId,
        limit: batchSize,
        offset,
      });

      if (page.items.length === 0) {
        break;
      }

      for (const item of page.items) {
        if (item.queueStatus !== "missing") {
          continue;
        }

        if (item.type === "video" && !includeVideos) {
          continue;
        }

        const jobId = queueWantedItem(item, {
          priority: options.priority,
          trigger: options.trigger,
        });

        if (jobId <= 0) {
          continue;
        }

        if (item.type === "album") counts.albums++;
        if (item.type === "track") counts.tracks++;
        if (item.type === "video") counts.videos++;
      }

      offset += page.items.length;
      if (offset >= page.total) {
        break;
      }
    }

    return counts;
  }
}

function clampBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(500, Math.max(1, Math.floor(value)));
}

function queueWantedItem(
  item: WantedItem,
  options: Pick<QueueWantedItemsOptions, "priority" | "trigger">,
): number {
  switch (item.type) {
    case "album":
      return TaskQueueService.addJob(
        JobTypes.DownloadAlbum,
        buildAlbumPayload(item),
        item.sourceId,
        options.priority ?? 0,
        options.trigger ?? 0,
      );
    case "track":
      return TaskQueueService.addJob(
        JobTypes.DownloadTrack,
        buildTrackPayload(item),
        item.sourceId,
        options.priority ?? 0,
        options.trigger ?? 0,
      );
    case "video":
      return TaskQueueService.addJob(
        JobTypes.DownloadVideo,
        buildVideoPayload(item),
        item.sourceId,
        options.priority ?? 0,
        options.trigger ?? 0,
      );
  }
}

function buildCommonPayload(item: WantedItem) {
  const artist = item.artistName || "Unknown";
  const title = item.title || "Unknown";

  return {
    url: buildStreamingMediaUrl(item.type, item.sourceId),
    tidalId: item.sourceId,
    title,
    artist,
    cover: item.cover || null,
    quality: item.quality || null,
    artists: artist === "Unknown" ? [] : [artist],
  };
}

function buildTrackPayload(item: WantedItem): DownloadTrackJobPayload {
  const common = buildCommonPayload(item);
  const title = common.title || "Unknown";
  const artist = common.artist || "Unknown";

  return {
    ...common,
    type: "track",
    albumId: item.albumId || undefined,
    albumTitle: item.albumTitle || undefined,
    description: item.albumTitle
      ? `${title} on ${item.albumTitle} by ${artist}`
      : `${title} by ${artist}`,
  };
}

function buildVideoPayload(item: WantedItem): DownloadVideoJobPayload {
  const common = buildCommonPayload(item);
  const title = common.title || "Unknown";
  const artist = common.artist || "Unknown";

  return {
    ...common,
    type: "video",
    description: `${title} by ${artist}`,
  };
}

function buildAlbumPayload(item: WantedItem): DownloadAlbumJobPayload {
  const common = buildCommonPayload(item);
  const title = common.title || "Unknown";
  const artist = common.artist || "Unknown";

  return {
    ...common,
    type: "album",
    albumId: item.albumId || item.sourceId,
    albumTitle: item.albumTitle || title,
    description: `${title} by ${artist}`,
  };
}
