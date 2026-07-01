import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Avatar,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkCircle16Regular, Play24Filled, Stop24Regular } from "@fluentui/react-icons";
import { api } from "@/services/api";
import { DataGrid, useDataGridCellStyles, type DataGridColumn } from "@/components/DataGrid";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import { TrackRowActions } from "@/components/tracks/TrackRowActions";
import { useTrackPlayback } from "@/hooks/useTrackPlayback";
import { navigateToAlbum } from "@/utils/albumNavigation";
import { formatDurationSeconds } from "@/utils/format";
import { orderedQualityTags } from "@/utils/qualityTags";
import { renderableArtworkUrl } from "@/utils/artwork";
import type { TrackListItem } from "@/types/track-list";

type TrackNumbering = "track" | "index";
type TrackFiles = NonNullable<TrackListItem["files"]>;

interface TrackListSelection<T> {
  selectedRowIds: Array<string | number>;
  onSelectionChange: (selectedRowIds: Array<string | number>) => void;
  getSelectionLabel?: (item: T) => string;
}

interface TrackListProps<T extends TrackListItem = TrackListItem> {
  tracks: T[];
  numbering?: TrackNumbering;
  showCover?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  showQuality?: boolean;
  showVolumeHeaders?: boolean;
  showDownloadedColumn?: boolean;
  /** Disable the sticky table header — set false for a virtualized full-page scroll container (e.g. Library). */
  disableStickyHeader?: boolean;
  contextArtistName?: string | null;
  contextAlbumTitle?: string | null;
  onTrackClick?: (track: T) => void;
  onDownloadTrack?: (track: T, event?: MouseEvent<HTMLButtonElement>) => void;
  onToggleMonitor?: (track: T, event?: MouseEvent<HTMLButtonElement>) => void;
  onToggleLock?: (track: T, event?: MouseEvent<HTMLButtonElement>) => void;
  isTrackDownloading?: (track: T) => boolean;
  selection?: TrackListSelection<T>;
}

const useStyles = makeStyles({
  numberButton: {
    position: "relative",
    width: "32px",
    height: "32px",
    padding: 0,
    border: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "default",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    ":enabled": {
      cursor: "pointer",
    },
    ":enabled:hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
      "& [data-track-number]": {
        opacity: 0,
      },
      "& [data-track-play]": {
        opacity: 1,
      },
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
      "& [data-track-number]": {
        opacity: 0,
      },
      "& [data-track-play]": {
        opacity: 1,
      },
    },
  },
  numberText: {
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
  },
  playOverlay: {
    position: "absolute",
    inset: 0,
    opacity: 0,
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
  },
  playOverlayActive: {
    opacity: 1,
  },
  playIcon: {
    fontSize: "20px",
    display: "block",
  },
  titleCell: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  coverButton: {
    position: "relative",
    width: "40px",
    height: "40px",
    padding: 0,
    border: 0,
    borderRadius: tokens.borderRadiusSmall,
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
    cursor: "pointer",
    display: "block",
    ":disabled": {
      cursor: "default",
    },
    ":hover": {
      "& [data-cover-play]": {
        opacity: 1,
      },
      "& [data-cover-image]": {
        filter: "brightness(0.62)",
      },
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
      "& [data-cover-play]": {
        opacity: 1,
      },
    },
  },
  coverFallback: {
    width: "40px",
    height: "40px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  coverPlayOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.48)",
    color: tokens.colorNeutralForegroundOnBrand,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
  },
  coverPlayOverlayActive: {
    opacity: 1,
  },
  checkIcon: {
    color: tokens.colorPaletteGreenForeground1,
    verticalAlign: "middle",
  },
  emptyCheck: {
    display: "inline-block",
    width: "16px",
    height: "16px",
  },
  titleStack: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  titleText: {
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
  },
  mobileMeta: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },
  metaSeparator: {
    color: tokens.colorNeutralForeground4,
  },
  linkText: {
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    ":hover": {
      color: tokens.colorNeutralForeground1,
    },
  },
  qualityContent: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    minWidth: 0,
  },
  durationText: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  actionCellContent: {
    width: "100%",
    justifyContent: "flex-end",
  },
  player: {
    width: "100%",
  },
  rowPlaying: {
    borderBottomColor: "transparent",
  },
  artistContainer: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    minWidth: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: "inherit",
  },
  artistCreditButton: {
    display: "inline-flex",
    alignItems: "center",
    padding: 0,
    border: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    cursor: "pointer",
    "&:hover": {
      opacity: 0.8,
    },
  },
  artistJoinPhrase: {
    color: tokens.colorNeutralForeground3,
    marginRight: tokens.spacingHorizontalXXS,
    marginLeft: tokens.spacingHorizontalXXS,
  },
});

