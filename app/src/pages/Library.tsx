import {
  TabList,
  Tab,
  Button,
  Text,
  makeStyles,
  tokens,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
  MenuItemRadio,
  MenuGroup,
  MenuGroupHeader,
  mergeClasses,
} from "@fluentui/react-components";
import {
  ArrowSync24Regular as ArrowSync24RegularBase,
  Search24Regular as Search24RegularBase,
  ArrowDownload24Regular as ArrowDownload24RegularBase,
  Eye24Regular as Eye24RegularBase,
  EyeOff24Regular as EyeOff24RegularBase,
  ChevronDownRegular as ChevronDownRegularBase,
  Grid24Regular as Grid24RegularBase,
  AppsListDetail24Regular as AppsListDetail24RegularBase,
  Speaker224Regular as Speaker224RegularBase,
  ArrowSortUp24Regular as ArrowSortUp24RegularBase,
  ArrowSortDown24Regular as ArrowSortDown24RegularBase,
  ArrowSortDownLines24Regular as ArrowSortDownLines24RegularBase,
  ArrowImport24Regular as ArrowImport24RegularBase,
  MusicNote224Regular as MusicNote224RegularBase,
  Person24Regular as Person24RegularBase,
  LockClosed24Regular as LockClosed24RegularBase,
  LockOpen24Regular as LockOpen24RegularBase,
  CheckmarkCircle24Filled,
  CheckmarkCircle24Regular as CheckmarkCircle24RegularBase,
  bundleIcon,
  ArrowSync24Filled,
  Search24Filled,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  ChevronDownFilled,
  Grid24Filled,
  AppsListDetail24Filled,
  Speaker224Filled,
  ArrowSortUp24Filled,
  ArrowSortDown24Filled,
  ArrowSortDownLines24Filled,
  ArrowImport24Filled,
  MusicNote224Filled,
  Person24Filled,
  LockClosed24Filled,
  LockOpen24Filled
} from "@fluentui/react-icons";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow } from "@/components/ui/ProviderQualityPill";
import { DownloadedBadge, NotScannedBadge } from "@/components/ui/StatusBadges";
import { useResponsiveTabsStyles } from "@/components/ui/useResponsiveTabsStyles";
import { MediaCard } from "@/components/cards/MediaCard";
import { useCardStyles } from "@/components/cards/cardStyles";
import { LibraryRowActions } from "@/components/library/LibraryRowActions";
import { LibrarySelectionBar } from "@/components/library/LibrarySelectionBar";
import FilterMenu from "@/components/FilterMenu";
import { StatusFilters, defaultStatusFilters } from "@/utils/statusFilters";
import TrackList from "@/components/TrackList";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { navigateToAlbumTrack } from "@/utils/albumNavigation";
import VideoGrid from "@/components/VideoGrid";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { useLibrary } from "@/hooks/useLibrary";
import { ImportArtistsModal } from "@/components/ui/ImportArtistsModal";
import { useTracks } from "@/hooks/useTracks";
import { useVideos } from "@/hooks/useVideos";
import { useQueueDetails } from "@/hooks/useQueueDetails";
import { useToast } from "@/hooks/useToast";
import { useDelayedVisible } from "@/hooks/useDelayedVisible";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";
import { DataGrid, useDataGridCellStyles } from "@/components/DataGrid";
import type { DataGridColumn } from "@/components/DataGrid";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { api, type StreamingProviderStatus } from "@/services/api";
import { renderableArtworkUrl } from "@/utils/artwork";
import {
  dispatchActivityRefresh,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
} from "@/utils/appEvents";
import { formatDurationSeconds } from "@/utils/format";
import { CardGridSkeleton, DataGridSkeleton } from "@/components/ui/LoadingSkeletons";
import { collectionContentInset } from "@/components/ui/sharedLayoutStyles";

const ArrowSync24Regular = bundleIcon(ArrowSync24Filled, ArrowSync24RegularBase);
const Search24Regular = bundleIcon(Search24Filled, Search24RegularBase);
const ArrowDownload24Regular = bundleIcon(ArrowDownload24Filled, ArrowDownload24RegularBase);
const Eye24Regular = bundleIcon(Eye24Filled, Eye24RegularBase);
const EyeOff24Regular = bundleIcon(EyeOff24Filled, EyeOff24RegularBase);
const ChevronDownRegular = bundleIcon(ChevronDownFilled, ChevronDownRegularBase);
const Grid24Regular = bundleIcon(Grid24Filled, Grid24RegularBase);
const AppsListDetail24Regular = bundleIcon(AppsListDetail24Filled, AppsListDetail24RegularBase);
const Speaker224Regular = bundleIcon(Speaker224Filled, Speaker224RegularBase);
const ArrowSortUp24Regular = bundleIcon(ArrowSortUp24Filled, ArrowSortUp24RegularBase);
const ArrowSortDown24Regular = bundleIcon(ArrowSortDown24Filled, ArrowSortDown24RegularBase);
const ArrowSortDownLines24Regular = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24RegularBase);
const ArrowImport24Regular = bundleIcon(ArrowImport24Filled, ArrowImport24RegularBase);
const MusicNote224Regular = bundleIcon(MusicNote224Filled, MusicNote224RegularBase);
const Person24Regular = bundleIcon(Person24Filled, Person24RegularBase);
const LockClosed24Regular = bundleIcon(LockClosed24Filled, LockClosed24RegularBase);
const LockOpen24Regular = bundleIcon(LockOpen24Filled, LockOpen24RegularBase);
const CheckmarkCircle24Regular = bundleIcon(CheckmarkCircle24Filled, CheckmarkCircle24RegularBase);

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    height: "100%",
  },
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    alignItems: "center",
    width: "100%",
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalS,
      justifyContent: "space-between",
    },
    "@media (max-width: 639px)": {
      alignItems: "flex-start",
      rowGap: tokens.spacingVerticalXS,
    },
  },
  desktopControlsRow: {
    display: "none",
    "@media (min-width: 640px)": {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: tokens.spacingHorizontalS,
      minWidth: 0,
      flex: "0 1 auto",
    },
  },
  mobileControlsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flex: "0 0 auto",
    "@media (min-width: 640px)": {
      display: "none",
    },
  },
  controlsRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    minWidth: 0,
    justifyContent: "flex-end",
    "@media (max-width: 639px)": {
      flex: "1 1 auto",
      gap: tokens.spacingHorizontalXS,
      justifyContent: "flex-end",
      alignItems: "flex-start",
    },
  },
  compactActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "nowrap",
    "@media (max-width: 639px)": {
      flex: "0 0 auto",
      marginLeft: "auto",
    },
  },
  virtuosoContainer: {
    flexGrow: 1,
    minHeight: "60vh",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalXS,
    width: "100%",
    boxSizing: "border-box",
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalS,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
  },
  contentPadding: {
    ...collectionContentInset,
  },
  pageBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    height: "100%",
  },
  tabPanel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    gap: tokens.spacingVerticalS,
  },
  tabScroller: {
    flexGrow: 1,
  },
  sentinel: {
    height: "1px",
  },
  fetchMoreRow: {
    display: "flex",
    justifyContent: "center",
    padding: tokens.spacingVerticalM,
  },
  placeholderIcon: {
    fontSize: "48px",
    width: "48px",
    height: "48px",
    color: tokens.colorNeutralForeground4,
  },
  compactIcon: {
    width: "16px",
    height: "16px",
  },
  dimmedIcon: {
    opacity: 0.6,
  },
  menuButtonIconOnly: {
    ...glassButtonStyles,
    minHeight: "36px",
    "@media (max-width: 639px)": {
      minHeight: "40px",
      minWidth: "40px",
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
    },
  },
  mobileHiddenLabel: {
    "@media (max-width: 639px)": {
      display: "none",
    },
  },
});

