import { useEffect, useRef } from "react";
import {
    Button,
    Menu,
    MenuDivider,
    MenuItemCheckbox,
    MenuList,
    MenuPopover,
    MenuTrigger,
    mergeClasses,
    Subtitle2,
    Text,
    tokens,
    makeStyles,
    type MenuProps,
} from "@fluentui/react-components";
import {
    ArrowClockwise24Regular,
    MusicNote224Regular,
    Video24Regular,
    ArrowClockwise24Filled,
    MusicNote224Filled,
    Video24Filled,
    Filter24Regular,
    Filter24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { Link } from "react-router-dom";
import type { QueueItemContract as QueueItem } from "@contracts/status";
import { MediaTypeBadge } from "@/components/ui/MediaTypeBadge";
import { QueuedStatusIcon, SemanticStatusIcon } from "@/components/ui/SemanticStatusIcon";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow } from "@/components/ui/ProviderQualityPill";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { mediaCoverProxySrc, mediaCoverSrc } from "@/utils/artwork";
import { queueProviderOffers } from "@/utils/queueProviderOffers";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { useDashboardStyles } from "./dashboardStyles";
import { formatRelativeTime } from "./dashboardUtils";
import {
    QUEUE_HISTORY_MEDIA_KIND_OPTIONS,
    QUEUE_HISTORY_OUTCOME_OPTIONS,
    countActiveQueueHistoryFilters,
    hasActiveQueueHistoryFilters,
    type QueueHistoryFilters,
    type QueueHistoryMediaKindFilter,
    type QueueHistoryOutcomeFilter,
} from "./queueHistoryFilters";
import { getQueueItemNavPath } from "./queueNavigation";

const ArrowClockwise24 = bundleIcon(ArrowClockwise24Filled, ArrowClockwise24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);
const Filter24 = bundleIcon(Filter24Filled, Filter24Regular);

const useFilterStyles = makeStyles({
    triggerButton: {
        ...glassButtonStyles,
    },
    activeTriggerButton: {
        color: tokens.colorBrandForeground1,
    },
});

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

function getQueueHistoryNavPath(item: QueueItem): string | null {
    return getQueueItemNavPath(item);
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
    const isVideo = mediaBadge?.kind === "video";
    const coverUrl = isVideo ? mediaCoverProxySrc(item) : mediaCoverSrc(item);
    const navPath = getQueueHistoryNavPath(item);
    const timeSource = item.completed_at || item.updated_at || item.started_at || item.created_at;

    return {
        title,
        subtitle,
        coverUrl,
        isVideo,
        mediaBadge,
        navPath,
        quality: item.quality ?? null,
        timeLabel: formatRelativeTime(timeSource),
        error: item.error ?? null,
    };
}

function renderHistoryStatusIndicator(
    status?: string,
    error?: string | null,
    outcome?: string | null,
    warningMessage?: string | null,
) {
    if (error || status === "failed") {
        return <SemanticStatusIcon status="error" size={24} title="Failed" />;
    }

    if (status === "completed" && outcome === "completedWithWarning") {
        return (
            <SemanticStatusIcon
                status="warning"
                size={24}
                title={warningMessage || "Completed with warning"}
            />
        );
    }

    if (status === "completed") {
        return <SemanticStatusIcon status="success" size={24} title="Completed" />;
    }

    return <QueuedStatusIcon size={24} aria-label="Waiting" />;
}

