import {
    Button,
    Badge,
    Select,
    Switch,
    Radio,
    RadioGroup,
    Spinner,
    Text,
    Title1,
    makeStyles,
    tokens,
    Link,
} from "@fluentui/react-components";
import {
  DoorArrowLeft24Regular,
  ArrowSync24Regular,
  DoorArrowLeft24Filled,
  ArrowSync24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
import { useProviderConnection } from "@/hooks/useProviderConnection";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useAppAuth } from "@/providers/appAuthContext";
import { useTheme } from "@/providers/themeContext";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useQuery } from "@tanstack/react-query";
import React, { useState, useEffect } from "react";
import { api } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { ErrorState } from "@/components/ui/ContentState";
import { AppearanceSettingsSection } from "@/pages/settings/AppearanceSettingsSection";
import { AudioQualitySettingsSection } from "@/pages/settings/AudioQualitySettingsSection";
import { CurationSettingsSection } from "@/pages/settings/CurationSettingsSection";
import { MetadataSourceSettingsSection } from "@/pages/settings/MetadataSourceSettingsSection";
import { NamingSettingsSection } from "@/pages/settings/NamingSettingsSection";
import { ProvidersSettingsSection } from "@/pages/settings/ProvidersSettingsSection";

import { dispatchActivityRefresh } from "@/utils/appEvents";
import type {
    CatalogConfigContract,
    FilteringConfigContract,
    MonitoringConfigContract,
    MonitoringStatusResponseContract,
} from "@contracts/config";
import type { AppReleaseInfoContract } from "@contracts/release";

const DoorArrowLeft24 = bundleIcon(DoorArrowLeft24Filled, DoorArrowLeft24Regular);
const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);

const MIN_RUN_NOW_FEEDBACK_MS = 600;

// Section layout helpers
const MEDIA = {
    mobile: '@media (max-width: 640px)',
    desktop: '@media (min-width: 1024px)',
};
const MODAL_LAYOUT = {
    rowPadding: {
        // Fluent SettingsCard-style rows: modest equal padding so the title/
        // description stay balanced with the trailing control without looking airy.
        base: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
    qualityPadding: {
        // Radio options inside a Settings card — WinUI SettingsExpander density
        // uses ~4px card spacing; keep option padding to XS so lists stay compact.
        base: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    },
    controlWidth: {
        compact: '64px',
        standard: '96px',
        wide: '192px',
    },
};

const rowBase = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
    padding: MODAL_LAYOUT.rowPadding.base,
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    [MEDIA.mobile]: {
        padding: MODAL_LAYOUT.rowPadding.mobile,
        columnGap: tokens.spacingHorizontalS,
        rowGap: tokens.spacingVerticalXS,
    },
};

