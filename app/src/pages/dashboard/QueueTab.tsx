import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent, type TouchEvent as ReactTouchEvent } from "react";
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
    CheckmarkCircle24Filled,
    ErrorCircle24Filled,
    ArrowClockwise24Regular,
    Clock24Regular,
    Delete24Regular,
    MusicNote224Regular,
    Video24Regular,
    ArrowDownload24Regular,
    ArrowUpload24Regular,
    MoreHorizontal24Regular,
    ArrowUp24Regular,
    ArrowDown24Regular,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { useQueue } from "@/hooks/useQueue";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import type { QueueItemContract as QueueItem } from "@contracts/status";
import { useQueueHistoryFeed } from "@/hooks/useQueueHistoryFeed";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";
import { MediaTypeBadge } from "@/components/ui/MediaTypeBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { EmptyState } from "@/components/ui/ContentState";
import { QueueListSkeleton } from "@/components/ui/LoadingSkeletons";
import { getAlbumCover, getTidalImage } from "@/utils/tidalImages";
import { dispatchActivityRefresh } from "@/utils/appEvents";
import { useDashboardStyles } from "./dashboardStyles";
import { formatRelativeTime } from "./dashboardUtils";

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

function findProgressTrackState(
    trackTitle: string | null | undefined,
    tracks?: Array<{ title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }>,
) {
    if (!trackTitle || !tracks?.length) {
        return undefined;
    }

    return tracks.find((track) => matchesActiveTrack(track.title, trackTitle) || matchesActiveTrack(trackTitle, track.title));
}

function findActiveAlbumTrackIndex(
    progress: {
        currentFileNum?: number;
        currentTrack?: string | null;
        state?: string;
    } | undefined,
    tracks?: Array<{ title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }>,
): number {
    if (!tracks?.length) {
        return -1;
    }

    if (progress?.currentTrack) {
        const matchedIndex = tracks.findIndex((track) => matchesActiveTrack(track.title, progress.currentTrack));
        if (matchedIndex >= 0) {
            return matchedIndex;
        }
    }

    if ((progress?.state === 'downloading' || progress?.state === 'failed') && typeof progress.currentFileNum === 'number' && progress.currentFileNum > 0) {
        return Math.min(tracks.length - 1, Math.max(0, progress.currentFileNum - 1));
    }

    return -1;
}

function inferAlbumTrackStatus(
    trackIndex: number,
    progress: {
        currentFileNum?: number;
        currentTrack?: string | null;
        trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
        state?: string;
    } | undefined,
    tracks: Array<{ title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' }>,
    persistedStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped',
): 'queued' | 'downloading' | 'completed' | 'error' | 'skipped' {
    if (persistedStatus && persistedStatus !== 'queued') {
        return persistedStatus;
    }

    if (progress?.state === 'completed') {
        return 'completed';
    }

    const activeTrackIndex = findActiveAlbumTrackIndex(progress, tracks);
    const completedThreshold = typeof progress?.currentFileNum === 'number'
        ? Math.max(0, progress.currentFileNum - 1)
        : 0;

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

        if (progress?.state === 'downloading' || progress?.trackStatus === 'downloading' || progress?.currentTrack) {
            return 'downloading';
        }
    }

    return persistedStatus ?? 'queued';
}

function renderPendingIndicator(styles: ReturnType<typeof useDashboardStyles>) {
    return <Clock24Regular className={styles.downloadStatusPendingIcon} />;
}

function renderTrackStatusIndicator(
    styles: ReturnType<typeof useDashboardStyles>,
    options: {
        isFailed?: boolean;
        isCompleted?: boolean;
        isDownloading?: boolean;
        isImporting?: boolean;
        isQueued?: boolean;
        isSkipped?: boolean;
    },
) {
    if (options.isFailed) {
        return <ErrorCircle24Filled className={styles.downloadStatusErrorIcon} />;
    }

    if (options.isCompleted) {
        return <CheckmarkCircle24Filled className={styles.downloadStatusCompleteIcon} />;
    }

    if (options.isDownloading) {
        return <Spinner size="extra-tiny" aria-label={options.isImporting ? 'importing' : 'downloading'} />;
    }

    if (options.isSkipped) {
        return null;
    }

    if (options.isQueued) {
        return renderPendingIndicator(styles);
    }

    return null;
}

function getTrackStatusText(options: {
    isImporting?: boolean;
    isSkipped?: boolean;
}) {
    if (options.isImporting) {
        return 'importing';
    }

    if (options.isSkipped) {
        return 'skipped';
    }

    return null;
}