const LIBRARY_TABS = [
  { key: "artists", label: "Artists" },
  { key: "albums", label: "Albums" },
  { key: "tracks", label: "Tracks" },
  { key: "videos", label: "Videos" },
] as const;

const LIBRARY_SETTINGS_STORAGE_KEY = "discogenius_library_settings";
const LIBRARY_SETTINGS_VERSION = 2;
const SelectItemsIcon = CheckmarkCircle24Regular;

function loadPersistedLibrarySettings() {
  try {
    const saved = localStorage.getItem(LIBRARY_SETTINGS_STORAGE_KEY);
    if (!saved) {
      return null;
    }

    const parsed = JSON.parse(saved);
    return parsed?.settingsVersion === LIBRARY_SETTINGS_VERSION ? parsed : null;
  } catch (e) {
    console.warn('Failed to load library settings from localStorage:', e);
    return null;
  }
}

const Library = () => {
  const styles = useStyles();
  const responsiveTabsStyles = useResponsiveTabsStyles();
  const cardStyles = useCardStyles();
  const dgCell = useDataGridCellStyles();
  const navigate = useNavigate();
  const { toast } = useToast();

  const persistedSettings = loadPersistedLibrarySettings();
  const [selectedTab, setSelectedTab] = useState<string>(
    persistedSettings?.selectedTab ?? "artists"
  );

  const {
    artists,
    albums,
    loading,
    toggleArtistMonitored,
    fetchLibrary,
    stats,
    hasMoreArtists,
    hasMoreAlbums,
    artistsFetchingMore,
    albumsFetchingMore,
    loadMoreArtists,
    loadMoreAlbums,
    refetchArtists,
    refetchAlbums,
    setArtistFilter,
    setAlbumFilter,
    setAlbumDownloadFilter,
    setAlbumLockFilter,
    setAlbumQualityFilter,
    setSortOptions,
    artistsIsPopulated,
    albumsIsPopulated,
    artistsHasRefreshError,
    artistsRefreshErrorMessage,
    albumsHasRefreshError,
    albumsRefreshErrorMessage,
  } = useLibrary({ activeTab: selectedTab as 'artists' | 'albums' | 'tracks' | 'videos' });
  const { data: streamingProviders } = useQuery({
    queryKey: ["streamingProviders"],
    queryFn: () => api.getStreamingProviders(),
    staleTime: 60_000,
  });
  const { addToQueue, getProgressByProviderId } = useQueueStatus();
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { setArtwork } = useUltraBlurContext();
  const activeSentinelRef = useRef<HTMLDivElement | null>(null);

  // Filters - load from persisted settings
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'stereo' | 'spatial' | 'video'>(
    persistedSettings?.libraryFilter ?? 'all'
  );
  const [statusFilters, setStatusFilters] = useState<StatusFilters>(
    persistedSettings?.statusFilters ?? defaultStatusFilters
  );
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const activeMonitoredCount = stats?.[selectedTab as "artists" | "albums" | "tracks" | "videos"]?.monitored;
  const effectiveStatusFilters = useMemo<StatusFilters>(() => (
    activeMonitoredCount === 0 && statusFilters.onlyMonitored && !statusFilters.onlyUnmonitored
      ? { ...statusFilters, onlyMonitored: false }
      : statusFilters
  ), [activeMonitoredCount, statusFilters]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(
    persistedSettings?.viewMode ?? 'grid'
  );

  // Sorting - load from persisted settings
  const [sortBy, setSortBy] = useState<'name' | 'releaseDate' | 'popularity' | 'scannedAt'>(
    persistedSettings?.sortBy ?? 'popularity'
  );
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(
    persistedSettings?.sortDirection ?? 'desc'
  );

  // Persist settings to localStorage whenever they change
  useEffect(() => {
    const settings = {
      settingsVersion: LIBRARY_SETTINGS_VERSION,
      selectedTab,
      libraryFilter,
      statusFilters,
      viewMode,
      sortBy,
      sortDirection,
    };
    try {
      localStorage.setItem(LIBRARY_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save library settings to localStorage:', e);
    }
  }, [selectedTab, libraryFilter, statusFilters, viewMode, sortBy, sortDirection]);

  const sortDirectionOptions: Array<'asc' | 'desc'> = sortBy === 'name' ? ['asc', 'desc'] : ['desc', 'asc'];
  const getSortDirectionLabel = (dir: 'asc' | 'desc') => {
    if (sortBy === 'name') return dir === 'asc' ? 'A → Z' : 'Z → A';
    if (sortBy === 'popularity') return dir === 'asc' ? 'Low → High' : 'High → Low';
    return dir === 'asc' ? 'Oldest → Newest' : 'Newest → Oldest';
  };

  const monitoredFilter = useMemo(() => {
    if (effectiveStatusFilters.onlyMonitored && !effectiveStatusFilters.onlyUnmonitored) return true;
    if (!effectiveStatusFilters.onlyMonitored && effectiveStatusFilters.onlyUnmonitored) return false;
    return undefined;
  }, [effectiveStatusFilters]);

  const downloadedFilter = useMemo(() => {
    if (statusFilters.onlyDownloaded && !statusFilters.onlyNotDownloaded) return true;
    if (!statusFilters.onlyDownloaded && statusFilters.onlyNotDownloaded) return false;
    return undefined;
  }, [statusFilters]);

  const lockedFilter = useMemo(() => {
    if (statusFilters.onlyLocked && !statusFilters.onlyUnlocked) return true;
    if (!statusFilters.onlyLocked && statusFilters.onlyUnlocked) return false;
    return undefined;
  }, [statusFilters]);

  const {
    tracks,
    loading: tracksLoading,
    isPopulated: tracksIsPopulated,
    hasMore: hasMoreTracks,
    isFetchingMore: tracksFetchingMore,
    loadMore: loadMoreTracks,
    refetch: refetchTracks,
    hasRefreshError: tracksHasRefreshError,
    refreshErrorMessage: tracksRefreshErrorMessage,
  } = useTracks({
    monitored: monitoredFilter,
    downloaded: downloadedFilter,
    locked: lockedFilter,
    libraryFilter,
    sort: sortBy,
    dir: sortDirection,
    enabled: selectedTab === 'tracks',
  });
  const {
    videos,
    loading: videosLoading,
    isPopulated: videosIsPopulated,
    hasMore: hasMoreVideos,
    isFetchingMore: videosFetchingMore,
    loadMore: loadMoreVideos,
    refetch: refetchVideos,
    toggleMonitor: toggleVideoMonitor,
    toggleLock: toggleVideoLock,
    hasRefreshError: videosHasRefreshError,
    refreshErrorMessage: videosRefreshErrorMessage,
  } = useVideos({
    monitored: monitoredFilter,
    downloaded: downloadedFilter,
    locked: lockedFilter,
    sort: sortBy,
    dir: sortDirection,
    enabled: selectedTab === 'videos',
  });
  const visibleAlbumIds = useMemo(
    () => selectedTab === "albums"
      ? albums.map((album: any) => String(album.id))
      : [],
    [albums, selectedTab],
  );
  useQueueDetails({
    albumIds: visibleAlbumIds,
    enabled: selectedTab === "albums" && visibleAlbumIds.length > 0,
  });

  // Keep server-side filters/sort in sync (prevents client-side resorting during pagination)
  useEffect(() => {
    setArtistFilter(monitoredFilter);
    setAlbumFilter(monitoredFilter);
    setAlbumDownloadFilter(downloadedFilter);
    setAlbumLockFilter(lockedFilter);
  }, [monitoredFilter, downloadedFilter, lockedFilter, setArtistFilter, setAlbumFilter, setAlbumDownloadFilter, setAlbumLockFilter]);

  useEffect(() => {
    setAlbumQualityFilter(libraryFilter);
  }, [libraryFilter, setAlbumQualityFilter]);

  useEffect(() => {
    setSortOptions(sortBy, sortDirection);
  }, [sortBy, sortDirection, setSortOptions]);

    const artistSelection = useSelectableCollection({
    items: artists,
    getItemId: (artist: any) => artist.id,
  });
  const clearArtistSelection = artistSelection.clearSelection;
  const albumSelection = useSelectableCollection({
    items: albums,
    getItemId: (album: any) => album.id,
  });
  const clearAlbumSelection = albumSelection.clearSelection;
  const trackSelection = useSelectableCollection({
    items: tracks,
    getItemId: (track: any) => track.id,
  });
  const clearTrackSelection = trackSelection.clearSelection;
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();
  const videoSelection = useSelectableCollection({
    items: videos,
    getItemId: (video: any) => video.id,
  });
  const clearVideoSelection = videoSelection.clearSelection;

  useEffect(() => {
    if (!isSelectionMode) {
      clearArtistSelection();
      clearAlbumSelection();
      clearTrackSelection();
      clearVideoSelection();
    }
  }, [
    isSelectionMode,
    clearArtistSelection,
    clearAlbumSelection,
    clearTrackSelection,
    clearVideoSelection,
  ]);

  async function runSelectionActionWithConcurrency<T>(
    items: T[],
    action: (item: T) => Promise<void>,
    concurrency: number = 4,
  ) {
    let succeeded = 0;
    let failed = 0;
    let nextIndex = 0;

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;

        try {
          await action(item);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          console.error("Bulk action failed:", error);
        }
      }
    });

    await Promise.all(workers);

    return { succeeded, failed };
  }

  const showBulkResult = useCallback((title: string, succeeded: number, failed: number) => {
    if (succeeded > 0) {
      toast({
        title,
        description: `${succeeded} item${succeeded === 1 ? "" : "s"} processed${failed > 0 ? `, ${failed} failed` : ""}.`,
      });
    }

    if (failed > 0) {
      toast({
        title: "Some items failed",
        description: `${failed} item${failed === 1 ? "" : "s"} could not be processed.`,
        variant: "destructive",
      });
    }
  }, [toast]);

  const queueSelectedArtistScan = async () => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(artistSelection.selectedItems, async (artist: any) => {
      await api.scanArtist(artist.id, { forceUpdate: false });
    });

    if (succeeded > 0) {
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    }

    showBulkResult("Refresh & scan queued", succeeded, failed);
    artistSelection.clearSelection();
  };

  const queueSelectedArtistCurate = async () => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(artistSelection.selectedItems, async (artist: any) => {
      await api.curateArtist(artist.id);
    });

    if (succeeded > 0) {
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    }

    showBulkResult("Curation queued", succeeded, failed);
    artistSelection.clearSelection();
  };

  const queueSelectedArtistDownload = async () => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(artistSelection.selectedItems, async (artist: any) => {
      await api.processMonitoredItems(artist.id);
    });

    if (succeeded > 0) {
      dispatchActivityRefresh();
    }

    showBulkResult("Download queued", succeeded, failed);
    artistSelection.clearSelection();
  };

  const setSelectedArtistMonitoring = async (monitored: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(artistSelection.selectedItems, async (artist: any) => {
      await api.toggleArtistMonitored(artist.id, monitored);
      dispatchMonitorStateChanged({ type: "artist", providerId: artist.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    artistSelection.clearSelection();
  };

  const queueSelectedAlbumDownload = async () => {
    const queueableAlbums = albumSelection.selectedItems.filter((album: any) => {
      const isDownloaded = album.is_downloaded ?? album.downloaded;
      return !isDownloaded;
    });

    if (queueableAlbums.length === 0) {
      toast({
        title: "No downloadable albums selected",
        description: "All selected albums are already downloaded.",
      });
      albumSelection.clearSelection();
      return;
    }

    const { succeeded, failed } = await runSelectionActionWithConcurrency(queueableAlbums, async (album: any) => {
      await api.addAlbum(String(album.id));
    });

    if (succeeded > 0) {
      dispatchActivityRefresh();
    }

    showBulkResult("Album download queued", succeeded, failed);
    albumSelection.clearSelection();
  };

  const setSelectedAlbumMonitoring = async (monitored: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(albumSelection.selectedItems, async (album: any) => {
      await api.updateAlbum(album.id, { monitored });
      dispatchMonitorStateChanged({ type: "album", providerId: album.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    albumSelection.clearSelection();
  };

  const setSelectedAlbumLockState = async (locked: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(albumSelection.selectedItems, async (album: any) => {
      await api.updateAlbum(album.id, { monitored_lock: locked });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(locked ? "Albums locked" : "Albums unlocked", succeeded, failed);
    albumSelection.clearSelection();
  };

  const queueSelectedTrackDownload = async () => {
    const queueableTracks = trackSelection.selectedItems.filter((track: any) => {
      const isDownloaded = track.is_downloaded ?? track.downloaded;
      const providerTrackId = String(track.preview_provider_track_id ?? "").trim();
      return !isDownloaded && providerTrackId.length > 0;
    });

    if (queueableTracks.length === 0) {
      toast({
        title: "No downloadable tracks selected",
        description: "Selected tracks are already downloaded or are not matched to a provider track yet.",
      });
      trackSelection.clearSelection();
      return;
    }

    const { succeeded, failed } = await runSelectionActionWithConcurrency(queueableTracks, async (track: any) => {
      const providerTrackId = String(track.preview_provider_track_id ?? "").trim();
      await addToQueue(null, "track", providerTrackId, {
        payload: {
          provider: track.preview_provider ?? track.provider ?? "tidal",
          providerId: providerTrackId,
          title: track.title,
          artist: track.artist_name,
          albumId: track.album_id,
          albumTitle: track.album_title,
          artistId: track.artist_id,
          cover: track.album_cover ?? track.cover_url ?? null,
          quality: track.quality ?? null,
        },
      });
    });

    if (succeeded > 0) {
      dispatchActivityRefresh();
    }

    showBulkResult("Track download queued", succeeded, failed);
    trackSelection.clearSelection();
  };

  const setSelectedTrackMonitoring = async (monitored: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(trackSelection.selectedItems, async (track: any) => {
      await api.updateTrack(track.id, { monitored });
      dispatchMonitorStateChanged({ type: "track", providerId: track.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    trackSelection.clearSelection();
  };

  const setSelectedTrackLockState = async (locked: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(trackSelection.selectedItems, async (track: any) => {
      await api.updateTrack(track.id, { monitored_lock: locked });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(locked ? "Tracks locked" : "Tracks unlocked", succeeded, failed);
    trackSelection.clearSelection();
  };

  const queueSelectedVideoDownload = async () => {
    const queueableVideos = videoSelection.selectedItems.filter((video: any) => {
      const isDownloaded = video.is_downloaded ?? video.downloaded;
      return !isDownloaded;
    });

    if (queueableVideos.length === 0) {
      toast({
        title: "No downloadable videos selected",
        description: "All selected videos are already downloaded.",
      });
      videoSelection.clearSelection();
      return;
    }

    const { succeeded, failed } = await runSelectionActionWithConcurrency(queueableVideos, async (video: any) => {
      const providerVideoId = String(video.provider_id ?? video.providerId ?? video.id ?? "").trim();
      await addToQueue(null, "video", providerVideoId, {
        payload: {
          provider: video.provider ?? "tidal",
          providerId: providerVideoId,
          title: video.title,
          artist: video.artist_name,
          albumId: video.album_id,
          artistId: video.artist_id,
          cover: video.cover ?? video.cover_id ?? null,
          quality: video.quality ?? null,
        },
      });
    });

    if (succeeded > 0) {
      dispatchActivityRefresh();
    }

    showBulkResult("Video download queued", succeeded, failed);
    videoSelection.clearSelection();
  };

  const setSelectedVideoMonitoring = async (monitored: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(videoSelection.selectedItems, async (video: any) => {
      await api.updateVideo(video.id, { monitored });
      dispatchMonitorStateChanged({ type: "video", providerId: video.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    videoSelection.clearSelection();
  };

  const setSelectedVideoLockState = async (locked: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(videoSelection.selectedItems, async (video: any) => {
      await api.updateVideo(video.id, { monitored_lock: locked });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(locked ? "Videos locked" : "Videos unlocked", succeeded, failed);
    videoSelection.clearSelection();
  };


  const { setBrandKeyColor } = useTheme();

  // Clear artwork and brand color when on library view (use logo colors)
  useEffect(() => {
    setArtwork(undefined);
    setBrandKeyColor(null);
  }, [setArtwork, setBrandKeyColor]);

  const activeInfiniteScroll = useMemo(() => {
    if (selectedTab === "albums") {
      return {
        hasMore: hasMoreAlbums,
        isLoading: albumsFetchingMore,
        itemCount: albums.length,
        initialLoading: loading,
        loadMore: loadMoreAlbums,
      };
    }
    if (selectedTab === "tracks") {
      return {
        hasMore: hasMoreTracks,
        isLoading: tracksFetchingMore,
        itemCount: tracks.length,
        initialLoading: tracksLoading,
        loadMore: loadMoreTracks,
      };
    }
    if (selectedTab === "videos") {
      return {
        hasMore: hasMoreVideos,
        isLoading: videosFetchingMore,
        itemCount: videos.length,
        initialLoading: videosLoading,
        loadMore: loadMoreVideos,
      };
    }
    return {
      hasMore: hasMoreArtists,
      isLoading: artistsFetchingMore,
      itemCount: artists.length,
      initialLoading: loading,
      loadMore: loadMoreArtists,
    };
  }, [
    albums.length,
    albumsFetchingMore,
    artists.length,
    artistsFetchingMore,
    hasMoreAlbums,
    hasMoreArtists,
    hasMoreTracks,
    hasMoreVideos,
    loadMoreAlbums,
    loadMoreArtists,
    loadMoreTracks,
    loadMoreVideos,
    loading,
    selectedTab,
    tracks.length,
    tracksFetchingMore,
    tracksLoading,
    videos.length,
    videosFetchingMore,
    videosLoading,
  ]);

  useInfiniteScroll({
    sentinelRef: activeSentinelRef,
    hasMore: activeInfiniteScroll.hasMore,
    isLoading: activeInfiniteScroll.isLoading,
    onLoadMore: activeInfiniteScroll.loadMore,
    enabled: activeInfiniteScroll.itemCount > 0 && !activeInfiniteScroll.initialLoading,
  });

  // Shared delayed-loading policy: skeletons only after the active tab's
  // initial load persists past the grace window, never for sub-second
  // cached responses.
  const showLoadingSkeleton = useDelayedVisible(activeInfiniteScroll.initialLoading);

  const importableFollowedProviders = useMemo(
    () => (streamingProviders?.providers ?? []).filter((provider: StreamingProviderStatus) => (
      provider.authenticated && (provider.management?.canImportArtists || provider.capabilities.followedArtists)
    )),
    [streamingProviders],
  );

  const importProvider = importableFollowedProviders[0];

  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((current) => !current);
  }, []);

  // Right-click / long-press on a card enters selection mode with that card
  // selected, skipping the toolbar Select button.
  const beginSelectionWith = useCallback((collection: { toggleItem: (id: string, selected: boolean, opts?: { range?: boolean }) => void }, id: string) => {
    setIsSelectionMode(true);
    collection.toggleItem(id, true);
  }, []);

  const renderEmptyLibraryAction = () => (
    <Button
      appearance="secondary"
      icon={importProvider ? <ArrowImport24Regular /> : undefined}
      onClick={() => (importProvider ? setImportModalOpen(true) : navigate("/settings"))}
      title={importProvider ? "Import artists from a connected service" : "Connect a provider to import artists"}
    >
      {importProvider ? "Import artists" : "Connect Provider"}
    </Button>
  );

  // Render a single artist card
  const renderArtistCard = (artist: any) => {
    const albumCount = artist.album_count;
    const imageUrl = artist.picture || artist.cover_image_url || null;
    const itemProgress = getProgressByProviderId(String(artist.id));
    return (
      <MediaCard
        key={artist.id}
        to={`/artist/${artist.id}`}
        imageUrl={imageUrl}
        alt={artist.name}
        title={artist.name}
        subtitle={typeof albumCount === "number" ? `${albumCount} ${albumCount === 1 ? "release" : "releases"}` : "Artist"}
        monitored={artist.is_monitored}
        onMonitorToggle={() => toggleArtistMonitored(artist.id, !artist.is_monitored)}
        placeholder={
          <div className={cardStyles.placeholderBg}>
            <Person24Regular className={styles.placeholderIcon} />
          </div>
        }
        statusBadge={
          !artist.last_scanned ? renderNotScannedBadge() : undefined
        }
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
        selection={isSelectionMode ? {
          selected: artistSelection.selectedRowIds.includes(artist.id),
          label: `Select ${artist.name}`,
          onChange: (selected, shiftKey) => artistSelection.toggleItem(artist.id, selected, { range: shiftKey }),
        } : undefined}
        onSelectionIntent={() => beginSelectionWith(artistSelection, artist.id)}
      />
    );
  };

  const renderNotScannedBadge = useCallback(() => <NotScannedBadge />, []);

  // Render artist as datagrid row
  const formatLastScanned = useCallback((date: string | null) => {
    if (!date) return null;
    const d = new Date(date);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  }, []);

  const handleArtistScan = useCallback(async (e: React.MouseEvent, artist: any) => {
    e.stopPropagation();
    try {
      const result: any = await api.scanArtist(artist.id, { forceUpdate: false });
      toast({
        title: "Refresh & scan queued",
        description: result?.message || artist.name,
      });
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error: any) {
      toast({ title: "Failed to queue refresh & scan", description: error.message || "Please try again", variant: "destructive" });
    }
  }, [toast]);

  const handleArtistCurate = useCallback(async (e: React.MouseEvent, artist: any) => {
    e.stopPropagation();
    try {
      const result: any = await api.curateArtist(artist.id);
      toast({ title: "Curation queued", description: result?.message || `Queued curation for ${artist.name}` });
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error: any) {
      toast({ title: "Failed to queue curation", description: error.message || "Please try again", variant: "destructive" });
    }
  }, [toast]);

  const handleArtistDownload = useCallback(async (e: React.MouseEvent, artist: any) => {
    e.stopPropagation();
    try {
      const result: any = await api.processMonitoredItems(artist.id);
      toast({ title: "Download queued", description: result?.message || `Queued monitored items for ${artist.name}` });
      dispatchActivityRefresh();
    } catch (error: any) {
      toast({ title: "Failed to queue downloads", description: error.message || "Please try again", variant: "destructive" });
    }
  }, [toast]);

  /** Column definitions for artist datagrid */
  const artistColumns = useMemo<DataGridColumn[]>(() => [
    {
      key: "thumb",
      header: "",
      width: "40px",
      render: (artist: any) => {
        const src = artist.picture || artist.cover_image_url;
        return src ? (
          <img src={src} alt={artist.name} className={dgCell.thumbnailCircle} />
        ) : (
          <div className={mergeClasses(dgCell.thumbnailCircle, dgCell.thumbnailPlaceholder)}>
            {artist.name?.charAt(0)?.toUpperCase() || '?'}
          </div>
        );
      },
    },
    {
      key: "name",
      header: "Name",
      width: "1fr",
      render: (artist: any) => <span className={dgCell.nameCell} title={artist.name}>{artist.name}</span>,
    },
    {
      key: "albums",
      header: "Albums",
      width: "70px",
      align: "center",
      render: (artist: any) => (
        <>
          <span className={dgCell.statPrimary}>{artist.monitored_album_count ?? "--"}</span>
          <span className={dgCell.statSecondary}> / {artist.album_count ?? "--"}</span>
        </>
      ),
    },
    {
      key: "tracks",
      header: "Tracks",
      width: "70px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (artist: any) => (
        <>
          <span className={dgCell.statPrimary}>{artist.monitored_track_count ?? "--"}</span>
          <span className={dgCell.statSecondary}> / {artist.track_count ?? "--"}</span>
        </>
      ),
    },
    {
      key: "scanned",
      header: "Scanned",
      width: "132px",
      align: "center",
      render: (artist: any) => artist.last_scanned
        ? <Text size={200}>{formatLastScanned(artist.last_scanned)}</Text>
        : renderNotScannedBadge(),
    },
    {
      key: "actions",
      header: "",
      width: "140px",
      align: "right",
      render: (artist: any) => (
        <LibraryRowActions
          actions={[
            {
              key: "scan",
              label: "Refresh & scan",
              icon: <ArrowSync24Regular />,
              onClick: (event) => handleArtistScan(event, artist),
            },
            {
              key: "curate",
              label: "Curate artist",
              icon: <ArrowSortDownLines24Regular />,
              onClick: (event) => handleArtistCurate(event, artist),
            },
            {
              key: "download",
              label: "Download missing",
              icon: <ArrowDownload24Regular />,
              onClick: (event) => handleArtistDownload(event, artist),
            },
            {
              key: "monitor",
              label: artist.is_monitored ? "Unmonitor" : "Monitor",
              icon: artist.is_monitored ? <EyeOff24Regular /> : <Eye24Regular />,
              onClick: (event) => {
                event.stopPropagation();
                toggleArtistMonitored(artist.id, !artist.is_monitored);
              },
            },
          ]}
        />
      ),
    },
  ], [dgCell, formatLastScanned, handleArtistScan, handleArtistCurate, handleArtistDownload, renderNotScannedBadge, toggleArtistMonitored]);

  const handleToggleAlbumMonitored = useCallback(async (e: React.MouseEvent, album: any) => {
    e.stopPropagation();
    const nextMonitored = !album.is_monitored;
    try {
      await api.updateAlbum(album.id, { monitored: nextMonitored });
      dispatchMonitorStateChanged({
        type: 'album',
        providerId: album.id,
        monitored: nextMonitored,
      });
      dispatchLibraryUpdated();
    } catch (error) {
      console.error('Failed to toggle album monitoring:', error);
    }
  }, []);

  const handleToggleAlbumLock = useCallback(async (e: React.MouseEvent, album: any) => {
    e.stopPropagation();
    const nextLocked = !album.monitored_lock;
    try {
      await api.updateAlbum(album.id, { monitored_lock: nextLocked });
      dispatchLibraryUpdated();
    } catch (error) {
      console.error('Failed to toggle album lock:', error);
    }
  }, []);

  // Render a single album card
  const renderAlbumCard = (album: any) => {
    const year = album.release_date ? album.release_date.split('-')[0] : '';
    const subtitle = [album.artist_name, year].filter(Boolean).join(' · ');
    const isLocked = Boolean(album.monitored_lock);
    const imageUrl = renderableArtworkUrl(album.cover_art_url || album.cover || album.cover_id);
    const itemProgress = getProgressByProviderId(String(album.id));
    return (
      <MediaCard
        key={album.id}
        to={`/album/${album.id}`}
        imageUrl={imageUrl}
        alt={album.title}
        title={album.title}
        subtitle={subtitle}
        explicit={album.explicit}
        quality={album.quality}
        monitored={album.is_monitored}
        onMonitorToggle={isLocked ? undefined : (e) => handleToggleAlbumMonitored(e, album)}
        placeholder={
          <div className={cardStyles.placeholderBg}>
            <MusicNote224Regular className={styles.placeholderIcon} />
          </div>
        }
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
        selection={isSelectionMode ? {
          selected: albumSelection.selectedRowIds.includes(album.id),
          label: `Select ${album.title}`,
          onChange: (selected, shiftKey) => albumSelection.toggleItem(album.id, selected, { range: shiftKey }),
        } : undefined}
        onSelectionIntent={() => beginSelectionWith(albumSelection, album.id)}
      />
    );
  };

  // Render album as datagrid columns
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
        const src = renderableArtworkUrl(album.cover_art_url || album.cover || album.cover_id);
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
          <Text size={200} className={dgCell.subtitleText} truncate>{album.artist_name}</Text>
        </div>
      ),
    },
    {
      key: "year",
      header: "Year",
      width: "65px",
      align: "center",
      minWidth: 768,
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
      width: "max-content",
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
                onClick: (event) => handleToggleAlbumMonitored(event, album),
                disabled: isLocked,
              },
              {
                key: "lock",
                label: isLocked ? "Unlock" : "Lock",
                icon: isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />,
                onClick: (event) => handleToggleAlbumLock(event, album),
              },
            ]}
          />
        );
      },
    },
  ], [dgCell, handleDownloadAlbumRow, handleToggleAlbumLock, handleToggleAlbumMonitored]);

  /** Column definitions for video datagrid — used in library Videos tab */
  const videoColumns = useMemo<DataGridColumn[]>(() => [
    {
      key: "thumb",
      header: "",
      width: "64px",
      render: (video: any) => {
        const src = renderableArtworkUrl(video.cover_art_url || video.cover || video.cover_id);
        return src ? (
          <img src={src} alt={video.title} className={dgCell.thumbnailWide} />
        ) : (
          <div className={mergeClasses(dgCell.thumbnailWide, dgCell.thumbnailPlaceholder)}>
            <Speaker224Regular className={styles.compactIcon} />
          </div>
        );
      },
    },
    {
      key: "title",
      header: "Title",
      width: "1fr",
      render: (video: any) => (
        <div className={dgCell.nameStack}>
          <span className={dgCell.nameCell} title={video.title}>{video.title}</span>
          <Text size={200} className={dgCell.subtitleText} truncate>{video.artist_name || 'Unknown'}</Text>
        </div>
      ),
    },
    {
      key: "duration",
      header: "Duration",
      width: "70px",
      align: "center",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (video: any) => <Text size={200}>{formatDurationSeconds(video.duration)}</Text>,
    },
    {
      key: "status",
      header: "Status",
      width: "90px",
      align: "center",
      render: (video: any) => video.is_downloaded ? <DownloadedBadge /> : null,
    },
    {
      key: "actions",
      header: "",
      width: "120px",
      align: "right",
      render: (video: any) => {
        const isLocked = Boolean(video.monitored_lock);
        return (
          <LibraryRowActions
            actions={[
              {
                key: "download",
                label: "Download video",
                icon: <ArrowDownload24Regular />,
                onClick: (event) => {
                  event.stopPropagation();
                  const providerVideoId = String(video.provider_id ?? video.providerId ?? video.id ?? "").trim();
                  void addToQueue(null, "video", providerVideoId, {
                    payload: {
                      provider: video.provider ?? "tidal",
                      providerId: providerVideoId,
                      title: video.title,
                      artist: video.artist_name,
                      cover: video.cover ?? video.cover_id ?? null,
                      quality: video.quality ?? null,
                    },
                  });
                },
                hidden: (video.is_downloaded ?? video.downloaded) ? true : false,
              },
              {
                key: "monitor",
                label: isLocked ? "Monitoring is locked" : (video.is_monitored ? "Unmonitor" : "Monitor"),
                icon: video.is_monitored ? <EyeOff24Regular /> : <Eye24Regular />,
                onClick: (event) => {
                  event.stopPropagation();
                  toggleVideoMonitor(video.id, !video.is_monitored);
                },
                disabled: isLocked,
              },
              {
                key: "lock",
                label: isLocked ? "Unlock" : "Lock",
                icon: isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />,
                onClick: (event) => {
                  event.stopPropagation();
                  toggleVideoLock(video.id, !isLocked);
                },
              },
            ]}
          />
        );
      },
    },
  ], [addToQueue, dgCell, styles.compactIcon, toggleVideoLock, toggleVideoMonitor]);

  const isLibraryEmpty = Boolean(
    stats
    && stats.artists.total === 0
    && stats.albums.total === 0
    && stats.tracks.total === 0
    && stats.videos.total === 0,
  );

  // Empty state - only show when not loading and the overall library is truly empty.
  if (
    isLibraryEmpty
    && !loading
    && !tracksLoading
    && !videosLoading
    && !artistsHasRefreshError
    && !albumsHasRefreshError
    && !tracksHasRefreshError
    && !videosHasRefreshError
  ) {
    return (
      <>
        <EmptyState
          title="Your library is empty"
          description="Add an artist from MusicBrainz, or import followed artists from a connected provider."
          icon={<MusicNote224Regular />}
          minHeight="320px"
          actions={renderEmptyLibraryAction()}
        />
        <ImportArtistsModal
          open={importModalOpen}
          onClose={() => setImportModalOpen(false)}
          onImported={() => fetchLibrary(undefined, { refreshStats: true })}
        />
      </>
    );
  }

  // Helper to render loading state in content area. Gated by the shared
  // delayed-loading policy so sub-second cached loads render a blank pane
  // instead of flashing skeleton rows.
  const renderLoadingContent = () => {
    if (!showLoadingSkeleton) return null;
    switch (selectedTab) {
      case "tracks":
        return (
          <DataGridSkeleton
            rows={10}
            columns={8}
            columnTemplate="52px minmax(180px, 1.25fr) minmax(120px, 1fr) minmax(150px, 1.35fr) 146px 64px 88px 44px"
            compact
            thumbnailColumns={[0]}
            actionColumns={[7]}
          />
        );
      case "videos":
        if (viewMode === "list") {
          return (
            <DataGridSkeleton
              rows={10}
              columns={5}
              columnTemplate="64px minmax(220px, 1fr) 80px 100px 120px"
              compact
              thumbnailColumns={[0]}
              actionColumns={[4]}
            />
          );
        }
        return <VideoGrid videos={[]} loading />;
      case "albums":
        if (viewMode === "list") {
          return (
            <DataGridSkeleton
              rows={10}
              columns={6}
              columnTemplate="40px minmax(220px, 1fr) 72px 64px 96px 120px"
              compact
              thumbnailColumns={[0]}
              actionColumns={[5]}
            />
          );
        }
        return <CardGridSkeleton cards={12} className={styles.grid} />;
      case "artists":
      default:
        if (viewMode === "list") {
          return (
            <DataGridSkeleton
              rows={10}
              columns={6}
              columnTemplate="40px minmax(220px, 1fr) 72px 72px 132px 140px"
              compact
              thumbnailColumns={[0]}
              circularThumbnailColumns={[0]}
              actionColumns={[5]}
            />
          );
        }
        return <CardGridSkeleton cards={12} className={styles.grid} />;
    }
  };

  const renderNoResultsContent = (mediaLabel: "artists" | "albums" | "tracks" | "videos") => (
    <EmptyState
      title={`No ${mediaLabel} found`}
      description={`No ${mediaLabel} match your current filters.`}
      icon={<Search24Regular />}
      minHeight="220px"
    />
  );

  const renderErrorContent = (
    title: string,
    message: string | null,
    onRetry: () => void,
  ) => (
    <ErrorState
      title={title}
      description={message ?? "Could not refresh this view."}
      minHeight="220px"
      actions={<Button onClick={onRetry}>Retry</Button>}
    />
  );

  const renderSortMenu = () => (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          icon={sortDirection === 'asc' ? <ArrowSortUp24Regular /> : <ArrowSortDown24Regular />}
          className={styles.menuButtonIconOnly}
          aria-label="Sort library"
          title="Sort library"
        >
          <span className={styles.mobileHiddenLabel}>Sort</span>
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList
          checkedValues={{
            sortBy: [sortBy],
            sortDirection: [sortDirection],
          }}
          onCheckedValueChange={(_, data) => {
            if (data.name === 'sortBy') {
              const nextSort = data.checkedItems[0] as typeof sortBy;
              setSortBy(nextSort);
              setSortDirection(nextSort === 'name' ? 'asc' : 'desc');
            } else if (data.name === 'sortDirection') {
              setSortDirection(data.checkedItems[0] as typeof sortDirection);
            }
          }}
        >
          <MenuGroup>
            <MenuGroupHeader>Sort By</MenuGroupHeader>
            <MenuItemRadio name="sortBy" value="name">
              Alphabetical
            </MenuItemRadio>
            <MenuItemRadio name="sortBy" value="releaseDate">
              {selectedTab === 'artists' ? 'Date Added' : 'Release Date'}
            </MenuItemRadio>
            <MenuItemRadio name="sortBy" value="popularity">
              Popularity
            </MenuItemRadio>
            <MenuItemRadio name="sortBy" value="scannedAt">
              Last Scanned
            </MenuItemRadio>
          </MenuGroup>
          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>Direction</MenuGroupHeader>
            {sortDirectionOptions.map((dir) => (
              <MenuItemRadio key={dir} name="sortDirection" value={dir}>
                {getSortDirectionLabel(dir)}
              </MenuItemRadio>
            ))}
          </MenuGroup>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  const renderSelectionBar = () => {
    if (!isSelectionMode) {
      return null;
    }

    if (selectedTab === "artists") {
      return (
        <LibrarySelectionBar
          selectedCount={artistSelection.selectedCount}
          allVisibleSelected={artistSelection.allVisibleSelected}
          someVisibleSelected={artistSelection.someVisibleSelected}
          onSelectAllVisible={artistSelection.selectAllVisible}
          onClearSelection={artistSelection.clearSelection}
          actions={[
            {
              key: "scan",
              label: "Refresh & scan",
              icon: <ArrowSync24Regular />,
              onClick: queueSelectedArtistScan,
              disabled: artistSelection.selectedCount === 0,
            },
            {
              key: "curate",
              label: "Curate selected",
              icon: <ArrowSortDownLines24Regular />,
              onClick: queueSelectedArtistCurate,
              disabled: artistSelection.selectedCount === 0,
            },
            {
              key: "download",
              label: "Download missing",
              icon: <ArrowDownload24Regular />,
              onClick: queueSelectedArtistDownload,
              disabled: artistSelection.selectedCount === 0,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24Regular />,
              onClick: () => void setSelectedArtistMonitoring(true),
              disabled: artistSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24Regular />,
              onClick: () => void setSelectedArtistMonitoring(false),
              disabled: artistSelection.selectedCount === 0,
            },
          ]}
        />
      );
    }

    if (selectedTab === "albums") {
      return (
        <LibrarySelectionBar
          selectedCount={albumSelection.selectedCount}
          allVisibleSelected={albumSelection.allVisibleSelected}
          someVisibleSelected={albumSelection.someVisibleSelected}
          onSelectAllVisible={albumSelection.selectAllVisible}
          onClearSelection={albumSelection.clearSelection}
          actions={[
            {
              key: "download",
              label: "Download selected",
              icon: <ArrowDownload24Regular />,
              onClick: queueSelectedAlbumDownload,
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24Regular />,
              onClick: () => void setSelectedAlbumMonitoring(true),
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24Regular />,
              onClick: () => void setSelectedAlbumMonitoring(false),
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "lock",
              label: "Lock",
              icon: <LockClosed24Regular />,
              onClick: () => void setSelectedAlbumLockState(true),
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "unlock",
              label: "Unlock",
              icon: <LockOpen24Regular />,
              onClick: () => void setSelectedAlbumLockState(false),
              disabled: albumSelection.selectedCount === 0,
            },
          ]}
        />
      );
    }

    if (selectedTab === "tracks") {
      return (
        <LibrarySelectionBar
          selectedCount={trackSelection.selectedCount}
          allVisibleSelected={trackSelection.allVisibleSelected}
          someVisibleSelected={trackSelection.someVisibleSelected}
          onSelectAllVisible={trackSelection.selectAllVisible}
          onClearSelection={trackSelection.clearSelection}
          actions={[
            {
              key: "download",
              label: "Download selected",
              icon: <ArrowDownload24Regular />,
              onClick: queueSelectedTrackDownload,
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24Regular />,
              onClick: () => void setSelectedTrackMonitoring(true),
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24Regular />,
              onClick: () => void setSelectedTrackMonitoring(false),
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "lock",
              label: "Lock",
              icon: <LockClosed24Regular />,
              onClick: () => void setSelectedTrackLockState(true),
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "unlock",
              label: "Unlock",
              icon: <LockOpen24Regular />,
              onClick: () => void setSelectedTrackLockState(false),
              disabled: trackSelection.selectedCount === 0,
            },
          ]}
        />
      );
    }

    if (selectedTab === "videos") {
      return (
        <LibrarySelectionBar
          selectedCount={videoSelection.selectedCount}
          allVisibleSelected={videoSelection.allVisibleSelected}
          someVisibleSelected={videoSelection.someVisibleSelected}
          onSelectAllVisible={videoSelection.selectAllVisible}
          onClearSelection={videoSelection.clearSelection}
          actions={[
            {
              key: "download",
              label: "Download selected",
              icon: <ArrowDownload24Regular />,
              onClick: queueSelectedVideoDownload,
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24Regular />,
              onClick: () => void setSelectedVideoMonitoring(true),
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24Regular />,
              onClick: () => void setSelectedVideoMonitoring(false),
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "lock",
              label: "Lock",
              icon: <LockClosed24Regular />,
              onClick: () => void setSelectedVideoLockState(true),
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "unlock",
              label: "Unlock",
              icon: <LockOpen24Regular />,
              onClick: () => void setSelectedVideoLockState(false),
              disabled: videoSelection.selectedCount === 0,
            },
          ]}
        />
      );
    }

    return null;
  };

  const renderPane = ({
    sentinelRef,
    isFetching,
    children,
    topContent,
  }: {
    sentinelRef: any;
    isFetching: boolean;
    children: React.ReactNode;
    topContent?: React.ReactNode;
  }) => (
    <div className={styles.tabPanel}>
      {topContent ? <div className={styles.contentPadding}>{topContent}</div> : null}
      <div className={mergeClasses(styles.tabScroller, styles.contentPadding)}>
        {children}
        <div ref={sentinelRef} className={styles.sentinel} />
        {isFetching ? <div className={styles.fetchMoreRow}><Text size={200}>Loading more...</Text></div> : null}
      </div>
    </div>
  );

  const canToggleView = selectedTab !== "tracks";
  const showLockFilter = selectedTab !== "artists";
  const showDownloadFilter = selectedTab !== "artists";

  return (
    <div className={styles.container}>
      <div className={styles.pageBody}>
        <div className={styles.toolbar}>
          <div className={responsiveTabsStyles.tabSlot}>
            {/* Mobile dropdown */}
            <div className={responsiveTabsStyles.mobileSelect}>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button appearance="subtle" iconPosition="after" icon={<ChevronDownRegular />} className={responsiveTabsStyles.menuButton}>
                    {LIBRARY_TABS.find((tab) => tab.key === selectedTab)?.label ?? "Artists"}
                  </Button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {LIBRARY_TABS.map((tab) => (
                      <MenuItem key={tab.key} onClick={() => setSelectedTab(tab.key)}>
                        {tab.label}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
            {/* Desktop tabs */}
            <div className={responsiveTabsStyles.desktopTabs}>
              <TabList selectedValue={selectedTab} onTabSelect={(_, data) => setSelectedTab(data.value as string)}>
                {LIBRARY_TABS.map((tab) => {
                  const statKey = tab.key as keyof Pick<NonNullable<typeof stats>, 'artists' | 'albums' | 'tracks' | 'videos'>;
                  const tabStats = stats?.[statKey];
                  return (
                    <Tab key={tab.key} value={tab.key} title={tabStats ? `${tabStats.monitored} monitored, ${tabStats.total} in database` : undefined}>
                      {tab.label}
                    </Tab>
                  );
                })}
              </TabList>
            </div>
          </div>

          <div className={styles.mobileControlsRow}>
            <div className={styles.compactActions}>
              {importProvider ? (
                <Button
                  appearance="subtle"
                  icon={<ArrowImport24Regular />}
                  onClick={() => setImportModalOpen(true)}
                  className={styles.menuButtonIconOnly}
                  title="Import artists from a connected service"
                  aria-label="Import artists"
                >
                  <span className={styles.mobileHiddenLabel}>Import</span>
                </Button>
              ) : null}
              <Button
                appearance="subtle"
                icon={<SelectItemsIcon />}
                onClick={toggleSelectionMode}
                className={styles.menuButtonIconOnly}
                title={isSelectionMode ? "Stop selecting" : `Select ${selectedTab}`}
                aria-label={isSelectionMode ? "Stop selecting" : `Select ${selectedTab}`}
                aria-pressed={isSelectionMode}
              >
                <span className={styles.mobileHiddenLabel}>{isSelectionMode ? "Done" : "Select"}</span>
              </Button>
              {renderSortMenu()}

              <FilterMenu
                libraryFilter={libraryFilter}
                onLibraryFilterChange={setLibraryFilter}
                statusFilters={effectiveStatusFilters}
                onStatusFiltersChange={setStatusFilters}
                showDownloadFilter={showDownloadFilter}
                showLockFilter={showLockFilter}
                className={styles.menuButtonIconOnly}
                hideLabelOnMobile
              />

              {/* View Mode Toggle */}
              {canToggleView ? (
                <Button
                  appearance="subtle"
                  icon={viewMode === 'grid' ? <Grid24Regular /> : <AppsListDetail24Regular />}
                  onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                  className={styles.menuButtonIconOnly}
                  title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
                  aria-label={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
                >
                  <span className={styles.mobileHiddenLabel}>
                    {viewMode === 'grid' ? 'Grid' : 'List'}
                  </span>
                </Button>
              ) : null}
            </div>
          </div>

          <div className={styles.desktopControlsRow}>
            <div className={styles.compactActions}>
              {importProvider ? (
                <Button
                  appearance="subtle"
                  icon={<ArrowImport24Regular />}
                  onClick={() => setImportModalOpen(true)}
                  className={styles.menuButtonIconOnly}
                  title="Import artists from a connected service"
                  aria-label="Import artists"
                >
                  <span className={styles.mobileHiddenLabel}>Import</span>
                </Button>
              ) : null}
              <Button
                appearance="subtle"
                icon={<SelectItemsIcon />}
                onClick={toggleSelectionMode}
                className={styles.menuButtonIconOnly}
                title={isSelectionMode ? "Stop selecting" : `Select ${selectedTab}`}
                aria-label={isSelectionMode ? "Stop selecting" : `Select ${selectedTab}`}
                aria-pressed={isSelectionMode}
              >
                <span className={styles.mobileHiddenLabel}>{isSelectionMode ? "Done" : "Select"}</span>
              </Button>
              {renderSortMenu()}

              <FilterMenu
                libraryFilter={libraryFilter}
                onLibraryFilterChange={setLibraryFilter}
                statusFilters={effectiveStatusFilters}
                onStatusFiltersChange={setStatusFilters}
                showDownloadFilter={showDownloadFilter}
                showLockFilter={showLockFilter}
                className={styles.menuButtonIconOnly}
                hideLabelOnMobile
              />

              {/* View Mode Toggle */}
              {canToggleView ? (
                <Button
                  appearance="subtle"
                  icon={viewMode === 'grid' ? <Grid24Regular /> : <AppsListDetail24Regular />}
                  onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                  className={styles.menuButtonIconOnly}
                  title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
                  aria-label={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
                >
                  <span className={styles.mobileHiddenLabel}>
                    {viewMode === 'grid' ? 'Grid' : 'List'}
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {selectedTab === "artists" && (
          <div className={styles.virtuosoContainer}>
            {loading ? renderPane({
              sentinelRef: activeSentinelRef,
              isFetching: false,
              children: renderLoadingContent(),
            }) : artistsHasRefreshError && (artists.length === 0 || !artistsIsPopulated) ? (
              renderErrorContent(
                "Failed to load artists",
                artistsRefreshErrorMessage,
                () => { void refetchArtists(); },
              )
            ) : artists.length === 0 ? (
              renderNoResultsContent("artists")
            ) : (
              renderPane({
                sentinelRef: activeSentinelRef,
                isFetching: artistsFetchingMore,
                topContent: renderSelectionBar(),
                children: viewMode === 'grid' ? (
                  <div className={styles.grid}>
                    {artists.map((artist) => renderArtistCard(artist))}
                  </div>
                ) : (
                  <DataGrid
                    columns={artistColumns}
                    items={artists}
                    getRowKey={(a: any) => a.id}
                    onRowClick={(a: any) => navigate(`/artist/${a.id}`)}
                    selection={isSelectionMode ? {
                      ...artistSelection.selection,
                      getSelectionLabel: (artist: any) => artist.name ? `Select ${artist.name}` : "Select artist",
                    } : undefined}
                  />
                ),
              })
            )}
          </div>
        )}

        {selectedTab === "albums" && (
          <div className={styles.virtuosoContainer}>
            {loading ? renderPane({
              sentinelRef: activeSentinelRef,
              isFetching: false,
              children: renderLoadingContent(),
            }) : albumsHasRefreshError && (albums.length === 0 || !albumsIsPopulated) ? (
              renderErrorContent(
                "Failed to load albums",
                albumsRefreshErrorMessage,
                () => { void refetchAlbums(); },
              )
            ) : albums.length === 0 ? (
              renderNoResultsContent("albums")
            ) : (
              renderPane({
                sentinelRef: activeSentinelRef,
                isFetching: albumsFetchingMore,
                topContent: renderSelectionBar(),
                children: viewMode === 'grid' ? (
                  <div className={styles.grid}>
                    {albums.map((album) => renderAlbumCard(album))}
                  </div>
                ) : (
                  <DataGrid
                    columns={albumColumns}
                    items={albums}
                    getRowKey={(a: any) => a.id}
                    onRowClick={(a: any) => navigate(`/album/${a.id}`)}
                    selection={isSelectionMode ? {
                      ...albumSelection.selection,
                      getSelectionLabel: (album: any) => album.title ? `Select ${album.title}` : "Select album",
                    } : undefined}
                  />
                ),
              })
            )}
          </div>
        )}

        {selectedTab === "tracks" && (
          <div className={styles.virtuosoContainer}>
            {tracksLoading ? renderPane({
              sentinelRef: activeSentinelRef,
              isFetching: false,
              children: renderLoadingContent(),
            }) : tracksHasRefreshError && (tracks.length === 0 || !tracksIsPopulated) ? (
              renderErrorContent(
                "Failed to load tracks",
                tracksRefreshErrorMessage,
                () => { void refetchTracks(); },
              )
            ) : tracks.length === 0 ? (
              renderNoResultsContent("tracks")
            ) : (
              renderPane({
                sentinelRef: activeSentinelRef,
                isFetching: tracksFetchingMore,
                topContent: renderSelectionBar(),
                children: <TrackList
                  tracks={tracks}
                  showCover
                  showArtist
                  showAlbum
                  showDownloadedColumn
                  disableStickyHeader={false}
                  onDownloadTrack={handleDownloadTrack}
                  isTrackDownloading={(track) => downloadingTracks.has(track.id)}
                  onTrackClick={(track: any) => {
                    if (track.album_id) {
                      navigateToAlbumTrack(navigate, track.album_id, track.id);
                    }
                  }}
                  // The tracks tab is always a table (no grid toggle), so selection
                  // must always be available here — it isn't gated on viewMode like
                  // the grid/list tabs, where the persisted viewMode could be 'grid'.
                  selection={isSelectionMode ? {
                    ...trackSelection.selection,
                    getSelectionLabel: (track: any) => track.title ? `Select ${track.title}` : "Select track",
                  } : undefined}
                />,
              })
            )}
          </div>
        )}

        {selectedTab === "videos" && (
          <div className={styles.virtuosoContainer}>
            {videosLoading ? renderPane({
              sentinelRef: activeSentinelRef,
              isFetching: false,
              children: renderLoadingContent(),
            }) : videosHasRefreshError && (videos.length === 0 || !videosIsPopulated) ? (
              renderErrorContent(
                "Failed to load videos",
                videosRefreshErrorMessage,
                () => { void refetchVideos(); },
              )
            ) : videos.length === 0 ? (
              renderNoResultsContent("videos")
            ) : (
              renderPane({
                sentinelRef: activeSentinelRef,
                isFetching: videosFetchingMore,
                topContent: renderSelectionBar(),
                children: viewMode === 'grid' ? (
                  <VideoGrid
                    videos={videos}
                    loading={videosLoading}
                    onToggleMonitor={(video) => toggleVideoMonitor(video.id, !video.is_monitored)}
                    onDownload={(video) => {
                      const providerVideoId = String((video as any).provider_id ?? (video as any).providerId ?? video.id ?? "").trim();
                      void addToQueue(null, "video", providerVideoId, {
                        payload: {
                          provider: (video as any).provider ?? "tidal",
                          providerId: providerVideoId,
                          title: video.title,
                          artist: (video as any).artist_name,
                          cover: (video as any).cover ?? (video as any).cover_id ?? null,
                          quality: video.quality ?? null,
                        },
                      });
                    }}
                    onOpenVideo={(video) => navigate(`/video/${video.id}`)}
                    selection={isSelectionMode ? {
                      selectedIds: new Set(videoSelection.selectedRowIds.map(String)),
                      onToggle: (video, selected, shiftKey) => videoSelection.toggleItem(video.id, selected, { range: shiftKey }),
                    } : undefined}
                    onSelectionIntent={(video) => beginSelectionWith(videoSelection, String(video.id))}
                  />
                ) : (
                  <DataGrid
                    columns={videoColumns}
                    items={videos}
                    getRowKey={(v: any) => v.id}
                    onRowClick={(v: any) => navigate(`/video/${v.id}`)}
                    selection={isSelectionMode ? {
                      ...videoSelection.selection,
                      getSelectionLabel: (video: any) => video.title ? `Select ${video.title}` : "Select video",
                    } : undefined}
                  />
                ),
              })
            )}
          </div>
        )}
      </div>

      <ImportArtistsModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={() => fetchLibrary(undefined, { refreshStats: true })}
      />
    </div>
  );
};

export default Library;
