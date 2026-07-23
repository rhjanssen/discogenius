import {
    Button,
    Badge,
    Caption1,
    Menu,
    MenuGroupHeader,
    MenuItem,
    MenuList,
    MenuPopover,
    MenuTrigger,
    Select,
    Switch,
    Spinner,
    Tab,
    TabList,
    Text,
    Title1,
    makeStyles,
    tokens,
    Link,
    type SelectTabData,
    type SelectTabEvent,
    type TabValue,
} from "@fluentui/react-components";
import {
    DoorArrowLeft24Regular,
    ArrowSync24Regular,
    DoorArrowLeft24Filled,
    ArrowSync24Filled,
    ChevronDown24Regular,
    ChevronDown24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { useProviderConnection } from "@/hooks/useProviderConnection";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useAppAuth } from "@/providers/appAuthContext";
import { useTheme } from "@/providers/themeContext";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { ErrorState } from "@/components/ui/ContentState";
import { AppearanceSettingsSection } from "@/pages/settings/AppearanceSettingsSection";
import { AudioQualitySettingsSection } from "@/pages/settings/AudioQualitySettingsSection";
import { CurationSettingsSection } from "@/pages/settings/CurationSettingsSection";
import { MetadataSourceSettingsSection } from "@/pages/settings/MetadataSourceSettingsSection";
import { MusicVideosSettingsSection } from "@/pages/settings/MusicVideosSettingsSection";
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
const ChevronDown24 = bundleIcon(ChevronDown24Filled, ChevronDown24Regular);

const MIN_RUN_NOW_FEEDBACK_MS = 600;

/** Fluent 2 breakpoints: large < 1024, x-large ≥ 1024. */
const MEDIA = {
    mobile: "@media (max-width: 639px)",
    desktop: "@media (min-width: 1024px)",
};

