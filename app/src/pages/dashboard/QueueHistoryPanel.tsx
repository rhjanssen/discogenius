import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
    Button,
    mergeClasses,
    Subtitle2,
    Text,
} from "@fluentui/react-components";
import {
    CheckmarkCircle16Filled,
    DismissCircle16Filled,
    Warning16Filled,
    ArrowClockwise24Regular,
    Clock16Regular,
    MusicNote224Regular,
    Video24Regular,
    ArrowClockwise24Filled,
    Clock16Filled,
    MusicNote224Filled,
    Video24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import type { QueueItemContract as QueueItem } from "@contracts/status";
import { MediaTypeBadge } from "@/components/ui/MediaTypeBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { mediaCoverSrc } from "@/utils/artwork";
import { ProviderMark } from "@/components/ui/ProviderMark";
import { useDashboardStyles } from "./dashboardStyles";
import { formatRelativeTime } from "./dashboardUtils";
import { isInteractiveElementTarget, stopQueueControlEvent } from "./queueTabShared";

const ArrowClockwise24 = bundleIcon(ArrowClockwise24Filled, ArrowClockwise24Regular);
const Clock16 = bundleIcon(Clock16Filled, Clock16Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);

type QueueHistoryMediaBadge = {
    kind: "album" | "track" | "video";
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

function getQueueHistoryNavPath(item: QueueItem): string | null {
    if (item.type === "video") {
        return buildVideoNavPath(item.media_id ?? item.providerId);
    }

    if (item.type === "album") {
        return buildAlbumNavPath(item.album_id ?? item.providerId);
    }

    if (item.type === "track") {
        return buildAlbumNavPath(item.album_id);
    }

    return null;
}

function getQueueHistoryMediaBadge(item: QueueItem): QueueHistoryMediaBadge | null {
    switch (item.type) {
        case "album":
            return { kind: "album" };
        case "video":
            return { kind: "video" };
        case "track":
            return { kind: "track" };
        default:
            return null;
    }
}

function mapQueueHistoryItemToRow(item: QueueItem): QueueHistoryRowModel {
    const mediaBadge = getQueueHistoryMediaBadge(item);
    const title = item.title || item.album_title || "Unknown item";
    const subtitle = item.artist || null;
    const coverUrl = mediaCoverSrc(item);
    const navPath = getQueueHistoryNavPath(item);
    const timeSource = item.completed_at || item.updated_at || item.started_at || item.created_at;

    return {
        title,
        subtitle,
        coverUrl,
        isVideo: mediaBadge?.kind === "video",
        mediaBadge,
        navPath,
        quality: item.quality ?? null,
        timeLabel: formatRelativeTime(timeSource),
        error: item.error ?? null,
    };
}

function renderHistoryStatusIndicator(
    styles: ReturnType<typeof useDashboardStyles>,
    status?: string,
    error?: string | null,
    outcome?: string | null,
    warningMessage?: string | null,
) {
    if (error || status === "failed") {
        return <DismissCircle16Filled className={styles.downloadStatusErrorIcon} />;
    }

    if (status === "completed" && outcome === "completedWithWarning") {
        return (
            <Warning16Filled
                className={styles.downloadStatusWarningIcon}
                title={warningMessage || "Completed with warning"}
            />
        );
    }

    if (status === "completed") {
        return <CheckmarkCircle16Filled className={styles.downloadStatusColorIcon} title="Completed" />;
    }

    return <Clock16 className={styles.downloadStatusPendingIcon} />;
}

export type QueueHistoryPanelProps = {
    items: QueueItem[];
    hasMore: boolean;
    isLoadingMore: boolean;
    onLoadMore: () => void | Promise<void>;
    hasRefreshError: boolean;
    refreshErrorMessage?: string | null;
    onRetryFeeds: () => void | Promise<void>;
    onRetryItem: (id: number) => void;
};

export function QueueHistoryPanel({
    items,
    hasMore,
    isLoadingMore,
    onLoadMore,
    hasRefreshError,
    refreshErrorMessage,
    onRetryFeeds,
    onRetryItem,
}: QueueHistoryPanelProps) {
    const styles = useDashboardStyles();
    const navigate = useNavigate();
    const historySentinelRef = useRef<HTMLDivElement | null>(null);
    const hasHistoryRows = items.length > 0;

    useEffect(() => {
        if (!hasHistoryRows || !hasMore) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    if (entry.target === historySentinelRef.current && hasMore && !isLoadingMore) {
                        void onLoadMore();
                    }
                }
            },
            { rootMargin: "200px" },
        );

        const historySentinel = historySentinelRef.current;
        if (historySentinel) observer.observe(historySentinel);

        return () => observer.disconnect();
    }, [hasHistoryRows, hasMore, isLoadingMore, onLoadMore, items.length]);

    if (hasHistoryRows) {
        return (
            <section className={styles.queueSection} aria-label="Queue history">
                <div className={styles.queueSectionHeader}>
                    <div className={styles.queueSectionHeading}>
                        <Subtitle2 className={styles.queueSectionTitle}>History</Subtitle2>
                    </div>
                </div>
                <div className={styles.downloadList}>
                    {items.map((item) => {
                        const row = mapQueueHistoryItemToRow(item);
                        const isVideo = row.isVideo;
                        const isFailed = item.status === "failed" || Boolean(item.error);

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

                            if (event.key === "Enter" || event.key === " ") {
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
                                role={row.navPath ? "link" : undefined}
                                tabIndex={row.navPath ? 0 : undefined}
                                aria-label={row.navPath ? `Open ${row.title}` : undefined}
                            >
                                {row.coverUrl ? (
                                    <img src={row.coverUrl} alt="" className={isVideo ? styles.downloadCoverVideo : styles.downloadCover} />
                                ) : (
                                    <div className={isVideo ? styles.downloadCoverPlaceholderVideo : styles.downloadCoverPlaceholder}>
                                        {isVideo
                                            ? <Video24 style={{ width: 16, height: 16 }} />
                                            : <MusicNote224 style={{ width: 16, height: 16 }} />}
                                    </div>
                                )}
                                <div className={styles.downloadInfo}>
                                    <div className={mergeClasses(styles.downloadHeaderRow, styles.downloadHeaderRowInline)}>
                                        <div className={mergeClasses(styles.downloadTitleRow, styles.downloadTitleRowInline)}>
                                            <Text className={styles.downloadTitle} truncate>{row.title}</Text>
                                        </div>
                                        <div className={mergeClasses(styles.downloadArtistMetaRow, styles.downloadArtistMetaRowInline)}>
                                            {row.subtitle ? (
                                                <Text className={styles.downloadArtist} truncate>{row.subtitle}</Text>
                                            ) : null}
                                            <div className={mergeClasses(styles.downloadBadgeRow, styles.downloadBadgeRowInline)}>
                                                {item.providerId ? <ProviderMark provider={item.providerId} size={16} /> : null}
                                                {row.quality ? <QualityBadge quality={row.quality} size="small" /> : null}
                                                {row.mediaBadge ? (
                                                    <MediaTypeBadge kind={row.mediaBadge.kind} label={row.mediaBadge.label} size="small" />
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className={styles.queueHistoryTrailing}>
                                    <Text className={styles.queueHistoryTime}>{row.timeLabel}</Text>
                                    <div className={styles.queueHistoryStatus}>
                                        {renderHistoryStatusIndicator(
                                            styles,
                                            item.status,
                                            item.error,
                                            item.outcome,
                                            item.warningMessage,
                                        )}
                                    </div>
                                </div>
                                {isFailed ? (
                                    <div className={styles.downloadActions} data-queue-control="true" onClick={stopQueueControlEvent}>
                                        <Button size="small" appearance="subtle" icon={<ArrowClockwise24 />} onClick={() => onRetryItem(item.id)} title="Retry" />
                                    </div>
                                ) : null}
                                {row.error ? (
                                    <Text className={styles.queueHistoryErrorText}>{row.error}</Text>
                                ) : item.outcome === "completedWithWarning" && item.warningMessage ? (
                                    <Text className={styles.queueHistoryErrorText}>{item.warningMessage}</Text>
                                ) : null}
                            </div>
                        );
                    })}
                    {hasMore ? (
                        <>
                            <div ref={historySentinelRef} aria-hidden="true" />
                            <div className={styles.loadMoreRow}>
                                <Button appearance="subtle" onClick={() => void onLoadMore()} disabled={isLoadingMore}>
                                    {isLoadingMore ? "Loading..." : "Load more"}
                                </Button>
                            </div>
                        </>
                    ) : null}
                </div>
            </section>
        );
    }

    if (hasRefreshError) {
        return (
            <section className={styles.queueSection} aria-label="Queue history">
                <div className={styles.queueSectionHeader}>
                    <div className={styles.queueSectionHeading}>
                        <Subtitle2 className={styles.queueSectionTitle}>History</Subtitle2>
                    </div>
                </div>
                <ErrorState
                    title="Queue history unavailable"
                    description={refreshErrorMessage ?? "The queue history feed did not finish loading."}
                    minHeight="220px"
                    actions={(
                        <Button appearance="primary" onClick={() => { void onRetryFeeds(); }}>
                            Retry
                        </Button>
                    )}
                />
            </section>
        );
    }

    return (
        <section className={styles.queueSection} aria-label="Queue history">
            <div className={styles.queueSectionHeader}>
                <div className={styles.queueSectionHeading}>
                    <Subtitle2 className={styles.queueSectionTitle}>History</Subtitle2>
                </div>
            </div>
            <EmptyState
                title="No history yet"
                icon={<ArrowClockwise24 />}
                minHeight="220px"
                compactMobile
            />
        </section>
    );
}
