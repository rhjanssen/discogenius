import {
    Button,
    Spinner,
    Switch,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    ArrowSync24Regular,
    ArrowSync24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import type { MonitoringConfigContract } from "@contracts/config";

const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);

const MEDIA = { mobile: "@media (max-width: 640px)" };

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    row: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        columnGap: tokens.spacingHorizontalM,
        rowGap: tokens.spacingVerticalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": { borderBottom: "none" },
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        },
    },
    rowContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        flex: 1,
        minWidth: 0,
        paddingTop: tokens.spacingVerticalXXS,
    },
    rowControl: {
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        minHeight: "32px",
        paddingTop: tokens.spacingVerticalXXS,
    },
    actionRow: {
        display: "flex",
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        },
    },
    fullWidthButton: {
        ...glassButtonStyles,
        width: "100%",
        justifyContent: "center",
        minHeight: "36px",
        [MEDIA.mobile]: { minHeight: "40px" },
    },
    mutedText: { color: tokens.colorNeutralForeground2 },
});

export interface MonitoringSettingsSectionProps {
    monitoringConfig: MonitoringConfigContract | null;
    upgradeExistingFiles: boolean;
    downconvertExistingFiles: boolean;
    isScanInProgress: boolean;
    onUpdateMonitoring: (updates: Partial<MonitoringConfigContract>) => void | Promise<void>;
    onUpgradeExistingFilesChange: (checked: boolean) => void | Promise<void>;
    onDownconvertExistingFilesChange: (checked: boolean) => void | Promise<void>;
    onRunNow: () => void | Promise<void>;
}

export const MonitoringSettingsSection = ({
    monitoringConfig,
    upgradeExistingFiles,
    downconvertExistingFiles,
    isScanInProgress,
    onUpdateMonitoring,
    onUpgradeExistingFilesChange,
    onDownconvertExistingFilesChange,
    onRunNow,
}: MonitoringSettingsSectionProps) => {
    const styles = useStyles();

    const renderToggleRow = (options: {
        title: string;
        description: ReactNode;
        checked: boolean;
        onChange: (checked: boolean) => void;
    }) => (
        <div className={styles.row}>
            <div className={styles.rowContent}>
                <Text weight="semibold">{options.title}</Text>
                <Text size={200} className={styles.mutedText}>{options.description}</Text>
            </div>
            <div className={styles.rowControl}>
                <Switch aria-label={options.title} checked={options.checked} onChange={(_, data) => options.onChange(data.checked)} />
            </div>
        </div>
    );

    return (
        <SettingsSection
            id="monitoring"
            title="Monitoring"
            description="Automatic checks for new music, quality upgrades, and library cleanup."
            className={styles.section}
        >
            <SettingsCard>
                {renderToggleRow({
                    title: "Automatic monitoring",
                    description: "Periodically look for new releases from monitored artists.",
                    checked: monitoringConfig?.enabled || false,
                    onChange: (checked) => void onUpdateMonitoring({ enabled: checked }),
                })}
                {renderToggleRow({
                    title: "Upgrade when quality settings change",
                    description: "Replace existing files if you raise the preferred quality.",
                    checked: upgradeExistingFiles,
                    onChange: (checked) => void onUpgradeExistingFilesChange(checked),
                })}
                {renderToggleRow({
                    title: "Also downconvert existing files",
                    description: "When you lower preferred quality, transcode files already in the stereo library down to that class. Off keeps higher-quality files as they are.",
                    checked: downconvertExistingFiles,
                    onChange: (checked) => void onDownconvertExistingFilesChange(checked),
                })}
                {renderToggleRow({
                    title: "Monitor newly found artists",
                    description: "When a folder scan finds a new artist, monitor them and fill their library.",
                    checked: monitoringConfig?.monitorNewArtists ?? false,
                    onChange: (checked) => void onUpdateMonitoring({ monitorNewArtists: checked }),
                })}
                {renderToggleRow({
                    title: "Remove unmonitored files",
                    description: "Delete release files when you stop monitoring them and during housekeeping.",
                    checked: monitoringConfig?.removeUnmonitoredFiles || false,
                    onChange: (checked) => void onUpdateMonitoring({ removeUnmonitoredFiles: checked }),
                })}
                <div className={styles.actionRow}>
                    <Button
                        appearance="outline"
                        className={styles.fullWidthButton}
                        icon={isScanInProgress ? <Spinner size="tiny" /> : <ArrowSync24 />}
                        onClick={() => void onRunNow()}
                        disabled={isScanInProgress}
                    >
                        {isScanInProgress ? "Running task…" : "Run now"}
                    </Button>
                </div>
            </SettingsCard>
        </SettingsSection>
    );
};

export default MonitoringSettingsSection;
