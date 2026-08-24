import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Avatar,
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Field,
    ProgressBar,
    Spinner,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
  AppsList24Filled,
  AppsList24Regular,
  ArrowLeft24Filled,
  ArrowLeft24Regular,
  ChevronRight20Filled,
  ChevronRight20Regular,
  Clock24Regular,
  Heart24Filled,
  Heart24Regular,
  MusicNote224Filled,
  MusicNote224Regular,
  PeopleTeam24Filled,
  PeopleTeam24Regular,
  bundleIcon,
  Clock24Filled
} from "@fluentui/react-icons";
import { ProviderMark } from "@/components/ui/ProviderMark";
import { SemanticStatusIcon } from "@/components/ui/SemanticStatusIcon";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";
import { providerArtworkThumbnailUrl } from "@/utils/providerArtworkThumbnail";
import {
    api,
    type ImportPreviewArtist,
    type ImportSource,
    type ImportSourceList,
    type ImportStreamHandle,
    type StreamingProviderStatus,
} from "@/services/api";

const AppsList24 = bundleIcon(AppsList24Filled, AppsList24Regular);
const ArrowLeft24 = bundleIcon(ArrowLeft24Filled, ArrowLeft24Regular);
const ChevronRight20 = bundleIcon(ChevronRight20Filled, ChevronRight20Regular);
const Clock24 = bundleIcon(Clock24Filled, Clock24Regular);
const Heart24 = bundleIcon(Heart24Filled, Heart24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const PeopleTeam24 = bundleIcon(PeopleTeam24Filled, PeopleTeam24Regular);

interface ImportArtistsModalProps {
    open: boolean;
    onClose: () => void;
    /** Settings can open a provider directly; Library intentionally omits this to show the provider picker. */
    providerId?: string | null;
    onImported?: () => void;
}

type Phase = "select-provider" | "select-source" | "select-list" | "preview" | "running" | "done";
type ArtistResultStatus = "pending" | "running" | "succeeded" | "skipped" | "unmatched" | "failed";

interface ImportProgress {
    total: number;
    processed: number;
    added: number;
    monitoredExisting: number;
    skipped: number;
    unmatched: number;
    failed: number;
    currentName?: string;
    message?: string;
}

interface ImportProgressArtist extends ImportPreviewArtist {
    status: ArtistResultStatus;
    detail?: string;
}

const ArrowLeftIcon = ArrowLeft24;
const ChevronRightIcon = ChevronRight20;
const PeopleTeamIcon = PeopleTeam24;
const HeartIcon = Heart24;
const MusicNoteIcon = MusicNote224;
const AppsListIcon = AppsList24;

const CATEGORY_ICONS: Record<string, React.ReactElement> = {
    "library-artists": <PeopleTeamIcon />,
    "followed-artists": <PeopleTeamIcon />,
    "favorite-tracks": <HeartIcon />,
    playlist: <AppsListIcon />,
    mix: <MusicNoteIcon />,
};

const EMPTY_PROGRESS: ImportProgress = {
    total: 0,
    processed: 0,
    added: 0,
    monitoredExisting: 0,
    skipped: 0,
    unmatched: 0,
    failed: 0,
};

const ARTIST_RENDER_BATCH_SIZE = 60;

const getPreviewArtistId = (artist: ImportPreviewArtist) => artist.providerId;

const useStyles = makeStyles({
    surface: { maxWidth: "720px", width: "calc(100vw - 32px)", maxHeight: "88vh" },
    content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minHeight: "220px" },
    sourceRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        minHeight: "56px",
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        cursor: "pointer",
        textAlign: "left",
        background: tokens.colorNeutralBackground1,
        color: tokens.colorNeutralForeground1,
        width: "100%",
        "&:hover": { background: tokens.colorNeutralBackground1Hover },
        "&:disabled": { cursor: "not-allowed", opacity: 0.6 },
    },
    rowText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: tokens.spacingVerticalXXS },
    rowTitle: {
        fontWeight: tokens.fontWeightSemibold,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    rowSubtitle: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        overflow: "hidden",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        wordBreak: "break-word",
    },
    icon: { color: tokens.colorBrandForeground1, flexShrink: 0, alignSelf: "center" },
    thumb: { width: "40px", height: "40px", borderRadius: tokens.borderRadiusSmall, objectFit: "cover", flexShrink: 0, alignSelf: "center" },
    listScroll: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, overflowY: "auto", maxHeight: "52vh" },
    selectionToolbar: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground3,
    },
    artistRow: {
        display: "grid",
        gridTemplateColumns: "auto auto minmax(0, 1fr) auto",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    },
    statusCell: { display: "flex", alignItems: "center", justifyContent: "center", width: "24px", minWidth: "24px" },
    success: { color: tokens.colorPaletteGreenForeground2 },
    warning: { color: tokens.colorPaletteYellowForeground1 },
    error: { color: tokens.colorPaletteRedForeground2 },
    pending: { color: tokens.colorNeutralForeground3 },
    groupHeading: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingTop: tokens.spacingVerticalS,
    },
    progressMeta: { display: "flex", justifyContent: "space-between", gap: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
    counts: { display: "flex", gap: tokens.spacingHorizontalS, flexWrap: "wrap" },
    countBadge: { flexShrink: 0 },
    empty: { color: tokens.colorNeutralForeground3, textAlign: "center", padding: tokens.spacingVerticalXXL },
});