const useStyles = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalM,
        maxWidth: '1200px',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalM,
        [MEDIA.mobile]: {
            alignItems: 'center',
            textAlign: 'center',
        },
    },
    sectionsContainer: {
        width: '100%',
        columnGap: tokens.spacingHorizontalM,
        columnWidth: '400px',
        columnFill: 'balance',
        [MEDIA.desktop]: {
            columnGap: tokens.spacingHorizontalL,
        },
        [MEDIA.mobile]: {
            columnCount: 1,
            columnGap: tokens.spacingHorizontalM,
        },
    },
    section: {
        display: 'flex',
        width: '100%',
        breakInside: 'avoid',
        WebkitColumnBreakInside: 'avoid',
        pageBreakInside: 'avoid',
        marginBottom: tokens.spacingVerticalM,
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
    },
    sectionFullWidth: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalM,
    },
    card: {
        ...glassSurfaceStyles,
        borderRadius: tokens.borderRadiusMedium,
        padding: tokens.spacingVerticalNone,
        overflow: 'hidden',
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    },
    // Standard row: horizontal layout with title/description left, control right
    row: {
        ...rowBase,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        '&:last-child': {
            borderBottom: 'none',
        },
    },
    // Nested form fields that follow a radio group inside the same card.
    nestedFields: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    fullWidthButton: {
        ...glassButtonStyles,
        width: '100%',
        justifyContent: 'center',
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    inlineActionButton: {
        ...glassButtonStyles,
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    rowContent: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        flex: 1,
        minWidth: 0,
        paddingTop: tokens.spacingVerticalXXS,
    },
    rowControl: {
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        minHeight: '32px',
        paddingTop: tokens.spacingVerticalXXS,
    },
    // Row without bottom border divider
    rowNoDivider: {
        ...rowBase,
    },
    aboutBadgeRow: {
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
        [MEDIA.mobile]: {
            justifyContent: 'flex-start',
        },
    },
    aboutMetaList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        marginTop: tokens.spacingVerticalXS,
    },
    aboutHint: {
        color: tokens.colorNeutralForeground2,
    },
    aboutLink: {
        color: tokens.colorNeutralForeground2Link,
    },
    signOutButton: {
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    qualityOption: {
        display: 'flex',
        alignItems: 'flex-start',
        padding: MODAL_LAYOUT.qualityPadding.base,
        gap: tokens.spacingHorizontalM,
        cursor: 'pointer',
        width: '100%',
        boxSizing: 'border-box',
        '&:hover': {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
        [MEDIA.mobile]: {
            padding: MODAL_LAYOUT.qualityPadding.mobile,
            gap: tokens.spacingHorizontalS,
        },
    },
    qualityOptionDisabled: {
        opacity: 0.5,
    },
    // Collapse Fluent RadioGroup's default item gap — option padding already
    // provides the touch/scan spacing (SettingsCard stacked radios).
    qualityRadioGroup: {
        display: 'flex',
        flexDirection: 'column',
        rowGap: tokens.spacingVerticalNone,
        gap: tokens.spacingVerticalNone,
        '& > *': {
            marginTop: tokens.spacingVerticalNone,
            marginBottom: tokens.spacingVerticalNone,
        },
    },
    qualityContent: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalNone,
        flex: 1,
    },
    pathInput: {
        flex: 1,
        width: '100%',
        minWidth: 0,
    },
    loadingState: {
        paddingTop: tokens.spacingVerticalXXXL,
        paddingBottom: tokens.spacingVerticalXXXL,
        textAlign: 'center',
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    selectCompact: {
        minWidth: MODAL_LAYOUT.controlWidth.standard,
    },
    inputCompact: {
        width: MODAL_LAYOUT.controlWidth.compact,
    },
    controlMedium: {
        width: MODAL_LAYOUT.controlWidth.wide,
        maxWidth: '100%',
    },
    actionButtonRow: {
        display: 'flex',
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        flexWrap: 'wrap' as const,
        [MEDIA.mobile]: {
            flexWrap: 'nowrap' as const,
            gap: tokens.spacingHorizontalXS,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        },
    },
    actionButton: {
        flex: 1,
        minWidth: '120px',
        justifyContent: 'center',
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: 'unset',
            minWidth: 0,
            flex: '1 1 0',
            flexDirection: 'column',
            gap: '2px',
            paddingTop: tokens.spacingVerticalXS,
            paddingBottom: tokens.spacingVerticalXS,
            paddingLeft: tokens.spacingHorizontalXS,
            paddingRight: tokens.spacingHorizontalXS,
            fontSize: tokens.fontSizeBase100,
        },
    },
});

