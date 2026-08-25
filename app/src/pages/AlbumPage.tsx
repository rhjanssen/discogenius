import { Fragment, useState, useCallback, useMemo, useLayoutEffect, useRef, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { formatDurationSeconds } from "@/utils/format";
import {
  AvatarGroup,
  AvatarGroupItem,
  Button,
  Text,
  Title1,
  Title2,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Spinner,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Checkbox,
  makeStyles,
  tokens,
  Overflow,
  OverflowItem,
  mergeClasses,
  Tab,
  TabList,
} from "@fluentui/react-components";
import { MediaCard } from "@/components/cards/MediaCard";
import {
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Info24Regular,
  Tag24Regular,
  MusicNote224Regular,
  ChevronDown16Regular,
  FolderSync24Regular,
  Play24Regular,
  Play24Filled,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Info24Filled,
  Tag24Filled,
  MusicNote224Filled,
  ChevronDown16Filled,
  FolderSync24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { compactPageTopOffset } from "@/components/ui/sharedLayoutStyles";
import { api } from "@/services/api";
import { QualityBadge } from "@/components/ui/QualityBadge";
import {
  ProviderQualityRow,
  type ProviderQualityOffer,
} from "@/components/ui/ProviderQualityPill";
import {
  acquisitionPlanDisplayQuality,
  formatAcquisitionPlanCoverageSummary,
} from "@/utils/acquisitionPlanCoverage";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { ArtistPersona } from "@/components/ui/ArtistPersona";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { DetailPageSkeleton } from "@/components/ui/LoadingSkeletons";
import { ExpandableMetadataBlock } from "@/components/ui/ExpandableMetadataBlock";
import { TrackInfoDialog, type TrackFileInfo } from "@/components/ui/TrackInfoDialog";
import TrackList from "@/components/TrackList";
import { useCardStyles } from "@/components/cards/cardStyles";
import {
  albumPageQueryKey,
  albumReleaseAvailabilityQueryKey,
  useAlbumPage,
  type AlbumAssociatedVideo,
  type AlbumPageData,
  type AlbumTrack,
} from "@/hooks/useAlbumPage";
import { useMonitoring } from "@/hooks/useMonitoring";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { useToast } from "@/hooks/useToast";
import { useDelayedVisible } from "@/hooks/useDelayedVisible";
import { useHorizontalScrollRestore } from "@/hooks/useHorizontalScrollRestore";
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import { useUltraBlurHero } from "@/hooks/useUltraBlurHero";
import { getAlbumRouteTrackTarget } from "@/utils/albumNavigation";
import { mediaCoverProxySrc, mediaCoverSrc } from "@/utils/artwork";
import { formatDescriptiveTrackPosition } from "@/utils/trackPosition";
import { readArtistViewMode, type ArtistViewMode } from "@/utils/artistViewMode";
import {
  compactDetailActionButtonStyles,
  detailActionGlassButtonStyles,
  detailActionMobileOverflowItemStyles,
  detailActionMobileOverflowRowStyles,
  detailActionPrimaryButtonStyles,
} from "@/components/media/detailActionStyles";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";
import { getAlbumMonitorActionPresentation } from "@/pages/album/albumMonitorAction";
import {
  RenamePreviewDialog,
  RetagPreviewDialog,
  type RenamePreviewItem,
  type RetagPreviewItem,
} from "@/components/mediafiles/FileMaintenanceDialogs";
import {
  ReleaseSwitcher,
} from "@/pages/album/ReleaseSwitcher";
import {
  defaultTrackListEditionId,
  resolveTrackListTabPresentation,
} from "@/pages/album/trackListTabPresentation";

const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const Info24 = bundleIcon(Info24Filled, Info24Regular);
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const ChevronDown16 = bundleIcon(ChevronDown16Filled, ChevronDown16Regular);
const FolderSync24 = bundleIcon(FolderSync24Filled, FolderSync24Regular);
const Play24 = bundleIcon(Play24Filled, Play24Regular);

function albumAssociatedVideoElementId(videoId: string): string {
  return `album-associated-video-${videoId}`;
}

const useStyles = makeStyles({
  container: {
    ...compactPageTopOffset,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    width: "100%",
    paddingBottom: `calc(${tokens.spacingVerticalXXXL} * 3)`,
  },
  stateShell: {
    width: "100%",
    alignSelf: "stretch",
  },
  header: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    boxSizing: "border-box",
    padding: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalNone,
    paddingBottom: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    gap: tokens.spacingHorizontalM,
    "@media (min-width: 768px)": {
      padding: tokens.spacingHorizontalL,
      paddingTop: tokens.spacingVerticalS,
      paddingBottom: tokens.spacingVerticalS,
      gap: tokens.spacingHorizontalXL,
    },
  },
  headerContent: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalS,
    width: "100%",
    textAlign: "center",
    "@media (min-width: 768px)": {
      flexDirection: "row",
      alignItems: "stretch",
      textAlign: "left",
      gap: tokens.spacingHorizontalXL,
    },
  },
  coverArt: {
    // Mobile covers read small next to Title1; step up toward the desktop 220.
    width: "200px",
    height: "200px",
    objectFit: "cover",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow28,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "220px",
      height: "220px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
      boxShadow: tokens.shadow64,
    },
  },
  coverPlaceholder: {
    width: "200px",
    height: "200px",
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    color: tokens.colorNeutralForeground4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "220px",
      height: "220px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
    },
  },
  albumInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    // Section rhythm (title block → metadata → actions). Persona↔title lives
    // in titleBlock with a tighter related-content gap.
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    width: "100%",
    alignItems: "center",
    textAlign: "center",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      textAlign: "left",
    },
  },
  // Fluent related-content pair: byline + title share XS/SNudge, not the
  // section M gap — so the persona reads as belonging to the title.
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalXS,
    width: "100%",
    minWidth: 0,
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      gap: tokens.spacingVerticalSNudge,
    },
  },
  albumTitle: {
    width: "100%",
    textAlign: "center",
    whiteSpace: "normal",
    wordBreak: "break-word",
    "@media (min-width: 768px)": {
      textAlign: "left",
    },
  },
  artistInfo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      columnGap: tokens.spacingHorizontalS,
    },
  },
  artistAvatarGroup: {
    display: "inline-flex",
    alignItems: "center",
    marginRight: tokens.spacingHorizontalXS,
  },
  artistNames: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXXS,
    rowGap: tokens.spacingVerticalXXS,
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
    },
  },
  artistCredit: {
    display: "inline-flex",
    alignItems: "center",
  },
  artistJoinPhrase: {
    display: "inline-flex",
    alignItems: "center",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  artistCreditButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: 0,
    border: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    "&:hover": {
      opacity: 0.8,
    },
  },
  metadata: {
    display: "flex",
    // Mobile: stack the quality badges above the year/track/duration facts so the
    // row never cuts off. Desktop: lay them out inline.
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXS,
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground2,
    "@media (min-width: 768px)": {
      flexDirection: "row",
      justifyContent: "flex-start",
      columnGap: tokens.spacingHorizontalM,
      rowGap: tokens.spacingVerticalS,
    },
  },
  metadataBadges: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  metadataFacts: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  metadataSeparator: {
    width: "4px",
    height: "4px",
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralForeground2,
  },
  actions: {
    display: "flex",
    flexWrap: "nowrap",
    justifyContent: "center",
    width: "100%",
    marginTop: tokens.spacingVerticalXS,
    alignItems: "stretch",
    ...detailActionMobileOverflowRowStyles,
    "& > *": {
      ...detailActionMobileOverflowItemStyles,
    },
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      marginTop: tokens.spacingVerticalS,
      flexWrap: "nowrap",
      overflow: "visible",
      paddingTop: tokens.spacingVerticalNone,
      paddingBottom: tokens.spacingVerticalNone,
      "& > *": {
        flex: "0 0 auto",
        minWidth: "auto",
        maxWidth: "none",
        flexShrink: 0,
      },
    },
  },
  // Transparent button base style
  transparentButton: {
    ...detailActionGlassButtonStyles,
  },
  // Primary action button
  primaryButton: {
    ...detailActionPrimaryButtonStyles,
  },
  actionButton: {
    ...compactDetailActionButtonStyles,
  },
  // Two adjacent Buttons sharing one rounded frame. The wrapper owns hover
  // shadow so the halves stay one unit. On mobile it fills one overflow slot.
  splitDownload: {
    display: "inline-flex",
    alignItems: "stretch",
    position: "relative",
    borderRadius: tokens.borderRadiusXLarge,
    minWidth: 0,
    width: "100%",
    transitionProperty: "box-shadow, transform",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    "&:hover": {
      boxShadow: tokens.shadow8,
    },
    "&:active": {
      boxShadow: tokens.shadow2,
    },
    "& > *:last-child": {
      flex: "0 0 32px",
      width: "32px",
      minWidth: "32px",
      maxWidth: "32px",
      alignSelf: "stretch",
    },
    "@media (min-width: 768px)": {
      width: "auto",
      flex: "0 0 auto",
      "& > *:last-child": {
        flex: "0 0 36px",
        width: "36px",
        minWidth: "36px",
        maxWidth: "36px",
      },
    },
  },
  splitDownloadPrimary: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    flex: "1 1 0",
    minWidth: 0,
    maxWidth: "none",
    "&:hover": {
      boxShadow: "none",
      transform: "none",
    },
    "&:active": {
      boxShadow: "none",
      transform: "none",
    },
  },
  splitDownloadMenu: {
    flex: "1 1 auto",
    width: "100%",
    minWidth: 0,
    maxWidth: "none",
    padding: tokens.spacingHorizontalNone,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftColor: tokens.colorNeutralStroke2,
    "& .fui-Button__icon": {
      marginLeft: "0",
      marginRight: "0",
    },
    "& .fui-Button__content": {
      display: "none",
    },
    "&:hover": {
      boxShadow: "none",
      transform: "none",
    },
    "&:active": {
      boxShadow: "none",
      transform: "none",
    },
  },
  metaAttribution: {
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  sectionHeader: {
    marginBottom: tokens.spacingVerticalM,
  },
  trackListTabs: {
    width: "100%",
    maxWidth: "100%",
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "thin",
    scrollBehavior: "smooth",
    "& [role='tab']": {
      flexShrink: 0,
      maxWidth: "min(260px, 72vw)",
    },
    "& .fui-Tab__content, & .fui-Tab__content--reserved-space": {
      display: "block",
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
  },
  /** Horizontal scroll for associated videos (matches artist page carousel). */
  videoCarousel: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    overflowX: "auto",
    scrollBehavior: "smooth",
    paddingBottom: tokens.spacingVerticalS,
    scrollSnapType: "x mandatory",
    "& > *": {
      scrollSnapAlign: "start",
      width: `calc((100% - 2 * ${tokens.spacingHorizontalS}) / 3)`,
      flexShrink: 0,
    },
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalM,
      "& > *": {
        width: `calc((100% - 3 * ${tokens.spacingHorizontalM}) / 4)`,
      },
    },
    "@media (min-width: 900px)": {
      "& > *": {
        width: `calc((100% - 5 * ${tokens.spacingHorizontalM}) / 6)`,
      },
    },
    scrollbarWidth: "none",
    "&::-webkit-scrollbar": {
      display: "none",
    },
  },
  /** Grid when artist view preference is "grid". */
  videoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    },
  },
  videoCardAnchor: {
    minWidth: 0,
    scrollMarginTop: "96px",
  },
  playIcon: {
    width: "32px",
    height: "32px",
    color: tokens.colorNeutralForeground3,
  },
  sectionSpacing: {
    marginTop: tokens.spacingVerticalXXL,
  },
  trackListLoading: {
    minHeight: "220px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  trackArtistText: {
    color: tokens.colorNeutralForeground2,
  },
  mobileTrackMeta: {
    color: tokens.colorNeutralForeground2,
  },
  trackSubInfo: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  trackArtistSeparator: {
    color: tokens.colorNeutralForeground2,
  },
  trackDurationText: {
    color: tokens.colorNeutralForeground2,
  },
  albumFilesCard: {
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  albumFilesHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  lockColorRed: {
    color: tokens.colorPaletteRedForeground1,
  },
  // Cover overlay for hover info
  coverContainer: {
    position: "relative",
    flexShrink: 0,
    alignSelf: "center",
    display: "inline-flex",
    lineHeight: 0,
    width: "fit-content",
    maxWidth: "100%",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    "@media (min-width: 768px)": {
      alignSelf: "flex-start",
    },
  },
  coverOverlay: {
    position: "absolute",
    right: tokens.spacingHorizontalS,
    bottom: tokens.spacingVerticalS,
    width: "36px",
    height: "36px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    color: "white",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    border: `1px solid ${tokens.colorNeutralStrokeOnBrand2}`,
    borderRadius: tokens.borderRadiusCircular,
    opacity: 0.82,
    transition: `opacity ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    cursor: "pointer",
    "&:hover": {
      opacity: 1,
    },
    "&:focus-visible": {
      opacity: 1,
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transitionDuration: "0.01ms",
    },
    "@media (forced-colors: active)": {
      color: "ButtonText",
      backgroundColor: "ButtonFace",
      border: "1px solid ButtonText",
    },
  },
  coverInfoIcon: {
    color: "inherit",
    fontSize: "28px",
  },
});

/* ── Album overflow helpers ─────────────────────────────────── */

const EMPTY_ALBUM_TRACKS: AlbumTrack[] = [];
const EMPTY_ASSOCIATED_VIDEOS: AlbumAssociatedVideo[] = [];

const AlbumPage = () => {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { toggleMonitor, toggleLock, isTogglingMonitor, isTogglingLock } = useMonitoring();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();

  const [downloadingAlbum, setDownloadingAlbum] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [coverInfoOpen, setCoverInfoOpen] = useState(false);
  const [coverImageFailed, setCoverImageFailed] = useState(false);
  // Same carousel/grid preference as the artist page video list.
  const [videoViewMode] = useState<ArtistViewMode>(() => readArtistViewMode());
  const [renamePreviewOpen, setRenamePreviewOpen] = useState(false);
  const [renamePreviewItems, setRenamePreviewItems] = useState<RenamePreviewItem[]>([]);
  const [renameApplying, setRenameApplying] = useState(false);
  const [retagPreviewOpen, setRetagPreviewOpen] = useState(false);
  const [retagPreviewItems, setRetagPreviewItems] = useState<RetagPreviewItem[]>([]);
  const [retagApplying, setRetagApplying] = useState(false);
  const [deleteFilesOpen, setDeleteFilesOpen] = useState(false);
  const [deleteFilesUnmonitor, setDeleteFilesUnmonitor] = useState(false);
  const [deleteFilesApplying, setDeleteFilesApplying] = useState(false);
  const [stripTagsOpen, setStripTagsOpen] = useState(false);
  const [stripTagsApplying, setStripTagsApplying] = useState(false);
  const [pendingSelectionKey, setPendingSelectionKey] = useState<string | null>(null);
  const handledTrackScrollKeyRef = useRef<string | null>(null);
  const associatedVideoCarouselRef = useHorizontalScrollRestore(
    `album:${albumId || "unknown"}:associated-videos`,
  );

  const { data: pageData, isLoading: loading, isAvailabilityLoading, error, refetch } = useAlbumPage(albumId);
  const album = pageData?.album ?? null;
  const tracks = pageData?.tracks ?? EMPTY_ALBUM_TRACKS;
  const associatedVideos = pageData?.associatedVideos ?? EMPTY_ASSOCIATED_VIDEOS;
  const initialTrackListEditionId = pageData?.initialTrackListEditionId ?? null;
  const { data: activity } = useQuery({
    queryKey: ['artist-activity', album?.artist_id],
    queryFn: ({ signal }) => album?.artist_id
      ? api.getArtistActivity(album.artist_id, { signal, timeoutMs: 8_000 })
      : null,
    enabled: Boolean(album?.artist_id) && !loading && !error,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
    retry: 1,
  }) as { data: { scanning?: boolean; curating?: boolean; downloading?: boolean; libraryScan?: boolean; totalActive?: number } | null };
  const releaseAvailability = pageData?.releaseAvailability ?? null;
  const artistImage = pageData?.artistImage ?? undefined;

  /**
   * The track-list tabs, resolved by `/page` from canonical acquisition units.
   *
   * The API collapses equivalent sets and nested subsets to one product (strip
   * hidden when ≤1) and marks exactly one tab as the list that opens first;
   * this page only labels and orders them. Availability may enrich the page
   * with offers and plans, but it must never decide which lists exist — an
   * Album stays fully navigable while availability is still loading, and it
   * survives availability failing outright.
   *
   * Track rows still attach stereo + spatial plan badges via recording identity.
   */
  const trackListTabs = useMemo(
    () => resolveTrackListTabPresentation(pageData?.trackListTabs, album?.title),
    [album?.title, pageData?.trackListTabs],
  );

  const defaultTabEditionId = defaultTrackListEditionId(trackListTabs);
  const [selectedTabEditionId, setSelectedTabEditionId] = useState<number | null>(null);
  const activeTabEditionId = trackListTabs.some((tab) => tab.editionId === selectedTabEditionId)
    ? selectedTabEditionId
    : defaultTabEditionId;

  // Only fetched when switching to a non-initial edition tab; the initial tab
  // uses the tracks array directly from the /page payload.
  const editionTracksQuery = useQuery({
    queryKey: ['albumPage', albumId, 'editionTracks', activeTabEditionId],
    queryFn: ({ signal }) => albumId && activeTabEditionId != null
      ? api.getAlbumEditionTracks(albumId, activeTabEditionId, { signal, timeoutMs: 15_000 })
      : Promise.resolve(EMPTY_ALBUM_TRACKS),
    enabled: Boolean(albumId) && activeTabEditionId != null && activeTabEditionId !== initialTrackListEditionId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 1,
  });

  const activeTabLabel = trackListTabs
    .find((tab) => tab.editionId === activeTabEditionId)?.label ?? "selected edition";
  const isEditionTrackListLoading = activeTabEditionId != null
    && activeTabEditionId !== initialTrackListEditionId
    && editionTracksQuery.isPending;
  const editionTrackListError = activeTabEditionId != null
    && activeTabEditionId !== initialTrackListEditionId
    && editionTracksQuery.error
      ? editionTracksQuery.error instanceof Error
        ? editionTracksQuery.error
        : new Error("The selected edition's tracks could not be loaded.")
      : null;

  // A selected Edition owns this section completely.
  const visibleTracks = activeTabEditionId != null && activeTabEditionId !== initialTrackListEditionId
    ? (editionTracksQuery.data ?? EMPTY_ALBUM_TRACKS)
    : tracks;

  const tracksWithAssociatedVideos = useMemo(() => {
    const tracks = visibleTracks;
    if (associatedVideos.length === 0) return tracks;
    const videoByTrackMbid = new Map<string, string>();
    const videoByAudioRecordingMbid = new Map<string, string>();
    for (const video of associatedVideos) {
      const videoId = String(video.id || "").trim();
      if (!videoId) continue;
      const trackMbid = String(video.track_mbid || "").trim();
      if (trackMbid && !videoByTrackMbid.has(trackMbid)) {
        videoByTrackMbid.set(trackMbid, videoId);
      }
      const audioMbid = String(video.audio_recording_mbid || "").trim();
      if (audioMbid && !videoByAudioRecordingMbid.has(audioMbid)) {
        videoByAudioRecordingMbid.set(audioMbid, videoId);
      }
    }
    return tracks.map((track) => {
      const byTrack = videoByTrackMbid.get(String(track.musicbrainz_track_id || "").trim());
      const byRecording = videoByAudioRecordingMbid.get(String(track.musicbrainz_recording_id || "").trim());
      const associatedVideoId = byTrack || byRecording || null;
      if (!associatedVideoId) return track;
      return { ...track, associated_video_id: associatedVideoId };
    });
  }, [associatedVideos, visibleTracks]);

  const scrollToAssociatedVideo = useCallback((videoId: string) => {
    const elementId = albumAssociatedVideoElementId(videoId);
    const escapeId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(elementId)
      : elementId.replace(/([\\"])/g, "\\$1");
    const target = document.getElementById(elementId)
      ?? document.querySelector<HTMLElement>(`#${escapeId}`);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    navigate(`/video/${videoId}`);
  }, [navigate]);

  const albumArtists = album?.album_artists?.length
    ? album.album_artists
    : album
      ? [{
          id: album.artist_id,
          name: album.artist_name,
          join_phrase: "",
          picture: artistImage,
        }]
      : [];
  const albumCanonicalArtworkUrl = album ? mediaCoverSrc(album) : null;
  const albumArtworkUrl = album
    ? (albumCanonicalArtworkUrl && !coverImageFailed ? albumCanonicalArtworkUrl : null)
    : undefined;
  const albumBrandColor = useArtworkBrandColor({
    artworkUrl: albumArtworkUrl,
    brandKeyColor: album?.vibrant_color ?? null,
    // MusicBrainz-canonical albums have no provider vibrant_color, so derive
    // the accent from the cover like the artist/video pages do — otherwise
    // brand-driven UI (seekbar, buttons) stays on the default orange while
    // UltraBlur already shows the artwork tint.
    deriveBrandFromArtwork: true,
    ownsAmbience: true,
  });
  const { heroProps: ultraBlurHeroProps } = useUltraBlurHero(albumArtworkUrl);

  useEffect(() => {
    setCoverImageFailed(false);
  }, [albumCanonicalArtworkUrl]);

  const isMonitored = !!album?.is_monitored;
  const isLocked = !!album?.monitored_lock;
  /**
   * Header pills come from the *executing* acquisition plan per library slot
   * (one quality badge each), not every raw provider-release quality variant.
   * Availability supplies composition + every provider album id a composite uses.
   */
  const headerPlanOffers = useMemo((): ProviderQualityOffer[] => {
    if (!album) return [];
    const offers: ProviderQualityOffer[] = [];
    const pushFromPlan = (
      slot: "stereo" | "spatial",
      libraryNameHint: RegExp,
      fallback: {
        quality?: string | null;
        provider?: string | null;
        providerAlbumId?: string | null;
        providerUrl?: string | null;
        matchStatus?: string | null;
        releaseMbid?: string | null;
      },
    ) => {
      const library = releaseAvailability?.libraries.find((candidate) =>
        libraryNameHint.test(candidate.name)
        || (slot === "spatial"
          ? candidate.allowedSourceFormats.includes("spatial")
            && !candidate.allowedSourceFormats.some((q) => q !== "spatial" && q !== "video")
          : candidate.allowedSourceFormats.some((q) =>
            q === "lossless" || q === "hires-lossless" || q === "lossy")));
      const selection = library?.selections.find((entry) => entry.monitored && entry.representative)
        ?? library?.selections.find((entry) => entry.monitored && entry.plan);
      const plan = selection?.plan ?? null;
      const release = releaseAvailability?.releases.find(
        (candidate) => candidate.id === selection?.editionId,
      );
      if (plan && release) {
        const sourceOffers = plan.providerEditionMatchIds
          .map((matchId) => release.offers.find((offer) => offer.providerEditionMatchId === matchId))
          .filter((offer): offer is NonNullable<typeof offer> => Boolean(offer));
        const albumIds = sourceOffers
          .map((offer) => String(offer.providerId || "").trim())
          .filter(Boolean);
        const primary = sourceOffers.find(
          (offer) => offer.providerEditionMatchId === plan.primaryProviderEditionMatchId,
        ) ?? sourceOffers[0];
        // The badge names what this plan will acquire, so it reads the plan's
        // own display quality (resolved from the variant each planned track
        // selected). Scanning every variant published on the source offers
        // would badge a stereo plan as Atmos whenever the provider also sells
        // an Atmos stream of the same album.
        const quality = acquisitionPlanDisplayQuality({
          qualityTier: plan.qualityTier,
          displayQuality: plan.displayQuality,
          provider: plan.provider,
        }) || fallback.quality || "LOSSLESS";
        const isComposite = plan.composition === "composite" || albumIds.length > 1;
        offers.push({
          slot,
          quality,
          provider: plan.provider,
          matchStatus: "verified",
          matchKind: isComposite ? "composite" : "direct",
          coverageSummary: formatAcquisitionPlanCoverageSummary({
            composition: isComposite ? "composite" : "single_source",
            relation: primary?.relation ?? null,
            coverage: plan.coverage,
            targetTrackCount: plan.targetTrackCount || plan.coverage,
          }),
          providerAlbumId: albumIds.join(";") || fallback.providerAlbumId || null,
          providerAlbumIds: albumIds.length > 0
            ? albumIds
            : (fallback.providerAlbumId ? [fallback.providerAlbumId] : []),
          providerUrl: primary?.providerUrl ?? fallback.providerUrl ?? null,
          selectedReleaseMbid: release.mbid || fallback.releaseMbid || null,
          explicit: plan.explicitContent === "explicit"
            ? true
            : plan.explicitContent === "clean"
              ? false
              : null,
        });
        return;
      }
      if (fallback.providerAlbumId || fallback.quality) {
        offers.push({
          slot,
          quality: fallback.quality,
          provider: fallback.provider,
          matchStatus: fallback.matchStatus,
          matchKind: "direct",
          coverageSummary: formatAcquisitionPlanCoverageSummary({
            composition: "single_source",
            relation: "exact",
            coverage: 1,
            targetTrackCount: 1,
          }),
          providerAlbumId: fallback.providerAlbumId,
          providerAlbumIds: fallback.providerAlbumId ? [fallback.providerAlbumId] : [],
          providerUrl: fallback.providerUrl,
          selectedReleaseMbid: fallback.releaseMbid,
        });
      }
    };

    pushFromPlan("stereo", /stereo/i, {
      quality: album.stereo_quality || album.quality,
      provider: album.stereo_provider || album.selected_provider,
      providerAlbumId: album.stereo_provider_id,
      providerUrl: album.stereo_provider_url,
      matchStatus: album.stereo_match_status,
      releaseMbid: album.stereo_release_mbid || album.selected_release_mbid,
    });
    if (album.spatial_provider_id || album.spatial_quality) {
      pushFromPlan("spatial", /spatial/i, {
        quality: album.spatial_quality || "DOLBY_ATMOS",
        provider: album.spatial_provider || album.selected_provider,
        providerAlbumId: album.spatial_provider_id,
        providerUrl: album.spatial_provider_url,
        matchStatus: album.spatial_match_status,
        releaseMbid: album.spatial_release_mbid || album.selected_release_mbid,
      });
    }
    return offers;
  }, [album, releaseAvailability]);

  const hasStereoOffer = headerPlanOffers.some((offer) => offer.slot === "stereo")
    || Boolean(album?.stereo_provider_id);
  const hasSpatialOffer = headerPlanOffers.some((offer) => offer.slot === "spatial")
    || Boolean(album?.spatial_provider_id);
  const hasAnyProviderOffer = headerPlanOffers.length > 0 || hasStereoOffer || hasSpatialOffer;
  /**
   * Every monitored edition the download action will queue a plan for.
   *
   * The header describes one edition per library — the representative — but the
   * download queues every monitored edition's plan across every enabled
   * library. On an album monitored as two editions that reads as "I pressed
   * download and got one version", because the header only ever described one
   * of them. The action is not tab-sensitive and never was; naming the count is
   * what makes it honest.
   */
  const queuedEditions = useMemo(() => {
    const byEdition = new Map<number, string>();
    for (const library of releaseAvailability?.libraries ?? []) {
      for (const selection of library.selections) {
        if (!selection.monitored || !selection.plan) continue;
        const release = releaseAvailability?.releases.find(
          (candidate) => candidate.id === selection.editionId,
        );
        if (release && !byEdition.has(selection.editionId)) {
          byEdition.set(selection.editionId, release.title || "Edition");
        }
      }
    }
    return [...byEdition.values()];
  }, [releaseAvailability]);
  const downloadButtonLabel = downloadingAlbum ? "Adding..." : "Download";
  const downloadScopeDescription = queuedEditions.length > 1
    ? `Download all ${queuedEditions.length} monitored editions`
    : "Download the monitored edition";
  const headerQualityBadges = useMemo(() => {
    const badges: Array<{ key: string; quality: string }> = [];
    for (const offer of headerPlanOffers) {
      if (offer.quality && !badges.some((badge) => badge.quality === offer.quality)) {
        badges.push({ key: offer.slot, quality: offer.quality });
      }
    }
    if (badges.length === 0 && album?.quality) {
      badges.push({ key: "primary", quality: album.quality });
    }
    return badges;
  }, [album?.quality, headerPlanOffers]);

  const renderAlbumArtists = () => {
    if (albumArtists.length > 1) {
      return (
        <>
          <AvatarGroup
            aria-label={albumArtists.map((artist) => artist.name).join(", ")}
            className={styles.artistAvatarGroup}
            layout="stack"
            size={24}
          >
            {albumArtists.map((artist, index) => (
              <AvatarGroupItem
                key={`${artist.id || artist.name}-${index}`}
                name={artist.name}
                image={artist.picture || artist.cover_image_url
                  ? { src: artist.picture || artist.cover_image_url || undefined }
                  : undefined}
              />
            ))}
          </AvatarGroup>
          <span className={styles.artistNames}>
            {albumArtists.map((artist, index) => (
              <Fragment key={`${artist.id || artist.name}-name-${index}`}>
                {artist.id ? (
                  <button
                    type="button"
                    className={styles.artistCreditButton}
                    onClick={() => navigate(`/artist/${artist.id}`)}
                  >
                    {artist.name}
                  </button>
                ) : (
                  <Text size={300}>{artist.name}</Text>
                )}
                {artist.join_phrase ? (
                  <Text size={300} className={styles.artistJoinPhrase}>
                    {artist.join_phrase}
                  </Text>
                ) : null}
              </Fragment>
            ))}
          </span>
        </>
      );
    }

    return albumArtists.map((artist) => (
      <Fragment key={artist.id || artist.name}>
        <span className={styles.artistCredit}>
          <ArtistPersona
            artistId={artist.id}
            artistName={artist.name}
            avatarUrl={artist.picture || artist.cover_image_url || undefined}
          />
        </span>
        {artist.join_phrase ? (
          <Text size={300} className={styles.artistJoinPhrase}>
            {artist.join_phrase}
          </Text>
        ) : null}
      </Fragment>
    ));
  };

  // App-wide ScrollRestoration owns window scroll (POP restore / PUSH top).

  useLayoutEffect(() => {
    if (!albumId || loading) {
      return;
    }

    const focusTrackId = getAlbumRouteTrackTarget(location.state);
    if (!focusTrackId) {
      return;
    }

    const scrollKey = `${location.key}:${albumId}:${focusTrackId}`;
    if (handledTrackScrollKeyRef.current === scrollKey) {
      return;
    }

    let animationFrameId = 0;
    let cancelled = false;
    let attempts = 0;

    const findTrackRow = () => {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return document.querySelector<HTMLElement>(`[data-album-track-id="${CSS.escape(focusTrackId)}"]`);
      }

      return document.querySelector<HTMLElement>(`[data-album-track-id="${focusTrackId.replace(/([\\"])/g, "\\$1")}"]`);
    };

    const scrollToTrack = () => {
      if (cancelled) {
        return;
      }

      const trackRow = findTrackRow();
      if (trackRow) {
        handledTrackScrollKeyRef.current = scrollKey;
        trackRow.scrollIntoView({ block: "center", behavior: "auto" });
        return;
      }

      attempts += 1;
      if (attempts < 12) {
        animationFrameId = window.requestAnimationFrame(scrollToTrack);
      }
    };

    animationFrameId = window.requestAnimationFrame(scrollToTrack);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [albumId, loading, location.key, location.state, tracks.length]);

  const updateAlbumPageCache = useCallback((updater: (current: Omit<AlbumPageData, "releaseAvailability">) => Omit<AlbumPageData, "releaseAvailability">) => {
    if (!albumId) {
      return;
    }

    queryClient.setQueryData<Omit<AlbumPageData, "releaseAvailability"> | undefined>(
      albumPageQueryKey(albumId),
      (current) => {
        if (!current) {
          return current;
        }

        return updater(current);
      },
    );
  }, [albumId, queryClient]);

  const handleToggleMonitor = () => {
    if (!album) return;
    toggleMonitor({ id: album.id, type: 'album', currentStatus: isMonitored });
    updateAlbumPageCache((current) => ({
      ...current,
      album: { ...current.album, is_monitored: !isMonitored },
    }));
    dispatchLibraryUpdated();
  };

  const handleToggleLock = () => {
    if (!album) return;
    toggleLock({ id: album.id, type: 'album', isLocked });
    updateAlbumPageCache((current) => ({
      ...current,
      album: { ...current.album, monitored_lock: !isLocked },
    }));
    dispatchLibraryUpdated();
  };

  const monitorAction = getAlbumMonitorActionPresentation({
    isLocked,
    isMonitored,
    isPending: isTogglingMonitor,
  });

  const librarySelectionMutation = useMutation({
    mutationFn: async ({
      libraryId,
      editionId,
      providerEditionMatchId,
    }: {
      libraryId: number;
      editionId: number;
      providerEditionMatchId: number;
    }) => api.setAlbumLibraryRelease(
      albumId!,
      libraryId,
      editionId,
      providerEditionMatchId,
    ),
    onSuccess: async (releaseAvailability) => {
      queryClient.setQueryData(
        albumReleaseAvailabilityQueryKey(albumId),
        releaseAvailability,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: albumPageQueryKey(albumId) }),
        queryClient.invalidateQueries({ queryKey: albumReleaseAvailabilityQueryKey(albumId) }),
      ]);
      dispatchLibraryUpdated();
      toast({
        title: "Release selection updated",
        description: "The selected provider offer has been switched for this library.",
      });
    },
    onError: (mutationError) => {
      toast({
        title: "Failed to switch release",
        description: mutationError instanceof Error ? mutationError.message : "Please try again",
        variant: "destructive",
      });
    },
    onSettled: () => {
      setPendingSelectionKey(null);
    },
  });

  const handleSelectReleaseForLibrary = useCallback((
    libraryId: number,
    editionId: number,
    providerEditionMatchId: number,
  ) => {
    if (!albumId) {
      return;
    }

    setPendingSelectionKey(`${libraryId}:${editionId}:${providerEditionMatchId}`);
    librarySelectionMutation.mutate({
      libraryId,
      editionId,
      providerEditionMatchId,
    });
  }, [albumId, librarySelectionMutation]);

  const libraryPlanMutation = useMutation({
    mutationFn: async ({
      libraryId,
      editionId,
      planKey,
      mode,
    }: {
      libraryId: number;
      editionId: number;
      planKey: string | null;
      mode?: "exclusive" | "additive";
    }) => (planKey == null
      ? api.revertAlbumLibraryPlan(albumId!, libraryId, editionId)
      : api.setAlbumLibraryPlan(
        albumId!,
        libraryId,
        editionId,
        planKey,
        mode ?? "exclusive",
      )),
    onSuccess: async (releaseAvailability, variables) => {
      queryClient.setQueryData(
        albumReleaseAvailabilityQueryKey(albumId),
        releaseAvailability,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: albumPageQueryKey(albumId) }),
        queryClient.invalidateQueries({ queryKey: albumReleaseAvailabilityQueryKey(albumId) }),
      ]);
      dispatchLibraryUpdated();
      const additive = variables.mode === "additive";
      toast({
        title: variables.planKey == null
          ? "Acquisition plan set to automatic"
          : additive
            ? "Edition monitored alongside others"
            : "Edition and offer selected",
        description: variables.planKey == null
          ? "The planner will choose the best plan for this library again."
          : additive
            ? "This edition is now monitored for this library without changing other editions."
            : "This library now monitors only this edition and acquires it with the selected offer.",
      });
    },
    onError: (mutationError) => {
      toast({
        title: "Failed to change acquisition plan",
        description: mutationError instanceof Error ? mutationError.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  const handleSelectPlanForLibrary = useCallback((
    libraryId: number,
    editionId: number,
    planKey: string,
    mode: "exclusive" | "additive" = "exclusive",
  ) => {
    if (!albumId) return;
    libraryPlanMutation.mutate({ libraryId, editionId, planKey, mode });
  }, [albumId, libraryPlanMutation]);

  const editionMonitoringMutation = useMutation({
    mutationFn: async ({
      libraryId,
      editionId,
    }: {
      libraryId: number;
      editionId: number;
    }) => api.removeAlbumLibraryEdition(albumId!, libraryId, editionId),
    onSuccess: async (releaseAvailability) => {
      queryClient.setQueryData(
        albumReleaseAvailabilityQueryKey(albumId),
        releaseAvailability,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: albumPageQueryKey(albumId) }),
        queryClient.invalidateQueries({ queryKey: albumReleaseAvailabilityQueryKey(albumId) }),
      ]);
      dispatchLibraryUpdated();
      toast({
        title: "Edition no longer monitored",
        description: "Files already on disk were left untouched.",
      });
    },
    onError: (mutationError) => {
      toast({
        title: "Failed to change monitored editions",
        description: mutationError instanceof Error ? mutationError.message : "Please try again",
        variant: "destructive",
      });
    },
  });

  const handleRemoveEditionForLibrary = useCallback((libraryId: number, editionId: number) => {
    if (!albumId) return;
    editionMonitoringMutation.mutate({ libraryId, editionId });
  }, [albumId, editionMonitoringMutation]);

  const handleRevertPlanForLibrary = useCallback((
    libraryId: number,
    editionId: number,
  ) => {
    if (!albumId) return;
    libraryPlanMutation.mutate({ libraryId, editionId, planKey: null });
  }, [albumId, libraryPlanMutation]);

  const handleDownloadAlbum = async (slot?: 'stereo' | 'spatial') => {
    if (!album || !hasAnyProviderOffer) return;
    setDownloadingAlbum(true);
    try {
      await api.addAlbum(album.id, slot ? { slot } : undefined);
      const slotLabel = slot === 'spatial' ? 'spatial audio' : slot === 'stereo' ? 'stereo' : hasStereoOffer && hasSpatialOffer ? 'stereo and spatial audio' : 'selected';
      // Name the editions rather than only the album: the queue covers every
      // monitored edition, which is not obvious from a header that describes one.
      const editionLabel = queuedEditions.length > 1
        ? ` — ${queuedEditions.length} editions: ${queuedEditions.join(', ')}`
        : '';
      toast({
        title: "Album added to queue",
        description: `${album.title} (${slotLabel})${editionLabel} will be downloaded shortly`,
      });
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["queue"] }),
        queryClient.invalidateQueries({ queryKey: ["queueDetails"] }),
        queryClient.refetchQueries({ queryKey: ["queue"] }),
        queryClient.refetchQueries({ queryKey: ["queueDetails"] }),
      ]);
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error adding album to queue:", error);
      toast({
        title: "Failed to add to queue",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setDownloadingAlbum(false);
    }
  };

  const handleDownloadPrimary = () => {
    if (hasStereoOffer && hasSpatialOffer) {
      void handleDownloadAlbum();
      return;
    }
    if (hasSpatialOffer) {
      void handleDownloadAlbum('spatial');
      return;
    }
    void handleDownloadAlbum('stereo');
  };

  const openRenamePreview = async () => {
    if (!albumId) return;
    setRenameApplying(true);
    try {
      const response = await api.getLibraryRenamePreview({ albumId, limit: 1000 }) as { items: RenamePreviewItem[] };
      const items = response.items.filter((item) => item.missing || item.conflict || item.needs_rename || item.drop_duplicate);
      setRenamePreviewItems(items);
      setRenamePreviewOpen(true);
    } catch (error) {
      toast({
        title: "Rename preview failed",
        description: error instanceof Error ? error.message : "Could not load the album rename preview.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  };

  const handleApplyRenames = async (ids: number[]) => {
    if (!albumId) return;
    setRenameApplying(true);
    try {
      const result: any = await api.applyLibraryRenames(ids.length > 0 ? { ids } : { applyAll: true, albumId });
      toast({
        title: "Rename queued",
        description: result?.message || "Queued album file renaming.",
      });
      setRenamePreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue rename",
        description: error instanceof Error ? error.message : "Could not queue album file renaming.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  };

  const openRetagPreview = async () => {
    if (!albumId) return;
    setRetagApplying(true);
    try {
      const response = await api.getRetagPreview({ albumId, limit: 1000 }) as { items: RetagPreviewItem[] };
      setRetagPreviewItems(response.items);
      setRetagPreviewOpen(true);
    } catch (error) {
      toast({
        title: "Retag preview failed",
        description: error instanceof Error ? error.message : "Could not load the album retag preview.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  };

  const handleApplyRetags = async (ids: number[]) => {
    if (!albumId) return;
    setRetagApplying(true);
    try {
      const result: any = await api.applyRetags(ids.length > 0 ? { ids } : { applyAll: true, albumId });
      toast({
        title: "Retag queued",
        description: result?.message || "Queued album metadata tag writing.",
      });
      setRetagPreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue retag",
        description: error instanceof Error ? error.message : "Could not queue album metadata tag writing.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  };

  const handleDeleteAlbumFiles = async () => {
    if (!albumId) return;
    setDeleteFilesApplying(true);
    try {
      const result: any = await api.deleteAlbumFiles(albumId, { unmonitor: deleteFilesUnmonitor });
      toast({
        title: "Album files deleted",
        description: `Removed ${result?.deleted ?? 0} file(s)${result?.unmonitored ? " and unmonitored the album" : ""}.`,
      });
      setDeleteFilesOpen(false);
      setDeleteFilesUnmonitor(false);
      await refetch();
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
    } catch (error) {
      toast({
        title: "Failed to delete album files",
        description: error instanceof Error ? error.message : "Could not delete album files.",
        variant: "destructive",
      });
    } finally {
      setDeleteFilesApplying(false);
    }
  };

  const handleStripAlbumTags = async () => {
    if (!albumId) return;
    setStripTagsApplying(true);
    try {
      const result: any = await api.stripTags({ applyAll: true, albumId });
      toast({
        title: "Strip tags queued",
        description: result?.message || "Queued removing embedded tags from album files.",
      });
      setStripTagsOpen(false);
      dispatchActivityRefresh();
    } catch (error) {
      toast({
        title: "Failed to queue strip tags",
        description: error instanceof Error ? error.message : "Could not queue strip tags.",
        variant: "destructive",
      });
    } finally {
      setStripTagsApplying(false);
    }
  };

  const albumActions: OverflowAction[] = [
    { key: 'monitor', label: monitorAction.label, disabled: monitorAction.disabled, onClick: handleToggleMonitor },
    { key: 'lock', label: isLocked ? 'Unlock' : 'Lock', disabled: isTogglingLock, onClick: handleToggleLock },
    {
      key: 'download',
      // Say how many editions this queues. It is not the selected tab.
      label: downloadingAlbum
        ? 'Adding...'
        : queuedEditions.length > 1
          ? `Download all ${queuedEditions.length} editions`
          : 'Download monitored edition',
      disabled: downloadingAlbum || !hasAnyProviderOffer,
      onClick: handleDownloadPrimary,
    },
    ...(album?.stereo_provider_id ? [{ key: 'download-stereo', label: 'Download stereo', disabled: downloadingAlbum, onClick: () => handleDownloadAlbum('stereo') }] : []),
    ...(album?.spatial_provider_id ? [{ key: 'download-spatial', label: 'Download spatial', disabled: downloadingAlbum, onClick: () => handleDownloadAlbum('spatial') }] : []),
    { key: 'rename-files', label: renameApplying ? 'Loading rename...' : 'Preview Rename', disabled: renameApplying, onClick: openRenamePreview },
    { key: 'retag-files', label: retagApplying ? 'Loading tags...' : 'Write Tags', disabled: retagApplying, onClick: openRetagPreview },
    { key: 'strip-tags', label: stripTagsApplying ? 'Queueing…' : 'Strip Tags…', disabled: stripTagsApplying, onClick: () => setStripTagsOpen(true) },
    { key: 'delete-files', label: 'Delete files…', disabled: deleteFilesApplying, onClick: () => setDeleteFilesOpen(true) },
  ];

  /** Open track info dialog */
  const showIngestSkeleton = Boolean(activity?.scanning) && tracks.length === 0;
  // Full-page skeleton only for /page (header + tracks). Release availability
  // is a deferred secondary query (7da677f) — do not hold the page for it;
  // Releases just appear when ready. Delayed gate skips flash on cache hits.
  const showPageSkeleton = useDelayedVisible(loading);

  if (loading && !showPageSkeleton && !showIngestSkeleton) {
    return null;
  }

  if (loading || showIngestSkeleton) {
    return (
      <DetailPageSkeleton
        artShape="rounded"
        content="tracks"
        info="metadata"
        rows={8}
        className={styles.container}
        actionWidths={["104px", "82px", "110px", "88px", "72px"]}
        label={showIngestSkeleton ? "Syncing album tracks from MusicBrainz..." : "Loading album details..."}
      />
    );
  }

  if (error) {
    return (
      <div className={styles.stateShell}>
        <h1 className="visually-hidden">Album</h1>
        <ErrorState
          title="Failed to load album"
          error={error as Error}
          minHeight="320px"
          actions={<Button onClick={() => void refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  if (!album) {
    return (
      <div className={styles.stateShell}>
        <h1 className="visually-hidden">Album</h1>
        <EmptyState
          title="Album not found"
          description="This album may not be in your library yet."
          actions={<Button appearance="primary" onClick={() => navigate('/')}>Return to Library</Button>}
          minHeight="320px"
        />
      </div>
    );
  }


  return (
    <DynamicBrandProvider keyColor={albumBrandColor}>
      <div className={styles.container}>
        <RenamePreviewDialog
          open={renamePreviewOpen}
          items={renamePreviewItems}
          applying={renameApplying}
          title="Preview Album Rename"
          onOpenChange={setRenamePreviewOpen}
          onApply={handleApplyRenames}
        />
        <RetagPreviewDialog
          open={retagPreviewOpen}
          items={retagPreviewItems}
          applying={retagApplying}
          title="Write Album Tags"
          onOpenChange={setRetagPreviewOpen}
          onApply={handleApplyRetags}
        />
        <Dialog
          open={deleteFilesOpen}
          onOpenChange={(_, data) => {
            if (!data.open && !deleteFilesApplying) {
              setDeleteFilesOpen(false);
              setDeleteFilesUnmonitor(false);
            }
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete album files</DialogTitle>
              <DialogContent>
                Delete imported library files for <strong>{album?.title || "this album"}</strong> from disk
                and remove them from Discogenius tracking. Catalog metadata is kept.
                <div style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={deleteFilesUnmonitor}
                    onChange={(_, data) => setDeleteFilesUnmonitor(Boolean(data.checked))}
                    label="Also unmonitor this album"
                  />
                </div>
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  disabled={deleteFilesApplying}
                  onClick={() => {
                    setDeleteFilesOpen(false);
                    setDeleteFilesUnmonitor(false);
                  }}
                >
                  Cancel
                </Button>
                <Button appearance="primary" disabled={deleteFilesApplying} onClick={() => void handleDeleteAlbumFiles()}>
                  {deleteFilesApplying ? "Deleting…" : "Delete files"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        <Dialog
          open={stripTagsOpen}
          onOpenChange={(_, data) => {
            if (!data.open && !stripTagsApplying) setStripTagsOpen(false);
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Strip tags</DialogTitle>
              <DialogContent>
                Remove embedded metadata tags from imported audio files for{" "}
                <strong>{album?.title || "this album"}</strong>. Files stay on disk; catalog data is unchanged.
                Use Write Tags afterward if you want Discogenius metadata rewritten.
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" disabled={stripTagsApplying} onClick={() => setStripTagsOpen(false)}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={stripTagsApplying} onClick={() => void handleStripAlbumTags()}>
                  {stripTagsApplying ? "Queueing…" : "Strip tags"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        {/* Header Section */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            {/* Cover art with optional info overlay for local covers */}
            {(() => {
              const coverFiles = (album.files || []).filter(
                (f: any) => f.file_type === 'cover' || f.file_type === 'image' || f.file_type === 'video_cover'
              );
              const hasCoverFile = coverFiles.length > 0;
              return (
                <div className={styles.coverContainer}>
                  {albumArtworkUrl ? (
                    <img
                      key={albumArtworkUrl}
                      {...ultraBlurHeroProps}
                      src={albumArtworkUrl}
                      alt=""
                      className={styles.coverArt}
                      onError={() => setCoverImageFailed(true)}
                    />
                  ) : (
                    <div className={styles.coverPlaceholder}>
                      <MusicNote224 />
                    </div>
                  )}
                  {hasCoverFile && (
                    <AppTooltip content="Artwork info" relationship="label">
                      <button
                        type="button"
                        className={styles.coverOverlay}
                        onClick={() => setCoverInfoOpen(true)}
                        aria-label={`Artwork information for ${album.title}`}
                      >
                        <Info24 className={styles.coverInfoIcon} />
                      </button>
                    </AppTooltip>
                  )}
                </div>
              );
            })()}
            <div className={styles.albumInfo}>
              <div className={styles.titleBlock}>
                <div className={styles.artistInfo}>
                  {renderAlbumArtists()}
                </div>
                <Title1 as="h1" className={styles.albumTitle}>{album.title}</Title1>
              </div>

              <div className={styles.metadata}>
                {/* Provider+quality pills sit in the middle; the year/track/
                    duration facts go on the bottom row (column on mobile). */}
                {headerPlanOffers.length > 0 ? (
                  <div className={styles.metadataBadges}>
                    <ProviderQualityRow
                      size="medium"
                      offers={headerPlanOffers}
                    />
                  </div>
                ) : headerQualityBadges.length > 0 ? (
                  <div className={styles.metadataBadges}>
                    {headerQualityBadges.map((badge) => (
                      <QualityBadge key={badge.key} quality={badge.quality} />
                    ))}
                  </div>
                ) : null}
                <div className={styles.metadataFacts}>
                  <Text>{album.release_date ? new Date(album.release_date).getFullYear() : "—"}</Text>
                  <div className={styles.metadataSeparator} />
                  {/* Counts describe only the edition currently on screen. */}
                  {isEditionTrackListLoading ? (
                    <Text>Loading tracks…</Text>
                  ) : editionTrackListError ? (
                    <Text>Tracks unavailable</Text>
                  ) : (
                    <>
                      <Text>{visibleTracks.length} Tracks</Text>
                      <div className={styles.metadataSeparator} />
                      <Text>
                        {formatDurationSeconds(visibleTracks.reduce((acc, t) => acc + t.duration, 0))}
                      </Text>
                    </>
                  )}
                  {hasSpatialOffer && !hasStereoOffer && (
                    <>
                      <div className={styles.metadataSeparator} />
                      <Text weight="semibold">Dolby Atmos only</Text>
                    </>
                  )}
                </div>
              </div>

              {/* Album Review Section */}
              {(() => {
                const reviewText = (album as any).review ?? (album as any).review_text ?? null;
                const reviewAttribution = formatMetadataAttribution(
                  (album as any).review_source,
                  (album as any).review_last_updated
                );
                if (!reviewText) return null;

                return (
                  <ExpandableMetadataBlock
                    content={parseWimpLinks(reviewText, navigate)}
                    attribution={reviewAttribution}
                    expanded={reviewExpanded}
                    onToggle={() => setReviewExpanded(!reviewExpanded)}
                    preserveWhitespace
                  />
                );
              })()}

              <Overflow minimumVisible={3}>
                <div className={styles.actions}>
                  {/* Monitor Button — icon shows action (what clicking will do) */}
                  <OverflowItem id="monitor" priority={3}>
                    <AppTooltip
                      content={monitorAction.tooltip}
                      relationship="description"
                    >
                      <Button
                        appearance={isMonitored ? "subtle" : "primary"}
                        icon={isMonitored ? <EyeOff24 /> : <Eye24 />}
                        onClick={handleToggleMonitor}
                        disabled={monitorAction.disabled}
                        className={mergeClasses(
                          styles.actionButton,
                          isMonitored ? styles.transparentButton : styles.primaryButton
                        )}
                      >
                        {monitorAction.label}
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  {/* Lock Button — icon shows action (what clicking will do) */}
                  <OverflowItem id="lock" priority={2}>
                    <AppTooltip content={isLocked
                      ? "Unlock to let curation change the monitored state, edition choice and acquisition plan"
                      : "Lock the monitored state, edition choice and acquisition plan against curation"} relationship="label">
                      <Button
                        appearance="subtle"
                        icon={isLocked ? <LockOpen24 /> : <LockClosed24 />}
                        onClick={handleToggleLock}
                        disabled={isTogglingLock}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        {isLocked ? "Unlock" : "Lock"}
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  {/* Download Button */}
                  <OverflowItem id="download" priority={1}>
                    {hasStereoOffer && hasSpatialOffer ? (
                      <div className={styles.splitDownload}>
                        <AppTooltip content={`${downloadScopeDescription} in stereo and spatial audio`} relationship="label">
                          <Button
                            icon={<ArrowDownload24 />}
                            appearance="subtle"
                            onClick={handleDownloadPrimary}
                            disabled={downloadingAlbum}
                            className={mergeClasses(styles.actionButton, styles.transparentButton, styles.splitDownloadPrimary)}
                          >
                            {downloadButtonLabel}
                          </Button>
                        </AppTooltip>
                        <Menu>
                          <MenuTrigger disableButtonEnhancement>
                            <Button
                              appearance="subtle"
                              aria-label="Choose download version"
                              icon={<ChevronDown16 />}
                              disabled={downloadingAlbum}
                              className={mergeClasses(styles.transparentButton, styles.splitDownloadMenu)}
                            />
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              <MenuItem onClick={() => handleDownloadAlbum()}>Download all monitored editions in stereo and spatial</MenuItem>
                              <MenuItem onClick={() => handleDownloadAlbum('stereo')}>Download all monitored editions in stereo</MenuItem>
                              <MenuItem onClick={() => handleDownloadAlbum('spatial')}>Download all monitored editions in spatial</MenuItem>
                            </MenuList>
                          </MenuPopover>
                        </Menu>
                      </div>
                    ) : (
                      <AppTooltip content={hasAnyProviderOffer ? downloadScopeDescription : "No provider offer selected"} relationship="label">
                        <Button
                          icon={<ArrowDownload24 />}
                          appearance="subtle"
                          onClick={handleDownloadPrimary}
                          disabled={downloadingAlbum || !hasAnyProviderOffer}
                          className={mergeClasses(styles.actionButton, styles.transparentButton)}
                        >
                          {downloadButtonLabel}
                        </Button>
                      </AppTooltip>
                    )}
                  </OverflowItem>

                  <OverflowItem id="rename-files" priority={0}>
                    <AppTooltip content="Preview album file renames" relationship="label">
                      <Button
                        appearance="subtle"
                        icon={renameApplying ? <Spinner size="tiny" /> : <FolderSync24 />}
                        onClick={openRenamePreview}
                        disabled={renameApplying}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        Rename
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  <OverflowItem id="retag-files" priority={0}>
                    <AppTooltip content="Preview album metadata tag changes" relationship="label">
                      <Button
                        appearance="subtle"
                        icon={retagApplying ? <Spinner size="tiny" /> : <Tag24 />}
                        onClick={openRetagPreview}
                        disabled={retagApplying}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        Tags
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  <ActionOverflowMenu actions={albumActions} className={mergeClasses(styles.actionButton, styles.transparentButton)} />
                </div>
              </Overflow>
            </div>
          </div>
        </div>

        {/* Track List Section */}
        {/* One tab per monitored edition, and only when the API says one list
            cannot show them all. The strip reuses the Dashboard's Queue/Activity
            TabList so the two read as the same control. */}
        {trackListTabs.length > 1 ? (
          <TabList
            className={styles.trackListTabs}
            aria-label="Monitored album editions"
            selectedValue={activeTabEditionId ?? undefined}
            onTabSelect={(_, data) => setSelectedTabEditionId(Number(data.value))}
          >
            {trackListTabs.map((tab) => (
              <Tab
                key={tab.editionId}
                value={tab.editionId}
                title={tab.label}
                aria-label={tab.label}
              >
                {tab.compactLabel}
              </Tab>
            ))}
          </TabList>
        ) : null}
        {isEditionTrackListLoading ? (
          <div className={styles.trackListLoading}>
            <Spinner label={`Loading tracks for ${activeTabLabel}…`} />
          </div>
        ) : editionTrackListError ? (
          <ErrorState
            title={`Couldn’t load ${activeTabLabel}`}
            error={editionTrackListError}
            minHeight="220px"
            actions={(
              <Button appearance="primary" onClick={() => void editionTracksQuery.refetch()}>
                Try again
              </Button>
            )}
          />
        ) : tracksWithAssociatedVideos.length === 0 ? (
          <EmptyState
            title="No tracks found"
            description={activeTabEditionId != null
              ? `${activeTabLabel} doesn't have any surfaced tracks yet.`
              : "This album doesn't have any surfaced tracks yet."}
            icon={<MusicNote224 />}
            minHeight="220px"
          />
        ) : (
          <TrackList
            tracks={tracksWithAssociatedVideos}
            showArtist
            showQuality={true}
            showLocalQuality
            showVolumeHeaders
            contextArtistName={album.artist_name}
            contextAlbumTitle={album.title}
            onDownloadTrack={handleDownloadTrack}
            onAssociatedVideoClick={(_track, videoId) => scrollToAssociatedVideo(videoId)}
            isTrackDownloading={(track) => downloadingTracks.has(track.id)}
          />
        )}

        {associatedVideos.length > 0 ? (
          <div className={styles.sectionSpacing}>
            <div className={styles.sectionHeader}>
              <Title2 as="h2">Associated videos</Title2>
            </div>
            <div
              ref={videoViewMode === "carousel" ? associatedVideoCarouselRef : undefined}
              className={videoViewMode === "grid" ? styles.videoGrid : styles.videoCarousel}
            >
              {associatedVideos.map((video) => {
                const videoId = String(video.id);
                const trackLabel = formatDescriptiveTrackPosition(video);
                const year = video.release_date ? new Date(video.release_date).getFullYear() : null;
                const placementLabel = video.placement?.mode === "inline"
                  ? "Inline"
                  : video.placement?.mode === "separated"
                    ? "Video library"
                    : null;
                const subtitle = [trackLabel, year || null, placementLabel].filter(Boolean).join(" · ");
                const videoProvider = String(video.provider || "").trim() || null;
                const videoProviderId = String(video.provider_id || "").trim() || null;
                const videoQuality = String(video.quality || "").trim() || null;
                const videoOffers: ProviderQualityOffer[] = (videoProvider || videoQuality)
                  ? [{
                      slot: "video",
                      quality: videoQuality,
                      provider: videoProvider,
                      providerAlbumId: videoProviderId,
                      providerUrl: video.provider_url,
                    }]
                  : [];
                return (
                  <div
                    key={videoId}
                    id={albumAssociatedVideoElementId(videoId)}
                    className={styles.videoCardAnchor}
                  >
                    <MediaCard
                      imageUrl={mediaCoverProxySrc(video)}
                      alt={video.title}
                      title={video.title}
                      subtitle={subtitle || undefined}
                      explicit={video.explicit}
                      qualityBadges={videoOffers.length > 0 ? (
                        <ProviderQualityRow size="small" offers={videoOffers} />
                      ) : undefined}
                      monitored={Boolean(video.is_monitored)}
                      monitoringLocked={Boolean(video.monitored_lock)}
                      videoAspect
                      onClick={() => navigate(`/video/${videoId}`)}
                      placeholder={
                        <div className={cardStyles.placeholderBg}>
                          <Play24 className={styles.playIcon} />
                        </div>
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Cover Info Dialog */}
        {coverInfoOpen && (() => {
          const coverFiles = (album.files || []).filter(
            (f: any) => f.file_type === 'cover' || f.file_type === 'image' || f.file_type === 'video_cover'
          );
          return (
            <TrackInfoDialog
              open={coverInfoOpen}
              onClose={() => setCoverInfoOpen(false)}
              trackTitle="Album Cover"
              dialogTitle="Artwork Info"
              detailsTitle="Artwork Details"
              artistName={album.artist_name}
              albumTitle={album.title}
              files={coverFiles as TrackFileInfo[]}
            />
          );
        })()}

        {/* Release Group Releases Section */}
        {isAvailabilityLoading ? (
          <div className={styles.sectionSpacing}>
            <div className={styles.sectionHeader}>
              <Title2 as="h2">Editions</Title2>
            </div>
            <div style={{ padding: "1rem 0", display: "flex", alignItems: "center", gap: "0.5rem", opacity: 0.7 }}>
              <Spinner size="small" label="Loading available editions..." />
            </div>
          </div>
        ) : releaseAvailability && releaseAvailability.releases.length > 0 ? (
          <div className={styles.sectionSpacing}>
            <div className={styles.sectionHeader}>
              <Title2 as="h2">Editions</Title2>
            </div>
            <ReleaseSwitcher
              availability={releaseAvailability}
              currentReleaseMbid={album.selected_release_mbid || album.stereo_release_mbid || album.spatial_release_mbid}
              pendingSelectionKey={pendingSelectionKey}
              onSelect={handleSelectReleaseForLibrary}
              onSelectPlan={handleSelectPlanForLibrary}
              onRevertPlan={handleRevertPlanForLibrary}
              onRemoveEdition={handleRemoveEditionForLibrary}
            />
          </div>
        ) : null}
      </div >
    </DynamicBrandProvider>
  );
};

export default AlbumPage;