const getAlbumTitle = (track: TrackListItem, fallback?: string | null) =>
  track.album?.title ?? track.album_title ?? fallback ?? null;
const getAlbumArtworkUrl = (track: TrackListItem) =>
  track.cover_url ?? track.album_cover ?? track.album?.cover_id ?? null;
const getDisplayTitle = (track: TrackListItem) =>
  track.version ? `${track.title} (${track.version})` : track.title;
const getQualityTags = (track: TrackListItem): string[] => orderedQualityTags(track);
const isDownloadedTrack = (track: TrackListItem) => Boolean(track.is_downloaded ?? track.downloaded);

const getDisplayNumber = (track: TrackListItem, index: number, numbering: TrackNumbering) => {
  if (numbering === "index") {
    return index + 1;
  }

  return track.track_number || index + 1;
};

const shouldShowAlbum = (
  track: TrackListItem,
  showAlbum: boolean,
  contextAlbumTitle?: string | null,
) => {
  const albumTitle = getAlbumTitle(track);
  if (!showAlbum || !albumTitle) {
    return false;
  }

  return !contextAlbumTitle || albumTitle !== contextAlbumTitle;
};

const TrackList = <T extends TrackListItem>({
  tracks,
  numbering = "track",
  showCover = false,
  showArtist = false,
  showAlbum = false,
  showQuality = true,
  showVolumeHeaders = false,
  showDownloadedColumn = false,
  disableStickyHeader = true,
  contextArtistName,
  contextAlbumTitle,
  onTrackClick,
  onDownloadTrack,
  onToggleMonitor,
  onToggleLock,
  isTrackDownloading,
  selection,
}: TrackListProps<T>) => {
  const styles = useStyles();
  const dgCell = useDataGridCellStyles();
  const navigate = useNavigate();
  const {
    getPlaybackSrc,
    getPlaybackHlsSrc,
    getTrackAudioFile,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  } = useTrackPlayback();
  const [infoTrack, setInfoTrack] = useState<T | null>(null);
  const [failedCoverUrls, setFailedCoverUrls] = useState<Set<string>>(new Set());
  const [trackFilesById, setTrackFilesById] = useState<Record<string, TrackFiles>>({});
  const [loadingTrackFileIds, setLoadingTrackFileIds] = useState<Set<string>>(new Set());

  const hasMultipleVolumes = useMemo(
    () => tracks.some((track) => (track.volume_number || 1) !== (tracks[0]?.volume_number || 1)),
    [tracks]
  );
  const hasMultipleQuality = useMemo(
    () => tracks.some((track) => getQualityTags(track).length > 1),
    [tracks]
  );

  const getTrackFiles = useCallback((track: T): TrackFiles => {
    if (Array.isArray(track.files) && track.files.length > 0) {
      return track.files;
    }

    return trackFilesById[track.id] ?? [];
  }, [trackFilesById]);

  const ensureTrackFiles = useCallback(async (track: T): Promise<TrackFiles> => {
    const existingFiles = getTrackFiles(track);
    if (existingFiles.length > 0) {
      return existingFiles;
    }

    if (!isDownloadedTrack(track) || loadingTrackFileIds.has(track.id)) {
      return [];
    }

    setLoadingTrackFileIds((previous) => new Set(previous).add(track.id));

    try {
      const response = await api.getTrackFiles(track.id) as { items?: TrackFiles };
      const files = Array.isArray(response?.items) ? response.items : [];
      setTrackFilesById((previous) => ({ ...previous, [track.id]: files }));
      return files;
    } finally {
      setLoadingTrackFileIds((previous) => {
        const next = new Set(previous);
        next.delete(track.id);
        return next;
      });
    }
  }, [getTrackFiles, loadingTrackFileIds]);

  const openTrackInfo = useCallback(async (track: T) => {
    const existingFiles = getTrackFiles(track);
    setInfoTrack(existingFiles.length > 0 ? { ...track, files: existingFiles } : track);

    if (existingFiles.length === 0 && isDownloadedTrack(track)) {
      const files = await ensureTrackFiles(track);
      if (files.length > 0) {
        setInfoTrack((current) => current?.id === track.id ? { ...current, files } : current);
      }
    }
  }, [ensureTrackFiles, getTrackFiles]);

  const handleArtistClick = useCallback(async (
    artistId: string | null | undefined,
    artistName: string,
    event: MouseEvent,
  ) => {
    event.stopPropagation();
    if (artistId) {
      navigate(`/artist/${artistId}`);
      return;
    }

    if (!artistName) {
      return;
    }

    try {
      const res = await api.search(artistName, ["artists"], 1);
      if (res.success && res.results?.artists && res.results.artists.length > 0) {
        navigate(`/artist/${res.results.artists[0].id}`);
      } else {
        navigate(`/search?q=${encodeURIComponent(artistName)}`);
      }
    } catch {
      navigate(`/search?q=${encodeURIComponent(artistName)}`);
    }
  }, [navigate]);

  const handleAlbumClick = useCallback((event: MouseEvent, track: T) => {
    event.stopPropagation();
    const albumId = track.album_id ?? track.album?.id ?? null;
    if (albumId) {
      navigateToAlbum(navigate, albumId);
    }
  }, [navigate]);

  const renderArtistCredits = useCallback((track: T) => {
    if (track.artist_credits && track.artist_credits.length > 0) {
      return (
        <span className={styles.artistContainer}>
          {track.artist_credits.map((credit, idx) => (
            <span key={`${credit.id}-${idx}`}>
              <button
                type="button"
                className={styles.artistCreditButton}
                onClick={(event) => {
                  void handleArtistClick(credit.id, credit.name, event);
                }}
              >
                {credit.name}
              </button>
              {credit.join_phrase ? (
                <span className={styles.artistJoinPhrase}>{credit.join_phrase}</span>
              ) : null}
            </span>
          ))}
        </span>
      );
    }

    if (track.artist_name) {
      return (
        <button
          type="button"
          className={styles.artistCreditButton}
          onClick={(event) => {
            void handleArtistClick(track.artist_id, track.artist_name!, event);
          }}
        >
          {track.artist_name}
        </button>
      );
    }

    return null;
  }, [
    handleArtistClick,
    styles.artistContainer,
    styles.artistCreditButton,
    styles.artistJoinPhrase,
  ]);

  const markCoverFailed = useCallback((url: string | null | undefined) => {
    if (!url) return;
    setFailedCoverUrls((previous) => {
      if (previous.has(url)) return previous;
      const next = new Set(previous);
      next.add(url);
      return next;
    });
  }, []);

  const renderTitle = useCallback((track: T) => {
    const displayAlbum = shouldShowAlbum(track, showAlbum, contextAlbumTitle)
      ? getAlbumTitle(track, contextAlbumTitle)
      : null;
    const artistCredits = showArtist ? renderArtistCredits(track) : null;
    const mobileMeta = [
      artistCredits,
      showAlbum ? displayAlbum : null,
    ].filter(Boolean);

    return (
      <div className={styles.titleCell}>
        <div className={styles.titleStack}>
          <div className={styles.titleRow}>
            <Text truncate wrap={false} className={styles.titleText}>
              {getDisplayTitle(track)}
            </Text>
            {track.explicit ? <ExplicitBadge /> : null}
          </div>
          {mobileMeta.length > 0 ? (
            <div className={styles.mobileMeta}>
              {mobileMeta.map((item, index) => (
                <Text key={`${track.id}-mobile-meta-${index}`} size={200} truncate wrap={false} as="span">
                  {index > 0 ? <span className={styles.metaSeparator}>/ </span> : null}
                  {item}
                </Text>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }, [
    contextAlbumTitle,
    renderArtistCredits,
    showAlbum,
    showArtist,
    styles.metaSeparator,
    styles.mobileMeta,
    styles.titleCell,
    styles.titleRow,
    styles.titleStack,
    styles.titleText,
  ]);

  const renderCover = useCallback((track: T) => {
    const isPlaying = playingTrackId === track.id;
    const audioFile = getTrackAudioFile(track);
    const canPlay = Boolean(isDownloadedTrack(track) || audioFile || track.preview_provider_track_id);
    const coverUrl = getAlbumArtworkUrl(track);
    const renderableCoverUrl = coverUrl && !failedCoverUrls.has(coverUrl)
      ? renderableArtworkUrl(coverUrl)
      : null;

    return (
      <button
        type="button"
        className={styles.coverButton}
        aria-label={canPlay ? (isPlaying ? "Stop track" : "Play track") : undefined}
        disabled={!canPlay}
        onClick={canPlay ? (event) => { event.stopPropagation(); toggleTrackPlayback(track, event); } : undefined}
      >
        {renderableCoverUrl ? (
          <img
            src={renderableCoverUrl}
            alt=""
            className={dgCell.thumbnailSquare}
            data-cover-image
            onError={() => markCoverFailed(coverUrl)}
          />
        ) : (
          <span className={styles.coverFallback}>
            <Avatar name={getAlbumTitle(track) || track.title} shape="square" size={40} />
          </span>
        )}
        {canPlay ? (
          <span
            className={mergeClasses(styles.coverPlayOverlay, isPlaying ? styles.coverPlayOverlayActive : undefined)}
            data-cover-play
          >
            {isPlaying
              ? <Stop24Regular className={styles.playIcon} />
              : <Play24Filled className={styles.playIcon} />}
          </span>
        ) : null}
      </button>
    );
  }, [
    dgCell.thumbnailSquare,
    failedCoverUrls,
    getTrackAudioFile,
    markCoverFailed,
    playingTrackId,
    styles.coverButton,
    styles.coverFallback,
    styles.coverPlayOverlay,
    styles.coverPlayOverlayActive,
    styles.playIcon,
    toggleTrackPlayback,
  ]);

  const columns = useMemo<DataGridColumn<T>[]>(() => {
    const trackColumns: DataGridColumn<T>[] = showCover
      ? [
        {
          key: "cover",
          header: "",
          width: "52px",
          render: (track) => renderCover(track),
        },
      ]
      : [
        {
          key: "number",
          header: "#",
          width: "44px",
          align: "center",
          render: (track, index) => {
            const isPlaying = playingTrackId === track.id;
            const audioFile = getTrackAudioFile(track);
            const canPlay = Boolean(isDownloadedTrack(track) || audioFile || track.preview_provider_track_id);

            return (
              <button
                type="button"
                className={styles.numberButton}
                disabled={!canPlay}
                aria-label={canPlay ? (isPlaying ? "Stop track" : "Play track") : undefined}
                onClick={canPlay
                  ? (event) => {
                    event.stopPropagation();
                    toggleTrackPlayback(track, event);
                  }
                  : undefined}
              >
                <span className={styles.numberText} data-track-number>
                  {getDisplayNumber(track, index, numbering)}
                </span>
                {canPlay ? (
                  <span
                    className={mergeClasses(styles.playOverlay, isPlaying ? styles.playOverlayActive : undefined)}
                    data-track-play
                  >
                    {isPlaying
                      ? <Stop24Regular className={styles.playIcon} />
                      : <Play24Filled className={styles.playIcon} />}
                  </span>
                ) : null}
              </button>
            );
          },
        },
      ];

    trackColumns.push({
      key: "title",
      header: "Title",
      width: showArtist || showAlbum ? "minmax(180px, 1.35fr)" : "minmax(220px, 1fr)",
      render: (track) => renderTitle(track),
    });

    if (showArtist) {
      trackColumns.push({
        key: "artist",
        header: "Artist",
        width: "minmax(120px, 1fr)",
        minWidth: 768,
        render: (track) => (
          <span className={mergeClasses(dgCell.subtitleText, styles.linkText)}>
            {renderArtistCredits(track) || track.artist_name || "Unknown Artist"}
          </span>
        ),
      });
    }

    if (showAlbum) {
      trackColumns.push({
        key: "album",
        header: "Album",
        width: "minmax(150px, 1.2fr)",
        minWidth: 768,
        render: (track) => {
          const displayAlbum = shouldShowAlbum(track, showAlbum, contextAlbumTitle)
            ? getAlbumTitle(track, contextAlbumTitle)
            : null;
          const albumId = track.album_id ?? track.album?.id ?? null;

          return (
            <Text
              truncate
              wrap={false}
              className={albumId ? mergeClasses(dgCell.subtitleText, styles.linkText) : dgCell.subtitleText}
              onClick={albumId ? (event) => handleAlbumClick(event, track) : undefined}
            >
              {displayAlbum || "—"}
            </Text>
          );
        },
      });
    }

    if (showQuality) {
      trackColumns.push({
        key: "quality",
        header: "Quality",
        width: hasMultipleQuality ? "146px" : "92px",
        render: (track) => (
          <div className={styles.qualityContent}>
            {getQualityTags(track).map((quality) => (
              <QualityBadge key={quality} quality={quality} size="small" />
            ))}
          </div>
        ),
      });
    }

    trackColumns.push({
      key: "duration",
      header: "Duration",
      width: "64px",
      align: "right",
      render: (track) => (
        <Text size={200} className={styles.durationText}>
          {formatDurationSeconds(track.duration)}
        </Text>
      ),
    });

    if (showDownloadedColumn) {
      trackColumns.push({
        key: "downloaded",
        header: "Downloaded",
        width: "88px",
        align: "right",
        minWidth: 768,
        render: (track) => {
          const isDownloaded = isDownloadedTrack(track);
          return (
            <span aria-label={isDownloaded ? "Downloaded" : "Not downloaded"}>
              {isDownloaded ? <CheckmarkCircle16Regular className={styles.checkIcon} /> : <span className={styles.emptyCheck} />}
            </span>
          );
        },
      });
    }

    trackColumns.push({
      key: "actions",
      header: "",
      width: "44px",
      align: "right",
      render: (track) => {
        const isDownloaded = isDownloadedTrack(track);
        const canDownload = Boolean(onDownloadTrack && track.preview_provider_track_id);
        const canShowInfo = isDownloaded || getTrackFiles(track).length > 0;

        return (
          <div onClick={(event) => event.stopPropagation()}>
            <TrackRowActions
              className={styles.actionCellContent}
              isPlaying={playingTrackId === track.id}
              isMonitored={Boolean(track.is_monitored)}
              isLocked={Boolean(track.monitored_lock)}
              isDownloaded={isDownloaded}
              isDownloading={Boolean(isTrackDownloading?.(track))}
              canShowInfo={canShowInfo}
              showDownload={Boolean(onDownloadTrack)}
              onToggleMonitor={onToggleMonitor
                ? (event) => { event.stopPropagation(); onToggleMonitor(track, event); }
                : undefined}
              onToggleLock={onToggleLock
                ? (event) => { event.stopPropagation(); onToggleLock(track, event); }
                : undefined}
              onShowInfo={(event) => {
                event.stopPropagation();
                void openTrackInfo(track);
              }}
              onDownload={canDownload && onDownloadTrack
                ? (event) => { event.stopPropagation(); onDownloadTrack(track, event); }
                : undefined}
            />
          </div>
        );
      },
    });

    return trackColumns;
  }, [
    contextAlbumTitle,
    dgCell.subtitleText,
    getTrackAudioFile,
    getTrackFiles,
    handleAlbumClick,
    hasMultipleQuality,
    isTrackDownloading,
    numbering,
    onDownloadTrack,
    onToggleLock,
    onToggleMonitor,
    openTrackInfo,
    playingTrackId,
    renderArtistCredits,
    renderCover,
    renderTitle,
    showAlbum,
    showArtist,
    showCover,
    showDownloadedColumn,
    showQuality,
    styles.actionCellContent,
    styles.checkIcon,
    styles.durationText,
    styles.emptyCheck,
    styles.linkText,
    styles.numberButton,
    styles.numberText,
    styles.playIcon,
    styles.playOverlay,
    styles.playOverlayActive,
    styles.qualityContent,
    toggleTrackPlayback,
  ]);

  const renderBeforeRow = useCallback((track: T, index: number, previousTrack?: T) => {
    if (!showVolumeHeaders || !hasMultipleVolumes) {
      return null;
    }

    const currentVolume = track.volume_number || 1;
    const previousVolume = previousTrack?.volume_number || currentVolume;
    if (index > 0 && currentVolume === previousVolume) {
      return null;
    }

    return <span>Volume {currentVolume}</span>;
  }, [hasMultipleVolumes, showVolumeHeaders]);

  const renderRowDetail = useCallback((track: T) => {
    if (playingTrackId !== track.id) {
      return null;
    }

    return (
      <div className={styles.player}>
        <AudioPlayer
          src={getPlaybackSrc(track)}
          hlsSrc={getPlaybackHlsSrc(track)}
          knownDuration={track.duration}
          onEnded={() => setPlayingTrackId(null)}
          onPlaybackError={() => {
            void handleTrackPlaybackError(track);
          }}
        />
      </div>
    );
  }, [
    getPlaybackHlsSrc,
    getPlaybackSrc,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    styles.player,
  ]);

  if (!tracks || tracks.length === 0) {
    return null;
  }

  return (
    <>
      <DataGrid
        columns={columns}
        items={tracks}
        getRowKey={(track) => track.id}
        onRowClick={onTrackClick}
        selection={selection}
        renderBeforeRow={renderBeforeRow}
        renderRowDetail={renderRowDetail}
        getRowClassName={(track) => playingTrackId === track.id ? styles.rowPlaying : undefined}
        disableStickyHeader={disableStickyHeader}
      />

      {infoTrack ? (
        <TrackInfoDialog
          open={Boolean(infoTrack)}
          onClose={() => setInfoTrack(null)}
          trackTitle={getDisplayTitle(infoTrack)}
          artistName={infoTrack.artist_name || contextArtistName || undefined}
          albumTitle={getAlbumTitle(infoTrack, contextAlbumTitle) || undefined}
          trackNumber={infoTrack.track_number || undefined}
          duration={infoTrack.duration}
          audioQuality={infoTrack.quality}
          files={infoTrack.files || []}
        />
      ) : null}
    </>
  );
};

export default TrackList;
