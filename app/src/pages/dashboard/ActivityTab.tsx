import { useCallback, useMemo } from "react";
import {
    Button,
    Spinner,
    Text,
} from "@fluentui/react-components";
import {
    ArrowClockwise24Regular,
    CheckmarkCircle24Filled,
    Clock24Regular,
    DismissCircle24Filled,
    Warning24Filled,
} from "@fluentui/react-icons";
import { EmptyState } from "@/components/ui/ContentState";
import { ActivityListSkeleton } from "@/components/ui/LoadingSkeletons";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useActivityInFlightFeed } from "@/hooks/useActivityInFlightFeed";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import type { ActivityJobContract as ActivityJob } from "@contracts/status";
import CachedRefreshNotice from "./CachedRefreshNotice";
import { useDashboardStyles } from "./dashboardStyles";
import {
    formatJobDescription,
    formatJobType,
    formatRelativeTime,
    getActivityTypeIcon,
    matchesActivityFilter,
} from "./dashboardUtils";

type ActivityTabProps = {
    activityFilter: string;
    isActive: boolean;
};

type ActivitySource = "running" | "queued" | "history";
type EventLevel = "success" | "warning" | "error" | "info";

type ActivityEntry = {
    job: ActivityJob;
    source: ActivitySource;
    sortTime: number;
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
    return typeof job.payload === "object" ? (job.payload as Record<string, unknown>) : null;
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

function getActivitySortTime(job: ActivityJob, source: ActivitySource): number {
    const timestamp = source === "history"
        ? Number(job.endTime || job.startTime || 0)
        : Number(job.startTime || 0);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareHistoryActivityEntries(left: ActivityEntry, right: ActivityEntry): number {
    if (left.sortTime !== right.sortTime) {
        return right.sortTime - left.sortTime;
    }

    return Number(right.job.id || 0) - Number(left.job.id || 0);
}

function humanizeActivityReason(value: unknown): string {
    const reason = String(value || "").trim().replace(/_/g, " ");
    if (!reason) return "";
    return reason.charAt(0).toUpperCase() + reason.slice(1);
}

function formatActivityDescription(job: ActivityJob, source: ActivitySource): string {
    const payload = getJobPayload(job);
    const parts: string[] = [];

    const description = formatJobDescription(job);
    if (description) {
        parts.push(description);
    }

    if (source === "queued" && Number.isFinite(Number(job.queuePosition))) {
        parts.push(`Queue #${Number(job.queuePosition)}`);
    }

    const reason = humanizeActivityReason(payload?.reason);
    if (reason) {
        parts.push(reason);
    }

    if (payload?.originalJobId) {
        parts.push(`Retry of #${String(payload.originalJobId)}`);
    }

    return parts.join(" | ");
}

function buildSectionEntries(jobs: ActivityJob[], source: ActivitySource, activityFilter: string): ActivityEntry[] {
    const entries = jobs
        .filter((job) => matchesActivityFilter(job, activityFilter))
        .map((job) => ({ job, source, sortTime: getActivitySortTime(job, source) }));

    if (source === "history") {
        entries.sort(compareHistoryActivityEntries);
    }

    return entries;
}

const ActivityTab = ({
    activityFilter,
    isActive,
}: ActivityTabProps) => {
    const styles = useDashboardStyles();
    const { retryItem } = useQueueStatus();
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
        isFetchingNextPage: isLoadingMoreInFlightActivity,
        fetchNextPage: loadMoreInFlightActivity,
    } = useActivityInFlightFeed({ enabled: isActive });

    const historyJobs = useMemo(
        () => activityItems.filter((job) => ["completed", "failed", "cancelled"].includes(String(job.status || ""))),
        [activityItems],
    );

    const runningJobs = useMemo(
        () => inFlightActivityItems.filter((job) => ["running", "processing"].includes(String(job.status || ""))),
        [inFlightActivityItems],
    );

    const queuedJobs = useMemo(
        () => inFlightActivityItems.filter((job) => String(job.status || "") === "pending"),
        [inFlightActivityItems],
    );

    const isRetryableJob = (job: ActivityJob) => {
        const type = job?.type || "";
        return type.startsWith("Download") || type === "ImportDownload" || type === "ImportPlaylist";
    };

    const hasSupersedingSuccess = useCallback((job: ActivityJob) => {
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
    }, [historyJobs, inFlightActivityItems]);

    const runningEntries = useMemo(
        () => buildSectionEntries(runningJobs, "running", activityFilter),
        [activityFilter, runningJobs],
    );

    const queuedEntries = useMemo(
        () => buildSectionEntries(queuedJobs, "queued", activityFilter),
        [activityFilter, queuedJobs],
    );

    const historyEntries = useMemo(
        () => buildSectionEntries(historyJobs, "history", activityFilter),
        [activityFilter, historyJobs],
    );

    const getStatusIcon = (level: EventLevel, source: ActivitySource) => {
        switch (level) {
            case "success":
                return <CheckmarkCircle24Filled className={source === "history" ? styles.statusIconSuccessHistory : styles.statusIconSuccess} />;
            case "warning":
                return <Warning24Filled className={styles.statusIconNeutral} />;
            case "error":
                return <DismissCircle24Filled className={styles.statusIconError} />;
            default:
                return <Clock24Regular className={styles.statusIconNeutral} />;
        }
    };

    const renderActivityEntry = (entry: ActivityEntry) => {
        const { job, source } = entry;
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
        const canRetry = source === "history"
            && Number.isFinite(retryJobId)
            && job.error
            && isRetryableJob(job)
            && !hasMoreInFlightActivity
            && !hasSupersedingSuccess(job);
        const description = formatActivityDescription(job, source);

        return (
            <div key={`${source}-${String(job.id)}`} className={styles.activityItem}>
                <div className={styles.activityLeading}>
                    <div className={source === "history" ? styles.activityLeadingContent : styles.activityLeadingContentCompact}>
                        {source === "running"
                            ? <Spinner size="tiny" />
                            : getStatusIcon(level, source)}
                        <span className={styles.activityIconOffset}>{getActivityTypeIcon(job)}</span>
                    </div>
                </div>
                <div className={styles.activityContent}>
                    <div className={styles.activitySummaryRow}>
                        <div className={styles.activityTitleStack}>
                            <Text weight="semibold" size={300} className={styles.activityTitleText}>
                                {formatJobType(job)}
                            </Text>
                            {description ? (
                                <Text size={200} className={styles.activityInlineDescription}>
                                    {description}
                                </Text>
                            ) : null}
                            {job.error ? <Text size={200} className={styles.activityErrorText}>Error: {job.error}</Text> : null}
                        </div>
                        <div className={styles.activityTimeActions}>
                            <Text className={styles.activityTime}>
                                {formatRelativeTime(source === "history" ? (job.endTime || job.startTime) : job.startTime)}
                            </Text>
                            {canRetry ? (
                                <Button
                                    size="small"
                                    appearance="subtle"
                                    icon={<ArrowClockwise24Regular />}
                                    title="Retry Job"
                                    onClick={() => retryItem(retryJobId)}
                                />
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderSection = (label: string, entries: ActivityEntry[], source: ActivitySource) => {
        if (entries.length === 0) {
            return null;
        }

        return (
            <section key={source} className={styles.activitySection} aria-label={label}>
                <div className={styles.activitySectionHeader}>
                    <Text size={200} weight="semibold" className={styles.activitySectionLabel}>{label}</Text>
                </div>
                <div className={styles.activitySectionItems}>
                    {entries.map((entry) => renderActivityEntry(entry))}
                </div>
            </section>
        );
    };

    const showCachedNotice = hasActivityRefreshError && (runningEntries.length > 0 || queuedEntries.length > 0 || historyEntries.length > 0);
    const showUnavailableState = hasActivityRefreshError && runningEntries.length === 0 && queuedEntries.length === 0 && historyEntries.length === 0;
    const showInitialLoadingState = isActivityInitialLoading
        && runningEntries.length === 0
        && queuedEntries.length === 0
        && historyEntries.length === 0;
    const showEmptyState = !showInitialLoadingState
        && !isActivityInitialLoading
        && runningEntries.length === 0
        && queuedEntries.length === 0
        && historyEntries.length === 0;

    if (showInitialLoadingState && !showUnavailableState) {
        return (
            <div className={styles.tabSection}>
                <ActivityListSkeleton rows={6} />
            </div>
        );
    }

    return (
        <div className={styles.tabSection}>
            <CachedRefreshNotice
                visible={showCachedNotice}
                cachedLabel="activity"
                errorMessage={activityRefreshErrorMessage}
            />

            {showUnavailableState ? (
                <EmptyState
                    title="Activity unavailable"
                    description={activityRefreshErrorMessage || "Unable to load activity right now."}
                    icon={<DismissCircle24Filled />}
                />
            ) : showEmptyState ? (
                <EmptyState
                    title="No recent activity"
                    description="Background jobs, downloads, scans, and imports appear here."
                    icon={<Clock24Regular />}
                />
            ) : (
                <div className={styles.activityList}>
                    {renderSection("Running", runningEntries, "running")}
                    {renderSection("Queued", queuedEntries, "queued")}
                    {hasMoreInFlightActivity ? (
                        <div className={styles.loadMoreRow}>
                            <Button appearance="subtle" onClick={() => void loadMoreInFlightActivity()} disabled={isLoadingMoreInFlightActivity}>
                                {isLoadingMoreInFlightActivity ? "Loading..." : "Load more queued"}
                            </Button>
                        </div>
                    ) : null}
                    <section className={styles.activitySection} aria-label="Recent">
                        <div className={styles.activitySectionHeader}>
                            <Text size={200} weight="semibold" className={styles.activitySectionLabel}>Recent</Text>
                        </div>
                        <div className={styles.activitySectionItems}>
                            {historyEntries.map((entry) => renderActivityEntry(entry))}
                            {hasMoreActivity ? (
                                <div className={styles.loadMoreRow}>
                                    <Button appearance="subtle" onClick={() => void loadMoreActivity()} disabled={isLoadingMoreActivity}>
                                        {isLoadingMoreActivity ? "Loading..." : "Load more"}
                                    </Button>
                                </div>
                            ) : null}
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
};

export default ActivityTab;

