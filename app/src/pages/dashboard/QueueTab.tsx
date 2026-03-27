import { useMemo, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from "react";
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
    MoreHorizontal24Regular,
    ArrowUp24Regular,
    ArrowDown24Regular,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { LibrarySelectionBar } from "@/components/library/LibrarySelectionBar";
import { useDownloadQueue, type QueueItem } from "@/hooks/useDownloadQueue";
import { useQueueHistoryFeed } from "@/hooks/useQueueHistoryFeed";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";
import type { ActivityJobContract as ActivityJob } from "@contracts/status";
import { MediaTypeBadge } from "@/components/ui/MediaTypeBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { EmptyState } from "@/components/ui/ContentState";
import { TrackListSkeleton } from "@/components/ui/LoadingSkeletons";
import { getAlbumCover, getTidalImage } from "@/utils/tidalImages";
import { useDashboardStyles } from "./dashboardStyles";
import {
    formatJobDescription,
    formatJobType,
    formatRelativeTime,
    getActivityTypeIcon,
} from "./dashboardUtils";

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

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function getOptionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getOptionalIdentifier(value: unknown): string | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }

    return getOptionalString(value);
}

function getRecordIdentifier(record: Record<string, unknown> | null, ...keys: string[]): string | null {
    for (const key of keys) {
        const value = getOptionalIdentifier(record?.[key]);
        if (value) {
            return value;
        }
    }

    return null;
}

