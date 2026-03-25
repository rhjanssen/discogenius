import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Button,
    Card,
    Menu,
    MenuItem,
    MenuList,
    MenuPopover,
    MenuTrigger,
    Tab,
    TabList,
    Text,
    Title1,
    tokens,
    makeStyles,
} from "@fluentui/react-components";
import {
    ArrowSync24Regular,
    ChevronDownRegular,
    Play24Regular,
    Pause24Regular,
    MusicNote224Regular,
    Person24Regular,
    Album24Regular,
    Video24Regular,
    ArrowDownload24Regular,
    FolderSearch24Regular,
    Filter24Regular,
    ArrowSortDownLines24Regular,
} from "@fluentui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { LibraryStats } from "@/hooks/useLibrary";
import type { HistoryEventItemContract } from "@contracts/history";
import { useToast } from "@/hooks/useToast";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import {
    ACTIVITY_REFRESH_EVENT,
    LIBRARY_UPDATED_EVENT,
    dispatchActivityRefresh,
} from "@/utils/appEvents";
import { useResponsiveTabsStyles } from "@/components/ui/useResponsiveTabsStyles";
import QueueTab from "./QueueTab";
import ActivityTab from "./ActivityTab";
import ManualImportTab from "./ManualImportTab";
import { useStatusOverview } from "@/hooks/useStatusOverview";

