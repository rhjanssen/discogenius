import {
    Button,
    Caption1,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Input,
    Select,
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
    { section: "Artist", token: "{Artist Name}", example: "Bastille" },
    { section: "Artist", token: "{Artist CleanName}", example: "Bastille" },
    { section: "Artist", token: "{Artist NameThe}", example: "Bastille, The" },
    { section: "Artist", token: "{Artist CleanNameThe}", example: "Bastille, The" },
    { section: "Artist", token: "{Artist NameFirstCharacter}", example: "B" },
    { section: "Artist", token: "{Artist Disambiguation}", example: "British pop rock band" },
    { section: "Artist", token: "{Artist Genre}", example: "Indie Pop" },
    { section: "Artist", token: "{Artist MbId}", example: "7808accb-6395-4b25-858c-678bbb73896b" },
    { section: "Artist", token: "{mbid-{Artist MbId}}", example: "{mbid-7808accb-6395-4b25-858c-678bbb73896b}" },
    { section: "Artist", token: "{Artist Id}", example: "8847" },
];

const ALBUM_NAMING_TOKENS: NamingToken[] = [
    { section: "Album", token: "{Album Title}", example: "Bad Blood" },
    { section: "Album", token: "{Album CleanTitle}", example: "Bad Blood" },
    { section: "Album", token: "{Album TitleThe}", example: "Bad Blood, The" },
    { section: "Album", token: "{Album CleanTitleThe}", example: "Bad Blood, The" },
    { section: "Album", token: "{Album Type}", example: "Album" },
    { section: "Album", token: "{Album Disambiguation}", example: "first studio album" },
    { section: "Album", token: "{Album Genre}", example: "Indie Pop" },
    { section: "Album", token: "{Album MbId}", example: "5b591b9a-4c28-444a-aab4-cd61be5bb5fb" },
    { section: "Album", token: "{Release Group MbId}", example: "5b591b9a-4c28-444a-aab4-cd61be5bb5fb" },
    { section: "Album", token: "{Album Id}", example: "1550545" },
];

const EDITION_NAMING_TOKENS: NamingToken[] = [
    { section: "Edition", token: "{Edition Title}", example: "Bad Blood (The Extended Cut)" },
    { section: "Edition", token: "{Edition CleanTitle}", example: "Bad Blood The Extended Cut" },
    { section: "Edition", token: "{Edition TitleThe}", example: "Bad Blood (The Extended Cut), The" },
    { section: "Edition", token: "{Edition CleanTitleThe}", example: "Bad Blood The Extended Cut, The" },
    { section: "Edition", token: "{Edition Disambiguation}", example: "deluxe edition" },
    { section: "Edition", token: "{Release Title}", example: "Bad Blood (The Extended Cut)" },
    { section: "Edition", token: "{Release Disambiguation}", example: "deluxe edition" },
];

const RELEASE_DATE_NAMING_TOKENS: NamingToken[] = [
    { section: "Release Date", token: "{Release Year}", example: "2013" },
    { section: "Release Date", token: "{Album Year}", example: "2013" },
    { section: "Release Date", token: "{Original Year}", example: "2013" },
    { section: "Release Date", token: "{Edition Year}", example: "2013" },
];

const MEDIUM_NAMING_TOKENS: NamingToken[] = [
    { section: "Medium", token: "{medium:0}", example: "1" },
    { section: "Medium", token: "{medium:00}", example: "01" },
    { section: "Medium", token: "{medium:000}", example: "001" },
    { section: "Medium Format", token: "{Medium Name}", example: "Disc 1" },
    { section: "Medium Format", token: "{Medium Format}", example: "CD" },
];

