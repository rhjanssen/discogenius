import { useState } from "react";
import {
  makeStyles,
  tokens,
  Card,
  Button,
  Badge,
  Text,
  Title3,
  Body1,
} from "@fluentui/react-components";
import {
  Play24Regular,
  Checkmark24Filled,
  Eye24Regular,
  EyeOff24Regular,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { getTidalImage } from "@/utils/tidalImages";
import { tidalUrl } from "@/utils/tidalUrl";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { LoadingState } from "@/components/ui/LoadingState";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: tokens.spacingHorizontalS,
    "@media (min-width: 480px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 1024px)": {
      gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
      gap: tokens.spacingHorizontalXL,
    },
  },
  card: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    cursor: "pointer",
    boxShadow: tokens.shadow8,
    transition: `all ${tokens.durationFast} ${tokens.curveEasyEase}`,
    padding: tokens.spacingVerticalNone,
    "&:hover": {
      transform: "translateY(-2px)",
      boxShadow: tokens.shadow28,
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1Hover}`,
    },
    "&:active": {
      transform: "translateY(0px)",
      boxShadow: tokens.shadow8,
    },
  },
  videoPreview: {
    position: "relative",
    aspectRatio: "3/2",
    width: "100%",
    backgroundColor: tokens.colorNeutralBackground3,
    overflow: "hidden",
  },
  videoImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  videoFallback: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground3,
  },
  playIcon: {
    width: "48px",
    height: "48px",
  },
  monitorIcon: {
    width: "16px",
    height: "16px",
    color: tokens.colorNeutralForeground2,
  },
  monitorIconMuted: {
    width: "16px",
    height: "16px",
    color: tokens.colorNeutralForegroundDisabled,
  },
  overlayControls: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: tokens.colorBackgroundOverlay,
    opacity: 0,
    transition: `opacity ${tokens.durationFast} ${tokens.curveEasyEase}`,
    "&:hover": {
      opacity: 1,
    },
  },
  statusBadge: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
  },
  qualityBadge: {
    position: "absolute",
    top: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    zIndex: 2,
  },
  monitorIndicator: {
    position: "absolute",
    bottom: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalS,
    zIndex: 2,
    width: "24px",
    height: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: tokens.borderRadiusCircular,
    backdropFilter: "blur(20px)",
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    cursor: "pointer",
    border: "none",
    padding: 0,
    transition: `transform ${tokens.durationFast} ${tokens.curveEasyEase}`,
    "&:hover": {
      transform: "scale(1.05)",
    },
  },
  durationBadge: {
    position: "absolute",
    bottom: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  cardContent: {
    padding: tokens.spacingVerticalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    minHeight: "80px",
  },
  videoTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase300,
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  videoTitleText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flexGrow: 1,
  },
  artistName: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  explicitBadge: {
    marginLeft: tokens.spacingHorizontalXS,
  },
  noVideos: {
    padding: tokens.spacingVerticalXXXL,
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalL,
  },
  noVideosText: {
    color: tokens.colorNeutralForeground2,
  },
  artistSubtitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

export interface Video {
  id: string;
  title: string;
  duration: number;
  release_date?: string;
  version?: string;

  explicit?: boolean;
  quality?: string;
  cover_id?: string;
  url?: string;
  path?: string;
  artist_id: string;
  artist_name?: string;
  is_monitored: boolean;
  is_downloaded: boolean;
  created_at?: string;
}

interface VideoGridProps {
  videos: Video[];
  loading?: boolean;
  onToggleMonitor?: (video: Video) => void;
  onOpenVideo?: (video: Video) => void;
}

const VideoGrid = ({ videos, loading, onToggleMonitor, onOpenVideo }: VideoGridProps) => {
  const styles = useStyles();
  const navigate = useNavigate();
  const [hoveredVideo, setHoveredVideo] = useState<string | null>(null);

  const formatDuration = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) {
      return `${minutes} MIN`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${mins.toString().padStart(2, "0")} HR`;
  };

  const handleVideoClick = (video: Video) => {
    if (onOpenVideo) {
      onOpenVideo(video);
      return;
    }
    const url = video.url || tidalUrl('video', video.id);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleArtistClick = (e: React.MouseEvent, artistId: string) => {
    e.stopPropagation();
    navigate(`/artist/${artistId}`);
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <LoadingState className={styles.noVideos} label="Loading videos..." />
      </div>
    );
  }

  if (!videos || videos.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.noVideos}>
          <Title3>No Videos Found</Title3>
          <Body1 className={styles.noVideosText}>
            Music videos will appear here when you add them to your library
          </Body1>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.grid}>
        {videos.map((video) => (
          <Card
            key={video.id}
            className={styles.card}
            onMouseEnter={() => setHoveredVideo(video.id)}
            onMouseLeave={() => setHoveredVideo(null)}
            onClick={() => handleVideoClick(video)}
          >
            <div className={styles.videoPreview}>
              {video.cover_id ? (
                <img
                  src={getTidalImage(video.cover_id, 'video', 'medium') || ''}
                  alt={video.title}
                  className={styles.videoImage}
                  loading="lazy"
                />
              ) : (
                <div className={styles.videoFallback}>
                  <Play24Regular className={styles.playIcon} />
                </div>
              )}

              {/* Status badge (top right) - downloaded indicator */}
              {video.is_downloaded && (
                <Badge
                  appearance="filled"
                  color="success"
                  icon={<Checkmark24Filled />}
                  className={styles.statusBadge}
                  size="small"
                >
                  Downloaded
                </Badge>
              )}

              {/* Duration badge (bottom left) */}
              <Badge appearance="filled" className={styles.durationBadge}>
                {formatDuration(video.duration)}
              </Badge>

              {/* Monitor indicator (bottom right) */}
              <button
                type="button"
                className={styles.monitorIndicator}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMonitor?.(video);
                }}
                title={video.is_monitored ? "Unmonitor" : "Monitor"}
                aria-pressed={video.is_monitored}
                aria-label={video.is_monitored ? "Unmonitor video" : "Monitor video"}
              >
                {video.is_monitored ? (
                  <EyeOff24Regular className={styles.monitorIcon} />
                ) : (
                  <Eye24Regular className={styles.monitorIcon} />
                )}
              </button>
            </div>

            <div className={styles.cardContent}>
              <div className={styles.videoTitle}>
                <span className={styles.videoTitleText} title={video.title}>
                  {video.title}
                </span>
                {video.explicit ? (
                  <ExplicitBadge className={styles.explicitBadge} />
                ) : null}
              </div>
              <div className={styles.artistSubtitle}>
                {[video.artist_name || "Unknown Artist", video.release_date ? new Date(video.release_date).getFullYear() : ''].filter(Boolean).join(' · ')}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default VideoGrid;