function getMovablePendingJobIds(
    items: Array<{ id: number; status: string; stage?: string }>,
): number[] {
    return items
        .filter((item) => item.status === 'pending' && item.stage !== 'import')
        .map((item) => item.id);
}

function renderHistoryStatusIndicator(
    styles: ReturnType<typeof useDashboardStyles>,
    status?: string,
    error?: string | null,
) {
    if (error || status === "failed") {
        return <ErrorCircle24Filled className={styles.downloadStatusErrorIcon} />;
    }

    if (status === "completed") {
        return <CheckmarkCircle24Filled className={styles.downloadStatusCompleteIcon} />;
    }

    return <Clock24Regular className={styles.downloadStatusPendingIcon} />;
}

function getOptionalIdentifier(value: unknown): string | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }

    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildAlbumNavPath(albumId: unknown): string | null {
    const resolvedAlbumId = getOptionalIdentifier(albumId);
    return resolvedAlbumId ? `/album/${resolvedAlbumId}` : null;
}

function buildVideoNavPath(videoId: unknown): string | null {
    const resolvedVideoId = getOptionalIdentifier(videoId);
    return resolvedVideoId ? `/video/${resolvedVideoId}` : null;
}

function getQueueGroupNavPath(groupType: QueueItem['type'], firstItem?: QueueItem): string | null {
    if (!firstItem) {
        return null;
    }

    if (groupType === 'video') {
        return buildVideoNavPath(firstItem.tidalId);
    }

    if (groupType === 'album') {
        return buildAlbumNavPath(firstItem.type === 'album' ? firstItem.tidalId : firstItem.album_id);
    }

    return buildAlbumNavPath(firstItem.album_id);
}

function getQueueHistoryNavPath(item: QueueItem): string | null {
    if (item.type === 'video') {
        return buildVideoNavPath(item.tidalId);
    }

    if (item.type === 'album') {
        return buildAlbumNavPath(item.tidalId ?? item.album_id);
    }

    if (item.type === 'track') {
        return buildAlbumNavPath(item.album_id);
    }

    return null;
}

function isInteractiveElementTarget(target: EventTarget | null): target is HTMLElement {
    return target instanceof HTMLElement
        && Boolean(target.closest('button,a,input,label,[role="menuitem"],[data-queue-control="true"]'));
}

type QueueHistoryMediaBadge = {
    kind: 'album' | 'track' | 'video';
    label?: string;
};

type QueueHistoryRowModel = {
    title: string;
    subtitle: string | null;
    coverUrl: string | null;
    isVideo: boolean;
    mediaBadge: QueueHistoryMediaBadge | null;
    navPath: string | null;
    quality: string | null;
    timeLabel: string;
    error: string | null;
};

function getQueueHistoryMediaBadge(item: QueueItem): QueueHistoryMediaBadge | null {
    switch (item.type) {
        case 'album':
            return { kind: 'album' };
        case 'video':
            return { kind: 'video' };
        case 'playlist':
            return { kind: 'track', label: 'Playlist' };
        case 'track':
            return { kind: 'track' };
        default:
            return null;
    }
}

function mapQueueHistoryItemToRow(item: QueueItem): QueueHistoryRowModel {
    const mediaBadge = getQueueHistoryMediaBadge(item);
    const title = item.title || item.album_title || 'Unknown item';
    const subtitle = item.artist || null;
    const coverUrl = item.cover
        ? mediaBadge?.kind === 'video'
            ? getTidalImage(item.cover, 'video', 'small')
            : getAlbumCover(item.cover, 'small')
        : null;
    const navPath = getQueueHistoryNavPath(item);
    const timeSource = item.completed_at || item.updated_at || item.started_at || item.created_at;

    return {
        title,
        subtitle,
        coverUrl,
        isVideo: mediaBadge?.kind === 'video',
        mediaBadge,
        navPath,
        quality: item.quality ?? null,
        timeLabel: formatRelativeTime(timeSource),
        error: item.error ?? null,
    };
}

type ReorderableQueueItem = {
    id: number;
    status: string;
    stage?: string;
};

type QueueGroup = {
    id: string;
    title: string;
    artist: string;
    cover: string | null;
    type: QueueItem['type'];
    quality: string | null;
    items: QueueItem[];
    status: 'downloading' | 'pending' | 'failed';
    sortIndex: number;
};

type GroupMoveAction = 'top' | 'up' | 'down' | 'bottom';
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
    return group.status === 'pending' && getMovablePendingJobIds(group.items).length === group.items.length;
}

function getGroupFirstJobId(group: { items: ReorderableQueueItem[] }): number | undefined {
    return getMovablePendingJobIds(group.items)[0];
}

function getGroupLastJobId(group: { items: ReorderableQueueItem[] }): number | undefined {
    const jobIds = getMovablePendingJobIds(group.items);
    return jobIds.at(-1);
}