function getTidalMediaIdFromUrl(url: unknown, mediaType: 'album' | 'track' | 'video'): string | null {
    const normalizedUrl = getOptionalString(url);
    if (!normalizedUrl) {
        return null;
    }

    const match = normalizedUrl.match(new RegExp(`/${mediaType}/([^/?#]+)`, 'i'));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
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

function getQueueHistoryNavPath(
    job: ActivityJob,
    payload: Record<string, unknown> | null,
    resolved: Record<string, unknown> | null,
    mediaBadge: QueueHistoryMediaBadge | null,
): string | null {
    const payloadType = getOptionalString(payload?.type)?.toLowerCase();
    const resolvedAlbum = asRecord(resolved?.album);
    const payloadAlbum = asRecord(payload?.album);

    if (mediaBadge?.kind === 'album') {
        return buildAlbumNavPath(
            getRecordIdentifier(resolved, 'albumId', 'album_id', 'tidalId', 'id')
            ?? getRecordIdentifier(payload, 'albumId', 'album_id', 'tidalId', 'id')
            ?? getTidalMediaIdFromUrl(payload?.url, 'album'),
        );
    }

    if (mediaBadge?.kind === 'video') {
        return buildVideoNavPath(
            getRecordIdentifier(resolved, 'videoId', 'mediaId', 'tidalId', 'id')
            ?? getRecordIdentifier(payload, 'videoId', 'mediaId', 'tidalId', 'id')
            ?? getTidalMediaIdFromUrl(payload?.url, 'video'),
        );
    }

    if (mediaBadge?.kind === 'track') {
        if (payloadType === 'playlist' || job.type === 'DownloadPlaylist' || job.type === 'ImportPlaylist') {
            return null;
        }

        return buildAlbumNavPath(
            getRecordIdentifier(resolved, 'albumId', 'album_id')
            ?? getRecordIdentifier(resolvedAlbum, 'id', 'albumId', 'album_id')
            ?? getRecordIdentifier(payload, 'albumId', 'album_id')
            ?? getRecordIdentifier(payloadAlbum, 'id', 'albumId', 'album_id')
            ?? getTidalMediaIdFromUrl(payload?.albumUrl, 'album'),
        );
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
    statusLabel: string;
    timeLabel: string;
    error: string | null;
};

function getQueueHistoryMediaBadge(job: ActivityJob, payload: Record<string, unknown> | null): QueueHistoryMediaBadge | null {
    const payloadType = getOptionalString(payload?.type)?.toLowerCase();

    if (payloadType === 'album') {
        return { kind: 'album' };
    }

    if (payloadType === 'video') {
        return { kind: 'video' };
    }

    if (payloadType === 'playlist') {
        return { kind: 'track', label: 'Playlist' };
    }

    if (payloadType === 'track') {
        return { kind: 'track' };
    }

    switch (job.type) {
        case 'DownloadAlbum':
            return { kind: 'album' };
        case 'DownloadVideo':
            return { kind: 'video' };
        case 'DownloadPlaylist':
        case 'ImportPlaylist':
            return { kind: 'track', label: 'Playlist' };
        case 'DownloadTrack':
            return { kind: 'track' };
        default:
            return null;
    }
}

function getQueueHistoryStatusLabel(status?: string, error?: string | null): string {
    if (error || status === 'failed') {
        return 'Failed';
    }

    if (status === 'cancelled') {
        return 'Cancelled';
    }

    return 'Completed';
}

function mapQueueHistoryJobToRow(job: ActivityJob): QueueHistoryRowModel {
    const payload = asRecord(job.payload);
    const resolved = asRecord(payload?.resolved);
    const mediaBadge = getQueueHistoryMediaBadge(job, payload);
    const title = getOptionalString(resolved?.title)
        ?? getOptionalString(payload?.title)
        ?? getOptionalString(payload?.playlistName)
        ?? formatJobType(job);
    const artist = getOptionalString(resolved?.artist)
        ?? getOptionalString(payload?.artist)
        ?? getOptionalString(payload?.artistName);
    const fallbackDescription = formatJobDescription(job);
    const subtitle = artist ?? (fallbackDescription && fallbackDescription !== title ? fallbackDescription : null);
    const cover = getOptionalString(resolved?.cover) ?? getOptionalString(payload?.cover);
    const coverUrl = cover
        ? mediaBadge?.kind === 'video'
            ? getTidalImage(cover, 'video', 'small')
            : getAlbumCover(cover, 'small')
        : null;
    const navPath = getQueueHistoryNavPath(job, payload, resolved, mediaBadge);

    return {
        title,
        subtitle,
        coverUrl,
        isVideo: mediaBadge?.kind === 'video',
        mediaBadge,
        navPath,
        quality: getOptionalString(payload?.quality) ?? getOptionalString(payload?.qualityProfile),
        statusLabel: getQueueHistoryStatusLabel(job.status, job.error),
        timeLabel: formatRelativeTime(job.endTime || job.startTime),
        error: job.error ?? null,
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
        queue: downloadQueue,
        loading,
        getProgress,
        retryItem,
        deleteItem,
        reorderItems,
    } = useDownloadQueue();
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

    const groupedDownloads = useMemo(() => {
        const albumTrackCounts = new Map<string, number>();

        downloadQueue.forEach((item) => {
            if (item.type === 'track' && item.album_id) {
                albumTrackCounts.set(item.album_id, (albumTrackCounts.get(item.album_id) ?? 0) + 1);
            }
        });

        const groups: Record<string, QueueGroup> = {};

        downloadQueue.forEach((item, index) => {
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

        return Object.values(groups).sort((a, b) => a.sortIndex - b.sortIndex);
    }, [downloadQueue]);

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

    const stopQueueControlEvent = (event: SyntheticEvent<HTMLElement>) => {
        event.stopPropagation();
    };

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

                await reorderItems(direction === 'up'
                    ? { jobIds, beforeJobId: anchorJobId }
                    : { jobIds, afterJobId: anchorJobId });
                workingGroups = moveArrayItem(workingGroups, currentIndex, neighborIndex);
            }
        });
    };

    const handleRemoveSelectedGroups = async () => {
        if (selectedPendingGroups.length === 0) {
            return;
        }

        const selectedGroupIds = selectedPendingGroups.map((group) => group.id);
        await withBusyGroups(selectedGroupIds, 'remove-selected', async () => {
            for (const group of selectedPendingGroups) {
                for (const item of group.items) {
                    await deleteItem(item.id);
                }
            }
            pendingGroupSelection.clearSelection();
        });
    };

    const getDropPosition = (event: DragEvent<HTMLDivElement>): DropPosition => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return event.clientY - bounds.top >= bounds.height / 2 ? 'after' : 'before';
    };

    const handleDragStart = (event: DragEvent<HTMLDivElement>, groupId: string) => {
        if (isQueueMutationPending || (event.target as HTMLElement).closest('[data-queue-control="true"]')) {
            event.preventDefault();
            return;
        }

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', groupId);
        setDraggingGroupId(groupId);
        setDropTarget(null);
    };

    const handleDragOver = (event: DragEvent<HTMLDivElement>, groupId: string) => {
        if (!draggingGroupId || draggingGroupId === groupId) {
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
        if (!movingGroupId || movingGroupId === groupId) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        const movingGroup = pendingReorderGroups.find((group) => group.id === movingGroupId);
        const targetGroup = pendingReorderGroups.find((group) => group.id === groupId);
        if (!movingGroup || !targetGroup) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        const jobIds = getMovablePendingJobIds(movingGroup.items);
        const position = getDropPosition(event);
        const anchorJobId = position === 'before'
            ? getGroupFirstJobId(targetGroup)
            : getGroupLastJobId(targetGroup);
        if (jobIds.length === 0 || anchorJobId == null) {
            setDraggingGroupId(null);
            setDropTarget(null);
            return;
        }

        await withBusyGroups([movingGroupId], null, async () => {
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
                <TrackListSkeleton rows={6} />
            </div>
        );
    }

    return (
        <div className={styles.tabSection}>
            {hasQueueRows ? (
                <section className={styles.queueSection} aria-label="Live queue">
                    <div className={styles.queueSectionHeader}>
                        <div className={styles.queueSectionHeading}>
                            <Text size={200} weight="semibold" className={styles.activitySectionLabel}>Live queue</Text>
                            {hasPendingReorderUi ? (
                                <Text size={200} className={styles.queueSectionHint}>
                                    Pending groups can be reordered directly here
                                </Text>
                            ) : null}
                        </div>
                    </div>

                    {hasPendingReorderUi ? (
                        <LibrarySelectionBar
                            selectedCount={pendingGroupSelection.selectedCount}
                            allVisibleSelected={pendingGroupSelection.allVisibleSelected}
                            someVisibleSelected={pendingGroupSelection.someVisibleSelected}
                            onSelectAllVisible={pendingGroupSelection.selectAllVisible}
                            onClearSelection={pendingGroupSelection.clearSelection}
                            actions={[
                                {
                                    key: 'move-top',
                                    label: 'Move to top',
                                    icon: <ArrowUp24Regular />,
                                    onClick: () => { void handleSelectedGroupsMoveToEdge('top'); },
                                    disabled: !canMoveSelectedTop || isQueueMutationPending,
                                },
                                {
                                    key: 'move-up',
                                    label: 'Move up',
                                    icon: <ArrowUp24Regular />,
                                    onClick: () => { void handleSelectedGroupsMoveOneStep('up'); },
                                    disabled: !canMoveSelectedUp || isQueueMutationPending,
                                },
                                {
                                    key: 'move-down',
                                    label: 'Move down',
                                    icon: <ArrowDown24Regular />,
                                    onClick: () => { void handleSelectedGroupsMoveOneStep('down'); },
                                    disabled: !canMoveSelectedDown || isQueueMutationPending,
                                },
                                {
                                    key: 'move-bottom',
                                    label: 'Send to bottom',
                                    icon: <ArrowDown24Regular />,
                                    onClick: () => { void handleSelectedGroupsMoveToEdge('bottom'); },
                                    disabled: !canMoveSelectedBottom || isQueueMutationPending,
                                },
                                {
                                    key: 'remove-selected',
                                    label: 'Remove selected',
                                    icon: <Delete24Regular />,
                                    onClick: () => { void handleRemoveSelectedGroups(); },
                                    disabled: pendingGroupSelection.selectedCount === 0 || isQueueMutationPending,
                                },
                            ]}
                            className={styles.queueSelectionBar}
                        />
                    ) : null}

                    <div className={styles.downloadList}>
                        {groupedDownloads.map((group) => {
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
                            const isGroupDragging = draggingGroupId === group.id;
                            const isDropBefore = dropTarget?.groupId === group.id && dropTarget.position === 'before';
                            const isDropAfter = dropTarget?.groupId === group.id && dropTarget.position === 'after';

                            const handleGroupClick = (e: ReactMouseEvent) => {
                                if (isInteractiveElementTarget(e.target)) return;
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
                                        onDragOver={isPendingReorderable ? (event) => handleDragOver(event, group.id) : undefined}
                                        onDragLeave={isPendingReorderable ? () => handleDragLeave(group.id) : undefined}
                                        onDrop={isPendingReorderable ? (event) => { void handleDrop(event, group.id); } : undefined}
                                    >
                                        {isPendingReorderable ? (
                                            <div className={styles.downloadSelectionCell} data-queue-control="true" onClick={stopQueueControlEvent}>
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
                                            <div className={styles.downloadHeaderRow}>
                                                <div className={styles.downloadTitleRow}>
                                                    <Text className={styles.downloadTitle} truncate data-queue-group-title={group.title}>{group.title}</Text>
                                                </div>
                                                <div className={styles.downloadArtistMetaRow}>
                                                    <Text className={styles.downloadArtist} truncate>{group.artist}</Text>
                                                    <div className={styles.downloadBadgeRow}>
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
                                        <div className={styles.downloadActions}>
                                            {isPendingReorderable ? (
                                                <div className={styles.downloadReorderActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                                    <Button
                                                        size="small"
                                                        appearance="subtle"
                                                        icon={<ArrowUp24Regular />}
                                                        aria-label={`Move ${group.title} up`}
                                                        disabled={isFirstPendingGroup || isQueueMutationPending}
                                                        onClick={() => { void handleSingleGroupMove(group.id, 'up'); }}
                                                    />
                                                    <Button
                                                        size="small"
                                                        appearance="subtle"
                                                        icon={<ArrowDown24Regular />}
                                                        aria-label={`Move ${group.title} down`}
                                                        disabled={isLastPendingGroup || isQueueMutationPending}
                                                        onClick={() => { void handleSingleGroupMove(group.id, 'down'); }}
                                                    />
                                                    <Menu>
                                                        <MenuTrigger disableButtonEnhancement>
                                                            <Button
                                                                size="small"
                                                                appearance="subtle"
                                                                icon={<MoreHorizontal24Regular />}
                                                                aria-label={`More queue actions for ${group.title}`}
                                                                disabled={isQueueMutationPending}
                                                            />
                                                        </MenuTrigger>
                                                        <MenuPopover>
                                                            <MenuList>
                                                                <MenuItem disabled={isFirstPendingGroup || isQueueMutationPending} onClick={() => { void handleSingleGroupMove(group.id, 'top'); }}>
                                                                    Move to top
                                                                </MenuItem>
                                                                <MenuItem disabled={isFirstPendingGroup || isQueueMutationPending} onClick={() => { void handleSingleGroupMove(group.id, 'up'); }}>
                                                                    Move up
                                                                </MenuItem>
                                                                <MenuItem disabled={isLastPendingGroup || isQueueMutationPending} onClick={() => { void handleSingleGroupMove(group.id, 'down'); }}>
                                                                    Move down
                                                                </MenuItem>
                                                                <MenuItem disabled={isLastPendingGroup || isQueueMutationPending} onClick={() => { void handleSingleGroupMove(group.id, 'bottom'); }}>
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
                                            {group.items.length === 1 && (
                                                <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => deleteItem(group.items[0].id)} />
                                            )}
                                        </div>
                                    </div>

                                    {(group.items.length > 1 || (group.items.length === 1 && group.items[0].type === 'track' && group.type === 'album')) && group.items.map(item => {
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
                                                <div className={styles.downloadActions}>
                                                    {isItemFailed && (
                                                        <Button size="small" appearance="subtle" icon={<ArrowClockwise24Regular />} onClick={() => retryItem(item.id)} />
                                                    )}
                                                    <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => deleteItem(item.id)} />
                                                </div>
                                            </div>
                                        );
                                    })}

                                    {group.type === 'album' && group.items.length === 1 && prog?.tracks && prog.tracks.length > 0 && (
                                        <div>
                                            {prog.tracks.map((t, idx) => {
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
                    </div>
                </section>
            ) : (
                <section className={styles.queueSection} aria-label="Live queue">
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
                            <Text size={200} weight="semibold" className={styles.activitySectionLabel}>History</Text>
                        </div>
                    </div>
                    <div className={styles.downloadList}>
                        {queueHistoryItems.map((job) => {
                            const row = mapQueueHistoryJobToRow(job);
                            const statusTextClassName = job.error || job.status === 'failed'
                                ? styles.queueHistoryStatusTextDanger
                                : job.status === 'cancelled'
                                    ? styles.queueHistoryStatusTextNeutral
                                    : styles.queueHistoryStatusTextSuccess;

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
                                    key={`queue-history-${String(job.id)}`}
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
                                        <img
                                            src={row.coverUrl}
                                            alt=""
                                            className={row.isVideo ? styles.downloadCoverVideo : styles.downloadCover}
                                        />
                                    ) : (
                                        <div className={row.isVideo ? styles.downloadCoverPlaceholderVideo : styles.downloadCoverPlaceholder}>
                                            {row.mediaBadge?.kind === 'video'
                                                ? <Video24Regular className={styles.queueHistoryPlaceholderIcon} />
                                                : row.mediaBadge
                                                    ? <MusicNote224Regular className={styles.queueHistoryPlaceholderIcon} />
                                                    : <span className={styles.activityIconOffset}>{getActivityTypeIcon(job)}</span>}
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
                                        <Text className={styles.downloadMeta}>{row.timeLabel}</Text>
                                        {row.error ? (
                                            <Text className={styles.queueHistoryErrorText}>{row.error}</Text>
                                        ) : null}
                                    </div>

                                    <div className={styles.queueHistoryStatus}>
                                        {renderHistoryStatusIndicator(styles, job.status, job.error)}
                                        <Text className={mergeClasses(styles.queueHistoryStatusText, statusTextClassName)}>
                                            {row.statusLabel}
                                        </Text>
                                    </div>
                                </div>
                            );
                        })}
                        {hasMoreQueueHistory ? (
                            <div className={styles.loadMoreRow}>
                                <Button appearance="subtle" onClick={() => void loadMoreQueueHistory()} disabled={isLoadingMoreQueueHistory}>
                                    {isLoadingMoreQueueHistory ? "Loading..." : "Load more"}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                </section>
            ) : null}
        </div>
    );
};

export default QueueTab;
