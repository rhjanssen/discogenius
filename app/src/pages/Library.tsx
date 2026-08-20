import {
  Button,
  Text,
  makeStyles,
  tokens,
  mergeClasses,
} from "@fluentui/react-components";
import {
  Search24Regular,
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  Speaker224Regular,
  MusicNote224Regular,
  Person24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  bundleIcon,
  Search24Filled,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  ArrowImport24Filled,
  ArrowImport24Regular,
  MusicNote224Filled,
  Person24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Speaker224Filled,
  Rename24Filled,
  Rename24Regular,
  Tag24Filled,
  Tag24Regular,
} from "@fluentui/react-icons";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow } from "@/components/ui/ProviderQualityPill";
import { albumSelectedQualityOffers } from "@/utils/albumSelectedQualityOffers";
import { NotScannedBadge } from "@/components/ui/StatusBadges";
import { MediaCard } from "@/components/cards/MediaCard";
import { useCardStyles } from "@/components/cards/cardStyles";
import { LibraryRowActions } from "@/components/library/LibraryRowActions";
import { LibrarySelectionBar } from "@/components/library/LibrarySelectionBar";
import { useAlbumTableColumns } from "@/components/library/useAlbumTableColumns";
import { StatusFilters, defaultStatusFilters } from "@/utils/statusFilters";
import TrackList from "@/components/TrackList";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { navigateToAlbumTrack } from "@/utils/albumNavigation";
import VideoGrid from "@/components/VideoGrid";
import { useLibrary } from "@/hooks/useLibrary";
import { ImportArtistsModal } from "@/components/ui/ImportArtistsModal";
import { useTracks } from "@/hooks/useTracks";
import { useVideos } from "@/hooks/useVideos";
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
import { mediaCoverProxySrc, mediaCoverSrc } from "@/utils/artwork";
import {
  dispatchActivityRefresh,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
} from "@/utils/appEvents";
import { formatDurationSeconds } from "@/utils/format";
import { CardGridSkeleton, DataGridSkeleton } from "@/components/ui/LoadingSkeletons";
import { collectionContentInset } from "@/components/ui/sharedLayoutStyles";
import {
  LibraryArtistsNoResults,
  LibraryArtistsSelectionBar,
  useLibraryArtistColumns,
} from "@/pages/library/LibraryArtistsTab";
import { LibraryToolbar } from "@/pages/library/LibraryToolbar";
import { useLibraryFileMaintenance } from "@/pages/library/LibraryFileTools";

const Search24 = bundleIcon(Search24Filled, Search24Regular);
const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const Speaker224 = bundleIcon(Speaker224Filled, Speaker224Regular);
const ArrowImport24 = bundleIcon(ArrowImport24Filled, ArrowImport24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const Person24 = bundleIcon(Person24Filled, Person24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const Rename24 = bundleIcon(Rename24Filled, Rename24Regular);
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);

const downloadableVideoOffer = (video: any): { provider: string; providerId: string } | null => {
  const provider = String(video?.provider || "").trim();
  const providerId = String(video?.provider_id ?? video?.providerId ?? "").trim();
  return provider && providerId ? { provider, providerId } : null;
};

const videoDownloadQueuePayload = (
  video: any,
  offer: { provider: string; providerId: string },
) => ({
  provider: offer.provider,
  providerId: offer.providerId,
  canonicalRecordingId: String(video.id),
  title: video.title,
  artist: video.artist_name,
  artistId: video.artist_id ?? null,
  albumId: video.album_id ?? null,
  cover: video.cover ?? video.cover_id ?? null,
  quality: video.quality ?? null,
});

/** Selected download offer only — matches tracks' remoteOffers (chosen slot), not every variant. */
const selectedVideoQualityOffer = (video: any): {
  provider: string | null;
  providerId: string | null;
  quality: string | null;
} | null => {
  const selected = downloadableVideoOffer(video);
  const quality = String(video?.quality || "").trim() || null;
  if (selected) {
    return { provider: selected.provider, providerId: selected.providerId, quality };
  }
  if (quality || video?.provider) {
    return {
      provider: String(video?.provider || "").trim() || null,
      providerId: null,
      quality,
    };
  }
  return null;
};

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    height: "100%",
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
  durationText: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  dimmedIcon: {
    opacity: 0.6,
  },
});

