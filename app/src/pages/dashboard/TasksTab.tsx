import { useMemo } from "react";
import {
    Button,
    Spinner,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    Clock24Regular,
    Play24Regular,
} from "@fluentui/react-icons";
import { DataGrid, type DataGridColumn } from "@/components/DataGrid";
import { EmptyState } from "@/components/ui/ContentState";
import { useSystemTasks } from "@/hooks/useSystemTasks";
import { useTasksFeed } from "@/hooks/useTasksFeed";
import type { ActivityJobContract } from "@contracts/status";
import type { SystemTaskContract } from "@contracts/system-task";
import { formatJobType, formatRelativeTime } from "./dashboardUtils";
import CachedRefreshNotice from "./CachedRefreshNotice";

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
    loadMoreRow: {
        display: "flex",
        justifyContent: "center",
        paddingTop: tokens.spacingVerticalXXS,
    },
});

type ScheduledRow = {
    id: string;
    task: SystemTaskContract;
    intervalLabel: string;
}

function formatInterval(minutes: number | null): string {
    if (!minutes || minutes <= 0) {
        return "Manual";
    }

    if (minutes % (60 * 24) === 0) {
        const days = minutes / (60 * 24);
        return `${days}d`;
    }

    if (minutes % 60 === 0) {
        return `${minutes / 60}h`;
    }

    return `${minutes}m`;
}

function formatResult(status?: string): string {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "completed") return "Completed";
    if (normalized === "failed") return "Failed";
    if (normalized === "cancelled") return "Cancelled";
    if (normalized === "processing" || normalized === "running") return "Running";
    return "Queued";
}

function createScheduledColumns(
    runTask: (taskId: string) => Promise<unknown>,
    runningTaskId: string | null,
): DataGridColumn<ScheduledRow>[] {
    return [
        {
            key: "name",
            header: "Name",
            width: "minmax(220px, 1.8fr)",
            render: (row) => <Text weight="semibold">{row.task.name}</Text>,
        },
        {
            key: "interval",
            header: "Interval",
            width: "minmax(92px, 0.7fr)",
            render: (row) => <Text>{row.intervalLabel}</Text>,
        },
        {
            key: "lastExecution",
            header: "Last Execution",
            width: "minmax(110px, 0.9fr)",
            minWidth: 768,
            align: "right",
            render: (row) => <Text>{formatRelativeTime(row.task.lastExecution)}</Text>,
        },
        {
            key: "nextExecution",
            header: "Next Execution",
            width: "minmax(110px, 0.9fr)",
            minWidth: 768,
            align: "right",
            render: (row) => <Text>{formatRelativeTime(row.task.nextExecution)}</Text>,
        },
        {
            key: "action",
            header: "Action",
            width: "minmax(86px, 0.6fr)",
            align: "right",
            render: (row) => {
                const isRunning = runningTaskId === row.id;
                return (
                    <Button
                        appearance="primary"
                        icon={isRunning ? <Spinner size="tiny" /> : <Play24Regular />}
                        disabled={isRunning || row.task.active || !row.task.canRunNow}
                        onClick={() => {
                            void runTask(row.id);
                        }}
                    >
                        Run
                    </Button>
                );
            },
        },
    ];
}

function createQueueColumns(): DataGridColumn<ActivityJobContract>[] {
    return [
        {
            key: "name",
            header: "Name",
            width: "minmax(220px, 1.8fr)",
            render: (item) => <Text weight="semibold">{formatJobType(item)}</Text>,
        },
        {
            key: "queued",
            header: "Queued",
            width: "minmax(100px, 0.8fr)",
            render: (item) => <Text>{formatRelativeTime(item.startTime)}</Text>,
        },
        {
            key: "started",
            header: "Started",
            width: "minmax(100px, 0.8fr)",
            minWidth: 768,
            align: "right",
            render: (item) => (
                <Text>{item.status === "processing" || item.status === "running" ? formatRelativeTime(item.startTime) : "—"}</Text>
            ),
        },
        {
            key: "status",
            header: "Status",
            width: "minmax(96px, 0.7fr)",
            align: "right",
            render: (item) => <Text>{formatResult(item.status)}</Text>,
        },
    ];
}

