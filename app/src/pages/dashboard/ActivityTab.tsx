import { useEffect, useRef } from "react";
import {
    Button,
    mergeClasses,
    Spinner,
    Text,
} from "@fluentui/react-components";
import {
    CheckmarkCircle24Filled,
    ErrorCircle24Filled,
    ArrowClockwise24Regular,
    Clock24Regular,
} from "@fluentui/react-icons";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import { useDashboardStyles } from "./dashboardStyles";
import {
    formatJobType,
    formatJobDescription,
    formatRelativeTime,
    getActivityTypeIcon,
    matchesActivityFilter,
} from "./dashboardUtils";

const COORDINATOR_JOB_TYPES = new Set([
    'RefreshMetadata',
    'ApplyCuration',
    'DownloadMissing',
]);

const WORKFLOW_CHILD_JOB_TYPES = new Set([
    'RefreshArtist',
    'CurateArtist',
    'RescanFolders',
]);

type ActivityEntry = {
    job: any;
    source: 'active' | 'queued' | 'history';
    sortTime: number;
};

function getActivitySortTime(job: any, source: 'active' | 'queued' | 'history') {
    const primary = source === 'history'
        ? Number(job?.endTime || job?.startTime || 0)
        : Number(job?.startTime || 0);
    return Number.isFinite(primary) ? primary : 0;
}

function getActivitySequencePriority(job: any) {
    const type = String(job?.type || '');
    if (COORDINATOR_JOB_TYPES.has(type)) return 2;
    if (WORKFLOW_CHILD_JOB_TYPES.has(type)) return 1;
    return 0;
}

function compareActivityEntries(left: ActivityEntry, right: ActivityEntry) {
    const leftTrigger = Number(left.job?.trigger || 0);
    const rightTrigger = Number(right.job?.trigger || 0);

    if (leftTrigger === rightTrigger && Math.abs(left.sortTime - right.sortTime) <= 60_000) {
        const priorityDelta = getActivitySequencePriority(right.job) - getActivitySequencePriority(left.job);
        if (priorityDelta !== 0) {
            return priorityDelta;
        }
    }

    if (left.sortTime !== right.sortTime) {
        return right.sortTime - left.sortTime;
    }

    return Number(right.job?.id || 0) - Number(left.job?.id || 0);
}

interface ActivityTabProps {
    activeJobs: any[];
    queuedJobs: any[];
    jobHistory: any[];
    activityFilter: string;
    isInitialLoading: boolean;
    hasMoreHistory: boolean;
    isLoadingMoreHistory: boolean;
    onLoadMoreHistory: () => Promise<void>;
}

function getJobPayload(job: any): Record<string, unknown> | null {
    if (!job?.payload) return null;
    if (typeof job.payload === 'string') {
        try {
            return JSON.parse(job.payload) as Record<string, unknown>;
        } catch {
            return null;
        }
    }
    return typeof job.payload === 'object' ? job.payload as Record<string, unknown> : null;
}

function getJobTidalId(job: any): string {
    const payload = getJobPayload(job);
    return String(payload?.tidalId || job?.ref_id || '').trim();
}

function getJobMediaType(job: any): string {
    const payload = getJobPayload(job);
    const payloadType = String(payload?.type || '').trim();
    if (payloadType) {
        return payloadType;
    }

    switch (job?.type) {
        case 'DownloadAlbum':
            return 'album';
        case 'DownloadTrack':
            return 'track';
        case 'DownloadVideo':
            return 'video';
        case 'DownloadPlaylist':
            return 'playlist';
        default:
            return '';
    }
}

