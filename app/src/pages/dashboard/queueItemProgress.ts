import type { QueueItemContract as QueueItem, DownloadProgressContract as DownloadProgress } from "@contracts/status";

function getLiveQueueItemStatus(progress: DownloadProgress): QueueItem["status"] {
    switch (progress.state) {
        case "failed":
        case "importFailed":
            return "failed";
        case "queued":
            return "queued";
        case "importPending":
        case "importing":
            return "started";
        case "completed":
            return "completed";
        default:
            return "downloading";
    }
}

function getLiveQueueItemStage(progress: DownloadProgress): QueueItem["stage"] | undefined {
    switch (progress.state) {
        case "importPending":
        case "importing":
        case "importFailed":
            return "import";
        case "queued":
        case "downloading":
        case "failed":
        case "paused":
            return "download";
        default:
            return undefined;
    }
}

function isPlaceholderQueueLabel(value: unknown): boolean {
    const text = String(value || "").trim().toLowerCase();
    return !text
        || text === "unknown"
        || text === "unknown track"
        || text === "unknown video"
        || text === "unknown album"
        || text === "unknown item";
}

function preferQueueLabel(progressValue: unknown, itemValue: unknown): string | undefined {
    const progressText = typeof progressValue === "string" ? progressValue : progressValue == null ? undefined : String(progressValue);
    const itemText = typeof itemValue === "string" ? itemValue : itemValue == null ? undefined : String(itemValue);
    if (!isPlaceholderQueueLabel(progressText)) return progressText;
    if (!isPlaceholderQueueLabel(itemText)) return itemText;
    return progressText ?? itemText;
}

function preferQueueCover(progressCover: unknown, itemCover: unknown): string | null {
    const progressText = typeof progressCover === "string" ? progressCover.trim() : "";
    const itemText = typeof itemCover === "string" ? itemCover.trim() : "";
    if (progressText) return progressText;
    if (itemText) return itemText;
    return null;
}

export function mergeQueueItemsWithProgress(
    downloadQueue: QueueItem[],
    progressByJobId: Map<number, DownloadProgress>,
): QueueItem[] {
    const mergedQueue = downloadQueue.map((item) => {
        const progress = progressByJobId.get(item.id);
        if (!progress) {
            return item;
        }

        // Server is authoritative for clean queued rows. Client progress can linger
        // after a requeue that stripped downloadState, which otherwise resurrects
        // tracklists / "downloading" chrome on items that are only waiting.
        const serverIsCleanQueued = item.status === "queued" && item.state !== "importPending";
        if (serverIsCleanQueued && progress.state !== "queued") {
            return item;
        }

        const liveStatus = getLiveQueueItemStatus(progress);
        const liveStage = getLiveQueueItemStage(progress);
        // Progress-state "completed" must not yank an Active row while the
        // command is still started (download backends used to emit that early).
        const status = (liveStatus === "completed" && (item.status === "started" || item.status === "downloading"))
            ? (item.status === "downloading" ? "downloading" : "started")
            : liveStatus;

        return {
            ...item,
            status,
            stage: liveStage ?? item.stage,
            progress: progress.progress ?? item.progress,
            error: status === "failed"
                ? progress.statusMessage ?? item.error ?? null
                : item.error ?? null,
            quality: progress.quality ?? item.quality ?? null,
            title: preferQueueLabel(progress.title, item.title),
            artist: preferQueueLabel(progress.artist, item.artist),
            cover: preferQueueCover(progress.cover, item.cover),
            currentFileNum: progress.currentFileNum ?? item.currentFileNum,
            totalFiles: progress.totalFiles ?? item.totalFiles,
            currentTrack: progress.currentTrack ?? item.currentTrack,
            currentProviderTrackId: progress.currentProviderTrackId ?? item.currentProviderTrackId,
            currentTrackNum: progress.currentTrackNum ?? item.currentTrackNum,
            currentVolumeNum: progress.currentVolumeNum ?? item.currentVolumeNum,
            trackProgress: progress.trackProgress ?? item.trackProgress,
            trackStatus: progress.trackStatus ?? item.trackStatus,
            statusMessage: progress.statusMessage ?? item.statusMessage,
            speed: progress.speed ?? item.speed,
            eta: progress.eta ?? item.eta,
            size: progress.size ?? item.size,
            sizeleft: progress.sizeleft ?? item.sizeleft,
            state: (progress.state === "completed" && (item.status === "started" || item.status === "downloading"))
                ? (item.state === "importPending" || item.state === "importing" ? item.state : "downloading")
                : (progress.state ?? item.state),
            tracks: progress.tracks ?? item.tracks,
        };
    });

    // Only the server supplies actionable queue rows and canonical identities.
    // A progress event may arrive after removal or before the next list refresh.
    return mergedQueue.sort((left, right) => queueActivityRank(left) - queueActivityRank(right));
}

export function queueActivityRank(item: QueueItem): number {
    if (item.state === "importing") return 0;
    if (item.state === "downloading" || item.status === "downloading") return 1;
    if (item.state === "importPending") return 2;
    if (item.status === "started" && item.state !== "queued" && item.state !== "paused") return 3;
    return 4;
}

/** Each acquisition has its own edition/library context, even for one album. */
export function queueItemGroupKey(item: QueueItem): string {
    return `${item.type}-${item.id}`;
}
