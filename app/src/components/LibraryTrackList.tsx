import { Fragment, useCallback, useMemo, useState, type MouseEvent } from "react";
import {
  Avatar,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CheckmarkCircle16Regular, Play24Filled, Stop24Regular } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { TrackRowActions } from "@/components/tracks/TrackRowActions";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import { useTrackPlayback } from "@/hooks/useTrackPlayback";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { api } from "@/services/api";
import type { TrackListItem as Track } from "@/types/track-list";
import { navigateToAlbum, navigateToAlbumTrack } from "@/utils/albumNavigation";
import { formatDurationSeconds } from "@/utils/format";
import { renderableArtworkUrl } from "@/utils/artwork";

type TrackFiles = NonNullable<Track["files"]>;

interface LibraryTrackListProps {
  tracks: Track[];
  showArtist?: boolean;
  showAlbum?: boolean;
  showCover?: boolean;
  selection?: {
    selectedRowIds: Array<string | number>;
    onSelectionChange: (selectedRowIds: Array<string | number>) => void;
    getSelectionLabel?: (track: Track) => string;
  };
}

const useStyles = makeStyles({
  root: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
  },
  desktopTable: {
    display: "none",
    width: "100%",
    "@media (min-width: 768px)": {
      display: "block",
    },
  },
  headerRow: {
    display: "flex",
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
  row: {
    cursor: "pointer",
    display: "flex",
    transitionProperty: "background-color, backdrop-filter, transform, box-shadow",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      boxShadow: tokens.shadow8,
      transform: "translateY(-1px)",
      position: "relative",
      zIndex: 1,
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
  linkText: {
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    ":hover": {
      color: tokens.colorNeutralForeground1,
    },
  },
  coverCell: {
    flex: "0 0 52px",
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  titleCell: {
    flex: "1.25 1 0px",
    minWidth: 0,
    alignItems: "center",
  },
  artistCell: {
    flex: "1 1 0px",
    minWidth: 0,
    alignItems: "center",
    paddingRight: tokens.spacingHorizontalM,
  },
  albumCell: {
    flex: "1.45 1 0px",
    minWidth: 0,
    alignItems: "center",
    paddingRight: tokens.spacingHorizontalM,
  },
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
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
  },
  metaRow: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    minWidth: 0,
  },
  metaText: {
    color: tokens.colorNeutralForeground3,
  },
  separator: {
    color: tokens.colorNeutralForeground4,
  },
  qualityBadge: {
    display: "inline-flex",
    flexShrink: 0,
  },
  explicitBadge: {
    flexShrink: 0,
  },
  mobileList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    "@media (min-width: 768px)": {
      display: "none",
    },
  },
  mobileCard: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    cursor: "pointer",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorSubtleBackground,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },
  },
  mobileCover: {
    width: "44px",
    height: "44px",
    borderRadius: tokens.borderRadiusSmall,
    objectFit: "cover",
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  desktopCover: {
    width: "40px",
    height: "40px",
    borderRadius: tokens.borderRadiusSmall,
    objectFit: "cover",
    display: "block",
    backgroundColor: tokens.colorNeutralBackground3,
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
  playOverlay: {
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
  playIcon: {
    fontSize: "22px",
    display: "block",
  },
  mobileInfo: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  mobileActions: {
    paddingTop: tokens.spacingVerticalXS,
  },
  selectionCell: {
    flex: "0 0 44px",
  },
  actionCell: {
    flex: "0 0 36px",
    justifyContent: "flex-end",
    alignItems: "center",
    textAlign: "right",
  },
  qualityCell: {
    flex: "0 0 120px",
    justifyContent: "flex-start",
    alignItems: "center",
    paddingRight: tokens.spacingHorizontalM,
  },
  durationCell: {
    flex: "0 0 56px",
    justifyContent: "flex-end",
    alignItems: "center",
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
  },
  downloadedCell: {
    flex: "0 0 88px",
    justifyContent: "flex-end",
    alignItems: "center",
    textAlign: "right",
  },
  actionCellContent: {
    width: "100%",
    justifyContent: "flex-end",
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
  truncateCell: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const getTrackDisplayTitle = (track: Track) =>
  track.version ? `${track.title} (${track.version})` : track.title;

const getQualityTags = (track: Track): string[] => {
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

const isDownloadedTrack = (track: Track) => Boolean(track.is_downloaded ?? track.downloaded);
const isMonitoredTrack = (track: Track) => Boolean(track.is_monitored);
const isLockedTrack = (track: Track) => Boolean(track.monitored_lock);
const getTrackCoverUrl = (track: Track) => track.cover_url ?? track.album_cover ?? track.album?.cover_id ?? null;

function joinTrackMeta(parts: Array<string | null | undefined>) {
  return parts.filter((value) => Boolean(value && value.trim().length > 0)) as string[];
}

const LibraryTrackList = ({
  tracks,
  showArtist = true,
  showAlbum = true,
  showCover = true,
  selection,
}: LibraryTrackListProps) => {
  const navigate = useNavigate();
  const styles = useStyles();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();
  const {
    getPlaybackSrc,
    getPlaybackHlsSrc,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  } = useTrackPlayback();
  const [infoTrack, setInfoTrack] = useState<Track | null>(null);
  const [trackFilesById, setTrackFilesById] = useState<Record<string, TrackFiles>>({});
  const [loadingTrackFileIds, setLoadingTrackFileIds] = useState<Set<string>>(new Set());
  const [failedCoverUrls, setFailedCoverUrls] = useState<Set<string>>(new Set());
  const selectedRowIdSet = useMemo(
    () => new Set(selection?.selectedRowIds ?? []),
    [selection?.selectedRowIds]
  );
  const selectableTrackIds = useMemo(
    () => tracks.map((track) => track.id),
    [tracks]
  );
  const allSelectableSelected = selection
    ? selectableTrackIds.length > 0 && selectableTrackIds.every((trackId) => selectedRowIdSet.has(trackId))
    : false;
  const someSelectableSelected = selection
    ? !allSelectableSelected && selectableTrackIds.some((trackId) => selectedRowIdSet.has(trackId))
    : false;

  const columnCount = useMemo(() => {
    return (selection ? 1 : 0) + (showCover ? 1 : 0) + 1 + (showArtist ? 1 : 0) + (showAlbum ? 1 : 0) + 3 + 1;
  }, [selection, showAlbum, showArtist, showCover]);

  const getTrackFiles = useCallback((track: Track): TrackFiles => {
    if (Array.isArray(track.files) && track.files.length > 0) {
      return track.files;
    }

    return trackFilesById[track.id] ?? [];
  }, [trackFilesById]);

  const withLoadedFiles = useCallback((track: Track): Track => {
    const files = getTrackFiles(track);
    return files.length > 0 ? { ...track, files } : track;
  }, [getTrackFiles]);

  const ensureTrackFiles = useCallback(async (track: Track): Promise<TrackFiles> => {
    const existingFiles = getTrackFiles(track);
    if (existingFiles.length > 0) {
      return existingFiles;
    }

    if (!isDownloadedTrack(track)) {
      return [];
    }

    if (loadingTrackFileIds.has(track.id)) {
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

  const openTrackInfo = useCallback(async (track: Track, event?: MouseEvent<HTMLButtonElement>) => {
    event?.stopPropagation();

    const initialTrack = withLoadedFiles(track);
    setInfoTrack(initialTrack);

    if (getTrackFiles(track).length === 0 && isDownloadedTrack(track)) {
      const files = await ensureTrackFiles(track);
      if (files.length > 0) {
        setInfoTrack((current) => current?.id === track.id ? { ...current, files } : current);
      }
    }
  }, [ensureTrackFiles, getTrackFiles, withLoadedFiles]);

  const handleRowClick = useCallback((track: Track) => {
    if (track.album_id) {
      navigateToAlbumTrack(navigate, track.album_id, track.id);
    }
  }, [navigate]);

  const handleArtistClick = useCallback((event: MouseEvent, track: Track) => {
    event.stopPropagation();
    if (track.artist_id) {
      navigate(`/artist/${track.artist_id}`);
    }
  }, [navigate]);

  const toggleAllSelected = useCallback((checked: boolean) => {
    if (!selection) {
      return;
    }

    selection.onSelectionChange(checked ? selectableTrackIds : []);
  }, [selectableTrackIds, selection]);

  const toggleSelectedTrack = useCallback((trackId: string, checked: boolean) => {
    if (!selection) {
      return;
    }

    const nextSelection = checked
      ? Array.from(new Set([...(selection.selectedRowIds ?? []), trackId]))
      : (selection.selectedRowIds ?? []).filter((currentTrackId) => currentTrackId !== trackId);

    selection.onSelectionChange(nextSelection);
  }, [selection]);

  const markCoverFailed = useCallback((url: string | null | undefined) => {
    if (!url) {
      return;
    }
    setFailedCoverUrls((previous) => {
      if (previous.has(url)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(url);
      return next;
    });
  }, []);

  const renderTitleMeta = (track: Track, showInlineDetails = true) => {
    const metaItems = joinTrackMeta([
      showInlineDetails ? formatDurationSeconds(track.duration) : null,
    ]);
    const qualityTags = getQualityTags(track);
    const showInlineQuality = showInlineDetails && qualityTags.length > 0;

    return (
      <div className={styles.titleBlock}>
        <div className={styles.titleRow}>
          <Text weight="semibold" truncate wrap={false} className={styles.titleText}>
            {getTrackDisplayTitle(track)}
          </Text>
          {track.explicit ? <ExplicitBadge className={styles.explicitBadge} /> : null}
        </div>
        <div className={styles.metaRow}>
          {metaItems.map((item, index) => (
            <Text key={`${track.id}-meta-${index}`} size={200} className={styles.metaText}>
              {index > 0 ? null : null}
              {item}
            </Text>
          ))}
          {showInlineQuality ? <Text size={200} className={styles.separator}>•</Text> : null}
          {showInlineDetails ? qualityTags.map((quality) => (
            <QualityBadge key={quality} quality={quality} size="small" className={styles.qualityBadge} />
          )) : null}
        </div>
      </div>
    );
  };

  if (!tracks || tracks.length === 0) {
    return null;
  }

  return (
    <>
      <div className={styles.root}>
        <div className={styles.mobileList}>
          {tracks.map((rawTrack) => {
            const track = withLoadedFiles(rawTrack);
            const isPlaying = playingTrackId === track.id;
            const isDownloaded = isDownloadedTrack(track);
            const hasProviderTrack = Boolean(track.preview_provider_track_id);
            const canPlayTrack = isDownloaded || hasProviderTrack;
            const canShowInfo = isDownloaded || getTrackFiles(track).length > 0;
            const coverUrl = getTrackCoverUrl(track);
            const renderableCoverUrl = failedCoverUrls.has(coverUrl || "")
              ? null
              : renderableArtworkUrl(coverUrl);

            return (
              <div
                key={track.id}
                className={styles.mobileCard}
                onClick={() => handleRowClick(track)}
              >
                {showCover ? (
                  renderableCoverUrl ? (
                    <img
                      src={renderableCoverUrl}
                      alt={track.album_title || "Album"}
                      className={styles.mobileCover}
                      onError={() => markCoverFailed(coverUrl)}
                    />
                  ) : (
                    <div className={styles.mobileCover} />
                  )
                ) : null}

                <div className={styles.mobileInfo}>
                  {renderTitleMeta(track)}

                  <div className={styles.metaRow}>
                    {showArtist ? (
                      <Text size={200} className={styles.metaText} truncate wrap={false}>
                        {track.artist_name || "Unknown Artist"}
                      </Text>
                    ) : null}
                    {showArtist && showAlbum ? <Text size={200} className={styles.separator}>•</Text> : null}
                    {showAlbum ? (
                      <Text size={200} className={styles.metaText} truncate wrap={false}>
                        {track.album_title || "Unknown Album"}
                      </Text>
                    ) : null}
                  </div>

                  <TrackRowActions
                    className={styles.mobileActions}
                    isPlaying={isPlaying}
                    isMonitored={isMonitoredTrack(track)}
                    isLocked={isLockedTrack(track)}
                    isDownloaded={isDownloaded}
                    isDownloading={downloadingTracks.has(track.id)}
                    canShowInfo={canShowInfo}
                    onPlay={canPlayTrack ? (event) => toggleTrackPlayback(track, event) : undefined}
                    onShowInfo={(event) => {
                      void openTrackInfo(track, event);
                    }}
                    onDownload={hasProviderTrack
                      ? (event) => {
                        void handleDownloadTrack(track, event);
                      }
                      : undefined}
                  />

                  {isPlaying ? (
                    <AudioPlayer
                      src={getPlaybackSrc(track)}
                    hlsSrc={getPlaybackHlsSrc(track)}
                      knownDuration={track.duration}
                      onEnded={() => setPlayingTrackId(null)}
                      onPlaybackError={() => {
                        void handleTrackPlaybackError(track);
                      }}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <Table aria-label="Track list" className={styles.desktopTable} noNativeElements size="small">
          <TableHeader>
            <TableRow className={styles.headerRow}>
              {selection ? (
                <TableHeaderCell className={styles.selectionCell}>
                  <Checkbox
                    checked={allSelectableSelected ? true : someSelectableSelected ? "mixed" : false}
                    aria-label="Select all visible tracks"
                    onChange={(_, data) => toggleAllSelected(Boolean(data.checked))}
                  />
                </TableHeaderCell>
              ) : null}
              {showCover ? <TableHeaderCell className={styles.coverCell} /> : null}
              <TableHeaderCell className={styles.titleCell}>
                <span className={styles.headerLabel}>Title</span>
              </TableHeaderCell>
              {showArtist ? (
                <TableHeaderCell className={styles.artistCell}>
                  <span className={styles.headerLabel}>Artist</span>
                </TableHeaderCell>
              ) : null}
              {showAlbum ? (
                <TableHeaderCell className={styles.albumCell}>
                  <span className={styles.headerLabel}>Album</span>
                </TableHeaderCell>
              ) : null}
              <TableHeaderCell className={styles.qualityCell}>
                <span className={styles.headerLabel}>Quality</span>
              </TableHeaderCell>
              <TableHeaderCell className={styles.durationCell}>
                <span className={`${styles.headerLabel} ${styles.headerLabelRight}`}>Duration</span>
              </TableHeaderCell>
              <TableHeaderCell className={styles.downloadedCell}>
                <span className={`${styles.headerLabel} ${styles.headerLabelRight}`}>Downloaded</span>
              </TableHeaderCell>
              <TableHeaderCell className={styles.actionCell} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracks.map((rawTrack) => {
              const track = withLoadedFiles(rawTrack);
              const isPlaying = playingTrackId === track.id;
              const isDownloaded = isDownloadedTrack(track);
              const hasProviderTrack = Boolean(track.preview_provider_track_id);
              const canPlayTrack = isDownloaded || hasProviderTrack;
              const canShowInfo = isDownloaded || getTrackFiles(track).length > 0;
              const coverUrl = getTrackCoverUrl(track);
              const renderableCoverUrl = failedCoverUrls.has(coverUrl || "")
                ? null
                : renderableArtworkUrl(coverUrl);
              const qualityTags = getQualityTags(track);

              return (
                <Fragment key={track.id}>
                  <TableRow
                    className={styles.row}
                    onClick={() => handleRowClick(track)}
                  >
                    {selection ? (
                      <TableCell className={styles.selectionCell} onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={selectedRowIdSet.has(track.id)}
                          aria-label={selection.getSelectionLabel?.(track) || `Select ${track.title}`}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(_, data) => toggleSelectedTrack(track.id, Boolean(data.checked))}
                        />
                      </TableCell>
                    ) : null}
                    {showCover ? (
                      <TableCell className={styles.coverCell} onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className={styles.coverButton}
                          aria-label={isPlaying ? "Stop track" : "Play track"}
                          disabled={!canPlayTrack}
                          onClick={canPlayTrack ? (event) => toggleTrackPlayback(track, event) : undefined}
                        >
                          {renderableCoverUrl ? (
                            <img
                              src={renderableCoverUrl}
                              alt={track.album_title || "Album"}
                              className={styles.desktopCover}
                              data-cover-image
                              onError={() => markCoverFailed(coverUrl)}
                            />
                          ) : (
                            <span className={styles.coverFallback}>
                              <Avatar
                                name={track.album_title || "Album"}
                                shape="square"
                                size={40}
                              />
                            </span>
                          )}
                          {canPlayTrack ? (
                            <span className={styles.playOverlay} data-cover-play>
                              {isPlaying
                                ? <Stop24Regular className={styles.playIcon} />
                                : <Play24Filled className={styles.playIcon} />}
                            </span>
                          ) : null}
                        </button>
                      </TableCell>
                    ) : null}

                    <TableCell className={styles.titleCell}>
                      {renderTitleMeta(track, false)}
                    </TableCell>

                    {showArtist ? (
                      <TableCell className={styles.artistCell}>
                        <Text truncate wrap={false} className={`${styles.linkText} ${styles.truncateCell}`} onClick={(event) => handleArtistClick(event, track)}>
                          {track.artist_name || "Unknown Artist"}
                        </Text>
                      </TableCell>
                    ) : null}

                    {showAlbum ? (
                      <TableCell className={styles.albumCell}>
                        <Text
                          truncate
                          wrap={false}
                          className={`${styles.linkText} ${styles.truncateCell}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (track.album_id) {
                              navigateToAlbum(navigate, track.album_id);
                            }
                          }}
                        >
                          {track.album_title || "Unknown Album"}
                        </Text>
                      </TableCell>
                    ) : null}

                    <TableCell className={styles.qualityCell}>
                      <div className={styles.metaRow}>
                        {qualityTags.map((quality) => (
                          <QualityBadge key={quality} quality={quality} size="small" className={styles.qualityBadge} />
                        ))}
                      </div>
                    </TableCell>

                    <TableCell className={styles.durationCell}>
                      {formatDurationSeconds(track.duration)}
                    </TableCell>

                    <TableCell className={styles.downloadedCell} aria-label={isDownloaded ? "Downloaded" : "Not downloaded"}>
                      {isDownloaded ? <CheckmarkCircle16Regular className={styles.checkIcon} /> : <span className={styles.emptyCheck} />}
                    </TableCell>

                    <TableCell onClick={(event) => event.stopPropagation()} className={styles.actionCell}>
                      <TrackRowActions
                        className={`${styles.actionCellContent} track-actions`}
                        isPlaying={isPlaying}
                        isMonitored={isMonitoredTrack(track)}
                        isLocked={isLockedTrack(track)}
                        isDownloaded={isDownloaded}
                        isDownloading={downloadingTracks.has(track.id)}
                        canShowInfo={canShowInfo}
                        onShowInfo={(event) => {
                          void openTrackInfo(track, event);
                        }}
                        onDownload={hasProviderTrack
                          ? (event) => {
                            void handleDownloadTrack(track, event);
                          }
                          : undefined}
                      />
                    </TableCell>
                  </TableRow>

                  {isPlaying ? (
                    <TableRow className={styles.playerRow}>
                      <TableCell className={styles.playerCell} style={{ flex: `1 1 ${columnCount * 100}%` }}>
                        <AudioPlayer
                          src={getPlaybackSrc(track)}
                          hlsSrc={getPlaybackHlsSrc(track)}
                          knownDuration={track.duration}
                          onEnded={() => setPlayingTrackId(null)}
                          onPlaybackError={() => {
                            void handleTrackPlaybackError(track);
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {infoTrack ? (
        <TrackInfoDialog
          open={Boolean(infoTrack)}
          onClose={() => setInfoTrack(null)}
          trackTitle={getTrackDisplayTitle(infoTrack)}
          artistName={infoTrack.artist_name || undefined}
          albumTitle={infoTrack.album_title || undefined}
          trackNumber={infoTrack.track_number || undefined}
          duration={infoTrack.duration}
          audioQuality={infoTrack.quality}
          files={infoTrack.files || []}
        />
      ) : null}
    </>
  );
};

export default LibraryTrackList;
