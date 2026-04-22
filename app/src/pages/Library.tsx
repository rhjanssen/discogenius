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
  SearchBox,
} from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  Search24Regular,
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  ChevronDownRegular,
  Grid24Regular,
  AppsListDetail24Regular,
  Speaker224Regular,
  ArrowSortUp24Regular,
  ArrowSortDown24Regular,
  ArrowSortDownLines24Regular,
  MusicNote224Regular,
  Person24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
} from "@fluentui/react-icons";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { DownloadedBadge, NotScannedBadge } from "@/components/ui/StatusBadges";
import { useResponsiveTabsStyles } from "@/components/ui/useResponsiveTabsStyles";
import { MediaCard } from "@/components/cards/MediaCard";
import { useCardStyles } from "@/components/cards/cardStyles";
import { LibraryRowActions } from "@/components/library/LibraryRowActions";
import { LibrarySelectionBar } from "@/components/library/LibrarySelectionBar";
import FilterMenu from "@/components/FilterMenu";
import { StatusFilters, defaultStatusFilters } from "@/utils/statusFilters";
import LibraryTrackList from "@/components/LibraryTrackList";
import VideoGrid from "@/components/VideoGrid";
import { useLibrary } from "@/hooks/useLibrary";
import { useTidalSearch } from "@/hooks/useTidalSearch";
import { useTracks } from "@/hooks/useTracks";
import { useVideos } from "@/hooks/useVideos";
import { useQueueDetails } from "@/hooks/useQueueDetails";
import { useToast } from "@/hooks/useToast";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";
import { DataGrid, useDataGridCellStyles } from "@/components/DataGrid";
import type { DataGridColumn } from "@/components/DataGrid";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { api } from "@/services/api";
import { getArtistPicture, getAlbumCover, getTidalImage } from "@/utils/tidalImages";
import {
  dispatchActivityRefresh,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
} from "@/utils/appEvents";
import { tidalUrl } from "@/utils/tidalUrl";
import { formatDurationSeconds } from "@/utils/format";
import { CardGridSkeleton, DataGridSkeleton, TrackTableSkeleton } from "@/components/ui/LoadingSkeletons";

