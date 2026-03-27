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
import { useNavigate } from "react-router-dom";
import { TrackRowActions } from "@/components/tracks/TrackRowActions";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { DownloadedBadge } from "@/components/ui/StatusBadges";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import { useMonitoring } from "@/hooks/useMonitoring";
import { useTrackPlayback } from "@/hooks/useTrackPlayback";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { api } from "@/services/api";
import type { TrackListItem as Track } from "@/types/track-list";
import { navigateToAlbum, navigateToAlbumTrack } from "@/utils/albumNavigation";
import { formatDurationSeconds } from "@/utils/format";
import { getTidalImage } from "@/utils/tidalImages";

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
    "@media (min-width: 768px)": {
      display: "table",
    },
  },
  row: {
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },
  },
  playerRow: {
    padding: `${tokens.spacingVerticalXS} 0 ${tokens.spacingVerticalS}`,
  },
  linkText: {
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    ":hover": {
      color: tokens.colorNeutralForeground1,
    },
  },
  coverCell: {
    width: "56px",
  },
  titleCell: {
    minWidth: "280px",
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
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
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
    transform: "scale(0.9)",
    transformOrigin: "left center",
    display: "inline-flex",
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
    width: "44px",
  },
  actionCell: {
    width: "180px",
  },
  actionCellContent: {
    width: "100%",
    justifyContent: "flex-end",
  },
});

const getTrackDisplayTitle = (track: Track) =>
  track.version ? `${track.title} (${track.version})` : track.title;

const isDownloadedTrack = (track: Track) => Boolean(track.is_downloaded ?? track.downloaded);
const isMonitoredTrack = (track: Track) => Boolean(track.is_monitored ?? track.monitor ?? track.monitored);
const isLockedTrack = (track: Track) => Boolean(track.monitor_locked ?? track.monitor_lock);

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
  const { toggleMonitor, toggleLock } = useMonitoring();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();
  const {
    getPlaybackSrc,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  } = useTrackPlayback();
  const [infoTrack, setInfoTrack] = useState<Track | null>(null);
  const [trackFilesById, setTrackFilesById] = useState<Record<string, TrackFiles>>({});
  const [loadingTrackFileIds, setLoadingTrackFileIds] = useState<Set<string>>(new Set());
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
    return (selection ? 1 : 0) + (showCover ? 1 : 0) + 1 + (showArtist ? 1 : 0) + (showAlbum ? 1 : 0) + 1;
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

  const renderTitleMeta = (track: Track) => {
    const metaItems = joinTrackMeta([
      formatDurationSeconds(track.duration),
    ]);

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
          {track.quality ? <Text size={200} className={styles.separator}>•</Text> : null}
          {track.quality ? <QualityBadge quality={track.quality} className={styles.qualityBadge} /> : null}
          {isDownloadedTrack(track) ? <DownloadedBadge /> : null}
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
            const canShowInfo = isDownloaded || getTrackFiles(track).length > 0;

            return (
              <div
                key={track.id}
                className={styles.mobileCard}
                onClick={() => handleRowClick(track)}
              >
                {showCover ? (
                  track.album_cover ? (
                    <img
                      src={getTidalImage(track.album_cover, "square", "small") || undefined}
                      alt={track.album_title || "Album"}
                      className={styles.mobileCover}
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
                    onPlay={(event) => toggleTrackPlayback(track, event)}
                    onToggleMonitor={(event) => {
                      event.stopPropagation();
                      toggleMonitor({
                        id: track.id,
                        type: "track",
                        currentStatus: isMonitoredTrack(track),
                      });
                    }}
                    onToggleLock={(event) => {
                      event.stopPropagation();
                      toggleLock({
                        id: track.id,
                        type: "track",
                        isLocked: isLockedTrack(track),
                        isMonitored: isMonitoredTrack(track),
                      });
                    }}
                    onShowInfo={(event) => {
                      void openTrackInfo(track, event);
                    }}
                    onDownload={(event) => {
                      void handleDownloadTrack(track, event);
                    }}
                  />

                  {isPlaying ? (
                    <AudioPlayer
                      src={getPlaybackSrc(track)}
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

        <Table aria-label="Track list" className={styles.desktopTable}>
          <TableHeader>
            <TableRow>
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
              <TableHeaderCell className={styles.titleCell}>Title</TableHeaderCell>
              {showArtist ? <TableHeaderCell>Artist</TableHeaderCell> : null}
              {showAlbum ? <TableHeaderCell>Album</TableHeaderCell> : null}
              <TableHeaderCell className={styles.actionCell} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracks.map((rawTrack) => {
              const track = withLoadedFiles(rawTrack);
              const isPlaying = playingTrackId === track.id;
              const isDownloaded = isDownloadedTrack(track);
              const canShowInfo = isDownloaded || getTrackFiles(track).length > 0;

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
                      <TableCell className={styles.coverCell}>
                        <Avatar
                          image={{
                            src: track.album_cover
                              ? getTidalImage(track.album_cover, "square", "small") || undefined
                              : undefined,
                          }}
                          name={track.album_title || "Album"}
                          shape="square"
                          size={40}
                        />
                      </TableCell>
                    ) : null}

                    <TableCell className={styles.titleCell}>
                      {renderTitleMeta(track)}
                    </TableCell>

                    {showArtist ? (
                      <TableCell>
                        <Text className={styles.linkText} onClick={(event) => handleArtistClick(event, track)}>
                          {track.artist_name || "Unknown Artist"}
                        </Text>
                      </TableCell>
                    ) : null}

                    {showAlbum ? (
                      <TableCell>
                        <Text
                          className={styles.linkText}
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

                    <TableCell onClick={(event) => event.stopPropagation()} className={styles.actionCell}>
                      <TrackRowActions
                        className={`${styles.actionCellContent} track-actions`}
                        isPlaying={isPlaying}
                        isMonitored={isMonitoredTrack(track)}
                        isLocked={isLockedTrack(track)}
                        isDownloaded={isDownloaded}
                        isDownloading={downloadingTracks.has(track.id)}
                        canShowInfo={canShowInfo}
                        onPlay={(event) => toggleTrackPlayback(track, event)}
                        onToggleMonitor={(event) => {
                          event.stopPropagation();
                          toggleMonitor({
                            id: track.id,
                            type: "track",
                            currentStatus: isMonitoredTrack(track),
                          });
                        }}
                        onToggleLock={(event) => {
                          event.stopPropagation();
                          toggleLock({
                            id: track.id,
                            type: "track",
                            isLocked: isLockedTrack(track),
                            isMonitored: isMonitoredTrack(track),
                          });
                        }}
                        onShowInfo={(event) => {
                          void openTrackInfo(track, event);
                        }}
                        onDownload={(event) => {
                          void handleDownloadTrack(track, event);
                        }}
                      />
                    </TableCell>
                  </TableRow>

                  {isPlaying ? (
                    <TableRow>
                      <TableCell colSpan={columnCount}>
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
