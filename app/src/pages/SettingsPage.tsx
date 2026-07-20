import {
    Button,
    Badge,
    Field,
    Input,
    Select,
    Switch,
    Checkbox,
    Radio,
    RadioGroup,
    Spinner,
    Text,
    Title1,
    Divider,
    makeStyles,
    tokens,
    Caption1,
    Tooltip,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    DialogActions,
    Link,
} from "@fluentui/react-components";
import {
  DoorArrowLeft24Regular as DoorArrowLeft24RegularBase,
  ArrowImport24Regular as ArrowImport24RegularBase,
  WeatherMoon24Regular as WeatherMoon24RegularBase,
  WeatherSunny24Regular as WeatherSunny24RegularBase,
  DesktopMac24Regular as DesktopMac24RegularBase,
  ArrowSync24Regular as ArrowSync24RegularBase,
  ArrowSortDownLines24Regular as ArrowSortDownLines24RegularBase,
  QuestionCircle24Regular as QuestionCircle24RegularBase,
  Dismiss24Regular as Dismiss24RegularBase,
  Open24Regular as Open24RegularBase,
  ChevronDown24Regular as ChevronDown24RegularBase,
  ChevronUp24Regular as ChevronUp24RegularBase,
  DoorArrowLeft24Filled,
  ArrowImport24Filled,
  WeatherMoon24Filled,
  WeatherSunny24Filled,
  DesktopMac24Filled,
  ArrowSync24Filled,
  ArrowSortDownLines24Filled,
  QuestionCircle24Filled,
  Dismiss24Filled,
  Open24Filled,
  ChevronDown24Filled,
  ChevronUp24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { ProviderMark } from "@/components/ui/ProviderMark";
import { providerMarkFor } from "@/components/ui/providerMarks";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ImportArtistsModal } from "@/components/ui/ImportArtistsModal";
import { videoCapabilityLabel, videoTierFromMaxHeight } from "@/utils/qualityTier";
import { useProviderConnection } from "@/hooks/useProviderConnection";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useAppAuth } from "@/providers/appAuthContext";
import { useTheme } from "@/providers/themeContext";
import { useQuery } from "@tanstack/react-query";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { api, type StreamingProviderStatus } from "@/services/api";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { ErrorState } from "@/components/ui/ContentState";
import {
    RenamePreviewDialog,
    RetagPreviewDialog,
    type RenamePreviewItem,
    type RetagPreviewItem,
} from "@/components/mediafiles/FileMaintenanceDialogs";

import { dispatchActivityRefresh } from "@/utils/appEvents";
import type {
    CatalogConfigContract,
    FilteringConfigContract,
    MonitoringConfigContract,
    MonitoringStatusResponseContract,
    NamingConfigContract,
} from "@contracts/config";
import type { AppReleaseInfoContract } from "@contracts/release";

