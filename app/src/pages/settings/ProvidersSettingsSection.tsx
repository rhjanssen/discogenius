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
    Link,
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
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
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

const DoorArrowLeft24 = bundleIcon(DoorArrowLeft24Filled, DoorArrowLeft24Regular);
const ArrowImport24 = bundleIcon(ArrowImport24Filled, ArrowImport24Regular);
const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);
const Open24 = bundleIcon(Open24Filled, Open24Regular);
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

const MEDIA = {
    mobile: "@media (max-width: 640px)",
};

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        breakInside: "avoid",
        WebkitColumnBreakInside: "avoid",
        pageBreakInside: "avoid",
        marginBottom: tokens.spacingVerticalM,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    card: {
        ...glassSurfaceStyles,
        borderRadius: tokens.borderRadiusMedium,
        padding: tokens.spacingVerticalNone,
        overflow: "hidden",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    profileRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        flexWrap: "wrap",
        columnGap: tokens.spacingHorizontalM,
        rowGap: tokens.spacingVerticalS,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        [MEDIA.mobile]: {
            columnGap: tokens.spacingHorizontalS,
            rowGap: tokens.spacingVerticalS,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
        },
    },
    profileDetails: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        flex: 1,
    },
    profileActions: {
        display: "flex",
        justifyContent: "flex-end",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
        marginLeft: "auto",
        flexShrink: 0,
    },
    providerStatusRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        flex: 1,
        minWidth: "220px",
    },
    providerIconBox: {
        width: "48px",
        height: "48px",
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
    },
    capabilitySummaryGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(140px, 1fr))",
        gap: tokens.spacingHorizontalS,
        width: "100%",
        [MEDIA.mobile]: {
            gridTemplateColumns: "1fr",
        },
    },
    capabilitySummaryItem: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground2,
        minWidth: 0,
    },
    capabilitySummaryValue: {
        fontWeight: tokens.fontWeightSemibold,
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        minHeight: "22px",
    },
    capabilitySectionHeader: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
    },
    signOutButton: {
        minHeight: "36px",
        [MEDIA.mobile]: {
            minHeight: "40px",
        },
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    mutedTextBlock: {
        color: tokens.colorNeutralForeground2,
        display: "block",
    },
    optionIconRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
    },
});

const reorderConnectedProviderIds = (
    providers: Array<Pick<StreamingProviderStatus, "id" | "authenticated">>,
    providerId: string,
    direction: -1 | 1,
): string[] | null => {
    const connectedIds = providers
        .filter((provider) => provider.authenticated)
        .map((provider) => provider.id);
    const connectedIndex = connectedIds.indexOf(providerId);
    const targetProviderId = connectedIds[connectedIndex + direction];
    if (connectedIndex === -1 || !targetProviderId) return null;

    const ids = providers.map((provider) => provider.id);
    const from = ids.indexOf(providerId);
    const to = ids.indexOf(targetProviderId);
    const fromId = ids[from];
    const toId = ids[to];
    if (!fromId || !toId) return null;
    ids[from] = toId;
    ids[to] = fromId;
    return ids;
};

