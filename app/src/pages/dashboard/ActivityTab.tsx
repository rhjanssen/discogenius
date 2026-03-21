import { useEffect, useRef } from "react";
import {
    Badge,
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
import type { ActivityJobContract as ActivityJob } from "@contracts/status";
import type { HistoryEventItemContract } from "@contracts/history";
import { EmptyState, LoadingState } from "@/components/ui/ContentState";
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

type ActivitySource = 'active' | 'queued' | 'history';

type ActivityEntry = {
    job: ActivityJob;
    source: ActivitySource;
    sortTime: number;
};

function getActivitySortTime(job: ActivityJob, source: ActivitySource) {
    const primary = source === 'history'
        ? Number(job?.endTime || job?.startTime || 0)
        : Number(job?.startTime || 0);
    return Number.isFinite(primary) ? primary : 0;
}

function getActivitySequencePriority(job: ActivityJob) {
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
    activeJobs: ActivityJob[];
    queuedJobs: ActivityJob[];
    jobHistory: ActivityJob[];
    libraryAuditEvents: HistoryEventItemContract[];
    activityFilter: string;
    isInitialLoading: boolean;
    isLibraryAuditLoading: boolean;
    hasMoreHistory: boolean;
    isLoadingMoreHistory: boolean;
    onLoadMoreHistory: () => Promise<void>;
}

function getJobPayload(job: ActivityJob): Record<string, unknown> | null {
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

function getHistoryEventData(event: HistoryEventItemContract): Record<string, unknown> | null {
    return event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? event.data as Record<string, unknown>
        : null;
}

function compactPath(value?: string | null): string {
    const text = String(value || "").trim().replace(/\\/g, "/");
    if (!text) {
        return "";
    }

    const segments = text.split("/").filter(Boolean);
    if (segments.length <= 2) {
        return text;
    }

    return `…/${segments.slice(-2).join("/")}`;
}

function humanizeLifecycleReason(value?: string | null): string {
    const reason = String(value || "").trim();
    if (!reason) {
        return "";
    }

    const normalized = reason.replace(/_/g, " ");
    switch (normalized) {
        case "upgrade": return "Upgrade";
        case "monitoring": return "Monitoring";
        case "metadata refresh": return "Metadata refresh";
        case "manual": return "Manual";
        case "retry": return "Retry";
        default:
            return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
}


function formatActivityLifecycleBadges(job: ActivityJob, source: ActivitySource): string[] {
    const payload = getJobPayload(job);
    const badges: string[] = [];

    // Only show meaningful badges, not status (already shown by icons) or trigger (always 1)
    const reason = humanizeLifecycleReason(String(payload?.reason || ''));
    if (reason) {
        badges.push(reason);
    }

    if (payload?.originalJobId) {
        badges.push(`Retry of #${payload.originalJobId}`);
    }

    if (payload?.workflow) {
        badges.push(String(payload.workflow).replace(/_/g, " "));
    }

    return badges;
}

function formatHistoryAuditLabel(eventType: HistoryEventItemContract["eventType"]): string {
    switch (eventType) {
        case "DownloadImported":
            return "Download imported";
        case "DownloadFailed":
            return "Download failed";
        case "AlbumImportIncomplete":
            return "Import incomplete";
        case "TrackFileImported":
            return "File imported";
        case "TrackFileRenamed":
            return "File renamed";
        case "TrackFileDeleted":
            return "File deleted";
        case "TrackFileRetagged":
            return "File retagged";
        case "Grabbed":
            return "Grabbed";
        case "DownloadIgnored":
            return "Ignored";
        default:
            return "History event";
    }
}

function formatHistoryAuditSummary(event: HistoryEventItemContract): string {
    const data = getHistoryEventData(event);
    if (!data) {
        return event.sourceTitle || "Audit entry";
    }

    if (event.eventType === "DownloadImported") {
        const processed = data.processedTrackIds as Record<string, unknown> | undefined;
        const processedCount = processed && typeof processed.count === "number" ? processed.count : undefined;
        const expectedCount = processed && typeof processed.expected === "number" ? processed.expected : undefined;
        if (typeof processedCount === "number" && typeof expectedCount === "number") {
            return `Processed ${processedCount}/${expectedCount} track(s)`;
        }
        return `Imported ${String(data.type || "item")}`;
    }

    if (event.eventType === "AlbumImportIncomplete") {
        const processed = data.processedTrackIds as Record<string, unknown> | undefined;
        const processedCount = processed && typeof processed.count === "number" ? processed.count : undefined;
        const expectedCount = processed && typeof processed.expected === "number" ? processed.expected : undefined;
        if (typeof processedCount === "number" && typeof expectedCount === "number") {
            return `Imported ${processedCount}/${expectedCount} track(s)`;
        }
        return "Album import incomplete";
    }

    if (event.eventType === "DownloadFailed") {
        return `Error: ${String(data.error || "Download failed")}`;
    }

    if (event.eventType === "TrackFileImported") {
        return data.importedPath ? `Imported to ${compactPath(String(data.importedPath))}` : "Imported into the library";
    }

    if (event.eventType === "TrackFileRenamed") {
        const fromPath = compactPath(String(data.fromPath || ""));
        const toPath = compactPath(String(data.toPath || ""));
        if (fromPath && toPath) {
            return `${fromPath} → ${toPath}`;
        }
        return "Renamed file";
    }

    if (event.eventType === "TrackFileDeleted") {
        const fileType = String(data.fileType || "").trim();
        return fileType ? `Deleted ${fileType}` : "Deleted file";
    }

    if (event.eventType === "TrackFileRetagged") {
        const fileType = String(data.fileType || "").trim();
        return fileType ? `Retagged ${fileType}` : "Updated tags";
    }

    return event.sourceTitle || "Audit entry";
}

function formatHistoryAuditBadges(event: HistoryEventItemContract): string[] {
    const data = getHistoryEventData(event);
    const badges: string[] = [];

    if (event.quality) {
        badges.push(event.quality);
    }

    if (event.libraryFileId !== null) {
        badges.push(`File #${event.libraryFileId}`);
    }

    if (event.albumId !== null) {
        badges.push(`Album #${event.albumId}`);
    }

    if (event.mediaId !== null) {
        badges.push(`Media #${event.mediaId}`);
    }

    if (data?.type) {
        badges.push(String(data.type).replace(/_/g, " "));
    }

    return badges;
}

function matchesHistoryAuditFilter(eventType: HistoryEventItemContract["eventType"], activityFilter: string): boolean {
    if (activityFilter === "all") {
        return true;
    }

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

function getHistoryAuditIcon(eventType: HistoryEventItemContract["eventType"]) {
    switch (eventType) {
        case "DownloadFailed":
        case "TrackFileDeleted":
            return <ErrorCircle24Filled style={{ width: 16, height: 16 }} />;
        case "DownloadImported":
        case "TrackFileImported":
            return <CheckmarkCircle24Filled style={{ width: 16, height: 16 }} />;
        case "TrackFileRenamed":
        case "TrackFileRetagged":
            return <ArrowClockwise24Regular style={{ width: 16, height: 16 }} />;
        default:
            return <Clock24Regular style={{ width: 16, height: 16 }} />;
    }
}
function getJobTidalId(job: ActivityJob): string {
    const payload = getJobPayload(job);
    const legacyRefId = (job as ActivityJob & { ref_id?: string }).ref_id;
    return String(payload?.tidalId || legacyRefId || '').trim();
}

function getJobMediaType(job: ActivityJob): string {
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

function buildSectionEntries(jobs: ActivityJob[], source: ActivitySource, activityFilter: string): ActivityEntry[] {
    return jobs
        .filter((job) => matchesActivityFilter(job, activityFilter))
        .map((job) => ({ job, source, sortTime: getActivitySortTime(job, source) }))
        .sort(compareActivityEntries);
}

function buildAuditEntries(events: HistoryEventItemContract[], activityFilter: string) {
    return events
        .filter((event) => matchesHistoryAuditFilter(event.eventType, activityFilter))
        .map((event) => ({
            event,
            sortTime: Number(new Date(event.date).getTime()) || 0,
        }))
        .sort((left, right) => {
            if (left.sortTime !== right.sortTime) {
                return right.sortTime - left.sortTime;
            }

            return right.event.id - left.event.id;
        });
}

const ActivityTab = ({
    activeJobs,
    queuedJobs,
    jobHistory,
    libraryAuditEvents,
    activityFilter,
    isInitialLoading,
    isLibraryAuditLoading,
    hasMoreHistory,
    isLoadingMoreHistory,
    onLoadMoreHistory,
}: ActivityTabProps) => {
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

    const isRetryableJob = (job: ActivityJob) => {
        const type = job?.type || '';
        return type.startsWith('Download') || type === 'ImportDownload' || type === 'ImportPlaylist';
    };

    const hasSupersedingSuccess = (job: ActivityJob) => {
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

    const getStatusIcon = (status?: string, error?: string) => {
        if (error) return <ErrorCircle24Filled className={styles.statusIconError} />;
        switch (status) {
            case "completed": return <CheckmarkCircle24Filled className={styles.statusIconSuccess} />;
            case "failed": return <ErrorCircle24Filled className={styles.statusIconError} />;
            default: return <Clock24Regular className={styles.statusIconNeutral} />;
        }
    };

    const activeEntries = buildSectionEntries(activeJobs, 'active', activityFilter);
    const queuedEntries = buildSectionEntries(queuedJobs, 'queued', activityFilter);
    const historyEntries = buildSectionEntries(jobHistory, 'history', activityFilter);
    const auditEntries = buildAuditEntries(libraryAuditEvents, activityFilter);
    const hasVisibleHistory = historyEntries.length > 0 || hasMoreHistory;
    const hasVisibleAudit = auditEntries.length > 0 || isLibraryAuditLoading;
    const hasAnyEntries = activeEntries.length > 0 || queuedEntries.length > 0 || historyEntries.length > 0 || auditEntries.length > 0;

    if (isInitialLoading && !hasAnyEntries) {
        return (
            <div className={styles.tabSection}>
                <LoadingState label="Loading activity..." />
            </div>
        );
    }

    if (!hasAnyEntries) {
        return (
            <div className={styles.tabSection}>
                <EmptyState
                    title="No recent activity"
                    description="Background jobs, scans, and imports will appear here."
                    icon={<Clock24Regular />}
                />
            </div>
        );
    }

    const renderActiveOrQueuedEntry = ({ job, source }: ActivityEntry) => {
        const payload = getJobPayload(job);
        const isUpgrade = payload?.reason === 'upgrade';
        const lifecycleBadges = formatActivityLifecycleBadges(job, source);
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
                        {formatJobDescription(job) && (
                            <Text size={200} className={styles.activityInlineDescription}>
                                {formatJobDescription(job)}
                            </Text>
                        )}
                    </div>
                    {lifecycleBadges.length > 0 && (
                        <div className={styles.activityBadgeRow}>
                            {lifecycleBadges.map((badge) => (
                                <Badge key={badge} size="small" appearance="tint" color="informative">
                                    {badge}
                                </Badge>
                            ))}
                        </div>
                    )}
                </div>
                <div className={styles.activityTimeColumn}>
                    <Text className={styles.activityTime}>{formatRelativeTime(job.startTime)}</Text>
                </div>
            </div>
        );
    };

    const renderHistoryEntry = ({ job }: ActivityEntry) => {
        const retryJobId = Number(job.id);
        const canRetry = Number.isFinite(retryJobId);
        const lifecycleBadges = formatActivityLifecycleBadges(job, 'history');

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
                        {formatJobDescription(job) && (
                            <Text size={200} className={styles.activityInlineDescription} truncate={!job.error}>
                                {formatJobDescription(job)}
                            </Text>
                        )}
                    </div>
                    {lifecycleBadges.length > 0 && (
                        <div className={styles.activityBadgeRow}>
                            {lifecycleBadges.map((badge) => (
                                <Badge key={badge} size="small" appearance="tint" color="informative">
                                    {badge}
                                </Badge>
                            ))}
                        </div>
                    )}
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
                        {job.error && isRetryableJob(job) && !hasSupersedingSuccess(job) && canRetry && (
                            <Button size="small" appearance="subtle" icon={<ArrowClockwise24Regular />} title="Retry Job" onClick={(e) => { e.stopPropagation(); retryItem(retryJobId); }} />
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderAuditEntry = (event: HistoryEventItemContract) => {
        const eventBadges = formatHistoryAuditBadges(event);
        const eventIcon = getHistoryAuditIcon(event.eventType);

        return (
            <div key={`audit-${event.id}`} className={styles.activityAuditItem}>
                <div className={styles.activityLeading}>
                    <div className={styles.activityLeadingContent}>
                        <span className={styles.activityAuditIcon}>{eventIcon}</span>
                    </div>
                </div>
                <div className={styles.activityContent}>
                    <div className={styles.activitySummaryRow}>
                        <Text weight="semibold" size={300} className={styles.activityTitleText}>
                            {formatHistoryAuditLabel(event.eventType)}
                        </Text>
                        {event.sourceTitle && (
                            <Text size={200} className={styles.activityInlineDescription} truncate>
                                {event.sourceTitle}
                            </Text>
                        )}
                    </div>
                    <Text size={200} className={styles.activitySecondaryText}>
                        {formatHistoryAuditSummary(event)}
                    </Text>
                    {eventBadges.length > 0 && (
                        <div className={styles.activityBadgeRow}>
                            {eventBadges.map((badge) => (
                                <Badge key={badge} size="small" appearance="tint" color="brand">
                                    {badge}
                                </Badge>
                            ))}
                        </div>
                    )}
                </div>
                <div className={styles.activityTimeColumn}>
                    <Text className={styles.activityTime}>{formatRelativeTime(event.date)}</Text>
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
                    <Text size={200} weight="semibold" className={styles.activitySectionLabel}>
                        {label}
                    </Text>
                    <Text size={100} className={styles.activitySectionCount}>
                        {entries.length}
                    </Text>
                </div>
                <div className={styles.activitySectionItems}>
                    {source === 'history'
                        ? entries.map(renderHistoryEntry)
                        : entries.map(renderActiveOrQueuedEntry)}
                </div>
            </section>
        );
    };

    const renderAuditSection = () => {
        if (!hasVisibleAudit) {
            return null;
        }

        return (
            <section className={styles.activitySection} aria-label="Library audit">
                <div className={styles.activitySectionHeader}>
                    <Text size={200} weight="semibold" className={styles.activitySectionLabel}>
                        Library audit
                    </Text>
                    <Text size={100} className={styles.activitySectionCount}>
                        {isLibraryAuditLoading && auditEntries.length === 0 ? "…" : auditEntries.length}
                    </Text>
                </div>
                <div className={styles.activitySectionItems}>
                    {auditEntries.length > 0
                        ? auditEntries.map(({ event }) => renderAuditEntry(event))
                        : (
                            <div className={styles.activityAuditLoadingRow}>
                                <Spinner size="tiny" />
                                <Text size={200} className={styles.activitySecondaryText}>Loading recent file activity…</Text>
                            </div>
                        )}
                </div>
            </section>
        );
    };

    return (
        <div className={styles.tabSection}>
            <div className={styles.activityList}>
                {renderSection("Running", activeEntries, 'active')}
                {renderSection("Queued", queuedEntries, 'queued')}
                {hasVisibleHistory && (
                    <section className={styles.activitySection} aria-label="Recent">
                        <div className={styles.activitySectionHeader}>
                            <Text size={200} weight="semibold" className={styles.activitySectionLabel}>
                                Recent
                            </Text>
                            <Text size={100} className={styles.activitySectionCount}>
                                {historyEntries.length}
                            </Text>
                        </div>
                        <div className={styles.activitySectionItems}>
                            {historyEntries.map(renderHistoryEntry)}
                            {hasMoreHistory && (
                                <div className={styles.loadMoreRow}>
                                    <div ref={loadMoreRef} />
                                    <Button appearance="subtle" onClick={() => void onLoadMoreHistory()} disabled={isLoadingMoreHistory}>
                                        {isLoadingMoreHistory ? 'Loading…' : 'Load More'}
                                    </Button>
                                </div>
                            )}
                        </div>
                    </section>
                )}
                {renderAuditSection()}
            </div>
        </div>
    );
};

export default ActivityTab;