function statusIcon(status: ArtistResultStatus, styles: ReturnType<typeof useStyles>) {
    // Colored Fluent status icons match the queue/activity status icon family.
    switch (status) {
        case "running": return <Spinner size="extra-tiny" aria-label="Importing" />;
        case "succeeded": return <SemanticStatusIcon status="success" size={24} />;
        case "skipped": return <SemanticStatusIcon status="warning" size={24} />;
        case "unmatched": return <SemanticStatusIcon status="unknown" size={24} />;
        case "failed": return <SemanticStatusIcon status="error" size={24} />;
        default: return <Clock24 className={styles.pending} />;
    }
}

export const ImportArtistsModal: React.FC<ImportArtistsModalProps> = ({ open, onClose, providerId, onImported }) => {
    const styles = useStyles();
    const [phase, setPhase] = useState<Phase>(providerId ? "select-source" : "select-provider");
    const [providers, setProviders] = useState<StreamingProviderStatus[]>([]);
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(providerId || null);
    const [providerName, setProviderName] = useState<string | null>(null);
    const [sources, setSources] = useState<ImportSource[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [activeSource, setActiveSource] = useState<ImportSource | null>(null);
    const [activeList, setActiveList] = useState<ImportSourceList | null>(null);
    const [previewArtists, setPreviewArtists] = useState<ImportPreviewArtist[]>([]);
    const [progressArtists, setProgressArtists] = useState<ImportProgressArtist[]>([]);
    const [progress, setProgress] = useState<ImportProgress>(EMPTY_PROGRESS);
    const [runError, setRunError] = useState<string | null>(null);
    const [visibleArtistCount, setVisibleArtistCount] = useState(ARTIST_RENDER_BATCH_SIZE);
    const streamRef = useRef<ImportStreamHandle | null>(null);
    const previewSelection = useSelectableCollection({ items: previewArtists, getItemId: getPreviewArtistId });

    const closeStream = useCallback(() => {
        streamRef.current?.close();
        streamRef.current = null;
    }, []);

    const loadSources = useCallback(async (nextProviderId: string) => {
        setLoading(true);
        setLoadError(null);
        try {
            const response = await api.getImportSources(nextProviderId);
            setSelectedProviderId(response.providerId);
            setProviderName(response.providerName);
            setSources(response.sources || []);
            setPhase("select-source");
        } catch (error: any) {
            setLoadError(error?.message || "Failed to load import sources");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!open) {
            closeStream();
            return;
        }
        setPhase(providerId ? "select-source" : "select-provider");
        setSelectedProviderId(providerId || null);
        setProviderName(null);
        setSources([]);
        setActiveSource(null);
        setActiveList(null);
        setPreviewArtists([]);
        setProgressArtists([]);
        setProgress(EMPTY_PROGRESS);
        setRunError(null);
        setLoadError(null);
        setVisibleArtistCount(ARTIST_RENDER_BATCH_SIZE);
        previewSelection.clearSelection();

        let cancelled = false;
        if (providerId) {
            void loadSources(providerId);
        } else {
            setLoading(true);
            api.getStreamingProviders()
                .then((response) => {
                    if (cancelled) return;
                    setProviders((response.providers || []).filter((provider) => provider.authenticated && provider.management?.canImportArtists));
                })
                .catch((error: any) => { if (!cancelled) setLoadError(error?.message || "Failed to load connected providers"); })
                .finally(() => { if (!cancelled) setLoading(false); });
        }
        return () => { cancelled = true; };
        // The selection hook intentionally is not a reset trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, providerId, closeStream, loadSources]);

    useEffect(() => () => closeStream(), [closeStream]);

    useEffect(() => {
        if (phase === "preview" && previewArtists.length > 0) {
            previewSelection.selectAllVisible();
        }
        // Initialize once for each fetched preview, not after every checkbox change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, previewArtists]);

    const openPreview = useCallback(async (source: ImportSource, list?: ImportSourceList) => {
        if (!selectedProviderId) return;
        setActiveSource(source);
        setActiveList(list || null);
        setPreviewArtists([]);
        setVisibleArtistCount(ARTIST_RENDER_BATCH_SIZE);
        previewSelection.clearSelection();
        setPhase("preview");
        setLoading(true);
        setLoadError(null);
        try {
            const response = await api.getImportPreview({
                providerId: selectedProviderId,
                category: source.category,
                listId: list?.id,
            });
            setPreviewArtists(response.artists || []);
        } catch (error: any) {
            setLoadError(error?.message || "Failed to preview artists");
        } finally {
            setLoading(false);
        }
    }, [previewSelection, selectedProviderId]);

    const updateProgressArtist = useCallback((providerArtistId: unknown, update: Partial<ImportProgressArtist>) => {
        const id = String(providerArtistId || "");
        setProgressArtists((items) => items.map((item) => item.providerId === id ? { ...item, ...update } : item));
    }, []);

    const startImport = useCallback(() => {
        if (!activeSource || !selectedProviderId || previewSelection.selectedCount === 0) return;
        const selected = previewSelection.selectedItems;
        setVisibleArtistCount(ARTIST_RENDER_BATCH_SIZE);
        setProgressArtists(selected.map((artist) => ({ ...artist, status: "pending" })));
        setRunError(null);
        setProgress({ ...EMPTY_PROGRESS, total: selected.length, message: "Starting…" });
        setPhase("running");
        closeStream();
        streamRef.current = api.createImportStream(
            {
                category: activeSource.category,
                listId: activeList?.id,
                label: activeList?.title || activeSource.label,
                providerId: selectedProviderId,
                artistIds: selected.map((artist) => artist.providerId),
            },
            (event, data) => {
                const terminalItem = event === "artist-added" || event === "artist-updated" || event === "artist-skipped" || event === "artist-failed";
                switch (event) {
                    case "status":
                        setProgress((current) => ({ ...current, message: data.message }));
                        break;
                    case "total":
                        setProgress((current) => ({ ...current, total: Number(data.total) || current.total }));
                        break;
                    case "artist-progress":
                        setProgress((current) => ({ ...current, currentName: data.name }));
                        updateProgressArtist(data.provider_id, { status: "running" });
                        break;
                    case "artist-added":
                        setProgress((current) => ({ ...current, added: Number(data.added) || current.added + 1 }));
                        updateProgressArtist(data.provider_id, { status: "succeeded", detail: "Added to library" });
                        break;
                    case "artist-updated":
                        setProgress((current) => ({ ...current, monitoredExisting: Number(data.updated) || current.monitoredExisting + 1 }));
                        updateProgressArtist(data.provider_id, { status: "succeeded", detail: "Already in library; monitoring enabled" });
                        break;
                    case "artist-skipped": {
                        const unmatched = String(data.reason || "").startsWith("musicbrainz_");
                        setProgress((current) => ({
                            ...current,
                            skipped: unmatched ? current.skipped : current.skipped + 1,
                            unmatched: unmatched ? current.unmatched + 1 : current.unmatched,
                        }));
                        updateProgressArtist(data.provider_id, {
                            status: unmatched ? "unmatched" : "skipped",
                            detail: unmatched ? "No unambiguous MusicBrainz match" : "Already monitored",
                        });
                        break;
                    }
                    case "artist-failed":
                        setProgress((current) => ({ ...current, failed: current.failed + 1 }));
                        updateProgressArtist(data.provider_id, { status: "failed", detail: data.error || "Import failed" });
                        break;
                    case "complete":
                        setProgress((current) => ({ ...current, message: data.message, processed: current.total }));
                        setPhase("done");
                        closeStream();
                        onImported?.();
                        break;
                    case "error":
                        setRunError(data.error || data.message || "Import failed");
                        setPhase("done");
                        closeStream();
                        break;
                }
                if (terminalItem) {
                    setProgress((current) => ({ ...current, processed: Math.min(current.total, current.processed + 1) }));
                }
            },
            (error) => {
                setRunError(error.message || "Stream connection failed");
                setPhase("done");
                closeStream();
            },
        );
    }, [activeList, activeSource, closeStream, onImported, previewSelection.selectedCount, previewSelection.selectedItems, selectedProviderId, updateProgressArtist]);

    const handleSourceClick = (source: ImportSource) => {
        setActiveSource(source);
        if (source.requiresListSelection) setPhase("select-list");
        else void openPreview(source);
    };

    const goBack = () => {
        setLoadError(null);
        if (phase === "select-source" && !providerId) setPhase("select-provider");
        else if (phase === "select-list") setPhase("select-source");
        else if (phase === "preview") setPhase(activeSource?.requiresListSelection ? "select-list" : "select-source");
    };

    const renderProviderPicker = () => {
        if (loading) return <div className={styles.empty}><Spinner label="Loading connected providers…" /></div>;
        if (providers.length === 0) return <Text className={styles.empty}>No connected provider supports artist import.</Text>;
        return providers.map((provider) => (
            <button key={provider.id} className={styles.sourceRow} onClick={() => void loadSources(provider.id)}>
                <ProviderMark provider={provider.id} size={28} />
                <span className={styles.rowText}>
                    <Text className={styles.rowTitle}>{provider.name}</Text>
                    <Text className={styles.rowSubtitle}>Choose what to import from {provider.name}</Text>
                </span>
                <ChevronRightIcon className={styles.icon} />
            </button>
        ));
    };

    const renderSourceList = () => {
        if (loading) return <div className={styles.empty}><Spinner label="Loading import sources…" /></div>;
        if (sources.length === 0) return <Text className={styles.empty}>No import sources are available for this provider.</Text>;
        return sources.map((source) => (
            <button key={source.category} className={styles.sourceRow} onClick={() => handleSourceClick(source)}>
                <span className={styles.icon}>{CATEGORY_ICONS[source.category] ?? <AppsListIcon />}</span>
                <span className={styles.rowText}>
                    <Text className={styles.rowTitle}>{source.label}</Text>
                    {source.description ? <Text className={styles.rowSubtitle}>{source.description}</Text> : null}
                </span>
                <ChevronRightIcon className={styles.icon} />
            </button>
        ));
    };

    const renderListPicker = () => {
        const lists = activeSource?.lists ?? [];
        if (lists.length === 0) return <Text className={styles.empty}>No {activeSource?.label.toLowerCase()} found.</Text>;
        return <div className={styles.listScroll}>{lists.map((list) => (
            <button key={list.id} className={styles.sourceRow} onClick={() => activeSource && void openPreview(activeSource, list)}>
                {list.image ? (
                    <img
                        className={styles.thumb}
                        src={providerArtworkThumbnailUrl(selectedProviderId, list.image)}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        decoding="async"
                    />
                ) : <Avatar name={list.title} shape="square" size={40} />}
                <span className={styles.rowText}>
                    <Text className={styles.rowTitle}>{list.title}</Text>
                    {list.subtitle ? <Text className={styles.rowSubtitle}>{list.subtitle}</Text> : null}
                </span>
                <ChevronRightIcon className={styles.icon} />
            </button>
        ))}</div>;
    };

    const renderPreview = () => {
        if (loading) return <div className={styles.empty}><Spinner label="Fetching artists…" /></div>;
        if (previewArtists.length === 0) return <Text className={styles.empty}>No artists were found in this source.</Text>;
        return (
            <div className={styles.listScroll}>
                <div className={styles.selectionToolbar}>
                    <Checkbox
                        label="Select all artists"
                        checked={previewSelection.allVisibleSelected ? true : previewSelection.someVisibleSelected ? "mixed" : false}
                        onChange={(_, data) => data.checked === true ? previewSelection.selectAllVisible() : previewSelection.clearSelection()}
                    />
                    <Text size={200}>{previewSelection.selectedCount} of {previewArtists.length} selected</Text>
                </div>
                {previewArtists.slice(0, visibleArtistCount).map((artist) => (
                    <div key={artist.providerId} className={styles.artistRow}>
                        <Checkbox
                            aria-label={`Select ${artist.name}`}
                            checked={previewSelection.selectedRowIds.includes(artist.providerId)}
                            onChange={(event, data) => previewSelection.toggleItem(artist.providerId, data.checked === true, {
                                range: Boolean((event.nativeEvent as MouseEvent).shiftKey),
                            })}
                        />
                        <Avatar
                            name={artist.name}
                            image={artist.picture ? {
                                src: providerArtworkThumbnailUrl(selectedProviderId, artist.picture),
                                loading: "lazy",
                                decoding: "async",
                            } : undefined}
                            size={32}
                        />
                        <span className={styles.rowText}><Text className={styles.rowTitle}>{artist.name}</Text></span>
                    </div>
                ))}
                {visibleArtistCount < previewArtists.length ? (
                    <Button appearance="subtle" onClick={() => setVisibleArtistCount((count) => count + ARTIST_RENDER_BATCH_SIZE)}>
                        Show {Math.min(ARTIST_RENDER_BATCH_SIZE, previewArtists.length - visibleArtistCount)} more artists
                    </Button>
                ) : null}
            </div>
        );
    };

    const groupedProgress = useMemo(() => {
        const order: ArtistResultStatus[] = phase === "done"
            ? ["succeeded", "skipped", "unmatched", "failed", "running", "pending"]
            : ["running", "pending", "succeeded", "skipped", "unmatched", "failed"];
        return order.map((status) => ({ status, items: progressArtists.filter((artist) => artist.status === status) })).filter((group) => group.items.length > 0);
    }, [phase, progressArtists]);

    const visibleProgressGroups = useMemo(() => {
        let remaining = visibleArtistCount;
        return groupedProgress
            .map((group) => {
                const items = group.items.slice(0, Math.max(0, remaining));
                remaining -= items.length;
                return { ...group, visibleItems: items };
            })
            .filter((group) => group.visibleItems.length > 0);
    }, [groupedProgress, visibleArtistCount]);

    const renderProgress = () => {
        const value = progress.total > 0 ? Math.min(1, progress.processed / progress.total) : undefined;
        const labels: Record<ArtistResultStatus, string> = {
            pending: "Waiting", running: "Importing", succeeded: "Succeeded", skipped: "Skipped", unmatched: "Not matched", failed: "Failed",
        };
        return (
            <>
                <Field validationMessage={runError || undefined} validationState={runError ? "error" : "none"}>
                    <ProgressBar value={value} thickness="large" />
                </Field>
                <div className={styles.progressMeta}>
                    <Text>{progress.currentName || progress.message || "Working…"}</Text>
                    <Text>{progress.processed}/{progress.total}</Text>
                </div>
                <div className={styles.counts}>
                    <Badge className={styles.countBadge} appearance="outline" color="success">{progress.added + progress.monitoredExisting} succeeded</Badge>
                    <Badge className={styles.countBadge} appearance="outline" color="warning">{progress.skipped} skipped</Badge>
                    <Badge className={styles.countBadge} appearance="outline" color="warning">{progress.unmatched} not matched</Badge>
                    <Badge className={styles.countBadge} appearance="outline" color="danger">{progress.failed} failed</Badge>
                </div>
                <div className={styles.listScroll}>
                    {visibleProgressGroups.map((group) => (
                        <React.Fragment key={group.status}>
                            <div className={styles.groupHeading}>
                                <Text weight="semibold">{labels[group.status]}</Text>
                                <Badge appearance="outline">{group.items.length}</Badge>
                            </div>
                            {group.visibleItems.map((artist) => (
                                <div key={artist.providerId} className={styles.artistRow}>
                                    <span className={styles.statusCell}>{statusIcon(artist.status, styles)}</span>
                                    <Avatar
                                        name={artist.name}
                                        image={artist.picture ? {
                                            src: providerArtworkThumbnailUrl(selectedProviderId, artist.picture),
                                            loading: "lazy",
                                            decoding: "async",
                                        } : undefined}
                                        size={32}
                                    />
                                    <span className={styles.rowText}>
                                        <Text className={styles.rowTitle}>{artist.name}</Text>
                                        {artist.detail ? <Text className={styles.rowSubtitle}>{artist.detail}</Text> : null}
                                    </span>
                                </div>
                            ))}
                        </React.Fragment>
                    ))}
                    {visibleArtistCount < progressArtists.length ? (
                        <Button appearance="subtle" onClick={() => setVisibleArtistCount((count) => count + ARTIST_RENDER_BATCH_SIZE)}>
                            Show {Math.min(ARTIST_RENDER_BATCH_SIZE, progressArtists.length - visibleArtistCount)} more results
                        </Button>
                    ) : null}
                </div>
            </>
        );
    };

    const title = phase === "select-provider"
        ? "Import artists"
        : phase === "select-source"
            ? `Import from ${providerName || "provider"}`
            : phase === "select-list" && activeSource
                ? activeSource.label
                : phase === "preview"
                    ? `Select artists from ${activeList?.title || activeSource?.label || "source"}`
                    : `Importing from ${activeList?.title || activeSource?.label || providerName || "provider"}`;
    const canGoBack = phase === "select-source" || phase === "select-list" || phase === "preview";

    return (
        <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
            <DialogSurface className={styles.surface}>
                <DialogBody>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogContent className={styles.content}>
                        {loadError ? <Field validationMessage={loadError} validationState="error" /> : null}
                        {phase === "select-provider" && renderProviderPicker()}
                        {phase === "select-source" && renderSourceList()}
                        {phase === "select-list" && renderListPicker()}
                        {phase === "preview" && renderPreview()}
                        {(phase === "running" || phase === "done") && renderProgress()}
                    </DialogContent>
                    <DialogActions>
                        {canGoBack ? <Button appearance="secondary" icon={<ArrowLeftIcon />} onClick={goBack}>Back</Button> : null}
                        {phase === "preview" ? (
                            <Button appearance="primary" disabled={previewSelection.selectedCount === 0 || loading} onClick={startImport}>
                                Import selected ({previewSelection.selectedCount})
                            </Button>
                        ) : phase === "done" ? (
                            <Button appearance="primary" onClick={onClose}>Done</Button>
                        ) : (
                            <Button appearance="secondary" onClick={onClose}>{phase === "running" ? "Run in background" : "Cancel"}</Button>
                        )}
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
};
