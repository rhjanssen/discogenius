import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useArtists, type Artist } from "@/hooks/useArtists";
import { useAlbums, type Album } from "@/hooks/useAlbums";
import type { LibraryStatsContract as LibraryStats } from "@contracts/catalog";
import { LIBRARY_UPDATED_EVENT } from "@/utils/appEvents";
import { defaultStatusFilters, type StatusFilters } from "@/utils/statusFilters";

export type { Album, Artist, LibraryStats };

type SortKey = "name" | "releaseDate" | "popularity" | "scannedAt";
type SortDir = "asc" | "desc";
type ActiveLibraryTab = "artists" | "albums" | "tracks" | "videos";
type LibraryFilter = "all" | "stereo" | "spatial" | "video";
type PersistedLibrarySettings = {
  settingsVersion?: number;
  statusFilters?: Partial<StatusFilters>;
  libraryFilter?: LibraryFilter;
  sortBy?: SortKey;
  sortDirection?: SortDir;
};

// Shared so the Dashboard reuses the same cached /api/v1/stats result instead of
// fetching the identical snapshot under its own key.
export const LIBRARY_STATS_QUERY_KEY = ["libraryStats"] as const;
const LIBRARY_STATS_GLOBAL_EVENTS = [
  "artist.scanned",
  "artist.refresh.complete",
  "config.updated",
  "library.updated",
  "file.added",
  "file.deleted",
  "file.upgraded",
] as const;

const LIBRARY_SETTINGS_STORAGE_KEY = "discogenius_library_settings";
const LIBRARY_SETTINGS_VERSION = 2;

const coerceBooleanFilter = (
  filters: Partial<StatusFilters> | undefined,
  enabledKey: keyof StatusFilters,
  disabledKey: keyof StatusFilters,
): boolean | undefined => {
  const enabled = Boolean(filters?.[enabledKey]);
  const disabled = Boolean(filters?.[disabledKey]);
  if (enabled && !disabled) return true;
  if (!enabled && disabled) return false;
  return undefined;
};

const normalizePersistedLibrarySettings = (value: unknown): PersistedLibrarySettings | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = value as PersistedLibrarySettings;
  if (parsed.settingsVersion !== LIBRARY_SETTINGS_VERSION) {
    return null;
  }

  return parsed;
};

const loadPersistedLibrarySettings = (): PersistedLibrarySettings | null => {
  try {
    const saved = localStorage.getItem(LIBRARY_SETTINGS_STORAGE_KEY);
    if (saved) {
      return normalizePersistedLibrarySettings(JSON.parse(saved));
    }
  } catch (e) {
    console.warn("[useLibrary] Failed to load persisted settings:", e);
  }
  return null;
};

const getInitialLibrarySettings = () => {
  const persisted = loadPersistedLibrarySettings();
  const statusFilters = {
    ...defaultStatusFilters,
    ...(persisted?.statusFilters ?? {}),
  };
  const libraryFilter = persisted?.libraryFilter ?? "all";

  return {
    artistMonitoredFilter: coerceBooleanFilter(statusFilters, "onlyMonitored", "onlyUnmonitored"),
    albumMonitoredFilter: coerceBooleanFilter(statusFilters, "onlyMonitored", "onlyUnmonitored"),
    albumDownloadedFilter: coerceBooleanFilter(statusFilters, "onlyDownloaded", "onlyNotDownloaded"),
    albumLockedFilter: coerceBooleanFilter(statusFilters, "onlyLocked", "onlyUnlocked"),
    albumLibraryFilter: libraryFilter,
    sort: persisted?.sortBy && persisted?.sortDirection
      ? { sort: persisted.sortBy, dir: persisted.sortDirection }
      : { sort: "popularity" as SortKey, dir: "desc" as SortDir },
  };
};

