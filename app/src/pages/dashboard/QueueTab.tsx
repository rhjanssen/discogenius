import { useMemo, useRef, useEffect, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
    Badge,
    Button,
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
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import { MediaTypeBadge } from "@/components/ui/MediaTypeBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { EmptyState, LoadingState } from "@/components/ui/ContentState";
import { getAlbumCover, getTidalImage } from "@/utils/tidalImages";
import { useDashboardStyles } from "./dashboardStyles";

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
        return options.isImporting
            ? <Text className={styles.downloadStatusText}>importing</Text>
            : <Spinner size="extra-tiny" />;
    }

    if (options.isSkipped) {
        return <Text className={styles.downloadStatusText}>skipped</Text>;
    }

    if (options.isQueued) {
        return renderPendingIndicator(styles);
    }

    return null;
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
    } = useDownloadQueue();

    const activeDownloads = downloadQueue.filter(i => i.status === 'downloading' || i.status === 'processing');
    const pendingDownloads = downloadQueue.filter(i => i.status === 'pending');
    const failedDownloads = downloadQueue.filter(i => i.status === 'failed');

    const groupedDownloads = useMemo(() => {
        const albumTrackCounts = new Map<string, number>();

        [...activeDownloads, ...pendingDownloads, ...failedDownloads].forEach((item) => {
            if (item.type === 'track' && item.album_id) {
                albumTrackCounts.set(item.album_id, (albumTrackCounts.get(item.album_id) ?? 0) + 1);
            }
        });

        const groups: Record<string, {
            id: string;
            title: string;
            artist: string;
            cover: string | null;
            type: string;
            quality: string | null;
            items: typeof downloadQueue;
            status: 'downloading' | 'pending' | 'failed';
            sortIndex: number;
        }> = {};

        [...activeDownloads, ...pendingDownloads, ...failedDownloads].forEach((item, index) => {
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

            const rankGroup = (groupStatus: 'downloading' | 'pending' | 'failed', activeItem?: typeof downloadQueue[number]) => {
                if (groupStatus === 'downloading' && activeItem?.stage === 'import') return 0;
                if (groupStatus === 'downloading') return 1;
                if (groupStatus === 'pending') return 2;
                return 3;
            };

            const rankDiff = rankGroup(a.status, aActiveItem) - rankGroup(b.status, bActiveItem);
            if (rankDiff !== 0) {
                return rankDiff;
            }

            return a.sortIndex - b.sortIndex;
        });
    }, [activeDownloads, pendingDownloads, failedDownloads]);

    const [listElement, setListElement] = useState<HTMLDivElement | null>(null);

    const virtualizer = useWindowVirtualizer({
        count: groupedDownloads.length,
        estimateSize: () => 75,
        overscan: 10,
        scrollMargin: listElement?.offsetTop ?? 0,
    });

    const hasQueueRows = groupedDownloads.length > 0;

    if (loading && !hasQueueRows) {
        return (
            <div className={styles.tabSection}>
                <LoadingState label="Loading queue..." />
            </div>
        );
    }

    if (!loading && !hasQueueRows) {
        return (
            <div className={styles.tabSection}>
                <EmptyState
                    title="No items in queue"
                    description="Browse your library and download albums, or enable monitoring to automate downloads."
                    icon={<ArrowDownload24Regular />}
                />
            </div>
        );
    }

    return (
        <div className={styles.tabSection} ref={setListElement}>
            <div className={styles.downloadList} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map(virtualRow => {
                    const group = groupedDownloads[virtualRow.index];
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
                    const groupNavPath = isVideo
                        ? `/video/${firstItem?.tidalId}`
                        : group.type === 'album'
                            ? `/album/${firstItem?.type === 'album' ? firstItem?.tidalId : firstItem?.album_id}`
                            : firstItem?.album_id
                                ? `/album/${firstItem.album_id}`
                                : null;

                    const handleGroupClick = (e: React.MouseEvent) => {
                        if ((e.target as HTMLElement).closest('button')) return;
                        if (groupNavPath) navigate(groupNavPath);
                    };

                    return (
                        <div key={group.id} ref={virtualizer.measureElement} data-index={virtualRow.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)` }}>
                            <div className={styles.downloadItem} style={{ opacity: isFailed ? 0.9 : 1, cursor: groupNavPath ? 'pointer' : 'default' }} onClick={handleGroupClick}>
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
                                            <Text className={styles.downloadTitle} truncate>{group.title}</Text>
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
                                const isCurrentAlbumTrack = group.type === 'album'
                                    && (matchesActiveTrack(item.title, prog?.currentTrack)
                                        || (prog?.tracks?.length ? findActiveAlbumTrackIndex(prog, prog.tracks) === albumTrackIndex : false));
                                const itemProgressValue = isCurrentAlbumTrack
                                    ? prog?.trackProgress
                                    : itemProg?.progress;
                                const itemErrorMessage = item.error || (isItemFailed ? prog?.statusMessage : undefined);
                                return (
                                    <div key={item.id} className={styles.downloadSubItem} onClick={(e) => {
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
        </div>
    );
};

export default QueueTab;
