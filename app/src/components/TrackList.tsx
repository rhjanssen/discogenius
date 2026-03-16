import React, { useState } from "react";
import { formatDurationSeconds } from "@/utils/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Avatar,
  Button,
  Text,
  Card,
  tokens,
  makeStyles,
  mergeClasses,
  TableCellLayout,
} from "@fluentui/react-components";
import {
  Play24Filled,
  MusicNote224Regular,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { LoadingState } from "@/components/ui/LoadingState";
import { MonitorButton } from "@/components/MonitorButton";
import { LockToggle } from "@/components/LockToggle";
import { getTidalImage } from "@/utils/tidalImages";

export interface Track {
  id: string;
  title: string;
  version?: string | null;
  duration: number;
  track_number: number;
  volume_number?: number;
  explicit?: boolean;
  quality?: string;
  album_id: string;
  album_title?: string;
  album_cover?: string;
  artist_id?: string;
  artist_name?: string;
  created_at?: string;
  downloaded?: boolean;
  monitored?: boolean;
  monitor_locked?: boolean;
  is_monitored?: boolean;
  monitor?: boolean;
  monitor_lock?: boolean;
}

interface TrackListProps {
  tracks: Track[];
  loading?: boolean;
  showArtist?: boolean;
  showAlbum?: boolean;
  showDate?: boolean;
  showCover?: boolean;
}

const useStyles = makeStyles({
  root: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
  },
  // Desktop table
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
    "& .actions": {
      opacity: 0,
      transition: `opacity ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    },
    ":hover .actions": {
      opacity: 1,
    },
    "& .play-icon": {
      display: "none",
    },
    ":hover .play-icon": {
      display: "block",
    },
    ":hover .track-num": {
      display: "none",
    },
  },
  actions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalXS,
  },
  linkText: {
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    ":hover": {
      color: tokens.colorNeutralForeground1,
    },
  },
  qualityBadge: {
    transform: "scale(0.9)",
    transformOrigin: "left center",
    display: "inline-flex",
  },
  explicitBadge: {
    marginLeft: tokens.spacingHorizontalS,
  },
  // Mobile card list
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
    alignItems: "center",
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
  mobileTitle: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  mobileMeta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  mobileDuration: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    flexShrink: 0,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingVerticalXXXL,
    gap: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
  },
  loadingState: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: tokens.spacingVerticalXXXL,
    gap: tokens.spacingHorizontalS,
  },
});

const TrackList = ({
  tracks,
  loading,
  showArtist = true,
  showAlbum = true,
  showDate = true,
  showCover = true,
}: TrackListProps) => {
  const navigate = useNavigate();
  const styles = useStyles();
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const handleRowClick = (track: Track) => {
    if (track.album_id) {
      navigate(`/album/${track.album_id}`);
    }
  };

  const handleArtistClick = (e: React.MouseEvent, track: Track) => {
    e.stopPropagation();
    if (track.artist_id) {
      navigate(`/artist/${track.artist_id}`);
    }
  };

  if (loading) {
    return (
      <LoadingState className={styles.loadingState} size="small" label="Loading tracks..." />
    );
  }

  if (!tracks || tracks.length === 0) {
    return (
      <div className={styles.emptyState}>
        <MusicNote224Regular style={{ width: 48, height: 48, color: tokens.colorNeutralForeground4 }} />
        <Text weight="semibold" size={400}>No tracks found</Text>
        <Text size={300}>Try adjusting your filters or add artists to your library.</Text>
      </div>
    );
  }

  const getTrackDisplayTitle = (track: Track) =>
    track.version ? `${track.title} (${track.version})` : track.title;

  return (
    <div className={styles.root}>
      {/* Mobile: Card-based list */}
      <div className={styles.mobileList}>
        {tracks.map((track) => (
          <div
            key={track.id}
            className={styles.mobileCard}
            onClick={() => handleRowClick(track)}
          >
            {showCover && (
              track.album_cover ? (
                <img
                  src={getTidalImage(track.album_cover, "square", "small") || undefined}
                  alt={track.album_title || "Album"}
                  className={styles.mobileCover}
                />
              ) : (
                <div className={styles.mobileCover} />
              )
            )}
            <div className={styles.mobileInfo}>
              <div className={styles.mobileTitle}>
                <Text
                  weight="semibold"
                  size={300}
                  truncate
                  wrap={false}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {getTrackDisplayTitle(track)}
                </Text>
                {track.explicit ? <ExplicitBadge /> : null}
              </div>
              <div className={styles.mobileMeta}>
                {showArtist && (
                  <Text
                    size={200}
                    style={{ color: tokens.colorNeutralForeground3 }}
                    truncate
                    wrap={false}
                  >
                    {track.artist_name || "Unknown Artist"}
                  </Text>
                )}
                {showArtist && showAlbum && (
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>•</Text>
                )}
                {showAlbum && (
                  <Text
                    size={200}
                    style={{ color: tokens.colorNeutralForeground3 }}
                    truncate
                    wrap={false}
                  >
                    {track.album_title || "Unknown Album"}
                  </Text>
                )}
              </div>
              <div className={styles.mobileMeta}>
                <Text className={styles.mobileDuration}>{formatDurationSeconds(track.duration)}</Text>
                {track.quality && (
                  <QualityBadge quality={track.quality} className={styles.qualityBadge} />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: Table */}
      <Table aria-label="Track list" className={styles.desktopTable}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell style={{ width: '48px', textAlign: 'center' }}>#</TableHeaderCell>
            {showCover && <TableHeaderCell style={{ width: '60px' }} />}
            <TableHeaderCell style={{ minWidth: '200px' }}>Title</TableHeaderCell>
            {showArtist && <TableHeaderCell>Artist</TableHeaderCell>}
            {showAlbum && <TableHeaderCell>Album</TableHeaderCell>}
            {showDate && <TableHeaderCell style={{ width: '120px' }}>Date Added</TableHeaderCell>}
            <TableHeaderCell style={{ width: '80px', textAlign: 'right' }}>Time</TableHeaderCell>
            <TableHeaderCell style={{ width: '120px' }} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tracks.map((track) => (
            <TableRow
              key={track.id}
              className={styles.row}
              onClick={() => handleRowClick(track)}
              onMouseEnter={() => setHoveredRow(track.id)}
              onMouseLeave={() => setHoveredRow(null)}
            >
              <TableCell style={{ textAlign: 'center', color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%' }}>
                  <span className="track-num">{track.track_number}</span>
                  <Play24Filled className="play-icon" style={{ width: 16, height: 16 }} />
                </div>
              </TableCell>

              {showCover && (
                <TableCell style={{ padding: tokens.spacingVerticalS }}>
                  <TableCellLayout
                    media={
                      <Avatar
                        image={{
                          src: track.album_cover
                            ? getTidalImage(track.album_cover, "square", "small") || undefined
                            : undefined
                        }}
                        name={track.album_title || "Album"}
                        shape="square"
                        size={40}
                      />
                    }
                  />
                </TableCell>
              )}

              <TableCell>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <Text weight="semibold" truncate wrap={false} style={{ maxWidth: '300px' }}>
                      {getTrackDisplayTitle(track)}
                    </Text>
                    {track.explicit ? (
                      <ExplicitBadge className={styles.explicitBadge} />
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS }}>
                    {track.quality && (
                      <QualityBadge quality={track.quality} className={styles.qualityBadge} />
                    )}
                  </div>
                </div>
              </TableCell>

              {showArtist && (
                <TableCell>
                  <Text
                    className={styles.linkText}
                    onClick={(e) => handleArtistClick(e, track)}
                  >
                    {track.artist_name || "Unknown Artist"}
                  </Text>
                </TableCell>
              )}

              {showAlbum && (
                <TableCell>
                  <Text
                    className={styles.linkText}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/album/${track.album_id}`);
                    }}
                  >
                    {track.album_title || "Unknown Album"}
                  </Text>
                </TableCell>
              )}

              {showDate && (
                <TableCell>
                  <Text style={{ color: tokens.colorNeutralForeground3 }}>
                    {track.created_at ? formatDate(track.created_at) : "-"}
                  </Text>
                </TableCell>
              )}

              <TableCell style={{ textAlign: 'right' }}>
                <Text style={{ color: tokens.colorNeutralForeground3, fontFamily: tokens.fontFamilyMonospace }}>
                  {formatDurationSeconds(track.duration)}
                </Text>
              </TableCell>

              <TableCell onClick={(e) => e.stopPropagation()}>
                <div className={mergeClasses(styles.actions, "actions")}>
                  <MonitorButton
                    id={track.id}
                    type="track"
                    isMonitored={Boolean(track.is_monitored ?? track.monitor ?? track.monitored)}
                    isLocked={Boolean(track.monitor_locked ?? track.monitor_lock)}
                    size="icon"
                    showLabel={false}
                    variant="ghost"
                  />
                  <LockToggle
                    id={track.id}
                    type="track"
                    isMonitored={Boolean(track.is_monitored ?? track.monitor ?? track.monitored)}
                    isLocked={Boolean(track.monitor_locked ?? track.monitor_lock)}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default TrackList;
