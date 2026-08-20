import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import {
    Badge,
    Button,
    Checkbox,
    Menu,
    MenuItem,
    MenuList,
    MenuPopover,
    MenuTrigger,
    mergeClasses,
    ProgressBar,
    Subtitle2,
    Spinner,
    Text,
    tokens,
} from "@fluentui/react-components";
import {
  CheckmarkCircle16Filled,
  DismissCircle16Filled,
  ArrowClockwise24Regular,
  Clock16Regular,
  Delete24Regular,
  MusicNote224Regular,
  Video24Regular,
  ArrowDownload24Regular,
  ArrowUpload24Regular,
  MoreHorizontal24Regular,
  ArrowUp24Regular,
  ArrowDown24Regular,
  ArrowClockwise24Filled,
  Clock16Filled,
  Delete24Filled,
  MusicNote224Filled,
  Video24Filled,
  ArrowDownload24Filled,
  ArrowUpload24Filled,
  MoreHorizontal24Filled,
  ArrowUp24Filled,
  ArrowDown24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { formatTrackPosition, isMultiVolumeTrackList } from "@/utils/trackPosition";
import { useDelayedVisible } from "@/hooks/useDelayedVisible";
import { useQueue } from "@/hooks/useQueue";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import type { QueueItemContract as QueueItem } from "@contracts/status";
import { useQueueHistoryFeed } from "@/hooks/useQueueHistoryFeed";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";
import { MediaTypeBadge } from "@/components/ui/MediaTypeBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { QueueListSkeleton } from "@/components/ui/LoadingSkeletons";
import { mediaCoverProxySrc, mediaCoverSrc } from "@/utils/artwork";
import { dispatchActivityRefresh } from "@/utils/appEvents";
import type { DownloadProgress } from "@/queue/queueProgress";
import { useDashboardStyles } from "./dashboardStyles";
import { ProviderMark } from "@/components/ui/ProviderMark";
import { QueueHistoryPanel } from "./QueueHistoryPanel";
import {
    isInteractiveElementTarget,
    isQueueRowActivationKey,
    stopQueueControlEvent,
} from "./queueTabShared";
import {
    defaultQueueHistoryFilters,
    type QueueHistoryFilters,
} from "./queueHistoryFilters";
import { getQueueItemNavPath } from "./queueNavigation";
import {
    buildBulkEdgeMoveRequest,
    buildSingleGroupMoveRequest,
    flattenPendingGroupJobIds,
    getGroupFirstJobId,
    getGroupLastJobId,
    getMovablePendingJobIds,
    type GroupMoveAction,
    type ReorderableQueueItem,
} from "./queueReorder";

const ArrowClockwise24 = bundleIcon(ArrowClockwise24Filled, ArrowClockwise24Regular);
const Clock16 = bundleIcon(Clock16Filled, Clock16Regular);
const Delete24 = bundleIcon(Delete24Filled, Delete24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);
const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const ArrowUpload24 = bundleIcon(ArrowUpload24Filled, ArrowUpload24Regular);
const MoreHorizontal24 = bundleIcon(MoreHorizontal24Filled, MoreHorizontal24Regular);
const ArrowUp24 = bundleIcon(ArrowUp24Filled, ArrowUp24Regular);
const ArrowDown24 = bundleIcon(ArrowDown24Filled, ArrowDown24Regular);

function normalizeTrackLabel(value?: string | null): string {
    return String(value || "")
        .toLowerCase()
        .replace(/^[^-]+\s-\s/, "")
        .trim();
}

function matchesActiveTrack(trackTitle?: string | null, currentTrack?: string | null): boolean {
    const left = normalizeTrackLabel(trackTitle);
    const right = normalizeTrackLabel(currentTrack);

    if (!left || !right) {
        return false;
    }

    return left === right || left.includes(right) || right.includes(left);
}

function matchesProviderTrackId(trackProviderId?: string | null, currentProviderTrackId?: string | null): boolean {
    const left = String(trackProviderId || "").trim();
    const right = String(currentProviderTrackId || "").trim();
    return Boolean(left && right && left === right);
}

/** Show V-T for every disc when the album has more than one volume. */
// Thin wrapper over the shared tracklist formatter (utils/trackPosition) so the
// queue and the manual-import dropdown share one definition of "1" vs "2-1".
function formatQueueTrackNumber(
    trackNum: number | string | null | undefined,
    volumeNum: number | null | undefined,
    tracks?: Array<{ volumeNum?: number | null }>,
    fallbackIndex?: number,
): string {
    const multiVolume = isMultiVolumeTrackList(tracks || []);
    return formatTrackPosition(trackNum, volumeNum, { multiVolume, fallbackIndex });
}

function findProgressTrackState(
    trackTitle: string | null | undefined,
    tracks?: Array<{ title: string; trackNum?: number; volumeNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }>,
    providerTrackId?: string | null,
) {
    if (!tracks?.length) {
        return undefined;
    }

    const byProviderId = tracks.find((track) => matchesProviderTrackId(track.providerTrackId, providerTrackId));
    if (byProviderId) {
        return byProviderId;
    }

    if (!trackTitle) {
        return undefined;
    }

    return tracks.find((track) => matchesActiveTrack(track.title, trackTitle) || matchesActiveTrack(trackTitle, track.title));
}

function isActiveAlbumProgressState(state?: string): boolean {
    return state === 'downloading' || state === 'importing' || state === 'importPending' || state === 'failed';
}

function findActiveAlbumTrackIndex(
    progress: {
        currentFileNum?: number;
        currentTrack?: string | null;
        currentProviderTrackId?: string | null;
        state?: string;
    } | undefined,
    tracks?: Array<{ title: string; trackNum?: number; volumeNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }>,
): number {
    if (!tracks?.length) {
        return -1;
    }

    if (progress?.currentProviderTrackId) {
        const matchedIndex = tracks.findIndex((track) => matchesProviderTrackId(track.providerTrackId, progress.currentProviderTrackId));
        if (matchedIndex >= 0) {
            return matchedIndex;
        }
    }

    if (progress?.currentTrack) {
        const matchedIndex = tracks.findIndex((track) => matchesActiveTrack(track.title, progress.currentTrack));
        if (matchedIndex >= 0) {
            return matchedIndex;
        }
    }

    if (isActiveAlbumProgressState(progress?.state) && typeof progress?.currentFileNum === 'number' && progress.currentFileNum > 0) {
        return Math.min(tracks.length - 1, Math.max(0, progress.currentFileNum - 1));
    }

    return -1;
}

function inferAlbumTrackStatus(
    trackIndex: number,
    progress: {
        currentFileNum?: number;
        currentTrack?: string | null;
        currentProviderTrackId?: string | null;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        state?: string;
        progress?: number | null;
    } | undefined,
    tracks: Array<{ title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }>,
    persistedStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped',
): 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' {
    if (persistedStatus === 'skipped') {
        return 'skipped';
    }

    if (progress?.state === 'completed') {
        return 'completed';
    }

    // Unmatched sibling rows must stay pending — never treat -1 as "already done".
    if (trackIndex < 0) {
        return persistedStatus && persistedStatus !== 'queued' ? persistedStatus : 'queued';
    }

    const activeTrackIndex = findActiveAlbumTrackIndex(progress, tracks);
    const isImportPhase = progress?.state === 'importing' || progress?.state === 'importPending';
    const hasImportTrackProgress = isImportPhase
        && progress?.state === 'importing'
        && (
            Boolean(progress.currentProviderTrackId)
            || Boolean(progress.currentTrack)
            || progress.trackStatus === 'downloading'
            || progress.trackStatus === 'completed'
        );
    const completedThreshold = typeof progress?.currentFileNum === 'number'
        ? Math.max(0, isImportPhase && !hasImportTrackProgress ? 0 : progress.currentFileNum - 1)
        : 0;

    if (isImportPhase) {
        if (persistedStatus === 'error') {
            return persistedStatus;
        }

        if (trackIndex < completedThreshold) {
            return 'completed';
        }

        if (trackIndex === activeTrackIndex) {
            if (progress?.trackStatus === 'error') {
                return 'error';
            }

            if (progress?.trackStatus === 'completed') {
                if (isImportPhase && progress.state === 'importing' && (progress.progress ?? 100) < 100) {
                    return 'downloading';
                }

                return 'completed';
            }

            if (progress?.trackStatus === 'downloading' || progress?.currentTrack || progress?.state === 'importing') {
                return 'downloading';
            }
        }

        return 'queued';
    }

    if (persistedStatus && persistedStatus !== 'queued') {
        return persistedStatus;
    }

    if (trackIndex < completedThreshold) {
        return 'completed';
    }

    if (trackIndex === activeTrackIndex) {
        if (progress?.trackStatus === 'error' || progress?.state === 'failed') {
            return 'error';
        }

        if (progress?.trackStatus === 'completed' && progress?.state !== 'downloading') {
            return 'completed';
        }

        if (isActiveAlbumProgressState(progress?.state) || progress?.trackStatus === 'downloading' || progress?.currentTrack) {
            return 'downloading';
        }
    }

    return persistedStatus ?? 'queued';
}

