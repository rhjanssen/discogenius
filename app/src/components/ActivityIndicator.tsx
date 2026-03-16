import { useMemo } from "react";
import {
    makeStyles,
    tokens,
    Spinner,
    Text,
    Tooltip,
    mergeClasses,
} from "@fluentui/react-components";
import {
    ArrowDownload24Regular,
    ErrorCircle24Regular,
} from "@fluentui/react-icons";
import { formatJobDescription, formatJobType } from "@/pages/dashboard/dashboardUtils";
import { useStatusOverview } from "@/hooks/useStatusOverview";

const useStyles = makeStyles({
    container: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground2,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        cursor: "default",
    },
    active: {
        color: tokens.colorBrandForeground1,
        borderTopColor: tokens.colorBrandStroke1,
        borderBottomColor: tokens.colorBrandStroke1,
        borderLeftColor: tokens.colorBrandStroke1,
        borderRightColor: tokens.colorBrandStroke1,
        backgroundColor: tokens.colorBrandBackground2,
    },
    icon: {
        fontSize: tokens.fontSizeBase300,
    },
});

export const ActivityIndicator = () => {
    const styles = useStyles();
    const {
        activeJobs: jobs,
        taskQueueStats,
        commandStats,
        isLoading,
        isError,
    } = useStatusOverview();

    const downloadingCount = useMemo(() =>
        Number(commandStats.downloads?.processing || 0) ||
        taskQueueStats
            .filter(s => ((s.type?.startsWith('Download') || s.type === 'ImportDownload')) && s.status === 'processing')
            .reduce((acc, curr) => acc + curr.count, 0)
        , [commandStats, taskQueueStats]);

    const queuedCount = useMemo(() =>
        Number(commandStats.downloads?.pending || 0) ||
        taskQueueStats
            .filter(s => ((s.type?.startsWith('Download') || s.type === 'ImportDownload')) && s.status === 'pending')
            .reduce((acc, curr) => acc + curr.count, 0)
        , [commandStats, taskQueueStats]);

    const activityJobTypes = ['CurateArtist', 'RescanFolders', 'Housekeeping', 'ApplyCuration', 'DownloadMissing', 'CheckUpgrades', 'RefreshMetadata', 'ApplyRenames', 'ApplyRetags'];
    const activeScan = jobs.find(j =>
        j.status === 'running' && (
            j.type === 'RefreshArtist' ||
            j.type.startsWith('Scan') ||
            activityJobTypes.includes(j.type)
        )
    ) || jobs.find(j =>
        j.type === 'RefreshArtist' ||
        j.type.startsWith('Scan') ||
        activityJobTypes.includes(j.type)
    );

    if (isLoading && jobs.length === 0) return null;

    if (isError && jobs.length === 0) {
        return (
            <Tooltip content="Cannot reach server status endpoint" relationship="label">
                <div className={styles.container}>
                    <ErrorCircle24Regular className={styles.icon} style={{ color: tokens.colorPaletteRedForeground1 }} />
                    <Text>Status unavailable</Text>
                </div>
            </Tooltip>
        );
    }

    if (activeScan) {
        const label = formatJobType(activeScan);
        const subtitle = formatJobDescription(activeScan);
        return (
            <Tooltip content={subtitle || activeScan.description} relationship="label">
                <div className={mergeClasses(styles.container, styles.active)}>
                    <Spinner size="tiny" />
                    <Text>{label}</Text>
                </div>
            </Tooltip>
        );
    }

    if (downloadingCount > 0 || queuedCount > 0) {
        return (
            <Tooltip content={`${downloadingCount} downloading, ${queuedCount} queued`} relationship="label">
                <div className={styles.container}>
                    {downloadingCount > 0 ? <Spinner size="tiny" /> : <ArrowDownload24Regular className={styles.icon} />}
                    <Text>
                        {downloadingCount > 0 ? `${downloadingCount} downloading` : `${queuedCount} queued`}
                    </Text>
                </div>
            </Tooltip>
        );
    }

    return null;
};
