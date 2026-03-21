import {
  TabList,
  Tab,
  Button,
  Badge,
  Spinner,
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
  ArrowSync16Regular,
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
} from "@fluentui/react-icons";
import { EmptyState } from "@/components/ui/ContentState";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { WarningBadge } from "@/components/ui/WarningBadge";
import { useResponsiveTabsStyles } from "@/components/ui/useResponsiveTabsStyles";
import { MediaCard } from "@/components/cards/MediaCard";
import { useCardStyles } from "@/components/cards/cardStyles";
import { QueueContext } from "@/providers/QueueProvider";
import FilterMenu from "@/components/FilterMenu";
import { StatusFilters, defaultStatusFilters } from "@/utils/statusFilters";
import TrackList from "@/components/TrackList";
import VideoGrid from "@/components/VideoGrid";
import { useLibrary } from "@/hooks/useLibrary";
import { useTidalSearch } from "@/hooks/useTidalSearch";
import { useTracks } from "@/hooks/useTracks";
import { useVideos } from "@/hooks/useVideos";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import { useToast } from "@/hooks/useToast";
import { DataGrid, useDataGridCellStyles } from "@/components/DataGrid";
import type { DataGridColumn } from "@/components/DataGrid";
import React, { useState, useEffect, useCallback, useMemo, useRef, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";
import { api } from "@/services/api";
import { getArtistPicture, getAlbumCover, getTidalImage } from "@/utils/tidalImages";
import {
  dispatchActivityRefresh,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
} from "@/utils/appEvents";
import { tidalUrl } from "@/utils/tidalUrl";
import { formatDurationSeconds } from "@/utils/format";
import { LoadingState } from "@/components/ui/LoadingState";

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
    gap: tokens.spacingVerticalL,
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
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: tokens.spacingHorizontalXS,
    width: "100%",
    boxSizing: "border-box",
    "@media (min-width: 480px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
      gap: tokens.spacingHorizontalS,
    },
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(172px, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))",
      gap: tokens.spacingHorizontalL,
    },
  },
  tabContent: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    gap: tokens.spacingVerticalM,
  },
  scrollContainer: {
    overflow: "auto",
    flexGrow: 1,
  },
  loadMoreSpinner: {
    display: "flex",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
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
    gap: tokens.spacingVerticalL,
    height: "100%",
  },
  tabPanel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    gap: tokens.spacingVerticalM,
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
    padding: tokens.spacingVerticalL,
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
    setArtistFilter,
    setAlbumFilter,
    setAlbumDownloadFilter,
    setAlbumQualityFilter,
    setSortOptions,
    setSearchQuery,
  } = useLibrary({ activeTab: selectedTab as 'artists' | 'albums' | 'tracks' | 'videos' });
  const { importFollowedArtists } = useTidalSearch();
  const { addToQueue, queue } = useDownloadQueue();
  const [importing, setImporting] = useState(false);
  const queueCtx = useContext(QueueContext);
  const progressMap = queueCtx?.progress;
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

  const [isFetchingMoreArtists, setIsFetchingMoreArtists] = useState(false);
  const [isFetchingMoreAlbums, setIsFetchingMoreAlbums] = useState(false);
  const [isFetchingMoreTracks, setIsFetchingMoreTracks] = useState(false);
  const [isFetchingMoreVideos, setIsFetchingMoreVideos] = useState(false);

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

  const { tracks, loading: tracksLoading, hasMore: hasMoreTracks, total: totalTracks, loadMore: loadMoreTracks } = useTracks({
    monitored: monitoredFilter,
    downloaded: downloadedFilter,
    libraryFilter,
    sort: sortBy,
    dir: sortDirection,
    search: debouncedSearchQuery,
    enabled: selectedTab === 'tracks',
  });
  const {
    videos,
    loading: videosLoading,
    hasMore: hasMoreVideos,
    total: totalVideos,
    loadMore: loadMoreVideos,
    toggleMonitor: toggleVideoMonitor,
  } = useVideos({
    monitored: monitoredFilter,
    downloaded: downloadedFilter,
    sort: sortBy,
    dir: sortDirection,
    search: debouncedSearchQuery,
    enabled: selectedTab === 'videos',
  });

  // Keep server-side filters/sort in sync (prevents client-side resorting during pagination)
  useEffect(() => {
    setArtistFilter(monitoredFilter);
    setAlbumFilter(monitoredFilter);
    setAlbumDownloadFilter(downloadedFilter);
  }, [monitoredFilter, downloadedFilter, setArtistFilter, setAlbumFilter, setAlbumDownloadFilter]);

  useEffect(() => {
    setAlbumQualityFilter(libraryFilter);
  }, [libraryFilter, setAlbumQualityFilter]);

  useEffect(() => {
    setSortOptions(sortBy, sortDirection);
  }, [sortBy, sortDirection, setSortOptions]);


  const filteredArtists = artists;
  const filteredAlbums = albums;
  const filteredTracks = tracks;
  const filteredVideos = videos;

  // Helper to check if album is in queue or downloaded
  const getAlbumDownloadStatus = (album: any) => {
    const albumUrl = tidalUrl('album', album.id);
    const inQueue = queue.find(item => item.url === albumUrl);

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
    const itemProgress = progressMap?.get(Number(artist.id));
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

  const renderNotScannedBadge = useCallback(() => (
    <WarningBadge icon={<ArrowSync16Regular />}>
      Not Scanned
    </WarningBadge>
  ), []);

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
        <div className={dgCell.actions}>
          <Button appearance="subtle" size="small" icon={<ArrowSync24Regular />}
            onClick={(e) => handleArtistScan(e, artist)}
            title={artist.last_scanned ? "Refresh & scan" : "Refresh & scan"} />
          <Button appearance="subtle" size="small" icon={<ArrowSortDownLines24Regular />}
            onClick={(e) => handleArtistCurate(e, artist)}
            title="Search missing" />
          <Button appearance="subtle" size="small" icon={<ArrowDownload24Regular />}
            onClick={(e) => handleArtistDownload(e, artist)}
            title="Download monitored" />
          <Button appearance="subtle" size="small"
            icon={artist.is_monitored ? <EyeOff24Regular /> : <Eye24Regular />}
            onClick={(e) => { e.stopPropagation(); toggleArtistMonitored(artist.id, !artist.is_monitored); }}
            title={artist.is_monitored ? "Unmonitor" : "Monitor"} />
        </div>
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

  // Render a single album card
  const renderAlbumCard = (album: any) => {
    const year = album.release_date ? album.release_date.split('-')[0] : '';
    const subtitle = [album.artist_name, year].filter(Boolean).join(' · ');
    const isLocked = Boolean(album.monitor_locked ?? album.monitor_lock);
    const imageUrl = getAlbumCover(album.cover_id, 'small') || album.cover_art_url || null;
    const itemProgress = progressMap?.get(Number(album.id));
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
      width: "80px",
      align: "right",
      render: (album: any) => {
        const isLocked = Boolean(album.monitor_locked ?? album.monitor_lock);
        return (
          <div className={dgCell.actions}>
            <Button appearance="subtle" size="small" icon={<ArrowDownload24Regular />}
              onClick={(e) => handleDownloadAlbumRow(e, album)}
              title='Download album' />
            <Button appearance="subtle" size="small"
              icon={album.is_monitored ? <EyeOff24Regular /> : <Eye24Regular />}
              onClick={(e) => handleToggleAlbumMonitored(e, album)}
              title={isLocked ? 'Monitoring is locked' : (album.is_monitored ? "Unmonitor" : "Monitor")}
              disabled={isLocked} />
          </div>
        );
      },
    },
  ], [dgCell, handleDownloadAlbumRow, handleToggleAlbumMonitored]);

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
      render: (video: any) => video.is_downloaded
        ? <Badge appearance="filled" color="success" size="small">Downloaded</Badge>
        : <Badge appearance="outline" size="small">Missing</Badge>,
    },
    {
      key: "actions",
      header: "",
      width: "60px",
      align: "right",
      render: (video: any) => (
        <div className={dgCell.actions}>
          <Button appearance="subtle" size="small"
            icon={video.is_monitored ? <EyeOff24Regular /> : <Eye24Regular />}
            onClick={(e) => { e.stopPropagation(); toggleVideoMonitor(video.id, !video.is_monitored); }}
            title={video.is_monitored ? "Unmonitor" : "Monitor"} />
        </div>
      ),
    },
  ], [dgCell, styles.compactIcon, toggleVideoMonitor]);

  // Empty state - only show when not loading and truly no artists exist
  if (!loading && artists.length === 0 && stats?.artists?.total === 0) {
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
  const renderLoadingContent = () => (
    <LoadingState className={styles.loadMoreSpinner} label="Loading..." />
  );

  const renderNoResultsContent = (mediaLabel: "artists" | "albums" | "tracks" | "videos") => (
    <EmptyState
      title={`No ${mediaLabel} found`}
      description={`No ${mediaLabel} match your current filters or search.`}
      icon={<Search24Regular />}
      minHeight="220px"
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

  const renderPane = ({
    scrollRef,
    sentinelRef,
    isFetching,
    children,
  }: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    sentinelRef: React.RefObject<HTMLDivElement | null>;
    isFetching: boolean;
    children: React.ReactNode;
  }) => (
    <div className={styles.tabPanel}>
      <div ref={scrollRef} className={mergeClasses(styles.tabScroller, styles.contentPadding)}>
        {children}
        <div ref={sentinelRef} className={styles.sentinel} />
        {isFetching && <div className={styles.fetchMoreRow}><Spinner size="small" /></div>}
      </div>
    </div>
  );

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
                showDownloadFilter={true}
                showLockFilter={true}
                className={styles.menuButtonIconOnly}
                hideLabelOnMobile
              />

              {/* View Mode Toggle */}
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
                showDownloadFilter={true}
                showLockFilter={true}
                className={styles.menuButtonIconOnly}
                hideLabelOnMobile
              />

              {/* View Mode Toggle */}
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
            {loading ? renderLoadingContent() : filteredArtists.length === 0 ? (
              renderNoResultsContent("artists")
            ) : (
              renderPane({
                scrollRef: artistScrollRef,
                sentinelRef: artistSentinelRef,
                isFetching: isFetchingMore.artists,
                children: viewMode === 'grid' ? (
                  <div className={styles.grid}>
                    {filteredArtists.map((artist) => renderArtistCard(artist))}
                  </div>
                ) : (
                  <DataGrid
                    columns={artistColumns}
                    items={filteredArtists}
                    getRowKey={(a: any) => a.id}
                    onRowClick={(a: any) => navigate(`/artist/${a.id}`)}
                  />
                ),
              })
            )}
          </div>
        )}

        {selectedTab === "albums" && (
          <div className={styles.virtuosoContainer}>
            {loading ? renderLoadingContent() : filteredAlbums.length === 0 ? (
              renderNoResultsContent("albums")
            ) : (
              renderPane({
                scrollRef: albumScrollRef,
                sentinelRef: albumSentinelRef,
                isFetching: isFetchingMore.albums,
                children: viewMode === 'grid' ? (
                  <div className={styles.grid}>
                    {filteredAlbums.map((album) => renderAlbumCard(album))}
                  </div>
                ) : (
                  <DataGrid
                    columns={albumColumns}
                    items={filteredAlbums}
                    getRowKey={(a: any) => a.id}
                    onRowClick={(a: any) => navigate(`/album/${a.id}`)}
                  />
                ),
              })
            )}
          </div>
        )}

        {selectedTab === "tracks" && (
          <div className={styles.virtuosoContainer}>
            {tracksLoading ? renderLoadingContent() : filteredTracks.length === 0 ? (
              renderNoResultsContent("tracks")
            ) : (
              renderPane({
                scrollRef: trackScrollRef,
                sentinelRef: trackSentinelRef,
                isFetching: isFetchingMore.tracks,
                children: <TrackList tracks={filteredTracks} />,
              })
            )}
          </div>
        )}

        {selectedTab === "videos" && (
          <div className={styles.virtuosoContainer}>
            {videosLoading ? renderLoadingContent() : filteredVideos.length === 0 ? (
              renderNoResultsContent("videos")
            ) : (
              renderPane({
                scrollRef: videoScrollRef,
                sentinelRef: videoSentinelRef,
                isFetching: isFetchingMore.videos,
                children: viewMode === 'grid' ? (
                  <VideoGrid
                    videos={filteredVideos}
                    loading={videosLoading}
                    onToggleMonitor={(video) => toggleVideoMonitor(video.id, !video.is_monitored)}
                    onOpenVideo={(video) => navigate(`/video/${video.id}`)}
                  />
                ) : (
                  <DataGrid
                    columns={videoColumns}
                    items={filteredVideos}
                    getRowKey={(v: any) => v.id}
                    onRowClick={(v: any) => navigate(`/video/${v.id}`)}
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