function renderPendingIndicator(styles: ReturnType<typeof useDashboardStyles>) {
    return <Clock16 className={styles.downloadStatusPendingIcon} />;
}

/**
 * Track-row indicator scheme:
 * - actively downloading OR importing → spinner
 * - downloaded, import still ahead    → brand-orange filled checkmark
 * - download + import both complete   → green filled checkmark
 * During the import phase every track is already downloaded, so rows the
 * importer hasn't reached yet show the orange checkmark instead of a clock.
 * Glyphs are Fluent 16 icons (native size) — no CSS width/height overrides.
 */
function renderTrackStatusIndicator(
    styles: ReturnType<typeof useDashboardStyles>,
    options: {
        isFailed?: boolean;
        isCompleted?: boolean;
        isActive?: boolean;
        isQueued?: boolean;
        isSkipped?: boolean;
        phase?: 'download' | 'import';
    },
) {
    if (options.isFailed) {
        return <DismissCircle16Filled className={styles.downloadStatusErrorIcon} />;
    }

    if (options.isActive) {
        return <Spinner size="extra-tiny" aria-label={options.phase === 'import' ? 'importing' : 'downloading'} />;
    }

    if (options.isCompleted) {
        return options.phase === 'import'
            ? <CheckmarkCircle16Filled className={styles.downloadStatusColorIcon} title="Downloaded and imported" />
            : <CheckmarkCircle16Filled className={styles.downloadStatusCompleteIcon} title="Downloaded" />;
    }

    if (options.isSkipped) {
        return <CheckmarkCircle16Filled className={styles.downloadStatusColorIcon} title="Already in library" />;
    }

    if (options.isQueued) {
        return options.phase === 'import'
            ? <CheckmarkCircle16Filled className={styles.downloadStatusCompleteIcon} title="Downloaded" />
            : renderPendingIndicator(styles);
    }

    return null;
}

function getQueueGroupNavPath(groupType: QueueItem['type'], firstItem?: QueueItem): string | null {
    if (!firstItem) {
        return null;
    }

    return getQueueItemNavPath({
        type: groupType,
        media_id: firstItem.media_id,
        album_id: firstItem.album_id,
    });
}

function getQueueItemSlotKey(item: QueueItem): string | null {
    const slot = item.slot?.trim().toLowerCase();
    if (slot) {
        return slot;
    }

    if (item.type !== 'album') {
        return null;
    }

    const quality = item.quality?.toUpperCase() ?? '';
    if (quality.includes('ATMOS') || quality.includes('SPATIAL') || quality.includes('SURROUND')) {
        return 'spatial';
    }

    return 'stereo';
}

type QueueGroup = {
    id: string;
    title: string;
    artist: string;
    cover: string | null;
    type: QueueItem['type'];
    quality: string | null;
    items: QueueItem[];
    status: 'downloading' | 'queued' | 'failed';
    sortIndex: number;
};

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

function mergeQueueItemsWithProgress(
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
        const serverIsCleanQueued = item.status === "queued"
            && (!item.state || item.state === "queued")
            && !(item.tracks && item.tracks.length > 0);
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

    const existingJobIds = new Set(mergedQueue.map((item) => item.id));

    for (const progress of progressByJobId.values()) {
        if (existingJobIds.has(progress.jobId)) {
            continue;
        }

        const status = getLiveQueueItemStatus(progress);
        if (status === "completed") {
            continue;
        }

        const timestamp = new Date().toISOString();
        mergedQueue.push({
            id: progress.jobId,
            url: null,
            type: progress.type,
            queuePosition: undefined,
            quality: progress.quality ?? null,
            stage: getLiveQueueItemStage(progress),
            providerId: progress.providerId,
            path: null,
            status,
            progress: progress.progress ?? 0,
            error: status === "failed" ? progress.statusMessage ?? null : null,
            created_at: timestamp,
            updated_at: timestamp,
            started_at: timestamp,
            completed_at: null,
            title: progress.title,
            artist: progress.artist,
            cover: progress.cover ?? null,
            album_id: progress.type === "album" ? progress.providerId : null,
            album_title: progress.type === "album" ? progress.title : null,
            currentFileNum: progress.currentFileNum,
            totalFiles: progress.totalFiles,
            currentTrack: progress.currentTrack,
            currentProviderTrackId: progress.currentProviderTrackId,
            currentTrackNum: progress.currentTrackNum,
            currentVolumeNum: progress.currentVolumeNum,
            trackProgress: progress.trackProgress,
            trackStatus: progress.trackStatus,
            statusMessage: progress.statusMessage,
            speed: progress.speed,
            eta: progress.eta,
            size: progress.size,
            sizeleft: progress.sizeleft,
            state: progress.state,
            tracks: progress.tracks,
        });
    }

    return mergedQueue;
}

function getEmbeddedQueueItemProgress(item?: QueueItem): DownloadProgress | undefined {
    if (!item || !item.providerId) {
        return undefined;
    }

    const hasInlineProgress = item.currentFileNum !== undefined
        || item.totalFiles !== undefined
        || item.currentTrack !== undefined
        || item.currentProviderTrackId !== undefined
        || item.currentTrackNum !== undefined
        || item.currentVolumeNum !== undefined
        || item.trackProgress !== undefined
        || item.trackStatus !== undefined
        || item.statusMessage !== undefined
        || item.speed !== undefined
        || item.eta !== undefined
        || item.size !== undefined
        || item.sizeleft !== undefined
        || item.state !== undefined
        || (item.tracks?.length ?? 0) > 0;

    if (!hasInlineProgress) {
        return undefined;
    }

    const inferredState = item.state
        ?? (item.status === "started"
            ? (item.stage === "import" ? "importing" : "downloading")
            : item.status === "downloading"
                ? "downloading"
                : item.status === "queued"
                    ? "queued"
                    : item.status === "failed"
                        ? "failed"
                        : undefined);

    return {
        jobId: item.id,
        providerId: item.providerId,
        type: item.type,
        quality: item.quality ?? null,
        title: item.title,
        artist: item.artist,
        cover: item.cover ?? null,
        progress: item.progress,
        speed: item.speed,
        eta: item.eta,
        totalFiles: item.totalFiles,
        currentFileNum: item.currentFileNum,
        currentTrack: item.currentTrack,
        currentProviderTrackId: item.currentProviderTrackId,
        currentTrackNum: item.currentTrackNum,
        currentVolumeNum: item.currentVolumeNum,
        trackProgress: item.trackProgress,
        trackStatus: item.trackStatus,
        statusMessage: item.statusMessage,
        state: inferredState,
        tracks: item.tracks,
        size: item.size,
        sizeleft: item.sizeleft,
    };
}

