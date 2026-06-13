import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Link,
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
import { formatDurationSeconds } from "@/utils/format";
import type { TrackListItem } from "@/types/track-list";

type TrackNumbering = "track" | "index";

interface TrackListProps<T extends TrackListItem = TrackListItem> {
  tracks: T[];
  numbering?: TrackNumbering;
  showCover?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  showQuality?: boolean;
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
    flexWrap: "nowrap",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    scrollMarginTop: `calc(${tokens.spacingVerticalXXL} * 2)`,
    transition: `background-color ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    "@media (min-width: 768px)": {
      alignItems: "center",
    },
  },
  rowClickable: {
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },
  },
  number: {
    width: "28px",
    paddingTop: tokens.spacingVerticalXXS,
    flexShrink: 0,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    "@media (min-width: 768px)": {
      paddingTop: 0,
    },
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
    display: "inline-flex",
    flexShrink: 0,
  },
  trailing: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    marginLeft: "auto",
    paddingTop: tokens.spacingVerticalXXS,
    flexShrink: 0,
    "@media (min-width: 768px)": {
      alignItems: "center",
      paddingTop: 0,
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
  titleColumn: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  mobileMetaRow: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    minWidth: 0,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },
  desktopArtistColumn: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "block",
      width: "220px",
      flexShrink: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
      boxSizing: "border-box",
    },
  },
  desktopAlbumColumn: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "block",
      width: "220px",
      flexShrink: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
      boxSizing: "border-box",
    },
  },
  desktopQualityColumn: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "flex",
      width: "110px",
      flexShrink: 0,
      alignItems: "center",
      columnGap: tokens.spacingHorizontalXS,
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
      boxSizing: "border-box",
    },
  },
  desktopDurationColumn: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "block",
      width: "60px",
      flexShrink: 0,
      textAlign: "right",
      paddingLeft: tokens.spacingHorizontalS,
      paddingRight: tokens.spacingHorizontalS,
      boxSizing: "border-box",
    },
  },
  desktopMetaText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  artistLink: {
    display: "inline",
    padding: 0,
    border: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    textDecoration: "none",
    ":hover": {
      textDecoration: "underline",
      opacity: 0.8,
    },
  },
  artistJoinPhrase: {
    color: tokens.colorNeutralForeground3,
    marginRight: tokens.spacingHorizontalXS,
    marginLeft: tokens.spacingHorizontalXS,
  },
  artistContainer: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

const isTruthy = (value: unknown) => Boolean(value);

const getAlbumTitle = (track: TrackListItem, fallback?: string | null) =>
  track.album?.title ?? track.album_title ?? fallback ?? null;
const getAlbumArtworkUrl = (track: TrackListItem) =>
  track.cover_url ?? track.album_cover ?? track.album?.cover_id ?? null;
const getDisplayTitle = (track: TrackListItem) =>
  track.version ? `${track.title} (${track.version})` : track.title;
const getQualityTags = (track: TrackListItem): string[] => {
  const values = Array.isArray(track.qualityTags) && track.qualityTags.length > 0
    ? track.qualityTags
    : track.quality
      ? [track.quality]
      : [];
  const seen = new Set<string>();
  return values
    .map((quality) => String(quality || "").trim())
    .filter((quality) => {
      const key = quality.toUpperCase();
      if (!quality || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

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
  showQuality = true,
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

  const renderArtistCredits = (track: T) => {
    const handleArtistClick = (artistId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      navigate(`/artist/${artistId}`);
    };

    if (track.artist_credits && track.artist_credits.length > 0) {
      return (
        <span className={styles.artistContainer}>
          {track.artist_credits.map((credit, idx) => (
            <span key={`${credit.id}-${idx}`}>
              {credit.id ? (
                <Link
                  inline
                  className={styles.artistLink}
                  onClick={(e) => handleArtistClick(credit.id, e)}
                >
                  {credit.name}
                </Link>
              ) : (
                <Text>{credit.name}</Text>
              )}
              {credit.join_phrase ? (
                <span className={styles.artistJoinPhrase}>{credit.join_phrase}</span>
              ) : null}
            </span>
          ))}
        </span>
      );
    }

    if (track.artist_name) {
      return track.artist_id ? (
        <Link
          inline
          className={styles.artistLink}
          onClick={(e) => handleArtistClick(track.artist_id!, e)}
        >
          {track.artist_name}
        </Link>
      ) : (
        <Text>{track.artist_name}</Text>
      );
    }

    return null;
  };

  return (
    <>
      <div className={styles.root}>
        {tracks.map((track, index) => {
          const displayNumber = getDisplayNumber(track, index, numbering);
          const isPlaying = playingTrackId === track.id;
          const audioFile = getTrackAudioFile(track);
          const isDownloaded = Boolean(track.is_downloaded ?? track.downloaded);
          const canPlay = Boolean(isDownloaded || audioFile || track.preview_provider_track_id);
          const canDownload = Boolean(onDownloadTrack && track.preview_provider_track_id);
          const isMonitored = isTruthy(track.is_monitored);
          const isLocked = isTruthy(track.monitored_lock);
          const displayArtist = shouldShowArtist(track, showArtist, contextArtistName) ? track.artist_name : null;
          const displayAlbum = shouldShowAlbum(track, showAlbum, contextAlbumTitle)
            ? getAlbumTitle(track, contextAlbumTitle)
            : null;
          const qualityTags = getQualityTags(track);
          const durationText = formatDurationSeconds(track.duration);
          const coverUrl = showCover ? getAlbumArtworkUrl(track) : null;
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

                <div className={styles.titleColumn}>
                  <div className={styles.titleRow}>
                    <Text className={styles.title}>{getDisplayTitle(track)}</Text>
                    {track.explicit ? <ExplicitBadge /> : null}
                  </div>

                  <div className={styles.mobileMetaRow}>
                    {displayArtist ? renderArtistCredits(track) : null}
                    {displayArtist && displayAlbum ? <Text className={styles.separator}>•</Text> : null}
                    {displayAlbum ? <Text className={styles.metaText}>{displayAlbum}</Text> : null}
                    {(displayArtist || displayAlbum) ? <Text className={styles.separator}>•</Text> : null}
                    <Text className={styles.metaText}>{durationText}</Text>
                    {showQuality && qualityTags.length > 0 ? <Text className={styles.separator}>•</Text> : null}
                    {showQuality && qualityTags.map((quality) => (
                      <QualityBadge key={quality} quality={quality} size="small" className={styles.qualityBadge} />
                    ))}
                  </div>
                </div>

                {showArtist ? (
                  <div className={styles.desktopArtistColumn}>
                    {renderArtistCredits(track)}
                  </div>
                ) : null}

                {showAlbum ? (
                  <div className={styles.desktopAlbumColumn}>
                    {displayAlbum ? (
                      <Text className={styles.desktopMetaText}>{displayAlbum}</Text>
                    ) : (
                      <Text className={styles.desktopMetaText}>—</Text>
                    )}
                  </div>
                ) : null}

                {showQuality ? (
                  <div className={styles.desktopQualityColumn}>
                    {qualityTags.length > 0 ? (
                      qualityTags.map((quality) => (
                        <QualityBadge key={quality} quality={quality} size="small" className={styles.qualityBadge} />
                      ))
                    ) : (
                      <Text className={styles.desktopMetaText}>—</Text>
                    )}
                  </div>
                ) : null}

                <div className={styles.desktopDurationColumn}>
                  <Text className={styles.desktopMetaText}>{durationText}</Text>
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
                    showDownload={Boolean(onDownloadTrack)}
                    onPlay={canPlay ? (event) => toggleTrackPlayback(track, event) : undefined}
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
                    onDownload={canDownload && onDownloadTrack
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
                    hlsSrc={getPlaybackHlsSrc(track)}
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
