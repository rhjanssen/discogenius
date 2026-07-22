import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Title1,
  Title2,
  Spinner,
  Card,
  Badge,
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
} from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  Eye24Regular,
  EyeOff24Regular,
  ArrowDownload24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Grid24Regular,
  AppsListDetail24Regular,
  Play24Regular,
  Info24Regular,
  Tag24Regular,
  ArrowSortDownLines24Regular,
  FolderSync24Regular,
  ArrowSync24Filled,
  Eye24Filled,
  EyeOff24Filled,
  ArrowDownload24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Grid24Filled,
  AppsListDetail24Filled,
  Play24Filled,
  Info24Filled,
  Tag24Filled,
  ArrowSortDownLines24Filled,
  FolderSync24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { useArtistPage } from "@/hooks/useArtistPage";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import type { TrackListItem } from "@/types/track-list";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useToast } from "@/hooks/useToast";
import { useDelayedVisible } from "@/hooks/useDelayedVisible";
import { mediaCoverSrc } from "@/utils/artwork";
import { WarningBadge } from "@/components/ui/WarningBadge";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { DetailPageSkeleton } from "@/components/ui/LoadingSkeletons";
import { ExpandableMetadataBlock } from "@/components/ui/ExpandableMetadataBlock";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import TrackList from "@/components/TrackList";
import { MediaCard } from "@/components/cards/MediaCard";
import { useCardStyles } from "@/components/cards/cardStyles";
import FilterMenu from "@/components/FilterMenu";
import { StatusFilters, defaultStatusFilters } from "@/utils/statusFilters";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import { useUltraBlurHero } from "@/hooks/useUltraBlurHero";
import { getAlbumPath, navigateToAlbumTrack } from "@/utils/albumNavigation";
import { isSpatialAudioQuality } from "@/utils/spatialAudio";
import {
  compactDetailActionButtonStyles,
  detailActionGlassButtonStyles,
  detailActionPrimaryButtonStyles,
} from "@/components/media/detailActionStyles";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";
import { DataGrid, useDataGridCellStyles } from "@/components/DataGrid";
import type { DataGridColumn } from "@/components/DataGrid";
import { ProviderQualityRow } from "@/components/ui/ProviderQualityPill";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { albumSelectedQualityOffers } from "@/utils/albumSelectedQualityOffers";
import { LibraryRowActions } from "@/components/library/LibraryRowActions";
import {
  RenamePreviewDialog,
  RetagPreviewDialog,
  type RenamePreviewItem,
  type RetagPreviewItem,
} from "@/components/mediafiles/FileMaintenanceDialogs";
import {
  ACTIVITY_REFRESH_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  clearOptimisticMonitorState,
  dispatchActivityRefresh,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
  getOptimisticMonitorState,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";

const ArrowSync24 = bundleIcon(ArrowSync24Filled, ArrowSync24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const Grid24 = bundleIcon(Grid24Filled, Grid24Regular);
const AppsListDetail24 = bundleIcon(AppsListDetail24Filled, AppsListDetail24Regular);
const Play24 = bundleIcon(Play24Filled, Play24Regular);
const Info24 = bundleIcon(Info24Filled, Info24Regular);
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);
const ArrowSortDownLines24 = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24Regular);
const FolderSync24 = bundleIcon(FolderSync24Filled, FolderSync24Regular);

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    width: "100%",
    paddingBottom: `calc(${tokens.spacingVerticalXXXL} * 3)`,
  },
  stateShell: {
    width: "100%",
    alignSelf: "stretch",
  },
  header: {
    position: "relative",
    minHeight: "200px",
    display: "flex",
    alignItems: "flex-start",
    padding: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    gap: tokens.spacingHorizontalL,
    "@media (min-width: 768px)": {
      // Match AlbumPage's desktop header height so detail pages transition
      // without the artist view leaving extra dead space below the actions.
      minHeight: "276px",
      padding: tokens.spacingHorizontalXL,
      paddingTop: tokens.spacingVerticalXL,
      paddingBottom: tokens.spacingVerticalL,
      gap: tokens.spacingHorizontalXXL,
    },
  },
  modules: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  headerContent: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
    width: "100%",
    textAlign: "center",
    "@media (min-width: 768px)": {
      flexDirection: "row",
      alignItems: "stretch",
      textAlign: "left",
      gap: tokens.spacingHorizontalXXL,
    },
  },
  artistImage: {
    // Match album-header mobile presence more closely (was 120 / 160).
    width: "160px",
    height: "160px",
    borderRadius: tokens.borderRadiusCircular,
    objectFit: "cover",
    boxShadow: tokens.shadow28,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "180px",
      height: "180px",
    },
    "@media (min-width: 768px)": {
      width: "200px",
      height: "200px",
      boxShadow: tokens.shadow64,
    },
  },
  artistImageShell: {
    position: "relative",
    flexShrink: 0,
    alignSelf: "center",
    display: "inline-flex",
    lineHeight: 0,
    width: "fit-content",
    maxWidth: "100%",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusCircular,
    "@media (min-width: 768px)": {
      alignSelf: "flex-start",
    },
  },
  artistImageOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    borderRadius: tokens.borderRadiusCircular,
    opacity: 0,
    transition: `opacity ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    cursor: "pointer",
    "&:hover": {
      opacity: 1,
    },
  },
  artworkInfoIcon: {
    color: "white",
    fontSize: "32px",
  },
  artistInfo: {
    display: "flex",
    flexDirection: "column",
    // Section rhythm (title block → actions). Name↔bio lives in titleBlock.
    gap: tokens.spacingVerticalM,
    minWidth: 0,
    width: "100%",
    alignItems: "center",
    textAlign: "center",
    "@media (min-width: 768px)": {
      flex: 1,
      alignItems: "flex-start",
      justifyContent: "flex-end",
      textAlign: "left",
    },
  },
  // Fluent related-content pair: name + bio share XS/SNudge (same as album
  // persona↔title), not the section M gap.
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
  artistTitle: {
    width: "100%",
    textAlign: "center",
    whiteSpace: "normal",
    wordBreak: "break-word",
    "@media (min-width: 768px)": {
      textAlign: "left",
    },
  },
  metaAttribution: {
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "nowrap",
    justifyContent: "center",
    width: "100%",
    // The glass buttons lift (translateY) and cast a shadow on hover; a plain
    // `overflow: hidden` here sliced off their rounded top edge. Keep it visible
    // so the hover state renders fully. Horizontal fit is handled by the
    // ActionOverflowMenu collapsing extra actions rather than by clipping.
    overflow: "visible",
    marginTop: tokens.spacingVerticalS,
    alignItems: "stretch",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      marginTop: tokens.spacingVerticalM,
      flexWrap: "nowrap",
      overflow: "visible",
    },
  },
  // Transparent button base style
  transparentButton: {
    ...detailActionGlassButtonStyles,
  },
  // Primary action button (Monitor when not monitored, Scan when not scanned)
  primaryButton: {
    ...detailActionPrimaryButtonStyles,
  },
  actionButton: {
    ...compactDetailActionButtonStyles,
    minWidth: "76px",
    flexShrink: 0,
    "@media (min-width: 768px)": {
      ...compactDetailActionButtonStyles["@media (min-width: 768px)"],
      minWidth: "auto",
      flexShrink: 0,
    },
  },
  filterViewDesktop: {
    display: "none",
    "@media (min-width: 1280px)": {
      display: "flex",
      gap: tokens.spacingHorizontalS,
      alignItems: "center",
      marginLeft: "auto",
      flexShrink: 0,
    },
  },
  filterViewMobile: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
    "@media (min-width: 1280px)": {
      display: "none",
    },
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  grid: {
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
  carousel: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    overflowX: "auto",
    scrollBehavior: "smooth",
    paddingBottom: tokens.spacingVerticalS,
    // Scroll snap
    scrollSnapType: "x mandatory",
    // Mirror the grid's column sizing so a card is the exact same width in both
    // views — 3-up on mobile, 4-up ≥640px, 6-up ≥900px — with matching gaps.
    // Cards beyond the visible count overflow into the horizontal scroll.
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
    // Hide scrollbar
    scrollbarWidth: "none",
    "&::-webkit-scrollbar": {
      display: "none",
    },
  },
  videoGrid: {
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    "@media (min-width: 640px)": { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" },
    "@media (min-width: 900px)": { gridTemplateColumns: "repeat(6, minmax(0, 1fr))" },
  },
  sectionAction: {
    flexShrink: 0,
  },
  // Shared card surface (card / preview / image / content / title / subtitle /
  // monitor indicator) now comes from useCardStyles in
  // components/cards/cardStyles.ts. Only page-specific keys remain below.
  lockedBadge: {
    position: "absolute",
    bottom: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    zIndex: 2,
  },
  slotBadgeStack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: tokens.spacingVerticalXXS,
  },
  placeholderInitial: {
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground3,
  },
  playIcon: {
    width: "32px",
    height: "32px",
    color: tokens.colorNeutralForeground3,
  },
  avatarPlaceholder: {
    backgroundColor: tokens.colorNeutralBackground3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground3,
  },
});

const COLLAPSED_TOP_TRACK_COUNT = 5;
const EXPANDED_TOP_TRACK_COUNT = 100;
// v2 discards the short-lived pre-release value that could be initialized from
// the identity-only response before monitored content arrived.
const ARTIST_FILTER_STORAGE_KEY = "discogenius_artist_filters_v2";

type ArtistPageFilterPrefs = {
  libraryFilter: 'all' | 'stereo' | 'spatial' | 'video';
  statusFilters: StatusFilters;
};

function readArtistFilterPrefs(artistId: string | undefined): ArtistPageFilterPrefs | null {
  if (!artistId) return null;
  try {
    const raw = localStorage.getItem(ARTIST_FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ArtistPageFilterPrefs>;
    const libraryFilter = parsed.libraryFilter;
    if (libraryFilter !== "all" && libraryFilter !== "stereo" && libraryFilter !== "spatial" && libraryFilter !== "video") {
      return null;
    }

    return {
      libraryFilter,
      statusFilters: {
        ...defaultStatusFilters,
        ...(parsed.statusFilters || {}),
      },
    };
  } catch {
    return null;
  }
}

const ArtistPage = () => {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { artistId } = useParams<{ artistId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();

  // State
  const [syncing, setSyncing] = useState(false);
  const [curating, setCurating] = useState(false);
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
  const [deleteArtistOpen, setDeleteArtistOpen] = useState(false);
  const [deleteArtistAlsoFiles, setDeleteArtistAlsoFiles] = useState(false);
  const [deleteArtistApplying, setDeleteArtistApplying] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [monitorOverride, setMonitorOverride] = useState<boolean | null>(() => (
    artistId ? getOptimisticMonitorState('artist', artistId) ?? null : null
  ));
  const { getProgressByProviderId } = useQueueStatus();

  useDebouncedQueryInvalidation({
    queryKeys: [['artist-activity', artistId]],
    globalEvents: ['command.added', 'command.deleted', 'queue.cleared'],
    windowEvents: [ACTIVITY_REFRESH_EVENT],
    enabled: Boolean(artistId),
    debounceMs: 400,
  });

  const {
    data: pageData,
    isLoading: pageLoading,
    isContentLoading: contentLoading,
    error: pageError,
    refetch: refetchPage,
  } = useArtistPage(artistId) as {
    data: any;
    isLoading: boolean;
    isContentLoading: boolean;
    error: any;
    refetch: () => void;
  };

  // Poll server for active jobs related to this artist (scanning, curating, downloading)
  const { data: activity } = useQuery({
    queryKey: ['artist-activity', artistId],
    queryFn: ({ signal }) => artistId
      ? api.getArtistActivity(artistId, { signal, timeoutMs: 8_000 })
      : null,
    enabled: Boolean(artistId) && !pageLoading && !pageError,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
    retry: 1,
  }) as { data: { scanning?: boolean; curating?: boolean; downloading?: boolean; libraryScan?: boolean; totalActive?: number } | null };

  // Combined busy states: local action flags OR server-side activity
  const isScanBusy = syncing || Boolean(activity?.scanning);
  const isCurateBusy = curating || Boolean(activity?.curating);
  const [viewMode, setViewMode] = useState<'carousel' | 'grid' | 'list'>(() => {
    const saved = localStorage.getItem('discogenius_artist_view_mode') as 'carousel' | 'grid' | 'list' | null;
    return (saved === 'grid' || saved === 'carousel' || saved === 'list') ? saved : 'carousel';
  });

  useEffect(() => {
    localStorage.setItem('discogenius_artist_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    setTopTracksExpanded(false);
  }, [artistId]);

  // Filters - start with onlyMonitored, but will be updated based on data
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'stereo' | 'spatial' | 'video'>(() => (
    readArtistFilterPrefs(artistId)?.libraryFilter ?? 'all'
  ));
  const [configuredStatusFilters, setStatusFilters] = useState<StatusFilters>(() => (
    readArtistFilterPrefs(artistId)?.statusFilters ?? { ...defaultStatusFilters, onlyMonitored: true }
  ));
  const [filterInitialized, setFilterInitialized] = useState(() => Boolean(readArtistFilterPrefs(artistId)));
  const [topTracksExpanded, setTopTracksExpanded] = useState(false);
  const [artistInfoOpen, setArtistInfoOpen] = useState(false);

  useEffect(() => {
    const prefs = readArtistFilterPrefs(artistId);
    setLibraryFilter(prefs?.libraryFilter ?? 'all');
    setStatusFilters(prefs?.statusFilters ?? { ...defaultStatusFilters, onlyMonitored: true });
    setFilterInitialized(Boolean(prefs));
  }, [artistId]);

  useEffect(() => {
    if (!artistId || !filterInitialized) return;
    try {
      localStorage.setItem(ARTIST_FILTER_STORAGE_KEY, JSON.stringify({
        libraryFilter,
        statusFilters: configuredStatusFilters,
      }));
    } catch {
      // Filter persistence is a convenience only; ignore storage failures.
    }
  }, [artistId, configuredStatusFilters, filterInitialized, libraryFilter]);

  // Unified Artist Info - prefer pageData.artist since that's the canonical DB-backed artist payload
  const artistInfo = pageData?.artist;
  const artistName = artistInfo?.name || pageData?.artistInfo?.name || "Unknown Artist";
  const artistBio = artistInfo?.bio || null;
  const artistLocalFiles = Array.isArray(artistInfo?.files) ? artistInfo.files : [];
  const hasLocalArtistPicture = artistLocalFiles.some((file: any) => file.file_type === "cover");
  const bioAttribution = formatMetadataAttribution(artistInfo?.bio_source, artistInfo?.bio_last_updated);
  const artistPictureUrl = artistInfo
    ? (mediaCoverSrc({
        picture: artistInfo.picture || (pageData?.artistInfo as any)?.picture,
      }) || null)
    : undefined;
  const [artistPictureFailed, setArtistPictureFailed] = useState(false);
  const artistBrandColor = useArtworkBrandColor({
    artworkUrl: artistPictureFailed ? null : artistPictureUrl,
    deriveBrandFromArtwork: true,
    ownsAmbience: true,
  });
  const { heroProps: ultraBlurHeroProps } = useUltraBlurHero(
    artistPictureFailed ? null : artistPictureUrl,
  );
  const isMonitored = monitorOverride ?? Boolean(artistInfo?.is_monitored);

  useEffect(() => {
    setArtistPictureFailed(false);
  }, [artistPictureUrl]);

  useEffect(() => {
    if (!artistId) {
      setMonitorOverride(null);
      return;
    }

    const optimisticState = getOptimisticMonitorState('artist', artistId);
    setMonitorOverride(optimisticState ?? null);
  }, [artistId]);

  useEffect(() => {
    if (!artistId || artistInfo?.is_monitored === undefined || monitorOverride === null) {
      return;
    }

    if (Boolean(artistInfo.is_monitored) === monitorOverride) {
      clearOptimisticMonitorState('artist', artistId);
      setMonitorOverride(null);
    }
  }, [artistId, artistInfo?.is_monitored, monitorOverride]);

  const monitoredItemCount = useMemo(() => {
    if (!pageData?.rows) return undefined;
    let count = 0;
    for (const row of pageData.rows) {
      for (const mod of row.modules || []) {
        const items = mod.pagedList?.items || mod.items || [];
        for (const item of items) {
          if (item.is_monitored) count += 1;
        }
      }
    }
    return count;
  }, [pageData?.rows]);

  // Keep the user's monitored preference, but do not turn an artist with no
  // monitored content into an apparently empty page. The preference becomes
  // effective automatically as soon as monitored content exists.
  const statusFilters = useMemo<StatusFilters>(() => (
    monitoredItemCount === 0
      && configuredStatusFilters.onlyMonitored
      && !configuredStatusFilters.onlyUnmonitored
      ? { ...configuredStatusFilters, onlyMonitored: false }
      : configuredStatusFilters
  ), [configuredStatusFilters, monitoredItemCount]);

  useEffect(() => {
    if (filterInitialized || pageLoading || contentLoading || !pageData?.rows) return;
    setFilterInitialized(true);
  }, [pageData, filterInitialized, pageLoading, contentLoading]);

  useEffect(() => {
    const handleMonitorChange = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || !artistId) return;

      if (detail.type === 'artist' && detail.providerId === artistId) {
        setMonitorOverride(detail.monitored);
        refetchPage();
        return;
      }

      // Album/video monitor changes from global search should refresh this page too.
      if (detail.type === 'album' || detail.type === 'video') {
        refetchPage();
      }
    };

    window.addEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorChange as EventListener);

    return () => {
      window.removeEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorChange as EventListener);
    };
  }, [artistId, refetchPage]);

  // Actions
  const toggleMonitoring = async () => {
    if (!artistId) return;
    const nextMonitored = !isMonitored;
    setMonitorOverride(nextMonitored);
    try {
      await api.updateArtist(artistId, { monitored: nextMonitored });
      dispatchMonitorStateChanged({ type: 'artist', providerId: artistId, monitored: nextMonitored });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      setMonitorOverride(!nextMonitored);
      console.error("Error toggling monitoring:", error);
    }
  };

  const syncArtist = async () => {
    if (!artistId) return;
    setSyncing(true);
    dispatchActivityRefresh();
    try {
      const result: any = await api.scanArtist(artistId, { forceUpdate: true });
      toast({
        title: "Refresh & scan queued",
        description: result?.message || "Refreshing MusicBrainz metadata, provider availability, and local files.",
      });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error("Error syncing:", error);
    } finally {
      setSyncing(false);
    }
  };

  const curateArtist = async () => {
    if (!artistId) return;
    setCurating(true);
    dispatchActivityRefresh();
    try {
      const result: any = await api.curateArtist(artistId);
      toast({
        title: "Curation queued",
        description: result?.message || "Queued artist curation.",
      });
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error("Error curating:", error);
      toast({
        title: "Failed to queue curation",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setCurating(false);
    }
  };

  const startDownloads = async () => {
    if (!artistId) return;


    dispatchActivityRefresh();
    try {
      await api.processMonitoredItems(artistId);
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["queue"] }),
        queryClient.invalidateQueries({ queryKey: ["queueDetails"] }),
        queryClient.refetchQueries({ queryKey: ["queue"] }),
        queryClient.refetchQueries({ queryKey: ["queueDetails"] }),
      ]);
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error starting downloads:", error);
    }
  };

  const openRenamePreview = async () => {
    if (!artistId) return;
    setRenameApplying(true);
    try {
      const response = await api.getLibraryRenamePreview({ artistId, limit: 1000 }) as { items: RenamePreviewItem[] };
      const items = response.items.filter((item) => item.missing || item.conflict || item.needs_rename);
      setRenamePreviewItems(items);
      setRenamePreviewOpen(true);
    } catch (error) {
      toast({
        title: "Rename preview failed",
        description: error instanceof Error ? error.message : "Could not load the artist rename preview.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  };

  const handleApplyRenames = async (ids: number[]) => {
    if (!artistId) return;
    setRenameApplying(true);
    try {
      const result: any = await api.applyLibraryRenames(ids.length > 0 ? { ids } : { applyAll: true, artistId });
      toast({
        title: "Rename queued",
        description: result?.message || "Queued artist file renaming.",
      });
      setRenamePreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue rename",
        description: error instanceof Error ? error.message : "Could not queue artist file renaming.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  };

  const openRetagPreview = async () => {
    if (!artistId) return;
    setRetagApplying(true);
    try {
      const response = await api.getRetagPreview({ artistId, limit: 1000 }) as { items: RetagPreviewItem[] };
      setRetagPreviewItems(response.items);
      setRetagPreviewOpen(true);
    } catch (error) {
      toast({
        title: "Retag preview failed",
        description: error instanceof Error ? error.message : "Could not load the artist retag preview.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  };

  const handleApplyRetags = async (ids: number[]) => {
    if (!artistId) return;
    setRetagApplying(true);
    try {
      const result: any = await api.applyRetags(ids.length > 0 ? { ids } : { applyAll: true, artistId });
      toast({
        title: "Retag queued",
        description: result?.message || "Queued artist metadata tag writing.",
      });
      setRetagPreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue retag",
        description: error instanceof Error ? error.message : "Could not queue artist metadata tag writing.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  };


  const toggleAlbumMonitored = useCallback(async (e: React.MouseEvent, albumId: string, nextMonitored: boolean) => {
    e.stopPropagation();
    try {
      await api.updateAlbum(albumId, { monitored: nextMonitored });
      dispatchMonitorStateChanged({ type: 'album', providerId: albumId, monitored: nextMonitored });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error("Error toggling album monitoring:", error);
    }
  }, [refetchPage]);

  const toggleVideoMonitored = async (e: React.MouseEvent, videoId: string, nextMonitored: boolean) => {
    e.stopPropagation();
    try {
      await api.updateVideo(videoId, { monitored: nextMonitored });
      dispatchMonitorStateChanged({ type: 'video', providerId: videoId, monitored: nextMonitored });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error("Error toggling video monitoring:", error);
    }
  };

  const dgCell = useDataGridCellStyles();
  const handleToggleAlbumLock = useCallback(async (e: React.MouseEvent, albumId: string, isLocked: boolean) => {
    e.stopPropagation();
    try {
      await api.updateAlbum(albumId, { monitored_lock: !isLocked });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error('Failed to toggle album lock:', error);
    }
  }, [refetchPage]);

  const handleDownloadAlbumRow = useCallback(async (e: React.MouseEvent, album: any) => {
    e.stopPropagation();
    await api.addAlbum(String(album.id));
  }, []);

  const albumColumns = useMemo<DataGridColumn[]>(() => [
    {
      key: "thumb",
      header: "",
      width: "40px",
      media: true,
      render: (album: any) => {
        const src = mediaCoverSrc(album);
        return src ? (
          <img
            src={src}
            alt={album.title}
            className={dgCell.thumbnailSquare}
          />
        ) : (
          <div className={mergeClasses(dgCell.thumbnailSquare, dgCell.thumbnailPlaceholder)}>?</div>
        );
      },
    },
    {
      key: "title",
      header: "Title",
      width: "1fr",
      render: (album: any) => (
        <div className={dgCell.nameStack}>
          <span className={dgCell.nameCell} title={album.title}>{album.title}</span>
        </div>
      ),
    },
    {
      key: "year",
      header: "Year",
      width: "65px",
      align: "center",
      className: dgCell.hideOnMobile,
      render: (album: any) => {
        const year = album.release_date ? album.release_date.split('-')[0] : '';
        return <>{year || '—'}</>;
      },
    },
    {
      key: "tracks",
      header: "Tracks",
      width: "60px",
      align: "center",
      render: (album: any) => {
        const files = Number(album.track_file_count ?? 0);
        const total = Number(album.track_count ?? album.num_tracks ?? 0);
        return <>{total > 0 ? `${files} / ${total}` : files}</>;
      },
    },
    {
      key: "quality",
      header: "Quality",
      width: "120px",
      align: "left",
      render: (album: any) => {
        const offers = albumSelectedQualityOffers(album);
        if (offers.length > 0) {
          return <ProviderQualityRow size="small" offers={offers} />;
        }
        return album.quality ? <QualityBadge quality={album.quality} size="small" /> : null;
      },
    },
    {
      key: "actions",
      header: "",
      width: "120px",
      align: "right",
      render: (album: any) => {
        const isLocked = Boolean(album.monitored_lock);
        return (
          <LibraryRowActions
            actions={[
              {
                key: "download",
                label: "Download album",
                icon: <ArrowDownload24 />,
                onClick: (event) => handleDownloadAlbumRow(event, album),
              },
              {
                key: "monitor",
                label: isLocked ? "Monitoring is locked" : (album.is_monitored ? "Unmonitor" : "Monitor"),
                icon: album.is_monitored ? <EyeOff24 /> : <Eye24 />,
                onClick: (event) => toggleAlbumMonitored(event, String(album.id), !album.is_monitored),
                disabled: isLocked,
              },
              {
                key: "lock",
                label: isLocked ? "Unlock" : "Lock",
                icon: isLocked ? <LockOpen24 /> : <LockClosed24 />,
                onClick: (event) => handleToggleAlbumLock(event, String(album.id), isLocked),
              },
            ]}
          />
        );
      },
    },
  ], [dgCell, handleDownloadAlbumRow, handleToggleAlbumLock, toggleAlbumMonitored]);

  // Rendering Helpers
  const renderAlbumCard = (item: any) => {
    const providerId = item.id?.toString?.() ?? String(item.id);
    const albumTitle = item.title || "Unknown Album";

    const isAlbumMonitored = Boolean(item.is_monitored);
    const isLocked = Boolean(item.monitored_lock);
    const isDownloaded = Boolean(item.is_downloaded ?? (Number(item.downloaded) >= 100));
    const redundantOf = item.redundant_of ?? item.redundant;
    const isRedundant = Boolean(redundantOf);
    const isPrimary = !isRedundant;

    // Status Filter Logic - each category is independent
    // Within each category: if no filter active = show all, if filter active = must match

    // Monitoring filter
    const hasMonitoringFilter = statusFilters.onlyMonitored || statusFilters.onlyUnmonitored;
    if (hasMonitoringFilter) {
      const matchesMonitored = statusFilters.onlyMonitored && isAlbumMonitored;
      const matchesUnmonitored = statusFilters.onlyUnmonitored && !isAlbumMonitored;
      if (!matchesMonitored && !matchesUnmonitored) return null;
    }

    // Lock filter
    const hasLockFilter = statusFilters.onlyLocked || statusFilters.onlyUnlocked;
    if (hasLockFilter) {
      const matchesLocked = statusFilters.onlyLocked && isLocked;
      const matchesUnlocked = statusFilters.onlyUnlocked && !isLocked;
      if (!matchesLocked && !matchesUnlocked) return null;
    }

    // Download filter
    const hasDownloadFilter = statusFilters.onlyDownloaded || statusFilters.onlyNotDownloaded;
    if (hasDownloadFilter) {
      const matchesDownloaded = statusFilters.onlyDownloaded && isDownloaded;
      const matchesNotDownloaded = statusFilters.onlyNotDownloaded && !isDownloaded;
      if (!matchesDownloaded && !matchesNotDownloaded) return null;
    }

    // Redundancy filter
    const hasRedundancyFilter = statusFilters.onlyPrimary || statusFilters.onlyRedundant;
    if (hasRedundancyFilter) {
      const matchesPrimary = statusFilters.onlyPrimary && isPrimary;
      const matchesRedundant = statusFilters.onlyRedundant && isRedundant;
      if (!matchesPrimary && !matchesRedundant) return null;
    }

    // Library Type Filter
    if (libraryFilter === 'video') return null;

    const hasStereoOffer = Boolean(item.stereo_provider_id);
    const hasSpatialOffer = Boolean(item.spatial_provider_id);
    const quality = libraryFilter === "spatial"
      ? (item.spatial_quality || item.quality || item.derived_quality)
      : libraryFilter === "stereo"
        ? (item.stereo_quality || item.quality || item.derived_quality)
        : (item.quality || item.stereo_quality || item.spatial_quality || item.derived_quality);
    const isSpatial = isSpatialAudioQuality(quality);

    if (libraryFilter === 'stereo' && !hasStereoOffer && isSpatial) return null;
    if (libraryFilter === 'spatial' && !hasSpatialOffer && !isSpatial) return null;

    const imageUrl = mediaCoverSrc(item);
    const year = item.release_date ? new Date(item.release_date).getFullYear() : '';
    const subtitle = item.source === "musicbrainz"
      ? [year || ""].filter(Boolean).join(' · ')
      : [item.artist_name || artistName, year || ''].filter(Boolean).join(' · ');
    const itemProgress = getProgressByProviderId(String(item.stereo_provider_id || ""))
      || getProgressByProviderId(String(item.spatial_provider_id || ""))
      || getProgressByProviderId(String(providerId));
    const stateBadge = isLocked ? (
      <Badge appearance="filled" color="informative" icon={<LockClosed24 />}>
        Locked
      </Badge>
    ) : (isRedundant && !isAlbumMonitored ? (
      <WarningBadge>
        Redundant
      </WarningBadge>
    ) : null);
    const statusBadge = stateBadge
      ? <div className={styles.slotBadgeStack}>{stateBadge}</div>
      : undefined;
    const qualityOffers = albumSelectedQualityOffers(item);

    return (
      <MediaCard
        key={providerId}
        to={getAlbumPath(providerId)}
        imageUrl={imageUrl}
        alt={albumTitle}
        title={albumTitle}
        subtitle={subtitle}
        explicit={item.explicit}
        qualityBadges={qualityOffers.length > 0 ? (
          <ProviderQualityRow size="small" offers={qualityOffers} />
        ) : item.quality ? (
          <QualityBadge quality={item.quality} size="small" />
        ) : undefined}
        monitored={isAlbumMonitored}
        onMonitorToggle={isLocked ? undefined : (e) => toggleAlbumMonitored(e, providerId, !isAlbumMonitored)}
        statusBadge={statusBadge}
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
      />
    );
  };

  // Render an artist card (ARTIST_LIST modules)
  const renderArtistCard = (item: any) => {
    const providerId = item.id?.toString?.() ?? String(item.id);
    const name = item.name || "Unknown Artist";
    const imageUrl = item.picture || item.cover_image_url || null;

    return (
      <Card
        key={providerId}
        className={cardStyles.card}
        onClick={() => navigate(`/artist/${providerId}`)}
      >
        <div className={cardStyles.cardPreview}>
          {imageUrl ? (
            <img src={imageUrl} alt={name} className={cardStyles.cardImage} loading="lazy" />
          ) : (
            <div className={styles.placeholderInitial}>
              {name?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
        </div>
        <div className={cardStyles.cardContent}>
          <div className={cardStyles.cardTitleCenter} title={name}>{name}</div>
        </div>
      </Card>
    );
  };

  // Render a video card
  const renderVideoCard = (item: any) => {
    const providerId = item.id?.toString?.() ?? String(item.id);
    const title = item.title || "Unknown Video";
    const isVideoMonitored = Boolean(item.is_monitored);
    const isLocked = Boolean(item.monitored_lock);
    const isDownloaded = Boolean(item.is_downloaded ?? item.downloaded);
    const imageUrl = mediaCoverSrc(item);
    const year = item.release_date ? new Date(item.release_date).getFullYear() : '';
    const subtitle = [artistName, year || ''].filter(Boolean).join(' · ');

    // Library filter
    if (libraryFilter === 'stereo' || libraryFilter === 'spatial') return null;

    // Status filter - monitoring
    const hasMonitoringFilter = statusFilters.onlyMonitored || statusFilters.onlyUnmonitored;
    if (hasMonitoringFilter) {
      const matchesMonitored = statusFilters.onlyMonitored && isVideoMonitored;
      const matchesUnmonitored = statusFilters.onlyUnmonitored && !isVideoMonitored;
      if (!matchesMonitored && !matchesUnmonitored) return null;
    }

    // Lock filter
    const hasLockFilter = statusFilters.onlyLocked || statusFilters.onlyUnlocked;
    if (hasLockFilter) {
      const matchesLocked = statusFilters.onlyLocked && isLocked;
      const matchesUnlocked = statusFilters.onlyUnlocked && !isLocked;
      if (!matchesLocked && !matchesUnlocked) return null;
    }

    // Download filter
    const hasDownloadFilter = statusFilters.onlyDownloaded || statusFilters.onlyNotDownloaded;
    if (hasDownloadFilter) {
      const matchesDownloaded = statusFilters.onlyDownloaded && isDownloaded;
      const matchesNotDownloaded = statusFilters.onlyNotDownloaded && !isDownloaded;
      if (!matchesDownloaded && !matchesNotDownloaded) return null;
    }

    if (libraryFilter === 'video' || libraryFilter === 'all') {
      return (
        <MediaCard
          key={`${artistId}-${providerId}`}
          imageUrl={imageUrl}
          alt={title}
          title={title}
          subtitle={subtitle}
          explicit={item.explicit}
          monitored={isVideoMonitored}
          monitoringLocked={isLocked}
          videoAspect
          onClick={() => navigate(`/video/${providerId}`)}
          onMonitorToggle={isLocked ? undefined : (e) => toggleVideoMonitored(e, providerId, !isVideoMonitored)}
          placeholder={
            <div className={cardStyles.placeholderBg}>
              <Play24 className={styles.playIcon} />
            </div>
          }
          statusBadge={isLocked ? (
            <Badge appearance="filled" color="informative" icon={<LockClosed24 />}>
              Locked
            </Badge>
          ) : undefined}
          downloadStatus={(() => {
            const progress = getProgressByProviderId(String(providerId));
            return progress && progress.state !== "completed" ? progress.state : undefined;
          })()}
          downloadProgress={getProgressByProviderId(String(providerId))?.progress}
          downloadError={getProgressByProviderId(String(providerId))?.statusMessage}
        />
      );
    }
    return null;
  };

  const filterTopTracks = useCallback((tracks: TrackListItem[]) => {
    return tracks.filter((track) => {
      const qualities = Array.isArray(track.qualityTags) && track.qualityTags.length > 0
        ? track.qualityTags.map((quality) => String(quality || "").toUpperCase())
        : [(track.quality || '').toString().toUpperCase()];
      const hasSpatialQuality = qualities.some((quality) => isSpatialAudioQuality(quality));
      const hasStereoQuality = qualities.some((quality) => quality && !isSpatialAudioQuality(quality));

      if (libraryFilter === 'spatial' && !hasSpatialQuality) return false;
      if (libraryFilter === 'stereo' && !hasStereoQuality) return false;

      const isTrackMonitored = Boolean(track.is_monitored);
      const hasMonitoringFilter = statusFilters.onlyMonitored || statusFilters.onlyUnmonitored;
      if (hasMonitoringFilter) {
        const matchesMonitored = statusFilters.onlyMonitored && isTrackMonitored;
        const matchesUnmonitored = statusFilters.onlyUnmonitored && !isTrackMonitored;
        if (!matchesMonitored && !matchesUnmonitored) return false;
      }

      const isDownloaded = Boolean(track.is_downloaded ?? track.downloaded);
      const hasDownloadFilter = statusFilters.onlyDownloaded || statusFilters.onlyNotDownloaded;
      if (hasDownloadFilter) {
        const matchesDownloaded = statusFilters.onlyDownloaded && isDownloaded;
        const matchesNotDownloaded = statusFilters.onlyNotDownloaded && !isDownloaded;
        if (!matchesDownloaded && !matchesNotDownloaded) return false;
      }

      const isLocked = Boolean(track.monitored_lock);
      const hasLockFilter = statusFilters.onlyLocked || statusFilters.onlyUnlocked;
      if (hasLockFilter) {
        const matchesLocked = statusFilters.onlyLocked && isLocked;
        const matchesUnlocked = statusFilters.onlyUnlocked && !isLocked;
        if (!matchesLocked && !matchesUnlocked) return false;
      }

      return true;
    });
  }, [libraryFilter, statusFilters]);

  const mobileFilterViewRendered = useRef(false);

  const renderMobileFilterView = () => (
    <div className={styles.filterViewMobile}>
      <FilterMenu
        libraryFilter={libraryFilter}
        onLibraryFilterChange={setLibraryFilter}
        statusFilters={statusFilters}
        onStatusFiltersChange={setStatusFilters}
        showDownloadFilter={true}
        showLockFilter={true}
        className={mergeClasses(styles.actionButton, styles.transparentButton)}
      />
      <Button
        appearance="subtle"
        icon={viewMode === 'grid' ? <AppsListDetail24 /> : viewMode === 'list' ? <Grid24 /> : <Grid24 />}
        onClick={() => setViewMode(prev => prev === 'carousel' ? 'grid' : prev === 'grid' ? 'list' : 'carousel')}
        title={`Switch to ${viewMode === 'carousel' ? 'grid' : viewMode === 'grid' ? 'list' : 'carousel'} view`}
        className={mergeClasses(styles.actionButton, styles.transparentButton)}
      >
        View
      </Button>
    </div>
  );

  const claimFirstVisible = () => {
    if (mobileFilterViewRendered.current) return false;
    mobileFilterViewRendered.current = true;
    return true;
  };

  const renderModule = (module: any, _index: number) => {
    const items = module.pagedList?.items || module.items || [];
    if (!items || items.length === 0) return null;

    if (module.type === 'TRACK_LIST') {
      if (libraryFilter === 'video') return null;
      const filteredTracks = filterTopTracks(items);
      if (filteredTracks.length === 0) return null;
      const filteredCount = filteredTracks.length;
      const expandedTrackCount = Math.min(filteredCount, EXPANDED_TOP_TRACK_COUNT);
      const visibleTracks = filteredTracks.slice(
        0,
        topTracksExpanded ? expandedTrackCount : COLLAPSED_TOP_TRACK_COUNT,
      );

      const isFirst = claimFirstVisible();

      return (
        <div key={`${module.type}-${module.title}`} className={styles.section}>
          <div className={styles.sectionHeader}>
            <Title2>{module.title}</Title2>
            {isFirst && renderMobileFilterView()}
            {filteredCount > COLLAPSED_TOP_TRACK_COUNT && (
              <Button
                appearance="subtle"
                size="small"
                className={styles.sectionAction}
                onClick={() => setTopTracksExpanded((previous) => !previous)}
              >
                {topTracksExpanded ? "Show less" : `Show more (${expandedTrackCount})`}
              </Button>
            )}
          </div>
          <TrackList
            tracks={visibleTracks}
            numbering="index"
            showAlbum
            showQuality={false}
            contextArtistName={artistName}
            onDownloadTrack={handleDownloadTrack}
            isTrackDownloading={(track) => downloadingTracks.has(track.id)}
            onTrackClick={(track) => {
              const albumId = track.album_id ?? track.album?.id ?? null;
              if (albumId) {
                navigateToAlbumTrack(navigate, albumId, track.id);
              }
            }}
          />
        </div>
      );
    }

    // Handle VIDEO_LIST
    if (module.type === 'VIDEO_LIST') {
      if (libraryFilter !== 'all' && libraryFilter !== 'video') return null;
      const rendered = items.map(renderVideoCard).filter(Boolean);
      if (rendered.length === 0) return null;
      const isFirst = claimFirstVisible();

      return (
        <div key={`${module.type}-${module.title}`} className={styles.section}>
          <div className={styles.sectionHeader}>
            <Title2>{module.title}</Title2>
            {isFirst && renderMobileFilterView()}
          </div>
          <div className={mergeClasses(viewMode === 'grid' ? styles.grid : styles.carousel, styles.videoGrid)}>
            {rendered}
          </div>
        </div>
      );
    }

    // Determine the appropriate renderer based on module type
    const isArtistModule = module.type === 'ARTIST_LIST';
    const isVideoModule = module.type === 'VIDEO_LIST';
    const renderer = isArtistModule ? renderArtistCard : renderAlbumCard;
    if (libraryFilter === 'video') return null;

    const rendered = items.map(renderer).filter(Boolean);
    if (rendered.length === 0) return null;

    const isFirst = claimFirstVisible();

    const renderGridOrCarousel = () => (
      <div className={viewMode === 'grid' ? styles.grid : styles.carousel}>
        {rendered}
      </div>
    );

    const renderListView = () => (
      <DataGrid
        items={items.filter((item: any) => {
           // Same filter logic as renderAlbumCard
           const isAlbumMonitored = Boolean(item.is_monitored);
           const isLocked = Boolean(item.monitored_lock);
           const isDownloaded = Boolean(item.is_downloaded ?? (Number(item.downloaded) >= 100));
           const hasMonitoringFilter = statusFilters.onlyMonitored || statusFilters.onlyUnmonitored;
           if (hasMonitoringFilter) {
             const matchesMonitored = statusFilters.onlyMonitored && isAlbumMonitored;
             const matchesUnmonitored = statusFilters.onlyUnmonitored && !isAlbumMonitored;
             if (!matchesMonitored && !matchesUnmonitored) return false;
           }
           const hasLockFilter = statusFilters.onlyLocked || statusFilters.onlyUnlocked;
           if (hasLockFilter) {
             const matchesLocked = statusFilters.onlyLocked && isLocked;
             const matchesUnlocked = statusFilters.onlyUnlocked && !isLocked;
             if (!matchesLocked && !matchesUnlocked) return false;
           }
           const hasDownloadFilter = statusFilters.onlyDownloaded || statusFilters.onlyNotDownloaded;
           if (hasDownloadFilter) {
             const matchesDownloaded = statusFilters.onlyDownloaded && isDownloaded;
             const matchesNotDownloaded = statusFilters.onlyNotDownloaded && !isDownloaded;
             if (!matchesDownloaded && !matchesNotDownloaded) return false;
           }
           const redundantOf = item.redundant_of ?? item.redundant;
           const isRedundant = Boolean(redundantOf);
           const isPrimary = !isRedundant;
           const hasRedundancyFilter = statusFilters.onlyPrimary || statusFilters.onlyRedundant;
           if (hasRedundancyFilter) {
             const matchesPrimary = statusFilters.onlyPrimary && isPrimary;
             const matchesRedundant = statusFilters.onlyRedundant && isRedundant;
             if (!matchesPrimary && !matchesRedundant) return false;
           }
           return true;
        })}
        columns={albumColumns}
        onRowClick={(album) => navigate(`/album/${album.id}`)}
      />
    );

    return (
      <div key={`${module.type}-${module.title}`} className={styles.section}>
        <div className={styles.sectionHeader}>
          <Title2>{module.title}</Title2>
          {isFirst && renderMobileFilterView()}
        </div>
        {viewMode === 'list' && !isArtistModule && !isVideoModule ? renderListView() : renderGridOrCarousel()}
      </div>
    );
  };

  // Process Page Data - use pageData.rows for modules (from page endpoint)
  const modules = useMemo(() => {
    const rows = pageData?.rows ?? [];
    const mods: any[] = [];
    rows.forEach((row: any) => {
      (row.modules ?? []).forEach((mod: any) => {
        const items = mod.pagedList?.items || mod.items || [];
        if (items.length > 0) {
          const sortedItems = mod.type === 'ARTIST_LIST'
            ? items
              .map((item: any, itemIndex: number) => ({ item, itemIndex }))
              .sort((left: any, right: any) => {
                const popularityDiff = Number(right.item?.popularity || 0) - Number(left.item?.popularity || 0);
                if (popularityDiff !== 0) {
                  return popularityDiff;
                }

                return left.itemIndex - right.itemIndex;
              })
              .map(({ item }: any) => item)
            : items;

          mods.push({
            title: mod.title,
            type: mod.type,
            items: sortedItems,
          });
        }
      });
    });

    // Sort album-type sections into canonical order. Top Tracks always sits
    // after every release section and before Videos, regardless of which
    // release types the artist has (a release type not in this map used to tie
    // with Top Tracks/Videos at 50 and could push Top Tracks above it).
    const sectionOrder: Record<string, number> = {
      'albums': 1,
      'eps': 2, 'ep': 2,
      'singles': 3, 'single': 3,
      'live': 4, 'live albums': 4,
      'compilations': 5, 'compilation': 5,
      'soundtracks': 6, 'soundtrack': 6,
      'demos': 7, 'demo': 7,
      'remixes': 8, 'remix': 8,
    };
    const orderOf = (mod: any) => {
      if (mod.type === 'VIDEO_LIST') return 100;
      if (mod.type === 'TRACK_LIST') return 90;
      // Every release-group section (known or not) sorts before Top Tracks.
      return sectionOrder[mod.title?.toLowerCase()] ?? 50;
    };
    mods.sort((a, b) => orderOf(a) - orderOf(b));

    return mods;
  }, [pageData]);

  const hasProviderMatchedItems = useMemo(() => modules.some((mod: any) => (
    (mod.items || []).some((item: any) => Boolean(
      item?.stereo_provider_id
      || item?.spatial_provider_id
      || item?.selected_provider_id
      || item?.provider_id
      || (item?.type === "Music Video" && item?.id)
    ))
  )), [modules]);

  const showIngestSkeleton = Boolean(activity?.scanning) && (modules.length === 0 || !pageData?.artist?.last_scanned);
  // Shared delayed-loading policy: sub-second cached loads render blank
  // instead of flashing the full-page skeleton. Ingest syncs are known-long
  // waits, so they keep an immediate skeleton.
  const showPageSkeleton = useDelayedVisible(pageLoading);

  if (pageLoading && !showPageSkeleton && !showIngestSkeleton) {
    return null;
  }

  if (pageLoading || showIngestSkeleton) {
    return (
      <DetailPageSkeleton
        artShape="circle"
        content="cards"
        info="bio"
        cards={6}
        className={styles.container}
        cardsClassName={styles.grid}
        actionWidths={["112px", "142px", "92px", "154px", "88px", "72px"]}
        label={showIngestSkeleton ? "Syncing artist details from MusicBrainz..." : "Loading artist details..."}
      />
    );
  }

  if (pageError) {
    return (
      <div className={styles.stateShell}>
        <ErrorState
          title="Failed to load artist"
          error={pageError as Error}
          minHeight="320px"
          actions={<Button onClick={() => void refetchPage()}>Retry</Button>}
        />
      </div>
    );
  }
  // Button state logic based on actual data rather than scan timestamp
  const albumCount = pageData?.album_count ?? 0;
  const monitoredAlbumCount = pageData?.monitored_album_count ?? 0;
  const hasAlbums = albumCount > 0;
  const hasMonitoredAlbums = monitoredAlbumCount > 0;
  const needsScan = Boolean(pageData?.needs_scan ?? !pageData?.last_scanned);
  const hasBeenScanned = !needsScan;
  const downloadActionDisabled = !hasBeenScanned || isScanBusy || !hasProviderMatchedItems;
  const downloadActionTitle = !hasBeenScanned
    ? 'Get metadata first to enable downloads'
    : isScanBusy
      ? 'Wait for scan to finish'
      : !hasProviderMatchedItems
        ? 'No provider offers are matched yet'
      : 'Download missing releases';
  const scanActionTitle = 'Refresh & Scan';

  const artistActions: OverflowAction[] = [
    { key: 'monitor', label: isMonitored ? 'Unmonitor' : 'Monitor', onClick: toggleMonitoring },
    { key: 'refresh-scan', label: isScanBusy ? 'Scanning...' : 'Refresh & Scan', disabled: isScanBusy, onClick: syncArtist },
    { key: 'curate', label: isCurateBusy ? 'Running...' : 'Curate', disabled: isCurateBusy || isScanBusy || !hasAlbums, onClick: curateArtist },
    { key: 'download-missing', label: 'Download Missing', disabled: downloadActionDisabled, onClick: startDownloads },
    { key: 'rename-files', label: renameApplying ? 'Loading rename...' : 'Preview Rename', disabled: renameApplying, onClick: openRenamePreview },
    { key: 'retag-files', label: retagApplying ? 'Loading tags...' : 'Write Tags', disabled: retagApplying, onClick: openRetagPreview },
    { key: 'strip-tags', label: stripTagsApplying ? 'Queueing…' : 'Strip Tags…', disabled: stripTagsApplying, onClick: () => setStripTagsOpen(true) },
    { key: 'delete-files', label: 'Delete files…', disabled: deleteFilesApplying || deleteArtistApplying, onClick: () => setDeleteFilesOpen(true) },
    { key: 'delete-artist', label: 'Delete artist…', disabled: deleteFilesApplying || deleteArtistApplying, onClick: () => setDeleteArtistOpen(true) },
  ];

  const handleDeleteArtistFiles = async () => {
    if (!artistId) return;
    setDeleteFilesApplying(true);
    try {
      const result: any = await api.deleteArtistFiles(artistId, { unmonitor: deleteFilesUnmonitor });
      toast({
        title: "Artist files deleted",
        description: `Removed ${result?.deleted ?? 0} file(s)${result?.unmonitored ? " and unmonitored the artist" : ""}.`,
      });
      setDeleteFilesOpen(false);
      setDeleteFilesUnmonitor(false);
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
      queryClient.invalidateQueries({ queryKey: ["artist-page", artistId] });
    } catch (error) {
      toast({
        title: "Failed to delete artist files",
        description: error instanceof Error ? error.message : "Could not delete artist files.",
        variant: "destructive",
      });
    } finally {
      setDeleteFilesApplying(false);
    }
  };

  const handleStripArtistTags = async () => {
    if (!artistId) return;
    setStripTagsApplying(true);
    try {
      const result: any = await api.stripTags({ applyAll: true, artistId });
      toast({
        title: "Strip tags queued",
        description: result?.message || "Queued removing embedded tags from artist files.",
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

  const handleDeleteArtist = async () => {
    if (!artistId) return;
    setDeleteArtistApplying(true);
    try {
      const result: any = await api.deleteArtist(artistId, { deleteFiles: deleteArtistAlsoFiles });
      toast({
        title: "Artist deleted",
        description: deleteArtistAlsoFiles
          ? `Removed ${artistName || "artist"} from the library and deleted ${result?.deletedFiles ?? 0} file(s).`
          : `Removed ${artistName || "artist"} from the library. Files on disk were kept.`,
      });
      setDeleteArtistOpen(false);
      setDeleteArtistAlsoFiles(false);
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
      queryClient.invalidateQueries({ queryKey: ["artists"] });
      navigate("/library");
    } catch (error) {
      toast({
        title: "Failed to delete artist",
        description: error instanceof Error ? error.message : "Could not delete artist.",
        variant: "destructive",
      });
    } finally {
      setDeleteArtistApplying(false);
    }
  };

  // Reset mobile filter/view tracking each render so it appears on the first visible section
  mobileFilterViewRendered.current = false;

  return (
    <DynamicBrandProvider keyColor={artistBrandColor}>
      <div className={styles.container}>
        <RenamePreviewDialog
          open={renamePreviewOpen}
          items={renamePreviewItems}
          applying={renameApplying}
          title="Preview Artist Rename"
          onOpenChange={setRenamePreviewOpen}
          onApply={handleApplyRenames}
        />
        <RetagPreviewDialog
          open={retagPreviewOpen}
          items={retagPreviewItems}
          applying={retagApplying}
          title="Write Artist Tags"
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
              <DialogTitle>Delete artist files</DialogTitle>
              <DialogContent>
                Delete all imported library files for <strong>{artistName || "this artist"}</strong> from disk
                and remove them from Discogenius tracking. Catalog metadata is kept.
                <div style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={deleteFilesUnmonitor}
                    onChange={(_, data) => setDeleteFilesUnmonitor(Boolean(data.checked))}
                    label="Also unmonitor this artist"
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
                <Button appearance="primary" disabled={deleteFilesApplying} onClick={() => void handleDeleteArtistFiles()}>
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
                <strong>{artistName || "this artist"}</strong>. Files stay on disk; catalog data is unchanged.
                Use Write Tags afterward if you want Discogenius metadata rewritten.
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" disabled={stripTagsApplying} onClick={() => setStripTagsOpen(false)}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={stripTagsApplying} onClick={() => void handleStripArtistTags()}>
                  {stripTagsApplying ? "Queueing…" : "Strip tags"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        <Dialog
          open={deleteArtistOpen}
          onOpenChange={(_, data) => {
            if (!data.open && !deleteArtistApplying) {
              setDeleteArtistOpen(false);
              setDeleteArtistAlsoFiles(false);
            }
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete artist</DialogTitle>
              <DialogContent>
                Remove <strong>{artistName || "this artist"}</strong> from your Discogenius library.
                Catalog metadata for MusicBrainz stays available for re-import.
                <div style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={deleteArtistAlsoFiles}
                    onChange={(_, data) => setDeleteArtistAlsoFiles(Boolean(data.checked))}
                    label="Also delete imported files from disk"
                  />
                </div>
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  disabled={deleteArtistApplying}
                  onClick={() => {
                    setDeleteArtistOpen(false);
                    setDeleteArtistAlsoFiles(false);
                  }}
                >
                  Cancel
                </Button>
                <Button appearance="primary" disabled={deleteArtistApplying} onClick={() => void handleDeleteArtist()}>
                  {deleteArtistApplying ? "Deleting…" : "Delete artist"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            {/* Artist Avatar */}
            <div className={styles.artistImageShell}>
              {artistPictureUrl && !artistPictureFailed ? (
                <img
                  {...ultraBlurHeroProps}
                  src={artistPictureUrl} 
                  className={styles.artistImage} 
                  alt={artistName}
                  onError={() => setArtistPictureFailed(true)}
                />
              ) : (
                <div
                  className={mergeClasses(styles.artistImage, styles.avatarPlaceholder)}
                >
                  {artistName?.charAt(0)?.toUpperCase() || '?'}
                </div>
              )}
              {hasLocalArtistPicture && (
                <div
                  className={styles.artistImageOverlay}
                  onClick={() => setArtistInfoOpen(true)}
                  title="Artwork info"
                >
                  <Info24 className={styles.artworkInfoIcon} />
                </div>
              )}
            </div>
            <div className={styles.artistInfo}>
              <div className={styles.titleBlock}>
                <Title1 className={styles.artistTitle}>{artistName}</Title1>
                {artistBio && (
                  <ExpandableMetadataBlock
                    content={parseWimpLinks(artistBio, navigate)}
                    attribution={bioAttribution}
                    expanded={bioExpanded}
                    onToggle={() => setBioExpanded(!bioExpanded)}
                  />
                )}
              </div>

              <Overflow minimumVisible={3}>
                <div className={styles.actions}>
                  <OverflowItem id="monitor" priority={4}>
                    <AppTooltip
                      content={isMonitored ? "Click to stop monitoring" : "Click to enable monitoring"}
                      relationship="label"
                    >
                      <Button
                        appearance={isMonitored ? "subtle" : "primary"}
                        icon={isMonitored ? <EyeOff24 /> : <Eye24 />}
                        onClick={toggleMonitoring}
                        className={mergeClasses(
                          styles.actionButton,
                          isMonitored ? styles.transparentButton : styles.primaryButton
                        )}
                      >
                        {isMonitored ? "Unmonitor" : "Monitor"}
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  <OverflowItem id="refresh-scan" priority={3}>
                    <AppTooltip content={isScanBusy ? "Scanning..." : scanActionTitle} relationship="label">
                      <Button
                        appearance={!hasBeenScanned ? "primary" : "subtle"}
                        icon={isScanBusy ? <Spinner size="tiny" /> : <ArrowSync24 />}
                        onClick={syncArtist}
                        disabled={isScanBusy}
                        className={mergeClasses(
                          styles.actionButton,
                          !hasBeenScanned ? styles.primaryButton : styles.transparentButton
                        )}
                      >
                        {isScanBusy ? "Scanning..." : "Refresh & Scan"}
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  <OverflowItem id="curate" priority={2}>
                    <AppTooltip
                      content={!hasAlbums ? "Refresh & Scan first" : (isScanBusy ? "Wait for scan to finish" : "Curate")}
                      relationship="label"
                    >
                      <Button
                        appearance={(hasAlbums && !hasMonitoredAlbums) ? "primary" : "subtle"}
                        icon={isCurateBusy ? <Spinner size="tiny" /> : <ArrowSortDownLines24 />}
                        onClick={curateArtist}
                        disabled={isCurateBusy || isScanBusy || !hasAlbums}
                        className={mergeClasses(
                          styles.actionButton,
                          (hasAlbums && !hasMonitoredAlbums) ? styles.primaryButton : styles.transparentButton
                        )}
                      >
                        {isCurateBusy ? "Running..." : "Curate"}
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  <OverflowItem id="download-missing" priority={1}>
                    <AppTooltip content={downloadActionTitle} relationship="label">
                      <Button
                        appearance="subtle"
                        icon={<ArrowDownload24 />}
                        onClick={startDownloads}
                        disabled={downloadActionDisabled}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        Download Missing
                      </Button>
                    </AppTooltip>
                  </OverflowItem>

                  <OverflowItem id="rename-files" priority={0}>
                    <AppTooltip content="Preview artist file renames" relationship="label">
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
                    <AppTooltip content="Preview artist metadata tag changes" relationship="label">
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

                  <ActionOverflowMenu actions={artistActions} className={mergeClasses(styles.actionButton, styles.transparentButton)} />

                  <div className={styles.filterViewDesktop}>
                    <FilterMenu
                      libraryFilter={libraryFilter}
                      onLibraryFilterChange={setLibraryFilter}
                      statusFilters={statusFilters}
                      onStatusFiltersChange={setStatusFilters}
                      showDownloadFilter={true}
                      showLockFilter={true}
                      className={mergeClasses(styles.actionButton, styles.transparentButton)}
                    />

                    <AppTooltip
                      content={viewMode === 'grid' ? "Switch to carousel view" : "Switch to grid view"}
                      relationship="label"
                    >
                      <Button
                        appearance="subtle"
                        icon={viewMode === 'grid' ? <AppsListDetail24 /> : <Grid24 />}
                        onClick={() => setViewMode(prev => prev === 'grid' ? 'carousel' : 'grid')}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        View
                      </Button>
                    </AppTooltip>
                  </div>
                </div>
              </Overflow>
            </div>
          </div>
        </div>

        {/* Dynamic Modules */}
        <div className={styles.modules}>
          {modules.map((mod, i) => renderModule(mod, i))}
          {contentLoading && modules.length === 0 && (
            <Spinner label="Loading artist library..." />
          )}
        </div>

        {modules.length === 0 && !pageLoading && !contentLoading && (
          <EmptyState
            title="No content found"
            description={!hasBeenScanned ? "Try getting metadata first." : "This artist does not have any surfaced modules yet."}
            icon={<FolderSync24 />}
            minHeight="220px"
          />
        )}

        {artistInfoOpen && (
          <TrackInfoDialog
            open={artistInfoOpen}
            onClose={() => setArtistInfoOpen(false)}
            trackTitle="Artist Files"
            dialogTitle="Artist Info"
            detailsTitle="Artist Details"
            artistName={artistName}
            files={artistLocalFiles}
          />
        )}
      </div>
    </DynamicBrandProvider>
  );
};

export default ArtistPage;
