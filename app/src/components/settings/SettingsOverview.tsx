import {
    Badge,
    Button,
    Caption1,
    makeStyles,
    Text,
    tokens,
} from "@fluentui/react-components";
import type { PathConfigContract } from "@contracts/config";

interface SectionLink {
    id: string;
    title: string;
}

interface RenameSummary {
    total: number;
    renameNeeded: number;
    conflicts: number;
    missing: number;
}

interface RetagSummary {
    total: number;
    retagNeeded: number;
    missing: number;
}

interface UpdateSummary {
    currentVersionLabel: string;
    latestVersionLabel: string;
    versionStatusColor: "warning" | "success" | "informative";
    versionStatusLabel: string;
    versionHint: string;
}

interface SettingsOverviewProps {
    sections: SectionLink[];
    pathSettings: PathConfigContract | null;
    renameStatus: RenameSummary | null;
    renameStatusLoading: boolean;
    retagStatus: RetagSummary | null;
    retagStatusLoading: boolean;
    audioRetaggingEnabled: boolean;
    updateSummary: UpdateSummary;
    onNavigate: (sectionId: string) => void;
}

const MEDIA = {
    mobile: "@media (max-width: 640px)",
};

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
        marginBottom: tokens.spacingVerticalL,
    },
    surface: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingVerticalL,
        borderRadius: tokens.borderRadiusLarge,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        background: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 74%, transparent)`,
    },
    header: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    sectionButtons: {
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
    },
    sectionButton: {
        minHeight: "32px",
    },
    heading: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    headingTitle: {
        margin: 0,
    },
    headingHint: {
        color: tokens.colorNeutralForeground2,
    },
    tileGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: tokens.spacingHorizontalM,
        [MEDIA.mobile]: {
            gridTemplateColumns: "1fr",
        },
    },
    tile: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        padding: tokens.spacingVerticalM,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        backgroundColor: tokens.colorNeutralBackground2,
        minWidth: 0,
    },
    tileHeader: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalS,
    },
    tileTitle: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    tileTitleText: {
        margin: 0,
    },
    tileDescription: {
        color: tokens.colorNeutralForeground2,
    },
    statusBadges: {
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
    },
    pathList: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
    },
    pathRow: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        padding: `${tokens.spacingVerticalXS} 0`,
    },
    pathHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        justifyContent: "space-between",
        flexWrap: "wrap",
    },
    pathValue: {
        color: tokens.colorNeutralForeground2,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    tileActions: {
        display: "flex",
        justifyContent: "flex-end",
        marginTop: tokens.spacingVerticalXS,
    },
    updateHint: {
        color: tokens.colorNeutralForeground2,
    },
});

export const SettingsOverview = ({
    sections,
    pathSettings,
    renameStatus,
    renameStatusLoading,
    retagStatus,
    retagStatusLoading,
    audioRetaggingEnabled,
    updateSummary,
    onNavigate,
}: SettingsOverviewProps) => {
    const styles = useStyles();

    const pathEntries = [
        { label: "Music", value: pathSettings?.music_path },
        { label: "Atmos", value: pathSettings?.atmos_path },
        { label: "Video", value: pathSettings?.video_path },
    ];
    const configuredPathCount = pathEntries.filter((entry) => Boolean(entry.value)).length;
    const missingPathCount = pathEntries.length - configuredPathCount;
    const pathStatusColor = missingPathCount > 0 ? "warning" : "success";
    const pathStatusLabel = missingPathCount > 0
        ? `${missingPathCount} missing`
        : "All configured";

    const renameStatusLabel = renameStatusLoading
        ? "Refreshing preview"
        : renameStatus
            ? renameStatus.renameNeeded > 0 || renameStatus.conflicts > 0
                ? "Needs attention"
                : "Ready"
            : "Preview not loaded";
    const renameStatusColor = renameStatusLoading
        ? "informative"
        : renameStatus
            ? renameStatus.renameNeeded > 0 || renameStatus.conflicts > 0
                ? "warning"
                : "success"
            : "informative";

    const retagStatusLabel = retagStatusLoading
        ? "Refreshing preview"
        : !audioRetaggingEnabled
            ? "Disabled"
            : retagStatus
                ? retagStatus.retagNeeded > 0
                    ? "Needs attention"
                    : "Ready"
                : "Preview not loaded";
    const retagStatusColor = retagStatusLoading
        ? "informative"
        : !audioRetaggingEnabled
            ? "informative"
            : retagStatus
                ? retagStatus.retagNeeded > 0
                    ? "warning"
                    : "success"
                : "informative";

    return (
        <div id="settings-overview" className={styles.root}>
            <div className={styles.surface}>
                <div className={styles.header}>
                    <div className={styles.heading}>
                        <Text weight="semibold" size={400} className={styles.headingTitle}>
                            Settings index
                        </Text>
                        <Caption1 className={styles.headingHint}>
                            Jump directly to the area you want to change.
                        </Caption1>
                    </div>
                    <div className={styles.sectionButtons} role="navigation" aria-label="Settings sections">
                        {sections.map((section) => (
                            <Button
                                key={section.id}
                                appearance="subtle"
                                size="small"
                                className={styles.sectionButton}
                                onClick={() => onNavigate(section.id)}
                            >
                                {section.title}
                            </Button>
                        ))}
                    </div>
                </div>

                <div className={styles.tileGrid}>
                    <div className={styles.tile}>
                        <div className={styles.tileHeader}>
                            <div className={styles.tileTitle}>
                                <Text weight="semibold" size={300} className={styles.tileTitleText}>
                                    Paths
                                </Text>
                                <Caption1 className={styles.tileDescription}>
                                    Library roots and runtime storage paths.
                                </Caption1>
                            </div>
                            <Badge appearance="outline" color={pathStatusColor}>
                                {pathStatusLabel}
                            </Badge>
                        </div>
                        <div className={styles.pathList}>
                            {pathEntries.map((entry) => (
                                <div key={entry.label} className={styles.pathRow}>
                                    <div className={styles.pathHeader}>
                                        <Badge appearance="outline" color={entry.value ? "success" : "warning"}>
                                            {entry.label}
                                        </Badge>
                                    </div>
                                    <Text size={200} className={styles.pathValue}>
                                        {entry.value || "Not configured"}
                                    </Text>
                                </div>
                            ))}
                        </div>
                        <div className={styles.tileActions}>
                            <Button appearance="outline" size="small" onClick={() => onNavigate("storage")}>
                                Open Storage
                            </Button>
                        </div>
                    </div>

                    <div className={styles.tile}>
                        <div className={styles.tileHeader}>
                            <div className={styles.tileTitle}>
                                <Text weight="semibold" size={300} className={styles.tileTitleText}>
                                    Rename plan
                                </Text>
                                <Caption1 className={styles.tileDescription}>
                                    Current naming templates and file move preview.
                                </Caption1>
                            </div>
                            <Badge appearance="outline" color={renameStatusColor}>
                                {renameStatusLabel}
                            </Badge>
                        </div>
                        <div className={styles.statusBadges}>
                            <Badge appearance="outline" color="brand">
                                {renameStatus?.total ?? 0} tracked
                            </Badge>
                            <Badge appearance="outline" color={(renameStatus?.renameNeeded ?? 0) > 0 ? "warning" : "success"}>
                                {renameStatus?.renameNeeded ?? 0} need rename
                            </Badge>
                            <Badge appearance="outline" color={(renameStatus?.conflicts ?? 0) > 0 ? "warning" : "informative"}>
                                {renameStatus?.conflicts ?? 0} conflicts
                            </Badge>
                        </div>
                        <Text size={200} className={styles.updateHint}>
                            Refresh the plan after changing templates, then apply the rename pass when ready.
                        </Text>
                        <div className={styles.tileActions}>
                            <Button appearance="outline" size="small" onClick={() => onNavigate("naming")}>
                                Open Naming
                            </Button>
                        </div>
                    </div>

                    <div className={styles.tile}>
                        <div className={styles.tileHeader}>
                            <div className={styles.tileTitle}>
                                <Text weight="semibold" size={300} className={styles.tileTitleText}>
                                    Retag plan
                                </Text>
                                <Caption1 className={styles.tileDescription}>
                                    Metadata write rules and replaygain preview.
                                </Caption1>
                            </div>
                            <Badge appearance="outline" color={retagStatusColor}>
                                {retagStatusLabel}
                            </Badge>
                        </div>
                        <div className={styles.statusBadges}>
                            <Badge appearance="outline" color="brand">
                                {retagStatus?.total ?? 0} tracked
                            </Badge>
                            <Badge appearance="outline" color={(retagStatus?.retagNeeded ?? 0) > 0 ? "warning" : "success"}>
                                {retagStatus?.retagNeeded ?? 0} need retag
                            </Badge>
                            <Badge appearance="outline" color={(retagStatus?.missing ?? 0) > 0 ? "warning" : "informative"}>
                                {retagStatus?.missing ?? 0} missing
                            </Badge>
                        </div>
                        <Text size={200} className={styles.updateHint}>
                            Metadata changes are only actionable when audio retagging or ReplayGain are enabled.
                        </Text>
                        <div className={styles.tileActions}>
                            <Button appearance="outline" size="small" onClick={() => onNavigate("metadata")}>
                                Open Metadata
                            </Button>
                        </div>
                    </div>

                    <div className={styles.tile}>
                        <div className={styles.tileHeader}>
                            <div className={styles.tileTitle}>
                                <Text weight="semibold" size={300} className={styles.tileTitleText}>
                                    Updates
                                </Text>
                                <Caption1 className={styles.tileDescription}>
                                    Current and latest Discogenius release status.
                                </Caption1>
                            </div>
                            <Badge appearance="outline" color={updateSummary.versionStatusColor}>
                                {updateSummary.versionStatusLabel}
                            </Badge>
                        </div>
                        <div className={styles.statusBadges}>
                            <Badge appearance="filled" color={updateSummary.versionStatusColor}>
                                {updateSummary.currentVersionLabel}
                            </Badge>
                            <Badge appearance="outline" color={updateSummary.versionStatusColor}>
                                {updateSummary.latestVersionLabel}
                            </Badge>
                        </div>
                        <Text size={200} className={styles.updateHint}>
                            {updateSummary.versionHint}
                        </Text>
                        <div className={styles.tileActions}>
                            <Button appearance="outline" size="small" onClick={() => onNavigate("about")}>
                                Open About
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SettingsOverview;
