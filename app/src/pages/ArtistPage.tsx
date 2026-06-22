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
  ArrowSortDownLines24Regular,
  FolderSync24Regular,
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { useArtistPage } from "@/hooks/useArtistPage";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import type { TrackListItem } from "@/types/track-list";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useToast } from "@/hooks/useToast";
import { getAlbumCover, getArtistPicture, getVideoThumbnail } from "@/utils/tidalImages";
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
import { DownloadOverlay } from "@/components/ui/DownloadOverlay";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
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
import { LibraryRowActions } from "@/components/library/LibraryRowActions";
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
    // Tighter on mobile so the name sits closer to the bio.
    gap: tokens.spacingVerticalXS,
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
    ...detailActionGlassButtonStyles,
  },
  // Primary action button (Monitor when not monitored, Scan when not scanned)
  primaryButton: {
    ...detailActionPrimaryButtonStyles,
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
const EXPANDED_TOP_TRACK_COUNT = 50;
const ARTIST_FILTER_STORAGE_PREFIX = "discogenius_artist_filters:";

type ArtistPageFilterPrefs = {
  libraryFilter: 'all' | 'stereo' | 'spatial' | 'video';
  statusFilters: StatusFilters;
};

function artistFilterStorageKey(artistId: string) {
  return `${ARTIST_FILTER_STORAGE_PREFIX}${artistId}`;
}

function readArtistFilterPrefs(artistId: string | undefined): ArtistPageFilterPrefs | null {
  if (!artistId) return null;
  try {
    const raw = localStorage.getItem(artistFilterStorageKey(artistId));
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

  const { data: pageData, isLoading: pageLoading, error: pageError, refetch: refetchPage } = useArtistPage(artistId) as { data: any, isLoading: boolean, error: any, refetch: () => void };

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
  const [statusFilters, setStatusFilters] = useState<StatusFilters>(() => (
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
      localStorage.setItem(artistFilterStorageKey(artistId), JSON.stringify({
        libraryFilter,
        statusFilters,
      }));
    } catch {
      // Filter persistence is a convenience only; ignore storage failures.
    }
  }, [artistId, filterInitialized, libraryFilter, statusFilters]);

  // Unified Artist Info - prefer pageData.artist since that's the canonical DB-backed artist payload
  const artistInfo = pageData?.artist;
  const artistName = artistInfo?.name || pageData?.artistInfo?.name || "Unknown Artist";
  const artistBio = artistInfo?.bio || null;
  const artistLocalFiles = Array.isArray(artistInfo?.files) ? artistInfo.files : [];
  const hasLocalArtistPicture = artistLocalFiles.some((file: any) => file.file_type === "cover");
  const bioAttribution = formatMetadataAttribution(artistInfo?.bio_source, artistInfo?.bio_last_updated);
  const artistPictureUrl = artistInfo
    ? (artistInfo.picture || (pageData?.artistInfo as any)?.picture || (artistInfo as any).cover_image_url || (pageData?.artistInfo as any)?.cover_image_url || null)
    : undefined;
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
          if (item.is_monitored) {
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
      render: (album: any) => {
        const fallbackSrc = getAlbumCover(album.provider_cover_id, 'small');
        const src = album.cover_art_url || getAlbumCover(album.cover_id || album.cover, 'small') || fallbackSrc;
        return src ? (
          <img
            src={src}
            alt={album.title}
            className={dgCell.thumbnailSquare}
            onError={(event) => {
              if (fallbackSrc && event.currentTarget.src !== fallbackSrc) {
                event.currentTarget.src = fallbackSrc;
              }
            }}
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
      render: (album: any) => <>{album.num_tracks ?? album.track_count ?? 0}</>,
    },
    {
      key: "quality",
      header: "Quality",
      width: "120px",
      align: "left",
      render: (album: any) => {
        const hasStereoOffer = Boolean(album.stereo_provider_id);
        const hasSpatialOffer = Boolean(album.spatial_provider_id);
        const hasAnyProviderOffer = hasStereoOffer || hasSpatialOffer;

        if (hasAnyProviderOffer) {
          return (
            <ProviderQualityRow
              size="small"
              offers={[
                ...(hasStereoOffer
                  ? [{
                      slot: "stereo",
                      quality: album.stereo_quality || album.quality,
                      provider: album.stereo_provider || album.selected_provider,
                      matchStatus: album.stereo_match_status,
                      providerAlbumId: album.stereo_provider_id,
                      selectedReleaseMbid: album.stereo_release_mbid || album.selected_release_mbid,
                    }]
                  : []),
                ...(hasSpatialOffer
                  ? [{
                      slot: "spatial",
                      quality: album.spatial_quality || "DOLBY_ATMOS",
                      provider: album.spatial_provider || album.selected_provider,
                      matchStatus: album.spatial_match_status,
                      providerAlbumId: album.spatial_provider_id,
                      selectedReleaseMbid: album.spatial_release_mbid || album.selected_release_mbid,
                    }]
                  : []),
              ] as any}
            />
          );
        }

        return album.quality ? <QualityBadge quality={album.quality} /> : null;
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
                icon: <ArrowDownload24Regular />,
                onClick: (event) => handleDownloadAlbumRow(event, album),
              },
              {
                key: "monitor",
                label: isLocked ? "Monitoring is locked" : (album.is_monitored ? "Unmonitor" : "Monitor"),
                icon: album.is_monitored ? <EyeOff24Regular /> : <Eye24Regular />,
                onClick: (event) => toggleAlbumMonitored(event, String(album.id), !album.is_monitored),
                disabled: isLocked,
              },
              {
                key: "lock",
                label: isLocked ? "Unlock" : "Lock",
                icon: isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />,
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

    const skyHookImageUrl = item.cover_art_url || null;
    const providerImageUrl = getAlbumCover(item.provider_cover_id, "medium");
    const storedImageUrl = getAlbumCover(item.cover || item.cover_id, "medium") || item.cover || item.cover_id || null;

    const imageUrl = skyHookImageUrl || storedImageUrl || providerImageUrl;
    const fallbackImageUrl = imageUrl === providerImageUrl ? null : providerImageUrl;
    const year = item.release_date ? new Date(item.release_date).getFullYear() : '';
    const subtitle = item.source === "musicbrainz"
      ? [year || ""].filter(Boolean).join(' · ')
      : [item.artist_name || artistName, year || ''].filter(Boolean).join(' · ');
    const itemProgress = getProgressByProviderId(String(item.stereo_provider_id || ""))
      || getProgressByProviderId(String(item.spatial_provider_id || ""))
      || getProgressByProviderId(String(providerId));
    const stateBadge = isLocked ? (
      <Badge appearance="filled" color="informative" icon={<LockClosed24Regular />}>
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

    return (
      <MediaCard
        key={providerId}
        to={getAlbumPath(providerId)}
        imageUrl={imageUrl}
        fallbackImageUrl={fallbackImageUrl}
        alt={albumTitle}
        title={albumTitle}
        subtitle={subtitle}
        explicit={item.explicit}
        monitored={isAlbumMonitored}
        onMonitorToggle={isLocked ? undefined : (e) => toggleAlbumMonitored(e, providerId, !isAlbumMonitored)}
        statusBadge={statusBadge}
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
      />
    );
  };

  // Render an artist card (for Similar Artists, Influencers sections)
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
    const imageUrl = getVideoThumbnail(item.cover_id, 'small');
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

    if (libraryFilter === 'video' || libraryFilter === 'all') {
      return (
        <Card
          key={providerId}
          className={cardStyles.card}
          onClick={() => navigate(`/video/${providerId}`)}
        >
          <div className={cardStyles.videoPreview}>
            {imageUrl ? (
              <img src={imageUrl} alt={title} className={cardStyles.cardImage} loading="lazy" />
            ) : (
              <div className={cardStyles.placeholderBg}>
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
            <button
              type="button"
              className={cardStyles.monitorIndicator}
              onClick={(e) => toggleVideoMonitored(e, providerId, !isVideoMonitored)}
              title={isLocked ? 'Monitoring is locked' : (isVideoMonitored ? 'Unmonitor' : 'Monitor')}
              style={{ cursor: isLocked ? 'not-allowed' : 'pointer', opacity: isLocked ? 0.5 : 1 }}
            >
              {isVideoMonitored ? (
                <EyeOff24Regular className={cardStyles.monitorIcon} />
              ) : (
                <Eye24Regular className={cardStyles.monitorIcon} />
              )}
            </button>
            {(() => {
              const progress = getProgressByProviderId(String(providerId));
              if (progress && progress.state !== 'completed') {
                return (
                  <DownloadOverlay
                    status={progress.state || 'queued'}
                    progress={progress.progress}
                    error={progress.statusMessage}
                  />
                );
              }
              return null;
            })()}
          </div>
          <div className={cardStyles.cardContent}>
            <div className={cardStyles.cardTitle} title={title}>{title}</div>
            <div className={cardStyles.cardSubtitle} title={subtitle}>{subtitle}</div>
          </div>
        </Card>
      );
    }
    return null;
  };

  const filterTopTracks = useCallback((tracks: TrackListItem[]) => {
    return tracks.filter((track) => {
      const quality = (track.quality || '').toString().toUpperCase();

      if (libraryFilter === 'spatial' && !isSpatialAudioQuality(quality)) return false;
      if (libraryFilter === 'stereo' && isSpatialAudioQuality(quality)) return false;

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
        icon={viewMode === 'grid' ? <AppsListDetail24Regular /> : viewMode === 'list' ? <Grid24Regular /> : <Grid24Regular />}
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

  if (pageLoading || showIngestSkeleton) {
    return (
      <DetailPageSkeleton
        artShape="circle"
        content="cards"
        cards={6}
        className={styles.container}
        cardsClassName={styles.grid}
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
                <img 
                  src={artistPictureUrl} 
                  className={styles.artistImage} 
                  alt={artistName} 
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    if (!target.dataset.fallbackTried) {
                      target.dataset.fallbackTried = 'true';
                      const fallbackUrl = getArtistPicture((artistInfo as any)?.provider_id || artistId, 'large');
                      if (fallbackUrl && target.src !== fallbackUrl) {
                        target.src = fallbackUrl;
                      }
                    }
                  }}
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