const getProviderCapabilitySummary = (provider: StreamingProviderStatus) => {
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

    const stereoCaption = caps.stereoQuality
        ?? (stereoBadge ? undefined : "Not available");
    const spatialCaption = caps.spatialQuality
        ?? (spatialBadge ? "Dolby Atmos" : "Not available");
    const videoCaption = caps.videoQuality
        ?? videoCapabilityLabel(caps.maxVideoResolution);

    return [
        { label: "Stereo quality", badgeQuality: stereoBadge, caption: stereoCaption || "Not available" },
        { label: "Spatial audio", badgeQuality: spatialBadge, caption: spatialCaption },
        { label: "Music video", badgeQuality: videoBadge, caption: videoCaption },
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
    const [detailsProviderId, setDetailsProviderId] = useState<string | null>(null);
    const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
    const [savingProviderOrder, setSavingProviderOrder] = useState(false);

    const openProviderAuth = () => navigate("/auth", {
        state: { mode: "add-provider", from: { pathname: "/settings" } },
    });

    const handleDisconnectProvider = async (providerId: string, providerName: string) => {
        try {
            await api.logoutProvider(providerId);
            await onRefetch();
            toast({
                title: `${providerName} disconnected`,
                description: "Provider availability, previews, followed artists, and downloads are disabled until you reconnect.",
            });
        } catch (error) {
            console.error(`Error disconnecting ${providerName}:`, error);
            toast({
                title: "Disconnect failed",
                description: error instanceof Error ? error.message : `Could not disconnect ${providerName}.`,
                variant: "destructive",
            });
        }
    };

    const handleImportComplete = () => {
        dispatchActivityRefresh();
        toast({
            title: "Import complete",
            description: "The artist list has been refreshed.",
        });
    };

    // The list order IS the provider preference: first = default provider and
    // the winner of equal-quality matching tie-breaks.
    const persistProviderOrder = async (orderedIds: string[]) => {
        setSavingProviderOrder(true);
        try {
            await api.updateProviderPriority(orderedIds);
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
        // Swap the two connected providers in their full registry slots. This
        // keeps every disconnected provider in the persisted priority list
        // while still making one button press visibly move by one connected row.
        const ids = reorderConnectedProviderIds(providers, providerId, direction);
        if (!ids) return;
        void persistProviderOrder(ids);
    };

    const dropProviderOn = (targetProviderId: string) => {
        if (!draggingProviderId || draggingProviderId === targetProviderId) {
            setDraggingProviderId(null);
            return;
        }
        const ids = providers.map((provider) => provider.id);
        const from = ids.indexOf(draggingProviderId);
        const to = ids.indexOf(targetProviderId);
        setDraggingProviderId(null);
        if (from === -1 || to === -1) return;
        ids.splice(from, 1);
        ids.splice(to, 0, draggingProviderId);
        void persistProviderOrder(ids);
    };

    const detailsProvider = providers.find((provider) => provider.id === detailsProviderId) || null;
    const activeProviders = providers.filter((p) => p.authenticated);

    return (
        <>
            <SettingsSection
                id="streaming-providers"
                title="Streaming Providers"
                description="Connect download services. Drag to set preference — higher entries win when quality is equal."
                className={styles.section}
            >
                <div className={styles.card}>
                    {(() => {
                        // Only connected services get a row; everything else is
                        // reachable through the always-visible "Add Provider" flow.

                        if (loadFailed) {
                            return (
                                <ErrorState
                                    minHeight="220px"
                                    title="Streaming providers unavailable"
                                    error={loadError instanceof Error
                                        ? loadError
                                        : "Discogenius could not load the provider registry."}
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
                            );
                        }

                        if (activeProviders.length === 0 && !loading) {
                            return (
                                <div className={styles.profileRow} style={{ justifyContent: "center", padding: "32px 16px" }}>
                                    <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
                                        <div>
                                            <Text weight="semibold" size={400} block style={{ marginBottom: "4px" }}>
                                                No Provider Connected
                                            </Text>
                                            <Caption1 className={styles.mutedTextBlock}>
                                                Connect a streaming service to enable downloads and metadata features.
                                            </Caption1>
                                        </div>
                                        <Button
                                            appearance="primary"
                                            onClick={openProviderAuth}
                                            size="large"
                                            icon={<Open24 />}
                                        >
                                            Add Provider
                                        </Button>
                                    </div>
                                </div>
                            );
                        }

                        const reorderable = activeProviders.length > 1;

                        return (
                            <>
                                {activeProviders.map((provider, index) => {
                                    const hasMark = Boolean(providerMarkFor(provider.id));
                                    const publiclyAvailable = provider.authenticated
                                        && !provider.management.canAuthenticate
                                        && !provider.management.canDisconnect;

                                    return (
                                        <div
                                            key={provider.id}
                                            className={styles.profileRow}
                                            draggable={reorderable && !savingProviderOrder}
                                            onDragStart={() => setDraggingProviderId(provider.id)}
                                            onDragEnd={() => setDraggingProviderId(null)}
                                            onDragOver={(event) => { if (draggingProviderId) event.preventDefault(); }}
                                            onDrop={() => dropProviderOn(provider.id)}
                                            style={draggingProviderId === provider.id ? { opacity: 0.5 } : undefined}
                                        >
                                            <div className={styles.providerStatusRow}>
                                                {reorderable ? (
                                                    <div style={{ display: "flex", flexDirection: "column" }} aria-label={`Reorder ${provider.name}`}>
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
                                                <div className={styles.providerIconBox}>
                                                    {hasMark ? (
                                                        <ProviderMark provider={provider.id} size={30} />
                                                    ) : (
                                                        <Text weight="semibold">{provider.name.slice(0, 1)}</Text>
                                                    )}
                                                </div>
                                                <div className={styles.profileDetails}>
                                                    <div className={styles.optionIconRow}>
                                                        <Text weight="semibold" size={400}>{provider.name}</Text>
                                                        {provider.isDefault ? (
                                                            <Badge appearance="tint" color="informative">Default</Badge>
                                                        ) : null}
                                                    </div>
                                                    <Caption1 className={styles.mutedText}>
                                                        {publiclyAvailable
                                                            ? "Ready to search and browse."
                                                            : "Ready to search, browse, and download."}
                                                    </Caption1>
                                                </div>
                                            </div>
                                            <div className={styles.profileActions}>
                                                {provider.management.canImportArtists ? (
                                                    <Button
                                                        appearance="outline"
                                                        className={styles.signOutButton}
                                                        icon={<ArrowImport24 />}
                                                        onClick={() => setImportProviderId(provider.id)}
                                                        disabled={!provider.authenticated}
                                                    >
                                                        Import artists
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    appearance="subtle"
                                                    className={styles.signOutButton}
                                                    onClick={() => setDetailsProviderId(provider.id)}
                                                >
                                                    Details
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}
                                {activeProviders.length > 0 && (
                                    <div className={styles.profileRow} style={{ justifyContent: "center" }}>
                                        <Button
                                            appearance="outline"
                                            icon={<Open24 />}
                                            onClick={openProviderAuth}
                                        >
                                            Add Provider
                                        </Button>
                                    </div>
                                )}
                            </>
                        );
                    })()}
                </div>

                <Dialog open={detailsProvider !== null} onOpenChange={(_, data) => { if (!data.open) setDetailsProviderId(null); }}>
                    <DialogSurface>
                        <DialogBody>
                            <DialogTitle>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
                                    {detailsProvider && providerMarkFor(detailsProvider.id) ? (
                                        <ProviderMark provider={detailsProvider.id} size={24} />
                                    ) : null}
                                    {detailsProvider?.name}
                                </span>
                            </DialogTitle>
                            <DialogContent>
                                {detailsProvider ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                        <div className={styles.optionIconRow}>
                                            <Badge appearance="filled" color={detailsProvider.authenticated ? "success" : "subtle"}>
                                                {detailsProvider.authenticated ? "Connected" : "Not connected"}
                                            </Badge>
                                            {detailsProvider.isDefault ? (
                                                <Badge appearance="tint" color="informative">Default provider</Badge>
                                            ) : null}
                                        </div>
                                        <div className={styles.capabilitySectionHeader}>
                                            <Text weight="semibold">Supported capabilities</Text>
                                            <Caption1 className={styles.mutedText}>
                                                Read-only quality ceilings for this service — not user-configurable.
                                            </Caption1>
                                        </div>
                                        <div className={styles.capabilitySummaryGrid}>
                                            {getProviderCapabilitySummary(detailsProvider).map((capability) => (
                                                <div key={capability.label} className={styles.capabilitySummaryItem}>
                                                    <Caption1 className={styles.mutedText}>{capability.label}</Caption1>
                                                    <div className={styles.capabilitySummaryValue}>
                                                        {capability.badgeQuality ? (
                                                            <QualityBadge
                                                                quality={capability.badgeQuality}
                                                                size="large"
                                                                tooltip={capability.caption}
                                                            />
                                                        ) : (
                                                            <AppTooltip
                                                                content={capability.caption}
                                                                relationship="description"
                                                                withArrow
                                                            >
                                                                <span style={{ display: "inline-flex" }}>
                                                                    <Text size={200}>Not available</Text>
                                                                </span>
                                                            </AppTooltip>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <Text size={200} className={styles.mutedText}>
                                            For connection and download health, see{" "}
                                            <Link onClick={() => { setDetailsProviderId(null); navigate("/system/status"); }}>System Status</Link>.
                                        </Text>
                                    </div>
                                ) : null}
                            </DialogContent>
                            <DialogActions>
                                {detailsProvider?.management.canAuthenticate && !detailsProvider.authenticated ? (
                                    <Button appearance="primary" onClick={openProviderAuth}>Connect</Button>
                                ) : null}
                                {detailsProvider?.management.canDisconnect && detailsProvider.authenticated ? (
                                    <Button
                                        appearance="outline"
                                        icon={<DoorArrowLeft24 />}
                                        onClick={() => {
                                            setDetailsProviderId(null);
                                            void handleDisconnectProvider(detailsProvider.id, detailsProvider.name);
                                        }}
                                    >
                                        Disconnect
                                    </Button>
                                ) : null}
                                <Button appearance="secondary" onClick={() => setDetailsProviderId(null)}>Close</Button>
                            </DialogActions>
                        </DialogBody>
                    </DialogSurface>
                </Dialog>
            </SettingsSection>

            <ImportArtistsModal
                open={Boolean(importProviderId)}
                onClose={() => setImportProviderId(null)}
                providerId={importProviderId}
                onImported={handleImportComplete}
            />
        </>
    );
};
