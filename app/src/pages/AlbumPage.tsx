import React, { useState, useCallback, useMemo, useLayoutEffect, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { formatDurationSeconds } from "@/utils/format";
import {
  Button,
  Text,
  Title1,
  Title2,
  Spinner,
  Avatar,
  Tooltip,
  makeStyles,
  tokens,
  Overflow,
  OverflowItem,
  mergeClasses,
} from "@fluentui/react-components";
import { MediaCard } from "@/components/cards/MediaCard";
import {
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Info24Regular,
  MusicNote224Regular,
} from "@fluentui/react-icons";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { api } from "@/services/api";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { DetailPageSkeleton } from "@/components/ui/LoadingSkeletons";
import { ExpandableMetadataBlock } from "@/components/ui/ExpandableMetadataBlock";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import TrackList from "@/components/TrackList";
import {
  albumPageQueryKey,
  useAlbumPage,
  type AlbumPageData,
  type AlbumTrack,
  type SimilarAlbum,
  type AlbumVersion,
} from "@/hooks/useAlbumPage";
import { useMonitoring } from "@/hooks/useMonitoring";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { getAlbumCover } from "@/utils/tidalImages";
import { useToast } from "@/hooks/useToast";
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";
import { tidalUrl } from "@/utils/tidalUrl";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import { getAlbumPath, getAlbumRouteTrackTarget } from "@/utils/albumNavigation";
import {
  detailActionButtonRadiusStyles,
  standardDetailActionButtonStyles,
} from "@/components/media/detailActionStyles";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXL,
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
    flexWrap: "nowrap",
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
    ...detailActionButtonRadiusStyles,
  },
  // Primary action button
  primaryButton: {
    ...detailActionButtonRadiusStyles,
  },
  actionButton: {
    ...standardDetailActionButtonStyles,
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
  // Similar Albums Section
  sectionHeader: {
    marginBottom: tokens.spacingVerticalM,
  },
  carousel: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    },
    "@media (min-width: 1200px)": {
      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
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
  placeholderBg: {
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
  },
  sectionSpacing: {
    marginTop: tokens.spacingVerticalXXL,
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

/* ── Album overflow helpers ─────────────────────────────────── */

const EMPTY_ALBUM_TRACKS: AlbumTrack[] = [];

const AlbumPage = () => {
  const styles = useStyles();
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { toggleMonitor, toggleLock, isTogglingMonitor, isTogglingLock } = useMonitoring();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();

  const { getProgressByTidalId } = useQueueStatus();
  const [downloadingAlbum, setDownloadingAlbum] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [coverInfoOpen, setCoverInfoOpen] = useState(false);
  const handledTrackScrollKeyRef = useRef<string | null>(null);

  const { data: pageData, isLoading: loading, error, refetch } = useAlbumPage(albumId);
  const album = pageData?.album ?? null;
  const tracks = pageData?.tracks ?? EMPTY_ALBUM_TRACKS;
  const showTrackArtists = useMemo(
    () => tracks.some((track) => Boolean(track.artist_name) && track.artist_name !== album?.artist_name),
    [tracks, album?.artist_name],
  );
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
  const albumArtworkUrl = album?.cover_id ? getAlbumCover(album.cover_id, 'large') : null;
  const albumBrandColor = useArtworkBrandColor({
    artworkUrl: albumArtworkUrl,
    brandKeyColor: album?.vibrant_color ?? null,
  });

  const isMonitored = !!album?.is_monitored;
  const isLocked = !!((album as any)?.monitor_locked ?? (album as any)?.monitor_lock);

  useLayoutEffect(() => {
    if (!albumId) {
      return;
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [albumId, location.key]);

  useLayoutEffect(() => {
    if (!albumId || loading) {
      return;
    }

    const focusTrackId = getAlbumRouteTrackTarget(location.state);
    if (!focusTrackId) {
      return;
    }

    const scrollKey = `${location.key}:${albumId}:${focusTrackId}`;
    if (handledTrackScrollKeyRef.current === scrollKey) {
      return;
    }

    let animationFrameId = 0;
    let cancelled = false;
    let attempts = 0;

    const findTrackRow = () => {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return document.querySelector<HTMLElement>(`[data-album-track-id="${CSS.escape(focusTrackId)}"]`);
      }

      return document.querySelector<HTMLElement>(`[data-album-track-id="${focusTrackId.replace(/([\\"])/g, "\\$1")}"]`);
    };

    const scrollToTrack = () => {
      if (cancelled) {
        return;
      }

      const trackRow = findTrackRow();
      if (trackRow) {
        handledTrackScrollKeyRef.current = scrollKey;
        trackRow.scrollIntoView({ block: "center", behavior: "auto" });
        return;
      }

      attempts += 1;
      if (attempts < 12) {
        animationFrameId = window.requestAnimationFrame(scrollToTrack);
      }
    };

    animationFrameId = window.requestAnimationFrame(scrollToTrack);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [albumId, loading, location.key, location.state, tracks.length]);

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
    toggleLock({ id: album.id, type: 'album', isLocked });
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

  const albumActions: OverflowAction[] = [
    { key: 'monitor', label: isMonitored ? 'Unmonitor' : 'Monitor', disabled: isTogglingMonitor || isLocked, onClick: handleToggleMonitor },
    { key: 'lock', label: isLocked ? 'Unlock' : 'Lock', disabled: isTogglingLock, onClick: handleToggleLock },
    { key: 'download', label: downloadingAlbum ? 'Adding...' : 'Download', disabled: downloadingAlbum, onClick: handleDownloadAlbum },
  ];

  /** Open track info dialog */
  if (loading) {
    return (
      <DetailPageSkeleton
        artShape="rounded"
        content="tracks"
        rows={8}
        className={styles.container}
        label="Loading album details..."
      />
    );
  }

  if (error) {
    return (
      <div className={styles.stateShell}>
        <ErrorState
          title="Failed to load album"
          error={error as Error}
          minHeight="320px"
          actions={<Button onClick={() => void refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  if (!album) {
    return (
      <div className={styles.stateShell}>
        <EmptyState
          title="Album not found"
          description="This album may not be in your library yet."
          actions={<Button appearance="primary" onClick={() => navigate('/')}>Return to Library</Button>}
          minHeight="320px"
        />
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
        to={getAlbumPath(item.id)}
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
    <DynamicBrandProvider keyColor={albumBrandColor}>
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
                    src={albumArtworkUrl || "/placeholder-album.png"}
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

              <Overflow minimumVisible={2}>
                <div className={styles.actions}>
                  {/* Monitor Button — icon shows action (what clicking will do) */}
                  <OverflowItem id="monitor" priority={3}>
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
                  </OverflowItem>

                  {/* Lock Button — icon shows action (what clicking will do) */}
                  <OverflowItem id="lock" priority={2}>
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
                  </OverflowItem>

                  {/* Download Button */}
                  <OverflowItem id="download" priority={1}>
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
                  </OverflowItem>

                  <ActionOverflowMenu actions={albumActions} />
                </div>
              </Overflow>
            </div>
          </div>
        </div>

        {/* Track List Section */}
        {tracks.length === 0 ? (
          <EmptyState
            title="No tracks found"
            description="This album doesn't have any surfaced tracks yet."
            icon={<MusicNote224Regular />}
            minHeight="220px"
          />
        ) : (
          <TrackList
            tracks={tracks}
            showArtist={showTrackArtists}
            showVolumeHeaders
            contextArtistName={album.artist_name}
            contextAlbumTitle={album.title}
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
              });
            }}
            isTrackDownloading={(track) => downloadingTracks.has(track.id)}
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
                  const vProgress = getProgressByTidalId(String(version.id));
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
                  const sProgress = getProgressByTidalId(String(similarAlbum.id));
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
