import {
    Button,
    Caption1,
    Dialog,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Input,
    Switch,
    Text,
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
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { AppTooltip } from "@/components/ui/AppTooltip";
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
    { section: "Album", token: "{Album Type}", example: "Album" },
    { section: "Album", token: "{Album Disambiguation}", example: "limited edition" },
    { section: "Album", token: "{Album Genre}", example: "Electronic" },
    { section: "Album", token: "{Album MbId}", example: "0ca7fd24-dc0f-4d16-a5f0-550ad6dd6e53" },
    { section: "Album", token: "{Release Group MbId}", example: "1d5f10c6-4d7f-4f94-b76f-2f61fb5c42f8" },
    { section: "Album", token: "{Release Year}", example: "2001" },
    { section: "Album", token: "{Album Id}", example: "1550545" },
    // Edition = MusicBrainz release (specific product). Preferred for folder names.
    { section: "Edition", token: "{Edition Title}", example: "Discovery (Deluxe)" },
    { section: "Edition", token: "{Edition CleanTitle}", example: "Discovery Deluxe" },
    { section: "Edition", token: "{Edition TitleThe}", example: "Discovery (Deluxe)" },
    { section: "Edition", token: "{Edition CleanTitleThe}", example: "Discovery Deluxe" },
    { section: "Edition", token: "{Edition Disambiguation}", example: "deluxe edition" },
    { section: "Edition", token: "{Release Title}", example: "Discovery (Deluxe)" },
    { section: "Edition", token: "{Release Disambiguation}", example: "deluxe edition" },
];

