import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Text,
    Spinner,
    ProgressBar,
    Field,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    ArrowLeft24Regular,
    ChevronRight20Regular,
    PeopleTeam24Regular,
    Heart24Regular,
    MusicNote224Regular,
    AppsList24Regular,
} from "@fluentui/react-icons";
import { api, type ImportSource, type ImportSourceList } from "@/services/api";

interface ImportArtistsModalProps {
    open: boolean;
    onClose: () => void;
    providerId?: string | null;
    /** Called after an import completes so the caller can refresh the library. */
    onImported?: () => void;
}

type Phase = "select-source" | "select-list" | "running" | "done";

interface ImportProgress {
    total: number;
    processed: number;
    added: number;
    monitoredExisting: number;
    skipped: number;
    currentName?: string;
    message?: string;
}

const CATEGORY_ICONS: Record<string, React.ReactElement> = {
    "followed-artists": <PeopleTeam24Regular />,
    "favorite-tracks": <Heart24Regular />,
    playlist: <AppsList24Regular />,
    mix: <MusicNote224Regular />,
};

const useStyles = makeStyles({
    surface: { maxWidth: "560px", width: "calc(100vw - 32px)", maxHeight: "80vh" },
    content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minHeight: "180px" },
    sourceRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        padding: tokens.spacingVerticalM,
        borderRadius: tokens.borderRadiusMedium,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        cursor: "pointer",
        textAlign: "left",
        background: tokens.colorNeutralBackground1,
        width: "100%",
        "&:hover": { background: tokens.colorNeutralBackground1Hover },
        "&:disabled": { cursor: "not-allowed", opacity: 0.6 },
    },
    rowText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
    rowTitle: { fontWeight: tokens.fontWeightSemibold },
    rowSubtitle: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
    icon: { color: tokens.colorBrandForeground1, flexShrink: 0, display: "flex" },
    thumb: { width: "40px", height: "40px", borderRadius: tokens.borderRadiusSmall, objectFit: "cover", flexShrink: 0 },
    listScroll: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, overflowY: "auto", maxHeight: "48vh" },
    progressMeta: { display: "flex", justifyContent: "space-between", color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
    counts: { display: "flex", gap: tokens.spacingHorizontalL, marginTop: tokens.spacingVerticalS },
    countItem: { display: "flex", flexDirection: "column", alignItems: "center", flex: 1 },
    countValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
    countLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
    empty: { color: tokens.colorNeutralForeground3, textAlign: "center", padding: tokens.spacingVerticalXXL },
});