const useStyles = makeStyles({
    container: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
        paddingTop: tokens.spacingVerticalL,
        paddingBottom: tokens.spacingVerticalXXL,
    },
    brandHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        minWidth: 0,
    },
    brandLogo: {
        display: "block",
        width: "32px",
        height: "32px",
        objectFit: "contain",
        flexShrink: 0,
    },
    brandTitle: {
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
    },
    desktopOnly: {
        display: "none",
        "@media (min-width: 640px)": {
            display: "block",
        },
    },
    mobileOnly: {
        display: "block",
        "@media (min-width: 640px)": {
            display: "none",
        },
    },
    header: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalM,
        "@media (max-width: 639px)": {
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
        },
    },
    statsGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: tokens.spacingHorizontalS,
        "@media (min-width: 640px)": {
            gridTemplateColumns: "repeat(4, 1fr)",
        },
    },
    statHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
    },
    statIconSlot: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
    },
    statIcon: {
        width: "16px",
        height: "16px",
        flexShrink: 0,
    },
    statIconArtists: {
        color: "var(--dg-accent-artists)",
    },
    statIconAlbums: {
        color: "var(--dg-accent-albums)",
    },
    statIconTracks: {
        color: "var(--dg-accent-tracks)",
    },
    statIconVideos: {
        color: "var(--dg-accent-videos)",
    },
    statCard: {
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
        backdropFilter: "blur(20px)",
    },
    statValue: {
        fontSize: tokens.fontSizeHero700,
        fontWeight: tokens.fontWeightBold,
        lineHeight: "1",
    },
    statLabel: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
    },
    statDetail: {
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorNeutralForeground3,
    },
    headerActionButton: {
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        flex: "1 1 0",
        minWidth: 0,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}`,
        gap: tokens.spacingVerticalXXS,
        borderRadius: tokens.borderRadiusXLarge,
        "& .fui-Button__content": {
            fontSize: tokens.fontSizeBase100,
            marginLeft: "0 !important",
            textAlign: "center",
            whiteSpace: "normal",
            lineHeight: tokens.lineHeightBase100,
        },
        "& .fui-Button__icon": {
            marginRight: "0",
            fontSize: tokens.fontSizeBase400,
        },
        "@media (min-width: 480px)": {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
            "& .fui-Button__icon": {
                fontSize: tokens.fontSizeBase500,
            },
        },
        "@media (min-width: 768px)": {
            flexDirection: "row",
            flex: "0 0 auto",
            minWidth: "auto",
            gap: tokens.spacingHorizontalNone,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
            "& .fui-Button__content": {
                fontSize: tokens.fontSizeBase300,
                marginTop: "0",
                marginLeft: tokens.spacingHorizontalS,
                whiteSpace: "nowrap",
                lineHeight: tokens.lineHeightBase300,
                textAlign: "left",
            },
            "& .fui-Button__icon": {
                marginRight: tokens.spacingHorizontalSNudge,
                fontSize: tokens.fontSizeBase600,
            },
        },
    },
    headerActionRow: {
        display: "flex",
        alignItems: "stretch",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "nowrap",
        justifyContent: "center",
        width: "100%",
        overflowX: "auto",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": {
            display: "none",
        },
        "@media (min-width: 768px)": {
            justifyContent: "flex-start",
            gap: tokens.spacingHorizontalM,
            overflowX: "visible",
            width: "auto",
        },
    },
    viewTabs: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "nowrap",
        minWidth: 0,
        paddingTop: tokens.spacingVerticalXXS,
        paddingBottom: tokens.spacingVerticalXXS,
        marginBottom: tokens.spacingVerticalS,
        gap: tokens.spacingHorizontalM,
        "@media (max-width: 639px)": {
            gap: tokens.spacingHorizontalS,
        },
    },
    mainCol: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
    },
    queueActionButton: {
        flexShrink: 0,
        whiteSpace: "nowrap",
    },
    tabContentPanel: {
        animationName: {
            from: { opacity: 0, transform: "translateY(10px)" },
            to: { opacity: 1, transform: "translateY(0)" },
        },
        animationDuration: "0.4s",
        animationTimingFunction: "ease-out",
    },
});

const HISTORY_PAGE_SIZE = 50;
const HISTORY_AUDIT_PAGE_SIZE = 12;
const dashboardStatsQueryKey = ["dashboardStats"] as const;
const historyEventsQueryKey = ["historyEvents"] as const;

const DASHBOARD_TAB_STORAGE_KEY = "discogenius:dashboard-tab";
let hasConsumedDashboardReloadState = false;

function getInitialDashboardTab(): "queue" | "activity" | "manualImport" {
    if (hasConsumedDashboardReloadState) {
        return "queue";
    }

    hasConsumedDashboardReloadState = true;

    const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigationEntry?.type !== "reload") {
        return "queue";
    }

    const storedTab = sessionStorage.getItem(DASHBOARD_TAB_STORAGE_KEY);
    return storedTab === "activity" || storedTab === "manualImport" || storedTab === "queue"
        ? storedTab
        : "queue";
}

const Dashboard = () => {
    const styles = useStyles();
    const responsiveTabsStyles = useResponsiveTabsStyles({ collapseOnMobile: false });
    const { toast } = useToast();
    const {
        isPaused: queueIsPaused,
        pauseQueue,
        resumeQueue,
    } = useDownloadQueue();

    const [scanningAll, setScanningAll] = useState(false);
    const [downloadingMissing, setDownloadingMissing] = useState(false);
    const [scanningRoots, setScanningRoots] = useState(false);
    const [searchingMissingAlbums, setSearchingMissingAlbums] = useState(false);
    const [historyPages, setHistoryPages] = useState<any[]>([]);
    const [historyOffset, setHistoryOffset] = useState(HISTORY_PAGE_SIZE);
    const [hasMoreHistory, setHasMoreHistory] = useState(false);
    const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
    const [mobileTab, setMobileTab] = useState<"queue" | "activity" | "manualImport">(getInitialDashboardTab);
    const [activityFilter, setActivityFilter] = useState<string>('all');

    useEffect(() => {
        sessionStorage.setItem(DASHBOARD_TAB_STORAGE_KEY, mobileTab);
    }, [mobileTab]);

    const {
        activeJobs,
        jobHistory: baseJobHistory,
        taskQueueStats,
        isLoading: isStatusInitialLoading,
    } = useStatusOverview();
    useDebouncedQueryInvalidation({
        queryKeys: [dashboardStatsQueryKey, historyEventsQueryKey],
        globalEvents: ["file.added", "file.deleted", "file.upgraded", "config.updated"],
        windowEvents: [LIBRARY_UPDATED_EVENT, ACTIVITY_REFRESH_EVENT],
        debounceMs: 500,
    });

    const statsQuery = useQuery<LibraryStats | null>({
        queryKey: dashboardStatsQueryKey,
        queryFn: async (): Promise<LibraryStats | null> => await api.getStats() as LibraryStats,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
        placeholderData: (previousData) => previousData,
    });
    const libraryStats = statsQuery.data ?? null;
    const historyEventsQuery = useQuery({
        queryKey: historyEventsQueryKey,
        queryFn: async (): Promise<{ items: HistoryEventItemContract[] }> => {
            const result = await api.getHistoryEvents({ limit: HISTORY_AUDIT_PAGE_SIZE });
            return { items: result.items };
        },
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: 1,
        placeholderData: (previousData) => previousData,
    });
    const libraryAuditEvents = historyEventsQuery.data?.items ?? [];
    const jobHistory = useMemo(() => {
        const seenIds = new Set(baseJobHistory.map((job) => job.id));
        return [...baseJobHistory, ...historyPages.filter((job) => !seenIds.has(job.id))];
    }, [baseJobHistory, historyPages]);

    useEffect(() => {
        if (historyPages.length === 0) {
            setHasMoreHistory(baseJobHistory.length >= HISTORY_PAGE_SIZE);
        }
    }, [baseJobHistory.length, historyPages.length]);

    const loadMoreHistory = useCallback(async () => {
        if (isLoadingMoreHistory || !hasMoreHistory) {
            return;
        }

        setIsLoadingMoreHistory(true);
        try {
            const result: any = await api.request(`/status/history?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`);
            const newJobs = result.jobHistory || [];
            if (newJobs.length > 0) {
                setHistoryPages(prev => {
                    const existingIds = new Set([...baseJobHistory, ...prev].map(j => j.id));
                    const uniqueNew = newJobs.filter((j: any) => !existingIds.has(j.id));
                    return [...prev, ...uniqueNew];
                });
                setHistoryOffset(prev => prev + HISTORY_PAGE_SIZE);
            }
            setHasMoreHistory(newJobs.length === HISTORY_PAGE_SIZE);
        } catch (e) {
            console.error("Failed to load more history", e);
            toast({ title: "Failed to load older activity", variant: "destructive" });
        } finally {
            setIsLoadingMoreHistory(false);
        }
    }, [baseJobHistory, hasMoreHistory, historyOffset, isLoadingMoreHistory, toast]);

    const hasActiveJobs = (types: string[]) =>
        taskQueueStats.some(s =>
            types.includes(s.type) &&
            (s.status === 'pending' || s.status === 'processing') &&
            s.count > 0
        );

    const refreshBusy = scanningAll || hasActiveJobs(['RefreshMetadata', 'RefreshArtist']);
    const curationBusy = searchingMissingAlbums || hasActiveJobs(['ApplyCuration', 'CurateArtist']);
    const scanRootsBusy = scanningRoots || hasActiveJobs(['RescanFolders']);

    const handleScanAll = async () => {
        setScanningAll(true);
        dispatchActivityRefresh();
        try {
            const result: any = await api.checkMonitoringNow();
            toast({ title: "Refresh Queued", description: result?.message || "Queued refresh for artists with monitored items..." });
            dispatchActivityRefresh();
        } catch (e: any) {
            toast({ title: "Refresh Failed", description: e.message, variant: "destructive" });
        } finally {
            setScanningAll(false);
        }
    };

    const handleDownloadMissing = async () => {
        setDownloadingMissing(true);
        try {
            const result: any = await api.downloadMissing();
            const total = (result?.albums || 0) + (result?.tracks || 0) + (result?.videos || 0);
            toast({ title: "Downloads Queued", description: result?.message || `Queued ${total} item(s) for download.` });
            dispatchActivityRefresh();
        } catch (e: any) {
            toast({ title: "Download Queue Failed", description: e.message, variant: "destructive" });
        } finally {
            setDownloadingMissing(false);
        }
    };

    const handleScanRootFolders = async () => {
        setScanningRoots(true);
        try {
            const result: any = await api.scanRootFolders();
            toast({ title: "Library Rescan Queued", description: result?.message || "Scanning library roots for new artist folders..." });
            dispatchActivityRefresh();
        } catch (e: any) {
            toast({ title: "Library Rescan Failed", description: e.message, variant: "destructive" });
        } finally {
            setScanningRoots(false);
        }
    };

    const handleQueueCuration = async () => {
        setSearchingMissingAlbums(true);
        try {
            const result: any = await api.queueCuration();
            toast({ title: "Curation Queued", description: result?.message || `Queued curation for ${result?.queued || 0} artist(s).` });
            dispatchActivityRefresh();
        } catch (e: any) {
            toast({ title: "Curation Failed", description: e.message, variant: "destructive" });
        } finally {
            setSearchingMissingAlbums(false);
        }
    };

    const handlePauseResume = async () => {
        if (queueIsPaused) {
            await resumeQueue();
        } else {
            await pauseQueue();
        }
    };

    const dashboardActions = [
        {
            key: 'refresh',
            label: refreshBusy ? 'Refreshing Metadata...' : 'Refresh Metadata',
            icon: <ArrowSync24Regular />,
            disabled: refreshBusy,
            onClick: handleScanAll,
        },
        {
            key: 'scan-files',
            label: scanRootsBusy ? 'Scanning Library Files...' : 'Scan Library Files',
            icon: <FolderSearch24Regular />,
            disabled: scanRootsBusy,
            onClick: handleScanRootFolders,
        },
        {
            key: 'curate',
            label: curationBusy ? 'Curating Library...' : 'Curate Library',
            icon: <ArrowSortDownLines24Regular />,
            disabled: curationBusy,
            onClick: handleQueueCuration,
        },
        {
            key: 'download-missing',
            label: downloadingMissing ? 'Downloading Missing...' : 'Download Missing',
            icon: <ArrowDownload24Regular />,
            disabled: downloadingMissing,
            onClick: handleDownloadMissing,
        },
    ];

    const statCards = [
        {
            key: 'artists',
            label: 'Artists',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconArtists}`}><Person24Regular className={styles.statIcon} /></span>,
            value: libraryStats?.artists?.downloaded ?? '—',
            detail: `${libraryStats?.artists?.monitored ?? 0} monitored • ${libraryStats?.artists?.total ?? 0} in database`,
        },
        {
            key: 'albums',
            label: 'Albums',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconAlbums}`}><Album24Regular className={styles.statIcon} /></span>,
            value: libraryStats?.albums?.downloaded ?? '—',
            detail: `${libraryStats?.albums?.monitored ?? 0} monitored • ${libraryStats?.albums?.total ?? 0} in database`,
        },
        {
            key: 'tracks',
            label: 'Tracks',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconTracks}`}><MusicNote224Regular className={styles.statIcon} /></span>,
            value: libraryStats?.tracks?.downloaded ?? '—',
            detail: `${libraryStats?.tracks?.monitored ?? 0} monitored • ${libraryStats?.tracks?.total ?? 0} in database`,
        },
        {
            key: 'videos',
            label: 'Videos',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconVideos}`}><Video24Regular className={styles.statIcon} /></span>,
            value: libraryStats?.videos?.downloaded ?? '—',
            detail: `${libraryStats?.videos?.monitored ?? 0} monitored • ${libraryStats?.videos?.total ?? 0} in database`,
        },
    ];

    const dashboardTabs = [
        { key: 'queue', label: 'Queue' },
        { key: 'activity', label: 'Activity' },
        { key: 'manualImport', label: 'Unmapped Files' },
    ] as const;

    return (
        <div className={styles.container}>
            {/* Header */}
            <div className={styles.header}>
                <div className={styles.desktopOnly}>
                    <Title1>Dashboard</Title1>
                </div>
                <div className={styles.mobileOnly}>
                    <div className={styles.brandHeader}>
                        <img src="/assets/images/logo.png" alt="" className={styles.brandLogo} />
                        <Title1 className={styles.brandTitle}>Discogenius</Title1>
                    </div>
                </div>
                <div className={styles.headerActionRow}>
                    {dashboardActions.map((action) => (
                        <Button key={action.key} appearance="subtle" icon={action.icon} onClick={action.onClick} disabled={action.disabled} className={styles.headerActionButton}>
                            {action.label}
                        </Button>
                    ))}
                </div>
            </div>

            {/* Library Stats */}
            <div className={styles.statsGrid}>
                {statCards.map((card) => (
                    <Card key={card.key} className={styles.statCard}>
                        <div className={styles.statHeader}>
                            {card.icon}
                            <Text className={styles.statLabel}>{card.label}</Text>
                        </div>
                        <Text className={styles.statValue}>{card.value}</Text>
                        <Text className={styles.statDetail}>{card.detail}</Text>
                    </Card>
                ))}
            </div>

            <div className={styles.mainCol}>
                {/* Tab Bar */}
                <div className={styles.viewTabs}>
                    <div className={responsiveTabsStyles.tabSlot}>
                        <div className={responsiveTabsStyles.mobileSelect}>
                            <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                    <Button appearance="subtle" iconPosition="after" icon={<ChevronDownRegular />} className={responsiveTabsStyles.menuButton}>
                                        {dashboardTabs.find((tab) => tab.key === mobileTab)?.label ?? "Queue"}
                                    </Button>
                                </MenuTrigger>
                                <MenuPopover>
                                    <MenuList>
                                        {dashboardTabs.map((tab) => (
                                            <MenuItem key={tab.key} onClick={() => setMobileTab(tab.key)}>
                                                {tab.label}
                                            </MenuItem>
                                        ))}
                                    </MenuList>
                                </MenuPopover>
                            </Menu>
                        </div>

                        <div className={responsiveTabsStyles.desktopTabs}>
                            <TabList
                                selectedValue={mobileTab}
                                onTabSelect={(_, data) => setMobileTab(data.value as "queue" | "activity" | "manualImport")}
                            >
                                {dashboardTabs.map((tab) => (
                                    <Tab key={tab.key} value={tab.key} aria-label={tab.label} title={tab.label}>
                                        {tab.label}
                                    </Tab>
                                ))}
                            </TabList>
                        </div>
                    </div>
                    {mobileTab === "queue" && (
                        <Button
                            className={styles.queueActionButton}
                            appearance={queueIsPaused ? "primary" : "outline"}
                            icon={queueIsPaused ? <Play24Regular /> : <Pause24Regular />}
                            onClick={handlePauseResume}
                            size="small"
                        >
                            {queueIsPaused ? "Resume" : "Pause"}
                        </Button>
                    )}
                    {mobileTab === "activity" && (
                        <Menu>
                            <MenuTrigger disableButtonEnhancement>
                                <Button className={styles.queueActionButton} appearance="outline" icon={<Filter24Regular />} size="small" title="Filter Activity">
                                    Filter
                                </Button>
                            </MenuTrigger>
                            <MenuPopover>
                                <MenuList>
                                    <MenuItem onClick={() => setActivityFilter('all')}>All Activity</MenuItem>
                                    <MenuItem onClick={() => setActivityFilter('downloads')}>Downloads & Upgrades</MenuItem>
                                    <MenuItem onClick={() => setActivityFilter('imports')}>Imports</MenuItem>
                                    <MenuItem onClick={() => setActivityFilter('metadata')}>Metadata & Scans</MenuItem>
                                    <MenuItem onClick={() => setActivityFilter('curation')}>Curation</MenuItem>
                                </MenuList>
                            </MenuPopover>
                        </Menu>
                    )}
                </div>

                {mobileTab === "queue" && (
                    <div className={styles.tabContentPanel}>
                        <QueueTab />
                    </div>
                )}

                {mobileTab === "activity" && (
                    <div className={styles.tabContentPanel}>
                        <ActivityTab
                            activeJobs={activeJobs}
                            jobHistory={jobHistory}
                            libraryAuditEvents={libraryAuditEvents}
                            activityFilter={activityFilter}
                            isInitialLoading={isStatusInitialLoading}
                            isLibraryAuditLoading={historyEventsQuery.isLoading}
                            hasMoreHistory={hasMoreHistory}
                            isLoadingMoreHistory={isLoadingMoreHistory}
                            onLoadMoreHistory={loadMoreHistory}
                        />
                    </div>
                )}

                {mobileTab === "manualImport" && (
                    <div className={styles.tabContentPanel}>
                        <ManualImportTab />
                    </div>
                )}
            </div>
        </div>
    );
};

export default Dashboard;