const useStyles = makeStyles({
  searchBox: {
    minWidth: "220px",
    maxWidth: "320px",
    flexGrow: 0,
    flexShrink: 1,
  },
  desktopSearchBox: {
    "@media (max-width: 639px)": {
      display: "none",
    },
  },
  mobileSearchRow: {
    display: "block",
    width: "100%",
    "@media (min-width: 640px)": {
      display: "none",
    },
  },
  mobileSearchBox: {
    minWidth: "100%",
    maxWidth: "100%",
    width: "100%",
  },
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
      gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 1200px)": {
      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    },
  },
  tabContent: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    gap: tokens.spacingVerticalS,
  },
  scrollContainer: {
    overflow: "auto",
    flexGrow: 1,
  },
  contentPadding: {
    padding: tokens.spacingHorizontalXXS,
    "@media (min-width: 768px)": {
      padding: tokens.spacingHorizontalS,
    },
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
    overflow: "auto",
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
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(12px) saturate(140%)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
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

const Library = () => {
  const styles = useStyles();
  const responsiveTabsStyles = useResponsiveTabsStyles();
  const cardStyles = useCardStyles();
  const dgCell = useDataGridCellStyles();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Load persisted settings from localStorage
  const loadPersistedSettings = () => {
    try {
      const saved = localStorage.getItem('discogenius_library_settings');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load library settings from localStorage:', e);
    }
    return null;
  };

  const persistedSettings = loadPersistedSettings();
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
    setSearchQuery,
    artistsIsPopulated,
    albumsIsPopulated,
    artistsHasRefreshError,
    artistsRefreshErrorMessage,
    albumsHasRefreshError,
    albumsRefreshErrorMessage,
  } = useLibrary({ activeTab: selectedTab as 'artists' | 'albums' | 'tracks' | 'videos' });
  const { importFollowedArtists } = useTidalSearch();
  const { addToQueue, getProgressByTidalId } = useQueueStatus();
  const [importing, setImporting] = useState(false);
  const { setArtwork } = useUltraBlurContext();
  const artistSentinelRef = useRef<HTMLDivElement | null>(null);
  const albumSentinelRef = useRef<HTMLDivElement | null>(null);
  const trackSentinelRef = useRef<HTMLDivElement | null>(null);
  const videoSentinelRef = useRef<HTMLDivElement | null>(null);
  // Scroll container refs for IntersectionObserver root
  const artistScrollRef = useRef<HTMLDivElement | null>(null);
  const albumScrollRef = useRef<HTMLDivElement | null>(null);
  const trackScrollRef = useRef<HTMLDivElement | null>(null);
  const videoScrollRef = useRef<HTMLDivElement | null>(null);
  const [isFetchingMore, setIsFetchingMore] = useState({
    artists: false,
    albums: false,
    tracks: false,
    videos: false,
  });

  // Filters - load from persisted settings
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'stereo' | 'atmos' | 'video'>(
    persistedSettings?.libraryFilter ?? 'all'
  );
  // Default: show only monitored items for new users
  const monitoredDefaultFilters: StatusFilters = { ...defaultStatusFilters, onlyMonitored: true };
  const [statusFilters, setStatusFilters] = useState<StatusFilters>(
    persistedSettings?.statusFilters ?? monitoredDefaultFilters
  );
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
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(localSearchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearchQuery]);

  useEffect(() => {
    setSearchQuery(debouncedSearchQuery);
  }, [debouncedSearchQuery, setSearchQuery]);

  // Persist settings to localStorage whenever they change
  useEffect(() => {
    const settings = {
      selectedTab,
      libraryFilter,
      statusFilters,
      viewMode,
      sortBy,
      sortDirection,
    };
    try {
      localStorage.setItem('discogenius_library_settings', JSON.stringify(settings));
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
    if (statusFilters.onlyMonitored && !statusFilters.onlyUnmonitored) return true;
    if (!statusFilters.onlyMonitored && statusFilters.onlyUnmonitored) return false;
    return undefined;
  }, [statusFilters]);

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
    search: debouncedSearchQuery,
    enabled: selectedTab === 'tracks',
  });
  const {
    videos,
    loading: videosLoading,
    isPopulated: videosIsPopulated,
    hasMore: hasMoreVideos,
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
    search: debouncedSearchQuery,
    enabled: selectedTab === 'videos',
  });
  const visibleAlbumIds = useMemo(
    () => selectedTab === "albums"
      ? albums.map((album: any) => String(album.id))
      : [],
    [albums, selectedTab],
  );
  const { items: albumQueueDetails } = useQueueDetails({
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
  const videoSelection = useSelectableCollection({
    items: videos,
    getItemId: (video: any) => video.id,
  });
  const clearVideoSelection = videoSelection.clearSelection;

  useEffect(() => {
    if (viewMode !== "list") {
      clearArtistSelection();
      clearAlbumSelection();
      clearTrackSelection();
      clearVideoSelection();
    }
  }, [
    viewMode,
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
      await api.processRedundancy(artist.id);
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
      dispatchMonitorStateChanged({ type: "artist", tidalId: artist.id, monitored });
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
      await addToQueue(tidalUrl("album", album.id), "album", album.id);
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
      dispatchMonitorStateChanged({ type: "album", tidalId: album.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    albumSelection.clearSelection();
  };

  const setSelectedAlbumLockState = async (locked: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(albumSelection.selectedItems, async (album: any) => {
      await api.updateAlbum(album.id, { monitor_lock: locked });
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
      return !isDownloaded;
    });

    if (queueableTracks.length === 0) {
      toast({
        title: "No downloadable tracks selected",
        description: "All selected tracks are already downloaded.",
      });
      trackSelection.clearSelection();
      return;
    }

    const { succeeded, failed } = await runSelectionActionWithConcurrency(queueableTracks, async (track: any) => {
      await addToQueue(tidalUrl("track", track.id), "track", track.id);
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
      dispatchMonitorStateChanged({ type: "track", tidalId: track.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    trackSelection.clearSelection();
  };

  const setSelectedTrackLockState = async (locked: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(trackSelection.selectedItems, async (track: any) => {
      await api.updateTrack(track.id, { monitor_lock: locked });
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
      await addToQueue(tidalUrl("video", video.id), "video", video.id);
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
      dispatchMonitorStateChanged({ type: "video", tidalId: video.id, monitored });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(monitored ? "Monitoring enabled" : "Monitoring disabled", succeeded, failed);
    videoSelection.clearSelection();
  };

  const setSelectedVideoLockState = async (locked: boolean) => {
    const { succeeded, failed } = await runSelectionActionWithConcurrency(videoSelection.selectedItems, async (video: any) => {
      await api.updateVideo(video.id, { monitor_lock: locked });
    });

    if (succeeded > 0) {
      dispatchLibraryUpdated();
    }

    showBulkResult(locked ? "Videos locked" : "Videos unlocked", succeeded, failed);
    videoSelection.clearSelection();
  };

  // Helper to check if album is in queue or downloaded
  const getAlbumDownloadStatus = (album: any) => {
    const albumId = String(album.id);
    const inQueue = albumQueueDetails.find((item) =>
      item.tidalId === albumId || item.album_id === albumId,
    );

    if (album.is_downloaded) return 'downloaded';
    if (inQueue?.status === 'downloading') return 'downloading';
    if (inQueue?.status === 'pending') return 'pending';
    if (inQueue?.status === 'failed') return 'failed';
    return 'none';
  };

  const handleDownloadAlbum = async (e: React.MouseEvent, album: any) => {
    e.stopPropagation(); // Prevent card click navigation


    const albumUrl = tidalUrl('album', album.id);
    await addToQueue(albumUrl, 'album', album.id);
  };

  const { setBrandKeyColor } = useTheme();

  // Clear artwork and brand color when on library view (use logo colors)
  useEffect(() => {
    setArtwork(undefined);
    setBrandKeyColor(null);
  }, [setArtwork, setBrandKeyColor]);

  // Infinite scroll observer for each tab - uses tab-specific scroll container as root
  // Artists tab observer
  useEffect(() => {
    // Wait for data to be loaded before setting up observer
    if (selectedTab !== "artists" || loading || artists.length === 0) return;
    if (!artistScrollRef.current || !artistSentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && hasMoreArtists && !isFetchingMore.artists) {
            setIsFetchingMore((prev) => ({ ...prev, artists: true }));
            loadMoreArtists().finally(() =>
              setIsFetchingMore((prev) => ({ ...prev, artists: false }))
            );
          }
        });
      },
      { root: artistScrollRef.current, rootMargin: "0px 0px 400px 0px" }
    );

    observer.observe(artistSentinelRef.current);
    return () => observer.disconnect();
  }, [selectedTab, hasMoreArtists, isFetchingMore.artists, loadMoreArtists, loading, artists.length]);

  // Albums tab observer
  useEffect(() => {
    // Wait for data to be loaded before setting up observer
    if (selectedTab !== "albums" || loading || albums.length === 0) return;
    if (!albumScrollRef.current || !albumSentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && hasMoreAlbums && !isFetchingMore.albums) {
            setIsFetchingMore((prev) => ({ ...prev, albums: true }));
            loadMoreAlbums().finally(() =>
              setIsFetchingMore((prev) => ({ ...prev, albums: false }))
            );
          }
        });
      },
      { root: albumScrollRef.current, rootMargin: "0px 0px 400px 0px" }
    );

    observer.observe(albumSentinelRef.current);
    return () => observer.disconnect();
  }, [selectedTab, hasMoreAlbums, isFetchingMore.albums, loadMoreAlbums, loading, albums.length]);

  // Tracks tab observer
  useEffect(() => {
    if (selectedTab !== "tracks" || tracksLoading || tracks.length === 0) return;
    if (selectedTab !== "tracks" || !trackScrollRef.current || !trackSentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && hasMoreTracks && !isFetchingMore.tracks) {
            setIsFetchingMore((prev) => ({ ...prev, tracks: true }));
            loadMoreTracks().finally(() =>
              setIsFetchingMore((prev) => ({ ...prev, tracks: false }))
            );
          }
        });
      },
      { root: trackScrollRef.current, rootMargin: "0px 0px 400px 0px" }
    );

    observer.observe(trackSentinelRef.current);
    return () => observer.disconnect();
  }, [selectedTab, hasMoreTracks, loadMoreTracks, isFetchingMore.tracks, tracksLoading, tracks.length]);

  // Videos tab observer
  useEffect(() => {
    if (selectedTab !== "videos" || videosLoading || videos.length === 0) return;
    if (selectedTab !== "videos" || !videoScrollRef.current || !videoSentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && hasMoreVideos && !isFetchingMore.videos) {
            setIsFetchingMore((prev) => ({ ...prev, videos: true }));
            loadMoreVideos().finally(() =>
              setIsFetchingMore((prev) => ({ ...prev, videos: false }))
            );
          }
        });
      },
      { root: videoScrollRef.current, rootMargin: "0px 0px 400px 0px" }
    );

    observer.observe(videoSentinelRef.current);
    return () => observer.disconnect();
  }, [selectedTab, hasMoreVideos, loadMoreVideos, isFetchingMore.videos, videosLoading, videos.length]);

  const handleImportFollowed = async () => {

    setImporting(true);
    try {
      await importFollowedArtists();
      // Refresh the library to show the new artists and albums
      await fetchLibrary(undefined, { refreshStats: true });
    } finally {
      setImporting(false);
    }
  };

  // Render a single artist card
  const renderArtistCard = (artist: any) => {
    const albumCount = artist.album_count ?? 0;
    const imageUrl = getArtistPicture(artist.picture, 'small') || artist.cover_image_url || null;
    const itemProgress = getProgressByTidalId(String(artist.id));
    return (
      <MediaCard
        key={artist.id}
        to={`/artist/${artist.id}`}
        imageUrl={imageUrl}
        alt={artist.name}
        title={artist.name}
        subtitle={`${albumCount} releases`}
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
      const result: any = await api.processRedundancy(artist.id);
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
        const src = getArtistPicture(artist.picture, 'small') || artist.cover_image_url;
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
          <span className={dgCell.statPrimary}>{artist.monitored_album_count ?? 0}</span>
          <span className={dgCell.statSecondary}> / {artist.album_count ?? 0}</span>
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
          <span className={dgCell.statPrimary}>{artist.monitored_track_count ?? 0}</span>
          <span className={dgCell.statSecondary}> / {artist.track_count ?? 0}</span>
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
              label: "Search missing",
              icon: <ArrowSortDownLines24Regular />,
              onClick: (event) => handleArtistCurate(event, artist),
            },
            {
              key: "download",
              label: "Download monitored",
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
        tidalId: album.id,
        monitored: nextMonitored,
      });
      dispatchLibraryUpdated();
    } catch (error) {
      console.error('Failed to toggle album monitoring:', error);
    }
  }, []);

  const handleToggleAlbumLock = useCallback(async (e: React.MouseEvent, album: any) => {
    e.stopPropagation();
    const nextLocked = !(album.monitor_locked ?? album.monitor_lock);
    try {
      await api.updateAlbum(album.id, { monitor_lock: nextLocked });
      dispatchLibraryUpdated();
    } catch (error) {
      console.error('Failed to toggle album lock:', error);
    }
  }, []);

  // Render a single album card
  const renderAlbumCard = (album: any) => {
    const year = album.release_date ? album.release_date.split('-')[0] : '';
    const subtitle = [album.artist_name, year].filter(Boolean).join(' · ');
    const isLocked = (album.monitor_locked ?? album.monitor_lock) ? true : false;
    const imageUrl = getAlbumCover(album.cover_id, 'small') || album.cover_art_url || null;
    const itemProgress = getProgressByTidalId(String(album.id));
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
      />
    );
  };

  // Render album as datagrid columns
  const handleDownloadAlbumRow = useCallback(async (e: React.MouseEvent, album: any) => {
    e.stopPropagation();


    const albumUrl = tidalUrl('album', album.id);
    await addToQueue(albumUrl, 'album', album.id);
  }, [addToQueue]);

  const albumColumns = useMemo<DataGridColumn[]>(() => [
    {
      key: "thumb",
      header: "",
      width: "40px",
      render: (album: any) => {
        const src = getAlbumCover(album.cover_id, 'small') || album.cover_art_url;
        return src ? (
          <img src={src} alt={album.title} className={dgCell.thumbnailSquare} />
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
      width: "90px",
      align: "center",
      render: (album: any) => album.quality ? <QualityBadge quality={album.quality} /> : null,
    },
    {
      key: "actions",
      header: "",
      width: "120px",
      align: "right",
      render: (album: any) => {
        const isLocked = (album.monitor_locked ?? album.monitor_lock) ? true : false;
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
        const src = getTidalImage(video.cover_id || video.cover_art_url, 'video', 'small');
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
        const isLocked = (video.monitor_locked ?? video.monitor_lock) ? true : false;
        return (
          <LibraryRowActions
            actions={[
              {
                key: "download",
                label: "Download video",
                icon: <ArrowDownload24Regular />,
                onClick: (event) => {
                  event.stopPropagation();
                  void addToQueue(tidalUrl("video", video.id), "video", video.id);
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
      <EmptyState
        title="Your library is empty"
        description="Use search to find artists or import followed artists from TIDAL."
        icon={<MusicNote224Regular />}
        minHeight="320px"
        actions={
          <Button
            appearance="primary"
            icon={<ArrowDownload24Regular />}
            onClick={handleImportFollowed}
            disabled={importing}
            title='Import followed artists from TIDAL'
          >
            {importing ? 'Importing...' : 'Import Followed Artists'}
          </Button>
        }
      />
    );
  }

  // Helper to render loading state in content area
  const renderLoadingContent = () => {
    switch (selectedTab) {
      case "tracks":
        return <TrackTableSkeleton rows={10} showCover showArtist showAlbum />;
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
      description={`No ${mediaLabel} match your current filters or search.`}
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
    if (viewMode !== "list") {
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
              label: "Search missing",
              icon: <ArrowSortDownLines24Regular />,
              onClick: queueSelectedArtistCurate,
              disabled: artistSelection.selectedCount === 0,
            },
            {
              key: "download",
              label: "Download monitored",
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
    scrollRef,
    sentinelRef,
    isFetching,
    children,
    topContent,
  }: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    sentinelRef: React.RefObject<HTMLDivElement | null>;
    isFetching: boolean;
    children: React.ReactNode;
    topContent?: React.ReactNode;
  }) => (
    <div className={styles.tabPanel}>
      {topContent ? <div>{topContent}</div> : null}
      <div ref={scrollRef} className={mergeClasses(styles.tabScroller, styles.contentPadding)}>
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
              {renderSortMenu()}

              <FilterMenu
                libraryFilter={libraryFilter}
                onLibraryFilterChange={setLibraryFilter}
                statusFilters={statusFilters}
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
            <SearchBox
              placeholder="Filter..."
              value={localSearchQuery}
              onChange={(e, data) => setLocalSearchQuery(data.value || '')}
              className={mergeClasses(styles.searchBox, styles.desktopSearchBox)}
            />
            <div className={styles.compactActions}>
              {renderSortMenu()}

              <FilterMenu
                libraryFilter={libraryFilter}
                onLibraryFilterChange={setLibraryFilter}
                statusFilters={statusFilters}
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

        <div className={styles.mobileSearchRow}>
          <SearchBox
            placeholder="Filter..."
            value={localSearchQuery}
            onChange={(e, data) => setLocalSearchQuery(data.value || '')}
            className={mergeClasses(styles.searchBox, styles.mobileSearchBox)}
          />
        </div>

        {selectedTab === "artists" && (
          <div className={styles.virtuosoContainer}>
            {loading ? renderPane({
              scrollRef: artistScrollRef,
              sentinelRef: artistSentinelRef,
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
                scrollRef: artistScrollRef,
                sentinelRef: artistSentinelRef,
                isFetching: isFetchingMore.artists,
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
                    selection={viewMode === 'list' ? {
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
              scrollRef: albumScrollRef,
              sentinelRef: albumSentinelRef,
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
                scrollRef: albumScrollRef,
                sentinelRef: albumSentinelRef,
                isFetching: isFetchingMore.albums,
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
                    selection={viewMode === 'list' ? {
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
              scrollRef: trackScrollRef,
              sentinelRef: trackSentinelRef,
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
                scrollRef: trackScrollRef,
                sentinelRef: trackSentinelRef,
                isFetching: isFetchingMore.tracks,
                topContent: renderSelectionBar(),
                children: <LibraryTrackList
                  tracks={tracks}
                  selection={viewMode === 'list' ? {
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
              scrollRef: videoScrollRef,
              sentinelRef: videoSentinelRef,
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
                scrollRef: videoScrollRef,
                sentinelRef: videoSentinelRef,
                isFetching: isFetchingMore.videos,
                topContent: renderSelectionBar(),
                children: viewMode === 'grid' ? (
                  <VideoGrid
                    videos={videos}
                    loading={videosLoading}
                    onToggleMonitor={(video) => toggleVideoMonitor(video.id, !video.is_monitored)}
                    onDownload={(video) => void addToQueue(tidalUrl("video", video.id), "video", video.id)}
                    onOpenVideo={(video) => navigate(`/video/${video.id}`)}
                  />
                ) : (
                  <DataGrid
                    columns={videoColumns}
                    items={videos}
                    getRowKey={(v: any) => v.id}
                    onRowClick={(v: any) => navigate(`/video/${v.id}`)}
                    selection={viewMode === 'list' ? {
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
    </div>
  );
};

export default Library;