export const ImportArtistsModal: React.FC<ImportArtistsModalProps> = ({ open, onClose, providerId, onImported }) => {
    const styles = useStyles();
    const [phase, setPhase] = useState<Phase>("select-source");
    const [sources, setSources] = useState<ImportSource[]>([]);
    const [loadingSources, setLoadingSources] = useState(false);
    const [sourcesError, setSourcesError] = useState<string | null>(null);
    const [activeSource, setActiveSource] = useState<ImportSource | null>(null);
    const [progress, setProgress] = useState<ImportProgress>({ total: 0, processed: 0, added: 0, monitoredExisting: 0, skipped: 0 });
    const [runError, setRunError] = useState<string | null>(null);
    const eventSourceRef = useRef<EventSource | null>(null);

    const closeStream = useCallback(() => {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
    }, []);

    // Reset + (re)load sources whenever the modal opens.
    useEffect(() => {
        if (!open) {
            closeStream();
            return;
        }
        setPhase("select-source");
        setActiveSource(null);
        setRunError(null);
        setProgress({ total: 0, processed: 0, added: 0, monitoredExisting: 0, skipped: 0 });
        setLoadingSources(true);
        setSourcesError(null);
        let cancelled = false;
        api.getImportSources(providerId)
            .then((res) => { if (!cancelled) setSources(res.sources || []); })
            .catch((err) => { if (!cancelled) setSourcesError(err?.message || "Failed to load import sources"); })
            .finally(() => { if (!cancelled) setLoadingSources(false); });
        return () => { cancelled = true; };
    }, [open, providerId, closeStream]);

    useEffect(() => () => closeStream(), [closeStream]);

    const startImport = useCallback((source: ImportSource, list?: ImportSourceList) => {
        setRunError(null);
        setProgress({ total: 0, processed: 0, added: 0, monitoredExisting: 0, skipped: 0, message: "Starting…" });
        setPhase("running");
        closeStream();
        eventSourceRef.current = api.createImportStream(
            { category: source.category, listId: list?.id, label: list?.title || source.label, providerId },
            (event, data) => {
                switch (event) {
                    case "status":
                        setProgress((p) => ({ ...p, message: data.message }));
                        break;
                    case "total":
                        setProgress((p) => ({ ...p, total: Number(data.total) || 0 }));
                        break;
                    case "artist-progress":
                        setProgress((p) => ({ ...p, processed: Number(data.progress) || p.processed, currentName: data.name }));
                        break;
                    case "artist-added":
                        setProgress((p) => ({ ...p, added: Number(data.added) || p.added + 1 }));
                        break;
                    case "artist-updated":
                        setProgress((p) => ({ ...p, monitoredExisting: Number(data.updated) || p.monitoredExisting + 1 }));
                        break;
                    case "artist-skipped":
                        setProgress((p) => ({ ...p, skipped: Number(data.skipped) || p.skipped + 1 }));
                        break;
                    case "complete":
                        setProgress((p) => ({ ...p, message: data.message, processed: p.total || p.processed }));
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
            },
            (err) => {
                setRunError(err.message || "Stream connection failed");
                setPhase("done");
                closeStream();
            },
        );
    }, [providerId, closeStream, onImported]);

    const handleSourceClick = (source: ImportSource) => {
        if (source.requiresListSelection) {
            setActiveSource(source);
            setPhase("select-list");
        } else {
            startImport(source);
        }
    };

    const renderSourceList = () => {
        if (loadingSources) {
            return <div className={styles.empty}><Spinner label="Loading import sources…" /></div>;
        }
        if (sourcesError) {
            return <Text className={styles.empty}>{sourcesError}</Text>;
        }
        if (sources.length === 0) {
            return <Text className={styles.empty}>No import sources available. Connect a streaming service first.</Text>;
        }
        return sources.map((source) => (
            <button key={source.category} className={styles.sourceRow} onClick={() => handleSourceClick(source)}>
                <span className={styles.icon}>{CATEGORY_ICONS[source.category] ?? <AppsList24Regular />}</span>
                <span className={styles.rowText}>
                    <Text className={styles.rowTitle}>{source.label}</Text>
                    {source.description ? <Text className={styles.rowSubtitle}>{source.description}</Text> : null}
                </span>
                {source.requiresListSelection ? <ChevronRight20Regular className={styles.icon} /> : null}
            </button>
        ));
    };

    const renderListPicker = () => {
        const lists = activeSource?.lists ?? [];
        if (lists.length === 0) {
            return <Text className={styles.empty}>No {activeSource?.label.toLowerCase()} found.</Text>;
        }
        return (
            <div className={styles.listScroll}>
                {lists.map((list) => (
                    <button key={list.id} className={styles.sourceRow} onClick={() => activeSource && startImport(activeSource, list)}>
                        {list.image ? <img className={styles.thumb} src={list.image} alt="" /> : null}
                        <span className={styles.rowText}>
                            <Text className={styles.rowTitle}>{list.title}</Text>
                            {list.subtitle ? <Text className={styles.rowSubtitle}>{list.subtitle}</Text> : null}
                        </span>
                    </button>
                ))}
            </div>
        );
    };

    const renderProgress = () => {
        const value = progress.total > 0 ? Math.min(1, progress.processed / progress.total) : undefined;
        return (
            <>
                <Field validationMessage={runError || undefined} validationState={runError ? "error" : "none"}>
                    <ProgressBar value={value} thickness="large" />
                </Field>
                <div className={styles.progressMeta}>
                    <Text>{progress.currentName || progress.message || "Working…"}</Text>
                    {progress.total > 0 ? <Text>{progress.processed}/{progress.total}</Text> : null}
                </div>
                <div className={styles.counts}>
                    <div className={styles.countItem}><Text className={styles.countValue}>{progress.added}</Text><Text className={styles.countLabel}>Added</Text></div>
                    <div className={styles.countItem}><Text className={styles.countValue}>{progress.monitoredExisting}</Text><Text className={styles.countLabel}>Already in library</Text></div>
                    <div className={styles.countItem}><Text className={styles.countValue}>{progress.skipped}</Text><Text className={styles.countLabel}>Skipped</Text></div>
                </div>
            </>
        );
    };

    const title = phase === "select-list" && activeSource ? activeSource.label : "Import artists";

    return (
        <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
            <DialogSurface className={styles.surface}>
                <DialogBody>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogContent className={styles.content}>
                        {phase === "select-source" && renderSourceList()}
                        {phase === "select-list" && renderListPicker()}
                        {(phase === "running" || phase === "done") && renderProgress()}
                    </DialogContent>
                    <DialogActions>
                        {phase === "select-list" ? (
                            <Button appearance="secondary" icon={<ArrowLeft24Regular />} onClick={() => setPhase("select-source")}>Back</Button>
                        ) : null}
                        {phase === "done" ? (
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
