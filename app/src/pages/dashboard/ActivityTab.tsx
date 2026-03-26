import { useMemo } from "react";
import {
    Badge,
    Button,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    ArrowClockwise24Regular,
    CheckmarkCircle24Filled,
    Clock24Regular,
    DismissCircle24Filled,
    Warning24Filled,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { DataGrid, type DataGridColumn } from "@/components/DataGrid";
import { EmptyState } from "@/components/ui/ContentState";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useActivityInFlightFeed } from "@/hooks/useActivityInFlightFeed";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import type { HistoryEventItemContract } from "@contracts/history";
import type { ActivityJobContract as ActivityJob } from "@contracts/status";
import CachedRefreshNotice from "./CachedRefreshNotice";
import {
    formatJobDescription,
    formatJobType,
    formatRelativeTime,
    getActivityTypeIcon,
    matchesActivityFilter,
} from "./dashboardUtils";

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    section: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
    },
    sectionHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
        padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    },
    sectionCount: {
        color: tokens.colorNeutralForeground2,
    },
    levelCell: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: tokens.spacingHorizontalXS,
    },
    typeIconSlot: {
        display: "inline-flex",
        width: "16px",
        height: "16px",
        alignItems: "center",
        justifyContent: "center",
    },
    statusIconSuccess: {
        color: tokens.colorPaletteGreenForeground1,
        width: "16px",
        height: "16px",
    },
    statusIconWarning: {
        color: tokens.colorPaletteYellowForeground1,
        width: "16px",
        height: "16px",
    },
    statusIconError: {
        color: tokens.colorPaletteRedForeground1,
        width: "16px",
        height: "16px",
    },
    statusIconInfo: {
        color: tokens.colorNeutralForeground3,
        width: "16px",
        height: "16px",
    },
    messageCell: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    messageTitle: {
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    messageDescription: {
        color: tokens.colorNeutralForeground2,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    messageError: {
        color: tokens.colorPaletteRedForeground1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    badgeRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
    },
    loadMoreRow: {
        display: "flex",
        justifyContent: "center",
        paddingTop: tokens.spacingVerticalXXS,
    },
});

type ActivityTabProps = {
    libraryAuditEvents: HistoryEventItemContract[];
    activityFilter: string;
    isLibraryAuditLoading: boolean;
    isActive: boolean;
};

type EventLevel = "success" | "warning" | "error" | "info";

type EventRow = {
    id: string;
    sourceId: number;
    sortTime: number;
    levelIcon: ReactNode;
    typeIcon?: ReactNode;
    timeLabel: string;
    component: string;
    title: string;
    description: string;
    badges: string[];
    error?: string;
    retryJobId?: number;
};

function getJobPayload(job: ActivityJob): Record<string, unknown> | null {
    if (!job?.payload) return null;
    if (typeof job.payload === "string") {
        try {
            return JSON.parse(job.payload) as Record<string, unknown>;
        } catch {
            return null;
        }
    }
    return typeof job.payload === "object" ? job.payload as Record<string, unknown> : null;
}

function getHistoryEventData(event: HistoryEventItemContract): Record<string, unknown> | null {
    return event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : null;
}

function compactPath(value?: string | null): string {
    const text = String(value || "").trim().replace(/\\/g, "/");
    if (!text) return "";
    const segments = text.split("/").filter(Boolean);
    if (segments.length <= 2) return text;
    return `…/${segments.slice(-2).join("/")}`;
}

function getJobTidalId(job: ActivityJob): string {
    const payload = getJobPayload(job);
    const legacyRefId = (job as ActivityJob & { ref_id?: string }).ref_id;
    return String(payload?.tidalId || legacyRefId || "").trim();
}

function getJobMediaType(job: ActivityJob): string {
    const payload = getJobPayload(job);
    const payloadType = String(payload?.type || "").trim();
    if (payloadType) return payloadType;

    switch (job?.type) {
        case "DownloadAlbum":
            return "album";
        case "DownloadTrack":
            return "track";
        case "DownloadVideo":
            return "video";
        case "DownloadPlaylist":
            return "playlist";
        default:
            return "";
    }
}