const SettingsPage = () => {
    const styles = useStyles();
    const navigate = useNavigate();
    const { toast } = useToast();
    const appVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
    const {
        qualitySettings,
        loading,
        updateQualitySettings,
        metadataSettings,
        updateMetadataSettings,
        pathSettings,
        updatePathSettings,
        namingSettings,
        updateNamingSettings,
    } = useUserSettings();
    const { isLoading: providerLoading } = useProviderConnection();
    const {
        data: streamingProviders,
        isLoading: providersLoading,
        isError: providersLoadFailed,
        error: providersLoadError,
        isFetching: providersFetching,
        refetch: refetchStreamingProviders,
    } = useQuery({
        queryKey: ["streamingProviders"],
        queryFn: () => api.getStreamingProviders(),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
    });
    const { isAuthActive, signOut } = useAppAuth();
    const { theme, setTheme, setBrandKeyColor } = useTheme();
    const { setArtwork } = useUltraBlurContext();
    const [monitoringConfig, setMonitoringConfig] = useState<MonitoringConfigContract | null>(null);
    const [monitoringStatus, setMonitoringStatus] = useState<Pick<MonitoringStatusResponseContract, "running" | "checking">>({
        running: false,
        checking: false,
    });
    const [curationConfig, setCurationConfig] = useState<FilteringConfigContract | null>(null);
    const [catalogConfig, setCatalogConfig] = useState<CatalogConfigContract | null>(null);
    const [catalogTest, setCatalogTest] = useState<{ status: "idle" | "testing" | "ok" | "error"; message?: string }>({ status: "idle" });
    const [checkingNow, setCheckingNow] = useState(false);
    const [searchingMissingAlbums, setSearchingMissingAlbums] = useState(false);
    const [releaseInfo, setReleaseInfo] = useState<AppReleaseInfoContract | null>(null);
    const writeAudioTagsPolicy = metadataSettings?.write_audio_tags_policy ?? "no";

    // Match Library: default chromatic wash, not the previous artist/album UltraBlur.
    useEffect(() => {
        setArtwork(undefined);
        setBrandKeyColor(null);
    }, [setArtwork, setBrandKeyColor]);

    useEffect(() => {
        void fetchConfigs();
    }, []);

    useEffect(() => {
        let active = true;

        api.getAppReleaseInfo()
            .then((info) => {
                if (active) setReleaseInfo(info);
            })
            .catch((error) => {
                console.error("Error fetching release info:", error);
            });

        return () => {
            active = false;
        };
    }, []);

    const fetchConfigs = async () => {
        try {
            const [monStatus, curation, catalog] = await Promise.all([
                api.getMonitoringStatus(),
                api.getCurationConfig(),
                api.getCatalogConfig(),
            ]);
            setMonitoringConfig(monStatus.config);
            setMonitoringStatus({
                running: monStatus.running,
                checking: monStatus.checking,
            });
            setCurationConfig(curation);
            setCatalogConfig(catalog);
        } catch (error) {
            console.error('Error fetching configs:', error);
            // Set defaults on error
            setMonitoringConfig({
                enabled: false,
                monitorNewArtists: true,
                removeUnmonitoredFiles: false,
            });
            setMonitoringStatus({ running: false, checking: false });
            setCurationConfig({
                include_album: true,
                include_single: true,
                include_ep: true,
                include_broadcast: true,
                include_other: true,
                include_compilation: true,
                include_soundtrack: true,
                include_live: true,
                include_remix: true,
                include_dj_mix: true,
                include_mixtape_street: true,
                include_demo: true,
                include_spatial: false,
                include_videos: false,
                enable_redundancy_filter: true,
                prefer_explicit: true,
                require_provider_availability: false,
            });
        }
    };

    const updateMonitoring = async (updates: Partial<MonitoringConfigContract>) => {
        try {
            const result = await api.updateMonitoringConfig(updates);
            setMonitoringConfig(result.config);

            if (updates.enabled !== undefined) {
                toast({
                    title: updates.enabled ? "Monitoring enabled" : "Monitoring disabled",
                    description: updates.enabled
                        ? "Background monitoring service has been started."
                        : "Background monitoring service has been stopped.",
                });
            }
        } catch (error) {
            console.error('Error updating monitoring config:', error);
            toast({
                title: "Error",
                description: "Failed to update monitoring configuration.",
                variant: "destructive"
            });
        }
    };

    const updateCuration = async (updates: Partial<FilteringConfigContract>) => {
        try {
            await api.updateCurationConfig(updates);
            setCurationConfig((current) => (current ? { ...current, ...updates } : current));
        } catch (error) {
            console.error('Error updating curation config:', error);
            toast({
                title: "Error",
                description: "Failed to update curation configuration.",
                variant: "destructive"
            });
        }
    };

    const updateCatalog = async (updates: Partial<CatalogConfigContract>) => {
        const previous = catalogConfig;
        setCatalogConfig((current) => (current ? { ...current, ...updates } : current));
        setCatalogTest({ status: "idle" });
        try {
            await api.updateCatalogConfig(updates);
        } catch (error) {
            console.error('Error updating catalog config:', error);
            setCatalogConfig(previous);
            toast({
                title: "Error",
                description: "Failed to update metadata source.",
                variant: "destructive"
            });
        }
    };

    const testCatalogConnection = async () => {
        if (!catalogConfig) return;
        setCatalogTest({ status: "testing" });
        try {
            const result = await api.testCatalogConnection(catalogConfig.musicbrainz_host);
            setCatalogTest({ status: result.ok ? "ok" : "error", message: result.message });
        } catch (error) {
            setCatalogTest({ status: "error", message: error instanceof Error ? error.message : "Connection test failed" });
        }
    };

    const handleQueueCuration = async () => {
        setSearchingMissingAlbums(true);
        try {
            const result: any = await api.queueCuration();
            toast({
                title: "Curation queued",
                description: result?.message || `Queued artist curation for ${result?.queued || 0} artist(s).`,
            });
        } catch (error) {
            console.error("Error queueing missing album search:", error);
            toast({
                title: "Curation failed",
                description: "Could not queue library-wide curation.",
                variant: "destructive",
            });
        } finally {
            setSearchingMissingAlbums(false);
        }
    };

    const handleSignOut = () => {
        signOut();
        navigate("/login");
    };

    if (loading || providerLoading || providersLoading) {
        return (
            <div className={styles.container}>
                <Spinner size="large" className={styles.loadingState} />
            </div>
        );
    }

    if (!qualitySettings) {
        return (
            <div className={styles.container}>
                <ErrorState
                    className={styles.loadingState}
                    title="Settings unavailable"
                    description="Discogenius could not load settings. Refresh the page or check that the app is running."
                />
            </div>
        );
    }

    const videoQualityOptions = [
        { value: 'sd', label: 'SD (480p)', disabled: false },
        { value: 'hd', label: 'HD (720p)', disabled: false },
        { value: 'fhd', label: 'Full HD (1080p)', disabled: false },
        { value: 'uhd', label: 'Ultra HD (2160p)', disabled: false },
    ];

    const isScanInProgress = checkingNow || monitoringStatus.checking || monitoringConfig?.checkInProgress;

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

    const renderToggleRow = ({
        title,
        description,
        checked,
        onChange,
        disabled,
        noDivider = false,
    }: {
        title: string;
        description: React.ReactNode;
        checked: boolean;
        onChange: (checked: boolean) => void;
        disabled?: boolean;
        noDivider?: boolean;
    }) => (
        <div className={noDivider ? styles.rowNoDivider : styles.row}>
            <div className={styles.rowContent}>
                <Text weight="semibold">{title}</Text>
                <Text size={200} className={styles.mutedText}>
                    {description}
                </Text>
            </div>
            <div className={styles.rowControl}>
                <Switch
                    checked={checked}
                    onChange={(_, data) => onChange(data.checked)}
                    disabled={disabled}
                />
            </div>
        </div>
    );


    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Title1>Settings</Title1>
            </div>

            <div className={styles.sectionsContainer} data-testid="settings-sections">


                {isAuthActive ? (
                    <SettingsSection
                        id="app-access"
                        title="App Access"
                        description="Sign-in for this browser session."
                        className={styles.section}
                    >
                        <div className={styles.card}>
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
                                    onClick={handleSignOut}
                                >
                                    Sign out
                                </Button>
                                </div>
                            </div>
                        </div>
                    </SettingsSection>
                ) : null}

                <AudioQualitySettingsSection
                    audioQuality={qualitySettings?.audio_quality || "max"}
                    includeSpatial={curationConfig?.include_spatial === true}
                    onAudioQualityChange={(audio_quality) => updateQualitySettings({ audio_quality })}
                    onIncludeSpatialChange={(include_spatial) => updateCuration({ include_spatial })}
                />
                {/* Video Quality */}
                <SettingsSection
                    id="video-quality"
                    title="Music videos"
                    description="Whether to download videos and at which resolution."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {renderToggleRow({
                            title: "Download music videos",
                            description: "Include official videos in the library when a service offers them.",
                            checked: curationConfig?.include_videos === true,
                            onChange: (checked) => updateCuration({ include_videos: checked }),
                        })}
                        <RadioGroup
                            className={styles.qualityRadioGroup}
                            value={qualitySettings?.video_quality || 'uhd'}
                            onChange={(_, data) => updateQualitySettings({
                                video_quality: data.value as "sd" | "hd" | "fhd" | "uhd"
                            })}
                        >
                            {videoQualityOptions.map((option) => (
                                <label
                                    key={option.value}
                                    className={styles.qualityOption}
                                    htmlFor={`video-quality-${option.value}`}
                                >
                                    <Radio value={option.value} id={`video-quality-${option.value}`} disabled={option.disabled} />
                                    <div className={styles.qualityContent}>
                                        <Text weight="semibold">{option.label}</Text>
                                        {option.disabled ? (
                                            <Text size={200} className={styles.mutedText}>
                                                No connected service offers this resolution
                                            </Text>
                                        ) : null}
                                    </div>
                                </label>
                            ))}
                        </RadioGroup>
                    </div>
                </SettingsSection>

                {/* Curation Section */}
                <CurationSettingsSection
                    curationConfig={curationConfig}
                    updating={searchingMissingAlbums}
                    onUpdate={updateCuration}
                    onQueueCuration={handleQueueCuration}
                />

                {/* Monitoring Section */}
                <SettingsSection
                    id="monitoring"
                    title="Monitoring"
                    description="Automatic checks for new music and library cleanup."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {renderToggleRow({
                            title: "Automatic monitoring",
                            description: "Periodically look for new releases from monitored artists.",
                            checked: monitoringConfig?.enabled || false,
                            onChange: (checked) => updateMonitoring({ enabled: checked }),
                        })}
                        {renderToggleRow({
                            title: "Upgrade when quality settings change",
                            description: "Replace existing files if you raise the preferred quality.",
                            checked: qualitySettings?.upgrade_existing_files ?? false,
                            onChange: (checked) => updateQualitySettings({ upgrade_existing_files: checked }),
                        })}
                        {renderToggleRow({
                            title: "Monitor newly found artists",
                            description: "When a folder scan finds a new artist, monitor them and fill their library.",
                            checked: monitoringConfig?.monitorNewArtists ?? true,
                            onChange: (checked) => updateMonitoring({ monitorNewArtists: checked }),
                        })}
                        {renderToggleRow({
                            title: "Remove unmonitored files",
                            description: "Delete files for releases you no longer monitor.",
                            checked: monitoringConfig?.removeUnmonitoredFiles || false,
                            onChange: (checked) => updateMonitoring({ removeUnmonitoredFiles: checked }),
                        })}
                        <div className={styles.actionButtonRow}>
                            <Button
                                appearance="outline"
                                className={styles.fullWidthButton}
                                icon={isScanInProgress ? <Spinner size="tiny" /> : <ArrowSync24 />}
                                onClick={async () => {
                                    const startedAt = Date.now();
                                    setCheckingNow(true);
                                    dispatchActivityRefresh();
                                    try {
                                        const result: any = await api.triggerAllMonitoring();
                                        dispatchActivityRefresh();
                                        await fetchConfigs();
                                        toast({
                                            title: "Monitoring Cycle Queued",
                                            description: result?.message || "The monitoring cycle has been queued.",
                                        });
                                    } catch (error) {
                                        console.error("Error triggering monitoring:", error);
                                        toast({
                                            title: "Error",
                                            description: "Failed to queue the monitoring cycle.",
                                            variant: "destructive"
                                        });
                                    } finally {
                                        const elapsed = Date.now() - startedAt;
                                        if (elapsed < MIN_RUN_NOW_FEEDBACK_MS) {
                                            await new Promise((resolve) => window.setTimeout(resolve, MIN_RUN_NOW_FEEDBACK_MS - elapsed));
                                        }
                                        setCheckingNow(false);
                                    }
                                }}
                                disabled={isScanInProgress}
                            >
                                {isScanInProgress ? "Running Task..." : "Run Now"}
                            </Button>
                        </div>
                    </div>
                </SettingsSection>

                {/* Metadata */}
                <SettingsSection
                    id="metadata"
                    title="Metadata & extras"
                    description="What to write into files and keep beside them in the library."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Write audio tags</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Embed titles, artists, albums, and MusicBrainz IDs in audio files.
                                </Text>
                            </div>
                            <div className={styles.rowControl}>
                            <Select
                                value={writeAudioTagsPolicy}
                                onChange={(_, data) => {
                                    updateMetadataSettings({
                                        write_audio_tags_policy: data.value as "no" | "new_files" | "all_files",
                                    });
                                }}
                                className={styles.controlMedium}
                            >
                                <option value="no">Off</option>
                                <option value="new_files">New downloads only</option>
                                <option value="all_files">All files</option>
                            </Select>
                            </div>
                        </div>

                        {renderToggleRow({
                            title: "Save album covers",
                            description: "Keep cover art in the album folder. Animated covers are kept when available.",
                            checked: metadataSettings?.save_album_cover === true,
                            onChange: (checked) => updateMetadataSettings({ save_album_cover: checked }),
                        })}

                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Preferred artwork</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Prefer catalog artwork, or artwork from the streaming service. The other source is used as fallback.
                                </Text>
                            </div>
                            <div className={styles.rowControl}>
                            <Select
                                value={metadataSettings?.artwork_preference === "provider" ? "provider" : "canonical"}
                                onChange={(_, data) => updateMetadataSettings({
                                    artwork_preference: data.value as "canonical" | "provider",
                                })}
                                className={styles.controlMedium}
                            >
                                <option value="canonical">Catalog artwork</option>
                                <option value="provider">Streaming service</option>
                            </Select>
                            </div>
                        </div>

                        {renderToggleRow({
                            title: "Save NFO files",
                            description: "Write sidecar info files next to albums for media servers and scrapers.",
                            checked: metadataSettings?.save_nfo === true,
                            onChange: (checked) => updateMetadataSettings({ save_nfo: checked }),
                        })}

                        {renderToggleRow({
                            title: "Save lyrics",
                            description: "Save a lyrics file next to each track. Synced lyrics are used when available.",
                            checked: metadataSettings?.save_lyrics === true,
                            onChange: (checked) => updateMetadataSettings({ save_lyrics: checked }),
                        })}

                        {renderToggleRow({
                            title: "Save artist pictures",
                            description: "Keep artist images in the artist folder.",
                            checked: metadataSettings?.save_artist_picture === true,
                            onChange: (checked) => updateMetadataSettings({ save_artist_picture: checked }),
                        })}

                        {renderToggleRow({
                            title: "Save video thumbnails",
                            description: "Keep a thumbnail image next to each music video for media servers.",
                            checked: metadataSettings?.save_video_thumbnail === true,
                            onChange: (checked) => updateMetadataSettings({ save_video_thumbnail: checked }),
                        })}

                        {renderToggleRow({
                            title: "Embed video thumbnails",
                            description: "Also embed the thumbnail inside the video file when possible.",
                            checked: metadataSettings?.embed_video_thumbnail !== false,
                            onChange: (checked) => updateMetadataSettings({ embed_video_thumbnail: checked }),
                        })}

                        {renderToggleRow({
                            title: "Fingerprint imported files",
                            description: "For files you already have, use audio fingerprinting to confirm the correct track before tagging.",
                            checked: metadataSettings?.enable_fingerprinting === true,
                            onChange: (checked) => updateMetadataSettings({ enable_fingerprinting: checked }),
                        })}
                    </div>
                </SettingsSection>

                <NamingSettingsSection
                    pathSettings={pathSettings}
                    updatePathSettings={updatePathSettings}
                    namingSettings={namingSettings}
                    updateNamingSettings={updateNamingSettings}
                />

                <AppearanceSettingsSection
                    theme={theme}
                    onThemeChange={setTheme}
                />

                <MetadataSourceSettingsSection
                    catalogConfig={catalogConfig}
                    catalogTest={catalogTest}
                    onUpdateCatalog={updateCatalog}
                    onHostChange={(host) => setCatalogConfig((current) => (current ? { ...current, musicbrainz_host: host } : current))}
                    onTestConnection={testCatalogConnection}
                />

                <ProvidersSettingsSection
                    providers={streamingProviders?.providers ?? []}
                    loadFailed={providersLoadFailed}
                    loadError={providersLoadError}
                    fetching={providersFetching}
                    loading={providersLoading}
                    onRefetch={refetchStreamingProviders}
                />

                {/* About */}
                <SettingsSection
                    id="about"
                    title="About"
                    description="App info and version."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Current Version</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Installed Discogenius app version.
                                </Text>
                            </div>
                            <div className={styles.aboutBadgeRow}>
                                <Badge appearance="filled" color={versionStatusColor}>v{currentVersionLabel}</Badge>
                            </div>
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Latest Version</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Latest stable release Discogenius could verify.
                                </Text>
                            </div>
                            <div className={styles.aboutBadgeRow}>
                                <Badge appearance="outline" color={versionStatusColor}>{latestVersionLabel}</Badge>
                            </div>
                        </div>
                        <div className={styles.rowNoDivider}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Update Status</Text>
                                <div className={styles.aboutMetaList}>
                                    <Badge appearance="filled" color={versionStatusColor}>{versionStatusLabel}</Badge>
                                    <Text size={200} className={styles.aboutHint}>
                                        {versionHint}
                                    </Text>
                                    {releaseInfo?.latestReleaseUrl && (
                                        <Link href={releaseInfo.latestReleaseUrl} target="_blank" className={styles.aboutLink}>
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
                    </div>
                </SettingsSection>
            </div >
        </div >
    );
};

export default SettingsPage;
