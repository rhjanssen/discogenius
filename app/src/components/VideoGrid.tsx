import {
  makeStyles,
  tokens,
  Badge,
  Button,
  Title3,
  Body1,
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowDownload16Regular as ArrowDownload16RegularBase,
  Play24Regular as Play24RegularBase,
  ArrowDownload16Filled,
  Play24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { MediaCard } from "@/components/cards/MediaCard";
import { useGridStyles } from "@/components/cards/cardStyles";
import { renderableArtworkUrl } from "@/utils/artwork";
import { CardGridSkeleton } from "@/components/ui/LoadingSkeletons";
import { DownloadedBadge } from "@/components/ui/StatusBadges";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderMark } from "@/components/ui/ProviderMark";
import { qualityDisplayKey } from "@/utils/qualityTags";

const ArrowDownload16Regular = bundleIcon(ArrowDownload16Filled, ArrowDownload16RegularBase);
const Play24Regular = bundleIcon(Play24Filled, Play24RegularBase);

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
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
  durationBadge: {
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    color: tokens.colorNeutralForeground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    backdropFilter: "blur(20px)",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  downloadButton: {
    minWidth: 0,
    width: "24px",
    height: "24px",
    padding: 0,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    color: tokens.colorNeutralForeground2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    backdropFilter: "blur(20px)",
  },
  placeholder: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground3,
  },
  placeholderIcon: {
    width: "48px",
    height: "48px",
  },
  offerBadges: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXXS,
  },
  offerPair: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
  },
});

export interface VideoProviderOffer {
  provider: string;
  provider_id: string;
  quality: string | null;
}

export interface Video {
  id: string;
  title: string;
  duration: number;
  release_date?: string | null;
  version?: string | null;
  explicit?: boolean;
  quality?: string | null;
  provider?: string | null;
  provider_id?: string | null;
  providers?: string[];
  provider_offers?: VideoProviderOffer[];
  cover?: string | null;
  cover_id?: string | null;
  cover_art_url?: string | null;
  url?: string | null;
  path?: string | null;
  artist_id: string;
  artist_name?: string | null;
  is_monitored: boolean;
  monitored_lock?: boolean;
  is_downloaded: boolean;
  created_at?: string | null;
}

interface VideoGridProps {
  videos: Video[];
  loading?: boolean;
  onToggleMonitor?: (video: Video) => void;
  onDownload?: (video: Video) => void;
  onOpenVideo?: (video: Video) => void;
  selection?: {
    selectedIds: ReadonlySet<string>;
    onToggle: (video: Video, selected: boolean, shiftKey: boolean) => void;
  };
  /** Right-click / long-press on a card: enter selection mode selecting this video. */
  onSelectionIntent?: (video: Video) => void;
}

const formatDuration = (seconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
};

const VideoGrid = ({ videos, loading, onToggleMonitor, onDownload, onOpenVideo, selection, onSelectionIntent }: VideoGridProps) => {
  const styles = useStyles();
  const gridStyles = useGridStyles();

  const handleVideoClick = (video: Video) => {
    if (onOpenVideo) {
      onOpenVideo(video);
      return;
    }
    if (video.url) {
      window.open(video.url, "_blank", "noopener,noreferrer");
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <CardGridSkeleton cards={6} thumbnailAspect="videoWide" className={gridStyles.grid} />
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
      <div className={gridStyles.grid}>
        {videos.map((video) => {
          const imageUrl = renderableArtworkUrl(video.cover_art_url || video.cover || video.cover_id);
          const year = video.release_date ? new Date(video.release_date).getFullYear() : null;
          const subtitle = [video.artist_name || "Unknown Artist", year || ""].filter(Boolean).join(" · ");
          const providerOffers = Array.from(new Map((video.provider_offers || [])
            .filter((offer) => offer?.provider && offer?.provider_id)
            // One display token per provider/quality; multiple ids for the same
            // grouped rendition must not recreate the old badge explosion.
            .map((offer) => [
              `${offer.provider}\u0000${offer.quality ? qualityDisplayKey(offer.quality) : "unknown"}`,
              offer,
            ])).values());
          const providers = [...new Set((providerOffers.length > 0
            ? providerOffers.map((offer) => offer.provider)
            : (video.providers?.length ? video.providers : [video.provider]))
            .filter((provider): provider is string => Boolean(provider)))];
          const providerLabel = providerOffers.length > 0
            ? providerOffers.map((offer) => `${offer.provider}${offer.quality ? ` · ${offer.quality}` : ""}`).join(", ")
            : providers.join(", ");

          return (
            <MediaCard
              key={video.id}
              imageUrl={imageUrl}
              alt={video.title}
              title={video.title}
              subtitle={subtitle}
              explicit={video.explicit}
              qualityBadges={(providers.length > 0 || video.quality) ? (
                <Tooltip content={providerLabel ? `Available from ${providerLabel}` : "Available video quality"} relationship="description">
                  <div className={styles.offerBadges} aria-label={providerLabel ? `Available from ${providerLabel}` : undefined}>
                    {providerOffers.length > 0
                      ? providerOffers.map((offer) => (
                          <span className={styles.offerPair} key={`${offer.provider}-${offer.provider_id}-${offer.quality || "unknown"}`}>
                            <ProviderMark provider={offer.provider} size={16} />
                            {offer.quality ? <QualityBadge quality={offer.quality} size="small" /> : null}
                          </span>
                        ))
                      : <>
                          {providers.map((provider) => <ProviderMark key={provider} provider={provider} size={16} />)}
                          {video.quality ? <QualityBadge quality={video.quality} size="small" /> : null}
                        </>}
                  </div>
                </Tooltip>
              ) : undefined}
              monitored={video.is_monitored}
              monitoringLocked={Boolean(video.monitored_lock)}
              videoAspect
              onClick={() => handleVideoClick(video)}
              onMonitorToggle={onToggleMonitor ? () => onToggleMonitor(video) : undefined}
              placeholder={(
                <div className={styles.placeholder}>
                  <Play24Regular className={styles.placeholderIcon} />
                </div>
              )}
              statusBadge={video.is_downloaded ? (
                <DownloadedBadge />
              ) : onDownload && video.provider && video.provider_id ? (
                <Button
                  appearance="subtle"
                  icon={<ArrowDownload16Regular />}
                  className={styles.downloadButton}
                  title="Download video"
                  aria-label="Download video"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDownload(video);
                  }}
                />
              ) : null}
              bottomLeftBadge={(
                <Badge appearance="outline" className={styles.durationBadge}>
                  {formatDuration(video.duration)}
                </Badge>
              )}
              selection={selection ? {
                selected: selection.selectedIds.has(String(video.id)),
                label: `Select ${video.title}`,
                onChange: (selected, shiftKey) => selection.onToggle(video, selected, shiftKey),
              } : undefined}
              onSelectionIntent={onSelectionIntent ? () => onSelectionIntent(video) : undefined}
            />

          );
        })}
      </div>
    </div>
  );
};

export default VideoGrid;