const ActivityTab = ({ activeJobs, queuedJobs, jobHistory, activityFilter, isInitialLoading, hasMoreHistory, isLoadingMoreHistory, onLoadMoreHistory }: ActivityTabProps) => {
    const styles = useDashboardStyles();
    const { retryItem } = useDownloadQueue();
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    const loadingRef = useRef(false);

    useEffect(() => {
        loadingRef.current = isLoadingMoreHistory;
    }, [isLoadingMoreHistory]);

    useEffect(() => {
        const node = loadMoreRef.current;
        if (!node || !hasMoreHistory) {
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting) || loadingRef.current) {
                return;
            }

            loadingRef.current = true;
            void onLoadMoreHistory().finally(() => {
                loadingRef.current = false;
            });
        }, { rootMargin: '160px 0px' });

        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMoreHistory, onLoadMoreHistory]);

    const isRetryableJob = (job: any) => {
        const type = job?.type || '';
        return type.startsWith('Download') || type === 'ImportDownload' || type === 'ImportPlaylist';
    };

    const hasSupersedingSuccess = (job: any) => {
        if (job?.type !== 'ImportDownload' || !job?.error) {
            return false;
        }

        const tidalId = getJobTidalId(job);
        const mediaType = getJobMediaType(job);
        if (!tidalId || !mediaType) {
            return false;
        }

        const jobTime = Number(job?.endTime || job?.startTime || 0);
        const wasRecoveredInHistory = jobHistory.some((candidate) => {
            if (candidate?.status !== 'completed') {
                return false;
            }

            const sameItem = getJobTidalId(candidate) === tidalId && getJobMediaType(candidate) === mediaType;
            const laterCompletion = Number(candidate?.endTime || candidate?.startTime || 0) > jobTime;
            return sameItem && laterCompletion;
        });

        if (wasRecoveredInHistory) {
            return true;
        }

        return [...activeJobs, ...queuedJobs].some((candidate) => {
            if (!candidate || (candidate.status !== 'running' && candidate.status !== 'processing' && candidate.status !== 'pending')) {
                return false;
            }

            return getJobTidalId(candidate) === tidalId && getJobMediaType(candidate) === mediaType;
        });
    };

    const getStatusIcon = (status: string, error?: string) => {
        if (error) return <ErrorCircle24Filled className={styles.statusIconError} />;
        switch (status) {
            case "completed": return <CheckmarkCircle24Filled className={styles.statusIconSuccess} />;
            case "failed": return <ErrorCircle24Filled className={styles.statusIconError} />;
            default: return <Clock24Regular className={styles.statusIconNeutral} />;
        }
    };

    const activityEntries: ActivityEntry[] = [
        ...activeJobs
            .filter((job) => matchesActivityFilter(job, activityFilter))
            .map((job) => ({ job, source: 'active' as const, sortTime: getActivitySortTime(job, 'active') })),
        ...queuedJobs
            .filter((job) => matchesActivityFilter(job, activityFilter))
            .map((job) => ({ job, source: 'queued' as const, sortTime: getActivitySortTime(job, 'queued') })),
        ...jobHistory
            .filter((job) => matchesActivityFilter(job, activityFilter))
            .map((job) => ({ job, source: 'history' as const, sortTime: getActivitySortTime(job, 'history') })),
    ].sort(compareActivityEntries);

    if (isInitialLoading && activityEntries.length === 0) {
        return (
            <div className={styles.tabSection}>
                <div className={styles.emptyState}>
                    <Spinner size="small" />
                    <Text className={styles.emptyStateTitle} size={500}>Loading activity</Text>
                    <Text className={styles.emptyStateSubtitle} size={300}>
                        Fetching active and queued jobs.
                    </Text>
                </div>
            </div>
        );
    }

    if (activityEntries.length === 0) {
        return (
            <div className={styles.tabSection}>
                <div className={styles.emptyState}>
                    <Clock24Regular className={styles.emptyStateIcon} />
                    <Text className={styles.emptyStateTitle} size={500}>No recent activity</Text>
                    <Text className={styles.emptyStateSubtitle} size={300}>
                        Background jobs, scans, and imports will appear here.
                    </Text>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.tabSection}>
            <div className={styles.activityList}>
                {activityEntries.map(({ job, source }) => {
                    const jobDescription = formatJobDescription(job);

                    if (source === 'active' || source === 'queued') {
                        const payload = getJobPayload(job);
                        const isUpgrade = payload?.reason === 'upgrade';
                        return (
                            <div key={`${source}-${job.id}`} className={mergeClasses(styles.activityItem, isUpgrade ? styles.activityItemUpgrade : styles.activityItemDefault)}>
                                <div className={styles.activityLeading}>
                                    <div className={styles.activityLeadingContentCompact}>
                                        {source === 'queued' || job.status === 'pending'
                                            ? <Clock24Regular className={styles.statusIconNeutral} />
                                            : <Spinner size="tiny" />}
                                        <span className={styles.activityIconOffset}>{getActivityTypeIcon(job)}</span>
                                    </div>
                                </div>
                                <div className={styles.activityContent}>
                                    <div className={styles.activitySummaryRow}>
                                        <Text weight="semibold" size={300} className={styles.activityTitleText}>
                                            {formatJobType(job)}
                                        </Text>
                                        {jobDescription && (
                                            <Text size={200} className={styles.activityInlineDescription}>
                                                {jobDescription}
                                            </Text>
                                        )}
                                    </div>
                                </div>
                                <div className={styles.activityTimeColumn}>
                                    <Text className={styles.activityTime}>{formatRelativeTime(job.startTime)}</Text>
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div key={`history-${job.id}`} className={styles.activityItem}>
                            <div className={styles.activityLeading}>
                                <div className={styles.activityLeadingContent}>
                                    {getStatusIcon(job.status, job.error)}
                                    {getActivityTypeIcon(job)}
                                </div>
                            </div>
                            <div className={styles.activityContent}>
                                <div className={styles.activitySummaryRow}>
                                    <Text weight="semibold" size={300} className={styles.activityTitleText}>
                                        {formatJobType(job)}
                                    </Text>
                                    {jobDescription && (
                                        <Text size={200} className={styles.activityInlineDescription} truncate={!job.error}>
                                            {jobDescription}
                                        </Text>
                                    )}
                                </div>
                                {job.error && (
                                    <Text size={200} className={styles.activityErrorText}>
                                        Error: {job.error}
                                    </Text>
                                )}
                            </div>
                            <div className={styles.activityTimeColumn}>
                                <div className={styles.activityTimeActions}>
                                    <Text className={styles.activityTime}>
                                        {formatRelativeTime(job.endTime || job.startTime)}
                                    </Text>
                                    {job.error && isRetryableJob(job) && !hasSupersedingSuccess(job) && (
                                        <Button size="small" appearance="subtle" icon={<ArrowClockwise24Regular />} title="Retry Job" onClick={(e) => { e.stopPropagation(); retryItem(job.id); }} />
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
                {hasMoreHistory && (
                    <div className={styles.loadMoreRow}>
                        <div ref={loadMoreRef} />
                        <Button appearance="subtle" onClick={() => void onLoadMoreHistory()} disabled={isLoadingMoreHistory}>
                            {isLoadingMoreHistory ? 'Loading…' : 'Load More'}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ActivityTab;