function QueueHistoryFilterMenu({
    filters,
    onFiltersChange,
}: {
    filters: QueueHistoryFilters;
    onFiltersChange: (next: QueueHistoryFilters) => void;
}) {
    const styles = useFilterStyles();
    const activeCount = countActiveQueueHistoryFilters(filters);
    const checkedValues: Record<string, string[]> = {
        outcome: filters.outcomes,
        mediaKind: filters.mediaKinds,
    };

    const handleCheckedValueChange: MenuProps["onCheckedValueChange"] = (_event, data) => {
        if (data.name === "outcome") {
            onFiltersChange({
                ...filters,
                outcomes: data.checkedItems as QueueHistoryOutcomeFilter[],
            });
            return;
        }

        if (data.name === "mediaKind") {
            onFiltersChange({
                ...filters,
                mediaKinds: data.checkedItems as QueueHistoryMediaKindFilter[],
            });
        }
    };

    const sectionLabelStyle = {
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorNeutralForeground3,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    } as const;

    return (
        <Menu checkedValues={checkedValues} onCheckedValueChange={handleCheckedValueChange}>
            <MenuTrigger disableButtonEnhancement>
                <Button
                    className={mergeClasses(
                        styles.triggerButton,
                        activeCount > 0 ? styles.activeTriggerButton : undefined,
                    )}
                    appearance="subtle"
                    icon={<Filter24 />}
                    size="small"
                    title="Filter history"
                    aria-label={`Filter history${activeCount > 0 ? ` (${activeCount})` : ""}`}
                >
                    {activeCount > 0 ? `Filter (${activeCount})` : "Filter"}
                </Button>
            </MenuTrigger>
            <MenuPopover>
                <MenuList>
                    <Text style={sectionLabelStyle}>OUTCOME</Text>
                    {QUEUE_HISTORY_OUTCOME_OPTIONS.map((option) => (
                        <MenuItemCheckbox key={option.value} name="outcome" value={option.value}>
                            {option.label}
                        </MenuItemCheckbox>
                    ))}
                    <MenuDivider />
                    <Text style={sectionLabelStyle}>LIBRARY</Text>
                    {QUEUE_HISTORY_MEDIA_KIND_OPTIONS.map((option) => (
                        <MenuItemCheckbox key={option.value} name="mediaKind" value={option.value}>
                            {option.label}
                        </MenuItemCheckbox>
                    ))}
                </MenuList>
            </MenuPopover>
        </Menu>
    );
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
    filters: QueueHistoryFilters;
    onFiltersChange: (next: QueueHistoryFilters) => void;
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
    filters,
    onFiltersChange,
}: QueueHistoryPanelProps) {
    const styles = useDashboardStyles();
    const historySentinelRef = useRef<HTMLDivElement | null>(null);
    const hasHistoryRows = items.length > 0;
    const filtersActive = hasActiveQueueHistoryFilters(filters);

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

    const sectionHeader = (
        <div className={styles.queueSectionHeader}>
            <div className={styles.queueSectionHeading}>
                <Subtitle2 className={styles.queueSectionTitle}>History</Subtitle2>
            </div>
            <div className={styles.queueSectionActions}>
                <QueueHistoryFilterMenu filters={filters} onFiltersChange={onFiltersChange} />
            </div>
        </div>
    );

    if (hasHistoryRows) {
        return (
            <section className={styles.queueSection} aria-label="Queue history">
                {sectionHeader}
                <div className={styles.downloadList}>
                    {items.map((item) => {
                        const row = mapQueueHistoryItemToRow(item);
                        const isVideo = row.isVideo;
                        const isFailed = item.status === "failed" || Boolean(item.error);
                        const qualityOffers = queueProviderOffers({
                            type: item.type,
                            quality: row.quality ?? item.quality,
                            provider: item.provider,
                            providerId: item.providerId,
                            url: item.url,
                        });

                        return (
                            <div
                                key={`queue-history-${String(item.id)}`}
                                className={mergeClasses(
                                    styles.downloadItem,
                                    styles.queueHistoryItem,
                                    styles.queueHistoryItemStatic,
                                )}
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
                                            {row.navPath ? (
                                                <Link to={row.navPath} className={mergeClasses(styles.downloadTitle, styles.downloadTitleLink)}>
                                                    {row.title}
                                                </Link>
                                            ) : (
                                                <Text className={styles.downloadTitle} truncate>{row.title}</Text>
                                            )}
                                        </div>
                                        <div className={mergeClasses(styles.downloadArtistMetaRow, styles.downloadArtistMetaRowInline)}>
                                            {row.subtitle ? (
                                                <Text className={styles.downloadArtist} truncate>{row.subtitle}</Text>
                                            ) : null}
                                            <div className={mergeClasses(styles.downloadBadgeRow, styles.downloadBadgeRowInline)}>
                                                {qualityOffers.length > 0
                                                    ? <ProviderQualityRow size="small" offers={qualityOffers} />
                                                    : (row.quality
                                                        ? <QualityBadge quality={row.quality} size="small" />
                                                        : null)}
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
                                            item.status,
                                            item.error,
                                            item.outcome,
                                            item.warningMessage,
                                        )}
                                    </div>
                                </div>
                                {isFailed ? (
                                    <div className={styles.downloadActions} data-queue-control="true">
                                        <Button size="small" appearance="subtle" icon={<ArrowClockwise24 />} onClick={() => onRetryItem(item.id)} title="Retry" aria-label={`Retry ${row.title}`} />
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
                {sectionHeader}
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
            {sectionHeader}
            <EmptyState
                title={filtersActive ? "No matching history" : "No history yet"}
                description={filtersActive ? "Try clearing outcome or library filters." : undefined}
                icon={<ArrowClockwise24 />}
                minHeight="220px"
                compactMobile
            />
        </section>
    );
}