function mergeProgressSnapshots(
    embedded: DownloadProgress | undefined,
    live: DownloadProgress | undefined,
): DownloadProgress | undefined {
    if (!embedded) {
        return live;
    }

    if (!live) {
        return embedded;
    }

    const phaseRank = (state?: string) => {
        switch (state) {
            case "queued":
                return 0;
            case "downloading":
            case "paused":
                return 1;
            case "importPending":
                return 2;
            case "importing":
                return 3;
            case "completed":
                // Prefer live import phases over a stale/premature completed
                // snapshot from the download backend.
                return 1.5;
            case "failed":
            case "importFailed":
                return 5;
            default:
                return -1;
        }
    };
    const embeddedRank = phaseRank(embedded.state);
    const liveRank = phaseRank(live.state);
    const preferred = embeddedRank > liveRank ? embedded : live;
    const fallback = preferred === live ? embedded : live;

    return {
        ...fallback,
        ...preferred,
        quality: preferred.quality ?? fallback.quality ?? null,
        title: preferred.title ?? fallback.title,
        artist: preferred.artist ?? fallback.artist,
        cover: preferred.cover ?? fallback.cover ?? null,
        speed: preferred.speed ?? fallback.speed,
        eta: preferred.eta ?? fallback.eta,
        totalFiles: preferred.totalFiles ?? fallback.totalFiles,
        currentFileNum: preferred.currentFileNum ?? fallback.currentFileNum,
        currentTrack: preferred.currentTrack ?? fallback.currentTrack,
        currentProviderTrackId: preferred.currentProviderTrackId ?? fallback.currentProviderTrackId,
        currentTrackNum: preferred.currentTrackNum ?? fallback.currentTrackNum,
        currentVolumeNum: preferred.currentVolumeNum ?? fallback.currentVolumeNum,
        trackProgress: preferred.trackProgress ?? fallback.trackProgress,
        trackStatus: preferred.trackStatus ?? fallback.trackStatus,
        statusMessage: preferred.statusMessage ?? fallback.statusMessage,
        state: preferred.state ?? fallback.state,
        tracks: preferred.tracks ?? fallback.tracks,
        size: preferred.size ?? fallback.size,
        sizeleft: preferred.sizeleft ?? fallback.sizeleft,
    };
}

type DropPosition = 'before' | 'after';
type DropTarget = {
    groupId: string;
    position: DropPosition;
};

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
    if (fromIndex === toIndex) {
        return items;
    }

    const next = [...items];
    const [item] = next.splice(fromIndex, 1);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, item);
    return next;
}

function isPendingReorderableGroup(group: { status: string; items: ReorderableQueueItem[] }): boolean {
    return group.status === 'queued' && getMovablePendingJobIds(group.items).length === group.items.length;
}

