import React, { useState, useEffect, useMemo, useContext, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Text,
  Title1,
  Title2,
  Spinner,
  Card,
  Badge,
  Skeleton,
  SkeletonItem,
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
  Filter24Regular,
  ArrowDownload24Regular,
  LockClosed24Regular,
  Grid24Regular,
  AppsListDetail24Regular,
  Play24Regular,
  Info24Regular,
  ArrowSortDownLines24Regular,
  FolderSync24Regular,
} from "@fluentui/react-icons";import { api } from "@/services/api";
import { useArtistPage } from "@/hooks/useArtistPage";
import { useMonitoring } from "@/hooks/useMonitoring";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import type { TrackListItem } from "@/types/track-list";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useToast } from "@/hooks/useToast";
import { getAlbumCover, getArtistPicture, getVideoThumbnail } from "@/utils/tidalImages";
import { WarningBadge } from "@/components/ui/WarningBadge";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { CardGridSkeleton } from "@/components/ui/LoadingSkeletons";
import { ExpandableMetadataBlock } from "@/components/ui/ExpandableMetadataBlock";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import TrackList from "@/components/TrackList";
import { MediaCard } from "@/components/cards/MediaCard";
import FilterMenu from "@/components/FilterMenu";
import { StatusFilters, defaultStatusFilters } from "@/utils/statusFilters";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { DownloadOverlay } from "@/components/ui/DownloadOverlay";
import { QueueContext } from "@/providers/QueueProvider";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import { getAlbumPath, navigateToAlbumTrack } from "@/utils/albumNavigation";
import {
  compactDetailActionButtonStyles,
  detailActionButtonRadiusStyles,
} from "@/components/media/detailActionStyles";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";
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
      minHeight: "300px",
      padding: tokens.spacingHorizontalXL,
      paddingTop: tokens.spacingVerticalXXL,
      paddingBottom: tokens.spacingVerticalS,
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
    width: "120px",
    height: "120px",
    borderRadius: tokens.borderRadiusCircular,
    objectFit: "cover",
    boxShadow: tokens.shadow28,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "160px",
      height: "160px",
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
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    width: "100%",
    alignItems: "center",
    textAlign: "center",
    "@media (min-width: 768px)": {
      flex: 1,
      alignItems: "flex-start",
      justifyContent: "flex-end",
      textAlign: "left",
      gap: tokens.spacingVerticalS,
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
    overflow: "hidden",
    marginTop: tokens.spacingVerticalS,
    alignItems: "stretch",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      marginTop: tokens.spacingVerticalM,
      overflow: "visible",
    },
  },
  // Transparent button base style
  transparentButton: {
    ...detailActionButtonRadiusStyles,
  },
  // Primary action button (Monitor when not monitored, Scan when not scanned)
  primaryButton: {
    ...detailActionButtonRadiusStyles,
  },
  actionButton: {
    ...compactDetailActionButtonStyles,
    minWidth: "76px",
    "@media (min-width: 768px)": {
      ...compactDetailActionButtonStyles["@media (min-width: 768px)"],
      minWidth: "auto",
    },
  },
  filterViewDesktop: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "flex",
      gap: tokens.spacingHorizontalS,
      alignItems: "center",
      marginLeft: "auto",
    },
  },
  filterViewMobile: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
    "@media (min-width: 768px)": {
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
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    "@media (min-width: 480px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
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
    "& > *": {
      scrollSnapAlign: "start",
      // Card widths in carousel
      width: "calc((100vw - 56px) / 3)",
      flexShrink: 0,
    },
    "@media (min-width: 480px)": {
      gap: tokens.spacingHorizontalM,
      "& > *": {
        width: "148px",
      },
    },
    "@media (min-width: 768px)": {
      "& > *": {
        width: "160px",
      },
    },
    "@media (min-width: 900px)": {
      "& > *": {
        width: "180px",
      },
    },
    // Hide scrollbar
    scrollbarWidth: "none",
    "&::-webkit-scrollbar": {
      display: "none",
    },
  },
  videoGrid: {
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    "& > *": {
      minWidth: "220px",
      maxWidth: "280px",
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
      "& > *": {
        minWidth: "260px",
        maxWidth: "320px",
      },
    },
  },
  sectionAction: {
    flexShrink: 0,
  },
  card: {
    minWidth: "0",
    width: "100%",
    maxWidth: "100%",
    height: "100%",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    boxShadow: tokens.shadow8,
    transition: `all ${tokens.durationFast} ${tokens.curveEasyEase}`,
    padding: tokens.spacingVerticalNone,
    "&:hover": {
      transform: "translateY(-2px)",
      boxShadow: tokens.shadow28,
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1Hover}`,
    },
    "&:active": {
      transform: "translateY(0px)",
      boxShadow: tokens.shadow8,
    },
  },
  cardPreview: {
    position: "relative",
    aspectRatio: "1/1",
    width: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
    margin: tokens.spacingVerticalNone,
    padding: tokens.spacingVerticalNone,
    overflow: "hidden",
  },
  cardImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
    borderRadius: tokens.borderRadiusNone,
  },
  cardContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  cardTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    lineHeight: tokens.lineHeightBase300,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardTitleCenter: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    lineHeight: tokens.lineHeightBase300,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "center",
  },
  cardSubtitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  explicitBadge: {
    marginLeft: "auto",
    flexShrink: 0,
  },
  monitoredBadge: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    zIndex: 2,
  },
  qualityBadge: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    zIndex: 2,
  },
  lockedBadge: {
    position: "absolute",
    bottom: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    zIndex: 2,
  },
  statusBadge: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    zIndex: 2,
  },
  monitorIndicator: {
    position: "absolute",
    bottom: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    zIndex: 2,
    width: "24px",
    height: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: tokens.borderRadiusCircular,
    backdropFilter: "blur(20px)",
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
  },
  monitorIcon: {
    width: "16px",
    height: "16px",
    color: tokens.colorNeutralForeground2,
  },
  monitorIconMuted: {
    width: "16px",
    height: "16px",
    color: tokens.colorNeutralForegroundDisabled,
  },
  placeholderBg: {
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
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
  videoCard: {
    minWidth: "0",
  },
  videoPreview: {
    aspectRatio: "3/2",
  },
  videoPlaceholder: {
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
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
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: tokens.colorBackgroundOverlay,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
});

const COLLAPSED_TOP_TRACK_COUNT = 5;
const EXPANDED_TOP_TRACK_COUNT = 50;

const ArtistPage = () => {
  const styles = useStyles();
  const { artistId } = useParams<{ artistId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { toggleMonitor, toggleLock } = useMonitoring();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();

  // State
  const [syncing, setSyncing] = useState(false);
  const [curating, setCurating] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [monitorOverride, setMonitorOverride] = useState<boolean | null>(() => (
    artistId ? getOptimisticMonitorState('artist', artistId) ?? null : null
  ));
  const queueCtx = useContext(QueueContext);
  const progressMap = queueCtx?.progress;

  useDebouncedQueryInvalidation({
    queryKeys: [['artist-activity', artistId]],
    globalEvents: ['job.added', 'job.deleted', 'queue.cleared'],
    windowEvents: [ACTIVITY_REFRESH_EVENT],
    enabled: Boolean(artistId),
    debounceMs: 400,
  });

  const { data: pageData, isLoading: pageLoading, error: pageError, refetch: refetchPage } = useArtistPage(artistId) as { data: any, isLoading: boolean, error: any, refetch: () => void };

  // Poll server for active jobs related to this artist (scanning, curating, downloading)
  const { data: activity } = useQuery({
    queryKey: ['artist-activity', artistId],
    queryFn: () => artistId ? api.getArtistActivity(artistId) : null,
    enabled: Boolean(artistId) && !pageLoading && !pageError,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
    placeholderData: (previousData) => previousData,
  }) as { data: { scanning?: boolean; curating?: boolean; downloading?: boolean; libraryScan?: boolean; totalActive?: number } | null };

  // Combined busy states: local action flags OR server-side activity
  const isScanBusy = syncing || Boolean(activity?.scanning);
  const isCurateBusy = curating || Boolean(activity?.curating);
  const isRescanning = rescanning || Boolean(activity?.libraryScan);
  const hasActiveWork = isScanBusy || isCurateBusy || isRescanning;
  const [viewMode, setViewMode] = useState<'carousel' | 'grid'>(() => {
    const saved = localStorage.getItem('discogenius_artist_view_mode');
    return (saved === 'grid' || saved === 'carousel') ? saved : 'carousel';
  });

  useEffect(() => {
    localStorage.setItem('discogenius_artist_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    setTopTracksExpanded(false);
  }, [artistId]);

  // Filters - start with onlyMonitored, but will be updated based on data
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'stereo' | 'atmos' | 'video'>('all');
  const [statusFilters, setStatusFilters] = useState<StatusFilters>({ ...defaultStatusFilters, onlyMonitored: true });
  const [filterInitialized, setFilterInitialized] = useState(false);
  const [topTracksExpanded, setTopTracksExpanded] = useState(false);
  const [artistInfoOpen, setArtistInfoOpen] = useState(false);

  // Unified Artist Info - prefer pageData.artist since that's the canonical DB-backed artist payload
  const artistInfo = pageData?.artist;
  const artistName = artistInfo?.name || pageData?.artistInfo?.name || "Unknown Artist";
  const artistBio = artistInfo?.bio || null;
  const artistLocalFiles = Array.isArray(artistInfo?.files) ? artistInfo.files : [];
  const hasLocalArtistPicture = artistLocalFiles.some((file: any) => file.file_type === "cover");
  const bioAttribution = formatMetadataAttribution(artistInfo?.bio_source, artistInfo?.bio_last_updated);
  // Get artist picture UUID for utility function (DB stores as picture, Tidal API returns as picture)
  const artistPictureId = artistInfo?.picture || pageData?.artistInfo?.picture;
  const artistPictureUrl = getArtistPicture(artistPictureId, 'large');
  const artistBrandColor = useArtworkBrandColor({
    artworkUrl: artistPictureUrl,
    deriveBrandFromArtwork: true,
  });
  const isMonitored = monitorOverride ?? Boolean(artistInfo?.is_monitored);

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

  // Count monitored items from all modules to determine filter default
  useEffect(() => {
    if (filterInitialized || !pageData?.rows) return;

    let monitoredCount = 0;
    for (const row of pageData.rows) {
      for (const mod of row.modules || []) {
        const items = mod.pagedList?.items || mod.items || [];
        for (const item of items) {
          if (item.is_monitored || item.monitor) {
            monitoredCount++;
          }
        }
      }
    }

    // If no monitored items, disable the monitored filter
    if (monitoredCount === 0) {
      setStatusFilters({ ...defaultStatusFilters, onlyMonitored: false });
    }
    setFilterInitialized(true);
  }, [pageData, filterInitialized]);

  useEffect(() => {
    const handleMonitorChange = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || !artistId) return;

      if (detail.type === 'artist' && detail.tidalId === artistId) {
        setMonitorOverride(detail.monitored);
        refetchPage();
        return;
      }

      // Album/video monitor changes from global search should refresh this page too.
      if (detail.type === 'album' || detail.type === 'video') {
        refetchPage();
      }
    };

    const handleActivityRefresh = () => {
      refetchPage();
    };

    window.addEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorChange as EventListener);
    window.addEventListener(ACTIVITY_REFRESH_EVENT, handleActivityRefresh);

    return () => {
      window.removeEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorChange as EventListener);
      window.removeEventListener(ACTIVITY_REFRESH_EVENT, handleActivityRefresh);
    };
  }, [artistId, refetchPage]);

  // Actions
  const toggleMonitoring = async () => {
    if (!artistId) return;
    const nextMonitored = !isMonitored;
    setMonitorOverride(nextMonitored);
    try {
      await api.updateArtist(artistId, { monitored: nextMonitored });
      dispatchMonitorStateChanged({ type: 'artist', tidalId: artistId, monitored: nextMonitored });
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
        description: result?.message || "Refreshing TIDAL metadata and scanning local files.",
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
      const result: any = await api.processRedundancy(artistId);
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
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error starting downloads:", error);
    }
  };

  const rescanFiles = async () => {
    if (!artistId) return;
    setRescanning(true);
    try {
      await api.libraryScan(artistId, {
        skipDownloadQueue: true,
        skipCuration: true,
        skipMetadataBackfill: true,
      });
      toast({
        title: "Library scan queued",
        description: "Scanning local files and importing changes. Curation and downloads stay unchanged.",
      });
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error queuing library scan:", error);
      toast({
        title: "Library scan failed",
        description: String(error),
      });
    } finally {
      setRescanning(false);
    }
  };

  const toggleAlbumMonitored = async (e: React.MouseEvent, albumId: string, nextMonitored: boolean) => {
    e.stopPropagation();
    try {
      await api.updateAlbum(albumId, { monitored: nextMonitored });
      dispatchMonitorStateChanged({ type: 'album', tidalId: albumId, monitored: nextMonitored });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error("Error toggling album monitoring:", error);
    }
  };

  const toggleVideoMonitored = async (e: React.MouseEvent, videoId: string, nextMonitored: boolean) => {
    e.stopPropagation();
    try {
      await api.updateVideo(videoId, { monitored: nextMonitored });
      dispatchMonitorStateChanged({ type: 'video', tidalId: videoId, monitored: nextMonitored });
      dispatchLibraryUpdated();
      refetchPage();
    } catch (error) {
      console.error("Error toggling video monitoring:", error);
    }
  };

  // Rendering Helpers
  const renderAlbumCard = (item: any) => {
    const tidalId = item.id?.toString?.() ?? String(item.id);
    const albumTitle = item.title || "Unknown Album";

    const isAlbumMonitored = Boolean(item.is_monitored ?? item.monitor);
    const isLocked = Boolean(item.monitor_locked ?? item.monitor_lock);
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

    // Redundancy filter
    const hasRedundancyFilter = statusFilters.onlyPrimary || statusFilters.onlyRedundant;
    if (hasRedundancyFilter) {
      const matchesPrimary = statusFilters.onlyPrimary && isPrimary;
      const matchesRedundant = statusFilters.onlyRedundant && isRedundant;
      if (!matchesPrimary && !matchesRedundant) return null;
    }

    // Library Type Filter
    if (libraryFilter === 'video') return null;

    const quality = item.quality || item.derived_quality;
    const isAtmos = String(quality || '').toUpperCase() === 'DOLBY_ATMOS';

    if (libraryFilter === 'stereo' && isAtmos) return null;
    if (libraryFilter === 'atmos' && !isAtmos) return null;

    const imageUrl = getAlbumCover(item.cover_id, 'small');
    const year = item.release_date ? new Date(item.release_date).getFullYear() : '';
    const subtitle = [item.artist_name || artistName, year || ''].filter(Boolean).join(' · ');
    const itemProgress = progressMap?.get(Number(tidalId));
    const statusBadge = isLocked ? (
      <Badge appearance="filled" color="informative" icon={<LockClosed24Regular />}>
        Locked
      </Badge>
    ) : (isRedundant && !isAlbumMonitored ? (
      <WarningBadge>
        Redundant
      </WarningBadge>
    ) : undefined);

    return (
      <MediaCard
        key={tidalId}
        to={getAlbumPath(tidalId)}
        imageUrl={imageUrl}
        alt={albumTitle}
        title={albumTitle}
        subtitle={subtitle}
        explicit={item.explicit}
        quality={quality as any}
        monitored={isAlbumMonitored}
        onMonitorToggle={isLocked ? undefined : (e) => toggleAlbumMonitored(e, tidalId, !isAlbumMonitored)}
        statusBadge={statusBadge}
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
      />
    );
  };

  // Render an artist card (for Similar Artists, Influencers sections)
  const renderArtistCard = (item: any) => {
    const tidalId = item.id?.toString?.() ?? String(item.id);
    const name = item.name || "Unknown Artist";
    const pictureId = item.picture || null;
    const imageUrl = pictureId ? getArtistPicture(pictureId, 'medium') : null;

    return (
      <Card
        key={tidalId}
        className={styles.card}
        onClick={() => navigate(`/artist/${tidalId}`)}
      >
        <div className={styles.cardPreview}>
          {imageUrl ? (
            <img src={imageUrl} alt={name} className={styles.cardImage} loading="lazy" />
          ) : (
            <div className={styles.placeholderInitial}>
              {name?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
        </div>
        <div className={styles.cardContent}>
          <div className={styles.cardTitleCenter} title={name}>{name}</div>
        </div>
      </Card>
    );
  };

  // Render a video card
  const renderVideoCard = (item: any) => {
    const tidalId = item.id?.toString?.() ?? String(item.id);
    const title = item.title || "Unknown Video";
    const isVideoMonitored = Boolean(item.is_monitored ?? item.monitor);
    const isLocked = Boolean(item.monitor_locked ?? item.monitor_lock);
    const imageUrl = getVideoThumbnail(item.cover_id, 'small');
    const year = item.release_date ? new Date(item.release_date).getFullYear() : '';
    const subtitle = [artistName, year || ''].filter(Boolean).join(' · ');

    // Library filter
    if (libraryFilter === 'stereo' || libraryFilter === 'atmos') return null;

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

    if (libraryFilter === 'video' || libraryFilter === 'all') {
      return (
        <Card
          key={tidalId}
          className={mergeClasses(styles.card, styles.videoCard)}
          onClick={() => navigate(`/video/${tidalId}`)}
        >
          <div className={mergeClasses(styles.cardPreview, styles.videoPreview)}>
            {imageUrl ? (
              <img src={imageUrl} alt={title} className={styles.cardImage} loading="lazy" />
            ) : (
              <div className={styles.videoPlaceholder}>
                <Play24Regular className={styles.playIcon} />
              </div>
            )}
            {isLocked && (
              <Badge
                appearance="filled"
                color="informative"
                className={styles.lockedBadge}
                icon={<LockClosed24Regular />}
              >
                Locked
              </Badge>
            )}
            <div
              className={styles.monitorIndicator}
              role="button"
              tabIndex={0}
              onClick={(e) => toggleVideoMonitored(e, tidalId, !isVideoMonitored)}
              title={isLocked ? 'Monitoring is locked' : (isVideoMonitored ? 'Unmonitor' : 'Monitor')}
              style={{ cursor: isLocked ? 'not-allowed' : 'pointer', opacity: isLocked ? 0.5 : 1 }}
            >
              {isVideoMonitored ? (
                <EyeOff24Regular className={styles.monitorIcon} />
              ) : (
                <Eye24Regular className={styles.monitorIcon} />
              )}
            </div>
            {(() => {
              const progress = progressMap?.get(Number(tidalId));
              if (progress && progress.state !== 'completed') {
                return (
                  <DownloadOverlay
                    status={progress.state}
                    progress={progress.progress}
                    error={progress.statusMessage}
                  />
                );
              }
              return null;
            })()}
          </div>
          <div className={styles.cardContent}>
            <div className={styles.cardTitle} title={title}>{title}</div>
            <div className={styles.cardSubtitle} title={subtitle}>{subtitle}</div>
          </div>
        </Card>
      );
    }
    return null;
  };

  const filterTopTracks = useCallback((tracks: TrackListItem[]) => {
    return tracks.filter((track) => {
      const quality = (track.quality || '').toString().toUpperCase();

      if (libraryFilter === 'atmos' && quality !== 'DOLBY_ATMOS') return false;
      if (libraryFilter === 'stereo' && quality === 'DOLBY_ATMOS') return false;

      const isTrackMonitored = Boolean(track.is_monitored ?? track.monitor);
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

      const isLocked = Boolean(track.monitor_locked ?? track.monitor_lock);
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
        icon={viewMode === 'grid' ? <AppsListDetail24Regular /> : <Grid24Regular />}
        onClick={() => setViewMode(prev => prev === 'grid' ? 'carousel' : 'grid')}
        title={viewMode === 'grid' ? "Switch to carousel view" : "Switch to grid view"}
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

  const renderModule = (module: any, index: number) => {
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
            contextArtistName={artistName}
            onDownloadTrack={handleDownloadTrack}
            onToggleMonitor={(track) => {
              toggleMonitor({
                id: track.id,
                type: "track",
                currentStatus: Boolean(track.is_monitored ?? track.monitor),
              });
            }}
            onToggleLock={(track) => {
              toggleLock({
                id: track.id,
                type: "track",
                isLocked: Boolean(track.monitor_locked ?? track.monitor_lock),
                isMonitored: Boolean(track.is_monitored ?? track.monitor),
              });
            }}
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
    const renderer = isArtistModule ? renderArtistCard : renderAlbumCard;
    if (libraryFilter === 'video') return null;

    const rendered = items.map(renderer).filter(Boolean);
    if (rendered.length === 0) return null;

    const isFirst = claimFirstVisible();

    return (
      <div key={`${module.type}-${module.title}`} className={styles.section}>
        <div className={styles.sectionHeader}>
          <Title2>{module.title}</Title2>
          {isFirst && renderMobileFilterView()}
        </div>
        <div className={viewMode === 'grid' ? styles.grid : styles.carousel}>
          {rendered}
        </div>
      </div>
    );
  };

  // Process Page Data - use pageData.rows for modules (from page-db endpoint)
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

    // Sort album-type sections into canonical order
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
    mods.sort((a, b) => {
      const orderA = sectionOrder[a.title?.toLowerCase()] ?? 50;
      const orderB = sectionOrder[b.title?.toLowerCase()] ?? 50;
      return orderA - orderB;
    });

    return mods;
  }, [pageData]);

  if (pageLoading) {
    return (
      <div className={styles.container}>
        <Skeleton animation="wave">
          <div className={styles.header}>
            <div className={styles.headerContent}>
              <SkeletonItem className={styles.artistImage} />
              <div className={styles.artistInfo}>
                <SkeletonItem style={{ height: '32px', width: 'min(280px, 60%)', borderRadius: tokens.borderRadiusMedium }} />
                <SkeletonItem style={{ height: '16px', width: 'min(200px, 40%)', borderRadius: tokens.borderRadiusMedium }} />
                <div className={styles.actions}>
                  <SkeletonItem style={{ height: '32px', width: '100px', borderRadius: tokens.borderRadiusMedium }} />
                  <SkeletonItem style={{ height: '32px', width: '100px', borderRadius: tokens.borderRadiusMedium }} />
                  <SkeletonItem style={{ height: '32px', width: '40px', borderRadius: tokens.borderRadiusMedium }} />
                </div>
              </div>
            </div>
          </div>
        </Skeleton>
        <div className={styles.modules}>
          <Skeleton animation="wave">
            <SkeletonItem style={{ height: '24px', width: '120px', borderRadius: tokens.borderRadiusMedium, marginBottom: tokens.spacingVerticalS }} />
          </Skeleton>
          <CardGridSkeleton cards={6} />
        </div>
      </div>
    );
  }

  if (pageError) {
    return (
      <div className={styles.stateShell}>
        <ErrorState
          title="Failed to load artist"
          error={pageError as Error}
          minHeight="320px"
          actions={<Button onClick={() => window.location.reload()}>Retry</Button>}
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
  const downloadActionDisabled = !hasBeenScanned || isScanBusy;
  const downloadActionTitle = !hasBeenScanned
    ? 'Get metadata first to enable downloads'
    : isScanBusy
      ? 'Wait for scan to finish'
      : 'Download missing releases';
  const scanActionTitle = 'Refresh & Scan';

  const artistActions: OverflowAction[] = [
    { key: 'monitor', label: isMonitored ? 'Unmonitor' : 'Monitor', onClick: toggleMonitoring },
    { key: 'refresh-scan', label: isScanBusy ? 'Scanning...' : 'Refresh & Scan', disabled: isScanBusy, onClick: syncArtist },
    { key: 'curate', label: isCurateBusy ? 'Running...' : 'Curate', disabled: isCurateBusy || isScanBusy || !hasAlbums, onClick: curateArtist },
    { key: 'download-missing', label: 'Download Missing', disabled: downloadActionDisabled, onClick: startDownloads },
  ];

  // Reset mobile filter/view tracking each render so it appears on the first visible section
  mobileFilterViewRendered.current = false;

  return (
    <DynamicBrandProvider keyColor={artistBrandColor}>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            {/* Artist Avatar */}
            <div className={styles.artistImageShell}>
              {artistPictureUrl ? (
                <img src={artistPictureUrl} className={styles.artistImage} alt={artistName} />
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
                  <Info24Regular className={styles.artworkInfoIcon} />
                </div>
              )}
            </div>
            <div className={styles.artistInfo}>
              <Title1 className={styles.artistTitle}>{artistName}</Title1>

              {/* Biography */}
              {artistBio && (
                <ExpandableMetadataBlock
                  content={parseWimpLinks(artistBio, navigate)}
                  attribution={bioAttribution}
                  expanded={bioExpanded}
                  onToggle={() => setBioExpanded(!bioExpanded)}
                />
              )}

              <Overflow minimumVisible={3}>
                <div className={styles.actions}>
                  <OverflowItem id="monitor" priority={4}>
                    <Button
                      appearance={isMonitored ? "subtle" : "primary"}
                      icon={isMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
                      onClick={toggleMonitoring}
                      title={isMonitored ? "Click to stop monitoring" : "Click to enable monitoring"}
                      className={mergeClasses(
                        styles.actionButton,
                        isMonitored ? styles.transparentButton : styles.primaryButton
                      )}
                    >
                      {isMonitored ? "Unmonitor" : "Monitor"}
                    </Button>
                  </OverflowItem>

                  <OverflowItem id="refresh-scan" priority={3}>
                    <Button
                      appearance={!hasBeenScanned ? "primary" : "subtle"}
                      icon={isScanBusy ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                      onClick={syncArtist}
                      disabled={isScanBusy}
                      className={mergeClasses(
                        styles.actionButton,
                        !hasBeenScanned ? styles.primaryButton : styles.transparentButton
                      )}
                      title={isScanBusy ? 'Scanning...' : scanActionTitle}
                    >
                      {isScanBusy ? "Scanning..." : "Refresh & Scan"}
                    </Button>
                  </OverflowItem>

                  <OverflowItem id="curate" priority={2}>
                    <Button
                      appearance={(hasAlbums && !hasMonitoredAlbums) ? "primary" : "subtle"}
                      icon={isCurateBusy ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
                      onClick={curateArtist}
                      disabled={isCurateBusy || isScanBusy || !hasAlbums}
                      className={mergeClasses(
                        styles.actionButton,
                        (hasAlbums && !hasMonitoredAlbums) ? styles.primaryButton : styles.transparentButton
                      )}
                      title={!hasAlbums ? "Refresh & Scan first" : (isScanBusy ? "Wait for scan to finish" : "Curate")}
                    >
                      {isCurateBusy ? "Running..." : "Curate"}
                    </Button>
                  </OverflowItem>

                  <OverflowItem id="download-missing" priority={1}>
                    <Button
                      appearance="subtle"
                      icon={<ArrowDownload24Regular />}
                      onClick={startDownloads}
                      disabled={downloadActionDisabled}
                      title={downloadActionTitle}
                      className={mergeClasses(styles.actionButton, styles.transparentButton)}
                    >
                      Download Missing
                    </Button>
                  </OverflowItem>

                  <ActionOverflowMenu actions={artistActions} />

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

                    <Button
                      appearance="subtle"
                      icon={viewMode === 'grid' ? <AppsListDetail24Regular /> : <Grid24Regular />}
                      onClick={() => setViewMode(prev => prev === 'grid' ? 'carousel' : 'grid')}
                      title={viewMode === 'grid' ? "Switch to carousel view" : "Switch to grid view"}
                      className={mergeClasses(styles.actionButton, styles.transparentButton)}
                    >
                      View
                    </Button>
                  </div>
                </div>
              </Overflow>
            </div>
          </div>
        </div>

        {/* Dynamic Modules */}
        <div className={styles.modules}>
          {modules.map((mod, i) => renderModule(mod, i))}
        </div>

        {modules.length === 0 && !pageLoading && (
          <EmptyState
            title="No content found"
            description={!hasBeenScanned ? "Try getting metadata first." : "This artist does not have any surfaced modules yet."}
            icon={<FolderSync24Regular />}
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
