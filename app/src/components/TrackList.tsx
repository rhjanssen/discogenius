import { useState, type MouseEvent } from "react";
import {
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import { TrackRowActions } from "@/components/tracks/TrackRowActions";
import { useTrackPlayback } from "@/hooks/useTrackPlayback";
import { getAlbumCover } from "@/utils/tidalImages";
import { formatDurationSeconds } from "@/utils/format";
import type { TrackListItem } from "@/types/track-list";

type TrackNumbering = "track" | "index";

interface TrackListProps<T extends TrackListItem = TrackListItem> {
  tracks: T[];
  numbering?: TrackNumbering;
  showCover?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  showVolumeHeaders?: boolean;
  contextArtistName?: string | null;
  contextAlbumTitle?: string | null;
  onTrackClick?: (track: T) => void;
  onDownloadTrack?: (track: T, event?: MouseEvent<HTMLButtonElement>) => void;
  onToggleMonitor?: (track: T, event?: MouseEvent<HTMLButtonElement>) => void;
  onToggleLock?: (track: T, event?: MouseEvent<HTMLButtonElement>) => void;
  isTrackDownloading?: (track: T) => boolean;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
  },
  volumeHeader: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS}`,
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    scrollMarginTop: `calc(${tokens.spacingVerticalXXL} * 2)`,
    transition: `background-color ${tokens.durationNormal} ${tokens.curveEasyEase}`,
  },
  rowClickable: {
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },
  },
  number: {
    width: "28px",
    flexShrink: 0,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  cover: {
    width: "44px",
    height: "44px",
    borderRadius: tokens.borderRadiusSmall,
    objectFit: "cover",
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  coverPlaceholder: {
    backgroundColor: tokens.colorNeutralBackground3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: tokens.fontWeightSemibold,
    "@media (max-width: 639px)": {
      whiteSpace: "normal",
      wordBreak: "break-word",
    },
  },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
    minWidth: 0,
  },
  metaText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  separator: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  qualityBadge: {
    transform: "scale(0.9)",
    transformOrigin: "left center",
  },
  trailing: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    marginLeft: "auto",
    flexShrink: 0,
    "@media (max-width: 639px)": {
      width: "100%",
      marginLeft: 0,
      justifyContent: "space-between",
      paddingLeft: `calc(28px + ${tokens.spacingHorizontalS})`,
    },
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  playerRow: {
    padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS}`,
  },
});

const isTruthy = (value: unknown) => Boolean(value);

const getAlbumTitle = (track: TrackListItem, fallback?: string | null) =>
  track.album?.title ?? track.album_title ?? fallback ?? null;
const getAlbumCoverId = (track: TrackListItem) => track.album?.cover_id ?? null;
const getDisplayTitle = (track: TrackListItem) =>
  track.version ? `${track.title} (${track.version})` : track.title;

const getDisplayNumber = (track: TrackListItem, index: number, numbering: TrackNumbering) => {
  if (numbering === "index") {
    return index + 1;
  }

  return track.track_number || index + 1;
};

