import React, { useState, useEffect, useCallback, useRef, useContext, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDurationSeconds } from "@/utils/format";
import {
  Badge,
  Button,
  Text,
  Title1,
  Title2,
  Title3,
  Spinner,
  Avatar,
  Tooltip,
  Card,
  makeStyles,
  tokens,
  mergeClasses,
} from "@fluentui/react-components";
import { MediaCard } from "@/components/cards/MediaCard";
import {
  ArrowDownload24Regular,
  Checkmark24Filled,
  Eye24Regular,
  EyeOff24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Play24Regular,
  Stop24Filled,
  Info24Regular,
} from "@fluentui/react-icons";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { api } from "@/services/api";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { LoadingState } from "@/components/ui/LoadingState";
import { ExpandableMetadataBlock } from "@/components/ui/ExpandableMetadataBlock";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import {
  albumPageQueryKey,
  useAlbumPage,
  type AlbumPageData,
  type AlbumTrack,
  type SimilarAlbum,
  type AlbumVersion,
} from "@/hooks/useAlbumPage";
import { useMonitoring } from "@/hooks/useMonitoring";
import { getAlbumCover } from "@/utils/tidalImages";
import { useToast } from "@/hooks/useToast";
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";
import { tidalUrl } from "@/utils/tidalUrl";
import { QueueContext } from "@/providers/QueueProvider";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXL,
    paddingBottom: `calc(${tokens.spacingVerticalXXXL} * 3)`,
  },
  header: {
    position: "relative",
    minHeight: "200px",
    display: "flex",
    alignItems: "flex-start",
    padding: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalXL,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    gap: tokens.spacingHorizontalL,
    "@media (min-width: 768px)": {
      minHeight: "300px",
      padding: tokens.spacingHorizontalXL,
      paddingTop: tokens.spacingVerticalXXL,
      paddingBottom: tokens.spacingVerticalXXL,
      gap: tokens.spacingHorizontalXXL,
    },
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
  coverArt: {
    width: "140px",
    height: "140px",
    objectFit: "cover",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow28,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "180px",
      height: "180px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
      boxShadow: tokens.shadow64,
    },
  },
  albumInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    width: "100%",
    alignItems: "center",
    textAlign: "center",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      textAlign: "left",
      gap: tokens.spacingVerticalM,
    },
  },
  albumTitle: {
    width: "100%",
    textAlign: "center",
    whiteSpace: "normal",
    wordBreak: "break-word",
    "@media (min-width: 768px)": {
      textAlign: "left",
    },
  },
  artistInfo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingHorizontalS,
    cursor: "pointer",
    "&:hover": {
      opacity: 0.8,
    },
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      gap: tokens.spacingHorizontalM,
    },
  },
  metadata: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground2,
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      gap: tokens.spacingHorizontalM,
    },
  },
  metadataSeparator: {
    width: "4px",
    height: "4px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralForeground2,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    justifyContent: "center",
    width: "100%",
    marginTop: tokens.spacingVerticalS,
    alignItems: "stretch",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      marginTop: tokens.spacingVerticalM,
    },
  },
  // Transparent button base style
  transparentButton: {
    borderRadius: tokens.borderRadiusXLarge,
  },
  // Primary action button
  primaryButton: {
    borderRadius: tokens.borderRadiusXLarge,
  },
  actionButton: {
    // Mobile: vertical layout, equal-width (like Dashboard)
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    flex: "1 1 0",
    minWidth: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    gap: tokens.spacingVerticalXXS,
    "& .fui-Button__content": {
      fontSize: tokens.fontSizeBase100,
      marginLeft: "0 !important",
    },
    "& .fui-Button__icon": {
      marginRight: "0",
    },
    // Tablet: slightly larger
    "@media (min-width: 480px)": {
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    },
    // Desktop: normal horizontal layout, auto width
    "@media (min-width: 768px)": {
      flexDirection: "row",
      flex: "0 0 auto",
      minWidth: "auto",
      gap: tokens.spacingHorizontalNone,
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
      "& .fui-Button__content": {
        fontSize: tokens.fontSizeBase300,
        marginTop: "0",
        marginLeft: tokens.spacingHorizontalS,
      },
      "& .fui-Button__icon": {
        marginRight: tokens.spacingHorizontalSNudge,
      },
    },
  },
  metaAttribution: {
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  explicitBadge: {
    marginLeft: "auto",
    flexShrink: 0,
  },
  trackExplicitBadge: {
    marginLeft: tokens.spacingHorizontalXS,
  },
  // Volume header for multi-disc albums
  volumeHeader: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXS}`,
    backgroundColor: tokens.colorTransparentBackground,
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalS,
    "@media (min-width: 640px)": {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
    },
  },
  trackList: {
    display: "flex",
    flexDirection: "column",
  },
  trackTable: {
    width: "100%",
    borderCollapse: "separate",
    borderSpacing: 0,
    tableLayout: "fixed",
    display: "none",
    "@media (min-width: 640px)": {
      display: "table",
    },
  },
  mobileTrackList: {
    display: "flex",
    flexDirection: "column",
    "@media (min-width: 640px)": {
      display: "none",
    },
  },
  mobileTrackItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  mobileTrackNumber: {
    width: "24px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    flexShrink: 0,
  },
  mobileTrackInfo: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  mobileTrackActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  trackHeader: {
    textAlign: "left",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
    borderBottom: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase100,
    textTransform: "uppercase",
    "@media (min-width: 640px)": {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
      fontSize: tokens.fontSizeBase200,
    },
  },
  trackRow: {
    cursor: "pointer",
    transition: `background-color ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },
  },
  trackCell: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: "middle",
    overflow: "hidden",
    "@media (min-width: 640px)": {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
    },
  },
  trackIndex: {
    width: "36px",
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
    "@media (min-width: 640px)": {
      width: "60px",
    },
  },
  trackTitle: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  trackFiles: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
  trackFileItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
  },
  actionButtons: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    justifyContent: "flex-end",
  },
  // Similar Albums Section
  sectionHeader: {
    marginBottom: tokens.spacingVerticalM,
  },
  carousel: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    "@media (min-width: 480px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
    },
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(172px, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
  },
  albumCard: {
    minWidth: "0",
    width: "100%",
    maxWidth: "100%",
    height: "100%",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    transition: `all ${tokens.durationFast} ${tokens.curveEasyEase}`,
    padding: tokens.spacingVerticalNone,
    "&:hover": {
      transform: "translateY(-2px)",
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha}`,
    },
  },
  albumCardPreview: {
    position: "relative",
    aspectRatio: "1/1",
    width: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
    margin: tokens.spacingVerticalNone,
    padding: tokens.spacingVerticalNone,
    overflow: "hidden",
  },
  albumCardImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  albumCardContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  albumCardTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  albumCardQualityBadge: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
  },
  albumCardTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  albumCardSubtitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  loadingState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    minHeight: "400px",
    margin: "0 auto",
    padding: tokens.spacingHorizontalL,
  },
  loadingPanel: {
    width: "100%",
    maxWidth: "520px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingVerticalM,
    textAlign: "center",
    margin: "0 auto",
  },
  notFoundState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "400px",
    gap: tokens.spacingVerticalL,
    textAlign: "center",
    padding: tokens.spacingHorizontalXXL,
  },
  notFoundSubtext: {
    color: tokens.colorNeutralForeground2,
  },
  placeholderBg: {
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
  },
  sectionSpacing: {
    marginTop: tokens.spacingVerticalXXL,
  },
  noTracksText: {
    color: tokens.colorNeutralForeground2,
  },
  trackArtistText: {
    color: tokens.colorNeutralForeground2,
  },
  mobileTrackMeta: {
    color: tokens.colorNeutralForeground2,
  },
  trackSubInfo: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  trackArtistSeparator: {
    color: tokens.colorNeutralForeground2,
  },
  trackDurationText: {
    color: tokens.colorNeutralForeground2,
  },
  albumFilesCard: {
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  albumFilesHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  lockColorRed: {
    color: tokens.colorPaletteRedForeground1,
  },
  // Audio player row below a track
  audioPlayerRow: {
    padding: `0 ${tokens.spacingHorizontalXS}`,
    paddingBottom: tokens.spacingVerticalS,
    "@media (min-width: 640px)": {
      padding: `0 ${tokens.spacingHorizontalS}`,
      paddingBottom: tokens.spacingVerticalS,
    },
  },
  audioPlayerCell: {
    padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  // Cover overlay for hover info
  coverContainer: {
    position: "relative",
    flexShrink: 0,
    alignSelf: "center",
    display: "inline-flex",
    lineHeight: 0,
    width: "fit-content",
    maxWidth: "100%",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    "@media (min-width: 768px)": {
      alignSelf: "flex-start",
    },
  },
  coverOverlay: {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: tokens.borderRadiusLarge,
    opacity: 0,
    transition: `opacity ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    cursor: "pointer",
    "&:hover": {
      opacity: 1,
    },
  },
  coverInfoIcon: {
    color: "white",
    fontSize: "32px",
  },
});