function formatLifecycleBadges(job: ActivityJob): string[] {
    const payload = getJobPayload(job);
    const badges: string[] = [];

    const reason = String(payload?.reason || "").trim().replace(/_/g, " ");
    if (reason) badges.push(reason.charAt(0).toUpperCase() + reason.slice(1));
    if (payload?.originalJobId) badges.push(`Retry of #${payload.originalJobId}`);

    return badges;
}

function formatHistoryAuditLabel(eventType: HistoryEventItemContract["eventType"]): string {
    switch (eventType) {
        case "DownloadImported": return "Download imported";
        case "DownloadFailed": return "Download failed";
        case "AlbumImportIncomplete": return "Import incomplete";
        case "TrackFileImported": return "File imported";
        case "TrackFileRenamed": return "File renamed";
        case "TrackFileDeleted": return "File deleted";
        case "TrackFileRetagged": return "File retagged";
        case "Grabbed": return "Grabbed";
        case "DownloadIgnored": return "Ignored";
        default: return "History event";
    }
}

function formatHistoryAuditSummary(event: HistoryEventItemContract): string {
    const data = getHistoryEventData(event);
    if (!data) return event.sourceTitle || "Audit entry";

    if (event.eventType === "TrackFileImported") {
        return data.importedPath ? `Imported to ${compactPath(String(data.importedPath))}` : "Imported into the library";
    }

    if (event.eventType === "TrackFileRenamed") {
        const fromPath = compactPath(String(data.fromPath || ""));
        const toPath = compactPath(String(data.toPath || ""));
        return fromPath && toPath ? `${fromPath} → ${toPath}` : "Renamed file";
    }

    if (event.eventType === "DownloadFailed") {
        return `Error: ${String(data.error || "Download failed")}`;
    }

    return event.sourceTitle || "Audit entry";
}

function formatHistoryAuditBadges(event: HistoryEventItemContract): string[] {
    const badges: string[] = [];
    if (event.quality) badges.push(event.quality);
    return badges;
}

function matchesHistoryAuditFilter(eventType: HistoryEventItemContract["eventType"], activityFilter: string): boolean {
    if (activityFilter === "all") return true;

    switch (activityFilter) {
        case "downloads":
            return ["DownloadImported", "DownloadFailed", "AlbumImportIncomplete", "Grabbed", "DownloadIgnored"].includes(eventType);
        case "imports":
            return ["TrackFileImported", "TrackFileRenamed", "TrackFileDeleted", "TrackFileRetagged"].includes(eventType);
        case "metadata":
            return eventType === "TrackFileRetagged" || eventType === "TrackFileImported";
        case "curation":
            return false;
        default:
            return true;
    }
}

function getHistoryAuditLevel(eventType: HistoryEventItemContract["eventType"]): EventLevel {
    switch (eventType) {
        case "DownloadFailed":
        case "TrackFileDeleted":
            return "error";
        case "AlbumImportIncomplete":
        case "DownloadIgnored":
            return "warning";
        case "DownloadImported":
        case "TrackFileImported":
            return "success";
        default:
            return "info";
    }
}

