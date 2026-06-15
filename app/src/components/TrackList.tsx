import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Link,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Play24Regular, Stop24Filled } from "@fluentui/react-icons";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import { TrackRowActions } from "@/components/tracks/TrackRowActions";
import { useTrackPlayback } from "@/hooks/useTrackPlayback";
import { formatDurationSeconds } from "@/utils/format";
import { isSpatialAudioQuality, normalizeQualityTag } from "@/utils/spatialAudio";
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
    gap: tokens.spacingHorizontalSNudge,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalS}`,
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
  numberPlay: {
    width: "28px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: tokens.spacingVerticalXXS,
    "@media (min-width: 768px)": {
      width: "32px",
      paddingTop: 0,
    },
  },
  numberPlayActive: {
    cursor: "pointer",
  },
  numberText: {
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  playIcon: {
    fontSize: "20px",
    color: tokens.colorNeutralForeground1,
    display: "block",
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
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
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
  // Artist shown below the title on mobile (desktop uses its own column).
  mobileArtistRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXXS,
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },
  // Compact cluster on the right of every row: quality + duration + action,
  // the same layout on desktop and mobile.
  rightGroup: {
    display: "flex",
    alignItems: "center",
    // Tight, symmetric gaps between quality · duration · action.
    gap: tokens.spacingHorizontalSNudge,
    marginLeft: "auto",
    flexShrink: 0,
    paddingTop: tokens.spacingVerticalXXS,
    "@media (min-width: 768px)": {
      paddingTop: 0,
    },
  },
  qualityCluster: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  durationText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    flexShrink: 0,
    // Right-aligned but only as wide as the longest duration, so there's no
    // dead space between the quality pills and the time.
    minWidth: "28px",
    textAlign: "right",
  },
  desktopArtistColumn: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "block",
      width: "200px",
      flexShrink: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: tokens.fontSizeBase200,
      color: tokens.colorNeutralForeground3,
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
      width: "164px",
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
    })
    // Stereo first, spatial (Dolby Atmos) last — matches the album-header order.
    .sort((a, b) =>
      Number(isSpatialAudioQuality(normalizeQualityTag(a))) - Number(isSpatialAudioQuality(normalizeQualityTag(b))));
};

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
  const [hoveredTrackId, setHoveredTrackId] = useState<string | number | null>(null);

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
                onMouseEnter={() => setHoveredTrackId(track.id)}
                onMouseLeave={() => setHoveredTrackId((current) => (current === track.id ? null : current))}
              >
                {/* Number that turns into a play/stop control: shown on row hover
                    (desktop) or while playing; tap the cell to play on mobile. */}
                <div
                  className={mergeClasses(styles.numberPlay, canPlay ? styles.numberPlayActive : undefined)}
                  role={canPlay ? "button" : undefined}
                  aria-label={canPlay ? (isPlaying ? "Stop track" : "Play track") : undefined}
                  onClick={canPlay ? (event) => { event.stopPropagation(); toggleTrackPlayback(track, event); } : undefined}
                >
                  {canPlay && (hoveredTrackId === track.id || isPlaying) ? (
                    isPlaying
                      ? <Stop24Filled className={styles.playIcon} />
                      : <Play24Regular className={styles.playIcon} />
                  ) : (
                    <span className={styles.numberText}>{displayNumber}</span>
                  )}
                </div>

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
                  {/* Artist always shows (no same-as-album suppression); it sits
                      below the title on mobile. */}
                  {showArtist ? (
                    <div className={styles.mobileArtistRow}>
                      {renderArtistCredits(track)}
                    </div>
                  ) : null}
                </div>

                {/* Artist in its own column on desktop. */}
                {showArtist ? (
                  <div className={styles.desktopArtistColumn}>
                    {renderArtistCredits(track)}
                  </div>
                ) : null}

                {showAlbum ? (
                  <div className={styles.desktopAlbumColumn}>
                    <Text className={styles.desktopMetaText}>{displayAlbum || "—"}</Text>
                  </div>
                ) : null}

                {/* Compact right cluster: quality + duration + the toggling action. */}
                <div className={styles.rightGroup}>
                  {showQuality && qualityTags.length > 0 ? (
                    <div className={styles.qualityCluster}>
                      {qualityTags.map((quality) => (
                        <QualityBadge key={quality} quality={quality} size="small" className={styles.qualityBadge} />
                      ))}
                    </div>
                  ) : null}
                  <Text className={styles.durationText}>{durationText}</Text>
                  <TrackRowActions
                    className={styles.actions}
                    isMonitored={isMonitored}
                    isLocked={isLocked}
                    isDownloaded={isDownloaded}
                    isDownloading={isDownloading}
                    canShowInfo={Boolean(audioFile)}
                    showDownload={Boolean(onDownloadTrack)}
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