export const useLibrary = (options?: { activeTab?: ActiveLibraryTab }) => {
  const initialSettingsRef = useRef<ReturnType<typeof getInitialLibrarySettings> | null>(null);
  if (initialSettingsRef.current === null) {
    initialSettingsRef.current = getInitialLibrarySettings();
  }
  const initialSettings = initialSettingsRef.current;
  const [artistMonitoredFilter, setArtistMonitoredFilter] = useState<boolean | undefined>(initialSettings.artistMonitoredFilter);
  const [albumMonitoredFilter, setAlbumMonitoredFilter] = useState<boolean | undefined>(initialSettings.albumMonitoredFilter);
  const [albumDownloadedFilter, setAlbumDownloadedFilter] = useState<boolean | undefined>(initialSettings.albumDownloadedFilter);
  const [albumLockedFilter, setAlbumLockedFilter] = useState<boolean | undefined>(initialSettings.albumLockedFilter);
  const [albumLibraryFilter, setAlbumLibraryFilter] = useState<LibraryFilter>(initialSettings.albumLibraryFilter);
  const [albumProviderFilter, setAlbumProviderFilter] = useState<string | undefined>(undefined);
  const [albumQualityTierFilter, setAlbumQualityTierFilter] = useState<string | undefined>(undefined);
  const [listSort, setListSort] = useState<{ sort: SortKey; dir: SortDir }>(initialSettings.sort);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const activeTab = options?.activeTab ?? "artists";
  const { toast } = useToast();
  const lastStatsErrorMessageRef = useRef<string | null>(null);

  const artistsQuery = useArtists({
    monitored: artistMonitoredFilter,
    sort: listSort.sort,
    dir: listSort.dir,
    search: searchQuery,
    includeDownloadStats: false,
    enabled: activeTab === "artists",
  });

  const albumsQuery = useAlbums({
    monitored: albumMonitoredFilter,
    downloaded: albumDownloadedFilter,
    locked: albumLockedFilter,
    libraryFilter: albumLibraryFilter,
    provider: albumProviderFilter,
    qualityTier: albumQualityTierFilter,
    sort: listSort.sort,
    dir: listSort.dir,
    search: searchQuery,
    enabled: activeTab === "albums",
  });

  useDebouncedQueryInvalidation({
    queryKeys: [LIBRARY_STATS_QUERY_KEY],
    globalEvents: [...LIBRARY_STATS_GLOBAL_EVENTS],
    windowEvents: [LIBRARY_UPDATED_EVENT],
    debounceMs: 400,
  });

  const statsQuery = useQuery<LibraryStats>({
    queryKey: LIBRARY_STATS_QUERY_KEY,
    queryFn: ({ signal }) => api.getStats({
      signal,
      timeoutMs: 8_000,
    }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  useEffect(() => {
    if (!statsQuery.isError || statsQuery.data) {
      lastStatsErrorMessageRef.current = null;
      return;
    }

    const message = statsQuery.error instanceof Error
      ? statsQuery.error.message
      : "Could not load library stats";
    if (message === lastStatsErrorMessageRef.current) {
      return;
    }

    lastStatsErrorMessageRef.current = message;
    toast({
      title: "Failed to load library stats",
      description: message,
      variant: "destructive",
    });
  }, [statsQuery.data, statsQuery.error, statsQuery.isError, toast]);

  const fetchLibrary = useCallback(async (
    monitored?: boolean,
    opts?: { refreshStats?: boolean; tab?: ActiveLibraryTab },
  ) => {
    const tab = opts?.tab ?? activeTab;
    const refreshStats = opts?.refreshStats ?? false;

    if (tab === "artists" && monitored !== undefined && monitored !== artistMonitoredFilter) {
      setArtistMonitoredFilter(monitored);
    }

    const tasks: Array<Promise<unknown>> = [];
    if (refreshStats) {
      tasks.push(statsQuery.refetch());
    }
    if (tab === "artists") {
      tasks.push(artistsQuery.refetch());
    } else if (tab === "albums") {
      tasks.push(albumsQuery.refetch());
    }

    await Promise.all(tasks);
  }, [
    activeTab,
    albumsQuery,
    artistMonitoredFilter,
    artistsQuery,
    statsQuery,
  ]);

  const safeFetchLibrary = useCallback(async (
    monitored?: boolean,
    opts?: { refreshStats?: boolean; tab?: ActiveLibraryTab },
  ) => {
    try {
      await fetchLibrary(monitored, opts);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load library";
      toast({
        title: "Failed to load library",
        description: message,
        variant: "destructive",
      });
    }
  }, [fetchLibrary, toast]);

  const setSortOptions = useCallback((sort: SortKey, dir: SortDir) => {
    setListSort({ sort, dir });
  }, []);

  const syncArtist = useCallback(async (artistId: string) => {
    try {
      const data: any = await api.scanArtist(artistId, { forceUpdate: false });

      toast({
        title: "Refresh & scan queued",
        description: data.message || "Artist refresh & scan queued",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not queue artist refresh";
      toast({
        title: "Refresh & scan failed",
        description: message,
        variant: "destructive",
      });
    }
  }, [toast]);

  const addArtist = useCallback(async (artist: Artist) => {
    try {
      await api.addArtist(artist.id);
      await Promise.all([artistsQuery.refetch(), statsQuery.refetch()]);

      toast({
        title: "Artist added",
        description: `${artist.name} has been added to your library`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add artist";
      toast({
        title: "Failed to add artist",
        description: message,
        variant: "destructive",
      });
    }
  }, [artistsQuery, statsQuery, toast]);

  const deleteArtist = useCallback(async (providerId: string, options?: { deleteFiles?: boolean }) => {
    try {
      await api.deleteArtist(providerId, options);
      await Promise.all([artistsQuery.refetch(), statsQuery.refetch()]);

      toast({
        title: "Artist removed",
        description: options?.deleteFiles
          ? "Artist and imported files have been removed from your library"
          : "Artist has been removed from your library",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not remove artist";
      toast({
        title: "Failed to remove artist",
        description: message,
        variant: "destructive",
      });
    }
  }, [artistsQuery, statsQuery, toast]);

  const updateArtist = useCallback(async (providerId: string, data: { is_monitored?: boolean }) => {
    try {
      await api.updateArtist(providerId, data);
      await Promise.all([artistsQuery.refetch(), statsQuery.refetch()]);

      toast({
        title: "Artist updated",
        description: "Artist monitoring status has been updated",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update artist";
      toast({
        title: "Failed to update artist",
        description: message,
        variant: "destructive",
      });
    }
  }, [artistsQuery, statsQuery, toast]);

  return {
    artists: artistsQuery.artists,
    albums: albumsQuery.albums,
    loading: activeTab === "artists" ? artistsQuery.loading : activeTab === "albums" ? albumsQuery.loading : false,
    stats: statsQuery.data ?? null,
    artistsIsPopulated: artistsQuery.isPopulated,
    albumsIsPopulated: albumsQuery.isPopulated,
    sort: listSort,
    hasMoreArtists: artistsQuery.hasMore,
    hasMoreAlbums: albumsQuery.hasMore,
    artistsFetchingMore: artistsQuery.isFetchingMore,
    albumsFetchingMore: albumsQuery.isFetchingMore,
    loadMoreArtists: artistsQuery.loadMore,
    loadMoreAlbums: albumsQuery.loadMore,
    refetchArtists: () => artistsQuery.refetch(),
    refetchAlbums: () => albumsQuery.refetch(),
    fetchLibrary: safeFetchLibrary,
    setArtistFilter: setArtistMonitoredFilter,
    setAlbumFilter: setAlbumMonitoredFilter,
    setAlbumDownloadFilter: setAlbumDownloadedFilter,
    setAlbumLockFilter: setAlbumLockedFilter,
    setAlbumQualityFilter: setAlbumLibraryFilter,
    albumProviderFilter,
    setAlbumProviderFilter,
    albumQualityTierFilter,
    setAlbumQualityTierFilter,
    setSortOptions,
    setSearchQuery,
    syncArtist,
    toggleArtistMonitored: artistsQuery.toggleMonitor,
    artistsHasRefreshError: artistsQuery.hasRefreshError,
    artistsRefreshErrorMessage: artistsQuery.refreshErrorMessage,
    albumsHasRefreshError: albumsQuery.hasRefreshError,
    albumsRefreshErrorMessage: albumsQuery.refreshErrorMessage,
    addArtist,
    deleteArtist,
    updateArtist,
  };
};
