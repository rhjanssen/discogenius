import {
    Button,
    Menu,
    MenuItemRadio,
    MenuList,
    MenuPopover,
    MenuTrigger,
    Spinner,
    Nav,
    NavItem,
    Title2,
    makeStyles,
    tokens,
    type OnNavItemSelectData,
} from "@fluentui/react-components";
import {
    ChevronDown24Regular,
    ChevronDown24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { useProviderConnection } from "@/hooks/useProviderConnection";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useAppAuth } from "@/providers/appAuthContext";
import { useTheme } from "@/providers/themeContext";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { ErrorState } from "@/components/ui/ContentState";
import { appBarHeightCssVariable, pageInsetTopDesktop } from "@/components/ui/sharedLayoutStyles";
import { AppearanceSettingsSection } from "@/pages/settings/AppearanceSettingsSection";
import { AudioQualitySettingsSection } from "@/pages/settings/AudioQualitySettingsSection";
import { AboutSettingsSection } from "@/pages/settings/AboutSettingsSection";
import { CurationSettingsSection } from "@/pages/settings/CurationSettingsSection";
import { MetadataFilesSettingsSection } from "@/pages/settings/MetadataFilesSettingsSection";
import { MetadataSourceSettingsSection } from "@/pages/settings/MetadataSourceSettingsSection";
import { MonitoringSettingsSection } from "@/pages/settings/MonitoringSettingsSection";
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

const ChevronDown24 = bundleIcon(ChevronDown24Filled, ChevronDown24Regular);

const MIN_RUN_NOW_FEEDBACK_MS = 600;
/** Ignore scroll-spy updates briefly after a nav click so a smooth scroll past
 *  intermediate sections doesn't flicker the active item. */
const PROGRAMMATIC_SCROLL_GRACE_MS = 700;

/** Fluent 2 breakpoints: stack below x-large, side-by-side nav + panel at ≥1024. */
const MEDIA = {
    mobile: "@media (max-width: 639px)",
    desktop: "@media (min-width: 1024px)",
};

/** Ordered scroll-spy sections. `id` matches each section's anchor element id. */
const SECTIONS: Array<{ id: string; label: string }> = [
    { id: "media-management", label: "Media Management" },
    { id: "metadata", label: "Metadata" },
    { id: "metadata-source", label: "Metadata Source" },
    { id: "audio-quality", label: "Audio" },
    { id: "music-videos", label: "Music Videos" },
    { id: "curation", label: "Filters" },
    { id: "monitoring", label: "Monitoring" },
    { id: "streaming-providers", label: "Providers" },
    { id: "appearance", label: "Appearance" },
    { id: "about", label: "About" },
];

const DEFAULT_SECTION = SECTIONS[0].id;