const TRACK_NAMING_TOKENS: NamingToken[] = [
    { section: "Track", token: "{track:0}", example: "1" },
    { section: "Track", token: "{track:00}", example: "01" },
    { section: "Track", token: "{track:000}", example: "001" },
    { section: "Track", token: "{Track Id}", example: "1550546" },
    { section: "Track", token: "{Track MbId}", example: "8f1b4f76-8c53-4f28-bb73-0e1d1b97a3ef" },
    { section: "Track", token: "{Recording MbId}", example: "9f2c5e0a-32b1-4f30-9d96-1c8a2c1efb10" },
    { section: "Track", token: "{Recording Id}", example: "42" },
    { section: "Track", token: "{Media Id}", example: "1550546" },
    { section: "Track Title", token: "{Track Title}", example: "Pompeii" },
    { section: "Track Title", token: "{Track CleanTitle}", example: "Pompeii" },
    { section: "Track Title", token: "{Track TitleThe}", example: "Pompeii" },
    { section: "Track Title", token: "{Track CleanTitleThe}", example: "Pompeii" },
];

const TRACK_ARTIST_NAMING_TOKENS: NamingToken[] = [
    { section: "Track Artist", token: "{Track ArtistName}", example: "Bastille" },
    { section: "Track Artist", token: "{Track ArtistCleanName}", example: "Bastille" },
    { section: "Track Artist", token: "{Track ArtistNameThe}", example: "Bastille, The" },
    { section: "Track Artist", token: "{Track ArtistCleanNameThe}", example: "Bastille, The" },
    { section: "Track Artist", token: "{Track ArtistMbId}", example: "7808accb-6395-4b25-858c-678bbb73896b" },
];

const QUALITY_NAMING_TOKENS: NamingToken[] = [
    { section: "Quality", token: "{Quality Full}", example: "FLAC Proper" },
    { section: "Quality", token: "{Quality Title}", example: "FLAC" },
    { section: "Quality", token: "{Quality Proper}", example: "Proper" },
    { section: "Quality", token: "{Quality}", example: "LOSSLESS" },
];

const MEDIAINFO_NAMING_TOKENS: NamingToken[] = [
    { section: "MediaInfo", token: "{MediaInfo AudioCodec}", example: "FLAC" },
    { section: "MediaInfo", token: "{MediaInfo AudioChannels}", example: "2.0" },
    { section: "MediaInfo", token: "{MediaInfo AudioBitRate}", example: "320 kbps" },
    { section: "MediaInfo", token: "{MediaInfo AudioBitsPerSample}", example: "16bit" },
    { section: "MediaInfo", token: "{MediaInfo AudioSampleRate}", example: "44.1kHz" },
    { section: "MediaInfo", token: "{Codec}", example: "FLAC" },
    { section: "MediaInfo", token: "{Channels}", example: "2" },
    { section: "MediaInfo", token: "{Bitrate}", example: "320" },
    { section: "MediaInfo", token: "{BitDepth}", example: "16" },
    { section: "MediaInfo", token: "{SampleRate}", example: "44100" },
    { section: "MediaInfo", token: "{SampleRate:kHz}", example: "44.1" },
    { section: "MediaInfo", token: "{Explicit}", example: "(Explicit)" },
    { section: "MediaInfo", token: "{E}", example: "[E]" },
];

const ORIGINAL_NAMING_TOKENS: NamingToken[] = [
    { section: "Original", token: "{Original Title}", example: "Bastille - Bad Blood - 01 - Pompeii" },
    { section: "Original", token: "{Original Filename}", example: "01 - Pompeii" },
    { section: "Original", token: "{Release Group}", example: "FLAC-GRP" },
];

const PROVIDER_NAMING_TOKENS: NamingToken[] = [
    { section: "Provider", token: "{Provider Name}", example: "TIDAL" },
    { section: "Provider", token: "{Provider ArtistId}", example: "8847" },
    { section: "Provider", token: "{Provider AlbumId}", example: "1550545" },
    { section: "Provider", token: "{Provider TrackId}", example: "1550546" },
    { section: "Provider", token: "{Provider MediaId}", example: "1550546" },
    { section: "Provider", token: "{Provider VideoId}", example: "44187439" },
];