const ActivityTab = ({
    libraryAuditEvents,
    activityFilter,
    isLibraryAuditLoading,
    isActive,
}: ActivityTabProps) => {
    const styles = useStyles();
    const { retryItem } = useDownloadQueue();
    const {
        activityItems,
        hasMoreActivity,
        isLoadingMoreActivity,
        loadMoreActivity,
        isActivityInitialLoading,
        hasActivityRefreshError,
        activityRefreshErrorMessage,
    } = useActivityFeed({ enabled: isActive });
    const {
        inFlightActivityItems,
        hasNextPage: hasMoreInFlightActivity,
    } = useActivityInFlightFeed({ enabled: isActive });

    const historyJobs = useMemo(
        () => activityItems.filter((job) => ["completed", "failed", "cancelled"].includes(String(job.status || ""))),
        [activityItems],
    );

    const getLevelIcon = (level: EventLevel) => {
        switch (level) {
            case "success":
                return <CheckmarkCircle24Filled className={styles.statusIconSuccess} />;
            case "warning":
                return <Warning24Filled className={styles.statusIconWarning} />;
            case "error":
                return <DismissCircle24Filled className={styles.statusIconError} />;
            default:
                return <Clock24Regular className={styles.statusIconInfo} />;
        }
    };

    const isRetryableJob = (job: ActivityJob) => {
        const type = job?.type || "";
        return type.startsWith("Download") || type === "ImportDownload" || type === "ImportPlaylist";
    };

    const hasSupersedingSuccess = (job: ActivityJob) => {
        if (job?.type !== "ImportDownload" || !job?.error) return false;

        const tidalId = getJobTidalId(job);
        const mediaType = getJobMediaType(job);
        if (!tidalId || !mediaType) return false;

        const jobTime = Number(job?.endTime || job?.startTime || 0);
        const recoveredInHistory = historyJobs.some((candidate) => {
            if (candidate?.status !== "completed") return false;
            return getJobTidalId(candidate) === tidalId
                && getJobMediaType(candidate) === mediaType
                && Number(candidate?.endTime || candidate?.startTime || 0) > jobTime;
        });

        if (recoveredInHistory) return true;

        return inFlightActivityItems.some((candidate) => {
            if (!candidate || !["running", "processing", "pending"].includes(candidate.status || "")) return false;
            return getJobTidalId(candidate) === tidalId && getJobMediaType(candidate) === mediaType;
        });
    };

    const rows = useMemo<EventRow[]>(() => {
        const jobRows = historyJobs
            .filter((job) => matchesActivityFilter(job, activityFilter))
            .map((job) => {
                const level: EventLevel = job.error
                    ? "error"
                    : job.status === "failed"
                        ? "error"
                        : job.status === "completed"
                            ? "success"
                            : job.status === "cancelled"
                                ? "warning"
                                : "info";

                const retryJobId = Number(job.id);
                const canRetry = Number.isFinite(retryJobId)
                    && job.error
                    && isRetryableJob(job)
                    && !hasMoreInFlightActivity
                    && !hasSupersedingSuccess(job);

                return {
                    id: `job-${job.id}`,
                    sourceId: Number(job.id || 0),
                    sortTime: Number(job.endTime || job.startTime || 0),
                    levelIcon: getLevelIcon(level),
                    typeIcon: getActivityTypeIcon(job),
                    timeLabel: formatRelativeTime(job.endTime || job.startTime),
                    component: formatJobType(job),
                    title: formatJobType(job),
                    description: formatJobDescription(job) || "No additional details",
                    badges: formatLifecycleBadges(job),
                    error: job.error || undefined,
                    retryJobId: canRetry ? retryJobId : undefined,
                };
            });

        const auditRows = libraryAuditEvents
            .filter((event) => matchesHistoryAuditFilter(event.eventType, activityFilter))
            .map((event) => ({
                id: `audit-${event.id}`,
                sourceId: event.id,
                sortTime: Number(new Date(event.date).getTime()) || 0,
                levelIcon: getLevelIcon(getHistoryAuditLevel(event.eventType)),
                timeLabel: formatRelativeTime(event.date),
                component: "Library audit",
                title: formatHistoryAuditLabel(event.eventType),
                description: formatHistoryAuditSummary(event),
                badges: formatHistoryAuditBadges(event),
            }));

        return [...jobRows, ...auditRows].sort((left, right) => {
            if (left.sortTime !== right.sortTime) return right.sortTime - left.sortTime;
            return right.sourceId - left.sourceId;
        });
    }, [activityFilter, hasMoreInFlightActivity, historyJobs, inFlightActivityItems, libraryAuditEvents]);

    const columns = useMemo<DataGridColumn<EventRow>[]>(() => [
        {
            key: "level",
            header: "Level",
            width: "minmax(74px, 0.45fr)",
            align: "center",
            render: (row) => (
                <div className={styles.levelCell}>
                    {row.levelIcon}
                    {row.typeIcon ? <span className={styles.typeIconSlot}>{row.typeIcon}</span> : null}
                </div>
            ),
        },
        {
            key: "time",
            header: "Time",
            width: "minmax(96px, 0.7fr)",
            render: (row) => <Text>{row.timeLabel}</Text>,
        },
        {
            key: "component",
            header: "Component",
            width: "minmax(160px, 1fr)",
            minWidth: 768,
            render: (row) => <Text weight="semibold">{row.component}</Text>,
        },
        {
            key: "message",
            header: "Message",
            width: "minmax(280px, 2.3fr)",
            render: (row) => (
                <div className={styles.messageCell}>
                    <Text weight="semibold" className={styles.messageTitle}>{row.title}</Text>
                    <Text className={styles.messageDescription}>{row.description}</Text>
                    {row.error ? <Text className={styles.messageError}>Error: {row.error}</Text> : null}
                    {row.badges.length > 0 ? (
                        <div className={styles.badgeRow}>
                            {row.badges.slice(0, 2).map((badge) => (
                                <Badge key={`${row.id}-${badge}`} size="small" appearance="tint" color="informative">
                                    {badge}
                                </Badge>
                            ))}
                        </div>
                    ) : null}
                </div>
            ),
        },
        {
            key: "action",
            header: "Action",
            width: "minmax(86px, 0.6fr)",
            align: "right",
            render: (row) => row.retryJobId
                ? (
                    <Button
                        size="small"
                        appearance="subtle"
                        icon={<ArrowClockwise24Regular />}
                        title="Retry Job"
                        onClick={() => retryItem(row.retryJobId as number)}
                    />
                )
                : <Text>—</Text>,
        },
    ], [retryItem, styles.badgeRow, styles.levelCell, styles.messageCell, styles.messageDescription, styles.messageError, styles.messageTitle, styles.typeIconSlot]);

    const showCachedNotice = hasActivityRefreshError && rows.length > 0;
    const showUnavailableState = hasActivityRefreshError && rows.length === 0;
    const showEmptyState = !isActivityInitialLoading && !isLibraryAuditLoading && rows.length === 0;

    return (
        <div className={styles.root}>
            <CachedRefreshNotice
                visible={showCachedNotice}
                cachedLabel="activity"
                errorMessage={activityRefreshErrorMessage}
            />

            <section className={styles.section} aria-label="Events">
                <div className={styles.sectionHeader}>
                    <Text weight="semibold">Events</Text>
                    <Text size={200} className={styles.sectionCount}>{rows.length}</Text>
                </div>
                <DataGrid
                    compact
                    loading={isActivityInitialLoading && rows.length === 0}
                    items={rows}
                    getRowKey={(item) => item.id}
                    columns={columns}
                    emptyContent={
                        showUnavailableState
                            ? (
                                <EmptyState
                                    title="Activity unavailable"
                                    description={activityRefreshErrorMessage || "Unable to load activity right now."}
                                    icon={<DismissCircle24Filled />}
                                />
                            )
                            : (
                                <EmptyState
                                    title={showEmptyState ? "No recent activity" : "Loading activity"}
                                    description={showEmptyState ? "Completed, failed, and audit events appear here." : "Fetching recent activity..."}
                                    icon={<Clock24Regular />}
                                />
                            )
                    }
                />
                {hasMoreActivity && (
                    <div className={styles.loadMoreRow}>
                        <Button appearance="subtle" onClick={() => void loadMoreActivity()} disabled={isLoadingMoreActivity}>
                            {isLoadingMoreActivity ? "Loading..." : "Load More"}
                        </Button>
                    </div>
                )}
            </section>
        </div>
    );
};

export default ActivityTab;
