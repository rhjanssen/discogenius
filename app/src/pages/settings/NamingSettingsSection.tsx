import {
    Button,
    Caption1,
    Dialog,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Input,
    Select,
    Switch,
    Text,
    Tooltip,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    Dismiss24Regular,
    QuestionCircle24Regular,
    Dismiss24Filled,
    QuestionCircle24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { useToast } from "@/hooks/useToast";
import { api } from "@/services/api";
import type { NamingConfigContract, PathConfigContract } from "@contracts/config";

const QuestionCircle24 = bundleIcon(QuestionCircle24Filled, QuestionCircle24Regular);
const Dismiss24 = bundleIcon(Dismiss24Filled, Dismiss24Regular);

type NamingFieldKey =
    | "artist_folder"
    | "album_track_path_single"
    | "album_track_path_multi"
    | "video_file";

type NamingToken = {
    token: string;
    example: string;
    section: string;
    mode?: "insert" | "replace";
};

const ARTIST_NAMING_TOKENS: NamingToken[] = [
    { section: "Artist", token: "{Artist Name}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist CleanName}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist NameThe}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist CleanNameThe}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist NameFirstCharacter}", example: "D" },
    { section: "Artist", token: "{Artist MbId}", example: "056e4f3e-d505-4dad-8ec1-d04f521cbb56" },
    { section: "Artist", token: "{Artist Disambiguation}", example: "French electronic music duo" },
    { section: "Artist", token: "{Artist Genre}", example: "Electronic" },
    { section: "Artist", token: "{mbid-{Artist MbId}}", example: "{mbid-056e4f3e-d505-4dad-8ec1-d04f521cbb56}" },
    { section: "Artist", token: "{Artist Id}", example: "8847" },
];

const ALBUM_NAMING_TOKENS: NamingToken[] = [
    { section: "Album", token: "{Album Title}", example: "Discovery" },
    { section: "Album", token: "{Album CleanTitle}", example: "Discovery" },
    { section: "Album", token: "{Album TitleThe}", example: "Discovery" },
    { section: "Album", token: "{Album CleanTitleThe}", example: "Discovery" },
    { section: "Album", token: "{Album FullTitle}", example: "Discovery (Deluxe)" },
    { section: "Album", token: "{Album Type}", example: "Album" },
    { section: "Album", token: "{Album Disambiguation}", example: "limited edition" },
    { section: "Album", token: "{Album Genre}", example: "Electronic" },
    { section: "Album", token: "{Album MbId}", example: "0ca7fd24-dc0f-4d16-a5f0-550ad6dd6e53" },
    { section: "Album", token: "{Release Group MbId}", example: "1d5f10c6-4d7f-4f94-b76f-2f61fb5c42f8" },
    { section: "Album", token: "{Release Year}", example: "2001" },
    { section: "Album", token: "{Album Id}", example: "1550545" },
];

const TRACK_NAMING_TOKENS: NamingToken[] = [
    { section: "Track", token: "{Track Title}", example: "One More Time" },
    { section: "Track", token: "{Track CleanTitle}", example: "One More Time" },
    { section: "Track", token: "{Track TitleThe}", example: "One More Time" },
    { section: "Track", token: "{Track CleanTitleThe}", example: "One More Time" },
    { section: "Track", token: "{Track FullTitle}", example: "One More Time (Radio Edit)" },
    { section: "Track", token: "{Track ArtistName}", example: "Daft Punk" },
    { section: "Track", token: "{Track ArtistCleanName}", example: "Daft Punk" },
    { section: "Track", token: "{Track ArtistNameThe}", example: "Daft Punk" },
    { section: "Track", token: "{Track ArtistCleanNameThe}", example: "Daft Punk" },
    { section: "Track", token: "{Track ArtistMbId}", example: "056e4f3e-d505-4dad-8ec1-d04f521cbb56" },
    { section: "Track", token: "{Track MbId}", example: "8f1b4f76-8c53-4f28-bb73-0e1d1b97a3ef" },
    { section: "Track", token: "{Track Id}", example: "1550546" },
    { section: "Track", token: "{Recording MbId}", example: "9f2c5e0a-32b1-4f30-9d96-1c8a2c1efb10" },
    { section: "Track", token: "{Recording Id}", example: "42" },
    { section: "Track", token: "{Media Id}", example: "1550546" },
    { section: "Numbering", token: "{track:00}", example: "01" },
    { section: "Numbering", token: "{track:000}", example: "001" },
    { section: "Numbering", token: "{medium:00}", example: "01" },
    { section: "Numbering", token: "{medium:000}", example: "001" },
];

const QUALITY_NAMING_TOKENS: NamingToken[] = [
    { section: "Quality", token: "{Quality}", example: "HIRES_LOSSLESS" },
    { section: "Quality", token: "{Codec}", example: "FLAC" },
    { section: "Quality", token: "{Bitrate}", example: "1800000" },
    { section: "Quality", token: "{SampleRate}", example: "96000" },
    { section: "Quality", token: "{SampleRate:kHz}", example: "96" },
    { section: "Quality", token: "{BitDepth}", example: "24" },
    { section: "Quality", token: "{Channels}", example: "2" },
    { section: "Quality", token: "{Explicit}", example: "(Explicit) or empty" },
    { section: "Quality", token: "{E}", example: "[E] or empty" },
];

const PROVIDER_NAMING_TOKENS: NamingToken[] = [
    { section: "Provider", token: "{Provider Name}", example: "TIDAL" },
    { section: "Provider", token: "{Provider ArtistId}", example: "8847" },
    { section: "Provider", token: "{Provider AlbumId}", example: "1550545" },
    { section: "Provider", token: "{Provider TrackId}", example: "1550546" },
    { section: "Provider", token: "{Provider MediaId}", example: "1550546" },
    { section: "Provider", token: "{Provider VideoId}", example: "44187439" },
];

const NAMING_HELP: Record<
    NamingFieldKey,
    { title: string; description: string; tokens: NamingToken[] }
> = {
    artist_folder: {
        title: "Artist folder",
        description: "Name of the artist folder under each library root.",
        tokens: [
            { section: "Formats", token: "{Artist Name} {mbid-{Artist MbId}}", example: "Daft Punk {mbid-056e4f3e-d505-4dad-8ec1-d04f521cbb56}", mode: "replace" },
            { section: "Formats", token: "{Artist CleanNameThe} {mbid-{Artist MbId}}", example: "Daft Punk {mbid-056e4f3e-d505-4dad-8ec1-d04f521cbb56}", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
        ],
    },
    album_track_path_single: {
        title: "Album track path (single disc)",
        description: "Path under the artist folder for tracks on single-disc albums (album folder + filename, no extension).",
        tokens: [
            { section: "Formats", token: "{Album FullTitle} ({Release Year})/{track:00} - {Track FullTitle}", example: "Discovery (Deluxe) (2001)/01 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}", example: "Discovery (2001)/Daft Punk - Discovery - 01 - One More Time", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...TRACK_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...PROVIDER_NAMING_TOKENS,
        ],
    },
    album_track_path_multi: {
        title: "Album track path (multi disc)",
        description: "Path under the artist folder for multi-disc albums (album folder, optional disc folder, filename).",
        tokens: [
            { section: "Formats", token: "{Album FullTitle} ({Release Year})/{medium:0}{track:00} - {Track FullTitle}", example: "Discovery (Deluxe) (2001)/201 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Album Title} ({Release Year})/{medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}", example: "Discovery (2001)/02/Daft Punk - Discovery - 01 - One More Time", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...TRACK_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...PROVIDER_NAMING_TOKENS,
        ],
    },
    video_file: {
        title: "Music video file",
        description: "Filename for music videos (no extension). Include {Video Type} (e.g. -video, -live, -lyrics) so media servers can classify extras in a separated video library. Inline layout always uses the matched track filename plus that type suffix.",
        tokens: [
            { section: "Formats", token: "{Video Title}{Video Type} {{Provider Name}-{Provider VideoId}}", example: "Around the World-video {TIDAL-12345}", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            { section: "Video", token: "{Video Title}", example: "Around the World" },
            { section: "Video", token: "{Video FullTitle}", example: "Around the World (Live At O2)" },
            { section: "Video", token: "{Video CleanTitle}", example: "Around the World" },
            { section: "Video", token: "{Video TitleThe}", example: "Around the World" },
            { section: "Video", token: "{Video CleanTitleThe}", example: "Around the World" },
            { section: "Video", token: "{Video Type}", example: "-video" },
            { section: "Video", token: "{Video Id}", example: "44187439" },
            { section: "Video", token: "{Track Id}", example: "1550546" },
            ...ALBUM_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...PROVIDER_NAMING_TOKENS,
        ],
    },
};

type NamingPreviewResponse = Awaited<ReturnType<typeof api.previewNamingConfig>>;

export interface NamingSettingsSectionProps {
    pathSettings: PathConfigContract | null;
    updatePathSettings: (updates: Partial<PathConfigContract>) => void | Promise<void>;
    namingSettings: NamingConfigContract | null;
    updateNamingSettings: (updates: Partial<NamingConfigContract>) => void | Promise<void>;
}

const MEDIA = {
    mobile: "@media (max-width: 640px)",
};

const MODAL_LAYOUT = {
    rowPadding: {
        base: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
};

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
    row: {
        ...rowBase,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": {
            borderBottom: "none",
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
    controlMedium: {
        width: "100%",
        maxWidth: "280px",
        minWidth: "180px",
    },
    templateControl: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        flex: 1,
        minWidth: 0,
    },
    templateInputRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        width: "100%",
    },
    templateHelpButton: {
        ...glassButtonStyles,
        flexShrink: 0,
        minWidth: "36px",
        minHeight: "36px",
        [MEDIA.mobile]: {
            minWidth: "40px",
            minHeight: "40px",
        },
    },
    templatePreview: {
        color: tokens.colorNeutralForeground2,
    },
    templateError: {
        color: tokens.colorPaletteRedForeground1,
    },
    namingRow: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": {
            borderBottom: "none",
        },
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        },
    },
    namingHelpContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    tokenGroup: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    tokenList: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    tokenRow: {
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        columnGap: tokens.spacingHorizontalM,
        alignItems: "center",
    },
    tokenCode: {
        fontFamily: tokens.fontFamilyMonospace,
        overflowWrap: "anywhere",
        whiteSpace: "normal",
    },
    pathInput: {
        flex: 1,
        width: "100%",
        maxWidth: "420px",
        minWidth: "220px",
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    dialogTitleRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
    },
});

