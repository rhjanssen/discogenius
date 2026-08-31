import {
    Badge,
    Button,
    Caption1,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Spinner,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    ArrowImport24Regular,
    ArrowSync24Regular,
    ChevronDown24Regular,
    ChevronUp24Regular,
    DoorArrowLeft24Regular,
    Open24Regular,
    ArrowImport24Filled,
    ArrowSync24Filled,
    ChevronDown24Filled,
    ChevronUp24Filled,
    DoorArrowLeft24Filled,
    Open24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { ErrorState } from "@/components/ui/ContentState";
import { ImportArtistsModal } from "@/components/ui/ImportArtistsModal";
import { ProviderMark } from "@/components/ui/ProviderMark";
import { providerMarkFor } from "@/components/ui/providerMarks";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { useToast } from "@/hooks/useToast";
import { api, type StreamingProviderStatus } from "@/services/api";
import { dispatchActivityRefresh } from "@/utils/appEvents";
import { videoCapabilityLabel, videoTierFromMaxHeight } from "@/utils/qualityTier";
import {
    dropConnectedProviderOn,
    reorderConnectedProviderIds,
} from "./providerPriority";

const ArrowImport24 = bundleIcon(ArrowImport24Filled, ArrowImport24Regular);
const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);
const Open24 = bundleIcon(Open24Filled, Open24Regular);
const DoorArrowLeft24 = bundleIcon(DoorArrowLeft24Filled, DoorArrowLeft24Regular);
const ChevronDown24 = bundleIcon(ChevronDown24Filled, ChevronDown24Regular);
const ChevronUp24 = bundleIcon(ChevronUp24Filled, ChevronUp24Regular);

export interface ProvidersSettingsSectionProps {
    providers: StreamingProviderStatus[];
    loadFailed: boolean;
    loadError: unknown;
    fetching: boolean;
    loading: boolean;
    onRefetch: () => void | Promise<unknown>;
}

const MEDIA = { mobile: "@media (max-width: 720px)" };

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    // Identity (left) fills the row so capabilities + actions right-align — no
    // stranded buttons clustered next to the name on a wide card.
    providerRow: {
        display: "flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalL,
        rowGap: tokens.spacingVerticalS,
        flexWrap: "wrap",
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-of-type": { borderBottom: "none" },
        [MEDIA.mobile]: {
            columnGap: tokens.spacingHorizontalS,
            padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
        },
    },
    identity: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        flex: "1 1 320px",
        minWidth: 0,
    },
    reorderColumn: {
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
    },
    iconBox: {
        width: "36px",
        height: "36px",
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
    },
    identityDetails: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        flex: "1 1 auto",
        minWidth: 0,
    },
    identityHeading: {
        display: "flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalS,
        rowGap: tokens.spacingVerticalXS,
        flexWrap: "wrap",
        minWidth: 0,
    },
    nameRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        minWidth: 0,
    },
    // Keep quality with the provider name. The heading wraps the badges below
    // only when the identity itself is too narrow.
    capabilities: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
        flex: "0 1 auto",
    },
    capabilityPlaceholder: {
        color: tokens.colorNeutralForeground3,
    },
    actions: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        flex: "0 0 auto",
        marginLeft: "auto",
        flexWrap: "wrap",
        [MEDIA.mobile]: {
            marginLeft: 0,
            flex: "1 1 100%",
            paddingLeft: "48px",
        },
    },
    actionButton: {
        minHeight: "34px",
    },
    addRow: {
        display: "flex",
        justifyContent: "center",
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    },
    emptyState: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: tokens.spacingVerticalM,
        textAlign: "center",
        padding: "32px 16px",
    },
    mutedText: { color: tokens.colorNeutralForeground2 },
    mutedTextBlock: { color: tokens.colorNeutralForeground2, display: "block" },
});

type ProviderCapability = { label: string; badgeQuality: string | null; caption: string };

const getProviderCapabilitySummary = (provider: StreamingProviderStatus): ProviderCapability[] => {
    const caps = provider.capabilities;

    const stereoBadge = caps.hiResStereo
        ? "HIRES_LOSSLESS"
        : caps.losslessStereo
            ? "LOSSLESS"
            : caps.lossyStereo
                ? (provider.id === "youtube-music"
                    ? "YOUTUBE_LOSSY"
                    : provider.id === "soundcloud"
                        ? "SOUNDCLOUD_LOSSY"
                        : "MP3_320")
                : null;
    const spatialBadge = caps.spatialAudio
        ? (caps.spatialFormats?.includes("DOLBY_ATMOS") ? "DOLBY_ATMOS" : "SPATIAL")
        : null;
    const videoTier = videoTierFromMaxHeight(caps.maxVideoResolution);
    const videoBadge = videoTier === "UHD"
        ? "MP4_2160P"
        : videoTier === "FHD"
            ? "MP4_1080P"
            : videoTier === "HD"
                ? "MP4_720P"
                : videoTier === "SD"
                    ? "MP4_480P"
                    : null;

    return [
        { label: "Stereo", badgeQuality: stereoBadge, caption: caps.stereoQuality ?? (stereoBadge ? "" : "Not available") },
        { label: "Spatial", badgeQuality: spatialBadge, caption: caps.spatialQuality ?? (spatialBadge ? "Dolby Atmos" : "Not available") },
        { label: "Video", badgeQuality: videoBadge, caption: caps.videoQuality ?? videoCapabilityLabel(caps.maxVideoResolution) },
    ];
};

