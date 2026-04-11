import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useArtists, type Artist } from "@/hooks/useArtists";
import { useAlbums, type Album } from "@/hooks/useAlbums";
import type { LibraryStatsContract as LibraryStats } from "@contracts/catalog";
import { LIBRARY_UPDATED_EVENT } from "@/utils/appEvents";

export type { Album, Artist, LibraryStats };

type SortKey = "name" | "releaseDate" | "popularity" | "scannedAt";
type SortDir = "asc" | "desc";
type ActiveLibraryTab = "artists" | "albums" | "tracks" | "videos";

const LIBRARY_STATS_QUERY_KEY = ["libraryStats"] as const;
const LIBRARY_STATS_GLOBAL_EVENTS = [
  "artist.scanned",
  "album.scanned",
  "rescan.completed",
  "config.updated",
  "file.added",
  "file.deleted",
  "file.upgraded",
] as const;

const loadPersistedLibrarySettings = (): { sort: SortKey; dir: SortDir } | null => {
  try {
    const saved = localStorage.getItem("discogenius_library_settings");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.sortBy && parsed.sortDirection) {
        return { sort: parsed.sortBy, dir: parsed.sortDirection };
      }
    }
  } catch (e) {
    console.warn("[useLibrary] Failed to load persisted settings:", e);
  }
  return null;
};

export const useLibrary = (options?: { activeTab?: ActiveLibraryTab }) => {
  const [artistMonitoredFilter, setArtistMonitoredFilter] = useState<boolean | undefined>(undefined);
  const [albumMonitoredFilter, setAlbumMonitoredFilter] = useState<boolean | undefined>(undefined);
  const [albumDownloadedFilter, setAlbumDownloadedFilter] = useState<boolean | undefined>(undefined);
  const [albumLockedFilter, setAlbumLockedFilter] = useState<boolean | undefined>(undefined);
  const [albumLibraryFilter, setAlbumLibraryFilter] = useState<"all" | "stereo" | "atmos" | "video">("all");
  const [listSort, setListSort] = useState<{ sort: SortKey; dir: SortDir }>(() => {
    const persisted = loadPersistedLibrarySettings();
    return persisted ?? { sort: "popularity", dir: "desc" };
  });
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
    queryFn: () => api.getStats(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  useEffect(() => {
    if (!statsQuery.isError) {
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
  }, [statsQuery.error, statsQuery.isError, toast]);

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

  const deleteArtist = useCallback(async (tidalId: string) => {
    try {
      await api.deleteArtist(tidalId);
      await Promise.all([artistsQuery.refetch(), statsQuery.refetch()]);

      toast({
        title: "Artist removed",
        description: "Artist has been removed from your library",
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

  const updateArtist = useCallback(async (tidalId: string, data: { is_monitored?: boolean }) => {
    try {
      await api.updateArtist(tidalId, data);
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
    sort: listSort,
    hasMoreArtists: artistsQuery.hasMore,
    hasMoreAlbums: albumsQuery.hasMore,
    loadMoreArtists: artistsQuery.loadMore,
    loadMoreAlbums: albumsQuery.loadMore,
    fetchLibrary: safeFetchLibrary,
    setArtistFilter: setArtistMonitoredFilter,
    setAlbumFilter: setAlbumMonitoredFilter,
    setAlbumDownloadFilter: setAlbumDownloadedFilter,
    setAlbumLockFilter: setAlbumLockedFilter,
    setAlbumQualityFilter: setAlbumLibraryFilter,
    setSortOptions,
    setSearchQuery,
    syncArtist,
    toggleArtistMonitored: artistsQuery.toggleMonitor,
    addArtist,
    deleteArtist,
    updateArtist,
  };
};
