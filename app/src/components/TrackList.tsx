import { useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/services/api";
import {
  Link,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Play24Filled, Stop24Regular } from "@fluentui/react-icons";
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
  table: {
    width: "100%",
    // Tighten cell gutters on mobile so the title isn't starved of width, but
    // give the two-line rows a little vertical breathing room.
    "@media (max-width: 767px)": {
      "& [role=row] > *": {
        paddingLeft: tokens.spacingHorizontalXXS,
        paddingRight: tokens.spacingHorizontalXXS,
        paddingTop: tokens.spacingVerticalS,
        paddingBottom: tokens.spacingVerticalS,
      },
    },
  },
  // Header is a desktop-only orientation row; mobile stays compact like TIDAL.
  headerRow: {
    display: "none",
    "@media (min-width: 768px)": {
      display: "flex",
    },
  },
  headerLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  headerLabelRight: {
    display: "block",
    width: "100%",
    textAlign: "right",
  },
  headerLabelCenter: {
    display: "block",
    width: "100%",
    textAlign: "center",
  },

  // A full-width separator row that introduces each disc/volume.
  volumeRow: {
    ":hover": {
      backgroundColor: "transparent",
    },
  },
  volumeCell: {
    flex: "1 1 0px",
  },
  volumeLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalXXS,
  },

  // Body row: on hover the index number fades out and the play affordance fades in.
  row: {
    transitionProperty: "background-color, backdrop-filter, transform, box-shadow",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      boxShadow: tokens.shadow8,
      transform: "translateY(-1px)",
      position: "relative",
      zIndex: 1,
    },
    "&:hover [data-row-number]": {
      opacity: 0,
    },
    "&:hover [data-row-play]": {
      opacity: 1,
      pointerEvents: "auto",
    },
  },
  rowClickable: {
    cursor: "pointer",
  },
  rowPlaying: {
    borderBottom: "none",
  },

  // Columns — fixed widths on the rails, equal flex on title + artist/album.
  indexCell: {
    flex: "0 0 26px",
    justifyContent: "center",
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: 0,
    position: "relative",
    "@media (min-width: 768px)": {
      flex: "0 0 36px",
    },
  },
  indexPlayable: {
    cursor: "pointer",
  },
  numberText: {
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    transition: `opacity ${tokens.durationFaster} ${tokens.curveEasyEase}`,
  },
  playReveal: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "28px",
    height: "28px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: 0,
    pointerEvents: "none",
    transition: `opacity ${tokens.durationFaster} ${tokens.curveEasyEase}, background-color ${tokens.durationFast} ${tokens.curveEasyEase}`,
    borderRadius: tokens.borderRadiusMedium,
    "&:hover": {
      backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1Hover} 80%, transparent)`,
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
    },
  },
  playRevealActive: {
    opacity: 1,
    pointerEvents: "auto",
  },
  playIcon: {
    fontSize: "20px",
    color: tokens.colorNeutralForeground1,
    display: "block",
  },

  cover: {
    width: "36px",
    height: "36px",
    borderRadius: tokens.borderRadiusSmall,
    objectFit: "cover",
    flexShrink: 0,
    marginRight: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground3,
  },

  titleStack: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    width: "100%",
    rowGap: tokens.spacingVerticalXXS,
  },
  titleLine: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  titleText: {
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
    // Smaller on mobile where the artist stacks underneath; full size on desktop.
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    "@media (min-width: 768px)": {
      fontSize: tokens.fontSizeBase300,
      lineHeight: tokens.lineHeightBase300,
    },
  },
  // Artist shown beneath the title on mobile only (its own column on desktop).
  mobileArtist: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },

  // Desktop-only columns.
  desktopColumn: {
    display: "none",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    "@media (min-width: 768px)": {
      display: "flex",
      paddingRight: tokens.spacingHorizontalM,
    },
  },
  truncate: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  qualityCellSingle: {
    flex: "0 0 auto",
    justifyContent: "flex-start",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXXS,
    "@media (min-width: 768px)": {
      flex: "0 0 80px",
      paddingRight: tokens.spacingHorizontalM,
    },
  },
  qualityCellMultiple: {
    flex: "0 0 auto",
    justifyContent: "flex-start",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXXS,
    "@media (min-width: 768px)": {
      flex: "0 0 140px",
      paddingRight: tokens.spacingHorizontalM,
    },
  },
  timeCell: {
    flex: "0 0 auto",
    justifyContent: "flex-start",
    alignItems: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: "tabular-nums",
    "@media (min-width: 768px)": {
      flex: "0 0 56px",
    },
  },
  actionsCell: {
    flex: "0 0 auto",
    justifyContent: "flex-end",
    alignItems: "center",
    "@media (min-width: 768px)": {
      flex: "0 0 36px",
    },
  },

  playerRow: {
    width: "100%",
    ":hover": {
      backgroundColor: "transparent",
    },
  },
  playerCell: {
    flex: "1 1 0px",
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: 0,
    paddingRight: 0,
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

  // How many flex/rail columns a full-width row (volume / player) should span.
  const columnSpan = 3
    + (showArtist ? 1 : 0)
    + (showAlbum ? 1 : 0)
    + (showQuality ? 1 : 0);
  const hasMultipleVolumes = tracks.some((track) => (track.volume_number || 1) !== (tracks[0]?.volume_number || 1));
  const hasMultipleQuality = tracks.some((track) => getQualityTags(track).length > 1);
  const qualityCellClass = hasMultipleQuality ? styles.qualityCellMultiple : styles.qualityCellSingle;

  const renderArtistCredits = (track: T) => {
    const handleArtistClick = async (artistId: string | undefined, artistName: string, event: MouseEvent) => {
      event.stopPropagation();
      if (artistId) {
        navigate(`/artist/${artistId}`);
      } else if (artistName) {
        try {
          const res = await api.search(artistName, ['artists'], 1);
          if (res.success && res.results?.artists && res.results.artists.length > 0) {
            navigate(`/artist/${res.results.artists[0].id}`);
          } else {
            navigate(`/search?q=${encodeURIComponent(artistName)}`);
          }
        } catch {
          navigate(`/search?q=${encodeURIComponent(artistName)}`);
        }
      }
    };

    if (track.artist_credits && track.artist_credits.length > 0) {
      return (
        <span className={styles.artistContainer}>
          {track.artist_credits.map((credit, idx) => (
            <span key={`${credit.id}-${idx}`}>
              <button
                type="button"
                className={styles.artistCreditButton}
                onClick={(e) => handleArtistClick(credit.id, credit.name, e)}
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
          onClick={(e) => handleArtistClick(track.artist_id, track.artist_name!, e)}
        >
          {track.artist_name}
        </button>
      );
    }

    return null;
  };

  return (
    <>
      <Table className={styles.table} noNativeElements size="small" aria-label="Tracklist">
        <TableHeader>
          <TableRow className={styles.headerRow}>
            <TableHeaderCell className={styles.indexCell}>
              <span className={mergeClasses(styles.headerLabel, styles.headerLabelCenter)}>#</span>
            </TableHeaderCell>
            <TableHeaderCell>
              <span className={styles.headerLabel}>Title</span>
            </TableHeaderCell>
            {showArtist ? (
              <TableHeaderCell>
                <span className={styles.headerLabel}>Artist</span>
              </TableHeaderCell>
            ) : null}
            {showAlbum ? (
              <TableHeaderCell>
                <span className={styles.headerLabel}>Album</span>
              </TableHeaderCell>
            ) : null}
            {showQuality ? (
              <TableHeaderCell className={qualityCellClass}>
                <span className={styles.headerLabel}>Quality</span>
              </TableHeaderCell>
            ) : null}
            <TableHeaderCell className={styles.timeCell}>
              <span className={styles.headerLabel}>Duration</span>
            </TableHeaderCell>
            <TableHeaderCell className={styles.actionsCell} />
          </TableRow>
        </TableHeader>

        <TableBody>
          {tracks.map((track, index) => {
            const displayNumber = getDisplayNumber(track, index, numbering);
            const isPlaying = playingTrackId === track.id;
            const audioFile = getTrackAudioFile(track);
            const isDownloaded = Boolean(track.is_downloaded ?? track.downloaded);
            const canPlay = Boolean(isDownloaded || audioFile || track.preview_provider_track_id);
            const canDownload = Boolean(onDownloadTrack && track.preview_provider_track_id);
            const isMonitored = Boolean(track.is_monitored);
            const isLocked = Boolean(track.monitored_lock);
            const displayAlbum = shouldShowAlbum(track, showAlbum, contextAlbumTitle)
              ? getAlbumTitle(track, contextAlbumTitle)
              : null;
            const qualityTags = getQualityTags(track);
            const durationText = formatDurationSeconds(track.duration);
            const coverUrl = showCover ? getAlbumArtworkUrl(track) : null;
            const isDownloading = Boolean(isTrackDownloading?.(track));
            const currentVolume = track.volume_number || 1;
            const previousVolume = index > 0 ? (tracks[index - 1]?.volume_number || 1) : currentVolume;
            const showVolumeHeader = showVolumeHeaders && hasMultipleVolumes && (index === 0 || currentVolume !== previousVolume);
            const artistCredits = showArtist ? renderArtistCredits(track) : null;

            return (
              <FragmentRow key={track.id}>
                {showVolumeHeader ? (
                  <TableRow className={styles.volumeRow}>
                    <TableCell className={styles.volumeCell} style={{ flex: `1 1 ${columnSpan * 100}%` }}>
                      <span className={styles.volumeLabel}>Volume {currentVolume}</span>
                    </TableCell>
                  </TableRow>
                ) : null}

                <TableRow
                  className={mergeClasses(
                    styles.row,
                    onTrackClick ? styles.rowClickable : undefined,
                    isPlaying ? styles.rowPlaying : undefined
                  )}
                  data-album-track-id={track.id}
                  onClick={onTrackClick ? () => onTrackClick(track) : undefined}
                >
                  {/* Number ↔ play/stop. The number fades on hover; play fades in. */}
                  <TableCell
                    className={mergeClasses(styles.indexCell, canPlay ? styles.indexPlayable : undefined)}
                    role={canPlay ? "button" : undefined}
                    aria-label={canPlay ? (isPlaying ? "Stop track" : "Play track") : undefined}
                    onClick={canPlay
                      ? (event) => { event.stopPropagation(); toggleTrackPlayback(track, event); }
                      : undefined}
                  >
                    <span className={styles.numberText} data-row-number>
                      {displayNumber}
                    </span>
                    {canPlay ? (
                      <span
                        className={mergeClasses(styles.playReveal, isPlaying ? styles.playRevealActive : undefined)}
                        data-row-play
                      >
                        {isPlaying
                          ? <Stop24Regular className={styles.playIcon} />
                          : <Play24Filled className={styles.playIcon} />}
                      </span>
                    ) : null}
                  </TableCell>

                  <TableCell>
                    {coverUrl ? <img src={coverUrl} alt="" className={styles.cover} /> : null}
                    <div className={styles.titleStack}>
                      <div className={styles.titleLine}>
                        <Text truncate wrap={false} className={styles.titleText}>
                          {getDisplayTitle(track)}
                        </Text>
                        {track.explicit ? <ExplicitBadge /> : null}
                      </div>
                      {artistCredits ? (
                        <span className={styles.mobileArtist}>{artistCredits}</span>
                      ) : null}
                    </div>
                  </TableCell>

                  {showArtist ? (
                    <TableCell className={mergeClasses(styles.desktopColumn, styles.truncate)}>
                      {artistCredits}
                    </TableCell>
                  ) : null}

                  {showAlbum ? (
                    <TableCell className={mergeClasses(styles.desktopColumn, styles.truncate)}>
                      {displayAlbum || "—"}
                    </TableCell>
                  ) : null}

                  {showQuality ? (
                    <TableCell className={qualityCellClass}>
                      {qualityTags.map((quality) => (
                        <QualityBadge key={quality} quality={quality} size="small" />
                      ))}
                    </TableCell>
                  ) : null}

                  <TableCell className={styles.timeCell}>{durationText}</TableCell>

                  <TableCell className={styles.actionsCell}>
                    <TrackRowActions
                      isMonitored={isMonitored}
                      isLocked={isLocked}
                      isDownloaded={isDownloaded}
                      isDownloading={isDownloading}
                      canShowInfo={Boolean(audioFile)}
                      showDownload={Boolean(onDownloadTrack)}
                      onToggleMonitor={onToggleMonitor
                        ? (event) => { event.stopPropagation(); onToggleMonitor(track, event); }
                        : undefined}
                      onToggleLock={onToggleLock
                        ? (event) => { event.stopPropagation(); onToggleLock(track, event); }
                        : undefined}
                      onShowInfo={(event) => { event.stopPropagation(); setInfoTrack(track); }}
                      onDownload={canDownload && onDownloadTrack
                        ? (event) => { event.stopPropagation(); onDownloadTrack(track, event); }
                        : undefined}
                    />
                  </TableCell>
                </TableRow>

                {isPlaying ? (
                  <TableRow className={styles.playerRow}>
                    <TableCell className={styles.playerCell} style={{ flex: `1 1 ${columnSpan * 100}%` }}>
                      <AudioPlayer
                        src={getPlaybackSrc(track)}
                        hlsSrc={getPlaybackHlsSrc(track)}
                        knownDuration={track.duration}
                        onEnded={() => setPlayingTrackId(null)}
                        onPlaybackError={() => { void handleTrackPlaybackError(track); }}
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
              </FragmentRow>
            );
          })}
        </TableBody>
      </Table>

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

// Groups a track's optional volume header, its row, and its player row without
// adding DOM (Table only expects row children).
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export default TrackList;