const VIDEO_NAMING_TOKENS: NamingToken[] = [
    { section: "Video", token: "{Video Title}", example: "Pompeii" },
    { section: "Video", token: "{Video CleanTitle}", example: "Pompeii" },
    { section: "Video", token: "{Video TitleThe}", example: "Pompeii" },
    { section: "Video", token: "{Video CleanTitleThe}", example: "Pompeii" },
    { section: "Video", token: "{Video Type}", example: "-video" },
    { section: "Video", token: "{Video Id}", example: "44187439" },
    { section: "Video", token: "{Track Id}", example: "1550546" },
];

const NAMING_HELP: Record<
    NamingFieldKey,
    { title: string; description: string; tokens: NamingToken[] }
> = {
    artist_folder: {
        title: "Artist Folder Tokens",
        description: "Name of the artist folder under each library root.",
        tokens: [
            { section: "File Names", token: "{Artist Name}", example: "Bastille", mode: "replace" },
            { section: "File Names", token: "{Artist CleanName}", example: "Bastille", mode: "replace" },
            { section: "File Names", token: "{Artist CleanNameThe}", example: "Bastille, The", mode: "replace" },
            { section: "File Names", token: "{Artist Name} {mbid-{Artist MbId}}", example: "Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}", mode: "replace" },
            { section: "File Names", token: "{Artist CleanNameThe} {mbid-{Artist MbId}}", example: "Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
        ],
    },
    album_track_path_single: {
        title: "Single-volume Track Format Tokens",
        description: "Path under the artist folder for tracks on single-disc albums (album folder + filename, without extension).",
        tokens: [
            { section: "File Names", token: "{Edition Title} ({Release Year})/{track:00} - {Track Title}", example: "Bad Blood (2013)/01 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Edition Title} ({Edition Disambiguation}) ({Release Year})/{track:00} - {Track Title}", example: "Bad Blood (deluxe edition) (2013)/01 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Album Title} ({Release Year})/{track:00} - {Track Title}", example: "Bad Blood (2013)/01 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}", example: "Bad Blood (2013)/Bastille - Bad Blood - 01 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Artist Name} - {Album Title} - {track:00} - {Track Title} {Quality Full}", example: "Bastille - Bad Blood - 01 - Pompeii FLAC Proper", mode: "replace" },
            { section: "File Names", token: "{Artist.Name}.{Album.Title}.{track:00}.{TrackClean.Title}.{Quality.Full}", example: "Bastille.Bad.Blood.01.Pompeii.FLAC.Proper", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...EDITION_NAMING_TOKENS,
            ...RELEASE_DATE_NAMING_TOKENS,
            ...TRACK_NAMING_TOKENS,
            ...TRACK_ARTIST_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...MEDIAINFO_NAMING_TOKENS,
            ...ORIGINAL_NAMING_TOKENS,
            ...PROVIDER_NAMING_TOKENS,
        ],
    },
    album_track_path_multi: {
        title: "Multi-volume Track Format Tokens",
        description: "Path under the artist folder for multi-disc albums (album folder, optional disc folder, and track filename).",
        tokens: [
            { section: "File Names", token: "{Edition Title} ({Release Year})/{medium:0}{track:00} - {Track Title}", example: "Bad Blood (2013)/201 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Album Title} ({Release Year})/{medium:0}{track:00} - {Track Title}", example: "Bad Blood (2013)/201 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Album Title} ({Release Year})/{medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}", example: "Bad Blood (2013)/02/Bastille - Bad Blood - 01 - Pompeii", mode: "replace" },
            { section: "File Names", token: "{Album Title} ({Release Year})/{Medium Format} {medium:0}/{track:00} - {Track Title}", example: "Bad Blood (2013)/CD 2/01 - Pompeii", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...EDITION_NAMING_TOKENS,
            ...RELEASE_DATE_NAMING_TOKENS,
            ...MEDIUM_NAMING_TOKENS,
            ...TRACK_NAMING_TOKENS,
            ...TRACK_ARTIST_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...MEDIAINFO_NAMING_TOKENS,
            ...ORIGINAL_NAMING_TOKENS,
            ...PROVIDER_NAMING_TOKENS,
        ],
    },
    video_file: {
        title: "Music Video File Tokens",
        description: "Filename for music videos (without extension). Include {Video Type} (e.g. -video, -live, -lyrics) so media servers can classify extras.",
        tokens: [
            { section: "File Names", token: "{Video Title}{Video Type} {{Provider Name}-{Provider VideoId}}", example: "Pompeii-video {TIDAL-12345}", mode: "replace" },
            { section: "File Names", token: "{Artist Name} - {Video Title}{Video Type}", example: "Bastille - Pompeii-video", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...VIDEO_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...EDITION_NAMING_TOKENS,
            ...RELEASE_DATE_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...MEDIAINFO_NAMING_TOKENS,
            ...ORIGINAL_NAMING_TOKENS,
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
    helpSurface: {
        width: "min(680px, calc(100vw - 32px))",
        maxWidth: "680px",
        maxHeight: "85vh",
    },
    helpHeader: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    selectorsRow: {
        display: "flex",
        gap: tokens.spacingHorizontalM,
        width: "100%",
        [MEDIA.mobile]: {
            flexDirection: "column",
            gap: tokens.spacingVerticalS,
        },
    },
    selectorControl: {
        flex: 1,
        minWidth: 0,
    },
    helpContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        minWidth: 0,
        maxWidth: "100%",
        overflowX: "hidden",
        paddingTop: tokens.spacingVerticalS,
    },
    tokenGroup: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        minWidth: 0,
    },
    tokenList: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: tokens.spacingVerticalXS,
        minWidth: 0,
        [MEDIA.mobile]: {
            gridTemplateColumns: "1fr",
        },
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
    modalFooter: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        width: "100%",
        paddingTop: tokens.spacingVerticalM,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        [MEDIA.mobile]: {
            flexDirection: "column",
            alignItems: "stretch",
            gap: tokens.spacingVerticalS,
        },
    },
    modalFooterInput: {
        flex: 1,
        minWidth: 0,
        fontFamily: tokens.fontFamilyMonospace,
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
    const [tokenSeparator, setTokenSeparator] = useState<string>(" ");
    const [tokenCase, setTokenCase] = useState<"title" | "lower" | "upper">("title");

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
    const modalInputRef = useRef<HTMLInputElement | null>(null);
    const [modalSelection, setModalSelection] = useState<{ start: number; end: number } | null>(null);

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

    const captureModalSelection = () => {
        const input = modalInputRef.current;
        if (!input) return;
        setModalSelection({
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
        });
    };

    const transformToken = (rawToken: string, isFullPattern: boolean): string => {
        let value = rawToken;
        if (isFullPattern) {
            if (tokenSeparator !== " ") {
                value = value.replace(/ /g, tokenSeparator);
            }
        } else {
            value = value.replace(/ /g, tokenSeparator);
        }

        if (tokenCase === "lower") {
            value = value.toLowerCase();
        } else if (tokenCase === "upper") {
            value = value.toUpperCase();
        }
        return value;
    };

    const transformExample = (rawExample: string): string => {
        let value = rawExample.replace(/ /g, tokenSeparator);
        if (tokenCase === "lower") {
            value = value.toLowerCase();
        } else if (tokenCase === "upper") {
            value = value.toUpperCase();
        }
        return value;
    };

    const insertNamingToken = (item: NamingToken) => {
        if (!namingHelpField || !namingSettings) return;
        const current = (localNaming as any)[namingHelpField] || "";
        const transformed = transformToken(item.token, item.mode === "replace");

        const range = modalSelection ?? namingSelectionRef.current[namingHelpField];
        const hasSelection = Boolean(
            range
            && range.start >= 0
            && range.end >= range.start
            && range.end <= current.length,
        );
        const next = item.mode === "replace"
            ? transformed
            : hasSelection
                ? `${current.slice(0, range!.start)}${transformed}${current.slice(range!.end)}`
                : `${current}${transformed}`;
        const cursor = item.mode === "replace"
            ? transformed.length
            : hasSelection
                ? range!.start + transformed.length
                : next.length;

        setLocalNaming((prev) => ({ ...prev, [namingHelpField]: next }));
        setModalSelection({ start: cursor, end: cursor });
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
        };
    })() : null;

    const getNamingFieldErrors = (field: NamingFieldKey): string[] => {
        const result = namingPreviewResponse?.validation?.[field];
        return Array.isArray(result?.errors) ? result.errors : [];
    };

    const closeNamingModal = () => {
        if (namingHelpField) {
            handleNamingCommit(namingHelpField);
        }
        setNamingHelpField(null);
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
                            Single Track: <span className={styles.tokenCode}>{namingExamples?.trackPathSingle ?? "—"}</span>
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
                            Multi Disc Track: <span className={styles.tokenCode}>{namingExamples?.trackPathMulti ?? "—"}</span>
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
                            Example: <span className={styles.tokenCode}>{namingExamples?.videoFile ?? "—"}</span>
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
                    if (!data.open) closeNamingModal();
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
                                    onClick={closeNamingModal}
                                />
                            }
                        >
                            <div className={styles.helpHeader}>
                                <div>{namingHelpMeta?.title}</div>
                                <div className={styles.selectorsRow}>
                                    <Select
                                        aria-label="Token Separator"
                                        value={tokenSeparator}
                                        onChange={(_, data) => setTokenSeparator(data.value)}
                                        className={styles.selectorControl}
                                    >
                                        <option value=" ">Space ( )</option>
                                        <option value=".">Period (.)</option>
                                        <option value="_">Underscore (_)</option>
                                        <option value="-">Dash (-)</option>
                                    </Select>
                                    <Select
                                        aria-label="Token Case"
                                        value={tokenCase}
                                        onChange={(_, data) => setTokenCase(data.value as "title" | "lower" | "upper")}
                                        className={styles.selectorControl}
                                    >
                                        <option value="title">Default Case</option>
                                        <option value="lower">Lowercase</option>
                                        <option value="upper">Uppercase</option>
                                    </Select>
                                </div>
                            </div>
                        </DialogTitle>
                        <DialogContent className={styles.helpContent}>
                            <Text size={200} className={styles.mutedText}>
                                {namingHelpMeta?.description}{" "}
                                Click any token to insert it into the template below.
                            </Text>
                            {namingTokenGroups.map((group) => (
                                <div key={group.section} className={styles.tokenGroup}>
                                    <Text weight="semibold">{group.section}</Text>
                                    <div className={styles.tokenList}>
                                        {group.tokens.map((t) => {
                                            const formattedToken = transformToken(t.token, t.mode === "replace");
                                            const formattedExample = transformExample(t.example);
                                            return (
                                                <button
                                                    key={`${group.section}-${t.token}`}
                                                    type="button"
                                                    className={styles.tokenItem}
                                                    onClick={() => insertNamingToken(t)}
                                                >
                                                    <span className={styles.tokenCode}>{formattedToken}</span>
                                                    <Caption1 className={styles.tokenExample}>
                                                        Example: {formattedExample}
                                                    </Caption1>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </DialogContent>
                        <DialogActions className={styles.modalFooter} position="start">
                            <Input
                                aria-label="Current template format"
                                ref={modalInputRef}
                                value={namingHelpField ? (localNaming[namingHelpField] ?? "") : ""}
                                onChange={(_, data) => {
                                    if (namingHelpField) {
                                        handleNamingChange(namingHelpField, data.value);
                                    }
                                }}
                                onFocus={captureModalSelection}
                                onSelect={captureModalSelection}
                                onKeyUp={captureModalSelection}
                                className={styles.modalFooterInput}
                            />
                            <Button appearance="primary" onClick={closeNamingModal}>
                                Close
                            </Button>
                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>
        </SettingsSection>
    );
};

export default NamingSettingsSection;
