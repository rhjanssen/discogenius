import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Avatar,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  CheckmarkCircle16Regular,
  Play24Filled,
  Stop24Regular,
  CheckmarkCircle16Filled,
  Stop24Filled,
  Video24Regular,
  Video24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { DataGrid, useDataGridCellStyles, type DataGridColumn } from "@/components/DataGrid";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow, type ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { TrackInfoDialog } from "@/components/ui/TrackInfoDialog";
import { TrackRowActions } from "@/components/tracks/TrackRowActions";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { useTrackPlayback } from "@/hooks/useTrackPlayback";
import { navigateToAlbum } from "@/utils/albumNavigation";
import { formatDurationSeconds } from "@/utils/format";
import { orderedQualityTags } from "@/utils/qualityTags";
import { localFileQualityTooltip } from "@/utils/localQualityTooltip";
import { mediaCoverSrc } from "@/utils/artwork";
import { formatTrackPositionFrom, isMultiVolumeTrackList } from "@/utils/trackPosition";
import type { TrackListItem } from "@/types/track-list";

const CheckmarkCircle16 = bundleIcon(CheckmarkCircle16Filled, CheckmarkCircle16Regular);
const Stop24 = bundleIcon(Stop24Filled, Stop24Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);

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
  showLocalQuality?: boolean;
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
  /** Music-video glyph on tracks that have an associated video (album page). */
  onAssociatedVideoClick?: (track: T, videoId: string, event: MouseEvent<HTMLButtonElement>) => void;
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
  // While the row is playing the stop overlay owns the cell; the underlying
  // track number must not shine through the icon.
  numberButtonPlaying: {
    "& [data-track-number]": {
      opacity: 0,
    },
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
  // No display override here: these icons are bundleIcon pairs, and forcing
  // `display` would reveal BOTH the filled and regular variants at once.
  playIcon: {
    fontSize: "20px",
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
  videoGlyphButton: {
    flexShrink: 0,
    width: "22px",
    height: "22px",
    padding: 0,
    border: 0,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    ":hover": {
      color: tokens.colorBrandForeground1,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
  },
  videoGlyphIcon: {
    fontSize: "16px",
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
    // Wrap so several badges stack within the Quality column instead of clipping.
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    minWidth: 0,
  },
  emptyValue: {
    color: tokens.colorNeutralForeground3,
  },

  durationText: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // Mobile secondary line under the title (Fluent list pattern): quality pills
  // live here so the Available column can hide and titles keep horizontal room.
  mobileQuality: {
    display: "flex",
    minWidth: 0,
    maxWidth: "100%",
    "@media (min-width: 768px)": {
      display: "none",
    },
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
  track.title;
const getQualityTags = (track: TrackListItem): string[] => orderedQualityTags(track);
/**
 * Provider column = acquisition-plan sources only.
 *
 * Manual imports and plan holes (file on disk, no provider track) must render
 * nothing here — never a hollow provider mark + quality chip invented from
 * local file tags. File quality belongs in the Local Files column.
 */
const getRemoteProviderQualityOffers = (track: TrackListItem): ProviderQualityOffer[] => {
  const bySlot = new Map<string, ProviderQualityOffer>();

  const pushOffer = (input: {
    slot: ProviderQualityOffer["slot"];
    provider: string;
    providerTrackId: string;
    quality?: string | null;
    providerAlbumId?: string | null;
    providerUrl?: string | null;
    providerTrackUrl?: string | null;
    matchStatus?: string | null;
    selectedReleaseMbid?: string | null;
  }) => {
    if (bySlot.has(input.slot)) return;
    const albumId = String(input.providerAlbumId || "").trim();
    bySlot.set(input.slot, {
      slot: input.slot,
      quality: input.quality ?? null,
      provider: input.provider,
      providerAlbumId: albumId || null,
      providerAlbumIds: albumId ? [albumId] : [],
      providerUrl: input.providerUrl ?? null,
      matchStatus: input.matchStatus || "verified",
      matchKind: "direct",
      // Track tooltips are ID lines only — no composition summary.
      coverageSummary: null,
      selectedReleaseMbid: input.selectedReleaseMbid || track.musicbrainz_release_id || null,
      providerTrackId: input.providerTrackId,
      providerTrackUrl: input.providerTrackUrl ?? null,
      musicbrainzTrackId: track.musicbrainz_track_id || null,
      musicbrainzRecordingId: track.musicbrainz_recording_id || null,
    });
  };

  for (const offer of track.remoteOffers || []) {
    const provider = String(offer.provider || "").trim();
    const providerTrackId = String(offer.providerTrackId || "").trim()
      || (String(track.preview_provider || "").toLowerCase() === provider.toLowerCase()
        ? String(track.preview_provider_track_id || "").trim()
        : "");
    // Require a concrete provider *track* — album id alone is not enough
    // (would paint the whole plan's quality onto uncovered tracks).
    if (!provider || !providerTrackId) continue;
    const slotRaw = String(offer.slot || "stereo").toLowerCase();
    const slot: ProviderQualityOffer["slot"] = slotRaw === "spatial" || slotRaw === "video"
      ? slotRaw
      : "stereo";
    pushOffer({
      slot,
      provider,
      providerTrackId,
      quality: offer.quality,
      providerAlbumId: offer.providerAlbumId,
      providerUrl: offer.providerUrl,
      providerTrackUrl: offer.providerTrackUrl,
      matchStatus: offer.matchStatus,
      selectedReleaseMbid: offer.selectedReleaseMbid,
    });
  }

  // No remoteOffers: only show a badge when the track already carries an
  // explicit provider track id (e.g. artist top tracks). Never invent from
  // qualityTags / file quality alone.
  if (bySlot.size === 0) {
    const provider = String(track.preview_provider || "").trim();
    const providerTrackId = String(track.preview_provider_track_id || "").trim();
    if (provider && providerTrackId) {
      pushOffer({
        slot: "stereo",
        provider,
        providerTrackId,
        quality: null,
      });
    }
  }

  return [...bySlot.values()];
};
const getFileQualityTags = (files: TrackFiles): string[] => orderedQualityTags({
  qualityTags: files
    .filter((file) => String(file.file_type || "track") === "track")
    .map((file) => file.quality),
});

/** Prefer the track file that carries this quality tag for tooltip probe props. */
const getFileForQualityTag = (files: TrackFiles, quality: string) => {
  const trackFiles = files.filter((file) => String(file.file_type || "track") === "track");
  const normalized = String(quality || "").trim().toUpperCase();
  return trackFiles.find((file) => String(file.quality || "").trim().toUpperCase() === normalized)
    || trackFiles[0]
    || null;
};
const isDownloadedTrack = (track: TrackListItem) => Boolean(track.is_downloaded ?? track.downloaded);
const looksLikeMusicBrainzMbid = (value: string | null | undefined) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
const canResolveProviderTrack = (track: TrackListItem) => {
  if (track.preview_provider_track_id) {
    return true;
  }

  const releaseGroupMbid = track.album_id ?? track.album?.id ?? null;
  const canonicalTrackMbid = track.musicbrainz_track_id ?? (looksLikeMusicBrainzMbid(track.id) ? track.id : null);
  return Boolean(
    looksLikeMusicBrainzMbid(releaseGroupMbid)
    && (looksLikeMusicBrainzMbid(canonicalTrackMbid) || looksLikeMusicBrainzMbid(track.musicbrainz_recording_id)),
  );
};
const hasPlayableTrackSource = (track: TrackListItem, audioFile: unknown) => Boolean(
  isDownloadedTrack(track)
  || audioFile
  || String(track.preview_provider_track_id || "").trim()
  // Album pages always attach a provider track id; top tracks sometimes only
  // carry canonical MBIDs. Playback can still resolve via release-group match.
  || canResolveProviderTrack(track),
);

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
  showLocalQuality = false,
  showVolumeHeaders = false,
  showDownloadedColumn = false,
  disableStickyHeader = true,
  contextArtistName,
  contextAlbumTitle,
  onTrackClick,
  onDownloadTrack,
  onToggleMonitor,
  onToggleLock,
  onAssociatedVideoClick,
  isTrackDownloading,
  selection,
}: TrackListProps<T>) => {
  const styles = useStyles();
  const dgCell = useDataGridCellStyles();
  const shouldShowLocalQuality = showLocalQuality;
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
    () => isMultiVolumeTrackList(tracks),
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
    const mobileOffers = showQuality ? getRemoteProviderQualityOffers(track) : [];
    const associatedVideoId = String(track.associated_video_id || "").trim() || null;

    return (
      <div className={styles.titleCell}>
        <div className={styles.titleStack}>
          <div className={styles.titleRow}>
            <Text truncate wrap={false} className={styles.titleText}>
              {getDisplayTitle(track)}
            </Text>
            {track.explicit ? <ExplicitBadge size="small" /> : null}
            {associatedVideoId && onAssociatedVideoClick ? (
              <AppTooltip content="Jump to associated video" relationship="label">
                <button
                  type="button"
                  className={styles.videoGlyphButton}
                  aria-label={`Jump to music video for ${getDisplayTitle(track)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAssociatedVideoClick(track, associatedVideoId, event);
                  }}
                >
                  <Video24 className={styles.videoGlyphIcon} />
                </button>
              </AppTooltip>
            ) : null}
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
          {mobileOffers.length > 0 ? (
            <div className={styles.mobileQuality} aria-label="Available provider quality">
              <ProviderQualityRow size="small" offers={mobileOffers} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }, [
    contextAlbumTitle,
    onAssociatedVideoClick,
    renderArtistCredits,
    showAlbum,
    showArtist,
    showQuality,
    styles.metaSeparator,
    styles.mobileMeta,
    styles.mobileQuality,
    styles.titleCell,
    styles.titleRow,
    styles.titleStack,
    styles.titleText,
    styles.videoGlyphButton,
    styles.videoGlyphIcon,
  ]);

  const renderCover = useCallback((track: T) => {
    const isPlaying = playingTrackId === track.id;
    const audioFile = getTrackAudioFile(track);
    const canPlay = hasPlayableTrackSource(track, audioFile);
    const coverUrl = getAlbumArtworkUrl(track);
    const renderableCoverUrl = coverUrl && !failedCoverUrls.has(coverUrl)
      ? mediaCoverSrc({ cover: coverUrl })
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
              ? <Stop24 className={styles.playIcon} />
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
          media: true,
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
            const canPlay = hasPlayableTrackSource(track, audioFile);

            return (
              <button
                type="button"
                className={mergeClasses(styles.numberButton, isPlaying ? styles.numberButtonPlaying : undefined)}
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
                  {numbering === "index"
                    ? index + 1
                    : formatTrackPositionFrom(track, {
                      // A volume header already supplies the disc context on
                      // album pages, so repeating it as "V-T" in every row is
                      // visual noise. Compact lists without headers still need
                      // the volume prefix to keep positions unambiguous.
                      multiVolume: hasMultipleVolumes && !showVolumeHeaders,
                      fallbackIndex: index + 1,
                    })}
                </span>
                {canPlay ? (
                  <span
                    className={mergeClasses(styles.playOverlay, isPlaying ? styles.playOverlayActive : undefined)}
                    data-track-play
                  >
                    {isPlaying
                      ? <Stop24 className={styles.playIcon} />
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
      // Title and Artist each take an equal share of the space left after the
      // content-sized columns (Available/Library/Duration).
      width: "minmax(0, 1fr)",
      wrap: true,
      render: (track) => renderTitle(track),
    });

    if (showArtist) {
      trackColumns.push({
        key: "artist",
        header: "Artist",
        width: "minmax(0, 1fr)",
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
        width: "minmax(0, 1fr)",
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
        key: "availableQuality",
        // Remote provider offers (what can be downloaded / previewed).
        header: "Provider",
        width: "max-content",
        // On mobile, pills move under the title so this column can hide and
        // titles keep the horizontal room (Fluent compact list pattern).
        minWidth: 768,
        render: (track) => {
          const offers = getRemoteProviderQualityOffers(track);
          if (offers.length === 0) {
            // Manual import / plan hole: leave the cell blank (not a hollow pill).
            return null;
          }
          return (
            <div className={styles.qualityContent} aria-label="Available provider quality">
              <ProviderQualityRow size="small" offers={offers} />
            </div>
          );
        },
      });
    }

    if (shouldShowLocalQuality) {
      trackColumns.push({
        key: "localQuality",
        // On-disk library file quality (what is already imported).
        header: "Local Files",
        width: "max-content",
        minWidth: 768,
        render: (track) => {
          const trackFiles = getTrackFiles(track);
          const fileQualityTags = getFileQualityTags(trackFiles);
          return (
            <div className={styles.qualityContent} aria-label="Library file quality">
              {fileQualityTags.length > 0
                ? fileQualityTags.map((quality) => {
                  const file = getFileForQualityTag(trackFiles, quality);
                  return (
                    <QualityBadge
                      key={quality}
                      quality={quality}
                      size="small"
                      tooltip={localFileQualityTooltip(file)}
                    />
                  );
                })
                : <span className={styles.emptyValue}>—</span>}
            </div>
          );
        },
      });
    }

    trackColumns.push({
      key: "duration",
      // Short header + content-sized track so mm:ss does not leave a wide empty
      // band between Available and the action icon on mobile.
      header: "Time",
      width: "max-content",
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
        header: "Status",
        width: "88px",
        align: "right",
        minWidth: 768,
        render: (track) => {
          const isDownloaded = isDownloadedTrack(track);
          return (
            <span aria-label={isDownloaded ? "Downloaded" : "Not downloaded"}>
              {isDownloaded ? <CheckmarkCircle16 className={styles.checkIcon} /> : <span className={styles.emptyCheck} />}
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
        const canDownload = Boolean(onDownloadTrack && canResolveProviderTrack(track));
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
    hasMultipleVolumes,
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
    shouldShowLocalQuality,
    showQuality,
    showVolumeHeaders,
    styles.actionCellContent,
    styles.checkIcon,
    styles.durationText,
    styles.emptyCheck,
    styles.emptyValue,
    styles.linkText,
    styles.numberButton,
    styles.numberButtonPlaying,
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
        ariaLabel="Track list"
        columns={columns}
        items={tracks}
        getRowKey={(track) => track.id}
        getRowProps={(track) => ({ "data-album-track-id": String(track.id) })}
        onRowClick={onTrackClick}
        selection={selection}
        renderBeforeRow={renderBeforeRow}
        renderRowDetail={renderRowDetail}
        getRowClassName={(track) => playingTrackId === track.id ? styles.rowPlaying : undefined}
        disableStickyHeader={disableStickyHeader}
        // One grid owns every column track, so the header and every loaded row
        // stay aligned even when provider/quality badge counts differ.
        sharedColumns
      />

      {infoTrack ? (
        <TrackInfoDialog
          open={Boolean(infoTrack)}
          onClose={() => setInfoTrack(null)}
          trackId={infoTrack.id}
          trackTitle={getDisplayTitle(infoTrack)}
          artistName={infoTrack.artist_name || contextArtistName || undefined}
          albumTitle={getAlbumTitle(infoTrack, contextAlbumTitle) || undefined}
          trackNumber={infoTrack.track_number || undefined}
          duration={infoTrack.duration}
          audioQuality={infoTrack.quality}
          files={infoTrack.files || []}
          onFilesDeleted={() => {
            setTrackFilesById((previous) => {
              const next = { ...previous };
              delete next[infoTrack.id];
              return next;
            });
          }}
        />
      ) : null}
    </>
  );
};

export default TrackList;
