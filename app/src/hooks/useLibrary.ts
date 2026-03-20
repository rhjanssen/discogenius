import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import type {
  AlbumContract as Album,
  ArtistContract as Artist,
  LibraryStatsContract as LibraryStats,
} from "@contracts/catalog";
import {
  LIBRARY_UPDATED_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";

export type { Album, Artist, LibraryStats };

type SortKey = 'name' | 'releaseDate' | 'popularity' | 'scannedAt';
type SortDir = 'asc' | 'desc';
type ActiveLibraryTab = 'artists' | 'albums' | 'tracks' | 'videos';

// Load persisted library settings from localStorage
const loadPersistedLibrarySettings = (): { sort: SortKey; dir: SortDir } | null => {
  try {
    const saved = localStorage.getItem('discogenius_library_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.sortBy && parsed.sortDirection) {
        return { sort: parsed.sortBy, dir: parsed.sortDirection };
      }
    }
  } catch (e) {
    console.warn('[useLibrary] Failed to load persisted settings:', e);
  }
  return null;
};

export const useLibrary = (options?: { activeTab?: ActiveLibraryTab }) => {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [artistsPage, setArtistsPage] = useState(0);
  const [hasMoreArtists, setHasMoreArtists] = useState(true);
  const [albumsPage, setAlbumsPage] = useState(0);
  const [hasMoreAlbums, setHasMoreAlbums] = useState(true);
  const [artistMonitoredFilter, setArtistMonitoredFilter] = useState<boolean | undefined>(undefined);
  const [albumMonitoredFilter, setAlbumMonitoredFilter] = useState<boolean | undefined>(undefined);
  const [albumDownloadedFilter, setAlbumDownloadedFilter] = useState<boolean | undefined>(undefined);
  const [albumLibraryFilter, setAlbumLibraryFilter] = useState<'all' | 'stereo' | 'atmos' | 'video'>('all');
  // Initialize sort from persisted settings or use defaults
  const [listSort, setListSort] = useState<{ sort: SortKey; dir: SortDir }>(() => {
    const persisted = loadPersistedLibrarySettings();
    return persisted ?? { sort: 'popularity', dir: 'desc' };
  });
  const [searchQuery, setSearchQuery] = useState<string>("");
  const { toast } = useToast();
  const activeTab = options?.activeTab ?? 'artists';

  // Prevent race conditions between overlapping fetch requests
  const artistFetchIdRef = useRef(0);
  const albumFetchIdRef = useRef(0);
  const libraryFetchIdRef = useRef(0);

  // Load stats first for quick counts
  const fetchStats = useCallback(async () => {
    try {
      const statsData = await api.getStats();
      setStats(statsData);
    } catch (error: any) {
      console.error('Error fetching stats:', error);
    }
  }, []);

  const fetchArtistsPage = useCallback(async (page: number = 0, append: boolean = false, monitored: boolean | undefined = artistMonitoredFilter) => {
    const fetchId = ++artistFetchIdRef.current;
    try {
      // keep the current filter unless explicitly overridden
      const monitoredFilter = monitored;
      if (monitored !== artistMonitoredFilter) {
        setArtistMonitoredFilter(monitoredFilter);
      }
      const data = await api.getArtists({
        limit: 50,
        offset: page * 50,
        monitored: monitoredFilter,
        sort: listSort.sort,
        dir: listSort.dir,
        search: searchQuery,
        includeDownloadStats: false,
      });

      if (fetchId !== artistFetchIdRef.current) return;

      if (append) {
        setArtists(prev => [...prev, ...data.items]);
      } else {
        setArtists(data.items);
      }

      setHasMoreArtists(data.hasMore);
      setArtistsPage(page);
    } catch (error: any) {
      console.error('Error fetching artists:', error);
      toast({
        title: "Failed to load artists",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast, artistMonitoredFilter, listSort, searchQuery]);

  const fetchAlbumsPage = useCallback(async (page: number = 0, append: boolean = false) => {
    const fetchId = ++albumFetchIdRef.current;
    try {
      const data = await api.getAlbums({
        limit: 50,
        offset: page * 50,
        monitored: albumMonitoredFilter,
        downloaded: albumDownloadedFilter,
        library_filter: albumLibraryFilter === 'video' ? 'all' : albumLibraryFilter,
        sort: listSort.sort,
        dir: listSort.dir,
        search: searchQuery,
      });

      if (fetchId !== albumFetchIdRef.current) return;

      if (append) {
        setAlbums(prev => [...prev, ...data.items]);
      } else {
        setAlbums(data.items);
      }

      setHasMoreAlbums(data.hasMore);
      setAlbumsPage(page);
    } catch (error: any) {
      console.error('Error fetching albums:', error);
      toast({
        title: "Failed to load albums",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast, albumMonitoredFilter, albumDownloadedFilter, albumLibraryFilter, listSort, searchQuery]);

  const fetchLibrary = useCallback(async (
    monitored: boolean | undefined = artistMonitoredFilter,
    opts?: { refreshStats?: boolean; tab?: ActiveLibraryTab }
  ) => {
    const tab = opts?.tab ?? activeTab;
    const refreshStats = opts?.refreshStats ?? false;
    const shouldManageLoading = tab === 'artists' || tab === 'albums';
    const fetchId = shouldManageLoading ? ++libraryFetchIdRef.current : libraryFetchIdRef.current;

    try {
      if (shouldManageLoading) {
        setLoading(true);
      }

      if (refreshStats) {
        await fetchStats();
      }

      if (tab === 'artists') {
        await fetchArtistsPage(0, false, monitored);
      } else if (tab === 'albums') {
        await fetchAlbumsPage(0, false);
      }
    } catch (error: any) {
      console.error('Error fetching library:', error);
      toast({
        title: "Failed to load library",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      if (shouldManageLoading && fetchId === libraryFetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [activeTab, fetchStats, fetchArtistsPage, fetchAlbumsPage, toast, artistMonitoredFilter]);

  const loadMoreArtists = useCallback(async () => {
    if (!hasMoreArtists) return;
    await fetchArtistsPage(artistsPage + 1, true, artistMonitoredFilter);
  }, [artistsPage, hasMoreArtists, fetchArtistsPage, artistMonitoredFilter]);

  const loadMoreAlbums = useCallback(async () => {
    if (!hasMoreAlbums) return;
    await fetchAlbumsPage(albumsPage + 1, true);
  }, [albumsPage, hasMoreAlbums, fetchAlbumsPage]);

  const addArtist = useCallback(async (artist: Artist) => {
    try {
      await api.addArtist(artist.id);

      // Optimistically add to UI
      setArtists(prev => [artist, ...prev]);

      // Refresh stats
      await fetchStats();

      toast({
        title: "Artist added",
        description: `${artist.name} has been added to your library`,
      });
    } catch (error: any) {
      console.error('Error adding artist:', error);
      toast({
        title: "Failed to add artist",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast, fetchStats]);

  const deleteArtist = useCallback(async (tidalId: string) => {
    try {
      await api.deleteArtist(tidalId);

      // Optimistically remove from UI
      setArtists(prev => prev.filter(a => a.id !== tidalId));

      // Refresh stats
      await fetchStats();

      toast({
        title: "Artist removed",
        description: "Artist has been removed from your library",
      });
    } catch (error: any) {
      console.error('Error deleting artist:', error);
      toast({
        title: "Failed to remove artist",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast, fetchStats]);

  const updateArtist = useCallback(async (tidalId: string, data: { is_monitored?: boolean }) => {
    try {
      await api.updateArtist(tidalId, data);

      // Optimistically update in UI
      setArtists(prev => prev.map(a =>
        a.id === tidalId ? { ...a, ...data } : a
      ));

      // Refresh stats
      await fetchStats();

      toast({
        title: "Artist updated",
        description: "Artist monitoring status has been updated",
      });
    } catch (error: any) {
      console.error('Error updating artist:', error);
      toast({
        title: "Failed to update artist",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast, fetchStats]);

  const syncArtist = useCallback(async (artistId: string) => {
    try {
      const data: any = await api.scanArtist(artistId, { forceUpdate: false });

      toast({
        title: "Refresh & scan queued",
        description: data.message || `Artist refresh & scan queued`,
      });
    } catch (error: any) {
      console.error('Sync error:', error);
      toast({
        title: "Refresh & scan failed",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast]);

  const toggleArtistMonitored = useCallback(async (artistId: string, monitored: boolean) => {
    try {
      setArtists((prev) => prev.map((artist) => (
        artist.id === artistId
          ? { ...artist, is_monitored: monitored }
          : artist
      )));

      await api.toggleArtistMonitored(artistId, monitored);

      toast({
        title: monitored ? "Monitoring enabled" : "Monitoring disabled",
        description: monitored ? "Will check for new releases" : "Will no longer check for new releases",
      });

      dispatchMonitorStateChanged({ type: 'artist', tidalId: artistId, monitored });
      dispatchLibraryUpdated();
    } catch (error: any) {
      setArtists((prev) => prev.map((artist) => (
        artist.id === artistId
          ? { ...artist, is_monitored: !monitored }
          : artist
      )));
      console.error('Toggle monitored error:', error);
      toast({
        title: "Failed to update monitoring",
        description: error.message,
        variant: "destructive",
      });
    }
  }, [toast]);

  const setArtistFilter = useCallback((monitored: boolean | undefined) => {
    setArtistMonitoredFilter(monitored);
  }, []);

  const setAlbumFilter = useCallback((monitored: boolean | undefined) => {
    setAlbumMonitoredFilter(monitored);
  }, []);

  const setAlbumDownloadFilter = useCallback((downloaded: boolean | undefined) => {
    setAlbumDownloadedFilter(downloaded);
  }, []);

  const setAlbumQualityFilter = useCallback((filter: 'all' | 'stereo' | 'atmos' | 'video') => {
    setAlbumLibraryFilter(filter);
  }, []);

  const setSortOptions = useCallback((sort: SortKey, dir: SortDir) => {
    setListSort({ sort, dir });
  }, []);

  // Fetch shared stats once up front. Tab data is fetched separately and lazily.
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (activeTab !== 'artists' && activeTab !== 'albums') {
      setLoading(false);
    }
  }, [activeTab]);

  // Use ref to break the circular dependency that causes infinite re-fetching
  const fetchLibraryRef = useRef(fetchLibrary);
  fetchLibraryRef.current = fetchLibrary;
  const artistMonitoredFilterRef = useRef(artistMonitoredFilter);
  artistMonitoredFilterRef.current = artistMonitoredFilter;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Fetch artist data only when the active artist view changes.
  useEffect(() => {
    if (activeTab !== 'artists') {
      return;
    }

    fetchLibraryRef.current(artistMonitoredFilter, { tab: 'artists', refreshStats: false });
  }, [activeTab, artistMonitoredFilter, listSort, searchQuery]);

  // Fetch album data only when the active album view changes.
  useEffect(() => {
    if (activeTab !== 'albums') {
      return;
    }

    fetchLibraryRef.current(undefined, { tab: 'albums', refreshStats: false });
  }, [activeTab, albumMonitoredFilter, albumDownloadedFilter, albumLibraryFilter, listSort, searchQuery]);

  // Listen for library update events
  useEffect(() => {
    const handleLibraryUpdate = () => {
      fetchStats();
      fetchLibraryRef.current(artistMonitoredFilterRef.current, {
        tab: activeTabRef.current,
        refreshStats: false,
      });
    };

    const handleMonitorStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail) return;

      if (detail.type === 'artist') {
        setArtists((prev) => prev.map((artist) => (
          artist.id === detail.tidalId
            ? { ...artist, is_monitored: detail.monitored }
            : artist
        )));
      }

      if (detail.type === 'album') {
        setAlbums((prev) => prev.map((album) => (
          album.id === detail.tidalId
            ? { ...album, is_monitored: detail.monitored }
            : album
        )));
      }

      // Keep counters accurate after optimistic updates.
      fetchStats();
    };

    window.addEventListener(LIBRARY_UPDATED_EVENT, handleLibraryUpdate);
    window.addEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorStateChanged as EventListener);

    return () => {
      window.removeEventListener(LIBRARY_UPDATED_EVENT, handleLibraryUpdate);
      window.removeEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorStateChanged as EventListener);
    };
  }, [fetchStats]);

  return {
    artists,
    albums,
    loading,
    stats,
    sort: listSort,
    hasMoreArtists,
    hasMoreAlbums,
    loadMoreArtists,
    loadMoreAlbums,
    fetchLibrary,
    setArtistFilter,
    setAlbumFilter,
    setAlbumDownloadFilter,
    setAlbumQualityFilter,
    setSortOptions,
    setSearchQuery,
    syncArtist,
    toggleArtistMonitored,
    addArtist,
    deleteArtist,
    updateArtist,
  };
};
