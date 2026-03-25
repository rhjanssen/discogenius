import React, { useEffect, useState } from "react";
import {
    Badge,
    Button,
    Input,
    Spinner,
    Switch,
    Text,
    Caption1,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { ArrowSync24Regular } from "@fluentui/react-icons";
import type { SystemTaskContract } from "@contracts/system-task";

interface SystemTasksSectionProps {
    tasks: SystemTaskContract[];
    loading: boolean;
    error: string | null;
    updatingTaskId: string | null;
    runningTaskId: string | null;
    onRetry: () => void;
    onToggleEnabled: (task: SystemTaskContract, enabled: boolean) => Promise<void>;
    onUpdateInterval: (task: SystemTaskContract, intervalMinutes: number) => Promise<void>;
    onRunNow: (task: SystemTaskContract) => Promise<void>;
}

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
    },
    loadingState: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: tokens.spacingHorizontalS,
        minHeight: "128px",
        padding: tokens.spacingVerticalXL,
    },
    group: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    groupHeader: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
    },
    groupHeading: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    groupTitle: {
        margin: 0,
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    list: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    card: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalM,
        borderRadius: tokens.borderRadiusLarge,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 68%, transparent)`,
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
    },
    header: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
    },
    titleBlock: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
        flex: 1,
    },
    badges: {
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
    },
    metaGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: tokens.spacingHorizontalM,
        ["@media (max-width: 768px)"]: {
            gridTemplateColumns: "1fr",
        },
    },
    metaItem: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    metaLabel: {
        color: tokens.colorNeutralForeground2,
    },
    intervalField: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
    },
    intervalInput: {
        width: "110px",
    },
    footer: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
        paddingTop: tokens.spacingVerticalXS,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    footerLeft: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
    },
    footerRight: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
    },
    toggleLabel: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    emptyState: {
        padding: tokens.spacingVerticalXL,
        borderRadius: tokens.borderRadiusLarge,
        border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
        textAlign: "center",
    },
    errorState: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
        padding: tokens.spacingVerticalM,
        borderRadius: tokens.borderRadiusLarge,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteRedBorder1}`,
        backgroundColor: tokens.colorPaletteRedBackground1,
    },
});

function formatTimestamp(value: string | null): string {
    if (!value) {
        return "Never";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toLocaleString();
}

function formatInterval(minutes: number | null): string {
    if (minutes === null) {
        return "Manual";
    }

    if (minutes <= 0) {
        return "Disabled";
    }

    if (minutes % 10080 === 0) {
        const weeks = minutes / 10080;
        return `Every ${weeks} week${weeks === 1 ? "" : "s"}`;
    }

    if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        return `Every ${days} day${days === 1 ? "" : "s"}`;
    }

    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
    }

    return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatRiskLabel(riskLevel: SystemTaskContract["riskLevel"]): string {
    switch (riskLevel) {
        case "low":
            return "Low risk";
        case "medium":
            return "Medium risk";
        case "high":
            return "High risk";
        default:
            return riskLevel;
    }
}

function SystemTaskCard({
    task,
    updatingTaskId,
    runningTaskId,
    onToggleEnabled,
    onUpdateInterval,
    onRunNow,
}: {
    task: SystemTaskContract;
    updatingTaskId: string | null;
    runningTaskId: string | null;
    onToggleEnabled: (task: SystemTaskContract, enabled: boolean) => Promise<void>;
    onUpdateInterval: (task: SystemTaskContract, intervalMinutes: number) => Promise<void>;
    onRunNow: (task: SystemTaskContract) => Promise<void>;
}) {
    const styles = useStyles();
    const isScheduled = task.kind === "scheduled";
    const isBusy = updatingTaskId === task.id || runningTaskId === task.id;
    const [intervalDraft, setIntervalDraft] = useState(task.intervalMinutes === null ? "" : String(task.intervalMinutes));

    useEffect(() => {
        setIntervalDraft(task.intervalMinutes === null ? "" : String(task.intervalMinutes));
    }, [task.id, task.intervalMinutes]);

    const commitInterval = async () => {
        if (!isScheduled) {
            return;
        }

        const parsed = Number.parseInt(intervalDraft, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
            setIntervalDraft(task.intervalMinutes === null ? "" : String(task.intervalMinutes));
            return;
        }

        if (parsed === task.intervalMinutes) {
            return;
        }

        await onUpdateInterval(task, parsed);
    };

    return (
        <article className={styles.card}>
            <div className={styles.header}>
                <div className={styles.titleBlock}>
                    <Text weight="semibold">{task.name}</Text>
                    <Caption1 className={styles.mutedText}>{task.description}</Caption1>
                </div>
                <div className={styles.badges}>
                    <Badge appearance="outline" color={isScheduled ? "brand" : "informative"}>
                        {isScheduled ? "Scheduled" : "Manual"}
                    </Badge>
                    <Badge appearance="outline" color="informative">
                        {task.category}
                    </Badge>
                    <Badge appearance="outline" color={task.riskLevel === "high" ? "danger" : task.riskLevel === "medium" ? "warning" : "success"}>
                        {formatRiskLabel(task.riskLevel)}
                    </Badge>
                    {task.active ? (
                        <Badge appearance="filled" color="informative">
                            Running
                        </Badge>
                    ) : null}
                    {isScheduled && task.enabled === true ? (
                        <Badge appearance="filled" color="success">
                            Enabled
                        </Badge>
                    ) : null}
                    {isScheduled && task.enabled === false ? (
                        <Badge appearance="filled" color="warning">
                            Disabled
                        </Badge>
                    ) : null}
                </div>
            </div>

            <div className={styles.metaGrid}>
                <div className={styles.metaItem}>
                    <Caption1 className={styles.metaLabel}>{task.active ? "Running since" : "Last run"}</Caption1>
                    <Text>{formatTimestamp(task.active ? task.lastStartTime ?? task.lastExecution : task.lastExecution)}</Text>
                </div>
                <div className={styles.metaItem}>
                    <Caption1 className={styles.metaLabel}>Next run</Caption1>
                    <Text>{isScheduled ? formatTimestamp(task.nextExecution) : "On demand"}</Text>
                </div>
                <div className={styles.metaItem}>
                    <Caption1 className={styles.metaLabel}>Interval</Caption1>
                    {isScheduled ? (
                        <div className={styles.intervalField}>
                            <Input
                                className={styles.intervalInput}
                                type="number"
                                min={1}
                                step={1}
                                value={intervalDraft}
                                onChange={(_, data) => setIntervalDraft(data.value)}
                                onBlur={() => {
                                    void commitInterval();
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        void commitInterval();
                                    }
                                }}
                                disabled={isBusy}
                            />
                            <Text size={200} className={styles.mutedText}>minutes</Text>
                        </div>
                    ) : (
                        <Text>{formatInterval(task.intervalMinutes)}</Text>
                    )}
                </div>
            </div>

            <div className={styles.footer}>
                <div className={styles.footerLeft}>
                    {isScheduled ? (
                        <div className={styles.toggleLabel}>
                            <Text weight="semibold">{task.enabled ? "Enabled" : "Disabled"}</Text>
                            <Caption1 className={styles.mutedText}>
                                {task.enabled
                                    ? "This task runs automatically on its configured interval."
                                    : "Automatic runs are paused until re-enabled."}
                            </Caption1>
                        </div>
                    ) : (
                        <div className={styles.toggleLabel}>
                            <Text weight="semibold">Manual task</Text>
                            <Caption1 className={styles.mutedText}>This command only runs when triggered from the settings page.</Caption1>
                        </div>
                    )}
                </div>
                <div className={styles.footerRight}>
                    {isScheduled ? (
                        <Switch
                            checked={task.enabled === true}
                            onChange={(_, data) => {
                                void onToggleEnabled(task, data.checked);
                            }}
                            disabled={isBusy}
                            aria-label={`${task.name} enabled`}
                        />
                    ) : null}
                    {task.canRunNow ? (
                        <Button
                            appearance="outline"
                            icon={runningTaskId === task.id ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                            onClick={() => {
                                void onRunNow(task);
                            }}
                            disabled={isBusy || task.active}
                        >
                            Run now
                        </Button>
                    ) : null}
                </div>
            </div>
        </article>
    );
}