const DoorArrowLeft24Regular = bundleIcon(DoorArrowLeft24Filled, DoorArrowLeft24RegularBase);
const ArrowImport24Regular = bundleIcon(ArrowImport24Filled, ArrowImport24RegularBase);
const WeatherMoon24Regular = bundleIcon(WeatherMoon24Filled, WeatherMoon24RegularBase);
const WeatherSunny24Regular = bundleIcon(WeatherSunny24Filled, WeatherSunny24RegularBase);
const DesktopMac24Regular = bundleIcon(DesktopMac24Filled, DesktopMac24RegularBase);
const ArrowSync24Regular = bundleIcon(ArrowSync24Filled, ArrowSync24RegularBase);
const ArrowSortDownLines24Regular = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24RegularBase);
const QuestionCircle24Regular = bundleIcon(QuestionCircle24Filled, QuestionCircle24RegularBase);
const Dismiss24Regular = bundleIcon(Dismiss24Filled, Dismiss24RegularBase);
const Open24Regular = bundleIcon(Open24Filled, Open24RegularBase);
const ChevronDown24Regular = bundleIcon(ChevronDown24Filled, ChevronDown24RegularBase);
const ChevronUp24Regular = bundleIcon(ChevronUp24Filled, ChevronUp24RegularBase);

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
            { section: "Formats", token: "{Album CleanTitle} ({Release Year})/{track:00} - {Track CleanTitle}", example: "Discovery (2001)/01 - One More Time", mode: "replace" },
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
            { section: "Formats", token: "{Album CleanTitle} ({Release Year})/{medium:0}{track:00} - {Track CleanTitle}", example: "Discovery (2001)/201 - One More Time", mode: "replace" },
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
        description: "Filename for music videos (no extension). A type suffix such as -video, -live, or -lyrics is added automatically so media servers can recognize extras.",
        tokens: [
            { section: "Formats", token: "{Artist CleanName} - {Video CleanTitle} {{ProviderName}-{ProviderVideoId}}", example: "Daft Punk - Around the World {Apple Music-12345}", mode: "replace" },
            ...ARTIST_NAMING_TOKENS,
            { section: "Video", token: "{Video Title}", example: "Around the World" },
            { section: "Video", token: "{Video CleanTitle}", example: "Around the World" },
            { section: "Video", token: "{Video TitleThe}", example: "Around the World" },
            { section: "Video", token: "{Video CleanTitleThe}", example: "Around the World" },
            { section: "Video", token: "{Video Id}", example: "44187439" },
            { section: "Video", token: "{Track Id}", example: "1550546" },
            ...ALBUM_NAMING_TOKENS,
            ...QUALITY_NAMING_TOKENS,
            ...PROVIDER_NAMING_TOKENS,
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
        // Fluent settings rows: equal vertical padding so title/description
        // sit balanced with the trailing control (not cramped toward the bottom).
        base: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
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
    subsectionHeader: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
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
        ...glassButtonStyles,
        width: '100%',
        justifyContent: 'center',
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    inlineActionButton: {
        ...glassButtonStyles,
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
        paddingTop: tokens.spacingVerticalXXS,
    },
    rowControl: {
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        minHeight: '32px',
        paddingTop: tokens.spacingVerticalXXS,
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
        ...glassButtonStyles,
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
    maintenanceDialog: {
        width: 'min(860px, calc(100vw - 32px))',
        maxWidth: '860px',
    },
    maintenanceDialogList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        maxHeight: '56vh',
        overflowY: 'auto',
        marginTop: tokens.spacingVerticalM,
    },
    maintenanceDialogRow: {
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr)',
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    maintenanceDialogSummary: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalXS,
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
    // Dense checklist (release types): single-line labels, not full settings rows.
    checkboxList: {
        display: 'grid',
        gridTemplateColumns: '1fr',
        paddingTop: tokens.spacingVerticalXS,
        paddingBottom: tokens.spacingVerticalS,
        [MEDIA.desktop]: {
            gridTemplateColumns: '1fr 1fr',
        },
    },
    checkboxRow: {
        display: 'flex',
        alignItems: 'center',
        minHeight: '28px',
        padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
        },
    },
    checkboxRowWithDescription: {
        ...rowBase,
        alignItems: 'flex-start',
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        '&:last-child': {
            borderBottom: 'none',
        },
    },
    checkboxLabelStack: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
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
        gap: tokens.spacingHorizontalS,
        flexWrap: 'wrap',
        marginLeft: 'auto',
        flexShrink: 0,
    },
    providerStatusRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
        flex: 1,
        minWidth: '220px',
    },
    providerIconBox: {
        width: '48px',
        height: '48px',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
    },
    providerIcon: {
        width: '30px',
        height: '30px',
        objectFit: 'contain',
    },
    capabilitySummaryGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))',
        gap: tokens.spacingHorizontalS,
        width: '100%',
        [MEDIA.mobile]: {
            gridTemplateColumns: '1fr',
        },
    },
    capabilitySummaryItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground2,
        minWidth: 0,
    },
    capabilitySummaryValue: {
        fontWeight: tokens.fontWeightSemibold,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        minHeight: '22px',
    },
    providerActionRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    signOutButton: {
        minHeight: '36px',
        [MEDIA.mobile]: {
            minHeight: '40px',
        },
    },
    qualityOption: {
        display: 'flex',
        alignItems: 'flex-start',
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
        paddingTop: tokens.spacingVerticalXXS,
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

type NamingRenameSample = RenamePreviewItem;

interface NamingRenameStatus {
    total: number;
    scanned: number;
    limited: boolean;
    renameNeeded: number;
    conflicts: number;
    missing: number;
    sample: NamingRenameSample[];
}

interface NamingRenamePreviewResponse {
    items: NamingRenameSample[];
}

type RetagStatusSample = RetagPreviewItem;

interface RetagStatus {
    enabled: boolean;
    total: number;
    scanned: number;
    limited: boolean;
    retagNeeded: number;
    missing: number;
    sample: RetagStatusSample[];
}

interface RetagPreviewResponse {
    items: RetagStatusSample[];
}

type NamingPreviewResponse = Awaited<ReturnType<typeof api.previewNamingConfig>>;

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

const SettingsPage = () => {
    const styles = useStyles();
    const navigate = useNavigate();
    const openProviderAuth = () => navigate("/auth", {
        state: { mode: "add-provider", from: { pathname: "/settings" } },
    });
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
    const { theme, setTheme } = useTheme();
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
    const [importProviderId, setImportProviderId] = useState<string | null>(null);
    const [detailsProviderId, setDetailsProviderId] = useState<string | null>(null);
    const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
    const [savingProviderOrder, setSavingProviderOrder] = useState(false);
    const [namingHelpField, setNamingHelpField] = useState<NamingFieldKey | null>(null);
    const [releaseInfo, setReleaseInfo] = useState<AppReleaseInfoContract | null>(null);
    const [renameStatus, setRenameStatus] = useState<NamingRenameStatus | null>(null);
    const [renameStatusLoading, setRenameStatusLoading] = useState(false);
    const [renameApplying, setRenameApplying] = useState(false);
    const [renameStatusInitialized, setRenameStatusInitialized] = useState(false);
    const [renamePreviewOpen, setRenamePreviewOpen] = useState(false);
    const [renamePreviewItems, setRenamePreviewItems] = useState<NamingRenameSample[]>([]);
    const [retagStatus, setRetagStatus] = useState<RetagStatus | null>(null);
    const [retagStatusLoading, setRetagStatusLoading] = useState(false);
    const [retagApplying, setRetagApplying] = useState(false);
    const [retagStatusInitialized, setRetagStatusInitialized] = useState(false);
    const [retagPreviewOpen, setRetagPreviewOpen] = useState(false);
    const [retagPreviewItems, setRetagPreviewItems] = useState<RetagStatusSample[]>([]);
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
    const writeAudioTagsPolicy = metadataSettings?.write_audio_tags_policy ?? "no";
    const audioRetaggingEnabled =
        metadataSettings?.enable_fingerprinting === true
        || writeAudioTagsPolicy !== "no"
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
            updateNamingSettings({ [key]: localNaming[key] });
        }
    };

    const getCurrentNamingSettings = useCallback((): Partial<NamingConfigContract> => ({
        ...localNaming,
        artist_folder: namingInputRefs.current.artist_folder?.value ?? localNaming.artist_folder,
        album_track_path_single: namingInputRefs.current.album_track_path_single?.value ?? localNaming.album_track_path_single,
        album_track_path_multi: namingInputRefs.current.album_track_path_multi?.value ?? localNaming.album_track_path_multi,
        video_file: namingInputRefs.current.video_file?.value ?? localNaming.video_file,
    }), [localNaming]);

    const loadRenameStatus = useCallback(async () => {
        if (!namingPreviewResponse || namingPreviewResponse.valid === false) {
            toast({
                title: "Rename plan blocked",
                description: namingPreviewResponse
                    ? "Fix the naming template errors before refreshing the rename plan."
                    : "Wait for the naming preview before refreshing the rename plan.",
                variant: "destructive",
            });
            return;
        }

        setRenameStatusLoading(true);
        try {
            await flushNamingSettings(getCurrentNamingSettings());
            const status = await api.getLibraryRenameStatus({ sampleLimit: 8, scanLimit: 1000 });
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
    }, [flushNamingSettings, getCurrentNamingSettings, namingPreviewResponse, toast]);

    const openRenamePreview = async () => {
        if (!namingPreviewResponse || namingPreviewResponse.valid === false) {
            toast({
                title: "Rename preview blocked",
                description: namingPreviewResponse
                    ? "Fix the naming template errors before previewing naming changes."
                    : "Wait for the naming preview before previewing naming changes.",
                variant: "destructive",
            });
            return;
        }

        setRenameStatusLoading(true);
        try {
            await flushNamingSettings(getCurrentNamingSettings());
            const response = await api.getLibraryRenamePreview({ limit: 1000 }) as NamingRenamePreviewResponse;
            const items = response.items.filter((item) => item.missing || item.conflict || item.needs_rename);
            setRenamePreviewItems(items);
            setRenamePreviewOpen(true);
            await loadRenameStatus();
        } catch (error: any) {
            toast({
                title: "Rename preview failed",
                description: error.message || "Could not load the rename preview.",
                variant: "destructive",
            });
        } finally {
            setRenameStatusLoading(false);
        }
    };

    const handleApplyLibraryNaming = async (ids?: number[]) => {
        if (!namingPreviewResponse || namingPreviewResponse.valid === false) {
            toast({
                title: "Rename blocked",
                description: namingPreviewResponse
                    ? "Fix the naming template errors before applying naming to the library."
                    : "Wait for the naming preview before applying naming to the library.",
                variant: "destructive",
            });
            return;
        }

        setRenameApplying(true);
        try {
            await flushNamingSettings(getCurrentNamingSettings());
            const result: any = await api.applyLibraryRenames(ids ? { ids } : { applyAll: true });
            toast({
                title: "Rename queued",
                description: result?.message || "Queued the library rename task.",
            });
            dispatchActivityRefresh();
            setRenamePreviewOpen(false);
            window.setTimeout(() => void loadRenameStatus(), 1500);
            window.setTimeout(() => void loadRenameStatus(), 5000);
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
            const status = await api.getRetagStatus({ sampleLimit: 8, scanLimit: 1000 });
            setRetagStatus(status as RetagStatus);
            setRetagStatusInitialized(true);
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

    const openRetagPreview = async () => {
        setRetagStatusLoading(true);
        try {
            const response = await api.getRetagPreview({ limit: 1000 }) as RetagPreviewResponse;
            setRetagPreviewItems(response.items);
            setRetagPreviewOpen(true);
            await loadRetagStatus();
        } catch (error: any) {
            toast({
                title: "Retag preview failed",
                description: error.message || "Could not load the retag preview.",
                variant: "destructive",
            });
        } finally {
            setRetagStatusLoading(false);
        }
    };

    const handleApplyRetags = async (ids?: number[]) => {
        setRetagApplying(true);
        try {
            const result: any = await api.applyRetags(ids ? { ids } : { applyAll: true });
            toast({
                title: "Retag queued",
                description: result?.message || "Queued the audio retag task.",
            });
            dispatchActivityRefresh();
            setRetagPreviewOpen(false);
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
        setRetagStatusInitialized(false);
    }, [audioRetaggingEnabled]);

    useEffect(() => {
        if (!audioRetaggingEnabled || retagStatus || retagStatusLoading || retagStatusInitialized) {
            return;
        }

        loadRetagStatus().catch(() => undefined);
    }, [audioRetaggingEnabled, loadRetagStatus, retagStatus, retagStatusInitialized, retagStatusLoading]);

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
            console.error('Error fetching configs:', error);
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

    const updateCatalog = async (updates: Partial<CatalogConfigContract>) => {
        const previous = catalogConfig;
        setCatalogConfig((current) => (current ? { ...current, ...updates } : current));
        setCatalogTest({ status: "idle" });
        try {
            await api.updateCatalogConfig(updates);
        } catch (error) {
            console.error('Error updating catalog config:', error);
            setCatalogConfig(previous);
            toast({
                title: "Error",
                description: "Failed to update metadata source.",
                variant: "destructive"
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

    const handleDisconnectProvider = async (providerId: string, providerName: string) => {
        try {
            await api.logoutProvider(providerId);
            await refetchStreamingProviders();
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

    const handleSignOut = () => {
        signOut();
        navigate("/login");
    };

    const handleImportComplete = () => {
        dispatchActivityRefresh();
        toast({
            title: "Import complete",
            description: "The artist list has been refreshed.",
        });
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
                    description="Discogenius could not load the settings payload. Refresh the page or check the API health if this persists."
                />
            </div>
        );
    }

    const qualityOptions = [
        { value: 'low', label: 'Low', description: 'Smaller files, lower quality' },
        { value: 'normal', label: 'Normal', description: 'Good quality for everyday listening' },
        { value: 'high', label: 'High', description: 'CD quality (lossless)' },
        { value: 'max', label: 'Max', description: 'Highest available quality (hi-res when offered)' },
    ];

    const videoQualityOptions = [
        { value: 'sd', label: 'SD (480p)', disabled: false },
        { value: 'hd', label: 'HD (720p)', disabled: false },
        { value: 'fhd', label: 'Full HD (1080p)', disabled: false },
        { value: 'uhd', label: 'Ultra HD (2160p)', disabled: false },
    ];

    const namingHelpMeta = namingHelpField ? NAMING_HELP[namingHelpField] : null;
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
            <div className={styles.rowControl}>
                <Switch
                    checked={checked}
                    onChange={(_, data) => onChange(data.checked)}
                    disabled={disabled}
                />
            </div>
        </div>
    );

    const renderCheckboxRow = ({
        title,
        description,
        checked,
        onChange,
        rowKey,
    }: {
        title: string;
        description?: React.ReactNode;
        checked: boolean;
        onChange: (checked: boolean) => void;
        rowKey?: string;
    }) => (
        <div
            key={rowKey}
            className={description ? styles.checkboxRowWithDescription : styles.checkboxRow}
        >
            <Checkbox
                checked={checked}
                onChange={(_, data) => onChange(Boolean(data.checked))}
                label={description ? (
                    <span className={styles.checkboxLabelStack}>
                        <Text weight="semibold">{title}</Text>
                        <Text size={200} className={styles.mutedTextBlock}>
                            {description}
                        </Text>
                    </span>
                ) : title}
            />
        </div>
    );

    const primaryReleaseTypeRows = [
        { key: "include_album", title: "Albums" },
        { key: "include_ep", title: "EPs" },
        { key: "include_single", title: "Singles" },
        { key: "include_broadcast", title: "Broadcasts" },
        { key: "include_other", title: "Other primary types" },
    ] as const;

    const secondaryReleaseTypeRows = [
        { key: "include_compilation", title: "Compilations" },
        { key: "include_soundtrack", title: "Soundtracks" },
        { key: "include_live", title: "Live" },
        { key: "include_remix", title: "Remix" },
        { key: "include_dj_mix", title: "DJ-mix" },
        { key: "include_mixtape_street", title: "Mixtape/Street" },
        { key: "include_demo", title: "Demo" },
    ] as const;

    // The list order IS the provider preference: first = default provider and
    // the winner of equal-quality matching tie-breaks.
    const persistProviderOrder = async (orderedIds: string[]) => {
        setSavingProviderOrder(true);
        try {
            await api.updateProviderPriority(orderedIds);
            await refetchStreamingProviders();
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
        const providers = streamingProviders?.providers ?? [];
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
        const ids = (streamingProviders?.providers ?? []).map((provider) => provider.id);
        const from = ids.indexOf(draggingProviderId);
        const to = ids.indexOf(targetProviderId);
        setDraggingProviderId(null);
        if (from === -1 || to === -1) return;
        ids.splice(from, 1);
        ids.splice(to, 0, draggingProviderId);
        void persistProviderOrder(ids);
    };

    const getProviderCapabilitySummary = (provider: StreamingProviderStatus) => {
        const caps = provider.capabilities;

        const stereoBadge = caps.hiResStereo
            ? "HIRES_LOSSLESS"
            : caps.losslessStereo
                ? "LOSSLESS"
                : caps.lossyStereo
                    ? (provider.id === "youtube-music" ? "YOUTUBE_LOSSY" : "MP3_320")
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

    const metadataSource = catalogConfig?.source ?? "servarr";
    const metadataSourceSection = (
        <SettingsSection
            id="metadata-source"
            title="Metadata source"
            description="Choose where artist, album, and track details come from."
            className={styles.section}
        >
            <div className={styles.card}>
                <RadioGroup
                    value={metadataSource}
                    onChange={(_, data) => updateCatalog({ source: data.value as "servarr" | "musicbrainz" })}
                >
                    <label className={styles.qualityOption} htmlFor="metadata-source-servarr">
                        <Radio value="servarr" id="metadata-source-servarr" />
                        <div className={styles.qualityContent}>
                            <Text weight="semibold">Servarr Metadata</Text>
                            <Text size={200} className={styles.mutedText}>
                                Hosted catalog — easy setup. Some releases and codes (ISRC/UPC) may be missing.
                            </Text>
                        </div>
                    </label>
                    <label className={styles.qualityOption} htmlFor="metadata-source-musicbrainz">
                        <Radio value="musicbrainz" id="metadata-source-musicbrainz" />
                        <div className={styles.qualityContent}>
                            <Text weight="semibold">MusicBrainz (local)</Text>
                            <Text size={200} className={styles.mutedText}>
                                Your own MusicBrainz mirror — fuller release data and better matching.
                            </Text>
                        </div>
                    </label>
                </RadioGroup>
                {metadataSource === "musicbrainz" ? (
                    <>
                        <Divider className={styles.divider} />
                        <Field
                            label="MusicBrainz host"
                            hint="Hostname or IP only. Discogenius uses the standard MusicBrainz ports automatically."
                            validationState={
                                catalogTest.status === "ok" ? "success"
                                    : catalogTest.status === "error" ? "error"
                                        : "none"
                            }
                            validationMessage={
                                catalogTest.status === "ok" || catalogTest.status === "error"
                                    ? catalogTest.message
                                    : undefined
                            }
                        >
                            <Input
                                value={catalogConfig?.musicbrainz_host ?? ""}
                                placeholder="192.168.1.100 or musicbrainz.mydomain.com"
                                onChange={(_, data) => setCatalogConfig((current) => (current ? { ...current, musicbrainz_host: data.value } : current))}
                                onBlur={() => { if (catalogConfig) { void updateCatalog({ musicbrainz_host: catalogConfig.musicbrainz_host }); } }}
                            />
                        </Field>
                        <Button
                            appearance="secondary"
                            style={{ marginTop: tokens.spacingVerticalS, alignSelf: "flex-start" }}
                            disabled={catalogTest.status === "testing" || !catalogConfig?.musicbrainz_host}
                            icon={catalogTest.status === "testing" ? <Spinner size="tiny" /> : undefined}
                            onClick={() => { void testCatalogConnection(); }}
                        >
                            Test connection
                        </Button>
                    </>
                ) : null}
            </div>
        </SettingsSection>
    );

    const detailsProvider = (streamingProviders?.providers ?? []).find((provider) => provider.id === detailsProviderId) || null;

    const streamingProvidersSection = (
        <SettingsSection
            id="streaming-providers"
            title="Streaming Providers"
            description="Connect download services. Drag to set preference — higher entries win when quality is equal."
            className={styles.section}
        >
            <div className={styles.card}>
                {(() => {
                    const allProviders = streamingProviders?.providers ?? [];
                    // Only connected services get a row; everything else is
                    // reachable through the always-visible "Add Provider" flow.
                    const activeProviders = allProviders.filter(p => p.authenticated);

                    if (providersLoadFailed) {
                        return (
                            <ErrorState
                                minHeight="220px"
                                title="Streaming providers unavailable"
                                error={providersLoadError instanceof Error
                                    ? providersLoadError
                                    : "Discogenius could not load the provider registry."}
                                actions={(
                                    <Button
                                        appearance="outline"
                                        icon={providersFetching ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                                        disabled={providersFetching}
                                        onClick={() => { void refetchStreamingProviders(); }}
                                    >
                                        Retry
                                    </Button>
                                )}
                            />
                        );
                    }

                    if (activeProviders.length === 0 && !providersLoading) {
                        return (
                            <div className={styles.profileRow} style={{ justifyContent: 'center', padding: '32px 16px' }}>
                                <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                                    <div>
                                        <Text weight="semibold" size={400} block style={{ marginBottom: '4px' }}>
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
                                        icon={<Open24Regular />}
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
                                                <div style={{ display: 'flex', flexDirection: 'column' }} aria-label={`Reorder ${provider.name}`}>
                                                    <Button
                                                        appearance="subtle"
                                                        size="small"
                                                        icon={<ChevronUp24Regular />}
                                                        aria-label={`Move ${provider.name} up`}
                                                        disabled={savingProviderOrder || index === 0}
                                                        onClick={() => moveProvider(provider.id, -1)}
                                                    />
                                                    <Button
                                                        appearance="subtle"
                                                        size="small"
                                                        icon={<ChevronDown24Regular />}
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
                                                    icon={<ArrowImport24Regular />}
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
                                <div className={styles.profileRow} style={{ justifyContent: 'center' }}>
                                    <Button
                                        appearance="outline"
                                        icon={<Open24Regular />}
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
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
                                {detailsProvider && providerMarkFor(detailsProvider.id) ? (
                                    <ProviderMark provider={detailsProvider.id} size={24} />
                                ) : null}
                                {detailsProvider?.name}
                            </span>
                        </DialogTitle>
                        <DialogContent>
                            {detailsProvider ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <div className={styles.optionIconRow}>
                                        <Badge appearance="filled" color={detailsProvider.authenticated ? "success" : "subtle"}>
                                            {detailsProvider.authenticated ? "Connected" : "Not connected"}
                                        </Badge>
                                        {detailsProvider.isDefault ? (
                                            <Badge appearance="tint" color="informative">Default provider</Badge>
                                        ) : null}
                                    </div>
                                    <div className={styles.capabilitySummaryGrid}>
                                        {getProviderCapabilitySummary(detailsProvider).map((capability) => (
                                            <div key={capability.label} className={styles.capabilitySummaryItem}>
                                                <Caption1 className={styles.mutedText}>{capability.label}</Caption1>
                                                <div className={styles.capabilitySummaryValue}>
                                                    {capability.badgeQuality ? (
                                                        <QualityBadge quality={capability.badgeQuality} size="large" />
                                                    ) : (
                                                        <Text size={200}>Not available</Text>
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
                                    icon={<DoorArrowLeft24Regular />}
                                    onClick={() => {
                                        setDetailsProviderId(null);
                                        handleDisconnectProvider(detailsProvider.id, detailsProvider.name);
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
    );

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Title1>Settings</Title1>
            </div>

            <div className={styles.sectionsContainer} data-testid="settings-sections">


                {isAuthActive ? (
                    <SettingsSection
                        id="app-access"
                        title="App Access"
                        description="Sign-in for this browser session."
                        className={styles.section}
                    >
                        <div className={styles.card}>
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
                                    icon={<DoorArrowLeft24Regular />}
                                    onClick={handleSignOut}
                                >
                                    Sign out
                                </Button>
                                </div>
                            </div>
                        </div>
                    </SettingsSection>
                ) : null}

                {/* Audio Quality */}
                <SettingsSection
                    id="audio-quality"
                    title="Audio quality"
                    description="Preferred quality for new stereo downloads and upgrades."
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
                            title: "Spatial audio",
                            description: "Also keep Dolby Atmos or other spatial versions when available.",
                            checked: curationConfig?.include_spatial === true,
                            onChange: (checked) => updateCuration({ include_spatial: checked }),
                        })}
                    </div>
                </SettingsSection>
                {/* Video Quality */}
                <SettingsSection
                    id="video-quality"
                    title="Music videos"
                    description="Whether to download videos and at which resolution."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        {renderToggleRow({
                            title: "Download music videos",
                            description: "Include official videos in the library when a service offers them.",
                            checked: curationConfig?.include_videos === true,
                            onChange: (checked) => updateCuration({ include_videos: checked }),
                        })}
                        <RadioGroup
                            value={qualitySettings?.video_quality || 'uhd'}
                            onChange={(_, data) => updateQualitySettings({
                                video_quality: data.value as "sd" | "hd" | "fhd" | "uhd"
                            })}
                        >
                            {videoQualityOptions.map((option) => (
                                <label
                                    key={option.value}
                                    className={styles.qualityOption}
                                    htmlFor={`video-quality-${option.value}`}
                                >
                                    <Radio value={option.value} id={`video-quality-${option.value}`} disabled={option.disabled} />
                                    <div className={styles.qualityContent}>
                                        <Text weight="semibold">{option.label}</Text>
                                        {option.disabled ? (
                                            <Text size={200} className={styles.mutedText}>
                                                No connected service offers this resolution
                                            </Text>
                                        ) : null}
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
                    description="Which release types to keep, and how to choose between versions."
                    className={styles.section}
                >
                    <div className={styles.card}>
                        <div className={styles.subsectionHeader}>
                            <Text weight="semibold">Primary release types</Text>
                        </div>
                        <div className={styles.checkboxList}>
                            {primaryReleaseTypeRows.map((row) => renderCheckboxRow({
                                rowKey: row.key,
                                title: row.title,
                                checked: curationConfig?.[row.key] !== false,
                                onChange: (checked) => updateCuration({ [row.key]: checked }),
                            }))}
                        </div>
                        <Divider className={styles.divider} />
                        <div className={styles.subsectionHeader}>
                            <Text weight="semibold">Secondary release types</Text>
                        </div>
                        <div className={styles.checkboxList}>
                            {secondaryReleaseTypeRows.map((row) => renderCheckboxRow({
                                rowKey: row.key,
                                title: row.title,
                                checked: curationConfig?.[row.key] === true,
                                onChange: (checked) => updateCuration({ [row.key]: checked }),
                            }))}
                        </div>
                        <Divider className={styles.divider} />
                        {renderToggleRow({
                            title: "Prefer explicit",
                            description: "Choose explicit editions when both clean and explicit are available.",
                            checked: curationConfig?.prefer_explicit !== false,
                            onChange: (checked) => updateCuration({ prefer_explicit: checked }),
                        })}
                        {renderToggleRow({
                            title: "Hide redundant singles",
                            description: "Skip singles when those tracks already appear on an album.",
                            checked: curationConfig?.enable_redundancy_filter !== false,
                            onChange: (checked) => updateCuration({ enable_redundancy_filter: checked }),
                        })}
                        {renderToggleRow({
                            title: "Require a download source",
                            description: "Only keep releases that at least one connected service can download.",
                            checked: curationConfig?.require_provider_availability === true,
                            onChange: (checked) => updateCuration({ require_provider_availability: checked }),
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
                    description="Automatic checks for new music and library cleanup."
                    className={styles.section}
                >
                    <div className={styles.card}>
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
                            checked: monitoringConfig?.monitorNewArtists ?? true,
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
                                disabled={isScanInProgress}
                            >
                                {isScanInProgress ? "Running Task..." : "Run Now"}
                            </Button>
                        </div>
                    </div>
                </SettingsSection>

                {/* Metadata */}
                <SettingsSection
                    id="metadata"
                    title="Metadata & extras"
                    description="What to write into files and keep beside them in the library."
                    className={styles.section}
                >
                    <div className={styles.card}>
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
                                    setRetagStatus(null);
                                    setRetagStatusInitialized(false);
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
                                <option value="canonical">Catalog (MusicBrainz / Fanart)</option>
                                <option value="provider">Streaming service</option>
                            </Select>
                            </div>
                        </div>

                        {renderToggleRow({
                            title: "Save NFO files",
                            description: "Write sidecar info files for apps like Jellyfin and Kodi.",
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
                            description: "Keep a thumbnail image next to each music video (Plex/Jellyfin-friendly).",
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
                            onChange: (checked) => {
                                updateMetadataSettings({ enable_fingerprinting: checked });
                                setRetagStatus(null);
                                setRetagStatusInitialized(false);
                            },
                        })}

                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Update Tags On Existing Files</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Re-apply the settings above to files already in your library. Preview the changes first, then run it.
                                </Text>
                                <div className={styles.namingBadgeRow}>
                                    <Badge appearance="outline" color="brand">
                                        {retagStatus?.total ?? 0} tracked
                                    </Badge>
                                    {retagStatus?.limited ? (
                                        <Badge appearance="outline" color="informative">
                                            {retagStatus.scanned} scanned
                                        </Badge>
                                    ) : null}
                                    <Badge appearance="outline" color={(retagStatus?.retagNeeded ?? 0) > 0 ? "warning" : "success"}>
                                        {retagStatus?.retagNeeded ?? 0}{retagStatus?.limited ? " in scan" : ""} need retag
                                    </Badge>
                                    <Badge appearance="outline" color={(retagStatus?.missing ?? 0) > 0 ? "warning" : "informative"}>
                                        {retagStatus?.missing ?? 0}{retagStatus?.limited ? " in scan" : ""} missing
                                    </Badge>
                                </div>
                                {retagStatus && !retagStatusLoading && audioRetaggingEnabled && (retagStatus.retagNeeded ?? 0) === 0 ? (
                                    <Text size={200} className={styles.mutedText}>
                                        {retagStatus.limited ? "No retag work detected in the fast scan." : "No retag work detected."}
                                    </Text>
                                ) : !audioRetaggingEnabled ? (
                                    <Text size={200} className={styles.mutedText}>Enable tag writing, ReplayGain, or fingerprinting to generate a retag plan.</Text>
                                ) : null}
                            </div>
                            <div className={styles.namingActionGroup}>
                                <Button
                                    appearance="outline"
                                    icon={retagStatusLoading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                                    onClick={() => void loadRetagStatus()}
                                    disabled={retagStatusLoading || retagApplying || !audioRetaggingEnabled}
                                >
                                    Scan library
                                </Button>
                                <Button
                                    appearance="outline"
                                    icon={retagStatusLoading ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
                                    onClick={() => openRetagPreview()}
                                    disabled={retagStatusLoading || retagApplying || !audioRetaggingEnabled}
                                >
                                    Preview changes
                                </Button>
                            </div>
                        </div>
                    </div>
                </SettingsSection>

                {/* Storage */}
                <SettingsSection
                    id="storage"
                    title="Storage"
                    description="Folders where Discogenius stores your organized music and videos."
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
                                <Text weight="semibold">Spatial Library Path</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Spatial and surround music library
                                </Text>
                            </div>
                            <Input
                                value={pathSettings?.spatial_path || ''}
                                onChange={(_, data) => updatePathSettings({ spatial_path: data.value })}
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
                        <div className={styles.divider} />
                        <div className={styles.row}>
                            <div className={styles.rowContent}>
                                <Text weight="semibold">Video Folder Layout</Text>
                                <Text size={200} className={styles.mutedText}>
                                    Keep videos in their own library, or store them alongside each artist's music.
                                </Text>
                            </div>
                            <Select
                                value={pathSettings?.video_folder_layout || 'separated'}
                                onChange={(_, data) => updatePathSettings({ video_folder_layout: data.value as 'separated' | 'inline' })}
                                className={styles.controlMedium}
                            >
                                <option value="separated">Separated Library</option>
                                <option value="inline">Inline with Audio Tracks</option>
                            </Select>
                        </div>
                        <div className={styles.divider} />
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
                </SettingsSection>

                {/* Naming */}
                <SettingsSection
                    id="naming"
                    title="Naming"
                    description="Templates for artist folders, album tracks, and music video filenames. Use ? for tokens and examples."
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
                                    {renameStatus?.limited ? (
                                        <Badge appearance="outline" color="informative">
                                            {renameStatus.scanned} scanned
                                        </Badge>
                                    ) : null}
                                    <Badge appearance="outline" color={(renameStatus?.renameNeeded ?? 0) > 0 ? "warning" : "success"}>
                                        {renameStatus?.renameNeeded ?? 0}{renameStatus?.limited ? " in scan" : ""} need rename
                                    </Badge>
                                    <Badge appearance="outline" color={(renameStatus?.conflicts ?? 0) > 0 ? "warning" : "informative"}>
                                        {renameStatus?.conflicts ?? 0}{renameStatus?.limited ? " in scan" : ""} conflicts
                                    </Badge>
                                    <Badge appearance="outline" color={(renameStatus?.missing ?? 0) > 0 ? "warning" : "informative"}>
                                        {renameStatus?.missing ?? 0}{renameStatus?.limited ? " in scan" : ""} missing
                                    </Badge>
                                </div>
                                {renameStatus && !renameStatusLoading && (renameStatus.renameNeeded ?? 0) === 0 ? (
                                    <Text size={200} className={styles.mutedText}>
                                        {renameStatus.limited
                                            ? "No rename work detected in the fast scan."
                                            : "No rename work detected for the current naming templates."}
                                    </Text>
                                ) : null}
                            </div>
                                <div className={styles.namingActionGroup}>
                                <Button
                                    appearance="outline"
                                    icon={renameStatusLoading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                                    onClick={() => void loadRenameStatus()}
                                    disabled={renameStatusLoading || renameApplying || !namingSettings || namingActionsDisabled}
                                >
                                    Scan library
                                </Button>
                                <Button
                                    appearance="outline"
                                    icon={renameStatusLoading ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
                                    onClick={() => openRenamePreview()}
                                    disabled={renameStatusLoading || renameApplying || !namingSettings || namingActionsDisabled}
                                >
                                    Preview changes
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

                {metadataSourceSection}

                {streamingProvidersSection}

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

                <RenamePreviewDialog
                    open={renamePreviewOpen}
                    items={renamePreviewItems}
                    applying={renameApplying}
                    onOpenChange={setRenamePreviewOpen}
                    onApply={handleApplyLibraryNaming}
                />
                <RetagPreviewDialog
                    open={retagPreviewOpen}
                    items={retagPreviewItems}
                    applying={retagApplying}
                    onOpenChange={setRetagPreviewOpen}
                    onApply={handleApplyRetags}
                />
                <ImportArtistsModal
                    open={Boolean(importProviderId)}
                    onClose={() => setImportProviderId(null)}
                    providerId={importProviderId}
                    onImported={handleImportComplete}
                />
            </div >
        </div >
    );
};

export default SettingsPage;