const shouldShowArtist = (
  track: TrackListItem,
  showArtist: boolean,
  contextArtistName?: string | null,
) => {
  if (!showArtist || !track.artist_name) {
    return false;
  }

  return !contextArtistName || track.artist_name !== contextArtistName;
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
  showVolumeHeaders = false,
  contextArtistName,
  contextAlbumTitle,
  onTrackClick,
  onDownloadTrack,
  onToggleMonitor,
  onToggleLock,
  isTrackDownloading,
}: TrackListProps<T>) => {
  const styles = useStyles();
  const {
    getPlaybackSrc,
    getTrackAudioFile,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  } = useTrackPlayback();
  const [infoTrack, setInfoTrack] = useState<T | null>(null);

  return (
    <>
      <div className={styles.root}>
        {tracks.map((track, index) => {
          const displayNumber = getDisplayNumber(track, index, numbering);
          const isPlaying = playingTrackId === track.id;
          const audioFile = getTrackAudioFile(track);
          const isDownloaded = Boolean(track.is_downloaded ?? track.downloaded);
          const isMonitored = isTruthy(track.is_monitored ?? track.monitor);
          const isLocked = isTruthy(track.monitor_locked ?? track.monitor_lock);
          const displayArtist = shouldShowArtist(track, showArtist, contextArtistName) ? track.artist_name : null;
          const displayAlbum = shouldShowAlbum(track, showAlbum, contextAlbumTitle)
            ? getAlbumTitle(track, contextAlbumTitle)
            : null;
          const durationText = formatDurationSeconds(track.duration);
          const coverUrl = showCover
            ? getAlbumCover(getAlbumCoverId(track), "tiny")
            : null;
          const isDownloading = Boolean(isTrackDownloading?.(track));
          const currentVolume = track.volume_number || 1;
          const previousVolume = index > 0 ? (tracks[index - 1]?.volume_number || 1) : currentVolume;
          const showVolumeHeader = showVolumeHeaders && (index === 0 || currentVolume !== previousVolume);

          return (
            <div key={track.id}>
              {showVolumeHeader ? (
                <div className={styles.volumeHeader}>Volume {currentVolume}</div>
              ) : null}

              <div
                className={mergeClasses(styles.row, onTrackClick ? styles.rowClickable : undefined)}
                data-album-track-id={track.id}
                onClick={onTrackClick ? () => onTrackClick(track) : undefined}
              >
                <Text className={styles.number}>{displayNumber}</Text>

                {showCover ? (
                  coverUrl ? (
                    <img src={coverUrl} alt={displayAlbum || track.title} className={styles.cover} />
                  ) : (
                    <div className={mergeClasses(styles.cover, styles.coverPlaceholder)} />
                  )
                ) : null}

                <div className={styles.main}>
                  <div className={styles.titleRow}>
                    <Text className={styles.title}>{getDisplayTitle(track)}</Text>
                    {track.explicit ? <ExplicitBadge /> : null}
                  </div>

                  <div className={styles.metaRow}>
                    {displayArtist ? <Text className={styles.metaText}>{displayArtist}</Text> : null}
                    {displayArtist && displayAlbum ? <Text className={styles.separator}>•</Text> : null}
                    {displayAlbum ? <Text className={styles.metaText}>{displayAlbum}</Text> : null}
                    {(displayArtist || displayAlbum) ? <Text className={styles.separator}>•</Text> : null}
                    <Text className={styles.metaText}>{durationText}</Text>
                    {track.quality ? <Text className={styles.separator}>•</Text> : null}
                    {track.quality ? <QualityBadge quality={track.quality} className={styles.qualityBadge} /> : null}
                  </div>
                </div>

                <div className={styles.trailing}>
                  <TrackRowActions
                    className={styles.actions}
                    isPlaying={isPlaying}
                    isMonitored={isMonitored}
                    isLocked={isLocked}
                    isDownloaded={isDownloaded}
                    isDownloading={isDownloading}
                    canShowInfo={Boolean(audioFile)}
                    onPlay={(event) => toggleTrackPlayback(track, event)}
                    onToggleMonitor={onToggleMonitor
                      ? (event) => {
                        event.stopPropagation();
                        onToggleMonitor(track, event);
                      }
                      : undefined}
                    onToggleLock={onToggleLock
                      ? (event) => {
                        event.stopPropagation();
                        onToggleLock(track, event);
                      }
                      : undefined}
                    onShowInfo={(event) => {
                      event.stopPropagation();
                      setInfoTrack(track);
                    }}
                    onDownload={onDownloadTrack
                      ? (event) => {
                        event.stopPropagation();
                        onDownloadTrack(track, event);
                      }
                      : undefined}
                  />
                </div>
              </div>

              {isPlaying ? (
                <div className={styles.playerRow}>
                  <AudioPlayer
                    src={getPlaybackSrc(track)}
                    knownDuration={track.duration}
                    onEnded={() => setPlayingTrackId(null)}
                    onPlaybackError={() => {
                      void handleTrackPlaybackError(track);
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {infoTrack ? (
        <TrackInfoDialog
          open={Boolean(infoTrack)}
          onClose={() => setInfoTrack(null)}
          trackTitle={getDisplayTitle(infoTrack)}
          artistName={infoTrack.artist_name || contextArtistName}
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