export function SystemTasksSection({
    tasks,
    loading,
    error,
    updatingTaskId,
    runningTaskId,
    onRetry,
    onToggleEnabled,
    onUpdateInterval,
    onRunNow,
}: SystemTasksSectionProps) {
    const styles = useStyles();
    const scheduledTasks = tasks.filter((task) => task.kind === "scheduled");
    const manualTasks = tasks.filter((task) => task.kind === "manual");

    return (
        <div className={styles.root}>
            {loading ? (
                <div className={styles.loadingState}>
                    <Spinner size="medium" />
                    <Text>Loading system tasks…</Text>
                </div>
            ) : error ? (
                <div className={styles.errorState}>
                    <div>
                        <Text weight="semibold">System tasks unavailable</Text>
                        <Caption1 className={styles.mutedText}>{error}</Caption1>
                    </div>
                    <Button appearance="outline" onClick={onRetry}>
                        Retry
                    </Button>
                </div>
            ) : (
                <>
                    <div className={styles.group}>
                        <div className={styles.groupHeader}>
                            <div className={styles.groupHeading}>
                                <Text weight="semibold" className={styles.groupTitle}>Scheduled Tasks</Text>
                                <Caption1 className={styles.mutedText}>Automatic jobs managed by the scheduler.</Caption1>
                            </div>
                            <Badge appearance="outline" color="brand">
                                {scheduledTasks.length}
                            </Badge>
                        </div>
                        {scheduledTasks.length > 0 ? (
                            <div className={styles.list}>
                                {scheduledTasks.map((task) => (
                                    <SystemTaskCard
                                        key={task.id}
                                        task={task}
                                        updatingTaskId={updatingTaskId}
                                        runningTaskId={runningTaskId}
                                        onToggleEnabled={onToggleEnabled}
                                        onUpdateInterval={onUpdateInterval}
                                        onRunNow={onRunNow}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className={styles.emptyState}>
                                <Text className={styles.mutedText}>No scheduled tasks are configured.</Text>
                            </div>
                        )}
                    </div>

                    <div className={styles.group}>
                        <div className={styles.groupHeader}>
                            <div className={styles.groupHeading}>
                                <Text weight="semibold" className={styles.groupTitle}>Manual Tasks</Text>
                                <Caption1 className={styles.mutedText}>Run these commands only when you need them.</Caption1>
                            </div>
                            <Badge appearance="outline" color="informative">
                                {manualTasks.length}
                            </Badge>
                        </div>
                        {manualTasks.length > 0 ? (
                            <div className={styles.list}>
                                {manualTasks.map((task) => (
                                    <SystemTaskCard
                                        key={task.id}
                                        task={task}
                                        updatingTaskId={updatingTaskId}
                                        runningTaskId={runningTaskId}
                                        onToggleEnabled={onToggleEnabled}
                                        onUpdateInterval={onUpdateInterval}
                                        onRunNow={onRunNow}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className={styles.emptyState}>
                                <Text className={styles.mutedText}>No manual tasks are available.</Text>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export default SystemTasksSection;