type TasksTabProps = {
    isActive: boolean;
};

const TasksTab = ({ isActive }: TasksTabProps) => {
    const styles = useStyles();
    const {
        scheduledTasks,
        manualTasks,
        isLoading: isLoadingTaskCatalog,
        errorMessage,
        isRunningTaskId,
        runTask,
    } = useSystemTasks();
    const {
        taskItems,
        hasMoreTasks,
        isLoadingMoreTasks,
        loadMoreTasks,
        isTaskInitialLoading,
        hasTaskRefreshError,
        hasTaskData,
        taskRefreshErrorMessage,
    } = useTasksFeed({ enabled: isActive });

    const scheduledRows = useMemo<ScheduledRow[]>(() => {
        const scheduled = scheduledTasks.map((task) => ({
            id: task.id,
            task,
            intervalLabel: formatInterval(task.intervalMinutes),
        }));

        const manual = manualTasks.map((task) => ({
            id: task.id,
            task: {
                ...task,
                name: `${task.name} (Manual)`,
            },
            intervalLabel: "Manual",
        }));

        return [...scheduled, ...manual];
    }, [manualTasks, scheduledTasks]);

    const scheduledColumns = useMemo(
        () => createScheduledColumns(runTask, isRunningTaskId),
        [isRunningTaskId, runTask],
    );

    const queueColumns = useMemo(() => createQueueColumns(), []);

    const showCachedNotice = hasTaskRefreshError && hasTaskData;
    const queueUnavailable = hasTaskRefreshError && !hasTaskData;

    return (
        <div className={styles.root}>
            <CachedRefreshNotice
                visible={showCachedNotice}
                cachedLabel="tasks"
                errorMessage={taskRefreshErrorMessage || undefined}
            />

            <section className={styles.section} aria-label="Scheduled tasks">
                <div className={styles.sectionHeader}>
                    <Text weight="semibold">Scheduled</Text>
                    <Text size={200} className={styles.sectionCount}>{scheduledRows.length}</Text>
                </div>
                <DataGrid
                    compact
                    loading={isLoadingTaskCatalog}
                    items={scheduledRows}
                    getRowKey={(item) => item.id}
                    columns={scheduledColumns}
                    emptyContent={
                        <EmptyState
                            title="No scheduled tasks"
                            description={errorMessage || "Scheduled and manual tasks will appear here."}
                            icon={<Clock24Regular />}
                        />
                    }
                />
            </section>

            <section className={styles.section} aria-label="Queue">
                <div className={styles.sectionHeader}>
                    <Text weight="semibold">Queue</Text>
                    <Text size={200} className={styles.sectionCount}>{taskItems.length}</Text>
                </div>
                <DataGrid
                    compact
                    loading={isTaskInitialLoading}
                    items={taskItems}
                    getRowKey={(item) => String(item.id)}
                    columns={queueColumns}
                    emptyContent={
                        <EmptyState
                            title={queueUnavailable ? "Tasks unavailable" : "Queue is empty"}
                            description={queueUnavailable ? (taskRefreshErrorMessage || "Unable to load queued tasks right now.") : "Pending and running commands appear here."}
                            icon={<Clock24Regular />}
                        />
                    }
                />
                {hasMoreTasks && (
                    <div className={styles.loadMoreRow}>
                        <Button appearance="subtle" onClick={() => void loadMoreTasks()} disabled={isLoadingMoreTasks} icon={isLoadingMoreTasks ? <Spinner size="tiny" /> : undefined}>
                            {isLoadingMoreTasks ? "Loading..." : "Load More"}
                        </Button>
                    </div>
                )}
            </section>
        </div>
    );
};

export default TasksTab;