const MODAL_LAYOUT = {
    rowPadding: {
        // Fluent SettingsCard-style rows: modest equal padding so the title/
        // description stay balanced with the trailing control without looking airy.
        base: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
    controlWidth: {
        compact: "64px",
        standard: "96px",
        wide: "192px",
    },
};

type SettingsCategory =
    | "streaming-providers"
    | "metadata-source"
    | "audio"
    | "music-videos"
    | "curation"
    | "monitoring"
    | "media-management"
    | "metadata"
    | "appearance"
    | "about";

type SettingsCategoryDef = {
    value: SettingsCategory;
    label: string;
    /** Section element ids that belong to this tab (for hash deep-links). */
    sectionIds: string[];
};

/**
 * Grouped, workflow-ordered navigation (Lidarr/Jellyfin-style): connect sources,
 * decide what music/video to collect, then how the library is organized.
 */
const SETTINGS_GROUPS: Array<{ label: string; categories: SettingsCategoryDef[] }> = [
    {
        label: "Connections",
        categories: [
            { value: "streaming-providers", label: "Providers", sectionIds: ["streaming-providers"] },
            { value: "metadata-source", label: "Metadata Source", sectionIds: ["metadata-source"] },
        ],
    },
    {
        label: "Music & Video",
        categories: [
            { value: "audio", label: "Audio", sectionIds: ["audio-quality"] },
            { value: "music-videos", label: "Music Videos", sectionIds: ["music-videos"] },
            { value: "curation", label: "Curation", sectionIds: ["curation"] },
            { value: "monitoring", label: "Monitoring", sectionIds: ["monitoring"] },
        ],
    },
    {
        label: "Library",
        categories: [
            { value: "media-management", label: "Media Management", sectionIds: ["media-management"] },
            { value: "metadata", label: "Metadata", sectionIds: ["metadata"] },
        ],
    },
    {
        label: "Application",
        categories: [
            { value: "appearance", label: "Appearance", sectionIds: ["appearance"] },
            { value: "about", label: "About", sectionIds: ["app-access", "about"] },
        ],
    },
];

const SETTINGS_CATEGORIES: SettingsCategoryDef[] = SETTINGS_GROUPS.flatMap((group) => group.categories);

/** Legacy hash aliases so old deep-links keep resolving after the reorg. */
const LEGACY_CATEGORY_HASHES: Record<string, SettingsCategory> = {
    catalog: "metadata-source",
    quality: "audio",
    "audio-quality": "audio",
    "video-quality": "music-videos",
};

const DEFAULT_CATEGORY: SettingsCategory = "streaming-providers";

function categoryFromHash(hash: string): SettingsCategory | null {
    const raw = hash.replace(/^#/, "").trim();
    if (!raw) return null;
    const byValue = SETTINGS_CATEGORIES.find((c) => c.value === raw);
    if (byValue) return byValue.value;
    const bySection = SETTINGS_CATEGORIES.find((c) => c.sectionIds.includes(raw));
    if (bySection) return bySection.value;
    return LEGACY_CATEGORY_HASHES[raw] ?? null;
}

const rowBase = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap" as const,
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
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalM,
        // Nav (~220) + content (~800) + gap; avoid huge empty gutters.
        maxWidth: "1120px",
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
        [MEDIA.mobile]: {
            padding: tokens.spacingVerticalS,
            gap: tokens.spacingVerticalS,
        },
    },
    header: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalXXS,
        [MEDIA.mobile]: {
            alignItems: "center",
            textAlign: "center",
        },
    },
    /**
     * Fluent 2 reposition: stack on small/medium; side-by-side nav + panel at x-large.
     */
    layout: {
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: tokens.spacingVerticalM,
        width: "100%",
        minWidth: 0,
        [MEDIA.desktop]: {
            flexDirection: "row",
            alignItems: "flex-start",
            gap: tokens.spacingHorizontalXL,
        },
    },
    nav: {
        flexShrink: 0,
        minWidth: 0,
        [MEDIA.desktop]: {
            width: "220px",
            // Stick below the app header (sticky at top:0 in Layout). Header is
            // ~48–56px + safe-area; leave a small gap under it.
            position: "sticky",
            top: "calc(env(safe-area-inset-top, 0px) + 56px)",
            alignSelf: "flex-start",
            maxHeight: "calc(100vh - env(safe-area-inset-top, 0px) - 56px - 12px)",
            overflowY: "auto",
            // Avoid creating a sticky-breaking scrollport on the x axis.
            overflowX: "clip",
            zIndex: 1,
        },
    },
    /** Compact category picker below the x-large breakpoint. */
    mobileNav: {
        display: "block",
        width: "100%",
        [MEDIA.desktop]: {
            display: "none",
        },
    },
    mobileNavButton: {
        ...glassButtonStyles,
        width: "100%",
        justifyContent: "space-between",
        minHeight: "40px",
    },
    /** Vertical TabList on desktop (Fluent TabListVertical pattern). */
    desktopNav: {
        display: "none",
        [MEDIA.desktop]: {
            display: "block",
            width: "100%",
        },
    },
    desktopTabList: {
        width: "100%",
    },
    navGroups: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
    },
    navGroup: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    navGroupHeader: {
        color: tokens.colorNeutralForeground3,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: tokens.fontWeightSemibold,
        paddingLeft: tokens.spacingHorizontalS,
        paddingBottom: tokens.spacingVerticalXXS,
    },
    panel: {
        flex: "1 1 auto",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXL,
        // Focused reading width inside the content column.
        maxWidth: "800px",
        width: "100%",
    },
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        marginBottom: tokens.spacingVerticalNone,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    // Standard row: horizontal layout with title/description left, control right
    row: {
        ...rowBase,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": {
            borderBottom: "none",
        },
    },
    fullWidthButton: {
        ...glassButtonStyles,
        width: "100%",
        justifyContent: "center",
        minHeight: "36px",
        [MEDIA.mobile]: {
            minHeight: "40px",
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
    rowNoDivider: {
        ...rowBase,
    },
    aboutBadgeRow: {
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
        [MEDIA.mobile]: {
            justifyContent: "flex-start",
        },
    },
    aboutMetaList: {
        display: "flex",
        flexDirection: "column",
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
        minHeight: "36px",
        [MEDIA.mobile]: {
            minHeight: "40px",
        },
    },
    loadingState: {
        paddingTop: tokens.spacingVerticalXXXL,
        paddingBottom: tokens.spacingVerticalXXXL,
        textAlign: "center",
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    controlMedium: {
        width: MODAL_LAYOUT.controlWidth.wide,
        maxWidth: "100%",
    },
    actionButtonRow: {
        display: "flex",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        flexWrap: "wrap" as const,
        [MEDIA.mobile]: {
            flexWrap: "nowrap" as const,
            gap: tokens.spacingHorizontalXS,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
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
    const [selectedCategory, setSelectedCategory] = useState<SettingsCategory>(() => {
        if (typeof window === "undefined") return DEFAULT_CATEGORY;
        return categoryFromHash(window.location.hash) ?? DEFAULT_CATEGORY;
    });
    const writeAudioTagsPolicy = metadataSettings?.write_audio_tags_policy ?? "no";

    const selectedCategoryLabel = useMemo(
        () => SETTINGS_CATEGORIES.find((c) => c.value === selectedCategory)?.label ?? "Settings",
        [selectedCategory],
    );

    const selectCategory = useCallback((next: SettingsCategory) => {
        setSelectedCategory(next);
        if (typeof window !== "undefined") {
            const url = new URL(window.location.href);
            url.hash = next;
            window.history.replaceState(null, "", `${url.pathname}${url.search}#${next}`);
        }
    }, []);

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

    useEffect(() => {
        const onHashChange = () => {
            const next = categoryFromHash(window.location.hash);
            if (next) setSelectedCategory(next);
        };
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
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
            console.error("Error fetching configs:", error);
            // Set defaults on error
            setMonitoringConfig({
                enabled: false,
                monitorNewArtists: false,
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
                include_video_official: true,
                include_video_lyric: true,
                include_video_live: true,
                include_video_visualizer: true,
                include_video_official_audio: true,
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
            console.error("Error updating monitoring config:", error);
            toast({
                title: "Error",
                description: "Failed to update monitoring configuration.",
                variant: "destructive",
            });
        }
    };

    const updateCuration = async (updates: Partial<FilteringConfigContract>) => {
        try {
            await api.updateCurationConfig(updates);
            setCurationConfig((current) => (current ? { ...current, ...updates } : current));
        } catch (error) {
            console.error("Error updating curation config:", error);
            toast({
                title: "Error",
                description: "Failed to update curation configuration.",
                variant: "destructive",
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
            console.error("Error updating catalog config:", error);
            setCatalogConfig(previous);
            toast({
                title: "Error",
                description: "Failed to update metadata source.",
                variant: "destructive",
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

    const onTabSelect = (_event: SelectTabEvent, data: SelectTabData) => {
        selectCategory(data.value as SettingsCategory);
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

    const renderCategoryPanel = (category: SettingsCategory) => {
        switch (category) {
            case "media-management":
                return (
                    <NamingSettingsSection
                        pathSettings={pathSettings}
                        updatePathSettings={updatePathSettings}
                        namingSettings={namingSettings}
                        updateNamingSettings={updateNamingSettings}
                    />
                );
            case "streaming-providers":
                return (
                    <ProvidersSettingsSection
                        providers={streamingProviders?.providers ?? []}
                        loadFailed={providersLoadFailed}
                        loadError={providersLoadError}
                        fetching={providersFetching}
                        loading={providersLoading}
                        onRefetch={refetchStreamingProviders}
                    />
                );
            case "metadata-source":
                return (
                    <MetadataSourceSettingsSection
                        catalogConfig={catalogConfig}
                        catalogTest={catalogTest}
                        onUpdateCatalog={updateCatalog}
                        onHostChange={(host) => setCatalogConfig((current) => (current ? { ...current, musicbrainz_host: host } : current))}
                        onTestConnection={testCatalogConnection}
                    />
                );
            case "metadata":
                return (
                    <SettingsSection
                        id="metadata"
                        title="Metadata & extras"
                        description="What to write into files and keep beside them in the library."
                        className={styles.section}
                    >
                        <SettingsCard>
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
                        </SettingsCard>
                    </SettingsSection>
                );
            case "audio":
                return (
                    <AudioQualitySettingsSection
                        audioQuality={qualitySettings?.audio_quality || "max"}
                        includeSpatial={curationConfig?.include_spatial === true}
                        onAudioQualityChange={(audio_quality) => updateQualitySettings({ audio_quality })}
                        onIncludeSpatialChange={(include_spatial) => updateCuration({ include_spatial })}
                    />
                );
            case "music-videos":
                return (
                    <MusicVideosSettingsSection
                        curationConfig={curationConfig}
                        videoQuality={qualitySettings?.video_quality || "uhd"}
                        videoFolderLayout={pathSettings?.video_folder_layout || "separated"}
                        onUpdateCuration={updateCuration}
                        onVideoQualityChange={(video_quality) => updateQualitySettings({ video_quality })}
                        onVideoFolderLayoutChange={(video_folder_layout) => updatePathSettings({ video_folder_layout })}
                    />
                );
            case "curation":
                return (
                    <CurationSettingsSection
                        curationConfig={curationConfig}
                        updating={searchingMissingAlbums}
                        onUpdate={updateCuration}
                        onQueueCuration={handleQueueCuration}
                    />
                );
            case "monitoring":
                return (
                    <SettingsSection
                        id="monitoring"
                        title="Monitoring"
                        description="Automatic checks for new music and library cleanup."
                        className={styles.section}
                    >
                        <SettingsCard>
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
                                checked: monitoringConfig?.monitorNewArtists ?? false,
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
                                                variant: "destructive",
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
                        </SettingsCard>
                    </SettingsSection>
                );
            case "appearance":
                return (
                    <AppearanceSettingsSection
                        theme={theme}
                        onThemeChange={setTheme}
                    />
                );
            case "about":
                return (
                    <>
                        {isAuthActive ? (
                            <SettingsSection
                                id="app-access"
                                title="App Access"
                                description="Sign-in for this browser session."
                                className={styles.section}
                            >
                                <SettingsCard>
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
                                </SettingsCard>
                            </SettingsSection>
                        ) : null}

                        <SettingsSection
                            id="about"
                            title="About"
                            description="App info and version."
                            className={styles.section}
                        >
                            <SettingsCard>
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
                            </SettingsCard>
                        </SettingsSection>
                    </>
                );
            default:
                return null;
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Title1>Settings</Title1>
            </div>

            <div className={styles.layout} data-testid="settings-layout">
                <nav className={styles.nav} aria-label="Settings categories">
                    <div className={styles.mobileNav}>
                        <Menu>
                            <MenuTrigger disableButtonEnhancement>
                                <Button
                                    appearance="outline"
                                    icon={<ChevronDown24 />}
                                    iconPosition="after"
                                    className={styles.mobileNavButton}
                                    data-testid="settings-category-menu"
                                >
                                    {selectedCategoryLabel}
                                </Button>
                            </MenuTrigger>
                            <MenuPopover>
                                <MenuList>
                                    {SETTINGS_GROUPS.map((group) => (
                                        <React.Fragment key={group.label}>
                                            <MenuGroupHeader>{group.label}</MenuGroupHeader>
                                            {group.categories.map((category) => (
                                                <MenuItem
                                                    key={category.value}
                                                    onClick={() => selectCategory(category.value)}
                                                >
                                                    {category.label}
                                                </MenuItem>
                                            ))}
                                        </React.Fragment>
                                    ))}
                                </MenuList>
                            </MenuPopover>
                        </Menu>
                    </div>

                    <div className={styles.desktopNav} data-testid="settings-category-tabs">
                        <div className={styles.navGroups}>
                            {SETTINGS_GROUPS.map((group) => (
                                <div key={group.label} className={styles.navGroup}>
                                    <Caption1 className={styles.navGroupHeader}>{group.label}</Caption1>
                                    <TabList
                                        vertical
                                        selectedValue={selectedCategory as TabValue}
                                        onTabSelect={onTabSelect}
                                        className={styles.desktopTabList}
                                    >
                                        {group.categories.map((category) => (
                                            <Tab key={category.value} value={category.value} id={`settings-tab-${category.value}`}>
                                                {category.label}
                                            </Tab>
                                        ))}
                                    </TabList>
                                </div>
                            ))}
                        </div>
                    </div>
                </nav>

                <div
                    className={styles.panel}
                    data-testid="settings-sections"
                    role="region"
                    aria-label={selectedCategoryLabel}
                >
                    {renderCategoryPanel(selectedCategory)}
                </div>
            </div>
        </div>
    );
};

export default SettingsPage;