export const ProvidersSettingsSection = ({
    providers,
    loadFailed,
    loadError,
    fetching,
    loading,
    onRefetch,
}: ProvidersSettingsSectionProps) => {
    const styles = useStyles();
    const navigate = useNavigate();
    const { toast } = useToast();
    const [importProviderId, setImportProviderId] = useState<string | null>(null);
    const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
    const [savingProviderOrder, setSavingProviderOrder] = useState(false);
    const [disconnectTarget, setDisconnectTarget] = useState<{
        id: string;
        name: string;
    } | null>(null);
    const [disconnectingProviderId, setDisconnectingProviderId] = useState<string | null>(null);

    const openProviderAuth = () => navigate("/auth", {
        state: { mode: "add-provider", from: { pathname: "/settings" } },
    });

    const handleDisconnectProvider = async (providerId: string, providerName: string) => {
        setDisconnectingProviderId(providerId);
        try {
            await api.logoutProvider(providerId);
            await onRefetch();
            setDisconnectTarget(null);
            toast({
                title: `${providerName} disconnected`,
                description: "Availability, previews, followed artists, and downloads are disabled until you reconnect.",
            });
        } catch (error) {
            console.error(`Error disconnecting ${providerName}:`, error);
            toast({
                title: "Disconnect failed",
                description: error instanceof Error ? error.message : `Could not disconnect ${providerName}.`,
                variant: "destructive",
            });
        } finally {
            setDisconnectingProviderId(null);
        }
    };

    const handleImportComplete = () => {
        dispatchActivityRefresh();
        toast({ title: "Import complete", description: "The artist list has been refreshed." });
    };

    // The list order IS the provider preference: first = default provider and the
    // winner of equal-quality matching tie-breaks.
    const persistProviderOrder = async (orderedIds: string[]) => {
        setSavingProviderOrder(true);
        try {
            await api.updateProviderPriority(orderedIds);
            dispatchActivityRefresh();
            await onRefetch();
        } catch (error: any) {
            toast({
                title: "Failed to reorder providers",
                description: error?.message || "Please try again",
                variant: "destructive",
            });
        } finally {
            setSavingProviderOrder(false);
        }
    };

    const moveProvider = (providerId: string, direction: -1 | 1) => {
        const ids = reorderConnectedProviderIds(providers, providerId, direction);
        if (ids) void persistProviderOrder(ids);
    };

    const dropProviderOn = (targetProviderId: string) => {
        if (!draggingProviderId || draggingProviderId === targetProviderId) {
            setDraggingProviderId(null);
            return;
        }
        const ids = dropConnectedProviderOn(providers, draggingProviderId, targetProviderId);
        setDraggingProviderId(null);
        if (!ids) return;
        void persistProviderOrder(ids);
    };

    const activeProviders = providers.filter((provider) => provider.authenticated);
    const reorderable = activeProviders.length > 1;

    const renderProviderRow = (provider: StreamingProviderStatus, index: number) => {
        const hasMark = Boolean(providerMarkFor(provider.id));
        const capabilities = getProviderCapabilitySummary(provider);
        const availableCapabilities = capabilities.filter((capability) => capability.badgeQuality);

        return (
            <div
                key={provider.id}
                className={styles.providerRow}
                role="group"
                aria-label={`${provider.name} provider`}
                draggable={reorderable && !savingProviderOrder}
                onDragStart={() => setDraggingProviderId(provider.id)}
                onDragEnd={() => setDraggingProviderId(null)}
                onDragOver={(event) => { if (draggingProviderId) event.preventDefault(); }}
                onDrop={() => dropProviderOn(provider.id)}
                style={draggingProviderId === provider.id ? { opacity: 0.5 } : undefined}
            >
                <div className={styles.identity}>
                    {reorderable ? (
                        <div className={styles.reorderColumn} role="group" aria-label={`Reorder ${provider.name}`}>
                            <Button
                                appearance="subtle"
                                size="small"
                                icon={<ChevronUp24 />}
                                aria-label={`Move ${provider.name} up`}
                                disabled={savingProviderOrder || index === 0}
                                onClick={() => moveProvider(provider.id, -1)}
                            />
                            <Button
                                appearance="subtle"
                                size="small"
                                icon={<ChevronDown24 />}
                                aria-label={`Move ${provider.name} down`}
                                disabled={savingProviderOrder || index === activeProviders.length - 1}
                                onClick={() => moveProvider(provider.id, 1)}
                            />
                        </div>
                    ) : null}
                    <div className={styles.iconBox}>
                        {hasMark ? (
                            <ProviderMark provider={provider.id} size={28} />
                        ) : (
                            <Text weight="semibold">{provider.name.slice(0, 1)}</Text>
                        )}
                    </div>
                    <div className={styles.identityDetails}>
                        <div className={styles.identityHeading}>
                            <div className={styles.nameRow}>
                                <Text weight="semibold" size={400}>{provider.name}</Text>
                                {provider.isDefault ? (
                                    <Badge appearance="tint" color="informative">Default</Badge>
                                ) : null}
                            </div>
                            <div className={styles.capabilities}>
                                {availableCapabilities.length > 0 ? (
                                    availableCapabilities.map((capability) => (
                                        <AppTooltip
                                            key={capability.label}
                                            relationship="description"
                                            withArrow
                                            content={`${capability.label}: ${capability.caption || capability.badgeQuality}`}
                                        >
                                            <span style={{ display: "inline-flex" }}>
                                                <QualityBadge quality={String(capability.badgeQuality)} size="small" showTooltip={false} />
                                            </span>
                                        </AppTooltip>
                                    ))
                                ) : (
                                    <Caption1 className={styles.capabilityPlaceholder}>No download tiers</Caption1>
                                )}
                            </div>
                        </div>
                        <Caption1 className={styles.mutedText}>
                            {index === 0 && reorderable ? "First priority" : "Connected"}
                        </Caption1>
                    </div>
                </div>

                <div className={styles.actions}>
                    {provider.management.canImportArtists ? (
                        <Button
                            appearance="outline"
                            className={styles.actionButton}
                            icon={<ArrowImport24 />}
                            onClick={() => setImportProviderId(provider.id)}
                        >
                            Import artists
                        </Button>
                    ) : null}
                    {provider.management.canDisconnect ? (
                        <Button
                            appearance="subtle"
                            className={styles.actionButton}
                            icon={<DoorArrowLeft24 />}
                            disabled={disconnectingProviderId !== null}
                            onClick={() => setDisconnectTarget({ id: provider.id, name: provider.name })}
                        >
                            Disconnect
                        </Button>
                    ) : null}
                </div>
            </div>
        );
    };

    return (
        <>
            <SettingsSection
                id="streaming-providers"
                title="Providers"
                description="Drag or use the arrows to order equal-quality matches and fallbacks. Discogenius chooses complete, higher-quality audio and higher-resolution video first; the top provider is also the default for provider metadata and manual lookups."
                className={styles.section}
            >
                <SettingsCard>
                    {loadFailed ? (
                        <ErrorState
                            minHeight="220px"
                            title="Streaming providers unavailable"
                            error={loadError instanceof Error ? loadError : "Discogenius could not load the provider registry."}
                            actions={(
                                <Button
                                    appearance="outline"
                                    icon={fetching ? <Spinner size="tiny" /> : <ArrowSync24 />}
                                    disabled={fetching}
                                    onClick={() => { void onRefetch(); }}
                                >
                                    Retry
                                </Button>
                            )}
                        />
                    ) : activeProviders.length === 0 && !loading ? (
                        <div className={styles.emptyState}>
                            <div>
                                <Text weight="semibold" size={400} block style={{ marginBottom: "4px" }}>
                                    No provider connected
                                </Text>
                                <Caption1 className={styles.mutedTextBlock}>
                                    Connect a streaming service to enable downloads and metadata features.
                                </Caption1>
                            </div>
                            <Button appearance="primary" onClick={openProviderAuth} size="large" icon={<Open24 />}>
                                Add provider
                            </Button>
                        </div>
                    ) : (
                        <>
                            {activeProviders.map(renderProviderRow)}
                            <div className={styles.addRow}>
                                <Button appearance="outline" icon={<Open24 />} onClick={openProviderAuth}>
                                    Add provider
                                </Button>
                            </div>
                        </>
                    )}
                </SettingsCard>
            </SettingsSection>

            <Dialog
                open={disconnectTarget !== null}
                onOpenChange={(_, data) => {
                    if (!data.open && !disconnectingProviderId) setDisconnectTarget(null);
                }}
            >
                <DialogSurface>
                    <DialogBody>
                        <DialogTitle>
                            Disconnect {disconnectTarget?.name || "provider"}?
                        </DialogTitle>
                        <DialogContent>
                            This removes its saved credentials and disables its availability checks,
                            previews, imports, and downloads. Existing library files and catalog matches
                            are kept.
                        </DialogContent>
                        <DialogActions>
                            <Button
                                appearance="secondary"
                                disabled={disconnectingProviderId !== null}
                                onClick={() => setDisconnectTarget(null)}
                            >
                                Cancel
                            </Button>
                            <Button
                                appearance="primary"
                                disabled={!disconnectTarget || disconnectingProviderId !== null}
                                onClick={() => {
                                    if (disconnectTarget) {
                                        void handleDisconnectProvider(disconnectTarget.id, disconnectTarget.name);
                                    }
                                }}
                            >
                                {disconnectingProviderId ? "Disconnecting…" : "Disconnect"}
                            </Button>
                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>

            <ImportArtistsModal
                open={Boolean(importProviderId)}
                onClose={() => setImportProviderId(null)}
                providerId={importProviderId}
                onImported={handleImportComplete}
            />
        </>
    );
};

export default ProvidersSettingsSection;
