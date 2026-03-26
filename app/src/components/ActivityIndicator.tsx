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
        status,
        taskQueueStats,
        commandStats,
        isStatusInitialLoading,
        hasStatusRefreshError,
        hasStatusData,
        isStatusUpdating,
    } = useStatusOverview();

    const downloadingCount =
        Number(commandStats.downloads?.processing || 0) ||
        taskQueueStats
            .filter((s) => ((s.type?.startsWith("Download") || s.type === "ImportDownload")) && s.status === "processing")
            .reduce((acc, curr) => acc + curr.count, 0);

    const queuedCount =
        Number(commandStats.downloads?.pending || 0) ||
        taskQueueStats
            .filter((s) => ((s.type?.startsWith("Download") || s.type === "ImportDownload")) && s.status === "pending")
            .reduce((acc, curr) => acc + curr.count, 0);

    const backgroundProcessing = Number(status?.activity?.processing || 0);
    const backgroundPending = Number(status?.activity?.pending || 0);

    if (isStatusInitialLoading && !hasStatusData) return null;

    if (hasStatusRefreshError && !hasStatusData) {
        return (
            <Tooltip content="Cannot reach server status endpoint" relationship="label">
                <div className={styles.container}>
                    <ErrorCircle24Regular className={styles.icon} style={{ color: tokens.colorPaletteRedForeground1 }} />
                    <Text>Status unavailable</Text>
                </div>
            </Tooltip>
        );
    }

    if (downloadingCount > 0 || queuedCount > 0) {
        const subtitle = `${downloadingCount} downloading, ${queuedCount} queued${(backgroundProcessing > 0 || backgroundPending > 0) ? `; ${backgroundProcessing} background running, ${backgroundPending} background queued` : ""}`;
        return (
            <Tooltip content={subtitle} relationship="label">
                <div className={mergeClasses(styles.container, styles.active)}>
                    {downloadingCount > 0 ? <Spinner size="tiny" /> : <ArrowDownload24Regular className={styles.icon} />}
                    <Text>
                        {downloadingCount > 0
                            ? `${downloadingCount} downloading${backgroundProcessing > 0 ? ` + ${backgroundProcessing} bg` : ""}`
                            : `${queuedCount} queued${backgroundPending > 0 ? ` + ${backgroundPending} bg` : ""}`}
                    </Text>
                </div>
            </Tooltip>
        );
    }

    if (backgroundProcessing > 0 || backgroundPending > 0) {
        const subtitle = `${backgroundProcessing} running, ${backgroundPending} queued background tasks`;
        return (
            <Tooltip content={subtitle} relationship="label">
                <div className={styles.container}>
                    <Spinner size="tiny" />
                    <Text>
                        {backgroundProcessing > 0
                            ? `${backgroundProcessing} background running`
                            : `${backgroundPending} background queued`}
                    </Text>
                </div>
            </Tooltip>
        );
    }

    if (isStatusUpdating) {
        return (
            <Tooltip content="Refreshing queue summary" relationship="label">
                <div className={styles.container}>
                    <Spinner size="tiny" />
                    <Text>Updating</Text>
                </div>
            </Tooltip>
        );
    }

    return null;
};
