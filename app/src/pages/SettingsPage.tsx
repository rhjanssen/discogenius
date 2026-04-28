import {
    Button,
    Badge,
    Input,
    Select,
    Switch,
    Checkbox,
    Avatar,
    Spinner,
    Text,
    Title1,
    Radio,
    RadioGroup,
    Divider,
    makeStyles,
    mergeClasses,
    tokens,
    Caption1,
    Tooltip,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    Link,
} from "@fluentui/react-components";
import {
    DoorArrowLeft24Regular,
    ArrowImport24Regular,
    WeatherMoon24Regular,
    WeatherSunny24Regular,
    DesktopMac24Regular,
    ArrowSync24Regular,
    ArrowSortDownLines24Regular,
    QuestionCircle24Regular,
    Dismiss24Regular,
} from "@fluentui/react-icons";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useTidalConnection } from "@/hooks/useTidalConnection";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useAppAuth } from "@/providers/appAuthContext";
import { useTheme } from "@/providers/themeContext";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { api } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { ErrorState } from "@/components/ui/ContentState";

import { dispatchActivityRefresh } from "@/utils/appEvents";
import type {
    FilteringConfigContract,
    MonitoringConfigContract,
    MonitoringStatusResponseContract,
    NamingConfigContract,
} from "@contracts/config";
import type { AppReleaseInfoContract } from "@contracts/release";

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

const MIN_RUN_NOW_FEEDBACK_MS = 600;

const ARTIST_NAMING_TOKENS: NamingToken[] = [
    { section: "Artist", token: "{Artist Name}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist CleanName}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist NameThe}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist CleanNameThe}", example: "Daft Punk" },
    { section: "Artist", token: "{Artist NameFirstCharacter}", example: "D" },
    { section: "Artist", token: "{Artist MbId}", example: "056e4f3e-d505-4dad-8ec1-d04f521cbb56" },
    { section: "Artist", token: "{mbid-{Artist MbId}}", example: "{mbid-056e4f3e-d505-4dad-8ec1-d04f521cbb56}" },
    { section: "Artist", token: "{Artist Id}", example: "8847" },
];