function flattenPendingGroupJobIds(groups: Array<{ items: ReorderableQueueItem[] }>): number[] {
    return groups.flatMap((group) => getMovablePendingJobIds(group.items));
}

function buildSingleGroupMoveRequest(
    groups: QueueGroup[],
    movingGroupId: string,
    action: GroupMoveAction,
): { jobIds: number[]; beforeJobId?: number; afterJobId?: number } | null {
    const currentIndex = groups.findIndex((group) => group.id === movingGroupId);
    if (currentIndex < 0) {
        return null;
    }

    const movingGroup = groups[currentIndex];
    const jobIds = getMovablePendingJobIds(movingGroup.items);
    if (jobIds.length === 0) {
        return null;
    }

    if (action === 'top') {
        if (currentIndex === 0) {
            return null;
        }

        const targetJobId = getGroupFirstJobId(groups[0]);
        return targetJobId ? { jobIds, beforeJobId: targetJobId } : null;
    }

    if (action === 'up') {
        if (currentIndex <= 0) {
            return null;
        }

        const targetJobId = getGroupFirstJobId(groups[currentIndex - 1]);
        return targetJobId ? { jobIds, beforeJobId: targetJobId } : null;
    }

    if (action === 'down') {
        if (currentIndex >= groups.length - 1) {
            return null;
        }

        const targetJobId = getGroupLastJobId(groups[currentIndex + 1]);
        return targetJobId ? { jobIds, afterJobId: targetJobId } : null;
    }

    if (currentIndex >= groups.length - 1) {
        return null;
    }

    const targetJobId = getGroupLastJobId(groups[groups.length - 1]);
    return targetJobId ? { jobIds, afterJobId: targetJobId } : null;
}

function buildBulkEdgeMoveRequest(
    groups: QueueGroup[],
    movingGroupIds: string[],
    action: 'top' | 'bottom',
): { jobIds: number[]; beforeJobId?: number; afterJobId?: number } | null {
    const movingGroupIdSet = new Set(movingGroupIds);
    const selectedGroups = groups.filter((group) => movingGroupIdSet.has(group.id));
    const remainingGroups = groups.filter((group) => !movingGroupIdSet.has(group.id));

    if (selectedGroups.length === 0 || remainingGroups.length === 0) {
        return null;
    }

    const jobIds = flattenPendingGroupJobIds(selectedGroups);
    if (jobIds.length === 0) {
        return null;
    }

    if (action === 'top') {
        const targetJobId = getGroupFirstJobId(remainingGroups[0]);
        return targetJobId ? { jobIds, beforeJobId: targetJobId } : null;
    }

    const targetJobId = getGroupLastJobId(remainingGroups[remainingGroups.length - 1]);
    return targetJobId ? { jobIds, afterJobId: targetJobId } : null;
}

