import { useEffect, useState } from "react";
import {
    Button,
    Card,
    Menu,
    MenuItem,
    MenuList,
    MenuPopover,
    MenuTrigger,
    Overflow,
    OverflowItem,
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
    MoreHorizontal24Regular,
    Play24Regular,
    Pause24Regular,
    MusicNote224Regular,
    Person24Regular,
    Album24Regular,
    Video24Regular,
    FolderSearch24Regular,
    Filter24Regular,
    ArrowSortDownLines24Regular,
    ArrowDownload24Regular,
} from "@fluentui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { LibraryStats } from "@/hooks/useLibrary";
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
import { formatCompactNumber } from "@/utils/format";
import { useSystemTasks } from "@/hooks/useSystemTasks";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";
import { compactDetailActionButtonStyles, detailActionButtonRadiusStyles } from "@/components/media/detailActionStyles";

const useStyles = makeStyles({
    container: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        paddingTop: tokens.spacingVerticalM,
        paddingBottom: tokens.spacingVerticalL,
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
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        "@media (max-width: 639px)": {
            flexDirection: "column",
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
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
        backdropFilter: "blur(20px)",
    },
    statValue: {
        fontSize: tokens.fontSizeBase600,
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
        ...compactDetailActionButtonStyles,
        ...detailActionButtonRadiusStyles,
        minWidth: "76px",
        "@media (min-width: 768px)": {
            ...compactDetailActionButtonStyles["@media (min-width: 768px)"],
            minWidth: "auto",
        },
    },
    headerActionRow: {
        display: "flex",
        alignItems: "stretch",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "nowrap",
        justifyContent: "center",
        width: "100%",
        "@media (min-width: 768px)": {
            justifyContent: "flex-start",
            gap: tokens.spacingHorizontalM,
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
        marginBottom: tokens.spacingVerticalXS,
        gap: tokens.spacingHorizontalM,
        "@media (max-width: 639px)": {
            gap: tokens.spacingHorizontalS,
        },
    },
    mainCol: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    queueActionButton: {
        flexShrink: 0,
        whiteSpace: "nowrap",
    },
    tabContentPanel: {
        animationName: {
            from: { opacity: 0, transform: `translateY(${tokens.spacingVerticalS})` },
            to: { opacity: 1, transform: "translateY(0)" },
        },
        animationDuration: "0.4s",
        animationTimingFunction: "ease-out",
    },
});

const dashboardStatsQueryKey = ["dashboardStats"] as const;

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
    const [scanningRoots, setScanningRoots] = useState(false);
    const [searchingMissingAlbums, setSearchingMissingAlbums] = useState(false);
    const { runnableTasks, isRunningTaskId, runTask } = useSystemTasks();
    const [mobileTab, setMobileTab] = useState<"queue" | "activity" | "manualImport">(getInitialDashboardTab);
    const [activityFilter, setActivityFilter] = useState<string>('all');

    useEffect(() => {
        sessionStorage.setItem(DASHBOARD_TAB_STORAGE_KEY, mobileTab);
    }, [mobileTab]);

    const {
        taskQueueStats,
        hasStatusRefreshError,
        hasStatusData,
    } = useStatusOverview();
    useDebouncedQueryInvalidation({
        queryKeys: [dashboardStatsQueryKey],
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
    const hasActiveJobs = (types: string[]) =>
        taskQueueStats.some(s =>
            types.includes(s.type) &&
            (s.status === 'pending' || s.status === 'processing') &&
            s.count > 0
        );

    const statusSyncLabel = hasStatusRefreshError
        ? (hasStatusData ? "Showing cached status" : "Status unavailable")
        : null;

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

    const actions: OverflowAction[] = [
        {
            key: 'refresh',
            label: refreshBusy ? 'Refreshing Metadata...' : 'Refresh Metadata',
            icon: <ArrowSync24Regular />,
            disabled: refreshBusy,
            onClick: handleScanAll,
            priority: 1,
        },
        {
            key: 'scan-files',
            label: scanRootsBusy ? 'Scanning Library Files...' : 'Scan Library Files',
            icon: <FolderSearch24Regular />,
            disabled: scanRootsBusy,
            onClick: handleScanRootFolders,
            priority: 2,
        },
        {
            key: 'curate',
            label: curationBusy ? 'Curating Library...' : 'Curate Library',
            icon: <ArrowSortDownLines24Regular />,
            disabled: curationBusy,
            onClick: handleQueueCuration,
            priority: 3,
        },
        {
            key: 'download-missing',
            label: (() => {
                const task = runnableTasks.find((t) => t.id === 'download-missing');
                return (isRunningTaskId === 'download-missing') ? 'Downloading Missing...' : (task?.name ?? 'Download Missing');
            })(),
            icon: <ArrowDownload24Regular />,
            disabled: isRunningTaskId === 'download-missing' || (runnableTasks.find((t) => t.id === 'download-missing')?.active ?? false),
            onClick: () => void runTask('download-missing'),
            priority: 4,
        },
        ...["check-upgrades", "health-check", "housekeeping", "cleanup-temp-files"]
            .map((taskId, index) => {
                const task = runnableTasks.find((t) => t.id === taskId);
                if (!task) return null;
                const isRunning = isRunningTaskId === taskId;
                return {
                    key: taskId,
                    label: task.name,
                    disabled: isRunning || task.active,
                    onClick: () => void runTask(taskId),
                    priority: 5 + index,
                };
            })
            .filter((a): a is NonNullable<typeof a> => a !== null),
    ];

    const statCards = [
        {
            key: 'artists',
            label: 'Artists',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconArtists}`}><Person24Regular className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.artists?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.artists?.monitored)} monitored • ${formatCompactNumber(libraryStats?.artists?.total)} in database`,
        },
        {
            key: 'albums',
            label: 'Albums',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconAlbums}`}><Album24Regular className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.albums?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.albums?.monitored)} monitored • ${formatCompactNumber(libraryStats?.albums?.total)} in database`,
        },
        {
            key: 'tracks',
            label: 'Tracks',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconTracks}`}><MusicNote224Regular className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.tracks?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.tracks?.monitored)} monitored • ${formatCompactNumber(libraryStats?.tracks?.total)} in database`,
        },
        {
            key: 'videos',
            label: 'Videos',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconVideos}`}><Video24Regular className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.videos?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.videos?.monitored)} monitored • ${formatCompactNumber(libraryStats?.videos?.total)} in database`,
        },
    ];

    const dashboardTabs = [
        { key: 'queue', label: 'Queue' },
        { key: 'activity', label: 'Activity' },
        { key: 'manualImport', label: 'Unmapped Files' },
    ] as const;
    const hasMobileOverflowActions = actions.length > 4;
    const mobileVisibleActions = actions.slice(0, hasMobileOverflowActions ? 3 : 4);
    const mobileOverflowActions = hasMobileOverflowActions ? actions.slice(3) : [];

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
                <div className={styles.desktopOnly}>
                    <Overflow minimumVisible={2}>
                        <div className={styles.headerActionRow}>
                            {actions.map((action) => (
                                <OverflowItem key={action.key} id={action.key} priority={actions.length - (action.priority ?? 0)}>
                                    <Button appearance="subtle" icon={action.icon} onClick={action.onClick} disabled={action.disabled} className={styles.headerActionButton}>
                                        {action.label}
                                    </Button>
                                </OverflowItem>
                            ))}
                            <ActionOverflowMenu actions={actions} />
                        </div>
                    </Overflow>
                </div>
                <div className={styles.mobileOnly}>
                    <div className={styles.headerActionRow}>
                        {mobileVisibleActions.map((action) => (
                            <Button
                                key={action.key}
                                appearance="subtle"
                                icon={action.icon}
                                onClick={action.onClick}
                                disabled={action.disabled}
                                className={styles.headerActionButton}
                            >
                                {action.label}
                            </Button>
                        ))}
                        {mobileOverflowActions.length > 0 ? (
                            <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                    <Button appearance="subtle" icon={<MoreHorizontal24Regular />} className={styles.headerActionButton}>
                                        More
                                    </Button>
                                </MenuTrigger>
                                <MenuPopover>
                                    <MenuList>
                                        {mobileOverflowActions.map((action) => (
                                            <MenuItem key={action.key} disabled={action.disabled} onClick={action.onClick}>
                                                {action.label}
                                            </MenuItem>
                                        ))}
                                    </MenuList>
                                </MenuPopover>
                            </Menu>
                        ) : null}
                    </div>
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
                    {statusSyncLabel ? (
                        <Text className={styles.statDetail}>{statusSyncLabel}</Text>
                    ) : null}
                </div>

                {mobileTab === "queue" && (
                    <div className={styles.tabContentPanel}>
                        <QueueTab />
                    </div>
                )}

                {mobileTab === "activity" && (
                    <div className={styles.tabContentPanel}>
                        <ActivityTab
                            activityFilter={activityFilter}
                            isActive={mobileTab === "activity"}
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