const ALBUM_NAMING_TOKENS: NamingToken[] = [
    { section: "Album", token: "{Album Title}", example: "Discovery" },
    { section: "Album", token: "{Album CleanTitle}", example: "Discovery" },
    { section: "Album", token: "{Album TitleThe}", example: "Discovery" },
    { section: "Album", token: "{Album CleanTitleThe}", example: "Discovery" },
    { section: "Album", token: "{Album Type}", example: "Album" },
    { section: "Album", token: "{Album MbId}", example: "0ca7fd24-dc0f-4d16-a5f0-550ad6dd6e53" },
    { section: "Album", token: "{Release Group MbId}", example: "1d5f10c6-4d7f-4f94-b76f-2f61fb5c42f8" },
    { section: "Album", token: "{Album FullTitle}", example: "Discovery (Deluxe)" },
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

const NAMING_HELP: Record<
    NamingFieldKey,
    { title: string; description: string; tokens: NamingToken[] }
> = {
    artist_folder: {
        title: "Artist Folder",
        description: "Template for the artist folder name.",
        tokens: [
            { section: "Formats", token: "{Artist Name} {mbid-{Artist MbId}}", example: "Daft Punk {mbid-056e4f3e-d505-4dad-8ec1-d04f521cbb56}", mode: "replace" },
            { section: "Formats", token: "{Artist CleanNameThe} {mbid-{Artist MbId}}", example: "Daft Punk {mbid-056e4f3e-d505-4dad-8ec1-d04f521cbb56}", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
        ],
    },
    album_track_path_single: {
        title: "Single-volume Album Track Path",
        description: "Relative path (inside the artist folder) for tracks in single-volume albums. Include album folder + track filename (without extension).",
        tokens: [
            { section: "Formats", token: "{Album CleanTitle} ({Release Year})/{track:00} - {Track CleanTitle}", example: "Discovery (2001)/01 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}", example: "Discovery (2001)/Daft Punk - Discovery - 01 - One More Time", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...TRACK_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
        ],
    },
    album_track_path_multi: {
        title: "Multi-volume Album Track Path",
        description: "Relative path (inside the artist folder) for tracks in multi-volume albums. Include album folder + optional disc folder + track filename (without extension).",
        tokens: [
            { section: "Formats", token: "{Album CleanTitle} ({Release Year})/{medium:00}-{track:00} - {Track CleanTitle}", example: "Discovery (2001)/02-01 - One More Time", mode: "replace" },
            { section: "Formats", token: "{Album Title} ({Release Year})/{medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}", example: "Discovery (2001)/02/Daft Punk - Discovery - 01 - One More Time", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            ...ALBUM_NAMING_TOKENS,
            ...TRACK_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
        ],
    },
    video_file: {
        title: "Video File",
        description: "Template for the video filename (without extension).",
        tokens: [
            { section: "Formats", token: "{Artist CleanName} - {Video CleanTitle} {tidal-{Video Id}}", example: "Daft Punk - Around the World {tidal-44187439}", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            { section: "Video", token: "{Video Title}", example: "Around the World" },
            { section: "Video", token: "{Video CleanTitle}", example: "Around the World" },
            { section: "Video", token: "{Video TitleThe}", example: "Around the World" },
            { section: "Video", token: "{Video CleanTitleThe}", example: "Around the World" },
            { section: "Video", token: "{Video Id}", example: "44187439" },
            { section: "Video", token: "{tidal-{Video Id}}", example: "{tidal-44187439}" },
            { section: "Video", token: "{Track Id}", example: "1550546" },
            ...QUALITY_NAMING_TOKENS,
        ],
    },
};

// Section layout helpers
const MEDIA = {
    mobile: '@media (max-width: 640px)',
    desktop: '@media (min-width: 1024px)',
};
const MODAL_LAYOUT = {
    rowPadding: {
        base: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
    qualityPadding: {
        base: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
    controlWidth: {
        compact: '64px',
        standard: '96px',
        wide: '192px',
    },
};

const rowBase = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
    padding: MODAL_LAYOUT.rowPadding.base,
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    [MEDIA.mobile]: {
        padding: MODAL_LAYOUT.rowPadding.mobile,
        columnGap: tokens.spacingHorizontalS,
        rowGap: tokens.spacingVerticalS,
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
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRadius: tokens.borderRadiusMedium,
        padding: tokens.spacingVerticalNone,
        overflow: 'hidden',
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    // Standard row: horizontal layout with title/description left, control right
    row: {
        ...rowBase,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        '&:last-child': {
            borderBottom: 'none',
        },
    },
    fullWidthButton: {
        width: '100%',
        justifyContent: 'center',
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    inlineActionButton: {
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
    },
    templateControl: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        flex: 1,
        minWidth: 0,
    },
    templateInputRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        width: '100%',
    },
    templateHelpButton: {
        flexShrink: 0,
        minWidth: '36px',
        minHeight: '36px',
        [MEDIA.mobile]: {
            minWidth: '40px',
            minHeight: '40px',
        },
    },
    templatePreview: {
        color: tokens.colorNeutralForeground2,
    },
    templateError: {
        color: tokens.colorPaletteRedForeground1,
    },
    // Naming template row - stacked vertical layout (heading/description on top, input below)
    namingRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        '&:last-child': {
            borderBottom: 'none',
        },
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        },
    },
    namingMaintenance: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
    },
    namingBadgeRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
    },
    previewList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        marginTop: tokens.spacingVerticalXS,
    },
    previewItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        background: tokens.colorNeutralBackground3,
        fontFamily: tokens.fontFamilyMonospace,
        fontSize: tokens.fontSizeBase100,
        overflow: 'hidden',
    },
    previewOld: {
        color: tokens.colorPaletteRedForeground1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    previewNew: {
        color: tokens.colorPaletteGreenForeground1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    previewFilename: {
        color: tokens.colorNeutralForeground1,
        fontWeight: tokens.fontWeightSemibold,
        fontFamily: tokens.fontFamilyBase,
        fontSize: tokens.fontSizeBase100,
        marginBottom: '2px',
    },
    previewConflict: {
        color: tokens.colorPaletteYellowForeground1,
        fontSize: tokens.fontSizeBase100,
    },
    namingActionGroup: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        minWidth: '220px',
        [MEDIA.mobile]: {
            width: '100%',
        },
    },
    namingHelpContent: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
    },
    tokenGroup: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
    },
    tokenList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
    },
    tokenRow: {
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        columnGap: tokens.spacingHorizontalM,
        alignItems: 'center',
    },
    tokenCode: {
        fontFamily: tokens.fontFamilyMonospace,
        overflowWrap: 'anywhere',
        whiteSpace: 'normal',
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
    profileRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        flexWrap: 'wrap',
        columnGap: tokens.spacingHorizontalM,
        rowGap: tokens.spacingVerticalS,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        [MEDIA.mobile]: {
            columnGap: tokens.spacingHorizontalS,
            rowGap: tokens.spacingVerticalS,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
        },
    },
    profileInfo: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
        flex: 1,
    },
    profileDetails: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        flex: 1,
    },
    profileActions: {
        display: 'flex',
        justifyContent: 'flex-end',
        marginLeft: 'auto',
        flexShrink: 0,
    },
    signOutButton: {
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    qualityOption: {
        display: 'flex',
        alignItems: 'center',
        padding: MODAL_LAYOUT.qualityPadding.base,
        gap: tokens.spacingHorizontalM,
        cursor: 'pointer',
        width: '100%',
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
    qualityContent: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
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
    mutedTextBlock: {
        color: tokens.colorNeutralForeground2,
        display: 'block',
    },
    divider: {
        marginTop: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalS,
    },
    dialogTitleRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
    },
    optionIconRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
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

interface NamingRenameSample {
    id: number;
    file_type: string;
    file_path: string;
    expected_path: string | null;
    missing: boolean;
    conflict: boolean;
}

interface NamingRenameStatus {
    total: number;
    renameNeeded: number;
    conflicts: number;
    missing: number;
    sample: NamingRenameSample[];
}

interface RetagSampleChange {
    field: string;
    oldValue: string | null;
    newValue: string | null;
}

interface RetagStatusSample {
    id: number;
    path: string;
    missing: boolean;
    changes: RetagSampleChange[];
    error?: string;
}

interface RetagStatus {
    enabled: boolean;
    total: number;
    retagNeeded: number;
    missing: number;
    sample: RetagStatusSample[];
}

type NamingPreviewResponse = Awaited<ReturnType<typeof api.previewNamingConfig>>;

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
        flushNamingSettings,
        accountSettings,
    } = useUserSettings();
    const { isConnected: tidalConnected, isLoading: tidalLoading } = useTidalConnection();
    const { isAuthActive, signOut } = useAppAuth();
    const { theme, setTheme } = useTheme();
    const [monitoringConfig, setMonitoringConfig] = useState<MonitoringConfigContract | null>(null);
    const [monitoringStatus, setMonitoringStatus] = useState<Pick<MonitoringStatusResponseContract, "running" | "checking">>({
        running: false,
        checking: false,
    });
    const [curationConfig, setCurationConfig] = useState<FilteringConfigContract | null>(null);
    const [checkingNow, setCheckingNow] = useState(false);
    const [searchingMissingAlbums, setSearchingMissingAlbums] = useState(false);
    const [importing, setImporting] = useState(false);
    const [scanningRoots, setScanningRoots] = useState(false);
    const [namingHelpField, setNamingHelpField] = useState<NamingFieldKey | null>(null);
    const [releaseInfo, setReleaseInfo] = useState<AppReleaseInfoContract | null>(null);
    const [renameStatus, setRenameStatus] = useState<NamingRenameStatus | null>(null);
    const [renameStatusLoading, setRenameStatusLoading] = useState(false);
    const [renameApplying, setRenameApplying] = useState(false);
    const [renameStatusInitialized, setRenameStatusInitialized] = useState(false);
    const [retagStatus, setRetagStatus] = useState<RetagStatus | null>(null);
    const [retagStatusLoading, setRetagStatusLoading] = useState(false);
    const [retagApplying, setRetagApplying] = useState(false);
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
    const audioRetaggingEnabled =
        metadataSettings?.enable_fingerprinting === true
        || metadataSettings?.write_audio_metadata === true
        || metadataSettings?.embed_replaygain !== false;

    useEffect(() => {
        if (namingSettings) {
            setLocalNaming(namingSettings);
        }
    }, [namingSettings]);

    const handleNamingChange = (key: keyof NamingConfigContract, value: string) => {
        setLocalNaming((prev) => ({ ...prev, [key]: value }));
        setRenameStatus(null);
        setRenameStatusInitialized(false);
    };

    const handleNamingCommit = (key: keyof NamingConfigContract) => {
        if (!namingSettings) {
            return;
        }

        if (localNaming[key] !== namingSettings[key] && !namingPreviewResponse) {
            toast({
                title: "Naming not saved",
                description: "Wait for the backend preview to finish before saving.",
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
            updateNamingSettings({ [key]: localNaming[key] });
        }
    };

    const loadRenameStatus = useCallback(async () => {
        if (!namingPreviewResponse || namingPreviewResponse.valid === false) {
            toast({
                title: "Rename plan blocked",
                description: namingPreviewResponse
                    ? "Fix the naming template errors before refreshing the rename plan."
                    : "Wait for the backend naming preview before refreshing the rename plan.",
                variant: "destructive",
            });
            return;
        }

        setRenameStatusLoading(true);
        try {
            await flushNamingSettings();
            const status = await api.getLibraryRenameStatus({ sampleLimit: 4 });
            setRenameStatus(status as NamingRenameStatus);
        } catch (error: any) {
            toast({
                title: "Rename preview failed",
                description: error.message || "Could not load the rename plan.",
                variant: "destructive",
            });
        } finally {
            setRenameStatusLoading(false);
            setRenameStatusInitialized(true);
        }
    }, [flushNamingSettings, namingPreviewResponse, toast]);

    const handleApplyLibraryNaming = async () => {
        if (!namingPreviewResponse || namingPreviewResponse.valid === false) {
            toast({
                title: "Rename blocked",
                description: namingPreviewResponse
                    ? "Fix the naming template errors before applying naming to the library."
                    : "Wait for the backend naming preview before applying naming to the library.",
                variant: "destructive",
            });
            return;
        }

        setRenameApplying(true);
        try {
            await flushNamingSettings();
            const result: any = await api.applyLibraryRenames({ applyAll: true });
            toast({
                title: "Rename queued",
                description: result?.message || "Queued the library rename task.",
            });
            dispatchActivityRefresh();
        } catch (error: any) {
            toast({
                title: "Failed to queue rename",
                description: error.message || "Could not apply the current naming templates.",
                variant: "destructive",
            });
        } finally {
            setRenameApplying(false);
        }
    };

    const loadRetagStatus = useCallback(async () => {
        setRetagStatusLoading(true);
        try {
            const status = await api.getRetagStatus({ sampleLimit: 4 });
            setRetagStatus(status as RetagStatus);
        } catch (error: any) {
            toast({
                title: "Retag preview failed",
                description: error.message || "Could not load the retag plan.",
                variant: "destructive",
            });
        } finally {
            setRetagStatusLoading(false);
        }
    }, [toast]);

    const handleApplyRetags = async () => {
        setRetagApplying(true);
        try {
            const result: any = await api.applyRetags({ applyAll: true });
            toast({
                title: "Retag queued",
                description: result?.message || "Queued the audio retag task.",
            });
            dispatchActivityRefresh();
        } catch (error: any) {
            toast({
                title: "Failed to queue retag",
                description: error.message || "Could not apply the current metadata tags.",
                variant: "destructive",
            });
        } finally {
            setRetagApplying(false);
        }
    };

    useEffect(() => {
        fetchConfigs();
    }, []);

    useEffect(() => {
        if (!namingSettings || !namingPreviewResponse?.valid || renameStatus || renameStatusLoading || renameStatusInitialized) {
            return;
        }

        loadRenameStatus().catch(() => undefined);
    }, [loadRenameStatus, namingPreviewResponse?.valid, namingSettings, renameStatus, renameStatusInitialized, renameStatusLoading]);

    useEffect(() => {
        if (audioRetaggingEnabled) {
            return;
        }

        setRetagStatus(null);
    }, [audioRetaggingEnabled]);

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

    const fetchConfigs = async () => {
        try {
            const [monStatus, curation] = await Promise.all([
                api.getMonitoringStatus(),
                api.getCurationConfig()
            ]);
            setMonitoringConfig(monStatus.config);
            setMonitoringStatus({
                running: monStatus.running,
                checking: monStatus.checking,
            });
            setCurationConfig(curation);
        } catch (error) {
            console.error('Error fetching configs:', error);
            // Set defaults on error
            setMonitoringConfig({
                enabled: false,
                scanIntervalHours: 24,
                startHour: 2,
                durationHours: 6,
                monitorNewArtists: false,
                removeUnmonitoredFiles: false,
                artistRefreshDays: 30,
                albumRefreshDays: 120,
                trackRefreshDays: 240,
                videoRefreshDays: 365,
            });
            setMonitoringStatus({ running: false, checking: false });
            setCurationConfig({
                include_album: true,
                include_single: true,
                include_ep: true,
                include_compilation: true,
                include_soundtrack: true,
                include_live: true,
                include_remix: false,
                include_appears_on: false,
                include_atmos: false,
                include_videos: true,
                enable_redundancy_filter: true,
                prefer_explicit: true,
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

    const handleCheckNow = async () => {
        setCheckingNow(true);

        try {
            let totalArtists = 0;
            const newAlbumsCount = 0;

            await new Promise((resolve, reject) => {
                const eventSource = api.createMonitoringCheckStream(
                    (event, data) => {

                        switch (event) {
                            case 'status':
                                toast({
                                    title: "Scan Progress",
                                    description: data.message,
                                });
                                break;

                            case 'total':
                                totalArtists = data.total;
                                toast({
                                    title: "Scanning Artists",
                                    description: `Scanning ${totalArtists} artists for new releases...`,
                                });
                                break;

                            case 'artist-progress':
                                break;

                            case 'artist-complete':
                                if (data.newAlbums > 0) {
                                    toast({
                                        title: "New Releases Found",
                                        description: `${data.name}: ${data.newAlbums} new album(s)`,
                                    });
                                }
                                break;

                            case 'complete':
                                eventSource.close();
                                toast({
                                    title: "Scan Complete",
                                    description: `Found ${data.newAlbums} new album(s) from ${data.artists} artists. Use "Download Missing" to start downloads.`,
                                });
                                resolve(data);
                                break;

                            case 'error':
                                toast({
                                    title: "Scan Error",
                                    description: data.message,
                                    variant: "destructive",
                                });
                                break;
                        }
                    },
                    (error) => {
                        eventSource.close();
                        toast({
                            title: "Scan failed",
                            description: error.message || "Could not check for new releases",
                            variant: "destructive",
                        });
                        reject(error);
                    }
                );
            });

            // Refresh status after check
            const status = await api.getMonitoringStatus();
            setMonitoringConfig(status.config);
            setMonitoringStatus({
                running: status.running,
                checking: status.checking,
            });
        } catch (error) {
            console.error('Error checking for new releases:', error);
        } finally {
            setCheckingNow(false);
        }
    };

    const [downloadingMissing, setDownloadingMissing] = useState(false);

    const handleScanRootFolders = async () => {
        setScanningRoots(true);
        try {
            const result: any = await api.scanRootFolders({ monitorArtist: monitoringConfig?.monitorNewArtists ?? true });
            toast({
                title: "Rescan Folders Queued",
                description: result?.message || "Scanning library roots for new artist folders...",
            });
        } catch (error) {
            console.error("Error scanning root folders:", error);
            toast({
                title: "Rescan Folders Failed",
                description: "Could not start folder rescan.",
                variant: "destructive",
            });
        } finally {
            setScanningRoots(false);
        }
    };

    const handleDownloadMissing = async () => {
        setDownloadingMissing(true);
        try {
            const result: any = await api.downloadMissing();
            const total = (result?.albums || 0) + (result?.tracks || 0) + (result?.videos || 0);
            toast({
                title: "Downloads Queued",
                description: result?.message || `Queued ${total} item(s) for download.`,
            });
        } catch (error) {
            console.error("Error queueing downloads:", error);
            toast({
                title: "Download queue failed",
                description: "Could not queue downloads.",
                variant: "destructive",
            });
        } finally {
            setDownloadingMissing(false);
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

    const handleDisconnectTidal = async () => {
        try {
            await api.logoutTidal();
            navigate("/auth");
        } catch (error) {
            console.error('Error disconnecting TIDAL:', error);
        }
    };

    const handleSignOut = () => {
        signOut();
        navigate("/login");
    };

    const handleImportFollowed = async () => {
        setImporting(true);
        try {
            const result: any = await api.importFollowedArtists();
            toast({
                title: "Import Started",
                description: result.message || "Importing followed artists in background.",
            });
        } catch (error) {
            console.error("Error importing followed artists:", error);
            toast({
                title: "Import Failed",
                description: "Could not import followed artists.",
                variant: "destructive",
            });
        } finally {
            setImporting(false);
        }
    };

    if (loading || tidalLoading) {
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
                    description="Discogenius could not load the settings payload. Refresh the page or check the API health if this persists."
                />
            </div>
        );
    }

    const qualityOptions = [
        { value: 'low', label: 'Low', description: 'AAC 96 kbps' },
        { value: 'normal', label: 'Normal', description: 'AAC 320 kbps' },
        { value: 'high', label: 'High', description: 'FLAC 16-bit / 44.1 kHz' },
        { value: 'max', label: 'Max', description: 'Hi-res FLAC up to 24-bit / 192 kHz' },
    ];

    const videoQualityOptions = [
        { value: 'sd', label: 'SD (360p)', description: 'Lower bandwidth' },
        { value: 'hd', label: 'HD (720p)', description: 'Balanced quality' },
        { value: 'fhd', label: 'Full HD (1080p)', description: 'Best available video' },
    ];

    const namingHelpMeta = namingHelpField ? NAMING_HELP[namingHelpField] : null;
    const normalizedVideoThumbnailResolution = metadataSettings?.video_thumbnail_resolution === "origin"
        ? "1080x720"
        : metadataSettings?.video_thumbnail_resolution === "640x360"
            ? "480x320"
            : metadataSettings?.video_thumbnail_resolution === "1280x720"
                ? "1080x720"
                : metadataSettings?.video_thumbnail_resolution || "1080x720";
    const isScanInProgress = checkingNow || monitoringStatus.checking || monitoringConfig?.checkInProgress;

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
        setRenameStatus(null);
        setRenameStatusInitialized(false);
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
    const namingIsInvalid = namingPreviewResponse?.valid === false;
    const namingPreviewPending = Boolean(effectiveNamingSettings && !namingPreviewResponse);
    const namingActionsDisabled = namingIsInvalid || namingPreviewPending;

    const getNamingFieldErrors = (field: NamingFieldKey): string[] => {
        const result = namingPreviewResponse?.validation?.[field];
        return Array.isArray(result?.errors) ? result.errors : [];
    };

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
        ? "A newer Discogenius image is available. Update Docker deployments by pulling the new image and redeploying the container."
        : releaseInfo?.updateStatus === "current"
            ? "This installation is on the latest stable release."
            : "Discogenius could not reach the release feed right now. Docker deployments still update by pulling a newer image and redeploying the container.";

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
            <Switch
                checked={checked}
                onChange={(_, data) => onChange(data.checked)}
                disabled={disabled}
            />
        </div>
    );

    const renderCheckboxRow = ({
        title,
        description,
        checked,
        onChange,
        noDivider = false,
    }: {
        title: string;
        description: React.ReactNode;
        checked: boolean;
        onChange: (checked: boolean) => void;
        noDivider?: boolean;
    }) => (
        <div className={noDivider ? styles.rowNoDivider : styles.row}>
            <Checkbox
                checked={checked}
                onChange={(_, data) => onChange(Boolean(data.checked))}
                label={<>
                    <Text weight="semibold">{title}</Text>
                    <Text size={200} className={styles.mutedTextBlock}>
                        {description}
                    </Text>
                </>}
            />
        </div>
    );

    const curationTypeRows = [
        { key: "include_album", title: "Albums", description: "Standard studio albums" },
        { key: "include_single", title: "Singles", description: "Single track releases" },
        { key: "include_ep", title: "EPs", description: "Extended play releases" },
        { key: "include_compilation", title: "Compilations", description: "Greatest hits, best of, anthologies" },
        { key: "include_soundtrack", title: "Soundtracks", description: "Movie, TV, and game soundtracks" },
        { key: "include_live", title: "Live Albums", description: "Live concert recordings" },
        { key: "include_remix", title: "Remixes", description: "Remix albums and collections" },
    ] as const;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Title1>Settings</Title1>
                <Text className={styles.mutedText}>
                    Manage your Discogenius configuration
                </Text>
            </div>

            <div className={styles.sectionsContainer} data-testid="settings-sections">


                {accountSettings && (
                    <SettingsSection
                        id="account"
                        title="Account"
                        description="Tidal connection and import actions."
                        className={styles.section}
                    >
                        <div className={styles.card}>
                            <div className={styles.profileRow}>
                                <div className={styles.profileInfo}>
                                    <Avatar
                                        name={accountSettings.fullName || accountSettings.username}
                                        image={accountSettings.picture ? { src: accountSettings.picture } : undefined}
                                        size={64}
                                    />
                                    <div className={styles.profileDetails}>
                                        <Text weight="semibold" size={400}>
                                            {accountSettings.firstName && accountSettings.lastName
                                                ? `${accountSettings.firstName} ${accountSettings.lastName}`
                                                : accountSettings.fullName || accountSettings.username}
                                        </Text>
                                        {accountSettings.email && (
                                            <Caption1 className={styles.mutedText}>
                                                {accountSettings.email}
                                            </Caption1>
                                        )}
                                    </div>
                                </div>
                                <div className={styles.profileActions}>
                                    <Tooltip content="Disconnect your TIDAL account" relationship="label">
                                        <Button
                                            appearance="outline"
                                            className={styles.signOutButton}
                                            icon={<DoorArrowLeft24Regular />}
                                            onClick={handleDisconnectTidal}
                                        >
                                            Disconnect TIDAL
                                        </Button>
                                    </Tooltip>
                                    {isAuthActive ? (
                                        <Tooltip content="Sign out of Discogenius app access" relationship="label">
                                            <Button
                                                appearance="subtle"
                                                className={styles.signOutButton}
                                                icon={<DoorArrowLeft24Regular />}
                                                onClick={handleSignOut}
                                            >
                                                Sign out
                                            </Button>
                                        </Tooltip>
                                    ) : null}
                                </div>
                            </div>
                            <div className={styles.row}>
                                <div className={styles.rowContent}>
                                    <Text weight="semibold">Import Followed Artists</Text>
                                    <Text size={200} className={styles.mutedText}>
                                        Add all artists you follow on Tidal to your library
                                    </Text>
                                </div>
                                <Button
                                    appearance="outline"
                                    icon={importing ? <Spinner size="tiny" /> : <ArrowImport24Regular />}
                                    onClick={handleImportFollowed}
                                    disabled={importing}
                                    className={styles.inlineActionButton}
                                >
                                    {importing ? "Importing..." : "Import"}
                                </Button>
                            </div>
                        </div>
                    </SettingsSection>
                )}

                {!accountSettings && isAuthActive ? (
                    <SettingsSection
                        id="app-access"
                        title="App Access"
                        description="Discogenius admin-session controls."
                        className={styles.section}
                    >
                        <div className={styles.card}>
                            <div className={styles.row}>
                                <div className={styles.rowContent}>
                                    <Text weight="semibold">Sign Out Of Discogenius</Text>
                                    <Text size={200} className={styles.mutedText}>
                                        Clear the admin-password session on this browser.
                                    </Text>
                                </div>
                                <Button
                                    appearance="outline"
                                    className={styles.signOutButton}
                                    icon={<DoorArrowLeft24Regular />}
                                    onClick={handleSignOut}
                                >
                                    Sign out
                                </Button>
                            </div>
                        </div>
                    </SettingsSection>
                ) : null}

                {/* Audio Quality */}
                <SettingsSection
                    id="audio-quality"
                    title="Audio Quality"
                    description="Stereo quality for downloaded tracks. Applies to new and upgraded downloads."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        <RadioGroup
                            value={qualitySettings?.audio_quality || 'max'}
                            onChange={(_, data) => updateQualitySettings({
                                audio_quality: data.value as "low" | "normal" | "high" | "max"
                            })}
                        >
                            {qualityOptions.map((option) => (
                                <label key={option.value} className={styles.qualityOption} htmlFor={`quality-${option.value}`}>
                                    <Radio value={option.value} id={`quality-${option.value}`} />
                                    <div className={styles.qualityContent}>
                                        <Text weight="semibold">{option.label}</Text>
                                        <Text size={200} className={styles.mutedText}>
                                            {option.description}
                                        </Text>
                                    </div>
                                </label>
                            ))}
                        </RadioGroup>
                        <Divider className={styles.divider} />
                        {renderToggleRow({
                            title: "Dolby Atmos",
                            description: "Download Atmos versions alongside stereo. Disabling unmonitors Atmos releases on next curation.",
                            checked: curationConfig?.include_atmos === true,
                            onChange: (checked) => updateCuration({ include_atmos: checked }),
                        })}
                    </div>
                </SettingsSection>
                {/* Video Quality */}
                <SettingsSection
                    id="video-quality"
                    title="Video Quality"
                    description="Control music video downloads and resolution."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {renderToggleRow({
                            title: "Music Videos",
                            description: "Download music videos",
                            checked: curationConfig?.include_videos !== false,
                            onChange: (checked) => updateCuration({ include_videos: checked }),
                        })}
                        <RadioGroup
                            value={qualitySettings?.video_quality || 'fhd'}
                            onChange={(_, data) => updateQualitySettings({
                                video_quality: data.value as "sd" | "hd" | "fhd"
                            })}
                            disabled={curationConfig?.include_videos === false}
                        >
                            {videoQualityOptions.map((option) => (
                                <label
                                    key={option.value}
                                    className={mergeClasses(
                                        styles.qualityOption,
                                        curationConfig?.include_videos === false ? styles.qualityOptionDisabled : undefined
                                    )}
                                    htmlFor={`video-quality-${option.value}`}
                                >
                                    <Radio value={option.value} id={`video-quality-${option.value}`} />
                                    <div className={styles.qualityContent}>
                                        <Text weight="semibold">{option.label}</Text>
                                        <Text size={200} className={styles.mutedText}>
                                            {option.description}
                                        </Text>
                                    </div>
                                </label>
                            ))}
                        </RadioGroup>
                    </div>
                </SettingsSection>

                {/* Curation Section */}
                <SettingsSection
                    id="curation"
                    title="Curation"
                    description="Choose what release types to include and how to prioritize versions."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {curationTypeRows.map((row) => renderCheckboxRow({
                            title: row.title,
                            description: row.description,
                            checked: curationConfig?.[row.key] !== false,
                            onChange: (checked) => updateCuration({ [row.key]: checked }),
                            noDivider: true,
                        }))}
                        {renderCheckboxRow({
                            title: "Appears On",
                            description: "Albums where artist is featured",
                            checked: curationConfig?.include_appears_on === true,
                            onChange: (checked) => updateCuration({ include_appears_on: checked }),
                        })}
                        {renderToggleRow({
                            title: "Prefer Explicit",
                            description: "Prefer explicit versions over clean ones",
                            checked: curationConfig?.prefer_explicit !== false,
                            onChange: (checked) => updateCuration({ prefer_explicit: checked }),
                        })}
                        {renderToggleRow({
                            title: "Deduplicate Releases",
                            description: "Unmonitor singles when their tracks appear on a full album",
                            checked: curationConfig?.enable_redundancy_filter !== false,
                            onChange: (checked) => updateCuration({ enable_redundancy_filter: checked }),
                        })}
                        <div className={styles.row}>
                            <Button
                                appearance="outline"
                                className={styles.fullWidthButton}
                                icon={searchingMissingAlbums ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
                                onClick={handleQueueCuration}
                                disabled={searchingMissingAlbums}
                            >
                                {searchingMissingAlbums ? "Queueing..." : "Curate Library"}
                            </Button>
                        </div>
                    </div>
                </SettingsSection>

                {/* Monitoring Section */}
                <SettingsSection
                    id="monitoring"
                    title="Monitoring"
                    description="Schedule automatic scans and cleanup behavior."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {renderToggleRow({
                            title: "Active Monitoring",
                            description: "Check for new releases automatically",
                            checked: monitoringConfig?.enabled || false,
                            onChange: (checked) => updateMonitoring({ enabled: checked }),
                        })}
                        {renderToggleRow({
                            title: "Re-Download On Quality Change",
                            description: "Re-download existing files when quality settings change (e.g. AAC → FLAC or 720p → 1080p)",
                            checked: qualitySettings?.upgrade_existing_files ?? false,
                            onChange: (checked) => updateQualitySettings({ upgrade_existing_files: checked }),
                        })}
                        {renderToggleRow({
                            title: "Monitor Discovered Artists",
                            description: "Auto-monitor artists found during a folder rescan and download their full discography",
                            checked: monitoringConfig?.monitorNewArtists ?? true,
                            onChange: (checked) => updateMonitoring({ monitorNewArtists: checked }),
                        })}
                        {renderToggleRow({
                            title: "Delete Unmonitored Files",
                            description: "Remove files for items that are no longer monitored (e.g. singles replaced by albums, disabled categories)",
                            checked: monitoringConfig?.removeUnmonitoredFiles || false,
                            onChange: (checked) => updateMonitoring({ removeUnmonitoredFiles: checked }),
                        })}
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Scan Interval</Text>
                                <Text size={200} className={styles.mutedText}>
                                    How often to check
                                </Text>
                            </div>
                            <Select
                                value={monitoringConfig?.scanIntervalHours?.toString() || '24'}
                                onChange={(_, data) => updateMonitoring({ scanIntervalHours: Number(data.value) })}
                                disabled={!monitoringConfig?.enabled}
                                className={styles.selectCompact}
                            >
                                <option value="24">Daily</option>
                                <option value="168">Weekly</option>
                                <option value="720">Monthly</option>
                            </Select>
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Start Hour</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Hour of day to start monitoring (0-23)
                                </Text>
                            </div>
                            <Input
                                type="number"
                                min={0}
                                max={23}
                                value={monitoringConfig?.startHour?.toString() || '23'}
                                onChange={(_, data) => updateMonitoring({ startHour: Number(data.value) })}
                                className={styles.inputCompact}
                                disabled={!monitoringConfig?.enabled}
                            />
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Duration (Hours)</Text>
                                <Text size={200} className={styles.mutedText}>
                                    How long the monitoring window lasts
                                </Text>
                            </div>
                            <Input
                                type="number"
                                min={1}
                                max={24}
                                value={monitoringConfig?.durationHours?.toString() || '4'}
                                onChange={(_, data) => updateMonitoring({ durationHours: Number(data.value) })}
                                className={styles.inputCompact}
                                disabled={!monitoringConfig?.enabled}
                            />
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Artist Refresh (Days)</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Minimum days between artist scans
                                </Text>
                            </div>
                            <Input
                                type="number"
                                min={0}
                                value={monitoringConfig?.artistRefreshDays?.toString() || '30'}
                                onChange={(_, data) => updateMonitoring({ artistRefreshDays: Number(data.value) })}
                                className={styles.inputCompact}
                                disabled={!monitoringConfig?.enabled}
                            />
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Album Refresh (Days)</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Minimum days between album metadata refreshes
                                </Text>
                            </div>
                            <Input
                                type="number"
                                min={0}
                                value={monitoringConfig?.albumRefreshDays?.toString() || '60'}
                                onChange={(_, data) => updateMonitoring({ albumRefreshDays: Number(data.value) })}
                                className={styles.inputCompact}
                                disabled={!monitoringConfig?.enabled}
                            />
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Track Refresh (Days)</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Minimum days between track list refreshes
                                </Text>
                            </div>
                            <Input
                                type="number"
                                min={0}
                                value={monitoringConfig?.trackRefreshDays?.toString() || '60'}
                                onChange={(_, data) => updateMonitoring({ trackRefreshDays: Number(data.value) })}
                                className={styles.inputCompact}
                                disabled={!monitoringConfig?.enabled}
                            />
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Video Refresh (Days)</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Minimum days between video refreshes
                                </Text>
                            </div>
                            <Input
                                type="number"
                                min={0}
                                value={monitoringConfig?.videoRefreshDays?.toString() || '60'}
                                onChange={(_, data) => updateMonitoring({ videoRefreshDays: Number(data.value) })}
                                className={styles.inputCompact}
                                disabled={!monitoringConfig?.enabled}
                            />
                        </div>
                        <div className={styles.actionButtonRow}>
                            <Button
                                appearance="outline"
                                className={styles.fullWidthButton}
                                icon={isScanInProgress ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
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
                                disabled={isScanInProgress || downloadingMissing || scanningRoots}
                            >
                                {isScanInProgress ? "Running Task..." : "Run Now"}
                            </Button>
                        </div>
                    </div>
                </SettingsSection>

                {/* Metadata */}
                <SettingsSection
                    id="metadata"
                    title="Metadata"
                    description="Decide what metadata is embedded or saved alongside files."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {renderToggleRow({
                            title: "Embed Tags",
                            description: "Keep track tags in sync with library metadata (title, artist, album, ISRC, barcode, etc.)",
                            checked: metadataSettings?.write_audio_metadata === true,
                            onChange: (checked) => updateMetadataSettings({ write_audio_metadata: checked }),
                        })}

                        {renderToggleRow({
                            title: "Embed ReplayGain Tags",
                            description: "Write ReplayGain gain and peak values into tags",
                            checked: metadataSettings?.embed_replaygain !== false,
                            onChange: (checked) => updateMetadataSettings({ embed_replaygain: checked }),
                        })}

                        {renderToggleRow({
                            title: "Mark Explicit",
                            description: "Append 🅴 to explicit track titles",
                            checked: metadataSettings?.mark_explicit ?? false,
                            onChange: (checked) => updateMetadataSettings({ mark_explicit: checked }),
                        })}

                        {renderToggleRow({
                            title: "Embed Album Cover",
                            description: "Write cover art into supported files",
                            checked: qualitySettings?.embed_cover !== false,
                            onChange: (checked) => updateQualitySettings({ embed_cover: checked }),
                        })}

                        {renderToggleRow({
                            title: "Save Album Covers",
                            description: "Save cover art in the album folder. Animated covers are kept when available.",
                            checked: metadataSettings?.save_album_cover === true,
                            onChange: (checked) => updateMetadataSettings({ save_album_cover: checked }),
                        })}
                        {(metadataSettings?.save_album_cover || qualitySettings?.embed_cover !== false) && (
                            <>
                                {metadataSettings?.save_album_cover && (
                                    <div className={styles.row}>
                                        <div className={styles.rowContent}>
                                            <Text weight="semibold">Filename</Text>
                                        </div>
                                        <Input
                                            value={metadataSettings?.album_cover_name || 'cover.jpg'}
                                            onChange={(_, data) => updateMetadataSettings({ album_cover_name: data.value })}
                                            className={styles.controlMedium}
                                        />
                                    </div>
                                )}
                                <div className={styles.row}>
                                    <div className={styles.rowContent}>
                                        <Text weight="semibold">Cover Resolution</Text>
                                        <Text size={200} className={styles.mutedText}>
                                            Used for both saving and embedding
                                        </Text>
                                    </div>
                                    <Select
                                        value={metadataSettings?.album_cover_resolution?.toString() || 'origin'}
                                        onChange={(_, data) => updateMetadataSettings({
                                            album_cover_resolution: (data.value === 'origin' ? 'origin' : Number(data.value)) as any
                                        })}
                                        className={styles.controlMedium}
                                    >
                                        <option value="80">80x80</option>
                                        <option value="160">160x160</option>
                                        <option value="320">320x320</option>
                                        <option value="640">640x640</option>
                                        <option value="1280">1280x1280</option>
                                        <option value="origin">Original</option>
                                    </Select>
                                </div>
                            </>
                        )}

                        {renderToggleRow({
                            title: "Embed Album Review",
                            description: "Write the album review into the comment tag of each track",
                            checked: metadataSettings?.embed_album_review === true,
                            onChange: (checked) => updateMetadataSettings({ embed_album_review: checked }),
                        })}

                        {renderToggleRow({
                            title: "Save Jellyfin NFO Files",
                            description: "Save artist.nfo, album.nfo, and music-video sidecar NFO files with MusicBrainz IDs",
                            checked: metadataSettings?.save_nfo === true,
                            onChange: (checked) => updateMetadataSettings({ save_nfo: checked }),
                        })}

                        {renderToggleRow({
                            title: "Embed Lyrics",
                            description: "Write lyrics into supported audio files",
                            checked: qualitySettings?.embed_lyrics === true,
                            onChange: (checked) => updateQualitySettings({ embed_lyrics: checked }),
                        })}

                        {renderToggleRow({
                            title: "Save Lyrics",
                            description: "Save lyrics as a sidecar .txt / .lrc file next to the track",
                            checked: metadataSettings?.save_lyrics === true,
                            onChange: (checked) => updateMetadataSettings({ save_lyrics: checked }),
                        })}

                        {(qualitySettings?.embed_lyrics === true || metadataSettings?.save_lyrics === true) && (
                            <RadioGroup
                                value={qualitySettings?.embed_synced_lyrics === true ? 'synced' : 'plain'}
                                onChange={(_, data) => updateQualitySettings({ embed_synced_lyrics: data.value === 'synced' })}
                            >
                                <label className={styles.qualityOption} htmlFor="lyrics-plain">
                                    <Radio value="plain" id="lyrics-plain" />
                                    <div className={styles.qualityContent}>
                                        <Text weight="semibold">Plain</Text>
                                        <Text size={200} className={styles.mutedText}>Unsynchronised text (embedded as-is, saved as .txt)</Text>
                                    </div>
                                </label>
                                <label className={styles.qualityOption} htmlFor="lyrics-synced">
                                    <Radio value="synced" id="lyrics-synced" />
                                    <div className={styles.qualityContent}>
                                        <Text weight="semibold">Synced</Text>
                                        <Text size={200} className={styles.mutedText}>Time-stamped when TIDAL provides them, plain as fallback (saved as .lrc)</Text>
                                    </div>
                                </label>
                            </RadioGroup>
                        )}

                        {renderToggleRow({
                            title: "Save Artist Pictures",
                            description: "Save artist artwork in the artist folder",
                            checked: metadataSettings?.save_artist_picture === true,
                            onChange: (checked) => updateMetadataSettings({ save_artist_picture: checked }),
                        })}
                        {metadataSettings?.save_artist_picture && (
                            <>
                                <div className={styles.row}>
                                    <div className={styles.rowContent}>
                                        <Text weight="semibold">Filename</Text>
                                    </div>
                                    <Input
                                        value={metadataSettings?.artist_picture_name || 'folder.jpg'}
                                        onChange={(_, data) => updateMetadataSettings({ artist_picture_name: data.value })}
                                        className={styles.controlMedium}
                                    />
                                </div>
                                <div className={styles.row}>
                                    <div className={styles.rowContent}>
                                        <Text weight="semibold">Resolution</Text>
                                        <Text size={200} className={styles.mutedText}>
                                            Max resolution 750x750
                                        </Text>
                                    </div>
                                    <Select
                                        value={metadataSettings?.artist_picture_resolution?.toString() || '750'}
                                        onChange={(_, data) => updateMetadataSettings({
                                            artist_picture_resolution: Number(data.value) as any
                                        })}
                                        className={styles.controlMedium}
                                    >
                                        <option value="160">160x160</option>
                                        <option value="320">320x320</option>
                                        <option value="480">480x480</option>
                                        <option value="750">750x750</option>
                                    </Select>
                                </div>
                            </>
                        )}

                        {renderToggleRow({
                            title: "Save Music Video Thumbnails",
                            description: "Save a JPG thumbnail next to each video",
                            checked: metadataSettings?.save_video_thumbnail === true,
                            onChange: (checked) => updateMetadataSettings({ save_video_thumbnail: checked }),
                        })}
                        {renderToggleRow({
                            title: "Embed Music Video Thumbnails",
                            description: "Embed thumbnail into each video file",
                            checked: metadataSettings?.embed_video_thumbnail !== false,
                            onChange: (checked) => updateMetadataSettings({ embed_video_thumbnail: checked }),
                        })}
                        {metadataSettings?.save_video_thumbnail && (
                            <div className={styles.row}>
                                <div className={styles.rowContent}>
                                    <Text weight="semibold">Resolution</Text>
                                </div>
                                <Select
                                    value={normalizedVideoThumbnailResolution}
                                    onChange={(_, data) => updateMetadataSettings({
                                        video_thumbnail_resolution: data.value as any
                                    })}
                                    className={styles.controlMedium}
                                >
                                    <option value="160x107">160x107</option>
                                    <option value="480x320">480x320</option>
                                    <option value="750x500">750x500</option>
                                    <option value="1080x720">1080x720</option>
                                </Select>
                            </div>
                        )}

                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">UPC Target Tag</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Choose the field name Discogenius uses when it writes album barcodes.
                                </Text>
                            </div>
                            <Select
                                value={metadataSettings?.upc_target || 'BARCODE'}
                                onChange={(_, data) => updateMetadataSettings({ upc_target: data.value as any })}
                                className={styles.controlMedium}
                            >
                                <option value="UPC">UPC</option>
                                <option value="EAN">EAN</option>
                                <option value="BARCODE">Barcode</option>
                            </Select>
                        </div>

                        {renderToggleRow({
                            title: "Embed TIDAL URL",
                            description: "Write the TIDAL track URL into audio metadata",
                            checked: metadataSettings?.write_tidal_url ?? true,
                            onChange: (checked) => updateMetadataSettings({ write_tidal_url: checked }),
                        })}

                        {renderToggleRow({
                            title: "Audio Fingerprinting",
                            description: "Generate fpcalc fingerprints and match tracks via AcoustID and MusicBrainz",
                            checked: metadataSettings?.enable_fingerprinting === true,
                            onChange: (checked) => updateMetadataSettings({ enable_fingerprinting: checked }),
                        })}

                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Apply Current Audio Tag Rules To Library</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Preview and apply the current audio-tag and ReplayGain rules to tracked music files already in the library.
                                </Text>
                                <div className={styles.namingBadgeRow}>
                                    <Badge appearance="outline" color="brand">
                                        {retagStatus?.total ?? 0} tracked
                                    </Badge>
                                    <Badge appearance="outline" color={(retagStatus?.retagNeeded ?? 0) > 0 ? "warning" : "success"}>
                                        {retagStatus?.retagNeeded ?? 0} need retag
                                    </Badge>
                                    <Badge appearance="outline" color={(retagStatus?.missing ?? 0) > 0 ? "warning" : "informative"}>
                                        {retagStatus?.missing ?? 0} missing
                                    </Badge>
                                </div>
                                {retagStatus?.sample?.length ? (
                                    <div className={styles.previewList}>
                                        {retagStatus.sample.map((sample) => {
                                            const name = sample.path.split(/[\\/]/).pop() || sample.path;
                                            return (
                                                <div key={sample.id} className={styles.previewItem}>
                                                    <span className={styles.previewFilename}>{name}</span>
                                                    {sample.missing ? (
                                                        <span className={styles.previewOld}>— missing on disk</span>
                                                    ) : sample.changes.map((change) => (
                                                        <React.Fragment key={change.field}>
                                                            <span className={styles.previewOld}>- {change.field}: {change.oldValue ?? "(empty)"}</span>
                                                            <span className={styles.previewNew}>+ {change.field}: {change.newValue ?? "(empty)"}</span>
                                                        </React.Fragment>
                                                    ))}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : retagStatus && !retagStatusLoading && audioRetaggingEnabled ? (
                                    <Text size={200} className={styles.mutedText}>No retag work detected.</Text>
                                ) : !audioRetaggingEnabled ? (
                                    <Text size={200} className={styles.mutedText}>Enable fingerprinting, audio tag correction, or ReplayGain to generate a retag plan.</Text>
                                ) : null}
                            </div>
                            <div className={styles.namingActionGroup}>
                                <Button
                                    appearance="outline"
                                    icon={retagStatusLoading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                                    onClick={() => loadRetagStatus()}
                                    disabled={retagStatusLoading || retagApplying || !audioRetaggingEnabled}
                                >
                                    Refresh plan
                                </Button>
                                <Button
                                    appearance="primary"
                                    icon={retagApplying ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
                                    onClick={() => handleApplyRetags()}
                                    disabled={
                                        retagStatusLoading
                                        || retagApplying
                                        || !audioRetaggingEnabled
                                        || (retagStatus?.retagNeeded ?? 0) === 0
                                    }
                                >
                                    Apply to library
                                </Button>
                            </div>
                        </div>
                    </div>
                </SettingsSection>

                {/* Storage */}
                <SettingsSection
                    id="storage"
                    title="Storage"
                    description="Set the paths where your organized library is stored."
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
                                value={pathSettings?.music_path || ''}
                                onChange={(_, data) => updatePathSettings({ music_path: data.value })}
                                className={styles.pathInput}
                            />
                        </div>
                        <div className={styles.divider} />
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Atmos Library Path</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Dolby Atmos surround library
                                </Text>
                            </div>
                            <Input
                                value={pathSettings?.atmos_path || ''}
                                onChange={(_, data) => updatePathSettings({ atmos_path: data.value })}
                                className={styles.pathInput}
                            />
                        </div>
                        <div className={styles.divider} />
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Video Library Path</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Music videos library
                                </Text>
                            </div>
                            <Input
                                value={pathSettings?.video_path || ''}
                                onChange={(_, data) => updatePathSettings({ video_path: data.value })}
                                className={styles.pathInput}
                            />
                        </div>
                    </div>
                </SettingsSection>

                {/* Naming */}
                <SettingsSection
                    id="naming"
                    title="Naming"
                    description="Use templates to organize your library. Click the ? buttons to see available tokens and examples."
                    className={styles.section}
                >
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
                                        value={localNaming?.artist_folder ?? ''}
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
                                            icon={<QuestionCircle24Regular />}
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
                                        value={localNaming?.album_track_path_single ?? ''}
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
                                            icon={<QuestionCircle24Regular />}
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
                                        value={localNaming?.album_track_path_multi ?? ''}
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
                                            icon={<QuestionCircle24Regular />}
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
                                        value={localNaming?.video_file ?? ''}
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
                                            icon={<QuestionCircle24Regular />}
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
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Apply Current Naming To Library</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Refresh the rename plan after changing templates, then apply it to move existing files and remove empty leftover folders.
                                </Text>
                                <div className={styles.namingBadgeRow}>
                                    <Badge appearance="outline" color="brand">
                                        {renameStatus?.total ?? 0} tracked
                                    </Badge>
                                    <Badge appearance="outline" color={(renameStatus?.renameNeeded ?? 0) > 0 ? "warning" : "success"}>
                                        {renameStatus?.renameNeeded ?? 0} need rename
                                    </Badge>
                                    <Badge appearance="outline" color={(renameStatus?.conflicts ?? 0) > 0 ? "warning" : "informative"}>
                                        {renameStatus?.conflicts ?? 0} conflicts
                                    </Badge>
                                    <Badge appearance="outline" color={(renameStatus?.missing ?? 0) > 0 ? "warning" : "informative"}>
                                        {renameStatus?.missing ?? 0} missing
                                    </Badge>
                                </div>
                                {renameStatus?.sample?.length ? (
                                    <div className={styles.previewList}>
                                        {renameStatus.sample.map((sample) => {
                                            const name = sample.file_path.split(/[\\/]/).pop() || sample.file_path;
                                            return (
                                                <div key={sample.id} className={styles.previewItem}>
                                                    <span className={styles.previewFilename}>{name}</span>
                                                    {sample.missing ? (
                                                        <span className={styles.previewOld}>— missing on disk</span>
                                                    ) : sample.conflict ? (
                                                        <>
                                                            <span className={styles.previewOld}>- {sample.file_path}</span>
                                                            <span className={styles.previewConflict}>⚠ {sample.expected_path ?? "conflict"}</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span className={styles.previewOld}>- {sample.file_path}</span>
                                                            <span className={styles.previewNew}>+ {sample.expected_path ?? "—"}</span>
                                                        </>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : renameStatus && !renameStatusLoading ? (
                                    <Text size={200} className={styles.mutedText}>No rename work detected for the current naming templates.</Text>
                                ) : null}
                            </div>
                            <div className={styles.namingActionGroup}>
                                <Button
                                    appearance="outline"
	                                    icon={renameStatusLoading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
	                                    onClick={() => loadRenameStatus()}
	                                    disabled={renameStatusLoading || renameApplying || !namingSettings || namingActionsDisabled}
	                                >
                                    Refresh plan
                                </Button>
                                <Button
                                    appearance="primary"
                                    icon={renameApplying ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
                                    onClick={() => handleApplyLibraryNaming()}
                                    disabled={
	                                        renameStatusLoading
	                                        || renameApplying
	                                        || !namingSettings
	                                        || namingActionsDisabled
	                                        || (renameStatus?.renameNeeded ?? 0) === 0
	                                    }
                                >
                                    Apply to library
                                </Button>
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
                                        <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setNamingHelpField(null)} />
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

                {/* Appearance */}
                <SettingsSection
                    id="appearance"
                    title="Appearance"
                    description="Choose the theme used across the app."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        <RadioGroup
                            value={theme}
                            onChange={(_, data) => setTheme(data.value as any)}
                        >
                            <label className={styles.qualityOption} htmlFor="theme-light">
                                <Radio value="light" id="theme-light" />
                                <div className={styles.qualityContent}>
                                    <div className={styles.optionIconRow}>
                                        <WeatherSunny24Regular />
                                        <Text weight="semibold">Light</Text>
                                    </div>
                                </div>
                            </label>
                            <label className={styles.qualityOption} htmlFor="theme-dark">
                                <Radio value="dark" id="theme-dark" />
                                <div className={styles.qualityContent}>
                                    <div className={styles.optionIconRow}>
                                        <WeatherMoon24Regular />
                                        <Text weight="semibold">Dark</Text>
                                    </div>
                                </div>
                            </label>
                            <label className={styles.qualityOption} htmlFor="theme-system">
                                <Radio value="system" id="theme-system" />
                                <div className={styles.qualityContent}>
                                    <div className={styles.optionIconRow}>
                                        <DesktopMac24Regular />
                                        <Text weight="semibold">System</Text>
                                    </div>
                                </div>
                            </label>
                        </RadioGroup>
                    </div>
                </SettingsSection>

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