const QueueTab = () => {
    const styles = useDashboardStyles();
    const navigate = useNavigate();
    const {
        queueItems: downloadQueue,
        isQueueInitialLoading: loading,
        refetch: refreshQueue,
    } = useQueue();
    const {
        getProgress,
        retryItem,
        deleteItem,
        reorderItems,
    } = useQueueStatus();
    const {
        queueHistoryItems,
        hasMoreQueueHistory,
        isLoadingMoreQueueHistory,
        loadMoreQueueHistory,
        isQueueHistoryInitialLoading,
    } = useQueueHistoryFeed();
    const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    const [busyGroupIds, setBusyGroupIds] = useState<string[]>([]);
    const [activeBulkAction, setActiveBulkAction] = useState<string | null>(null);
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeSentinelRef = useRef<HTMLDivElement | null>(null);
    const historySentinelRef = useRef<HTMLDivElement | null>(null);

    const groupedDownloads = useMemo(() => {
        const activeDownloads = downloadQueue.filter(i => i.status === 'downloading' || i.status === 'processing');
        const pendingDownloads = downloadQueue.filter(i => i.status === 'pending');
        const failedDownloads = downloadQueue.filter(i => i.status === 'failed');
        const filteredQueue = [...activeDownloads, ...pendingDownloads, ...failedDownloads];

        const albumTrackCounts = new Map<string, number>();

        filteredQueue.forEach((item) => {
            if (item.type === 'track' && item.album_id) {
                albumTrackCounts.set(item.album_id, (albumTrackCounts.get(item.album_id) ?? 0) + 1);
            }
        });

        const groups: Record<string, QueueGroup> = {};

        filteredQueue.forEach((item, index) => {
            const isAlbum = item.type === 'album';
            const isVideo = item.type === 'video';
            const shouldGroupTrackAsAlbum = item.type === 'track'
                && Boolean(item.album_id)
                && (albumTrackCounts.get(item.album_id as string) ?? 0) > 1;
            const groupId = isAlbum
                ? `album-${item.tidalId}`
                : isVideo
                    ? `video-${item.tidalId}`
                    : shouldGroupTrackAsAlbum
                        ? `album-${item.album_id}`
                        : `track-${item.tidalId}`;

            if (!groups[groupId]) {
                const groupType = isAlbum
                    ? 'album'
                    : isVideo
                        ? 'video'
                        : shouldGroupTrackAsAlbum
                            ? 'album'
                            : 'track';
                groups[groupId] = {
                    id: groupId,
                    title: groupType === 'album'
                        ? (isAlbum ? item.title || "Unknown Album" : item.album_title || item.title || "Unknown Album")
                        : item.title || "Unknown Track",
                    artist: item.artist || "Unknown",
                    cover: item.cover || null,
                    type: groupType,
                    quality: item.quality ?? null,
                    items: [],
                    status: (item.status === 'downloading' || item.status === 'processing') ? 'downloading' : item.status === 'failed' ? 'failed' : 'pending',
                    sortIndex: index,
                };
            }

            if (item.status === 'downloading' || item.status === 'processing') {
                groups[groupId].status = 'downloading';
            } else if (item.status === 'failed' && groups[groupId].status !== 'downloading') {
                groups[groupId].status = 'failed';
            }

            if (!groups[groupId].quality && item.quality) {
                groups[groupId].quality = item.quality;
            }

            groups[groupId].items.push(item);
        });

        return Object.values(groups).sort((a, b) => {
            const aActiveItem = a.items.find(i => i.status === 'downloading' || i.status === 'processing');
            const bActiveItem = b.items.find(i => i.status === 'downloading' || i.status === 'processing');
            const rankGroup = (group: QueueGroup, activeItem?: QueueItem) => {
                if (group.status === 'downloading' && activeItem?.stage === 'import') return 0;
                if (group.status === 'pending' && group.items[0]?.stage === 'import') return 1;
                if (group.status === 'downloading') return 2;
                if (group.status === 'pending') return 3;
                return 4;
            };
            const rankDiff = rankGroup(a, aActiveItem) - rankGroup(b, bActiveItem);
            if (rankDiff !== 0) return rankDiff;
            return a.sortIndex - b.sortIndex;
        });
    }, [downloadQueue]);

    const ACTIVE_PAGE_SIZE = 25;
    const [visibleActiveLimit, setVisibleActiveLimit] = useState(ACTIVE_PAGE_SIZE);
    const visibleGroupedDownloads = useMemo(
        () => groupedDownloads.slice(0, visibleActiveLimit),
        [groupedDownloads, visibleActiveLimit],
    );
    const hasMoreActiveGroups = groupedDownloads.length > visibleActiveLimit;

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
                        setVisibleActiveLimit((prev) => prev + ACTIVE_PAGE_SIZE);
                    }
                    if (entry.target === historySentinelRef.current && hasMoreQueueHistory && !isLoadingMoreQueueHistory) {
                        void loadMoreQueueHistory();
                    }
                }
            },
            { rootMargin: "200px" },
        );

        const activeSentinel = activeSentinelRef.current;
        const historySentinel = historySentinelRef.current;
        if (activeSentinel) observer.observe(activeSentinel);
        if (historySentinel) observer.observe(historySentinel);

        return () => observer.disconnect();
    }, [hasMoreActiveGroups, hasMoreQueueHistory, isLoadingMoreQueueHistory, loadMoreQueueHistory]);

    const pendingReorderGroups = useMemo(
        () => groupedDownloads.filter((group) => isPendingReorderableGroup(group)),
        [groupedDownloads],
    );
    const pendingGroupSelection = useSelectableCollection({
        items: pendingReorderGroups,
        getItemId: (group) => group.id,
    });
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
    const canMoveSelectedBottom = selectedPendingCount > 0 && !isSelectedBlockAtBottom;
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
        if (!isPendingReorderableGroup(groupedDownloads.find((g) => g.id === groupId))) return;
        e.preventDefault();
        enterSelectionMode(groupId);
    }, [groupedDownloads, enterSelectionMode]);

    const handleGroupTouchStart = useCallback((_e: ReactTouchEvent, groupId: string) => {
        if (!isPendingReorderableGroup(groupedDownloads.find((g) => g.id === groupId))) return;
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

    const stopQueueControlEvent = (event: SyntheticEvent<HTMLElement>) => {
        event.stopPropagation();
    };

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

        await withBusyGroups([groupId], null, async () => {
            await reorderItems(reorderRequest);
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

        await withBusyGroups(selectedPendingGroupIds, action === 'top' ? 'move-top' : 'move-bottom', async () => {
            await reorderItems(reorderRequest);
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

                await reorderItems(
                    direction === 'up'
                        ? { jobIds, beforeJobId: anchorJobId }
                        : { jobIds, afterJobId: anchorJobId },
                    { refresh: false, dispatchActivity: false },
                );
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

        await withBusyGroups(movingGroupIds, null, async () => {
            await reorderItems(position === 'before'
                ? { jobIds, beforeJobId: anchorJobId }
                : { jobIds, afterJobId: anchorJobId });
        });
    };

    const handleDragEnd = () => {
        setDraggingGroupId(null);
        setDropTarget(null);
    };

    const hasQueueRows = groupedDownloads.length > 0;
    const hasHistoryRows = queueHistoryItems.length > 0;

    if ((loading && !hasQueueRows) || (!hasQueueRows && isQueueHistoryInitialLoading)) {
        return (
            <div className={styles.tabSection}>
                <QueueListSkeleton rows={6} />
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
                                const coverUrl = group.cover ? (isVideo ? getTidalImage(group.cover, 'video', 'small') : getAlbumCover(group.cover, 'small')) : null;
                                const isDownloading = group.status === 'downloading';
                                const isFailed = group.status === 'failed';

                                const activeItem = group.items.find(i => i.status === 'downloading' || i.status === 'processing');
                                const firstItem = group.items[0];
                                const prog = activeItem ? getProgress(activeItem.id) : firstItem ? getProgress(firstItem.id) : undefined;
                                const activeStage = activeItem?.stage || firstItem?.stage;
                                const isImporting = isDownloading && (activeStage === 'import' || prog?.state === 'importing');
                                const isImportPending = !isDownloading && !isFailed && activeStage === 'import';
                                const shouldRenderGroupedTrackRows = (group.items.length > 1)
                                    || (group.items.length === 1 && group.items[0].type === 'track' && group.type === 'album');
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
                                const disableMoveBottom = isQueueMutationPending || (useSelectionActionState ? !canMoveSelectedBottom : isLastPendingGroup);

                                const handleGroupClick = (e: ReactMouseEvent) => {
                                    if (isInteractiveElementTarget(e.target)) return;
                                    if (isSelectionMode && isPendingReorderable) {
                                        pendingGroupSelection.setSelectedRowIds((current) => {
                                            const currentIds = current.map((rowId) => String(rowId));
                                            if (currentIds.includes(group.id)) {
                                                return current.filter((rowId) => String(rowId) !== group.id);
                                            }
                                            return [...current, group.id];
                                        });
                                        return;
                                    }
                                    if (groupNavPath) navigate(groupNavPath);
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
                                            onClick={handleGroupClick}
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
                                                            onChange={(_, data) => {
                                                                pendingGroupSelection.setSelectedRowIds((current) => {
                                                                    const currentIds = current.map((rowId) => String(rowId));
                                                                    if (data.checked) {
                                                                        return currentIds.includes(group.id) ? current : [...current, group.id];
                                                                    }

                                                                    return current.filter((rowId) => String(rowId) !== group.id);
                                                                });
                                                            }}
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
                                                    {isVideo ? <Video24Regular style={{ width: 16, height: 16 }} /> : <MusicNote224Regular style={{ width: 16, height: 16 }} />}
                                                </div>
                                            )}
                                            <div className={styles.downloadInfo}>
                                                <div className={mergeClasses(
                                                    styles.downloadHeaderRow,
                                                    (isDownloading || isImportPending) ? styles.downloadHeaderRowInline : '',
                                                )}>
                                                    <div className={styles.downloadTitleRow}>
                                                        <Text className={styles.downloadTitle} truncate data-queue-group-title={group.title}>{group.title}</Text>
                                                    </div>
                                                    <div className={mergeClasses(
                                                        styles.downloadArtistMetaRow,
                                                        (isDownloading || isImportPending) ? styles.downloadArtistMetaRowInline : '',
                                                    )}>
                                                        <Text className={styles.downloadArtist} truncate>{group.artist}</Text>
                                                        <div className={mergeClasses(
                                                            styles.downloadBadgeRow,
                                                            (isDownloading || isImportPending) ? styles.downloadBadgeRowInline : '',
                                                        )}>
                                                            <MediaTypeBadge kind={group.type === 'video' ? 'video' : group.type === 'album' ? 'album' : 'track'} size="small" />
                                                            {group.quality ? <QualityBadge quality={group.quality} size="small" /> : null}
                                                        </div>
                                                    </div>
                                                </div>

                                                {isDownloading && prog && (
                                                    <div className={styles.downloadProgress}>
                                                        <div className={styles.progressBarWrapper}>
                                                            <ProgressBar
                                                                thickness="medium"
                                                                color="brand"
                                                                value={prog.progress !== undefined ? prog.progress / 100 : undefined}
                                                            />
                                                        </div>
                                                        <Text className={styles.progressText}>
                                                            {prog.progress !== undefined ? `${prog.progress}%` : "…"}
                                                        </Text>
                                                    </div>
                                                )}

                                                {isDownloading && prog && group.type === 'album' && prog.currentFileNum !== undefined && prog.totalFiles !== undefined && (
                                                    <Text className={styles.downloadMeta}>
                                                        {`${prog.currentFileNum}/${prog.totalFiles} files`}
                                                    </Text>
                                                )}

                                                {isFailed && groupError && (
                                                    <Text className={styles.downloadMeta} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                                        {groupError}
                                                    </Text>
                                                )}
                                            </div>
                                            {isFailed && (
                                                <Badge appearance="tint" color="danger" size="small">Failed</Badge>
                                            )}
                                            {!isDownloading && !isFailed && (
                                                isImportPending
                                                    ? <Text className={styles.downloadStatusText}>waiting to import</Text>
                                                    : renderPendingIndicator(styles)
                                            )}
                                            {isDownloading && (
                                                isImporting
                                                    ? <Text className={styles.downloadStatusText}>importing</Text>
                                                    : (
                                                        <div className={styles.downloadStateIndicator}>
                                                            <Spinner size="extra-tiny" />
                                                        </div>
                                                    )
                                            )}
                                            <div className={styles.downloadActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                                {isPendingReorderable ? (
                                                    <div className={styles.downloadReorderActions}>
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowUpload24Regular />}
                                                            aria-label={`Move ${group.title} to top`}
                                                            title="Move to top"
                                                            disabled={disableMoveTop}
                                                            onClick={() => { void handleGroupMove(group.id, 'top'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowUp24Regular />}
                                                            aria-label={`Move ${group.title} up`}
                                                            title="Move up"
                                                            disabled={disableMoveUp}
                                                            onClick={() => { void handleGroupMove(group.id, 'up'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowDown24Regular />}
                                                            aria-label={`Move ${group.title} down`}
                                                            title="Move down"
                                                            disabled={disableMoveDown}
                                                            onClick={() => { void handleGroupMove(group.id, 'down'); }}
                                                            className={styles.reorderDesktopOnly}
                                                        />
                                                        <Button
                                                            size="small"
                                                            appearance="subtle"
                                                            icon={<ArrowDownload24Regular />}
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
                                                                    icon={<MoreHorizontal24Regular />}
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
                                                    <Button size="small" appearance="subtle" icon={<ArrowClockwise24Regular />} onClick={() => retryItem(group.items[0].id)} />
                                                )}
                                                <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => { void handleDeleteAction(group); }} />
                                            </div>
                                        </div>

                                        {shouldRenderGroupedTrackRows && group.items.map(item => {
                                            const itemProg = getProgress(item.id);
                                            const matchedTrack = group.type === 'album' ? findProgressTrackState(item.title, prog?.tracks) : undefined;
                                            const albumTrackIndex = group.type === 'album'
                                                ? (prog?.tracks?.findIndex((track) => matchesActiveTrack(track.title, item.title)) ?? -1)
                                                : -1;
                                            const inferredAlbumStatus = group.type === 'album' && prog?.tracks?.length
                                                ? inferAlbumTrackStatus(albumTrackIndex, prog, prog.tracks, matchedTrack?.status)
                                                : undefined;
                                            const derivedStatus = inferredAlbumStatus
                                                ?? matchedTrack?.status
                                                ?? (item.status === 'failed'
                                                    ? 'error'
                                                    : item.status === 'downloading' || item.status === 'processing'
                                                        ? 'downloading'
                                                        : item.status === 'completed'
                                                            ? 'completed'
                                                            : 'queued');
                                            const isItemDownloading = derivedStatus === 'downloading';
                                            const isItemFailed = derivedStatus === 'error';
                                            const isItemCompleted = derivedStatus === 'completed';
                                            const isItemImporting = isItemDownloading && (item.stage === 'import' || itemProg?.state === 'importing');
                                            const itemStatusText = getTrackStatusText({
                                                isImporting: isItemImporting,
                                            });
                                            const isCurrentAlbumTrack = group.type === 'album'
                                                && (matchesActiveTrack(item.title, prog?.currentTrack)
                                                    || (prog?.tracks?.length ? findActiveAlbumTrackIndex(prog, prog.tracks) === albumTrackIndex : false));
                                            const itemProgressValue = isCurrentAlbumTrack
                                                ? prog?.trackProgress
                                                : itemProg?.progress;
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
                                                                isDownloading: isItemDownloading,
                                                                isImporting: isItemImporting,
                                                                isQueued: !isItemDownloading && !isItemFailed && !isItemCompleted,
                                                            })}
                                                        </div>
                                                    </div>
                                                    <div className={styles.downloadInfo}>
                                                        <Text className={mergeClasses(styles.downloadTitle, styles.downloadSubtleText)} truncate>{item.title || "Unknown Track"}</Text>
                                                        {itemStatusText ? (
                                                            <Text className={styles.downloadSubItemStatusText} data-queue-track-status={itemStatusText}>
                                                                {itemStatusText}
                                                            </Text>
                                                        ) : null}
                                                        {isItemDownloading && itemProgressValue !== undefined && (
                                                            <div className={styles.downloadProgress}>
                                                                <div className={styles.progressBarWrapper}>
                                                                    <ProgressBar
                                                                        thickness="medium"
                                                                        color="brand"
                                                                        value={itemProgressValue / 100}
                                                                    />
                                                                </div>
                                                                <Text className={styles.progressText}>
                                                                    {`${itemProgressValue}%`}
                                                                </Text>
                                                            </div>
                                                        )}
                                                        {isItemFailed && itemErrorMessage && (
                                                            <Text className={styles.downloadMeta} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                                                {itemErrorMessage}
                                                            </Text>
                                                        )}
                                                    </div>
                                                    <div className={styles.downloadActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                                        {isItemFailed && (
                                                            <Button size="small" appearance="subtle" icon={<ArrowClockwise24Regular />} onClick={() => retryItem(item.id)} />
                                                        )}
                                                        <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => deleteItem(item.id)} />
                                                    </div>
                                                </div>
                                            );
                                        })}

                                        {group.type === 'album' && group.items.length === 1 && (prog?.tracks?.length ?? 0) > 0 && (
                                            <div>
                                                {prog!.tracks!.map((t, idx) => {
                                                    const visualStatus = inferAlbumTrackStatus(idx, prog, prog.tracks, t.status);
                                                    const isTrackDownloading = visualStatus === 'downloading';
                                                    const isTrackCompleted = visualStatus === 'completed';
                                                    const isTrackFailed = visualStatus === 'error';
                                                    const trackStatusText = getTrackStatusText({
                                                        isSkipped: visualStatus === 'skipped',
                                                    });
                                                    const shouldShowTrackProgress = isTrackDownloading
                                                        && prog.trackProgress !== undefined
                                                        && (matchesActiveTrack(t.title, prog.currentTrack) || findActiveAlbumTrackIndex(prog, prog.tracks) === idx);

                                                    return (
                                                        <div key={idx} className={styles.downloadSubItem} onClick={() => { if (groupNavPath) navigate(groupNavPath); }}>
                                                            <div className={styles.downloadTrackLead}>
                                                                <div className={styles.downloadStatusLead}>
                                                                    {renderTrackStatusIndicator(styles, {
                                                                        isFailed: isTrackFailed,
                                                                        isCompleted: isTrackCompleted,
                                                                        isDownloading: isTrackDownloading,
                                                                        isQueued: visualStatus === 'queued',
                                                                        isSkipped: visualStatus === 'skipped',
                                                                    })}
                                                                </div>
                                                                <Text className={styles.downloadTrackNumber}>
                                                                    {t.trackNum || idx + 1}
                                                                </Text>
                                                            </div>
                                                            <div className={styles.downloadInfo}>
                                                                <Text className={mergeClasses(styles.downloadTitle, styles.downloadSubtleText)} truncate>{t.title || "Unknown Track"}</Text>
                                                                {trackStatusText ? (
                                                                    <Text className={styles.downloadSubItemStatusText} data-queue-track-status={trackStatusText}>
                                                                        {trackStatusText}
                                                                    </Text>
                                                                ) : null}
                                                                {shouldShowTrackProgress && (
                                                                    <div className={styles.downloadProgress}>
                                                                        <div className={styles.progressBarWrapper}>
                                                                            <ProgressBar
                                                                                thickness="medium"
                                                                                color="brand"
                                                                                value={prog.trackProgress / 100}
                                                                            />
                                                                        </div>
                                                                        <Text className={styles.progressText}>
                                                                            {`${prog.trackProgress}%`}
                                                                        </Text>
                                                                    </div>
                                                                )}
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
                                        <Button appearance="subtle" onClick={() => setVisibleActiveLimit(prev => prev + ACTIVE_PAGE_SIZE)}>
                                            Load more ({groupedDownloads.length - visibleActiveLimit} remaining)
                                        </Button>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </section>
                ) : (
                    <section className={styles.queueSection} aria-label="Active">
                        <EmptyState
                            title="No items in queue"
                            description="Browse your library and download albums, or enable monitoring to automate downloads."
                            icon={<ArrowDownload24Regular />}
                        />
                    </section>
                )}

                {hasHistoryRows ? (
                    <section className={styles.queueSection} aria-label="Queue history">
                        <div className={styles.queueSectionHeader}>
                            <div className={styles.queueSectionHeading}>
                                <Subtitle2 className={styles.queueSectionTitle}>History</Subtitle2>
                            </div>
                        </div>
                        <div className={styles.downloadList}>
                            {queueHistoryItems.map((item) => {
                                const row = mapQueueHistoryItemToRow(item);
                                const isVideo = row.isVideo;
                                const isFailed = item.status === 'failed' || Boolean(item.error);

                                const handleHistoryRowClick = (event: ReactMouseEvent<HTMLDivElement>) => {
                                    if (!row.navPath || isInteractiveElementTarget(event.target)) {
                                        return;
                                    }

                                    navigate(row.navPath);
                                };
                                const handleHistoryRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
                                    if (!row.navPath || isInteractiveElementTarget(event.target)) {
                                        return;
                                    }

                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        navigate(row.navPath);
                                    }
                                };

                                return (
                                    <div
                                        key={`queue-history-${String(item.id)}`}
                                        className={mergeClasses(
                                            styles.downloadItem,
                                            styles.queueHistoryItem,
                                            row.navPath ? styles.queueHistoryItemClickable : styles.queueHistoryItemStatic,
                                        )}
                                        onClick={row.navPath ? handleHistoryRowClick : undefined}
                                        onKeyDown={row.navPath ? handleHistoryRowKeyDown : undefined}
                                        role={row.navPath ? 'link' : undefined}
                                        tabIndex={row.navPath ? 0 : undefined}
                                        aria-label={row.navPath ? `Open ${row.title}` : undefined}
                                    >
                                        {row.coverUrl ? (
                                            <img src={row.coverUrl} alt="" className={isVideo ? styles.downloadCoverVideo : styles.downloadCover} />
                                        ) : (
                                            <div className={isVideo ? styles.downloadCoverPlaceholderVideo : styles.downloadCoverPlaceholder}>
                                                {isVideo
                                                    ? <Video24Regular style={{ width: 16, height: 16 }} />
                                                    : <MusicNote224Regular style={{ width: 16, height: 16 }} />}
                                            </div>
                                        )}
                                        <div className={styles.downloadInfo}>
                                            <div className={styles.downloadHeaderRow}>
                                                <div className={styles.downloadTitleRow}>
                                                    <Text className={styles.downloadTitle} truncate>{row.title}</Text>
                                                </div>
                                                <div className={styles.downloadArtistMetaRow}>
                                                    {row.subtitle ? (
                                                        <Text className={styles.downloadArtist} truncate>{row.subtitle}</Text>
                                                    ) : null}
                                                    <div className={styles.downloadBadgeRow}>
                                                        {row.mediaBadge ? (
                                                            <MediaTypeBadge kind={row.mediaBadge.kind} label={row.mediaBadge.label} size="small" />
                                                        ) : null}
                                                        {row.quality ? <QualityBadge quality={row.quality} size="small" /> : null}
                                                    </div>
                                                </div>
                                            </div>
                                            {row.error ? (
                                                <Text className={styles.queueHistoryErrorText}>{row.error}</Text>
                                            ) : null}
                                        </div>
                                        <div className={styles.queueHistoryTrailing}>
                                            <Text className={styles.queueHistoryTime}>{row.timeLabel}</Text>
                                            <div className={styles.queueHistoryStatus}>
                                                {renderHistoryStatusIndicator(styles, item.status, item.error)}
                                            </div>
                                        </div>
                                        <div className={styles.downloadActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                            {isFailed ? (
                                                <Button size="small" appearance="subtle" icon={<ArrowClockwise24Regular />} onClick={() => retryItem(item.id)} title="Retry" />
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            })}
                            {hasMoreQueueHistory ? (
                                <>
                                    <div ref={historySentinelRef} aria-hidden="true" />
                                    <div className={styles.loadMoreRow}>
                                        <Button appearance="subtle" onClick={() => void loadMoreQueueHistory()} disabled={isLoadingMoreQueueHistory}>
                                            {isLoadingMoreQueueHistory ? "Loading..." : "Load more"}
                                        </Button>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </section>
                ) : null}
            </div>
        </div>
    );
};

export default QueueTab;