const AlbumPage = () => {
  const styles = useStyles();
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const { setArtwork } = useUltraBlurContext();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { toggleMonitor, toggleLock, isTogglingMonitor, isTogglingLock } = useMonitoring();

  const queueCtx = useContext(QueueContext);
  const progressMap = queueCtx?.progress;
  const [downloadingTracks, setDownloadingTracks] = useState<Set<string>>(new Set());
  const [downloadingAlbum, setDownloadingAlbum] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [tidalStreamUrls, setTidalStreamUrls] = useState<Map<string, string>>(new Map());
  const [infoTrack, setInfoTrack] = useState<AlbumTrack | null>(null);
  const [coverInfoOpen, setCoverInfoOpen] = useState(false);
  /** JS breakpoint — true when viewport >= 640px (matches CSS trackTable / mobileTrackList). */
  const [isWideViewport, setIsWideViewport] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 640px)').matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 640px)');
    const handler = (e: MediaQueryListEvent) => setIsWideViewport(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const { data: pageData, isLoading: loading, error } = useAlbumPage(albumId);
  const album = pageData?.album ?? null;
  const tracks = pageData?.tracks ?? [];
  const similarAlbums = useMemo(() => {
    const items = pageData?.similarAlbums ?? [];

    return items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const popularityDiff = (Number(right.item.popularity || 0) - Number(left.item.popularity || 0));
        if (popularityDiff !== 0) {
          return popularityDiff;
        }

        return left.index - right.index;
      })
      .map(({ item }) => item);
  }, [pageData?.similarAlbums]);
  const otherVersions = pageData?.otherVersions ?? [];
  const artistImage = pageData?.artistImage ?? undefined;

  const isMonitored = !!album?.is_monitored;
  const isLocked = !!((album as any)?.monitor_locked ?? (album as any)?.monitor_lock);

  const updateAlbumPageCache = useCallback((updater: (current: AlbumPageData) => AlbumPageData) => {
    if (!albumId) {
      return;
    }

    queryClient.setQueryData<AlbumPageData | undefined>(albumPageQueryKey(albumId), (current) => {
      if (!current) {
        return current;
      }

      return updater(current);
    });
  }, [albumId, queryClient]);

  const handleToggleMonitor = () => {
    if (!album || isLocked) return;
    toggleMonitor({ id: album.id, type: 'album', currentStatus: isMonitored });
    updateAlbumPageCache((current) => ({
      ...current,
      album: { ...current.album, is_monitored: !isMonitored },
    }));
    dispatchLibraryUpdated();
  };

  const handleToggleLock = () => {
    if (!album) return;
    toggleLock({ id: album.id, type: 'album', isLocked, isMonitored });
    updateAlbumPageCache((current) => ({
      ...current,
      album: { ...current.album, monitor_locked: !isLocked } as typeof current.album & { monitor_locked: boolean },
    }));
    dispatchLibraryUpdated();
  };

  const handleDownloadAlbum = async () => {
    if (!album) return;
    setDownloadingAlbum(true);
    try {
      const url = tidalUrl('album', album.id);
      await api.addToQueue(url, 'album', album.id);
      toast({
        title: "Album added to queue",
        description: `${album.title} will be downloaded shortly`,
      });
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error adding album to queue:", error);
      toast({
        title: "Failed to add to queue",
        description: "Please try again",
        variant: "destructive",
      });
    } finally {
      setDownloadingAlbum(false);
    }
  };

  const handleDownloadTrack = async (track: AlbumTrack, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (track.downloaded) return;


    setDownloadingTracks(prev => new Set(prev).add(track.id));
    try {
      const fullTitle = track.version ? `${track.title} (${track.version})` : track.title;
      const url = tidalUrl('track', track.id);
      await api.addToQueue(url, 'track', track.id);
      toast({
        title: "Track added to queue",
        description: `${fullTitle} will be downloaded shortly`,
      });
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error adding track to queue:", error);
      toast({
        title: "Failed to add to queue",
        description: "Please try again",
        variant: "destructive",
      });
    } finally {
      setDownloadingTracks(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  /** Get the first streamable audio file for a track */
  const getTrackAudioFile = useCallback((track: AlbumTrack) => {
    return (track.files || []).find(f => f.file_type === 'track');
  }, []);

  /** Toggle play/stop for a track.
   *  If the track has a local audio file we play that;
   *  otherwise we sign a TIDAL stream URL on the fly.
   */
  const signingRef = useRef(false);
  const handleTogglePlay = useCallback(async (track: AlbumTrack, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (playingTrackId === track.id) {
      setPlayingTrackId(null);
      return;
    }
    // Prevent double-clicks while a signing request is in flight
    if (signingRef.current) return;

    const audioFile = getTrackAudioFile(track);

    if (!audioFile && !tidalStreamUrls.has(track.id)) {
      // Need to sign a TIDAL stream URL first
      signingRef.current = true;
      try {
        const url = await api.signTidalStream(track.id);
        setTidalStreamUrls(prev => new Map(prev).set(track.id, url));
      } catch (err) {
        console.error('Failed to get TIDAL stream URL:', err);
        toast({ title: 'Playback failed', description: 'Could not get stream URL from TIDAL', variant: 'destructive' });
        return;
      } finally {
        signingRef.current = false;
      }
    }
    setPlayingTrackId(track.id);
  }, [getTrackAudioFile, playingTrackId, tidalStreamUrls, toast]);

  /** Open track info dialog */
  const handleOpenInfo = useCallback((track: AlbumTrack, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setInfoTrack(track);
  }, []);

  useEffect(() => {
    const artworkUrl = album?.cover_id ? getAlbumCover(album.cover_id, 'large') : null;
    if (artworkUrl) {
      setArtwork(artworkUrl);
    }
  }, [album?.cover_id, setArtwork]);

  if (loading) {
    return (
      <DynamicBrandProvider keyColor={album?.vibrant_color}>
        <LoadingState
          className={styles.loadingState}
          panelClassName={styles.loadingPanel}
          size="huge"
          label="Loading album details..."
        />
      </DynamicBrandProvider>
    );
  }

  if (!album) {
    return (
      <div className={styles.notFoundState}>
        <Text size={500}>Album not found</Text>
        <Text className={styles.notFoundSubtext}>This album may not be in your library yet.</Text>
        <Button appearance="primary" onClick={() => navigate('/')}>Return to Library</Button>
      </div>
    );
  }


  const renderMiniAlbumCard = (
    item: { id: string; title: string; cover_id?: string; cover?: string; quality?: string; explicit?: boolean; },
    subtitle: string,
    itemProgress?: any
  ) => {
    const isCurrent = item.id === album?.id;

    return (
      <MediaCard
        key={item.id}
        className={mergeClasses(styles.albumCard, isCurrent && styles.albumCard)}
        to={`/album/${item.id}`}
        imageUrl={item.cover_id ? getAlbumCover(item.cover_id, "small") : (item.cover ? getAlbumCover(item.cover, "small") : null)}
        alt={item.title}
        title={item.title}
        subtitle={subtitle}
        explicit={item.explicit}
        quality={item.quality}
        mini
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
      />
    );
  };
  return (
    <DynamicBrandProvider keyColor={album.vibrant_color}>
      <div className={styles.container}>
        {/* Header Section */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            {/* Cover art with optional info overlay for local covers */}
            {(() => {
              const coverFiles = (album.files || []).filter(
                (f: any) => f.file_type === 'cover' || f.file_type === 'image' || f.file_type === 'video_cover'
              );
              const hasCoverFile = coverFiles.length > 0;
              return (
                <div className={styles.coverContainer}>
                  <img
                    src={getAlbumCover(album.cover_id, 'large') || "/placeholder-album.png"}
                    alt={album.title}
                    className={styles.coverArt}
                  />
                  {hasCoverFile && (
                    <div
                      className={styles.coverOverlay}
                      onClick={() => setCoverInfoOpen(true)}
                      title="Artwork info"
                    >
                      <Info24Regular className={styles.coverInfoIcon} />
                    </div>
                  )}
                </div>
              );
            })()}
            <div className={styles.albumInfo}>
              <Title1 className={styles.albumTitle}>{album.title}</Title1>

              <div
                className={styles.artistInfo}
                onClick={() => navigate(`/artist/${album.artist_id}`)}
              >
                <Avatar
                  image={{ src: artistImage }}
                  name={album.artist_name}
                  size={32}
                />
                <Text size={400} weight="semibold">
                  {album.artist_name}
                </Text>
              </div>

              <div className={styles.metadata}>
                <QualityBadge quality={album.quality} />
                <div className={styles.metadataSeparator} />
                <Text>{new Date(album.release_date).getFullYear()}</Text>
                <div className={styles.metadataSeparator} />
                <Text>{tracks.length} Tracks</Text>
                <div className={styles.metadataSeparator} />
                <Text>
                  {formatDurationSeconds(tracks.reduce((acc, t) => acc + t.duration, 0))}
                </Text>
              </div>

              {/* Album Review Section */}
              {(() => {
                const reviewText = (album as any).review ?? (album as any).review_text ?? null;
                const reviewAttribution = formatMetadataAttribution(
                  (album as any).review_source,
                  (album as any).review_last_updated
                );
                if (!reviewText) return null;

                return (
                  <ExpandableMetadataBlock
                    content={parseWimpLinks(reviewText, navigate)}
                    attribution={reviewAttribution}
                    expanded={reviewExpanded}
                    onToggle={() => setReviewExpanded(!reviewExpanded)}
                    preserveWhitespace
                  />
                );
              })()}

              <div className={styles.actions}>
                {/* Monitor Button — icon shows action (what clicking will do) */}
                <Button
                  appearance={isMonitored ? "subtle" : "primary"}
                  icon={isMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
                  onClick={handleToggleMonitor}
                  disabled={isTogglingMonitor || isLocked}
                  title={isLocked ? "Unlock to change monitoring" : (isMonitored ? "Stop monitoring" : "Start monitoring")}
                  className={mergeClasses(
                    styles.actionButton,
                    isMonitored ? styles.transparentButton : styles.primaryButton
                  )}
                >
                  {isMonitored ? "Unmonitor" : "Monitor"}
                </Button>

                {/* Lock Button — icon shows action (what clicking will do) */}
                <Tooltip content={isLocked ? "Unlock to allow auto-filters to change status" : "Lock to prevent auto-filters from changing status"} relationship="label">
                  <Button
                    appearance="subtle"
                    icon={isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />}
                    onClick={handleToggleLock}
                    disabled={isTogglingLock}
                    className={mergeClasses(styles.actionButton, styles.transparentButton)}
                  >
                    {isLocked ? "Unlock" : "Lock"}
                  </Button>
                </Tooltip>

                {/* Download Button */}
                <Button
                  icon={<ArrowDownload24Regular />}
                  appearance="subtle"
                  onClick={handleDownloadAlbum}
                  disabled={downloadingAlbum}
                  title="Download album"
                  className={mergeClasses(styles.actionButton, styles.transparentButton)}
                >
                  {downloadingAlbum ? "Adding..." : "Download"}
                </Button>
              </div>            </div>
          </div>
        </div>

        {/* Track List Section */}
        {tracks.length === 0 ? (
          <Text className={styles.noTracksText}>No tracks found for this album.</Text>
        ) : (() => {
          // Check if multi-volume
          const volumes = [...new Set(tracks.map(t => t.volume_number || 1))].sort((a, b) => a - b);
          const isMultiVolume = volumes.length > 1;

          return (
            <>
              {/* Mobile Track List */}
              <div className={styles.mobileTrackList}>
                {tracks.map((track, index) => {
                  const showArtist = track.artist_name && track.artist_name !== album.artist_name;
                  const isDownloading = downloadingTracks.has(track.id);
                  const isTrackMonitored = Boolean(track.is_monitored ?? track.monitor);
                  const isTrackLocked = Boolean((track as any).monitor_locked ?? track.monitor_lock);
                  const isDownloaded = Boolean(track.downloaded);
                  const audioFile = getTrackAudioFile(track);
                  const isPlaying = playingTrackId === track.id;
                  const currentVolume = track.volume_number || 1;
                  const prevTrack = index > 0 ? tracks[index - 1] : null;
                  const prevVolume = prevTrack ? (prevTrack.volume_number || 1) : 0;
                  const showVolumeHeader = isMultiVolume && currentVolume !== prevVolume;

                  return (
                    <React.Fragment key={track.id}>
                      {showVolumeHeader && (
                        <div className={styles.volumeHeader}>
                          <Title3>Volume {currentVolume}</Title3>
                        </div>
                      )}
                      <div className={styles.mobileTrackItem}>
                        <Text className={styles.mobileTrackNumber}>{track.track_number}</Text>
                        <div className={styles.mobileTrackInfo}>
                          <Text weight="medium" size={300} truncate wrap={false}>
                            {track.version ? `${track.title} (${track.version})` : track.title}
                            {track.explicit ? <ExplicitBadge className={styles.trackExplicitBadge} /> : null}
                          </Text>
                          <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                            {[showArtist ? track.artist_name : null, formatDurationSeconds(track.duration)].filter(Boolean).join(' · ')}
                          </Text>
                        </div>
                        <div className={styles.mobileTrackActions}>
                          {/* Play/Stop — always available (local file or TIDAL stream) */}
                          <Tooltip content={isPlaying ? "Stop" : "Play"} relationship="label">
                            <Button
                              appearance="subtle"
                              icon={isPlaying ? <Stop24Filled /> : <Play24Regular />}
                              size="small"
                              onClick={(e) => handleTogglePlay(track, e)}
                            />
                          </Tooltip>
                          <Button
                            appearance="subtle"
                            icon={isTrackMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
                            size="small"
                            disabled={isTrackLocked}
                            onClick={() => toggleMonitor({ id: track.id, type: 'track', currentStatus: isTrackMonitored })}
                            title={isTrackLocked ? "Unlock to change monitoring" : (isTrackMonitored ? "Stop monitoring" : "Start monitoring")}
                          />
                          <Button
                            appearance="subtle"
                            icon={isTrackLocked ? <LockOpen24Regular /> : <LockClosed24Regular />}
                            size="small"
                            onClick={() => toggleLock({ id: track.id, type: 'track', isLocked: isTrackLocked, isMonitored: isTrackMonitored })}
                            style={isTrackLocked ? { color: tokens.colorPaletteRedForeground1 } : undefined}
                            title={isTrackLocked ? "Unlock" : "Lock"}
                          />
                          {/* Info replaces download when downloaded; download when not */}
                          {audioFile ? (
                            <Tooltip content="Track info" relationship="label">
                              <Button
                                appearance="subtle"
                                icon={<Info24Regular />}
                                size="small"
                                onClick={(e) => handleOpenInfo(track, e)}
                              />
                            </Tooltip>
                          ) : (
                            isDownloaded ? (
                              <Button icon={<Checkmark24Filled />} appearance="subtle" size="small" disabled />
                            ) : (
                              <Button
                                icon={<ArrowDownload24Regular />}
                                appearance="subtle"
                                size="small"
                                onClick={(e) => handleDownloadTrack(track, e)}
                                disabled={isDownloading}
                                title="Download track"
                              />
                            )
                          )}
                        </div>
                      </div>
                      {/* Inline audio player — only mount on mobile to avoid duplicate Audio elements */}
                      {isPlaying && !isWideViewport && (
                        <div className={styles.audioPlayerRow}>
                          <AudioPlayer
                            src={audioFile ? api.getStreamUrl(audioFile.id) : (tidalStreamUrls.get(track.id) || '')}
                            knownDuration={track.duration}
                            onEnded={() => setPlayingTrackId(null)}
                          />
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
              {/* Desktop Track Table */}
              <table className={styles.trackTable}>
                <thead>
                  <tr>
                    <th className={mergeClasses(styles.trackHeader, styles.trackIndex)}>#</th>
                    <th className={styles.trackHeader}>TITLE</th>
                    <th className={styles.trackHeader} style={{ width: '140px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((track, index) => {
                    const showArtist = track.artist_name && track.artist_name !== album.artist_name;
                    const isDownloading = downloadingTracks.has(track.id);
                    const isTrackMonitored = Boolean(track.is_monitored ?? track.monitor);
                    const isTrackLocked = Boolean((track as any).monitor_locked ?? track.monitor_lock);
                    const isDownloaded = Boolean(track.downloaded);
                    const audioFile = getTrackAudioFile(track);
                    const isPlaying = playingTrackId === track.id;

                    // Check if we need a volume header
                    const currentVolume = track.volume_number || 1;
                    const prevTrack = index > 0 ? tracks[index - 1] : null;
                    const prevVolume = prevTrack ? (prevTrack.volume_number || 1) : 0;
                    const showVolumeHeader = isMultiVolume && currentVolume !== prevVolume;

                    return (
                      <React.Fragment key={track.id}>
                        {showVolumeHeader && (
                          <tr>
                            <td colSpan={3} className={styles.volumeHeader}>
                              <Title3>Volume {currentVolume}</Title3>
                            </td>
                          </tr>
                        )}
                        <tr className={styles.trackRow}>
                          <td className={mergeClasses(styles.trackCell, styles.trackIndex)}>
                            {track.track_number}
                          </td>
                          <td className={styles.trackCell}>
                            <div className={styles.trackTitle}>
                              <Text weight="medium">
                                {track.version ? `${track.title} (${track.version})` : track.title}
                                {track.explicit ? <ExplicitBadge className={styles.trackExplicitBadge} /> : null}
                              </Text>
                              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                                {showArtist && (
                                  <>
                                    <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                                      {track.artist_name}
                                    </Text>
                                    <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>•</Text>
                                  </>
                                )}
                                <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                                  {formatDurationSeconds(track.duration)}
                                </Text>
                              </div>
                            </div>
                          </td>
                          <td className={styles.trackCell}>
                            <div className={styles.actionButtons}>
                              {/* Play/Stop — always available (local file or TIDAL stream) */}
                              <Tooltip content={isPlaying ? "Stop" : "Play"} relationship="label">
                                <Button
                                  appearance="subtle"
                                  icon={isPlaying ? <Stop24Filled /> : <Play24Regular />}
                                  size="small"
                                  onClick={(e) => handleTogglePlay(track, e)}
                                />
                              </Tooltip>

                              {/* Track Monitor Button */}
                              <Tooltip content={isTrackLocked ? "Unlock to change" : (isTrackMonitored ? "Stop monitoring" : "Start monitoring")} relationship="label">
                                <Button
                                  appearance="subtle"
                                  icon={isTrackMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
                                  size="small"
                                  disabled={isTrackLocked}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleMonitor({ id: track.id, type: 'track', currentStatus: isTrackMonitored });
                                  }}
                                />
                              </Tooltip>

                              {/* Track Lock Button */}
                              <Tooltip content={isTrackLocked ? "Unlock" : "Lock"} relationship="label">
                                <Button
                                  appearance="subtle"
                                  icon={isTrackLocked ? <LockOpen24Regular /> : <LockClosed24Regular />}
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleLock({ id: track.id, type: 'track', isLocked: isTrackLocked, isMonitored: isTrackMonitored });
                                  }}
                                  style={isTrackLocked ? { color: tokens.colorPaletteRedForeground1 } : undefined}
                                />
                              </Tooltip>

                              {/* Info (downloaded) or Download/Checkmark (not downloaded) */}
                              {audioFile ? (
                                <Tooltip content="Track info" relationship="label">
                                  <Button
                                    appearance="subtle"
                                    icon={<Info24Regular />}
                                    size="small"
                                    onClick={(e) => handleOpenInfo(track, e)}
                                  />
                                </Tooltip>
                              ) : (
                                isDownloaded ? (
                                  <Button
                                    icon={<Checkmark24Filled />}
                                    appearance="subtle"
                                    size="small"
                                    disabled
                                    title="Downloaded"
                                  />
                                ) : (
                                  <Button
                                    icon={<ArrowDownload24Regular />}
                                    appearance="subtle"
                                    size="small"
                                    onClick={(e) => handleDownloadTrack(track, e)}
                                    disabled={isDownloading}
                                    title="Download track"
                                  />
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                        {/* Inline audio player row — only mount on desktop to avoid duplicate Audio elements */}
                        {isPlaying && isWideViewport && (
                          <tr>
                            <td colSpan={3} className={styles.audioPlayerCell}>
                              <AudioPlayer
                                src={audioFile ? api.getStreamUrl(audioFile.id) : (tidalStreamUrls.get(track.id) || '')}
                                knownDuration={track.duration}
                                onEnded={() => setPlayingTrackId(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </>
          );
        })()}

        {/* Track Info Dialog */}
        {infoTrack && (
          <TrackInfoDialog
            open={!!infoTrack}
            onClose={() => setInfoTrack(null)}
            trackTitle={infoTrack.version ? `${infoTrack.title} (${infoTrack.version})` : infoTrack.title}
            artistName={infoTrack.artist_name || album.artist_name}
            albumTitle={album.title}
            trackNumber={infoTrack.track_number}
            duration={infoTrack.duration}
            audioQuality={infoTrack.quality}
            files={infoTrack.files}
          />
        )}

        {/* Cover Info Dialog */}
        {coverInfoOpen && (() => {
          const coverFiles = (album.files || []).filter(
            (f: any) => f.file_type === 'cover' || f.file_type === 'image' || f.file_type === 'video_cover'
          );
          return (
            <TrackInfoDialog
              open={coverInfoOpen}
              onClose={() => setCoverInfoOpen(false)}
              trackTitle="Album Cover"
              dialogTitle="Artwork Info"
              detailsTitle="Artwork Details"
              artistName={album.artist_name}
              albumTitle={album.title}
              files={coverFiles}
            />
          );
        })()}

        {/* Other Versions Section */}
        {
          otherVersions.length > 0 && (
            <div className={styles.sectionSpacing}>
              <div className={styles.sectionHeader}>
                <Title2>Other Versions</Title2>
              </div>
              <div className={styles.carousel}>
                {otherVersions.map((version) => {
                  const year = version.release_date ? new Date(version.release_date).getFullYear() : '';
                  const versionLabel = version.version || (version.explicit ? 'Explicit' : 'Clean');
                  const subtitle = [versionLabel, year].filter(Boolean).join(' · ');
                  const vProgress = progressMap?.get(Number(version.id));
                  return renderMiniAlbumCard(version, subtitle, vProgress);
                })}
              </div>
            </div>
          )
        }

        {/* Similar Albums Section */}
        {
          similarAlbums.length > 0 && (
            <div className={styles.sectionSpacing}>
              <div className={styles.sectionHeader}>
                <Title2>Similar Albums</Title2>
              </div>
              <div className={styles.carousel}>
                {similarAlbums.map((similarAlbum) => {
                  const year = similarAlbum.release_date ? new Date(similarAlbum.release_date).getFullYear() : '';
                  const subtitle = [similarAlbum.artist_name, year].filter(Boolean).join(' · ');
                  const sProgress = progressMap?.get(Number(similarAlbum.id));
                  return renderMiniAlbumCard(similarAlbum, subtitle, sProgress);
                })}
              </div>
            </div>
          )
        }
      </div >
    </DynamicBrandProvider>
  );
};

export default AlbumPage;