const QueueTab = () => {
    const styles = useDashboardStyles();
    const navigate = useNavigate();
    const {
        queueItems: downloadQueue,
        isQueueInitialLoading: loading,
        hasQueueRefreshError,
        queueRefreshErrorMessage,
        hasMoreQueueItems,
        isLoadingMoreQueueItems,
        loadMoreQueueItems,
        refetch: refreshQueue,
    } = useQueue();
    const {
        getProgress,
        progressByJobId,
        retryItem,
        deleteItem,
        reorderItems,
    } = useQueueStatus();
    const [historyFilters, setHistoryFilters] = useState<QueueHistoryFilters>(defaultQueueHistoryFilters);
    const {
        queueHistoryItems,
        hasMoreQueueHistory,
        isLoadingMoreQueueHistory,
        loadMoreQueueHistory,
        isQueueHistoryInitialLoading,
        hasQueueHistoryRefreshError,
        queueHistoryRefreshErrorMessage,
        refetch: refreshQueueHistory,
    } = useQueueHistoryFeed({ filters: historyFilters });
    const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    const [busyGroupIds, setBusyGroupIds] = useState<string[]>([]);
    const [activeBulkAction, setActiveBulkAction] = useState<string | null>(null);
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeSentinelRef = useRef<HTMLDivElement | null>(null);

    const liveQueueItems = useMemo(
        () => mergeQueueItemsWithProgress(downloadQueue, progressByJobId),
        [downloadQueue, progressByJobId],
    );

    const groupedDownloads = useMemo(() => {
        const filteredQueue = liveQueueItems.filter(i => (
            i.status === 'downloading'
            || i.status === 'started'
            || i.status === 'queued'
        ));

        const groups: Record<string, QueueGroup> = {};

        filteredQueue.forEach((item, index) => {
            const isAlbum = item.type === 'album';
            const isVideo = item.type === 'video';
            const albumSlotKey = isAlbum ? getQueueItemSlotKey(item) : null;
            // Catalog-anchored albums are one DownloadAlbum command. Standalone
            // DownloadTrack rows stay individual track cards (no fake album grouping).
            const groupId = isAlbum
                ? `album-${item.album_id ?? item.providerId}-${albumSlotKey ?? 'default'}`
                : isVideo
                    ? `video-${item.providerId}`
                    : `track-${item.id}-${item.providerId}`;

            if (!groups[groupId]) {
                const groupType = isAlbum ? 'album' : isVideo ? 'video' : 'track';
                groups[groupId] = {
                    id: groupId,
                    title: groupType === 'album'
                        ? (item.title || item.album_title || "Unknown Album")
                        : item.title || "Unknown Track",
                    artist: item.artist || "Unknown",
                    cover: item.cover || null,
                    type: groupType,
                    quality: item.quality ?? null,
                    items: [],
                    status: (item.status === 'downloading' || item.status === 'started') ? 'downloading' : item.status === 'failed' ? 'failed' : 'queued',
                    sortIndex: index,
                };
            }

            if (item.status === 'downloading' || item.status === 'started') {
                groups[groupId].status = 'downloading';
            } else if (item.status === 'failed' && groups[groupId].status !== 'downloading') {
                groups[groupId].status = 'failed';
            }

            if (!groups[groupId].quality && item.quality) {
                groups[groupId].quality = item.quality;
            }

            if (!groups[groupId].cover && item.cover) {
                groups[groupId].cover = item.cover;
            }

            groups[groupId].items.push(item);
        });

        return Object.values(groups).sort((a, b) => a.sortIndex - b.sortIndex);
    }, [liveQueueItems]);

    // Optimistic reorder. The server reflects a reorder immediately, but the
    // client refetch can race the write (most visible when the queue is idle, so
    // no incidental churn-triggered refetch masks it) and a move could appear to
    // do nothing until a manual reload. Applying the intended order locally makes
    // the move instant; the reconciler below drops the override once the server
    // list catches up, or when churn changes which groups are still pending.
    const [pendingOrderOverride, setPendingOrderOverride] = useState<string[] | null>(null);

    const displayGroups = useMemo(() => {
        if (!pendingOrderOverride) return groupedDownloads;
        const orderIndex = new Map(pendingOrderOverride.map((id, index) => [id, index] as const));
        const pendingPositions: number[] = [];
        groupedDownloads.forEach((group, index) => {
            if (isPendingReorderableGroup(group)) pendingPositions.push(index);
        });
        const reorderedPending = groupedDownloads
            .filter((group) => isPendingReorderableGroup(group))
            .slice()
            .sort((left, right) => (
                (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER)
                - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
            ));
        // Permute only the pending groups within their existing slots so active
        // (started) rows keep their exact position.
        const result = groupedDownloads.slice();
        pendingPositions.forEach((position, index) => {
            result[position] = reorderedPending[index];
        });
        return result;
    }, [groupedDownloads, pendingOrderOverride]);

    // Server-derived pending order, ignoring the optimistic override.
    const serverPendingGroupIds = useMemo(
        () => groupedDownloads.filter((group) => isPendingReorderableGroup(group)).map((group) => group.id),
        [groupedDownloads],
    );

    useEffect(() => {
        if (!pendingOrderOverride) return;
        const serverSet = new Set(serverPendingGroupIds);
        const sameMembership = serverSet.size === pendingOrderOverride.length
            && pendingOrderOverride.every((id) => serverSet.has(id));
        // Churn changed which groups are pending — trust the server list again.
        if (!sameMembership) {
            setPendingOrderOverride(null);
            return;
        }
        // Server list has caught up to the intended order — drop the override.
        if (serverPendingGroupIds.every((id, index) => id === pendingOrderOverride[index])) {
            setPendingOrderOverride(null);
        }
    }, [serverPendingGroupIds, pendingOrderOverride]);

    // Safety net: if the server never reflects the move (e.g. the reorder request
    // failed), release the optimistic order so the list can't get stuck showing a
    // phantom order. The match-based reconciler above clears a successful reorder
    // well before this fires.
    useEffect(() => {
        if (!pendingOrderOverride) return;
        const timer = setTimeout(() => setPendingOrderOverride(null), 10_000);
        return () => clearTimeout(timer);
    }, [pendingOrderOverride]);

    const ACTIVE_PAGE_SIZE = 25;
    const [visibleActiveLimit, setVisibleActiveLimit] = useState(ACTIVE_PAGE_SIZE);
    const visibleGroupedDownloads = useMemo(
        () => displayGroups.slice(0, visibleActiveLimit),
        [displayGroups, visibleActiveLimit],
    );
    const hasMoreLocalActiveGroups = groupedDownloads.length > visibleActiveLimit;
    const hasMoreActiveGroups = hasMoreLocalActiveGroups || hasMoreQueueItems;

    // Reset visible limit when queue shrinks below threshold
    useEffect(() => {
        if (groupedDownloads.length <= ACTIVE_PAGE_SIZE) {
            setVisibleActiveLimit(ACTIVE_PAGE_SIZE);
        }
    }, [groupedDownloads.length]);

    // Infinite scroll: auto-load next page when sentinel enters viewport
    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    if (entry.target === activeSentinelRef.current && hasMoreActiveGroups) {
                        if (hasMoreLocalActiveGroups) {
                            setVisibleActiveLimit((prev) => prev + ACTIVE_PAGE_SIZE);
                        } else if (hasMoreQueueItems && !isLoadingMoreQueueItems) {
                            void loadMoreQueueItems();
                        }
                    }
                }
            },
            { rootMargin: "200px" },
        );

        const activeSentinel = activeSentinelRef.current;
        if (activeSentinel) observer.observe(activeSentinel);

        return () => observer.disconnect();
    }, [
        hasMoreActiveGroups,
        hasMoreLocalActiveGroups,
        hasMoreQueueItems,
        isLoadingMoreQueueItems,
        loadMoreQueueItems,
    ]);

    const pendingReorderGroups = useMemo(
        () => displayGroups.filter((group) => isPendingReorderableGroup(group)),
        [displayGroups],
    );
    const pendingGroupSelection = useSelectableCollection({
        items: pendingReorderGroups,
        getItemId: (group) => group.id,
    });
    const pendingQueueRangeSelectionRef = useRef(false);
    const selectedPendingGroupIds = useMemo(
        () => pendingGroupSelection.selectedRowIds.map((groupId) => String(groupId)),
        [pendingGroupSelection.selectedRowIds],
    );
    const selectedPendingGroupIdSet = useMemo(
        () => new Set(selectedPendingGroupIds),
        [selectedPendingGroupIds],
    );
    const busyGroupIdSet = useMemo(() => new Set(busyGroupIds), [busyGroupIds]);
    const hasPendingReorderUi = pendingReorderGroups.length > 0;
    const selectedPendingGroups = useMemo(
        () => pendingReorderGroups.filter((group) => selectedPendingGroupIdSet.has(group.id)),
        [pendingReorderGroups, selectedPendingGroupIdSet],
    );
    const selectedPendingCount = selectedPendingGroups.length;
    const isSelectedBlockAtTop = selectedPendingCount > 0
        && pendingReorderGroups.slice(0, selectedPendingCount).every((group) => selectedPendingGroupIdSet.has(group.id));
    const isSelectedBlockAtBottom = selectedPendingCount > 0
        && pendingReorderGroups.slice(-selectedPendingCount).every((group) => selectedPendingGroupIdSet.has(group.id));
    const canMoveSelectedTop = selectedPendingCount > 0 && !isSelectedBlockAtTop;
    const canMoveSelectedBottom = selectedPendingCount > 0
        && (!isSelectedBlockAtBottom || hasMoreQueueItems);
    const canMoveSelectedUp = pendingReorderGroups.some((group, index) => (
        selectedPendingGroupIdSet.has(group.id)
        && index > 0
        && !selectedPendingGroupIdSet.has(pendingReorderGroups[index - 1].id)
    ));
    const canMoveSelectedDown = pendingReorderGroups.some((group, index) => (
        selectedPendingGroupIdSet.has(group.id)
        && index < pendingReorderGroups.length - 1
        && !selectedPendingGroupIdSet.has(pendingReorderGroups[index + 1].id)
    ));
    const isQueueMutationPending = busyGroupIds.length > 0 || activeBulkAction !== null;

    const enterSelectionMode = useCallback((groupId: string) => {
        setIsSelectionMode(true);
        pendingGroupSelection.setSelectedRowIds((current) => {
            const currentIds = current.map((rowId) => String(rowId));
            return currentIds.includes(groupId) ? current : [...current, groupId];
        });
    }, [pendingGroupSelection]);

    const exitSelectionMode = useCallback(() => {
        setIsSelectionMode(false);
        pendingGroupSelection.clearSelection();
    }, [pendingGroupSelection]);

    // Exit selection mode when there are no more pending reorderable groups
    useEffect(() => {
        if (isSelectionMode && pendingReorderGroups.length === 0) {
            exitSelectionMode();
        }
    }, [isSelectionMode, pendingReorderGroups.length, exitSelectionMode]);

    const handleGroupContextMenu = useCallback((e: ReactMouseEvent, groupId: string) => {
        const group = groupedDownloads.find((g) => g.id === groupId);
        if (!group || !isPendingReorderableGroup(group)) return;
        e.preventDefault();
        enterSelectionMode(groupId);
    }, [groupedDownloads, enterSelectionMode]);

    const handleGroupTouchStart = useCallback((_e: ReactTouchEvent, groupId: string) => {
        const group = groupedDownloads.find((g) => g.id === groupId);
        if (!group || !isPendingReorderableGroup(group)) return;
        longPressTimerRef.current = setTimeout(() => {
            enterSelectionMode(groupId);
        }, 400);
    }, [groupedDownloads, enterSelectionMode]);

    const handleGroupTouchEnd = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const handleGroupTouchMove = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const getDraggedGroupIds = useCallback((movingGroupId: string, event?: DragEvent<HTMLDivElement>): string[] => {
        if (isSelectionMode && selectedPendingGroupIdSet.has(movingGroupId)) {
            return pendingReorderGroups
                .filter((group) => selectedPendingGroupIdSet.has(group.id))
                .map((group) => group.id);
        }

        const rawGroupIds = event?.dataTransfer.getData('application/discogenius-queue-group-ids');
        if (!rawGroupIds) {
            return [movingGroupId];
        }

        try {
            const parsed = JSON.parse(rawGroupIds);
            if (Array.isArray(parsed)) {
                const normalized = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
                if (normalized.length > 0) {
                    return normalized;
                }
            }
        } catch {
            // Ignore invalid drag metadata and fall back to the dragged row.
        }

        return [movingGroupId];
    }, [isSelectionMode, pendingReorderGroups, selectedPendingGroupIdSet]);

    const withBusyGroups = async (groupIds: string[], action: string | null, task: () => Promise<void>) => {
        setBusyGroupIds(groupIds);
        setActiveBulkAction(action);
        try {
            await task();
        } finally {
            setBusyGroupIds([]);
            setActiveBulkAction(null);
            setDraggingGroupId(null);
            setDropTarget(null);
        }
    };

    const handleSingleGroupMove = async (groupId: string, action: GroupMoveAction) => {
        const reorderRequest = buildSingleGroupMoveRequest(pendingReorderGroups, groupId, action);
        if (!reorderRequest) {
            return;
        }

        const ids = pendingReorderGroups.map((group) => group.id);
        const fromIndex = ids.indexOf(groupId);
        if (fromIndex >= 0) {
            const toIndex = action === 'top' ? 0
                : action === 'bottom' ? ids.length - 1
                    : action === 'up' ? Math.max(0, fromIndex - 1)
                        : Math.min(ids.length - 1, fromIndex + 1);
            setPendingOrderOverride(moveArrayItem(ids, fromIndex, toIndex));
        }

        await withBusyGroups([groupId], null, async () => {
            const succeeded = await reorderItems(reorderRequest);
            if (!succeeded) {
                setPendingOrderOverride(null);
                await refreshQueue();
            }
        });
    };

    const handleGroupMove = async (groupId: string, action: GroupMoveAction) => {
        if (isSelectionMode && selectedPendingGroupIdSet.has(groupId) && selectedPendingGroupIds.length > 1) {
            if (action === 'top' || action === 'bottom') {
                await handleSelectedGroupsMoveToEdge(action);
            } else {
                await handleSelectedGroupsMoveOneStep(action);
            }
        } else {
            await handleSingleGroupMove(groupId, action);
        }
    };

    const handleSelectedGroupsMoveToEdge = async (action: 'top' | 'bottom') => {
        const reorderRequest = buildBulkEdgeMoveRequest(pendingReorderGroups, selectedPendingGroupIds, action);
        if (!reorderRequest) {
            return;
        }

        const movingSet = new Set(selectedPendingGroupIds);
        const ids = pendingReorderGroups.map((group) => group.id);
        const moving = ids.filter((id) => movingSet.has(id));
        const rest = ids.filter((id) => !movingSet.has(id));
        setPendingOrderOverride(action === 'top' ? [...moving, ...rest] : [...rest, ...moving]);

        await withBusyGroups(selectedPendingGroupIds, action === 'top' ? 'move-top' : 'move-bottom', async () => {
            const succeeded = await reorderItems(reorderRequest);
            if (!succeeded) {
                setPendingOrderOverride(null);
                await refreshQueue();
            }
        });
    };

    const handleSelectedGroupsMoveOneStep = async (direction: 'up' | 'down') => {
        if (selectedPendingGroupIds.length === 0) {
            return;
        }

        const orderedSelection = pendingReorderGroups
            .filter((group) => selectedPendingGroupIdSet.has(group.id))
            .map((group) => group.id);
        const traversalOrder = direction === 'up' ? orderedSelection : [...orderedSelection].reverse();
        let workingGroups = [...pendingReorderGroups];
        let didReorder = false;

        // Mirror the per-step swaps at the id level for an instant optimistic move.
        let optimisticIds = pendingReorderGroups.map((group) => group.id);
        for (const groupId of traversalOrder) {
            const currentIndex = optimisticIds.indexOf(groupId);
            if (currentIndex < 0) continue;
            const neighborIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
            if (neighborIndex < 0 || neighborIndex >= optimisticIds.length) continue;
            if (selectedPendingGroupIdSet.has(optimisticIds[neighborIndex])) continue;
            optimisticIds = moveArrayItem(optimisticIds, currentIndex, neighborIndex);
        }
        setPendingOrderOverride(optimisticIds);

        await withBusyGroups(selectedPendingGroupIds, direction === 'up' ? 'move-up' : 'move-down', async () => {
            for (const groupId of traversalOrder) {
                const currentIndex = workingGroups.findIndex((group) => group.id === groupId);
                if (currentIndex < 0) {
                    continue;
                }

                const neighborIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
                if (neighborIndex < 0 || neighborIndex >= workingGroups.length) {
                    continue;
                }

                const neighborGroup = workingGroups[neighborIndex];
                if (selectedPendingGroupIdSet.has(neighborGroup.id)) {
                    continue;
                }

                const movingGroup = workingGroups[currentIndex];
                const jobIds = getMovablePendingJobIds(movingGroup.items);
                const anchorJobId = direction === 'up'
                    ? getGroupFirstJobId(neighborGroup)
                    : getGroupLastJobId(neighborGroup);
                if (jobIds.length === 0 || anchorJobId == null) {
                    continue;
                }

                const succeeded = await reorderItems(
                    direction === 'up'
                        ? { jobIds, beforeJobId: anchorJobId }
                        : { jobIds, afterJobId: anchorJobId },
                    { refresh: false, dispatchActivity: false },
                );
                if (!succeeded) {
                    setPendingOrderOverride(null);
                    await refreshQueue();
                    return;
                }
                didReorder = true;
                workingGroups = moveArrayItem(workingGroups, currentIndex, neighborIndex);
            }

            if (didReorder) {
                await refreshQueue();
                dispatchActivityRefresh();
            }
        });
    };

    const handleRemoveSelectedGroups = async () => {
        if (selectedPendingGroups.length === 0) {
            return;
        }

        const selectedGroupIds = selectedPendingGroups.map((group) => group.id);
        await withBusyGroups(selectedGroupIds, 'remove-selected', async () => {
            await Promise.all(selectedPendingGroups.flatMap((group) => group.items.map((item) => deleteItem(item.id))));
            pendingGroupSelection.clearSelection();
        });
    };

    const handleRemoveGroup = async (group: QueueGroup) => {
        await withBusyGroups([group.id], null, async () => {
            await Promise.all(group.items.map((item) => deleteItem(item.id)));
            pendingGroupSelection.setSelectedRowIds((current) => current.filter((rowId) => String(rowId) !== group.id));
        });
    };

    const handleDeleteAction = async (group: QueueGroup) => {
        if (isSelectionMode && selectedPendingGroupIdSet.has(group.id)) {
            await handleRemoveSelectedGroups();
            return;
        }

        await handleRemoveGroup(group);
    };

    const getDropPosition = (event: DragEvent<HTMLDivElement>): DropPosition => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return event.clientY - bounds.top >= bounds.height / 2 ? 'after' : 'before';
    };

    const handleDragStart = (event: DragEvent<HTMLDivElement>, groupId: string) => {
        if (isQueueMutationPending) {
            event.preventDefault();
            return;
        }

        const movingGroupIds = getDraggedGroupIds(groupId);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', groupId);
        event.dataTransfer.setData('application/discogenius-queue-group-ids', JSON.stringify(movingGroupIds));
        setDraggingGroupId(groupId);
        setDropTarget(null);
    };

    const handleDragOver = (event: DragEvent<HTMLDivElement>, groupId: string) => {
        if (!draggingGroupId) {
            return;
        }

        const movingGroupIds = getDraggedGroupIds(draggingGroupId, event);
        if (movingGroupIds.includes(groupId)) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget({ groupId, position: getDropPosition(event) });
    };

    const handleDragLeave = (groupId: string) => {
        setDropTarget((current) => current?.groupId === groupId ? null : current);
    };

    const handleDrop = async (event: DragEvent<HTMLDivElement>, groupId: string) => {
        event.preventDefault();

        const movingGroupId = draggingGroupId || event.dataTransfer.getData('text/plain');
        if (!movingGroupId) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        const movingGroupIds = getDraggedGroupIds(movingGroupId, event);
        const movingGroupIdSet = new Set(movingGroupIds);
        if (movingGroupIdSet.has(groupId)) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        const movingGroups = pendingReorderGroups.filter((group) => movingGroupIdSet.has(group.id));
        const targetGroup = pendingReorderGroups.find((group) => group.id === groupId && !movingGroupIdSet.has(group.id));
        if (movingGroups.length === 0 || !targetGroup) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        const jobIds = flattenPendingGroupJobIds(movingGroups);
        const position = getDropPosition(event);
        const anchorJobId = position === 'before'
            ? getGroupFirstJobId(targetGroup)
            : getGroupLastJobId(targetGroup);
        if (jobIds.length === 0 || anchorJobId == null) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        const ids = pendingReorderGroups.map((group) => group.id);
        const moving = ids.filter((id) => movingGroupIdSet.has(id));
        const rest = ids.filter((id) => !movingGroupIdSet.has(id));
        const anchorIndex = rest.indexOf(groupId);
        if (anchorIndex >= 0) {
            const insertIndex = position === 'before' ? anchorIndex : anchorIndex + 1;
            setPendingOrderOverride([...rest.slice(0, insertIndex), ...moving, ...rest.slice(insertIndex)]);
        }

        await withBusyGroups(movingGroupIds, null, async () => {
            const succeeded = await reorderItems(position === 'before'
                ? { jobIds, beforeJobId: anchorJobId }
                : { jobIds, afterJobId: anchorJobId });
            if (!succeeded) {
                setPendingOrderOverride(null);
                await refreshQueue();
            }
        });
    };

    const handleDragEnd = () => {
        setDraggingGroupId(null);
        setDropTarget(null);
    };

    const hasQueueRows = groupedDownloads.length > 0;
    const isInitialLoading = (loading && !hasQueueRows) || (!hasQueueRows && isQueueHistoryInitialLoading && !hasQueueRefreshError);
    // Shared delayed-loading policy: no skeleton flash for sub-second loads.
    const showInitialSkeleton = useDelayedVisible(isInitialLoading);

    const handleRetryQueueFeeds = async () => {
        await Promise.all([
            refreshQueue(),
            refreshQueueHistory(),
        ]);
    };

    if (isInitialLoading) {
        if (!showInitialSkeleton) {
            return <div className={styles.tabSection} />;
        }
        // Mirror the real Active/History dual-column layout so the skeleton
        // matches the predictable page structure (Fluent skeleton guidance).
        return (
            <div className={styles.tabSection}>
                <div className={styles.queueColumnsWrapper}>
                    <section className={styles.queueSection} aria-label="Active">
                        <div className={styles.queueSectionHeader}>
                            <div className={styles.queueSectionHeading}>
                                <Subtitle2 className={styles.queueSectionTitle}>Active</Subtitle2>
                            </div>
                        </div>
                        <QueueListSkeleton rows={4} />
                    </section>
                    <section className={styles.queueSection} aria-label="History">
                        <div className={styles.queueSectionHeader}>
                            <div className={styles.queueSectionHeading}>
                                <Subtitle2 className={styles.queueSectionTitle}>History</Subtitle2>
                            </div>
                        </div>
                        <QueueListSkeleton rows={4} />
                    </section>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.tabSection}>
            <div className={styles.queueColumnsWrapper}>
                {hasQueueRows ? (
                    <section className={styles.queueSection} aria-label="Active">
                        <div className={styles.queueSectionHeader}>
                            <div className={styles.queueSectionHeading}>
                                <Subtitle2 className={styles.queueSectionTitle}>Active</Subtitle2>
                            </div>
                            {isSelectionMode && hasPendingReorderUi ? (
                                <div className={styles.queueSectionActions}>
                                    <Text className={styles.queueSectionSelectionCount}>
                                        {selectedPendingCount === 1 ? '1 selected' : `${selectedPendingCount} selected`}
                                    </Text>
                                    <Button
                                        size="small"
                                        appearance="subtle"
                                        onClick={() => {
                                            setIsSelectionMode(true);
                                            pendingGroupSelection.selectAllVisible();
                                        }}
                                        disabled={pendingGroupSelection.allVisibleSelected || isQueueMutationPending}
                                    >
                                        Select all
                                    </Button>
                                    <Button size="small" appearance="subtle" onClick={exitSelectionMode} disabled={isQueueMutationPending}>
                                        Clear
                                    </Button>
                                </div>
                            ) : null}
                        </div>

                        <div className={styles.downloadList}>
                            {visibleGroupedDownloads.map((group) => {
                                const isVideo = group.type === 'video';
                                const coverUrl = isVideo ? mediaCoverProxySrc(group) : mediaCoverSrc(group);
                                const isDownloading = group.status === 'downloading';
                                const isFailed = group.status === 'failed';
                                const groupedTrackItems = group.items.filter((item) => item.type === 'track');

                                const activeItem = group.items.find(i => i.status === 'downloading' || i.status === 'started');
                                const firstItem = group.items[0];
                                const prog = activeItem
                                    ? mergeProgressSnapshots(getEmbeddedQueueItemProgress(activeItem), getProgress(activeItem.id))
                                    : firstItem
                                        ? mergeProgressSnapshots(getEmbeddedQueueItemProgress(firstItem), getProgress(firstItem.id))
                                        : undefined;
                                const activeStage = activeItem?.stage || firstItem?.stage;
                                const isImporting = isDownloading && (activeStage === 'import' || prog?.state === 'importing' || prog?.state === 'importPending');
                                const isImportPending = !isDownloading && !isFailed && (activeStage === 'import' || prog?.state === 'importPending' || prog?.state === 'importing');
                                const shouldRenderGroupedTrackRows = group.type === 'album' && groupedTrackItems.length > 0;
                                const groupError = firstItem?.error || (isFailed ? prog?.statusMessage : undefined);
                                const groupNavPath = getQueueGroupNavPath(group.type, firstItem);
                                const isPendingReorderable = isPendingReorderableGroup(group);
                                const pendingGroupIndex = isPendingReorderable
                                    ? pendingReorderGroups.findIndex((pendingGroup) => pendingGroup.id === group.id)
                                    : -1;
                                const isFirstPendingGroup = pendingGroupIndex === 0;
                                const isLastPendingGroup = pendingGroupIndex === pendingReorderGroups.length - 1;
                                const isGroupSelected = selectedPendingGroupIdSet.has(group.id);
                                const isGroupBusy = busyGroupIdSet.has(group.id);
                                const isGroupDragging = draggingGroupId === group.id
                                    || (draggingGroupId !== null
                                        && isSelectionMode
                                        && selectedPendingGroupIdSet.has(draggingGroupId)
                                        && isGroupSelected);
                                const isDropBefore = dropTarget?.groupId === group.id && dropTarget.position === 'before';
                                const isDropAfter = dropTarget?.groupId === group.id && dropTarget.position === 'after';
                                const useSelectionActionState = isSelectionMode && isGroupSelected;
                                const disableMoveTop = isQueueMutationPending || (useSelectionActionState ? !canMoveSelectedTop : isFirstPendingGroup);
                                const disableMoveUp = isQueueMutationPending || (useSelectionActionState ? !canMoveSelectedUp : isFirstPendingGroup);
                                const disableMoveDown = isQueueMutationPending || (useSelectionActionState ? !canMoveSelectedDown : isLastPendingGroup);
                                const disableMoveBottom = isQueueMutationPending || (
                                    useSelectionActionState
                                        ? !canMoveSelectedBottom
                                        : (isLastPendingGroup && !hasMoreQueueItems)
                                );
                                const isGroupRowInteractive = Boolean(groupNavPath)
                                    || (isSelectionMode && isPendingReorderable);
                                const groupRowRole = isSelectionMode && isPendingReorderable
                                    ? "button"
                                    : groupNavPath
                                        ? "link"
                                        : undefined;
                                const groupRowLabel = isSelectionMode && isPendingReorderable
                                    ? `${isGroupSelected ? "Deselect" : "Select"} ${group.title}`
                                    : groupNavPath
                                        ? `Open ${group.title}`
                                        : undefined;

                                const activateGroupRow = (shiftKey = false) => {
                                    if (isSelectionMode && isPendingReorderable) {
                                        pendingGroupSelection.toggleItem(group.id, !isGroupSelected, { range: shiftKey });
                                        return;
                                    }
                                    if (groupNavPath) navigate(groupNavPath);
                                };
                                const handleGroupClick = (event: ReactMouseEvent<HTMLDivElement>) => {
                                    if (isInteractiveElementTarget(event.target)) return;
                                    activateGroupRow(event.shiftKey);
                                };
                                const handleGroupKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
                                    if (
                                        !isQueueRowActivationKey(event.key)
                                        || isInteractiveElementTarget(event.target)
                                    ) {
                                        return;
                                    }

                                    event.preventDefault();
                                    activateGroupRow(event.shiftKey);
                                };

                                return (
                                    <div key={group.id} className={styles.downloadGroup} data-queue-group-id={group.id}>
                                        <div
                                            className={mergeClasses(
                                                styles.downloadItem,
                                                isPendingReorderable ? styles.downloadItemReorderable : '',
                                                isGroupSelected ? styles.downloadItemSelected : '',
                                                isGroupBusy ? styles.downloadItemBusy : '',
                                                isGroupDragging ? styles.downloadItemDragging : '',
                                                isDropBefore ? styles.downloadItemDropBefore : '',
                                                isDropAfter ? styles.downloadItemDropAfter : '',
                                            )}
                                            style={{ opacity: isFailed ? 0.9 : 1, cursor: groupNavPath ? 'pointer' : 'default' }}
                                            onClick={isGroupRowInteractive ? handleGroupClick : undefined}
                                            onKeyDown={isGroupRowInteractive ? handleGroupKeyDown : undefined}
                                            role={groupRowRole}
                                            tabIndex={isGroupRowInteractive ? 0 : undefined}
                                            aria-label={groupRowLabel}
                                            aria-pressed={isSelectionMode && isPendingReorderable
                                                ? isGroupSelected
                                                : undefined}
                                            onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
                                            onTouchStart={(e) => handleGroupTouchStart(e, group.id)}
                                            onTouchEnd={handleGroupTouchEnd}
                                            onTouchMove={handleGroupTouchMove}
                                            onDragOver={isPendingReorderable ? (event) => handleDragOver(event, group.id) : undefined}
                                            onDragLeave={isPendingReorderable ? () => handleDragLeave(group.id) : undefined}
                                            onDrop={isPendingReorderable ? (event) => { void handleDrop(event, group.id); } : undefined}
                                        >
                                            {isPendingReorderable ? (
                                                <div className={styles.downloadSelectionCell} data-queue-control="true" onClick={stopQueueControlEvent}>
                                                    {isSelectionMode ? (
                                                        <Checkbox
                                                            aria-label={`Select ${group.title}`}
                                                            checked={isGroupSelected}
                                                            onClick={(event) => {
                                                                stopQueueControlEvent(event);
                                                                pendingQueueRangeSelectionRef.current = event.shiftKey;
                                                            }}
                                                            onChange={(event, data) => pendingGroupSelection.toggleItem(
                                                                group.id,
                                                                data.checked === true,
                                                                {
                                                                    range: pendingQueueRangeSelectionRef.current
                                                                        || Boolean((event.nativeEvent as MouseEvent).shiftKey),
                                                                },
                                                            )}
                                                        />
                                                    ) : null}
                                                    <div
                                                        className={mergeClasses(
                                                            styles.downloadDragHandle,
                                                            isGroupDragging ? styles.downloadDragHandleDragging : '',
                                                        )}
                                                        draggable={!isQueueMutationPending}
                                                        onDragStart={(event) => handleDragStart(event, group.id)}
                                                        onDragEnd={handleDragEnd}
                                                        onClick={stopQueueControlEvent}
                                                        aria-hidden="true"
                                                        title="Drag to reorder"
                                                    >
                                                        ⋮⋮
                                                    </div>
                                                </div>
                                            ) : null}
                                            {coverUrl ? (
                                                <img src={coverUrl} alt="" className={isVideo ? styles.downloadCoverVideo : styles.downloadCover} />
                                            ) : (
                                                <div className={isVideo ? styles.downloadCoverPlaceholderVideo : styles.downloadCoverPlaceholder}>
                                                    {isVideo ? <Video24 style={{ width: 16, height: 16 }} /> : <MusicNote224 style={{ width: 16, height: 16 }} />}
                                                </div>
                                            )}
                                            <div className={styles.downloadInfo}>
                                                <div className={mergeClasses(styles.downloadHeaderRow, styles.downloadHeaderRowInline)}>
                                                    <div className={mergeClasses(styles.downloadTitleRow, styles.downloadTitleRowInline)}>
                                                        <Text className={styles.downloadTitle} truncate data-queue-group-title={group.title}>{group.title}</Text>
                                                    </div>
                                                    <div className={mergeClasses(styles.downloadArtistMetaRow, styles.downloadArtistMetaRowInline)}>
                                                        <Text className={styles.downloadArtist} truncate>{group.artist}</Text>
                                                        <div className={mergeClasses(styles.downloadBadgeRow, styles.downloadBadgeRowInline)}>
                                                            {firstItem?.provider ? <ProviderMark provider={firstItem.provider} size={16} /> : null}
                                                            {group.quality ? <QualityBadge quality={group.quality} size="small" /> : null}
                                                            <MediaTypeBadge kind={group.type === 'video' ? 'video' : group.type === 'album' ? 'album' : 'track'} size="small" />
                                                        </div>
                                                    </div>
                                                </div>

                                                {isDownloading && prog && (
                                                    <div className={styles.downloadProgress}>
                                                        <div className={styles.progressBarWrapper}>
                                                            <ProgressBar
                                                                thickness="medium"
                                                                color="brand"
                                                                value={typeof prog.progress === "number" ? prog.progress / 100 : undefined}
                                                            />
                                                        </div>
                                                        <Text className={styles.progressText}>
                                                            {typeof prog.progress === "number"
                                                                ? `${prog.progress}%`
                                                                : null}
                                                            {(() => {
                                                                const catalogTotal = prog.tracks?.length || 0;
                                                                const total = catalogTotal > 0
                                                                    ? catalogTotal
                                                                    : (prog.totalFiles ?? null);
                                                                if (total == null || total <= 0) {
                                                                    return typeof prog.progress === "number" ? "" : "…";
                                                                }
                                                                const current = prog.currentFileNum != null
                                                                    ? Math.min(prog.currentFileNum, total)
                                                                    : null;
                                                                const prefix = typeof prog.progress === "number" ? " · " : "";
                                                                return `${prefix}${current ?? "…"}/${total} files`;
                                                            })()}
                                                        </Text>
                                                    </div>
                                                )}
                                            </div>
                                            {isFailed && (
                                                <Badge appearance="tint" color="danger" size="small">Failed</Badge>
                                            )}
                                            {!isDownloading && !isFailed && (
                                                isImportPending
                                                    ? (
                                                        <div className={styles.downloadStateIndicator} title="Waiting to import">
                                                            {renderPendingIndicator(styles)}
                                                        </div>
                                                      )
                                                    : renderPendingIndicator(styles)
                                            )}
                                            {isDownloading && (
                                                isImporting
                                                    ? (
                                                        <div className={styles.downloadStateIndicator} title="Importing">
                                                            <Spinner size="extra-tiny" aria-label="importing" />
                                                            <Text className={styles.downloadStatusText}>Importing</Text>
                                                        </div>
                                                      )
                                                    : (
                                                        <div className={styles.downloadStateIndicator} title="Downloading">
                                                            <Spinner size="extra-tiny" aria-label="downloading" />
                                                            <Text className={styles.downloadStatusText}>Downloading</Text>
                                                        </div>
                                                     )
                                            )}
                                            <div className={styles.downloadActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                                {isPendingReorderable ? (
                                                    <div className={styles.downloadReorderActions}>
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowUpload24 />}
                                                            aria-label={`Move ${group.title} to top`}
                                                            title="Move to top"
                                                            disabled={disableMoveTop}
                                                            onClick={() => { void handleGroupMove(group.id, 'top'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowUp24 />}
                                                            aria-label={`Move ${group.title} up`}
                                                            title="Move up"
                                                            disabled={disableMoveUp}
                                                            onClick={() => { void handleGroupMove(group.id, 'up'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowDown24 />}
                                                            aria-label={`Move ${group.title} down`}
                                                            title="Move down"
                                                            disabled={disableMoveDown}
                                                            onClick={() => { void handleGroupMove(group.id, 'down'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowDownload24 />}
                                                            aria-label={`Move ${group.title} to bottom`}
                                                            title="Move to bottom"
                                                            disabled={disableMoveBottom}
                                                            onClick={() => { void handleGroupMove(group.id, 'bottom'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Menu>
                                                            <MenuTrigger disableButtonEnhancement>
                                                                <Button
                                                                    size="small"
                                                                    appearance="subtle"
                                                                    icon={<MoreHorizontal24 />}
                                                                    aria-label={`Queue actions for ${group.title}`}
                                                                    disabled={isQueueMutationPending}
                                                                    className={styles.reorderMobileOnly}
                                                                />
                                                            </MenuTrigger>
                                                            <MenuPopover>
                                                                <MenuList>
                                                                    <MenuItem disabled={disableMoveTop} onClick={() => { void handleGroupMove(group.id, 'top'); }}>
                                                                        Move to top
                                                                    </MenuItem>
                                                                    <MenuItem disabled={disableMoveUp} onClick={() => { void handleGroupMove(group.id, 'up'); }}>
                                                                        Move up
                                                                    </MenuItem>
                                                                    <MenuItem disabled={disableMoveDown} onClick={() => { void handleGroupMove(group.id, 'down'); }}>
                                                                        Move down
                                                                    </MenuItem>
                                                                    <MenuItem disabled={disableMoveBottom} onClick={() => { void handleGroupMove(group.id, 'bottom'); }}>
                                                                        Send to bottom
                                                                    </MenuItem>
                                                                </MenuList>
                                                            </MenuPopover>
                                                        </Menu>
                                                    </div>
                                                ) : null}
                                                {isFailed && group.items.length === 1 && (
                                                    <Button
                                                        size="small"
                                                        appearance="subtle"
                                                        icon={<ArrowClockwise24 />}
                                                        aria-label={`Retry ${group.title}`}
                                                        onClick={() => retryItem(group.items[0].id)}
                                                    />
                                                )}
                                                <Button
                                                    size="small"
                                                    appearance="subtle"
                                                    icon={<Delete24 />}
                                                    aria-label={`Remove ${group.title} from queue`}
                                                    onClick={() => { void handleDeleteAction(group); }}
                                                />
                                            </div>
                                            {isFailed && groupError ? (
                                                <Text className={styles.downloadErrorText}>{groupError}</Text>
                                            ) : null}
                                        </div>

                                        {shouldRenderGroupedTrackRows && groupedTrackItems.map(item => {
                                            const itemProg = mergeProgressSnapshots(getEmbeddedQueueItemProgress(item), getProgress(item.id));
                                            const matchedTrack = group.type === 'album' ? findProgressTrackState(item.title, prog?.tracks, item.providerId) : undefined;
                                            const albumTrackIndex = group.type === 'album'
                                                ? (prog?.tracks?.findIndex((track) =>
                                                    matchesProviderTrackId(track.providerTrackId, item.providerId)
                                                    || matchesActiveTrack(track.title, item.title)) ?? -1)
                                                : -1;
                                            const inferredAlbumStatus = group.type === 'album' && prog?.tracks?.length
                                                ? inferAlbumTrackStatus(albumTrackIndex, prog, prog.tracks, matchedTrack?.status)
                                                : undefined;
                                            const derivedStatus = inferredAlbumStatus
                                                ?? matchedTrack?.status
                                                ?? (item.status === 'failed'
                                                    ? 'error'
                                                    : item.status === 'downloading' || item.status === 'started'
                                                        ? 'downloading'
                                                        : item.status === 'completed'
                                                            ? 'completed'
                                                            : 'queued');
                                            const isItemDownloading = derivedStatus === 'downloading';
                                            const isItemFailed = derivedStatus === 'error';
                                            const isItemCompleted = derivedStatus === 'completed';
                                            const isItemImportPhase = item.stage === 'import' || itemProg?.state === 'importing' || itemProg?.state === 'importPending' || prog?.state === 'importing' || prog?.state === 'importPending';
                                            const itemErrorMessage = item.error || (isItemFailed ? prog?.statusMessage : undefined);
                                            return (
                                                <div key={item.id} className={styles.downloadSubItem} data-queue-subitem-row="true" onClick={(e) => {
                                                    if ((e.target as HTMLElement).closest('button')) return;
                                                    const path = item.album_id ? `/album/${item.album_id}` : null;
                                                    if (path) navigate(path);
                                                }}>
                                                    <div className={styles.downloadTrackLead}>
                                                        <div className={styles.downloadStatusLead}>
                                                            {renderTrackStatusIndicator(styles, {
                                                                isFailed: isItemFailed,
                                                                isCompleted: isItemCompleted,
                                                                isActive: isItemDownloading,
                                                                isQueued: !isItemDownloading && !isItemFailed && !isItemCompleted,
                                                                phase: isItemImportPhase ? 'import' : 'download',
                                                            })}
                                                        </div>
                                                        <Text className={styles.downloadTrackNumber}>
                                                            {formatQueueTrackNumber(
                                                                item.currentTrackNum || matchedTrack?.trackNum,
                                                                item.currentVolumeNum || matchedTrack?.volumeNum,
                                                                prog?.tracks,
                                                            )}
                                                        </Text>
                                                    </div>
                                                    <div className={styles.downloadInfo}>
                                                        <Text className={mergeClasses(styles.downloadTitle, styles.downloadSubtleText)} truncate>{item.title || "Unknown Track"}</Text>
                                                        {isItemFailed && itemErrorMessage && (
                                                            <Text className={styles.downloadMeta} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                                                {itemErrorMessage}
                                                            </Text>
                                                        )}
                                                    </div>
                                                    <div className={styles.downloadActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                                        {isItemFailed && (
                                                            <Button size="small" appearance="subtle" icon={<ArrowClockwise24 />} onClick={() => retryItem(item.id)} />
                                                        )}
                                                        <Button size="small" appearance="subtle" icon={<Delete24 />} onClick={() => deleteItem(item.id)} />
                                                    </div>
                                                </div>
                                            );
                                        })}

                                        {group.type === 'album' && groupedTrackItems.length === 0 && isDownloading && prog && prog.tracks && prog.tracks.length > 0 && (
                                            <div>
                                                {prog.tracks.map((t, idx) => {
                                                    const tracks = prog.tracks || [];
                                                    const visualStatus = inferAlbumTrackStatus(idx, prog, tracks, t.status);
                                                    const isTrackDownloading = visualStatus === 'downloading';
                                                    const isTrackCompleted = visualStatus === 'completed';
                                                    const isTrackFailed = visualStatus === 'error';
                                                    const trackLabel = formatQueueTrackNumber(
                                                        t.trackNum,
                                                        t.volumeNum,
                                                        tracks,
                                                        idx + 1,
                                                    );

                                                    return (
                                                        <div key={idx} className={styles.downloadSubItem} onClick={() => { if (groupNavPath) navigate(groupNavPath); }}>
                                                            <div className={styles.downloadTrackLead}>
                                                                <div className={styles.downloadStatusLead}>
                                                                    {renderTrackStatusIndicator(styles, {
                                                                        isFailed: isTrackFailed,
                                                                        isCompleted: isTrackCompleted,
                                                                        isActive: isTrackDownloading,
                                                                        isQueued: visualStatus === 'queued',
                                                                        isSkipped: visualStatus === 'skipped',
                                                                        phase: isImporting ? 'import' : 'download',
                                                                    })}
                                                                </div>
                                                                <Text className={styles.downloadTrackNumber}>
                                                                    {trackLabel}
                                                                </Text>
                                                            </div>
                                                            <div className={styles.downloadInfo}>
                                                                <Text className={mergeClasses(styles.downloadTitle, styles.downloadSubtleText)} truncate>{t.title || "Unknown Track"}</Text>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {hasMoreActiveGroups ? (
                                <>
                                    <div ref={activeSentinelRef} aria-hidden="true" />
                                    <div className={styles.loadMoreRow}>
                                        <Button
                                            appearance="subtle"
                                            disabled={isLoadingMoreQueueItems}
                                            onClick={() => {
                                                if (hasMoreLocalActiveGroups) {
                                                    setVisibleActiveLimit(prev => prev + ACTIVE_PAGE_SIZE);
                                                } else if (hasMoreQueueItems) {
                                                    void loadMoreQueueItems();
                                                }
                                            }}
                                        >
                                            {isLoadingMoreQueueItems
                                                ? "Loading..."
                                                : hasMoreLocalActiveGroups
                                                    ? `Load more (${Math.max(0, groupedDownloads.length - visibleActiveLimit)} remaining)`
                                                    : "Load more"}
                                        </Button>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </section>
                ) : (
                    <section className={styles.queueSection} aria-label="Active">
                        <div className={styles.queueSectionHeader}>
                            <div className={styles.queueSectionHeading}>
                                <Subtitle2 className={styles.queueSectionTitle}>Active</Subtitle2>
                            </div>
                        </div>
                        {hasQueueRefreshError ? (
                            <ErrorState
                                title="Queue unavailable"
                                description={queueRefreshErrorMessage ?? "The queue feed did not finish loading."}
                                minHeight="220px"
                                actions={(
                                    <Button appearance="primary" onClick={() => { void handleRetryQueueFeeds(); }}>
                                        Retry
                                    </Button>
                                )}
                            />
                        ) : (
                            <EmptyState
                                title="No items in queue"
                                icon={<ArrowDownload24 />}
                                compactMobile
                            />
                        )}
                    </section>
                )}

                <QueueHistoryPanel
                    items={queueHistoryItems}
                    hasMore={hasMoreQueueHistory}
                    isLoadingMore={isLoadingMoreQueueHistory}
                    onLoadMore={() => { void loadMoreQueueHistory(); }}
                    hasRefreshError={hasQueueHistoryRefreshError}
                    refreshErrorMessage={queueHistoryRefreshErrorMessage}
                    onRetryFeeds={handleRetryQueueFeeds}
                    onRetryItem={retryItem}
                    filters={historyFilters}
                    onFiltersChange={setHistoryFilters}
                />
            </div>
        </div>
    );
};

export default QueueTab;