function sectionFromHash(hash: string): string | null {
    const raw = hash.replace(/^#/, "").trim();
    return SECTIONS.some((section) => section.id === raw) ? raw : null;
}

const useStyles = makeStyles({
    container: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        padding: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM}`,
        maxWidth: "1120px",
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
        [MEDIA.mobile]: {
            padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS}`,
            gap: tokens.spacingVerticalS,
        },
    },
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
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalS,
        flexShrink: 0,
        minWidth: 0,
        // Narrow layouts use a plain page heading + category control, not a
        // second framed app bar beneath the primary navigation.
        position: "static",
        backgroundColor: "transparent",
        [MEDIA.desktop]: {
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "flex-start",
            gap: tokens.spacingVerticalS,
            width: "240px",
            alignSelf: "flex-start",
            position: "sticky",
            paddingTop: tokens.spacingVerticalNone,
            top: `calc(var(${appBarHeightCssVariable}, 48px) + ${pageInsetTopDesktop})`,
            maxHeight: `calc(100dvh - var(${appBarHeightCssVariable}, 48px) - ${pageInsetTopDesktop} - ${tokens.spacingVerticalM})`,
            overflowY: "auto",
            overflowX: "clip",
        },
    },
    navTitle: {
        minWidth: 0,
        [MEDIA.desktop]: {
            paddingLeft: tokens.spacingHorizontalS,
        },
    },
    mobileNav: {
        display: "block",
        flex: "0 1 auto",
        minWidth: 0,
        [MEDIA.desktop]: { display: "none" },
    },
    mobileNavButton: {
        maxWidth: "100%",
        backgroundColor: "transparent",
        boxShadow: "none",
        minHeight: "40px",
        "& .fui-Button__content": {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
        },
    },
    desktopNav: {
        display: "none",
        [MEDIA.desktop]: { display: "block", width: "100%" },
        // Fluent Nav uses colorNeutralBackground4 for every item by default.
        // Settings sits directly over the page hero, so keep the resting list
        // transparent while retaining Fluent's interaction-state feedback.
        "& .fui-NavItem": {
            backgroundColor: tokens.colorTransparentBackground,
        },
        "& .fui-NavItem:hover": {
            backgroundColor: tokens.colorSubtleBackgroundHover,
        },
        "& .fui-NavItem:active": {
            backgroundColor: tokens.colorSubtleBackgroundPressed,
        },
    },
    panel: {
        flex: "1 1 auto",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXL,
        maxWidth: "820px",
        width: "100%",
    },
    loadingState: {
        paddingTop: tokens.spacingVerticalXXXL,
        paddingBottom: tokens.spacingVerticalXXXL,
        textAlign: "center",
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
    const [activeSection, setActiveSection] = useState<string>(() => {
        if (typeof window === "undefined") return DEFAULT_SECTION;
        return sectionFromHash(window.location.hash) ?? DEFAULT_SECTION;
    });
    const programmaticScrollUntilRef = useRef(0);

    const activeSectionLabel = useMemo(
        () => SECTIONS.find((section) => section.id === activeSection)?.label ?? "Settings",
        [activeSection],
    );

    const contentReady = !loading && !providerLoading && !providersLoading && Boolean(qualitySettings);

    const scrollToSection = useCallback((id: string) => {
        setActiveSection(id);
        programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
        if (typeof window !== "undefined") {
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
            document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }, []);

    // Scroll-spy: highlight the section nearest the top of the viewport.
    useEffect(() => {
        if (!contentReady) return;
        const elements = SECTIONS
            .map((section) => document.getElementById(section.id))
            .filter((element): element is HTMLElement => element !== null);

        const observer = new IntersectionObserver(
            (entries) => {
                if (Date.now() < programmaticScrollUntilRef.current) return;
                const visible = entries.filter((entry) => entry.isIntersecting);
                if (visible.length === 0) return;
                const topmost = visible.reduce((closest, entry) => (
                    entry.boundingClientRect.top < closest.boundingClientRect.top ? entry : closest
                ));
                setActiveSection(topmost.target.id);
            },
            { rootMargin: "-80px 0px -55% 0px", threshold: 0 },
        );

        elements.forEach((element) => observer.observe(element));
        return () => observer.disconnect();
    }, [contentReady]);

    // Honor a deep-link hash once the sections have mounted.
    useEffect(() => {
        if (!contentReady) return;
        const hashSection = sectionFromHash(window.location.hash);
        if (hashSection) {
            programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
            document.getElementById(hashSection)?.scrollIntoView({ block: "start" });
        }
    }, [contentReady]);

    // Match Library: default chromatic wash, not the artist/album UltraBlur.
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
            .then((info) => { if (active) setReleaseInfo(info); })
            .catch((error) => console.error("Error fetching release info:", error));
        return () => { active = false; };
    }, []);

    const fetchConfigs = async () => {
        try {
            const [monStatus, curation, catalog] = await Promise.all([
                api.getMonitoringStatus(),
                api.getCurationConfig(),
                api.getCatalogConfig(),
            ]);
            setMonitoringConfig(monStatus.config);
            setMonitoringStatus({ running: monStatus.running, checking: monStatus.checking });
            setCurationConfig(curation);
            setCatalogConfig(catalog);
        } catch (error) {
            console.error("Error fetching configs:", error);
            setMonitoringConfig({ enabled: false, monitorNewArtists: false, removeUnmonitoredFiles: false });
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
                include_field_recording: true,
                include_spokenword: false,
                include_interview: false,
                include_audiobook: false,
                include_audio_drama: false,
                include_status_official: true,
                include_status_promotion: false,
                include_status_bootleg: false,
                include_status_pseudo_release: false,
                include_status_withdrawn: false,
                include_status_cancelled: false,
                include_status_expunged: false,
                include_spatial: false,
                include_videos: false,
                include_video_official: true,
                include_video_lyric: false,
                include_video_live: true,
                include_video_visualizer: false,
                include_video_official_audio: false,
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
            toast({ title: "Error", description: "Failed to update monitoring configuration.", variant: "destructive" });
        }
    };

    const updateCuration = async (updates: Partial<FilteringConfigContract>) => {
        try {
            await api.updateCurationConfig(updates);
            setCurationConfig((current) => (current ? { ...current, ...updates } : current));
        } catch (error) {
            console.error("Error updating curation config:", error);
            toast({ title: "Error", description: "Failed to update curation configuration.", variant: "destructive" });
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
            toast({ title: "Error", description: "Failed to update metadata source.", variant: "destructive" });
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
            toast({ title: "Curation failed", description: "Could not queue library-wide curation.", variant: "destructive" });
        } finally {
            setSearchingMissingAlbums(false);
        }
    };

    const handleRunMonitoringNow = async () => {
        const startedAt = Date.now();
        setCheckingNow(true);
        dispatchActivityRefresh();
        try {
            const result: any = await api.triggerAllMonitoring();
            dispatchActivityRefresh();
            await fetchConfigs();
            toast({ title: "Monitoring cycle queued", description: result?.message || "The monitoring cycle has been queued." });
        } catch (error) {
            console.error("Error triggering monitoring:", error);
            toast({ title: "Error", description: "Failed to queue the monitoring cycle.", variant: "destructive" });
        } finally {
            const elapsed = Date.now() - startedAt;
            if (elapsed < MIN_RUN_NOW_FEEDBACK_MS) {
                await new Promise((resolve) => window.setTimeout(resolve, MIN_RUN_NOW_FEEDBACK_MS - elapsed));
            }
            setCheckingNow(false);
        }
    };

    const handleSignOut = () => {
        signOut();
        navigate("/login");
    };

    const onNavItemSelect = (_event: unknown, data: OnNavItemSelectData) => {
        scrollToSection(String(data.value));
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

    const isScanInProgress = Boolean(checkingNow || monitoringStatus.checking || monitoringConfig?.checkInProgress);

    return (
        <div className={styles.container}>
            <div className={styles.layout} data-testid="settings-layout">
                <nav className={styles.nav} aria-label="Settings sections">
                    <Title2 as="h1" className={styles.navTitle}>Settings</Title2>

                    <div className={styles.mobileNav}>
                        <Menu checkedValues={{ section: [activeSection] }}>
                            <MenuTrigger disableButtonEnhancement>
                                <Button
                                    appearance="subtle"
                                    icon={<ChevronDown24 />}
                                    iconPosition="after"
                                    className={styles.mobileNavButton}
                                    data-testid="settings-category-menu"
                                >
                                    {activeSectionLabel}
                                </Button>
                            </MenuTrigger>
                            <MenuPopover>
                                <MenuList>
                                    {SECTIONS.map((section) => (
                                        <MenuItemRadio
                                            key={section.id}
                                            name="section"
                                            value={section.id}
                                            onClick={() => scrollToSection(section.id)}
                                        >
                                            {section.label}
                                        </MenuItemRadio>
                                    ))}
                                </MenuList>
                            </MenuPopover>
                        </Menu>
                    </div>

                    <div className={styles.desktopNav} data-testid="settings-category-nav">
                        <Nav
                            selectedValue={activeSection}
                            onNavItemSelect={onNavItemSelect}
                        >
                            {SECTIONS.map((section) => (
                                <NavItem key={section.id} value={section.id} id={`settings-nav-${section.id}`}>
                                    {section.label}
                                </NavItem>
                            ))}
                        </Nav>
                    </div>
                </nav>

                <div className={styles.panel} data-testid="settings-sections">
                    <NamingSettingsSection
                        pathSettings={pathSettings}
                        updatePathSettings={updatePathSettings}
                        namingSettings={namingSettings}
                        updateNamingSettings={updateNamingSettings}
                    />
                    <MetadataFilesSettingsSection
                        metadataSettings={metadataSettings}
                        updateMetadataSettings={updateMetadataSettings}
                        embedCover={qualitySettings?.embed_cover !== false}
                        onEmbedCoverChange={(embed_cover) => updateQualitySettings({ embed_cover })}
                    />
                    <MetadataSourceSettingsSection
                        catalogConfig={catalogConfig}
                        catalogTest={catalogTest}
                        onUpdateCatalog={updateCatalog}
                        onHostChange={(host) => setCatalogConfig((current) => (current ? { ...current, musicbrainz_host: host } : current))}
                        onTestConnection={testCatalogConnection}
                    />
                    <AudioQualitySettingsSection
                        audioQuality={qualitySettings?.audio_quality || "max"}
                        includeSpatial={curationConfig?.include_spatial === true}
                        onAudioQualityChange={(audio_quality) => updateQualitySettings({ audio_quality })}
                        onIncludeSpatialChange={(include_spatial) => updateCuration({ include_spatial })}
                    />
                    <MusicVideosSettingsSection
                        curationConfig={curationConfig}
                        videoQuality={qualitySettings?.video_quality || "uhd"}
                        videoFolderLayout={pathSettings?.video_folder_layout || "separated"}
                        onUpdateCuration={updateCuration}
                        onVideoQualityChange={(video_quality) => updateQualitySettings({ video_quality })}
                        onVideoFolderLayoutChange={(video_folder_layout) => updatePathSettings({ video_folder_layout })}
                    />
                    <CurationSettingsSection
                        curationConfig={curationConfig}
                        updating={searchingMissingAlbums}
                        onUpdate={updateCuration}
                        onQueueCuration={handleQueueCuration}
                    />
                    <MonitoringSettingsSection
                        monitoringConfig={monitoringConfig}
                        upgradeExistingFiles={qualitySettings?.upgrade_existing_files ?? false}
                        downconvertExistingFiles={qualitySettings?.downconvert_existing_files ?? false}
                        isScanInProgress={isScanInProgress}
                        onUpdateMonitoring={updateMonitoring}
                        onUpgradeExistingFilesChange={(upgrade_existing_files) => updateQualitySettings({ upgrade_existing_files })}
                        onDownconvertExistingFilesChange={(downconvert_existing_files) => updateQualitySettings({ downconvert_existing_files })}
                        onRunNow={handleRunMonitoringNow}
                    />
                    <ProvidersSettingsSection
                        providers={streamingProviders?.providers ?? []}
                        loadFailed={providersLoadFailed}
                        loadError={providersLoadError}
                        fetching={providersFetching}
                        loading={providersLoading}
                        onRefetch={refetchStreamingProviders}
                    />
                    <AppearanceSettingsSection
                        theme={theme}
                        onThemeChange={setTheme}
                    />
                    <AboutSettingsSection
                        appVersion={appVersion}
                        releaseInfo={releaseInfo}
                        isAuthActive={isAuthActive}
                        onSignOut={handleSignOut}
                    />
                </div>
            </div>
        </div>
    );
};

export default SettingsPage;
