import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    Button,
    Badge,
    Card,
    Menu,
    MenuItem,
    MenuList,
    MenuPopover,
    MenuTrigger,
    Text,
    Title1,
    tokens,
    makeStyles,
} from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  MoreHorizontal24Regular,
  Play24Regular,
  Pause24Regular,
  FolderSearch24Regular,
  Filter24Regular,
  ArrowSortDownLines24Regular,
  ArrowDownload24Regular,
  Warning24Regular,
  ArrowSync24Filled,
  MoreHorizontal24Filled,
  Play24Filled,
  Pause24Filled,
  MusicNote224Filled,
  Person24Filled,
  Album24Filled,
  Video24Filled,
  FolderSearch24Filled,
  Filter24Filled,
  ArrowSortDownLines24Filled,
  ArrowDownload24Filled,
  Warning24Filled,
  Pulse24Regular,
  Pulse24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { LibraryStats } from "@/hooks/useLibrary";
import { LIBRARY_STATS_QUERY_KEY } from "@/hooks/useLibrary";
import { useToast } from "@/hooks/useToast";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";
import {
    ACTIVITY_REFRESH_EVENT,
    LIBRARY_UPDATED_EVENT,
    dispatchActivityRefresh,
} from "@/utils/appEvents";
import { ResponsiveStockTabList } from "@/components/ui/StockTabList";
import QueueTab from "./QueueTab";
import ActivityTab from "./ActivityTab";
import ManualImportTab from "./ManualImportTab";
import { useStatusOverview } from "@/hooks/useStatusOverview";
import { formatCompactNumber } from "@/utils/format";
import { useSystemTasks } from "@/hooks/useSystemTasks";
import { useProviderConnection } from "@/hooks/useProviderConnection";
import type { OverflowAction } from "@/components/overflow/ActionOverflowMenu";
import {
    compactDetailActionButtonStyles,
    detailActionGlassButtonStyles,
    detailActionMobileOverflowRowStyles,
    detailActionPrimaryButtonStyles,
} from "@/components/media/detailActionStyles";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
import { compactPageTopOffset } from "@/components/ui/sharedLayoutStyles";

const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);
const MoreHorizontal24 = bundleIcon(MoreHorizontal24Filled, MoreHorizontal24Regular);
const Play24 = bundleIcon(Play24Filled, Play24Regular);
const Pause24 = bundleIcon(Pause24Filled, Pause24Regular);
const FolderSearch24 = bundleIcon(FolderSearch24Filled, FolderSearch24Regular);
const Filter24 = bundleIcon(Filter24Filled, Filter24Regular);
const ArrowSortDownLines24 = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24Regular);
const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Warning24 = bundleIcon(Warning24Filled, Warning24Regular);
const Pulse24 = bundleIcon(Pulse24Filled, Pulse24Regular);