const TRACK_NAMING_TOKENS: NamingToken[] = [
    { section: "Track", token: "{Track Title}", example: "One More Time" },
    { section: "Track", token: "{Track CleanTitle}", example: "One More Time" },
    { section: "Track", token: "{Track TitleThe}", example: "One More Time" },
    { section: "Track", token: "{Track CleanTitleThe}", example: "One More Time" },
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
        description: "Path under the artist folder for tracks on single-disc albums (album folder + filename, no extension). Prefer {Edition Title} so deluxe/region products get distinct folders.",
        tokens: [
            { section: "Formats", token: "{Edition Title} ({Release Year})/{track:00} - {Track Title}", example: "Discovery (2001)/01 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Edition Title} ({Edition Disambiguation}) ({Release Year})/{track:00} - {Track Title}", example: "Discovery (deluxe edition) (2001)/01 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Album Title} ({Release Year})/{track:00} - {Track Title}", example: "Discovery (2001)/01 - One More Time", mode: "replace" },
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
            { section: "Formats", token: "{Edition Title} ({Release Year})/{medium:0}{track:00} - {Track Title}", example: "Discovery (2001)/201 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Album Title} ({Release Year})/{medium:0}{track:00} - {Track Title}", example: "Discovery (2001)/201 - One More Time", mode: "replace" },
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

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        marginBottom: tokens.spacingVerticalNone,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    /**
     * Fluent Field-like vertical rows: label + hint above, control full width.
     * Avoids cramped label|control pairs for paths/selects on desktop and mobile.
     */
    fieldRow: {
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: tokens.spacingVerticalS,
        padding: MODAL_LAYOUT.rowPadding.base,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        minWidth: 0,
        "&:last-child": {
            borderBottom: "none",
        },
        [MEDIA.mobile]: {
            padding: MODAL_LAYOUT.rowPadding.mobile,
        },
    },
    /** Compact toggle rows keep label left / switch right (WinUI SettingsCard). */
    rowInline: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        padding: MODAL_LAYOUT.rowPadding.base,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        minWidth: 0,
        "&:last-child": {
            borderBottom: "none",
        },
        [MEDIA.mobile]: {
            padding: MODAL_LAYOUT.rowPadding.mobile,
            columnGap: tokens.spacingHorizontalS,
        },
    },
    rowContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        flex: "1 1 auto",
        minWidth: 0,
    },
    labelWithHelp: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
        minHeight: "32px",
        minWidth: 0,
    },
    templateControl: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        width: "100%",
        minWidth: 0,
    },
    templateHelpButton: {
        ...glassButtonStyles,
        flexShrink: 0,
        minWidth: "32px",
        minHeight: "32px",
        [MEDIA.mobile]: {
            minWidth: "36px",
            minHeight: "36px",
        },
    },
    templatePreview: {
        color: tokens.colorNeutralForeground2,
        overflowWrap: "anywhere",
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
        minWidth: 0,
        "&:last-child": {
            borderBottom: "none",
        },
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        },
    },
    pathInput: {
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
    },
    templateInput: {
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    // Fluent Dialog: constrain surface; scroll inside DialogContent only.
    helpSurface: {
        width: "min(560px, calc(100vw - 32px))",
        maxWidth: "560px",
    },
    helpContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
        minWidth: 0,
        maxWidth: "100%",
        overflowX: "hidden",
    },
    tokenGroup: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        minWidth: 0,
    },
    tokenList: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        minWidth: 0,
    },
    tokenItem: {
        ...glassButtonStyles,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: tokens.spacingVerticalXXS,
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        boxSizing: "border-box",
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        textAlign: "left",
        cursor: "pointer",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground1,
        "&:hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
    },
    tokenCode: {
        fontFamily: tokens.fontFamilyMonospace,
        fontSize: tokens.fontSizeBase200,
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        whiteSpace: "pre-wrap",
        minWidth: 0,
    },
    tokenExample: {
        color: tokens.colorNeutralForeground2,
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        minWidth: 0,
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
        // Album/video previews use ".../" so the artist folder isn't repeated under every template.
        const withShortenedArtistParent = (relativePath: string) =>
            ["...", relativePath].filter(Boolean).join("/");
        return {
            artistFolder,
            videoFile,
            trackPathSingle,
            trackPathMulti,
            fullSingleTrackPath: withShortenedArtistParent(trackPathSingle),
            fullMultiTrackPath: withShortenedArtistParent(trackPathMulti),
            videoPath: withShortenedArtistParent(videoFile),
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
                <SettingsCard>
                    <div className={styles.fieldRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Music Library Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Standard stereo music library
                            </Text>
                        </div>
                        <Input
                            aria-label="Music Library Path"
                            value={pathSettings?.music_path || ""}
                            onChange={(_, data) => updatePathSettings({ music_path: data.value })}
                            className={styles.pathInput}
                        />
                    </div>
                    <div className={styles.fieldRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Spatial Library Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Spatial and surround music library
                            </Text>
                        </div>
                        <Input
                            aria-label="Spatial Library Path"
                            value={pathSettings?.spatial_path || ""}
                            onChange={(_, data) => updatePathSettings({ spatial_path: data.value })}
                            className={styles.pathInput}
                        />
                    </div>
                    <div className={styles.fieldRow}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Video Library Path</Text>
                            <Text size={200} className={styles.mutedText}>
                                Music videos library
                            </Text>
                        </div>
                        <Input
                            aria-label="Video Library Path"
                            value={pathSettings?.video_path || ""}
                            onChange={(_, data) => updatePathSettings({ video_path: data.value })}
                            className={styles.pathInput}
                        />
                    </div>
                    <div className={styles.rowInline}>
                        <div className={styles.rowContent}>
                            <Text weight="semibold">Create Empty Artist Folders</Text>
                            <Text size={200} className={styles.mutedText}>
                                Create a folder for every monitored artist, even before anything is downloaded.
                            </Text>
                        </div>
                        <Switch
                            aria-label="Create Empty Artist Folders"
                            checked={Boolean(pathSettings?.create_empty_artist_folders)}
                            onChange={(_, data) => updatePathSettings({ create_empty_artist_folders: data.checked })}
                        />
                    </div>
                </SettingsCard>

                <SettingsCard>
                    <div className={styles.namingRow}>
                        <div className={styles.rowContent}>
                            <div className={styles.labelWithHelp}>
                                <Text weight="semibold">Artist Folder</Text>
                                <AppTooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("artist_folder")}
                                        aria-label="Artist folder naming tokens"
                                    />
                                </AppTooltip>
                            </div>
                            <Text size={200} className={styles.mutedText}>
                                Template for artist folder name
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <Input
                                aria-label="Artist Folder"
                                ref={setNamingInputRef("artist_folder")}
                                value={localNaming?.artist_folder ?? ""}
                                onChange={(_, data) => handleNamingChange("artist_folder", data.value)}
                                onFocus={() => captureNamingSelection("artist_folder")}
                                onSelect={() => captureNamingSelection("artist_folder")}
                                onKeyUp={() => captureNamingSelection("artist_folder")}
                                onBlur={() => handleNamingCommit("artist_folder")}
                                onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("artist_folder"); }}
                                className={styles.templateInput}
                                disabled={!namingSettings}
                            />
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
                            <div className={styles.labelWithHelp}>
                                <Text weight="semibold">Single-volume Album Track Path</Text>
                                <AppTooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("album_track_path_single")}
                                        aria-label="Single-volume album track path naming tokens"
                                    />
                                </AppTooltip>
                            </div>
                            <Text size={200} className={styles.mutedText}>
                                Album folder + track filename (without extension)
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <Input
                                aria-label="Single-volume Album Track Path"
                                ref={setNamingInputRef("album_track_path_single")}
                                value={localNaming?.album_track_path_single ?? ""}
                                onChange={(_, data) => handleNamingChange("album_track_path_single", data.value)}
                                onFocus={() => captureNamingSelection("album_track_path_single")}
                                onSelect={() => captureNamingSelection("album_track_path_single")}
                                onKeyUp={() => captureNamingSelection("album_track_path_single")}
                                onBlur={() => handleNamingCommit("album_track_path_single")}
                                onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("album_track_path_single"); }}
                                className={styles.templateInput}
                                disabled={!namingSettings}
                            />
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
                            <div className={styles.labelWithHelp}>
                                <Text weight="semibold">Multi-volume Album Track Path</Text>
                                <AppTooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("album_track_path_multi")}
                                        aria-label="Multi-volume album track path naming tokens"
                                    />
                                </AppTooltip>
                            </div>
                            <Text size={200} className={styles.mutedText}>
                                Album folder + optional disc folder + track filename (without extension)
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <Input
                                aria-label="Multi-volume Album Track Path"
                                ref={setNamingInputRef("album_track_path_multi")}
                                value={localNaming?.album_track_path_multi ?? ""}
                                onChange={(_, data) => handleNamingChange("album_track_path_multi", data.value)}
                                onFocus={() => captureNamingSelection("album_track_path_multi")}
                                onSelect={() => captureNamingSelection("album_track_path_multi")}
                                onKeyUp={() => captureNamingSelection("album_track_path_multi")}
                                onBlur={() => handleNamingCommit("album_track_path_multi")}
                                onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("album_track_path_multi"); }}
                                className={styles.templateInput}
                                disabled={!namingSettings}
                            />
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
                            <div className={styles.labelWithHelp}>
                                <Text weight="semibold">Video File</Text>
                                <AppTooltip content="Show tokens" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        icon={<QuestionCircle24 />}
                                        className={styles.templateHelpButton}
                                        onClick={() => setNamingHelpField("video_file")}
                                        aria-label="Video file naming tokens"
                                    />
                                </AppTooltip>
                            </div>
                            <Text size={200} className={styles.mutedText}>
                                Video filename (without extension)
                            </Text>
                        </div>
                        <div className={styles.templateControl}>
                            <Input
                                aria-label="Video File"
                                ref={setNamingInputRef("video_file")}
                                value={localNaming?.video_file ?? ""}
                                onChange={(_, data) => handleNamingChange("video_file", data.value)}
                                onFocus={() => captureNamingSelection("video_file")}
                                onSelect={() => captureNamingSelection("video_file")}
                                onKeyUp={() => captureNamingSelection("video_file")}
                                onBlur={() => handleNamingCommit("video_file")}
                                onKeyDown={(e) => { if (e.key === "Enter") handleNamingCommit("video_file"); }}
                                className={styles.templateInput}
                                disabled={!namingSettings}
                            />
                            <Caption1 className={styles.templatePreview}>
                                Example: <span className={styles.tokenCode}>{namingExamples?.videoPath ?? "—"}</span>
                            </Caption1>
                            {getNamingFieldErrors("video_file").map((error) => (
                                <Caption1 key={error} className={styles.templateError}>{error}</Caption1>
                            ))}
                        </div>
                    </div>
                </SettingsCard>

                <Dialog
                    open={Boolean(namingHelpMeta)}
                    onOpenChange={(_, data) => {
                        if (!data.open) setNamingHelpField(null);
                    }}
                >
                    <DialogSurface className={styles.helpSurface}>
                        <DialogBody>
                            <DialogTitle
                                action={
                                    <Button
                                        appearance="subtle"
                                        aria-label="Close"
                                        icon={<Dismiss24 />}
                                        onClick={() => setNamingHelpField(null)}
                                    />
                                }
                            >
                                {namingHelpMeta?.title}
                            </DialogTitle>
                            <DialogContent className={styles.helpContent}>
                                <Text size={200} className={styles.mutedText}>
                                    {namingHelpMeta?.description}
                                    {" "}
                                    Click a token to insert it into the template.
                                </Text>
                                {namingTokenGroups.map((group) => (
                                    <div key={group.section} className={styles.tokenGroup}>
                                        <Text weight="semibold">{group.section}</Text>
                                        <div className={styles.tokenList}>
                                            {group.tokens.map((t) => (
                                                <button
                                                    key={`${group.section}-${t.token}`}
                                                    type="button"
                                                    className={styles.tokenItem}
                                                    onClick={() => insertNamingToken(t)}
                                                >
                                                    <span className={styles.tokenCode}>{t.token}</span>
                                                    <Caption1 className={styles.tokenExample}>
                                                        Example: {t.example}
                                                    </Caption1>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </DialogContent>
                        </DialogBody>
                    </DialogSurface>
                </Dialog>
            </SettingsSection>
    );
};

export default NamingSettingsSection;