export const NamingSettingsSection = ({
    pathSettings,
    updatePathSettings,
    namingSettings,
    updateNamingSettings,
}: NamingSettingsSectionProps) => {
    const styles = useStyles();
    const { toast } = useToast();

    const [namingHelpField, setNamingHelpField] = useState<NamingFieldKey | null>(null);
    const [namingPreviewResponse, setNamingPreviewResponse] = useState<NamingPreviewResponse | null>(null);
    const namingPreviewRequestRef = useRef(0);
    const namingInputRefs = useRef<Record<NamingFieldKey, HTMLInputElement | null>>({
        artist_folder: null,
        album_track_path_single: null,
        album_track_path_multi: null,
        video_file: null,
    });
    const namingSelectionRef = useRef<Record<NamingFieldKey, { start: number; end: number } | null>>({
        artist_folder: null,
        album_track_path_single: null,
        album_track_path_multi: null,
        video_file: null,
    });
    const [localNaming, setLocalNaming] = useState<Partial<NamingConfigContract>>({});

    useEffect(() => {
        if (namingSettings) {
            setLocalNaming(namingSettings);
        }
    }, [namingSettings]);

    const handleNamingChange = (key: keyof NamingConfigContract, value: string) => {
        setLocalNaming((prev) => ({ ...prev, [key]: value }));
    };

    const handleNamingCommit = (key: keyof NamingConfigContract) => {
        if (!namingSettings) {
            return;
        }

        if (localNaming[key] !== namingSettings[key] && !namingPreviewResponse) {
            toast({
                title: "Naming not saved",
                description: "Wait for the preview to finish before saving.",
                variant: "destructive",
            });
            return;
        }

        if (namingPreviewResponse?.valid === false) {
            toast({
                title: "Naming not saved",
                description: "Fix the template validation errors before saving.",
                variant: "destructive",
            });
            return;
        }

        if (localNaming[key] !== namingSettings[key]) {
            void updateNamingSettings({ [key]: localNaming[key] });
        }
    };

    const effectiveNamingSettings = useMemo(
        () => namingSettings ? { ...namingSettings, ...localNaming } : null,
        [localNaming, namingSettings],
    );

    useEffect(() => {
        if (!effectiveNamingSettings) {
            namingPreviewRequestRef.current += 1;
            setNamingPreviewResponse(null);
            return;
        }

        const requestId = namingPreviewRequestRef.current + 1;
        namingPreviewRequestRef.current = requestId;
        setNamingPreviewResponse(null);
        const timeout = setTimeout(() => {
            api.previewNamingConfig(effectiveNamingSettings)
                .then((response) => {
                    if (namingPreviewRequestRef.current === requestId) {
                        setNamingPreviewResponse(response);
                    }
                })
                .catch(() => {
                    if (namingPreviewRequestRef.current === requestId) {
                        setNamingPreviewResponse(null);
                    }
                });
        }, 250);

        return () => clearTimeout(timeout);
    }, [effectiveNamingSettings]);

    const namingHelpMeta = namingHelpField ? NAMING_HELP[namingHelpField] : null;

    const setNamingInputRef = (field: NamingFieldKey) => (element: HTMLInputElement | null) => {
        namingInputRefs.current[field] = element;
    };

    const captureNamingSelection = (field: NamingFieldKey) => {
        const input = namingInputRefs.current[field];
        if (!input) return;
        namingSelectionRef.current[field] = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
        };
    };

    const insertNamingToken = (item: NamingToken) => {
        if (!namingHelpField || !namingSettings) return;
        const current = (localNaming as any)[namingHelpField] || "";
        const range = namingSelectionRef.current[namingHelpField];
        const hasSelection = Boolean(
            range
            && range.start >= 0
            && range.end >= range.start
            && range.end <= current.length,
        );
        const next = item.mode === "replace"
            ? item.token
            : hasSelection
                ? `${current.slice(0, range!.start)}${item.token}${current.slice(range!.end)}`
                : `${current}${item.token}`;
        const cursor = item.mode === "replace"
            ? item.token.length
            : hasSelection
                ? range!.start + item.token.length
                : next.length;

        setLocalNaming((prev) => ({ ...prev, [namingHelpField]: next }));
        namingSelectionRef.current[namingHelpField] = { start: cursor, end: cursor };
    };

    const namingTokenGroups = (() => {
        if (!namingHelpMeta) return [];
        const groups: Array<{ section: string; tokens: NamingToken[] }> = [];
        for (const item of namingHelpMeta.tokens) {
            let group = groups.find((candidate) => candidate.section === item.section);
            if (!group) {
                group = { section: item.section, tokens: [] };
                groups.push(group);
            }
            group.tokens.push(item);
        }
        return groups;
    })();

    const namingExamples = namingPreviewResponse?.preview ? (() => {
        const artistFolder = namingPreviewResponse.preview.artistFolder;
        const trackPathSingle = namingPreviewResponse.preview.standardTrack;
        const trackPathMulti = namingPreviewResponse.preview.multiDiscTrack;
        const videoFile = namingPreviewResponse.preview.video;
        return {
            artistFolder,
            videoFile,
            trackPathSingle,
            trackPathMulti,
            fullSingleTrackPath: [artistFolder, trackPathSingle].filter(Boolean).join("/"),
            fullMultiTrackPath: [artistFolder, trackPathMulti].filter(Boolean).join("/"),
            videoPath: [artistFolder, videoFile].filter(Boolean).join("/"),
        };
    })() : null;

    const getNamingFieldErrors = (field: NamingFieldKey): string[] => {
        const result = namingPreviewResponse?.validation?.[field];
        return Array.isArray(result?.errors) ? result.errors : [];
    };

    return (
            <SettingsSection
                id="media-management"
                title="Media Management"
                description="Library roots, folder layout, and naming templates for organized files."
                className={styles.section}
            >
                <div className={styles.card}>
                    <div className={styles.row}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Music Library Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Standard stereo music library
                            </Text>
                        </div>
                        <Input
                            value={pathSettings?.music_path || ""}
                            onChange={(_, data) => updatePathSettings({ music_path: data.value })}
                            className={styles.pathInput}
                        />
                    </div>
                    <div className={styles.row}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Spatial Library Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Spatial and surround music library
                            </Text>
                        </div>
                        <Input
                            value={pathSettings?.spatial_path || ""}
                            onChange={(_, data) => updatePathSettings({ spatial_path: data.value })}
                            className={styles.pathInput}
                        />
                    </div>
                    <div className={styles.row}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Video Library Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Music videos library
                            </Text>
                        </div>
                        <Input
                            value={pathSettings?.video_path || ""}
                            onChange={(_, data) => updatePathSettings({ video_path: data.value })}
                            className={styles.pathInput}
                        />
                    </div>
                    <div className={styles.row}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Video Folder Layout</Text>
                            <Text size={200} className={styles.mutedText}>
                                Keep videos in their own library, or store them alongside each artist's music.
                            </Text>
                        </div>
                        <Select
                            value={pathSettings?.video_folder_layout || "separated"}
                            onChange={(_, data) => updatePathSettings({ video_folder_layout: data.value as "separated" | "inline" })}
                            className={styles.controlMedium}
                        >
                            <option value="separated">Separated Library</option>
                            <option value="inline">Inline with Audio Tracks</option>
                        </Select>
                    </div>
                    <div className={styles.row}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Create Empty Artist Folders</Text>
                            <Text size={200} className={styles.mutedText}>
                                Create a folder for every monitored artist, even before anything is downloaded.
                            </Text>
                        </div>
                        <Switch
                            checked={Boolean(pathSettings?.create_empty_artist_folders)}
                            onChange={(_, data) => updatePathSettings({ create_empty_artist_folders: data.checked })}
                        />
                    </div>
                </div>

                <div className={styles.card}>
                    <div className={styles.namingRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Artist Folder</Text>
                            <Text size={200} className={styles.mutedText}>
                                Template for artist folder name
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <div className={styles.templateInputRow}>
                                <Input
                                    ref={setNamingInputRef("artist_folder")}
                                    value={localNaming?.artist_folder ?? ""}
                                    onChange={(_, data) => handleNamingChange("artist_folder", data.value)}
                                    onFocus={() => captureNamingSelection("artist_folder")}
                                    onSelect={() => captureNamingSelection("artist_folder")}
                                    onKeyUp={() => captureNamingSelection("artist_folder")}
                                    onBlur={() => handleNamingCommit("artist_folder")}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("artist_folder"); }}
                                    className={styles.pathInput}
                                    disabled={!namingSettings}
                                />
                                <Tooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("artist_folder")}
                                    />
                                </Tooltip>
                            </div>
                            <Caption1 className={styles.templatePreview}>
                                Example: <span className={styles.tokenCode}>{namingExamples?.artistFolder ?? "—"}</span>
                            </Caption1>
                            {getNamingFieldErrors("artist_folder").map((error) => (
                                <Caption1 key={error} className={styles.templateError}>{error}</Caption1>
                            ))}
                        </div>
                    </div>
                    <div className={styles.namingRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Single-volume Album Track Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Album folder + track filename (without extension)
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <div className={styles.templateInputRow}>
                                <Input
                                    ref={setNamingInputRef("album_track_path_single")}
                                    value={localNaming?.album_track_path_single ?? ""}
                                    onChange={(_, data) => handleNamingChange("album_track_path_single", data.value)}
                                    onFocus={() => captureNamingSelection("album_track_path_single")}
                                    onSelect={() => captureNamingSelection("album_track_path_single")}
                                    onKeyUp={() => captureNamingSelection("album_track_path_single")}
                                    onBlur={() => handleNamingCommit("album_track_path_single")}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("album_track_path_single"); }}
                                    className={styles.pathInput}
                                    disabled={!namingSettings}
                                />
                                <Tooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("album_track_path_single")}
                                    />
                                </Tooltip>
                            </div>
                            <Caption1 className={styles.templatePreview}>
                                Example: <span className={styles.tokenCode}>{namingExamples?.fullSingleTrackPath ?? "—"}</span>
                            </Caption1>
                            {getNamingFieldErrors("album_track_path_single").map((error) => (
                                <Caption1 key={error} className={styles.templateError}>{error}</Caption1>
                            ))}
                        </div>
                    </div>
                    <div className={styles.namingRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Multi-volume Album Track Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Album folder + optional disc folder + track filename (without extension)
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <div className={styles.templateInputRow}>
                                <Input
                                    ref={setNamingInputRef("album_track_path_multi")}
                                    value={localNaming?.album_track_path_multi ?? ""}
                                    onChange={(_, data) => handleNamingChange("album_track_path_multi", data.value)}
                                    onFocus={() => captureNamingSelection("album_track_path_multi")}
                                    onSelect={() => captureNamingSelection("album_track_path_multi")}
                                    onKeyUp={() => captureNamingSelection("album_track_path_multi")}
                                    onBlur={() => handleNamingCommit("album_track_path_multi")}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("album_track_path_multi"); }}
                                    className={styles.pathInput}
                                    disabled={!namingSettings}
                                />
                                <Tooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("album_track_path_multi")}
                                    />
                                </Tooltip>
                            </div>
                            <Caption1 className={styles.templatePreview}>
                                Example: <span className={styles.tokenCode}>{namingExamples?.fullMultiTrackPath ?? "—"}</span>
                            </Caption1>
                            {getNamingFieldErrors("album_track_path_multi").map((error) => (
                                <Caption1 key={error} className={styles.templateError}>{error}</Caption1>
                            ))}
                        </div>
                    </div>
                    <div className={styles.namingRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Video File</Text>
                            <Text size={200} className={styles.mutedText}>
                                Video filename (without extension)
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <div className={styles.templateInputRow}>
                                <Input
                                    ref={setNamingInputRef("video_file")}
                                    value={localNaming?.video_file ?? ""}
                                    onChange={(_, data) => handleNamingChange("video_file", data.value)}
                                    onFocus={() => captureNamingSelection("video_file")}
                                    onSelect={() => captureNamingSelection("video_file")}
                                    onKeyUp={() => captureNamingSelection("video_file")}
                                    onBlur={() => handleNamingCommit("video_file")}
                                    onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("video_file"); }}
                                    className={styles.pathInput}
                                    disabled={!namingSettings}
                                />
                                <Tooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("video_file")}
                                    />
                                </Tooltip>
                            </div>
                            <Caption1 className={styles.templatePreview}>
                                Example: <span className={styles.tokenCode}>{namingExamples?.videoPath ?? "—"}</span>
                            </Caption1>
                            {getNamingFieldErrors("video_file").map((error) => (
                                <Caption1 key={error} className={styles.templateError}>{error}</Caption1>
                            ))}
                        </div>
                    </div>
                </div>

                <Dialog
                    open={Boolean(namingHelpMeta)}
                    onOpenChange={(_, data) => {
                        if (!data.open) setNamingHelpField(null);
                    }}
                >
                    <DialogSurface>
                        <DialogBody>
                            <DialogTitle>
                                <div className={styles.dialogTitleRow}>
                                    <span>{namingHelpMeta?.title}</span>
                                    <Button appearance="subtle" icon={<Dismiss24 />} onClick={() => setNamingHelpField(null)} />
                                </div>
                            </DialogTitle>
                            <DialogContent>
                                <div className={styles.namingHelpContent}>
                                    <Text className={styles.mutedText}>
                                        {namingHelpMeta?.description}
                                    </Text>
                                    {namingTokenGroups.map((group) => (
                                        <div key={group.section} className={styles.tokenGroup}>
                                            <Text size={200} weight="semibold">{group.section}</Text>
                                            <div className={styles.tokenList}>
                                                {group.tokens.map((t) => (
                                                    <div key={`${group.section}-${t.token}`} className={styles.tokenRow}>
                                                        <Button
                                                            appearance="subtle"
                                                            size="small"
                                                            onClick={() => insertNamingToken(t)}
                                                        >
                                                            <span className={styles.tokenCode}>{t.token}</span>
                                                        </Button>
                                                        <Text size={200} className={styles.mutedText}>
                                                            Example: <span className={styles.tokenCode}>{t.example}</span>
                                                        </Text>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </DialogContent>
                        </DialogBody>
                    </DialogSurface>
                </Dialog>
            </SettingsSection>
    );
};

export default NamingSettingsSection;