const LIBRARY_SETTINGS_STORAGE_KEY = "discogenius_library_settings";
const LIBRARY_SETTINGS_VERSION = 2;

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
  const cardStyles = useCardStyles();
  const dgCell = useDataGridCellStyles();
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileMaintenance = useLibraryFileMaintenance();

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
    albumProviderFilter,
    setAlbumProviderFilter,
    albumQualityTierFilter,
    setAlbumQualityTierFilter,
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
  const { data: curationConfig } = useQuery({
    queryKey: ["curationConfig"],
    queryFn: () => api.getCurationConfig(),
    staleTime: 60_000,
  });
  const musicVideosEnabled = curationConfig?.include_videos === true;
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
    provider: albumProviderFilter,
    qualityTier: albumQualityTierFilter,
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
    provider: albumProviderFilter,
    sort: sortBy,
    dir: sortDirection,
    enabled: selectedTab === 'videos',
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
      // Manual bulk action: ignore freshness, like the single-artist refresh.
      await api.scanArtist(artist.id, { forceUpdate: true });
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
      await api.updateAlbum(album.id, { monitored }, { allLibraries: true });
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
      await api.updateAlbum(album.id, { monitored_lock: locked }, { allLibraries: true });
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
      return !isDownloaded && downloadableVideoOffer(video) != null;
    });

    if (queueableVideos.length === 0) {
      toast({
        title: "No downloadable videos selected",
        description: "Selected videos are already downloaded or have no downloadable provider offer.",
      });
      videoSelection.clearSelection();
      return;
    }

    const { succeeded, failed } = await runSelectionActionWithConcurrency(queueableVideos, async (video: any) => {
      const offer = downloadableVideoOffer(video);
      if (!offer) throw new Error("No downloadable provider offer");
      await addToQueue(null, "video", offer.providerId, {
        payload: videoDownloadQueuePayload(video, offer),
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

  // Provider options for the album library filter — every provider that can
  // supply catalog offers, so the user can narrow the library to one source.
  const providerFilterOptions = useMemo(
    () => (streamingProviders?.providers ?? []).map((provider: StreamingProviderStatus) => ({
      id: provider.id,
      name: provider.name,
    })),
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
      icon={importProvider ? <ArrowImport24 /> : undefined}
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
            <Person24 className={styles.placeholderIcon} />
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

  const handleArtistScan = useCallback(async (e: React.MouseEvent, artist: any) => {
    e.stopPropagation();
    try {
      const result: any = await api.scanArtist(artist.id, { forceUpdate: true });
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

  const artistColumns = useLibraryArtistColumns({
    onScan: handleArtistScan,
    onCurate: handleArtistCurate,
    onDownload: handleArtistDownload,
    onToggleMonitored: toggleArtistMonitored,
    showVideos: musicVideosEnabled,
  });

  const handleToggleAlbumMonitored = useCallback(async (e: React.MouseEvent, album: any) => {
    e.stopPropagation();
    const nextMonitored = !album.is_monitored;
    try {
      await api.updateAlbum(album.id, { monitored: nextMonitored }, { allLibraries: true });
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
      await api.updateAlbum(album.id, { monitored_lock: nextLocked }, { allLibraries: true });
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
    const imageUrl = mediaCoverSrc(album);
    const itemProgress = getProgressByProviderId(String(album.stereo_provider_id || ""))
      || getProgressByProviderId(String(album.spatial_provider_id || ""));
    const qualityOffers = albumSelectedQualityOffers(album);
    return (
      <MediaCard
        key={album.id}
        to={`/album/${album.id}`}
        imageUrl={imageUrl}
        alt={album.title}
        title={album.title}
        subtitle={subtitle}
        explicit={album.explicit}
        qualityBadges={qualityOffers.length > 0 ? (
          <ProviderQualityRow size="small" offers={qualityOffers} />
        ) : album.quality ? (
          <QualityBadge quality={album.quality} size="small" />
        ) : undefined}
        monitored={album.is_monitored}
        monitoringLocked={isLocked}
        onMonitorToggle={(e) => handleToggleAlbumMonitored(e, album)}
        placeholder={
          <div className={cardStyles.placeholderBg}>
            <MusicNote224 className={styles.placeholderIcon} />
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

  const renderAlbumRowActions = useCallback((album: any) => {
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
            onClick: (event) => handleToggleAlbumMonitored(event, album),
            disabled: isLocked,
          },
          {
            key: "lock",
            label: isLocked ? "Unlock" : "Lock",
            icon: isLocked ? <LockOpen24 /> : <LockClosed24 />,
            onClick: (event) => handleToggleAlbumLock(event, album),
          },
        ]}
      />
    );
  }, [handleDownloadAlbumRow, handleToggleAlbumLock, handleToggleAlbumMonitored]);

  const albumColumns = useAlbumTableColumns({
    showArtist: true,
    renderActions: renderAlbumRowActions,
  });

  /** Column definitions for video datagrid — used in library Videos tab */
  const renderVideoQuality = useCallback((video: any) => {
    const offer = selectedVideoQualityOffer(video);
    if (!offer) return null;
    return (
      <ProviderQualityRow
        size="small"
        offers={[{
          slot: "video" as const,
          quality: offer.quality,
          provider: offer.provider,
          providerAlbumId: offer.providerId,
        }]}
      />
    );
  }, []);

  const videoColumns = useMemo<DataGridColumn[]>(() => [
    {
      key: "thumb",
      header: "",
      width: "92px",
      media: true,
      render: (video: any) => {
        const src = mediaCoverProxySrc(video);
        return src ? (
          <img src={src} alt={video.title} className={dgCell.thumbnailWide} />
        ) : (
          <div className={mergeClasses(dgCell.thumbnailWide, dgCell.thumbnailPlaceholder)}>
            <Speaker224 className={styles.compactIcon} />
          </div>
        );
      },
    },
    {
      key: "title",
      header: "Title",
      width: "minmax(0, 1.5fr)",
      wrap: true,
      render: (video: any) => {
        const quality = renderVideoQuality(video);
        return (
          <div className={dgCell.nameStack}>
            <span className={dgCell.nameCell} title={video.title}>{video.title}</span>
            <Text size={200} className={mergeClasses(dgCell.subtitleText, dgCell.showOnMobileOnly)} truncate>{video.artist_name || 'Unknown'}</Text>
            {video.is_downloaded ? (
              <div className={dgCell.mobileMetaLine}>
                <span className={dgCell.mobileMetaText}>Downloaded</span>
              </div>
            ) : null}
            {quality ? (
              <div className={dgCell.mobileQuality} aria-label="Available provider quality">
                {quality}
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "artist",
      header: "Artist",
      width: "minmax(0, 1fr)",
      wrap: true,
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (video: any) => (
        <Text size={200} className={dgCell.subtitleText} truncate>{video.artist_name || 'Unknown'}</Text>
      ),
    },
    {
      key: "quality",
      header: "Provider",
      width: "max-content",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (video: any) => renderVideoQuality(video) ?? <Text size={200}>—</Text>,
    },
    {
      key: "localQuality",
      header: "Local Files",
      width: "max-content",
      minWidth: 768,
      className: dgCell.hideOnMobile,
      render: (video: any) => {
        const isDownloaded = Boolean(video.is_downloaded ?? video.downloaded);
        const quality = video.local_quality || (isDownloaded ? (video.quality || "Video") : null);
        return (
          <div className={dgCell.badgeContainer}>
            {quality ? <QualityBadge quality={quality} size="small" /> : <Text size={200}>—</Text>}
          </div>
        );
      },
    },
    {
      key: "duration",
      header: "Time",
      width: "max-content",
      align: "right",
      render: (video: any) => (
        <Text size={200} className={styles.durationText}>
          {formatDurationSeconds(video.duration)}
        </Text>
      ),
    },
    {
      key: "actions",
      header: "",
      width: "max-content",
      align: "right",
      render: (video: any) => {
        const isLocked = Boolean(video.monitored_lock);
        const downloadOffer = downloadableVideoOffer(video);
        return (
          <LibraryRowActions
            actions={[
              {
                key: "download",
                label: "Download video",
                icon: <ArrowDownload24 />,
                onClick: (event) => {
                  event.stopPropagation();
                  if (!downloadOffer) return;
                  void addToQueue(null, "video", downloadOffer.providerId, {
                    payload: videoDownloadQueuePayload(video, downloadOffer),
                  });
                },
                hidden: Boolean(video.is_downloaded ?? video.downloaded) || !downloadOffer,
              },
              {
                key: "monitor",
                label: isLocked ? "Monitoring is locked" : (video.is_monitored ? "Unmonitor" : "Monitor"),
                icon: video.is_monitored ? <EyeOff24 /> : <Eye24 />,
                onClick: (event) => {
                  event.stopPropagation();
                  toggleVideoMonitor(video.id, !video.is_monitored);
                },
                disabled: isLocked,
              },
              {
                key: "lock",
                label: isLocked ? "Unlock" : "Lock",
                icon: isLocked ? <LockOpen24 /> : <LockClosed24 />,
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
  ], [addToQueue, dgCell, renderVideoQuality, styles.compactIcon, styles.durationText, toggleVideoLock, toggleVideoMonitor]);

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
          icon={<MusicNote224 />}
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
            columnTemplate="52px minmax(180px, 1.25fr) minmax(120px, 1fr) minmax(150px, 1.35fr) max-content 72px 88px 44px"
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
              columnTemplate="64px minmax(220px, 1fr) max-content 70px 120px"
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
      icon={<Search24 />}
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

  const renderSelectionBar = () => {
    if (!isSelectionMode) {
      return null;
    }

    if (selectedTab === "artists") {
      return (
        <LibraryArtistsSelectionBar
          selectedCount={artistSelection.selectedCount}
          allVisibleSelected={artistSelection.allVisibleSelected}
          someVisibleSelected={artistSelection.someVisibleSelected}
          onSelectAllVisible={artistSelection.selectAllVisible}
          onClearSelection={artistSelection.clearSelection}
          onScan={queueSelectedArtistScan}
          onCurate={queueSelectedArtistCurate}
          onDownload={queueSelectedArtistDownload}
          onRename={() => fileMaintenance.openRenamePreview({
            artistIds: artistSelection.selectedItems.map((artist: any) => String(artist.id)),
          })}
          onWriteTags={() => fileMaintenance.openRetagPreview({
            artistIds: artistSelection.selectedItems.map((artist: any) => String(artist.id)),
          })}
          onMonitor={() => void setSelectedArtistMonitoring(true)}
          onUnmonitor={() => void setSelectedArtistMonitoring(false)}
          fileToolsBusy={fileMaintenance.busy}
          renameIcon={fileMaintenance.renameIcon}
          retagIcon={fileMaintenance.retagIcon}
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
              icon: <ArrowDownload24 />,
              onClick: queueSelectedAlbumDownload,
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "rename",
              label: "Preview Rename",
              icon: (fileMaintenance.renameIcon as React.ReactElement) ?? <Rename24 />,
              onClick: () => fileMaintenance.openRenamePreview({
                albumIds: albumSelection.selectedItems.map((album: any) => String(album.id)),
              }),
              disabled: albumSelection.selectedCount === 0 || fileMaintenance.busy,
            },
            {
              key: "retag",
              label: "Write Tags",
              icon: (fileMaintenance.retagIcon as React.ReactElement) ?? <Tag24 />,
              onClick: () => fileMaintenance.openRetagPreview({
                albumIds: albumSelection.selectedItems.map((album: any) => String(album.id)),
              }),
              disabled: albumSelection.selectedCount === 0 || fileMaintenance.busy,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24 />,
              onClick: () => void setSelectedAlbumMonitoring(true),
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24 />,
              onClick: () => void setSelectedAlbumMonitoring(false),
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "lock",
              label: "Lock",
              icon: <LockClosed24 />,
              onClick: () => void setSelectedAlbumLockState(true),
              disabled: albumSelection.selectedCount === 0,
            },
            {
              key: "unlock",
              label: "Unlock",
              icon: <LockOpen24 />,
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
              icon: <ArrowDownload24 />,
              onClick: queueSelectedTrackDownload,
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "rename",
              label: "Preview Rename",
              icon: (fileMaintenance.renameIcon as React.ReactElement) ?? <Rename24 />,
              onClick: () => {
                const albumIds = trackSelection.selectedItems
                  .map((track: any) => track.album_id ?? track.albumId)
                  .filter(Boolean)
                  .map(String);
                const artistIds = trackSelection.selectedItems
                  .map((track: any) => track.artist_id ?? track.artistId)
                  .filter(Boolean)
                  .map(String);
                fileMaintenance.openRenamePreview(albumIds.length > 0 ? { albumIds } : { artistIds });
              },
              disabled: trackSelection.selectedCount === 0 || fileMaintenance.busy,
            },
            {
              key: "retag",
              label: "Write Tags",
              icon: (fileMaintenance.retagIcon as React.ReactElement) ?? <Tag24 />,
              onClick: () => {
                const albumIds = trackSelection.selectedItems
                  .map((track: any) => track.album_id ?? track.albumId)
                  .filter(Boolean)
                  .map(String);
                const artistIds = trackSelection.selectedItems
                  .map((track: any) => track.artist_id ?? track.artistId)
                  .filter(Boolean)
                  .map(String);
                fileMaintenance.openRetagPreview(albumIds.length > 0 ? { albumIds } : { artistIds });
              },
              disabled: trackSelection.selectedCount === 0 || fileMaintenance.busy,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24 />,
              onClick: () => void setSelectedTrackMonitoring(true),
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24 />,
              onClick: () => void setSelectedTrackMonitoring(false),
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "lock",
              label: "Lock",
              icon: <LockClosed24 />,
              onClick: () => void setSelectedTrackLockState(true),
              disabled: trackSelection.selectedCount === 0,
            },
            {
              key: "unlock",
              label: "Unlock",
              icon: <LockOpen24 />,
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
              icon: <ArrowDownload24 />,
              onClick: queueSelectedVideoDownload,
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "rename",
              label: "Preview Rename",
              icon: (fileMaintenance.renameIcon as React.ReactElement) ?? <Rename24 />,
              onClick: () => {
                const albumIds = videoSelection.selectedItems
                  .map((video: any) => video.album_id ?? video.albumId)
                  .filter(Boolean)
                  .map(String);
                const artistIds = videoSelection.selectedItems
                  .map((video: any) => video.artist_id ?? video.artistId)
                  .filter(Boolean)
                  .map(String);
                fileMaintenance.openRenamePreview(albumIds.length > 0 ? { albumIds } : { artistIds });
              },
              disabled: videoSelection.selectedCount === 0 || fileMaintenance.busy,
            },
            {
              key: "retag",
              label: "Write Tags",
              icon: (fileMaintenance.retagIcon as React.ReactElement) ?? <Tag24 />,
              onClick: () => {
                const albumIds = videoSelection.selectedItems
                  .map((video: any) => video.album_id ?? video.albumId)
                  .filter(Boolean)
                  .map(String);
                const artistIds = videoSelection.selectedItems
                  .map((video: any) => video.artist_id ?? video.artistId)
                  .filter(Boolean)
                  .map(String);
                fileMaintenance.openRetagPreview(albumIds.length > 0 ? { albumIds } : { artistIds });
              },
              disabled: videoSelection.selectedCount === 0 || fileMaintenance.busy,
            },
            {
              key: "monitor",
              label: "Monitor",
              icon: <Eye24 />,
              onClick: () => void setSelectedVideoMonitoring(true),
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "unmonitor",
              label: "Unmonitor",
              icon: <EyeOff24 />,
              onClick: () => void setSelectedVideoMonitoring(false),
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "lock",
              label: "Lock",
              icon: <LockClosed24 />,
              onClick: () => void setSelectedVideoLockState(true),
              disabled: videoSelection.selectedCount === 0,
            },
            {
              key: "unlock",
              label: "Unlock",
              icon: <LockOpen24 />,
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
        <LibraryToolbar
          selectedTab={selectedTab}
          onSelectedTabChange={setSelectedTab}
          stats={stats}
          importProvider={importProvider}
          onOpenImport={() => setImportModalOpen(true)}
          isSelectionMode={isSelectionMode}
          onToggleSelectionMode={toggleSelectionMode}
          sortBy={sortBy}
          sortDirection={sortDirection}
          onSortByChange={setSortBy}
          onSortDirectionChange={setSortDirection}
          libraryFilter={libraryFilter}
          onLibraryFilterChange={setLibraryFilter}
          albumProviderFilter={albumProviderFilter}
          onAlbumProviderFilterChange={setAlbumProviderFilter}
          providerFilterOptions={providerFilterOptions}
          albumQualityTierFilter={albumQualityTierFilter}
          onAlbumQualityTierFilterChange={setAlbumQualityTierFilter}
          statusFilters={effectiveStatusFilters}
          onStatusFiltersChange={setStatusFilters}
          showDownloadFilter={showDownloadFilter}
          showLockFilter={showLockFilter}
          canToggleView={canToggleView}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
        {fileMaintenance.dialogs}

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
              <LibraryArtistsNoResults />
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
                    sharedColumns
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
                  showLocalQuality
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
                      const offer = downloadableVideoOffer(video);
                      if (!offer) return;
                      void addToQueue(null, "video", offer.providerId, {
                        payload: videoDownloadQueuePayload(video, offer),
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
                    sharedColumns
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