const useStyles = makeStyles({
    container: {
        ...compactPageTopOffset,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        paddingTop: tokens.spacingVerticalNone,
        paddingBottom: tokens.spacingVerticalL,
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        boxSizing: "border-box",
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
        width: "100%",
        "@media (min-width: 640px)": {
            display: "none",
        },
    },
    header: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: tokens.spacingHorizontalL,
        minWidth: 0,
        flexWrap: "wrap",
        "@media (max-width: 639px)": {
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            gap: tokens.spacingVerticalS,
        },
    },
    headerTitleWrap: {
        flex: "0 1 auto",
        minWidth: 0,
        paddingRight: tokens.spacingHorizontalS,
    },
    headerTitle: {
        margin: 0,
        width: "auto",
    },
    desktopActions: {
        display: "none",
        minWidth: 0,
        maxWidth: "100%",
        "@media (min-width: 640px)": {
            display: "flex",
            flex: "1 1 12rem",
            justifyContent: "flex-end",
            overflow: "visible",
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
        ...glassSurfaceStyles,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    },
    statValue: {
        fontSize: tokens.fontSizeBase600,
        fontWeight: tokens.fontWeightBold,
        lineHeight: "1",
        color: tokens.colorNeutralForeground1,
    },
    statLabel: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
    },
    statDetail: {
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorNeutralForeground3,
    },
    providerNotice: {
        ...glassSurfaceStyles,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        "@media (max-width: 639px)": {
            alignItems: "stretch",
            flexDirection: "column",
        },
    },
    providerNoticeMain: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        minWidth: 0,
    },
    providerNoticeIcon: {
        width: "18px",
        height: "18px",
        color: tokens.colorPaletteMarigoldForeground2,
        flexShrink: 0,
    },
    providerNoticeText: {
        color: tokens.colorNeutralForeground2,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        "@media (max-width: 639px)": {
            whiteSpace: "normal",
        },
    },
    providerNoticeAction: {
        flexShrink: 0,
        "@media (max-width: 639px)": {
            alignSelf: "flex-start",
        },
    },
    headerActionButton: {
        ...compactDetailActionButtonStyles,
        ...detailActionGlassButtonStyles,
        minWidth: 0,
        "@media (min-width: 768px)": {
            ...compactDetailActionButtonStyles["@media (min-width: 768px)"],
            minWidth: "auto",
        },
    },
    headerActionRow: {
        display: "flex",
        alignItems: "stretch",
        flexWrap: "nowrap",
        justifyContent: "center",
        width: "auto",
        maxWidth: "100%",
        ...detailActionMobileOverflowRowStyles,
        "@media (min-width: 640px)": {
            width: "100%",
        },
        "@media (min-width: 768px)": {
            justifyContent: "flex-end",
            gap: tokens.spacingHorizontalM,
            overflow: "visible",
            paddingTop: tokens.spacingVerticalNone,
            paddingBottom: tokens.spacingVerticalNone,
        },
        "@media (max-width: 639px)": {
            justifyContent: "center",
        },
    },
    viewTabs: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "nowrap",
        minWidth: 0,
        gap: tokens.spacingHorizontalS,
        "@media (min-width: 640px)": {
            gap: tokens.spacingHorizontalM,
        },
    },
    viewTabSlot: {
        flex: "1 1 auto",
        minWidth: 0,
        overflow: "visible",
        "@media (min-width: 640px)": {
            // These three fixed labels fit at the desktop breakpoint. Keeping
            // the slot content-sized avoids a scrollport clipping Fluent's
            // external focus ring and shadow.
            flex: "0 1 auto",
        },
    },
    dashboardTabLabel: {
        display: "inline-flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        minWidth: 0,
    },
    mainCol: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    queueActionButton: {
        ...detailActionGlassButtonStyles,
        flexShrink: 0,
        whiteSpace: "nowrap",
        "@media (max-width: 639px)": {
            minWidth: "32px",
            "& .fui-Button__content": {
                display: "none",
            },
        },
    },
    queuePrimaryActionButton: {
        ...detailActionPrimaryButtonStyles,
        flexShrink: 0,
        whiteSpace: "nowrap",
        "@media (max-width: 639px)": {
            minWidth: "32px",
            "& .fui-Button__content": {
                display: "none",
            },
        },
    },
    tabContentPanel: {
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        animationName: {
            from: { opacity: 0, transform: `translateY(${tokens.spacingVerticalS})` },
            to: { opacity: 1, transform: "translateY(0)" },
        },
        animationDuration: "0.4s",
        animationTimingFunction: "ease-out",
    },
});

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
    const { toast } = useToast();
    const navigate = useNavigate();
    const { setArtwork } = useUltraBlurContext();
    const { setBrandKeyColor } = useTheme();
    const {
        isPaused: queueIsPaused,
        pauseQueue,
        resumeQueue,
    } = useQueueStatus();

    const [scanningAll, setScanningAll] = useState(false);
    const [scanningRoots, setScanningRoots] = useState(false);
    const [searchingMissingAlbums, setSearchingMissingAlbums] = useState(false);
    const { runnableTasks, isRunningTaskId, runTask } = useSystemTasks();
    const [mobileTab, setMobileTab] = useState<"queue" | "activity" | "manualImport">(getInitialDashboardTab);
    const [activityFilter, setActivityFilter] = useState<string>('all');
    const { canAccessShell, remoteCatalogAvailable, isSessionExpired } = useProviderConnection();

    // Match Library: default chromatic wash, not the previous artist/album UltraBlur.
    useEffect(() => {
        setArtwork(undefined);
        setBrandKeyColor(null);
    }, [setArtwork, setBrandKeyColor]);

    useEffect(() => {
        sessionStorage.setItem(DASHBOARD_TAB_STORAGE_KEY, mobileTab);
    }, [mobileTab]);

    const {
        taskQueueStats,
        hasStatusRefreshError,
        hasStatusData,
    } = useStatusOverview();
    useDebouncedQueryInvalidation({
        queryKeys: [LIBRARY_STATS_QUERY_KEY],
        globalEvents: ["file.added", "file.deleted", "file.upgraded", "config.updated", "library.updated"],
        windowEvents: [LIBRARY_UPDATED_EVENT, ACTIVITY_REFRESH_EVENT],
        debounceMs: 500,
    });

    const statsQuery = useQuery<LibraryStats | null>({
        // Shared key with the Library page: one cached /api/v1/stats fetch serves both.
        queryKey: LIBRARY_STATS_QUERY_KEY,
        queryFn: ({ signal }): Promise<LibraryStats | null> => api.getStats({ signal, timeoutMs: 8_000 }) as Promise<LibraryStats | null>,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
        placeholderData: (previousData) => previousData,
    });
    const libraryStats = statsQuery.data ?? null;
    const hasActiveJobs = (types: string[]) =>
        taskQueueStats.some(s =>
            types.includes(s.type) &&
            (s.status === 'queued' || s.status === 'started') &&
            s.count > 0
        );

    const statusSyncLabel = hasStatusRefreshError
        ? (hasStatusData ? "Showing cached status" : "Status unavailable")
        : null;
    const showProviderNotice = canAccessShell && !remoteCatalogAvailable;
    const providerNoticeText = isSessionExpired
        ? "Provider session expired. MusicBrainz library management still works."
        : "No provider connected. Provider availability, previews, lyrics, and downloads are paused.";

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
            icon: <ArrowSync24 />,
            disabled: refreshBusy,
            onClick: handleScanAll,
            priority: 1,
        },
        {
            key: 'scan-files',
            label: scanRootsBusy ? 'Scanning Library Files...' : 'Scan Library Files',
            icon: <FolderSearch24 />,
            disabled: scanRootsBusy,
            onClick: handleScanRootFolders,
            priority: 2,
        },
        {
            key: 'curate',
            label: curationBusy ? 'Curating Library...' : 'Curate Library',
            icon: <ArrowSortDownLines24 />,
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
            icon: <ArrowDownload24 />,
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
            icon: <span className={`${styles.statIconSlot} ${styles.statIconArtists}`}><Person24Filled className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.artists?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.artists?.monitored)} monitored • ${formatCompactNumber(libraryStats?.artists?.total)} catalog`,
        },
        {
            key: 'albums',
            label: 'Albums',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconAlbums}`}><Album24Filled className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.albums?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.albums?.monitored)} monitored • ${formatCompactNumber(libraryStats?.albums?.total)} catalog`,
        },
        {
            key: 'tracks',
            label: 'Tracks',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconTracks}`}><MusicNote224Filled className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.tracks?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.tracks?.monitored)} monitored • ${formatCompactNumber(libraryStats?.tracks?.total)} catalog`,
        },
        {
            key: 'videos',
            label: 'Videos',
            icon: <span className={`${styles.statIconSlot} ${styles.statIconVideos}`}><Video24Filled className={styles.statIcon} /></span>,
            value: formatCompactNumber(libraryStats?.videos?.downloaded),
            detail: `${formatCompactNumber(libraryStats?.videos?.monitored)} monitored • ${formatCompactNumber(libraryStats?.videos?.total)} catalog`,
        },
    ];

    const dashboardTabs = [
        { key: 'queue', label: 'Queue', icon: <ArrowDownload24 /> },
        { key: 'activity', label: 'Activity', icon: <Pulse24 /> },
        { key: 'manualImport', label: 'Unmapped', icon: <FolderSearch24 /> },
    ] as const;
    // Three actions plus More: four equal slots, labels wrap inside them.
    const hasMobileOverflowActions = actions.length > 3;
    const mobileVisibleActions = actions.slice(0, 3);
    const mobileOverflowActions = hasMobileOverflowActions ? actions.slice(3) : [];
    const desktopVisibleActions = actions.slice(0, 4);
    const desktopOverflowActions = actions.slice(4);
    const compactActionLabel = (action: OverflowAction) => {
        if (action.key === 'refresh') return refreshBusy ? 'Refreshing...' : 'Refresh';
        if (action.key === 'scan-files') return scanRootsBusy ? 'Scanning...' : 'Scan';
        if (action.key === 'curate') return curationBusy ? 'Curating...' : 'Curate';
        if (action.key === 'download-missing') {
            return (isRunningTaskId === 'download-missing') ? 'Downloading...' : 'Download';
        }
        return action.label;
    };

    return (
        <div className={styles.container}>
            {/* Header */}
            <div className={styles.header}>
                <div className={styles.headerTitleWrap}>
                    <Title1 as="h1" className={styles.headerTitle}>Dashboard</Title1>
                </div>
                <div className={styles.desktopActions}>
                    <div className={styles.headerActionRow}>
                        {desktopVisibleActions.map((action) => (
                            <Button
                                key={action.key}
                                appearance="subtle"
                                icon={action.icon}
                                onClick={action.onClick}
                                disabled={action.disabled}
                                className={styles.headerActionButton}
                                title={action.label}
                                aria-label={action.label}
                            >
                                {compactActionLabel(action)}
                            </Button>
                        ))}
                        {desktopOverflowActions.length > 0 ? (
                            <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                    <Button appearance="subtle" icon={<MoreHorizontal24 />} className={styles.headerActionButton}>
                                        More
                                    </Button>
                                </MenuTrigger>
                                <MenuPopover>
                                    <MenuList>
                                        {desktopOverflowActions.map((action) => (
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
                                aria-label={action.label}
                            >
                                {compactActionLabel(action)}
                            </Button>
                        ))}
                        {mobileOverflowActions.length > 0 ? (
                            <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                    <Button appearance="subtle" icon={<MoreHorizontal24 />} className={styles.headerActionButton}>
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

            {showProviderNotice ? (
                <div className={styles.providerNotice}>
                    <div className={styles.providerNoticeMain}>
                        <Warning24 className={styles.providerNoticeIcon} />
                        <Text className={styles.providerNoticeText}>{providerNoticeText}</Text>
                        <Badge appearance="tint" color="warning">Provider</Badge>
                    </div>
                    <Button
                        appearance="subtle"
                        size="small"
                        className={styles.providerNoticeAction}
                        onClick={() => navigate("/settings")}
                    >
                        Settings
                    </Button>
                </div>
            ) : null}

            <div className={styles.mainCol}>
                {/* Tab Bar */}
                <div className={styles.viewTabs}>
                    <div className={styles.viewTabSlot}>
                        <ResponsiveStockTabList
                            idBase="dashboard"
                            ariaLabel="Dashboard view"
                            items={dashboardTabs}
                            selectedValue={mobileTab}
                            onSelect={(value) => setMobileTab(value as "queue" | "activity" | "manualImport")}
                        />
                    </div>
                    {mobileTab === "queue" && (
                        <Button
                            className={queueIsPaused ? styles.queuePrimaryActionButton : styles.queueActionButton}
                            appearance={queueIsPaused ? "primary" : "outline"}
                            icon={queueIsPaused ? <Play24 /> : <Pause24 />}
                            onClick={handlePauseResume}
                            size="small"
                            aria-label={queueIsPaused ? "Resume queue" : "Pause queue"}
                            title={queueIsPaused ? "Resume" : "Pause"}
                        >
                            {queueIsPaused ? "Resume" : "Pause"}
                        </Button>
                    )}
                    {mobileTab === "activity" && (
                        <Menu>
                            <MenuTrigger disableButtonEnhancement>
                                <Button className={styles.queueActionButton} appearance="outline" icon={<Filter24 />} size="small" title="Filter Activity">
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
                    <div
                        id="dashboard-panel-queue"
                        role="tabpanel"
                        aria-labelledby="dashboard-tab-queue"
                        className={styles.tabContentPanel}
                    >
                        <QueueTab />
                    </div>
                )}

                {mobileTab === "activity" && (
                    <div
                        id="dashboard-panel-activity"
                        role="tabpanel"
                        aria-labelledby="dashboard-tab-activity"
                        className={styles.tabContentPanel}
                    >
                        <ActivityTab
                            activityFilter={activityFilter}
                            isActive={mobileTab === "activity"}
                        />
                    </div>
                )}

                {mobileTab === "manualImport" && (
                    <div
                        id="dashboard-panel-manualImport"
                        role="tabpanel"
                        aria-labelledby="dashboard-tab-manualImport"
                        className={styles.tabContentPanel}
                    >
                        <ManualImportTab />
                    </div>
                )}
            </div>
        </div>
    );
};

export default Dashboard;


