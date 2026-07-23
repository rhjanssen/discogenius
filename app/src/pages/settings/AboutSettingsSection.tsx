import {
    Badge,
    Button,
    Link,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    DoorArrowLeft24Regular,
    DoorArrowLeft24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import type { AppReleaseInfoContract } from "@contracts/release";

const DoorArrowLeft24 = bundleIcon(DoorArrowLeft24Filled, DoorArrowLeft24Regular);

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
    badgeRow: {
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
        [MEDIA.mobile]: { justifyContent: "flex-start" },
    },
    metaList: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        marginTop: tokens.spacingVerticalXS,
    },
    hint: { color: tokens.colorNeutralForeground2 },
    link: { color: tokens.colorNeutralForeground2Link },
    mutedText: { color: tokens.colorNeutralForeground2 },
    signOutButton: {
        minHeight: "36px",
        [MEDIA.mobile]: { minHeight: "40px" },
    },
});

export interface AboutSettingsSectionProps {
    appVersion: string;
    releaseInfo: AppReleaseInfoContract | null;
    isAuthActive: boolean;
    onSignOut: () => void;
}

export const AboutSettingsSection = ({
    appVersion,
    releaseInfo,
    isAuthActive,
    onSignOut,
}: AboutSettingsSectionProps) => {
    const styles = useStyles();

    const currentVersionLabel = releaseInfo?.version || appVersion;
    const versionStatusColor: "warning" | "success" | "informative" = releaseInfo?.updateStatus === "update-available"
        ? "warning"
        : releaseInfo?.updateStatus === "current"
            ? "success"
            : "informative";
    const versionStatusLabel = releaseInfo?.updateStatus === "update-available"
        ? "Update available"
        : releaseInfo?.updateStatus === "current"
            ? "Up to date"
            : "Check unavailable";
    const latestVersionLabel = releaseInfo?.latestVersion ? `v${releaseInfo.latestVersion}` : "Unavailable";
    const versionHint = releaseInfo?.updateStatus === "update-available"
        ? "A newer Discogenius image is available. Pull the updated image and restart the container."
        : releaseInfo?.updateStatus === "current"
            ? "This installation is on the latest stable release."
            : "Discogenius could not reach the release feed right now. You can still update by pulling a newer image and restarting the container.";

    return (
        <SettingsSection
            id="about"
            title="About"
            description="App access, version, and updates."
            className={styles.section}
        >
            <SettingsCard>
                {isAuthActive ? (
                    <div className={styles.row}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Sign out</Text>
                            <Text size={200} className={styles.mutedText}>
                                End the admin session on this device.
                            </Text>
                        </div>
                        <div className={styles.rowControl}>
                            <Button
                                appearance="outline"
                                className={styles.signOutButton}
                                icon={<DoorArrowLeft24 />}
                                onClick={onSignOut}
                            >
                                Sign out
                            </Button>
                        </div>
                    </div>
                ) : null}

                <div className={styles.row}>
                    <div className={styles.rowContent}>
                        <Text weight="semibold">Current version</Text>
                        <Text size={200} className={styles.mutedText}>
                            Installed Discogenius app version.
                        </Text>
                    </div>
                    <div className={styles.badgeRow}>
                        <Badge appearance="filled" color={versionStatusColor}>v{currentVersionLabel}</Badge>
                    </div>
                </div>
                <div className={styles.row}>
                    <div className={styles.rowContent}>
                        <Text weight="semibold">Latest version</Text>
                        <Text size={200} className={styles.mutedText}>
                            Latest stable release Discogenius could verify.
                        </Text>
                    </div>
                    <div className={styles.badgeRow}>
                        <Badge appearance="outline" color={versionStatusColor}>{latestVersionLabel}</Badge>
                    </div>
                </div>
                <div className={styles.row}>
                    <div className={styles.rowContent}>
                        <Text weight="semibold">Update status</Text>
                        <div className={styles.metaList}>
                            <Badge appearance="filled" color={versionStatusColor}>{versionStatusLabel}</Badge>
                            <Text size={200} className={styles.hint}>{versionHint}</Text>
                            {releaseInfo?.latestReleaseUrl && (
                                <Link href={releaseInfo.latestReleaseUrl} target="_blank" className={styles.link}>
                                    Open latest release notes
                                </Link>
                            )}
                            {releaseInfo?.checkedAt && (
                                <Text size={200} className={styles.mutedText}>
                                    Last checked: {new Date(releaseInfo.checkedAt).toLocaleString()}
                                </Text>
                            )}
                        </div>
                    </div>
                </div>
            </SettingsCard>
        </SettingsSection>
    );
};

export default AboutSettingsSection;
