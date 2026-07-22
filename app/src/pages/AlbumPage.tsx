import { Fragment, useState, useCallback, useMemo, useLayoutEffect, useRef, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { formatDurationSeconds } from "@/utils/format";
import {
  AvatarGroup,
  AvatarGroupItem,
  Button,
  Text,
  Title1,
  Title2,
  Tooltip,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Spinner,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Checkbox,
  makeStyles,
  tokens,
  Overflow,
  OverflowItem,
  mergeClasses,
} from "@fluentui/react-components";
import { MediaCard } from "@/components/cards/MediaCard";
import {
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Info24Regular,
  Tag24Regular,
  MusicNote224Regular,
  ChevronDown16Regular,
  CheckmarkCircle16Filled,
  FolderSync24Regular,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Info24Filled,
  Tag24Filled,
  MusicNote224Filled,
  ChevronDown16Filled,
  FolderSync24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { api } from "@/services/api";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow, type ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { ArtistPersona } from "@/components/ui/ArtistPersona";
import { EmptyState, ErrorState } from "@/components/ui/ContentState";
import { DetailPageSkeleton } from "@/components/ui/LoadingSkeletons";
import { ExpandableMetadataBlock } from "@/components/ui/ExpandableMetadataBlock";
import { TrackInfoDialog, type TrackFileInfo } from "@/components/ui/TrackInfoDialog";
import TrackList from "@/components/TrackList";
import {
  albumPageQueryKey,
  useAlbumPage,
  type AlbumPageData,
  type AlbumTrack,
  type ReleaseGroupAvailability,
} from "@/hooks/useAlbumPage";
import { useMonitoring } from "@/hooks/useMonitoring";
import { useTrackQueueActions } from "@/hooks/useTrackQueueActions";
import { useToast } from "@/hooks/useToast";
import { useDelayedVisible } from "@/hooks/useDelayedVisible";
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import { useUltraBlurHero } from "@/hooks/useUltraBlurHero";
import { getAlbumPath, getAlbumRouteTrackTarget } from "@/utils/albumNavigation";
import { mediaCoverSrc } from "@/utils/artwork";
import {
  detailActionGlassButtonStyles,
  detailActionPrimaryButtonStyles,
  standardDetailActionButtonStyles,
} from "@/components/media/detailActionStyles";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";
import {
  RenamePreviewDialog,
  RetagPreviewDialog,
  type RenamePreviewItem,
  type RetagPreviewItem,
} from "@/components/mediafiles/FileMaintenanceDialogs";
import { ReleaseSwitcher, selectedOfferExplicitForSlot, type SwitchableSlot } from "@/pages/album/ReleaseSwitcher";

const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const Info24 = bundleIcon(Info24Filled, Info24Regular);
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);
const MusicNote224 = bundleIcon(MusicNote224Filled, MusicNote224Regular);
const ChevronDown16 = bundleIcon(ChevronDown16Filled, ChevronDown16Regular);
const FolderSync24 = bundleIcon(FolderSync24Filled, FolderSync24Regular);

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    width: "100%",
    paddingBottom: `calc(${tokens.spacingVerticalXXXL} * 3)`,
  },
  stateShell: {
    width: "100%",
    alignSelf: "stretch",
  },
  header: {
    position: "relative",
    minHeight: "200px",
    display: "flex",
    alignItems: "flex-start",
    padding: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalXL,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: "hidden",
    gap: tokens.spacingHorizontalL,
    "@media (min-width: 768px)": {
      // Common desktop detail header height. With vertical padding this lands
      // at the same rendered height as artist pages and prevents shorter
      // metadata stacks from collapsing above the following content.
      minHeight: "276px",
      padding: tokens.spacingHorizontalXL,
      paddingTop: tokens.spacingVerticalXL,
      paddingBottom: tokens.spacingVerticalL,
      gap: tokens.spacingHorizontalXXL,
    },
  },
  headerContent: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
    width: "100%",
    textAlign: "center",
    "@media (min-width: 768px)": {
      flexDirection: "row",
      alignItems: "stretch",
      textAlign: "left",
      gap: tokens.spacingHorizontalXXL,
    },
  },
  coverArt: {
    // Mobile covers read small next to Title1; step up toward the desktop 220.
    width: "200px",
    height: "200px",
    objectFit: "cover",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow28,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "220px",
      height: "220px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
      boxShadow: tokens.shadow64,
    },
  },
  coverPlaceholder: {
    width: "200px",
    height: "200px",
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    color: tokens.colorNeutralForeground4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "220px",
      height: "220px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
    },
  },
  albumInfo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    // Section rhythm (title block → metadata → actions). Persona↔title lives
    // in titleBlock with a tighter related-content gap.
    gap: tokens.spacingVerticalM,
    minWidth: 0,
    width: "100%",
    alignItems: "center",
    textAlign: "center",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      textAlign: "left",
    },
  },
  // Fluent related-content pair: byline + title share XS/SNudge, not the
  // section M gap — so the persona reads as belonging to the title.
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalXS,
    width: "100%",
    minWidth: 0,
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      gap: tokens.spacingVerticalSNudge,
    },
  },
  albumTitle: {
    width: "100%",
    textAlign: "center",
    whiteSpace: "normal",
    wordBreak: "break-word",
    "@media (min-width: 768px)": {
      textAlign: "left",
    },
  },
  artistInfo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      columnGap: tokens.spacingHorizontalS,
    },
  },
  artistAvatarGroup: {
    display: "inline-flex",
    alignItems: "center",
    marginRight: tokens.spacingHorizontalXS,
  },
  artistNames: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXXS,
    rowGap: tokens.spacingVerticalXXS,
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
    },
  },
  artistCredit: {
    display: "inline-flex",
    alignItems: "center",
  },
  artistJoinPhrase: {
    display: "inline-flex",
    alignItems: "center",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  artistCreditButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: 0,
    border: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    "&:hover": {
      opacity: 0.8,
    },
  },
  metadata: {
    display: "flex",
    // Mobile: stack the quality badges above the year/track/duration facts so the
    // row never cuts off. Desktop: lay them out inline.
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXS,
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground2,
    "@media (min-width: 768px)": {
      flexDirection: "row",
      justifyContent: "flex-start",
      columnGap: tokens.spacingHorizontalM,
      rowGap: tokens.spacingVerticalS,
    },
  },
  metadataBadges: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  metadataFacts: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  metadataSeparator: {
    width: "4px",
    height: "4px",
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralForeground2,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "nowrap",
    justifyContent: "center",
    width: "100%",
    marginTop: tokens.spacingVerticalS,
    alignItems: "stretch",
    // Glass buttons lift + cast a shadow on hover; `overflow: hidden` sliced off
    // their rounded top edge. Keep it visible so the hover state renders fully.
    // Horizontal fit is handled by the ActionOverflowMenu, not by clipping.
    overflow: "visible",
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      marginTop: tokens.spacingVerticalM,
      flexWrap: "nowrap",
      overflow: "visible",
    },
  },
  // Transparent button base style
  transparentButton: {
    ...detailActionGlassButtonStyles,
  },
  // Primary action button
  primaryButton: {
    ...detailActionPrimaryButtonStyles,
  },
  actionButton: {
    ...standardDetailActionButtonStyles,
    minWidth: "76px",
    flexShrink: 0,
    "@media (min-width: 768px)": {
      ...standardDetailActionButtonStyles["@media (min-width: 768px)"],
      minWidth: "auto",
      flexShrink: 0,
    },
  },
  // Two adjacent Buttons sharing one rounded frame. The wrapper (not the halves)
  // owns the hover shadow + lift so the unit moves as one, and we avoid
  // overflow:hidden so the shadow/lift aren't clipped. Each half keeps its outer
  // corners rounded and inner corners squared so the seam stays clean.
  splitDownload: {
    display: "inline-flex",
    alignItems: "stretch",
    position: "relative",
    borderRadius: tokens.borderRadiusXLarge,
    flex: "0 0 auto",
    minWidth: 0,
    transitionProperty: "box-shadow, transform",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    "&:hover": {
      boxShadow: tokens.shadow8,
      transform: "translateY(-1px)",
    },
    "&:active": {
      boxShadow: tokens.shadow2,
      transform: "translateY(0)",
    },
    "@media (min-width: 768px)": {
      flex: "0 0 auto",
      minWidth: "auto",
    },
  },
  splitDownloadPrimary: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    flex: "1 1 auto",
    minWidth: 0,
    // The wrapper handles the lift/shadow; suppress the per-half transform so the
    // two halves don't slide independently and tear the seam.
    "&:hover": {
      boxShadow: "none",
      transform: "none",
    },
    "&:active": {
      boxShadow: "none",
      transform: "none",
    },
  },
  splitDownloadMenu: {
    minWidth: "36px",
    flex: "0 0 36px",
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftColor: tokens.colorNeutralStroke2,
    "&:hover": {
      boxShadow: "none",
      transform: "none",
    },
    "&:active": {
      boxShadow: "none",
      transform: "none",
    },
  },
  metaAttribution: {
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  sectionHeader: {
    marginBottom: tokens.spacingVerticalM,
  },
  carousel: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    "@media (min-width: 640px)": {
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      gap: tokens.spacingHorizontalM,
    },
    "@media (min-width: 900px)": {
      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    },
  },
  // Edition cards in the "Other releases" grid use the shared card surface
  // from useCardStyles (components/cards/cardStyles.ts) via MediaCard. This
  // page-specific key only highlights the edition currently being viewed.
  currentEdition: {
    outlineWidth: tokens.strokeWidthThick,
    outlineStyle: "solid",
    outlineColor: tokens.colorBrandStroke1,
    outlineOffset: `calc(-1 * ${tokens.strokeWidthThick})`,
    borderRadius: tokens.borderRadiusMedium,
  },
  sectionSpacing: {
    marginTop: tokens.spacingVerticalXXL,
  },
  trackArtistText: {
    color: tokens.colorNeutralForeground2,
  },
  mobileTrackMeta: {
    color: tokens.colorNeutralForeground2,
  },
  trackSubInfo: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  trackArtistSeparator: {
    color: tokens.colorNeutralForeground2,
  },
  trackDurationText: {
    color: tokens.colorNeutralForeground2,
  },
  albumFilesCard: {
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  albumFilesHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  lockColorRed: {
    color: tokens.colorPaletteRedForeground1,
  },
  // Cover overlay for hover info
  coverContainer: {
    position: "relative",
    flexShrink: 0,
    alignSelf: "center",
    display: "inline-flex",
    lineHeight: 0,
    width: "fit-content",
    maxWidth: "100%",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusLarge,
    "@media (min-width: 768px)": {
      alignSelf: "flex-start",
    },
  },
  coverOverlay: {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: tokens.borderRadiusLarge,
    opacity: 0,
    transition: `opacity ${tokens.durationNormal} ${tokens.curveEasyEase}`,
    cursor: "pointer",
    "&:hover": {
      opacity: 1,
    },
  },
  coverInfoIcon: {
    color: "white",
    fontSize: tokens.fontSizeHero800,
  },
});

/* ── Album overflow helpers ─────────────────────────────────── */

const EMPTY_ALBUM_TRACKS: AlbumTrack[] = [];

const AlbumPage = () => {
  const styles = useStyles();
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { toggleMonitor, toggleLock, isTogglingMonitor, isTogglingLock } = useMonitoring();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();

  const [downloadingAlbum, setDownloadingAlbum] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [coverInfoOpen, setCoverInfoOpen] = useState(false);
  const [coverImageFailed, setCoverImageFailed] = useState(false);
  const [renamePreviewOpen, setRenamePreviewOpen] = useState(false);
  const [renamePreviewItems, setRenamePreviewItems] = useState<RenamePreviewItem[]>([]);
  const [renameApplying, setRenameApplying] = useState(false);
  const [retagPreviewOpen, setRetagPreviewOpen] = useState(false);
  const [retagPreviewItems, setRetagPreviewItems] = useState<RetagPreviewItem[]>([]);
  const [retagApplying, setRetagApplying] = useState(false);
  const [deleteFilesOpen, setDeleteFilesOpen] = useState(false);
  const [deleteFilesUnmonitor, setDeleteFilesUnmonitor] = useState(false);
  const [deleteFilesApplying, setDeleteFilesApplying] = useState(false);
  const [pendingSelectionKey, setPendingSelectionKey] = useState<string | null>(null);
  const handledTrackScrollKeyRef = useRef<string | null>(null);

  const { data: pageData, isLoading: loading, error, refetch } = useAlbumPage(albumId);
  const album = pageData?.album ?? null;
  const tracks = pageData?.tracks ?? EMPTY_ALBUM_TRACKS;
  const { data: curationConfig } = useQuery({
    queryKey: ["config", "curation"],
    queryFn: () => api.getCurationConfig(),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const includeSpatial = curationConfig?.include_spatial === true;

  const { data: activity } = useQuery({
    queryKey: ['artist-activity', album?.artist_id],
    queryFn: ({ signal }) => album?.artist_id
      ? api.getArtistActivity(album.artist_id, { signal, timeoutMs: 8_000 })
      : null,
    enabled: Boolean(album?.artist_id) && !loading && !error,
    refetchOnWindowFocus: false,
    staleTime: 10_000,
    retry: 1,
  }) as { data: { scanning?: boolean; curating?: boolean; downloading?: boolean; libraryScan?: boolean; totalActive?: number } | null };
  const otherVersions = pageData?.otherVersions ?? [];
  const releaseAvailability = pageData?.releaseAvailability ?? null;
  const artistImage = pageData?.artistImage ?? undefined;
  const albumArtists = album?.album_artists?.length
    ? album.album_artists
    : album
      ? [{
          id: album.artist_id,
          name: album.artist_name,
          join_phrase: "",
          picture: artistImage,
        }]
      : [];
  const albumCanonicalArtworkUrl = album ? mediaCoverSrc(album) : null;
  const albumArtworkUrl = album
    ? (albumCanonicalArtworkUrl && !coverImageFailed ? albumCanonicalArtworkUrl : null)
    : undefined;
  const albumBrandColor = useArtworkBrandColor({
    artworkUrl: albumArtworkUrl,
    brandKeyColor: album?.vibrant_color ?? null,
    // MusicBrainz-canonical albums have no provider vibrant_color, so derive
    // the accent from the cover like the artist/video pages do — otherwise
    // brand-driven UI (seekbar, buttons) stays on the default orange while
    // UltraBlur already shows the artwork tint.
    deriveBrandFromArtwork: true,
    ownsAmbience: true,
  });
  const { heroProps: ultraBlurHeroProps } = useUltraBlurHero(albumArtworkUrl);

  useEffect(() => {
    setCoverImageFailed(false);
  }, [albumCanonicalArtworkUrl]);

  const isMonitored = !!album?.is_monitored;
  const isLocked = !!album?.monitored_lock;
  const hasStereoOffer = Boolean(album?.stereo_provider_id);
  const hasSpatialOffer = Boolean(album?.spatial_provider_id);
  const hasAnyProviderOffer = hasStereoOffer || hasSpatialOffer;
  const selectedOfferExplicitBySlot = useMemo(() => ({
    stereo: selectedOfferExplicitForSlot(releaseAvailability, "stereo", {
      provider: album?.stereo_provider || album?.selected_provider,
      providerAlbumId: album?.stereo_provider_id,
      releaseMbid: album?.stereo_release_mbid || album?.selected_release_mbid,
    }),
    spatial: selectedOfferExplicitForSlot(releaseAvailability, "spatial", {
      provider: album?.spatial_provider || album?.selected_provider,
      providerAlbumId: album?.spatial_provider_id,
      releaseMbid: album?.spatial_release_mbid || album?.selected_release_mbid,
    }),
  }), [
    album?.selected_provider,
    album?.selected_release_mbid,
    album?.spatial_provider,
    album?.spatial_provider_id,
    album?.spatial_release_mbid,
    album?.stereo_provider,
    album?.stereo_provider_id,
    album?.stereo_release_mbid,
    releaseAvailability,
  ]);
  const headerQualityBadges = useMemo(() => {
    const badges: Array<{ key: string; quality: string }> = [];

    if (album?.spatial_quality) {
      badges.push({ key: "spatial", quality: album.spatial_quality });
    }

    if (album?.stereo_quality && !badges.some((badge) => badge.quality === album.stereo_quality)) {
      badges.push({ key: "stereo", quality: album.stereo_quality });
    }

    if (badges.length === 0 && album?.quality) {
      badges.push({ key: "primary", quality: album.quality });
    }

    return badges;
  }, [album?.quality, album?.spatial_quality, album?.stereo_quality]);

  const renderAlbumArtists = () => {
    if (albumArtists.length > 1) {
      return (
        <>
          <AvatarGroup
            aria-label={albumArtists.map((artist) => artist.name).join(", ")}
            className={styles.artistAvatarGroup}
            layout="stack"
            size={24}
          >
            {albumArtists.map((artist, index) => (
              <AvatarGroupItem
                key={`${artist.id || artist.name}-${index}`}
                name={artist.name}
                image={artist.picture || artist.cover_image_url
                  ? { src: artist.picture || artist.cover_image_url || undefined }
                  : undefined}
              />
            ))}
          </AvatarGroup>
          <span className={styles.artistNames}>
            {albumArtists.map((artist, index) => (
              <Fragment key={`${artist.id || artist.name}-name-${index}`}>
                {artist.id ? (
                  <button
                    type="button"
                    className={styles.artistCreditButton}
                    onClick={() => navigate(`/artist/${artist.id}`)}
                  >
                    {artist.name}
                  </button>
                ) : (
                  <Text size={300}>{artist.name}</Text>
                )}
                {artist.join_phrase ? (
                  <Text size={300} className={styles.artistJoinPhrase}>
                    {artist.join_phrase}
                  </Text>
                ) : null}
              </Fragment>
            ))}
          </span>
        </>
      );
    }

    return albumArtists.map((artist) => (
      <Fragment key={artist.id || artist.name}>
        <span className={styles.artistCredit}>
          <ArtistPersona
            artistId={artist.id}
            artistName={artist.name}
            avatarUrl={artist.picture || artist.cover_image_url || undefined}
          />
        </span>
        {artist.join_phrase ? (
          <Text size={300} className={styles.artistJoinPhrase}>
            {artist.join_phrase}
          </Text>
        ) : null}
      </Fragment>
    ));
  };

  useLayoutEffect(() => {
    if (!albumId) {
      return;
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [albumId, location.key]);

  useLayoutEffect(() => {
    if (!albumId || loading) {
      return;
    }

    const focusTrackId = getAlbumRouteTrackTarget(location.state);
    if (!focusTrackId) {
      return;
    }

    const scrollKey = `${location.key}:${albumId}:${focusTrackId}`;
    if (handledTrackScrollKeyRef.current === scrollKey) {
      return;
    }

    let animationFrameId = 0;
    let cancelled = false;
    let attempts = 0;

    const findTrackRow = () => {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return document.querySelector<HTMLElement>(`[data-album-track-id="${CSS.escape(focusTrackId)}"]`);
      }

      return document.querySelector<HTMLElement>(`[data-album-track-id="${focusTrackId.replace(/([\\"])/g, "\\$1")}"]`);
    };

    const scrollToTrack = () => {
      if (cancelled) {
        return;
      }

      const trackRow = findTrackRow();
      if (trackRow) {
        handledTrackScrollKeyRef.current = scrollKey;
        trackRow.scrollIntoView({ block: "center", behavior: "auto" });
        return;
      }

      attempts += 1;
      if (attempts < 12) {
        animationFrameId = window.requestAnimationFrame(scrollToTrack);
      }
    };

    animationFrameId = window.requestAnimationFrame(scrollToTrack);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [albumId, loading, location.key, location.state, tracks.length]);

  const updateAlbumPageCache = useCallback((updater: (current: AlbumPageData) => AlbumPageData) => {
    if (!albumId) {
      return;
    }

    queryClient.setQueryData<AlbumPageData | undefined>(albumPageQueryKey(albumId), (current) => {
      if (!current) {
        return current;
      }

      return updater(current);
    });
  }, [albumId, queryClient]);

  const handleToggleMonitor = () => {
    if (!album || isLocked) return;
    toggleMonitor({ id: album.id, type: 'album', currentStatus: isMonitored });
    updateAlbumPageCache((current) => ({
      ...current,
      album: { ...current.album, is_monitored: !isMonitored },
    }));
    dispatchLibraryUpdated();
  };

  const handleToggleLock = () => {
    if (!album) return;
    toggleLock({ id: album.id, type: 'album', isLocked });
    updateAlbumPageCache((current) => ({
      ...current,
      album: { ...current.album, monitored_lock: !isLocked },
    }));
    dispatchLibraryUpdated();
  };

  const slotSelectionMutation = useMutation({
    mutationFn: async ({
      slot,
      releaseMbid,
      provider,
      providerAlbumId,
    }: {
      slot: SwitchableSlot;
      releaseMbid: string;
      provider: string;
      providerAlbumId: string;
    }) => api.setAlbumSlotSelection(albumId!, slot, { releaseMbid, provider, providerAlbumId }),
    onSuccess: async (releaseAvailability) => {
      updateAlbumPageCache((current) => ({
        ...current,
        releaseAvailability,
      }));
      await queryClient.invalidateQueries({ queryKey: albumPageQueryKey(albumId) });
      dispatchLibraryUpdated();
      toast({
        title: "Release selection updated",
        description: "The selected provider offer has been switched for this library.",
      });
    },
    onError: (mutationError) => {
      toast({
        title: "Failed to switch release",
        description: mutationError instanceof Error ? mutationError.message : "Please try again",
        variant: "destructive",
      });
    },
    onSettled: () => {
      setPendingSelectionKey(null);
    },
  });

  const handleSelectReleaseForSlot = useCallback((
    slot: SwitchableSlot,
    releaseMbid: string,
    offer: ReleaseGroupAvailability["releases"][number]["availability"][number],
  ) => {
    if (!albumId || !offer.providerAlbumId) {
      return;
    }

    setPendingSelectionKey(`${slot}:${releaseMbid}`);
    slotSelectionMutation.mutate({
      slot,
      releaseMbid,
      provider: offer.provider,
      providerAlbumId: offer.providerAlbumId,
    });
  }, [albumId, slotSelectionMutation]);

  const handleDownloadAlbum = async (slot?: 'stereo' | 'spatial') => {
    if (!album || !hasAnyProviderOffer) return;
    setDownloadingAlbum(true);
    try {
      await api.addAlbum(album.id, slot ? { slot } : undefined);
      const slotLabel = slot === 'spatial' ? 'spatial audio' : slot === 'stereo' ? 'stereo' : hasStereoOffer && hasSpatialOffer ? 'stereo and spatial audio' : 'selected';
      toast({
        title: "Album added to queue",
        description: `${album.title} (${slotLabel}) will be downloaded shortly`,
      });
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["queue"] }),
        queryClient.invalidateQueries({ queryKey: ["queueDetails"] }),
        queryClient.refetchQueries({ queryKey: ["queue"] }),
        queryClient.refetchQueries({ queryKey: ["queueDetails"] }),
      ]);
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
    } catch (error) {
      console.error("Error adding album to queue:", error);
      toast({
        title: "Failed to add to queue",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setDownloadingAlbum(false);
    }
  };

  const handleDownloadPrimary = () => {
    if (hasStereoOffer && hasSpatialOffer) {
      void handleDownloadAlbum();
      return;
    }
    if (hasSpatialOffer) {
      void handleDownloadAlbum('spatial');
      return;
    }
    void handleDownloadAlbum('stereo');
  };

  const openRenamePreview = async () => {
    if (!albumId) return;
    setRenameApplying(true);
    try {
      const response = await api.getLibraryRenamePreview({ albumId, limit: 1000 }) as { items: RenamePreviewItem[] };
      const items = response.items.filter((item) => item.missing || item.conflict || item.needs_rename);
      setRenamePreviewItems(items);
      setRenamePreviewOpen(true);
    } catch (error) {
      toast({
        title: "Rename preview failed",
        description: error instanceof Error ? error.message : "Could not load the album rename preview.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  };

  const handleApplyRenames = async (ids: number[]) => {
    if (!albumId) return;
    setRenameApplying(true);
    try {
      const result: any = await api.applyLibraryRenames(ids.length > 0 ? { ids } : { applyAll: true, albumId });
      toast({
        title: "Rename queued",
        description: result?.message || "Queued album file renaming.",
      });
      setRenamePreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue rename",
        description: error instanceof Error ? error.message : "Could not queue album file renaming.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  };

  const openRetagPreview = async () => {
    if (!albumId) return;
    setRetagApplying(true);
    try {
      const response = await api.getRetagPreview({ albumId, limit: 1000 }) as { items: RetagPreviewItem[] };
      setRetagPreviewItems(response.items);
      setRetagPreviewOpen(true);
    } catch (error) {
      toast({
        title: "Retag preview failed",
        description: error instanceof Error ? error.message : "Could not load the album retag preview.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  };

  const handleApplyRetags = async (ids: number[]) => {
    if (!albumId) return;
    setRetagApplying(true);
    try {
      const result: any = await api.applyRetags(ids.length > 0 ? { ids } : { applyAll: true, albumId });
      toast({
        title: "Retag queued",
        description: result?.message || "Queued album metadata tag writing.",
      });
      setRetagPreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue retag",
        description: error instanceof Error ? error.message : "Could not queue album metadata tag writing.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  };

  const handleDeleteAlbumFiles = async () => {
    if (!albumId) return;
    setDeleteFilesApplying(true);
    try {
      const result: any = await api.deleteAlbumFiles(albumId, { unmonitor: deleteFilesUnmonitor });
      toast({
        title: "Album files deleted",
        description: `Removed ${result?.deleted ?? 0} file(s)${result?.unmonitored ? " and unmonitored the album" : ""}.`,
      });
      setDeleteFilesOpen(false);
      setDeleteFilesUnmonitor(false);
      await refetch();
      dispatchLibraryUpdated();
      dispatchActivityRefresh();
    } catch (error) {
      toast({
        title: "Failed to delete album files",
        description: error instanceof Error ? error.message : "Could not delete album files.",
        variant: "destructive",
      });
    } finally {
      setDeleteFilesApplying(false);
    }
  };

  const albumActions: OverflowAction[] = [
    { key: 'monitor', label: isMonitored ? 'Unmonitor' : 'Monitor', disabled: isTogglingMonitor || isLocked, onClick: handleToggleMonitor },
    { key: 'lock', label: isLocked ? 'Unlock' : 'Lock', disabled: isTogglingLock, onClick: handleToggleLock },
    { key: 'download', label: downloadingAlbum ? 'Adding...' : 'Download selected', disabled: downloadingAlbum || !hasAnyProviderOffer, onClick: handleDownloadPrimary },
    ...(album?.stereo_provider_id ? [{ key: 'download-stereo', label: 'Download stereo', disabled: downloadingAlbum, onClick: () => handleDownloadAlbum('stereo') }] : []),
    ...(album?.spatial_provider_id ? [{ key: 'download-spatial', label: 'Download spatial', disabled: downloadingAlbum, onClick: () => handleDownloadAlbum('spatial') }] : []),
    { key: 'rename-files', label: renameApplying ? 'Loading rename...' : 'Preview Rename', disabled: renameApplying, onClick: openRenamePreview },
    { key: 'retag-files', label: retagApplying ? 'Loading tags...' : 'Write Tags', disabled: retagApplying, onClick: openRetagPreview },
    { key: 'delete-files', label: 'Delete files…', disabled: deleteFilesApplying, onClick: () => setDeleteFilesOpen(true) },
  ];

  /** Open track info dialog */
  const showIngestSkeleton = Boolean(activity?.scanning) && tracks.length === 0;
  // Shared delayed-loading policy: don't flash the page skeleton for
  // sub-second cached loads; known-long ingest syncs stay immediate.
  const showPageSkeleton = useDelayedVisible(loading);

  if (loading && !showPageSkeleton && !showIngestSkeleton) {
    return null;
  }

  if (loading || showIngestSkeleton) {
    return (
      <DetailPageSkeleton
        artShape="rounded"
        content="tracks"
        rows={8}
        className={styles.container}
        actionWidths={["104px", "82px", "110px", "88px", "72px"]}
        label={showIngestSkeleton ? "Syncing album tracks from MusicBrainz..." : "Loading album details..."}
      />
    );
  }

  if (error) {
    return (
      <div className={styles.stateShell}>
        <ErrorState
          title="Failed to load album"
          error={error as Error}
          minHeight="320px"
          actions={<Button onClick={() => void refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  if (!album) {
    return (
      <div className={styles.stateShell}>
        <EmptyState
          title="Album not found"
          description="This album may not be in your library yet."
          actions={<Button appearance="primary" onClick={() => navigate('/')}>Return to Library</Button>}
          minHeight="320px"
        />
      </div>
    );
  }


  const renderMiniAlbumCard = (
    item: {
      id: string;
      title: string;
      cover_id?: string | null;
      cover?: string | null;
      quality?: string | null;
      explicit?: boolean;
      stereo_provider_id?: string | null;
      stereo_quality?: string | null;
      spatial_provider_id?: string | null;
      spatial_quality?: string | null;
      provider_cover_id?: string | null;
      cover_art_url?: string | null;
    },
    subtitle: string,
    itemProgress?: any,
    options?: { to?: string | null }
  ) => {
    const isCurrent = item.id === album?.id;
    const target = options?.to === undefined ? getAlbumPath(item.id) : options.to ?? undefined;
    const hasStereoOffer = Boolean(item.stereo_provider_id);
    const hasSpatialOffer = Boolean(item.spatial_provider_id);
    const isMatched = hasStereoOffer || hasSpatialOffer;

    const statusBadge = isMatched ? (
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.colorPaletteGreenBackground3,
        color: tokens.colorPaletteGreenForeground3,
        borderRadius: tokens.borderRadiusCircular,
        padding: tokens.spacingHorizontalXXS,
        boxShadow: tokens.shadow4,
      }}>
        <CheckmarkCircle16Filled style={{ width: "12px", height: "12px" }} />
      </div>
    ) : undefined;

    // Quality is surfaced in the library list/table view, not on the card
    // overlay — keeping it off the card avoids colliding with the monitor button.
    return (
      <MediaCard
        key={item.id}
        className={isCurrent ? styles.currentEdition : undefined}
        to={target}
        imageUrl={mediaCoverSrc(item)}
        alt={item.title}
        title={item.title}
        subtitle={subtitle}
        explicit={item.explicit}
        statusBadge={statusBadge}
        downloadStatus={itemProgress?.state}
        downloadProgress={itemProgress?.progress}
        downloadError={itemProgress?.statusMessage}
      />
    );
  };
  return (
    <DynamicBrandProvider keyColor={albumBrandColor}>
      <div className={styles.container}>
        <RenamePreviewDialog
          open={renamePreviewOpen}
          items={renamePreviewItems}
          applying={renameApplying}
          title="Preview Album Rename"
          onOpenChange={setRenamePreviewOpen}
          onApply={handleApplyRenames}
        />
        <RetagPreviewDialog
          open={retagPreviewOpen}
          items={retagPreviewItems}
          applying={retagApplying}
          title="Write Album Tags"
          onOpenChange={setRetagPreviewOpen}
          onApply={handleApplyRetags}
        />
        <Dialog
          open={deleteFilesOpen}
          onOpenChange={(_, data) => {
            if (!data.open && !deleteFilesApplying) {
              setDeleteFilesOpen(false);
              setDeleteFilesUnmonitor(false);
            }
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete album files</DialogTitle>
              <DialogContent>
                Delete imported library files for <strong>{album?.title || "this album"}</strong> from disk
                and remove them from Discogenius tracking. Catalog metadata is kept.
                <div style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={deleteFilesUnmonitor}
                    onChange={(_, data) => setDeleteFilesUnmonitor(Boolean(data.checked))}
                    label="Also unmonitor this album"
                  />
                </div>
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  disabled={deleteFilesApplying}
                  onClick={() => {
                    setDeleteFilesOpen(false);
                    setDeleteFilesUnmonitor(false);
                  }}
                >
                  Cancel
                </Button>
                <Button appearance="primary" disabled={deleteFilesApplying} onClick={() => void handleDeleteAlbumFiles()}>
                  {deleteFilesApplying ? "Deleting…" : "Delete files"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        {/* Header Section */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            {/* Cover art with optional info overlay for local covers */}
            {(() => {
              const coverFiles = (album.files || []).filter(
                (f: any) => f.file_type === 'cover' || f.file_type === 'image' || f.file_type === 'video_cover'
              );
              const hasCoverFile = coverFiles.length > 0;
              return (
                <div className={styles.coverContainer}>
                  {albumArtworkUrl ? (
                    <img
                      key={albumArtworkUrl}
                      {...ultraBlurHeroProps}
                      src={albumArtworkUrl}
                      alt={album.title}
                      className={styles.coverArt}
                      onError={() => setCoverImageFailed(true)}
                    />
                  ) : (
                    <div className={styles.coverPlaceholder}>
                      <MusicNote224 />
                    </div>
                  )}
                  {hasCoverFile && (
                    <div
                      className={styles.coverOverlay}
                      onClick={() => setCoverInfoOpen(true)}
                      title="Artwork info"
                    >
                      <Info24 className={styles.coverInfoIcon} />
                    </div>
                  )}
                </div>
              );
            })()}
            <div className={styles.albumInfo}>
              <div className={styles.titleBlock}>
                <div className={styles.artistInfo}>
                  {renderAlbumArtists()}
                </div>
                <Title1 className={styles.albumTitle}>{album.title}</Title1>
              </div>

              <div className={styles.metadata}>
                {/* Provider+quality pills sit in the middle; the year/track/
                    duration facts go on the bottom row (column on mobile). */}
                {hasAnyProviderOffer ? (
                  <div className={styles.metadataBadges}>
                    <ProviderQualityRow
                      size="medium"
                      offers={[
                        ...(hasStereoOffer
                          ? [{
                              slot: "stereo",
                              quality: album.stereo_quality || album.quality,
                              provider: album.stereo_provider || album.selected_provider,
                              matchStatus: album.stereo_match_status,
                              providerAlbumId: album.stereo_provider_id,
                              selectedReleaseMbid: album.stereo_release_mbid || album.selected_release_mbid,
                              explicit: selectedOfferExplicitBySlot.stereo,
                            }]
                          : []),
                        ...(hasSpatialOffer
                          ? [{
                              slot: "spatial",
                              quality: album.spatial_quality || "DOLBY_ATMOS",
                              provider: album.spatial_provider || album.selected_provider,
                              matchStatus: album.spatial_match_status,
                              providerAlbumId: album.spatial_provider_id,
                              selectedReleaseMbid: album.spatial_release_mbid || album.selected_release_mbid,
                              explicit: selectedOfferExplicitBySlot.spatial,
                            }]
                          : []),
                      ] as ProviderQualityOffer[]}
                    />
                  </div>
                ) : headerQualityBadges.length > 0 ? (
                  <div className={styles.metadataBadges}>
                    {headerQualityBadges.map((badge) => (
                      <QualityBadge key={badge.key} quality={badge.quality} />
                    ))}
                  </div>
                ) : null}
                <div className={styles.metadataFacts}>
                  <Text>{album.release_date ? new Date(album.release_date).getFullYear() : "—"}</Text>
                  <div className={styles.metadataSeparator} />
                  <Text>{tracks.length} Tracks</Text>
                  <div className={styles.metadataSeparator} />
                  <Text>
                    {formatDurationSeconds(tracks.reduce((acc, t) => acc + t.duration, 0))}
                  </Text>
                  {hasSpatialOffer && !hasStereoOffer && (
                    <>
                      <div className={styles.metadataSeparator} />
                      <Text weight="semibold">Dolby Atmos only</Text>
                    </>
                  )}
                </div>
              </div>

              {/* Album Review Section */}
              {(() => {
                const reviewText = (album as any).review ?? (album as any).review_text ?? null;
                const reviewAttribution = formatMetadataAttribution(
                  (album as any).review_source,
                  (album as any).review_last_updated
                );
                if (!reviewText) return null;

                return (
                  <ExpandableMetadataBlock
                    content={parseWimpLinks(reviewText, navigate)}
                    attribution={reviewAttribution}
                    expanded={reviewExpanded}
                    onToggle={() => setReviewExpanded(!reviewExpanded)}
                    preserveWhitespace
                  />
                );
              })()}

              <Overflow minimumVisible={3}>
                <div className={styles.actions}>
                  {/* Monitor Button — icon shows action (what clicking will do) */}
                  <OverflowItem id="monitor" priority={3}>
                    <Button
                      appearance={isMonitored ? "subtle" : "primary"}
                      icon={isMonitored ? <EyeOff24 /> : <Eye24 />}
                      onClick={handleToggleMonitor}
                      disabled={isTogglingMonitor || isLocked}
                      title={isLocked ? "Unlock to change monitoring" : (isMonitored ? "Stop monitoring" : "Start monitoring")}
                      className={mergeClasses(
                        styles.actionButton,
                        isMonitored ? styles.transparentButton : styles.primaryButton
                      )}
                    >
                      {isMonitored ? "Unmonitor" : "Monitor"}
                    </Button>
                  </OverflowItem>

                  {/* Lock Button — icon shows action (what clicking will do) */}
                  <OverflowItem id="lock" priority={2}>
                    <Tooltip content={isLocked ? "Unlock to allow auto-filters to change status" : "Lock to prevent auto-filters from changing status"} relationship="label">
                      <Button
                        appearance="subtle"
                        icon={isLocked ? <LockOpen24 /> : <LockClosed24 />}
                        onClick={handleToggleLock}
                        disabled={isTogglingLock}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        {isLocked ? "Unlock" : "Lock"}
                      </Button>
                    </Tooltip>
                  </OverflowItem>

                  {/* Download Button */}
                  <OverflowItem id="download" priority={1}>
                    {hasStereoOffer && hasSpatialOffer ? (
                      <div className={styles.splitDownload}>
                        <Button
                          icon={<ArrowDownload24 />}
                          appearance="subtle"
                          onClick={handleDownloadPrimary}
                          disabled={downloadingAlbum}
                          title="Download stereo and spatial audio"
                          className={mergeClasses(styles.actionButton, styles.transparentButton, styles.splitDownloadPrimary)}
                        >
                          {downloadingAlbum ? "Adding..." : "Download"}
                        </Button>
                        <Menu>
                          <MenuTrigger disableButtonEnhancement>
                            <Button
                              appearance="subtle"
                              aria-label="Choose download version"
                              icon={<ChevronDown16 />}
                              disabled={downloadingAlbum}
                              className={mergeClasses(styles.actionButton, styles.transparentButton, styles.splitDownloadMenu)}
                            />
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              <MenuItem onClick={() => handleDownloadAlbum()}>Download both</MenuItem>
                              <MenuItem onClick={() => handleDownloadAlbum('stereo')}>Download stereo only</MenuItem>
                              <MenuItem onClick={() => handleDownloadAlbum('spatial')}>Download spatial only</MenuItem>
                            </MenuList>
                          </MenuPopover>
                        </Menu>
                      </div>
                    ) : (
                      <Button
                        icon={<ArrowDownload24 />}
                        appearance="subtle"
                        onClick={handleDownloadPrimary}
                        disabled={downloadingAlbum || !hasAnyProviderOffer}
                        title={hasAnyProviderOffer ? "Download album" : "No provider offer selected"}
                        className={mergeClasses(styles.actionButton, styles.transparentButton)}
                      >
                        {downloadingAlbum ? "Adding..." : "Download"}
                      </Button>
                    )}
                  </OverflowItem>

                  <OverflowItem id="rename-files" priority={0}>
                    <Button
                      appearance="subtle"
                      icon={renameApplying ? <Spinner size="tiny" /> : <FolderSync24 />}
                      onClick={openRenamePreview}
                      disabled={renameApplying}
                      title="Preview album file renames"
                      className={mergeClasses(styles.actionButton, styles.transparentButton)}
                    >
                      Rename
                    </Button>
                  </OverflowItem>

                  <OverflowItem id="retag-files" priority={0}>
                    <Button
                      appearance="subtle"
                      icon={retagApplying ? <Spinner size="tiny" /> : <Tag24 />}
                      onClick={openRetagPreview}
                      disabled={retagApplying}
                      title="Preview album metadata tag changes"
                      className={mergeClasses(styles.actionButton, styles.transparentButton)}
                    >
                      Tags
                    </Button>
                  </OverflowItem>

                  <ActionOverflowMenu actions={albumActions} className={mergeClasses(styles.actionButton, styles.transparentButton)} />
                </div>
              </Overflow>
            </div>
          </div>
        </div>

        {/* Track List Section */}
        {tracks.length === 0 ? (
          <EmptyState
            title="No tracks found"
            description="This album doesn't have any surfaced tracks yet."
            icon={<MusicNote224 />}
            minHeight="220px"
          />
        ) : (
          <TrackList
            tracks={tracks}
            showArtist
            showQuality={true}
            showLocalQuality
            showVolumeHeaders
            contextArtistName={album.artist_name}
            contextAlbumTitle={album.title}
            onDownloadTrack={handleDownloadTrack}
            isTrackDownloading={(track) => downloadingTracks.has(track.id)}
          />
        )}

        {/* Cover Info Dialog */}
        {coverInfoOpen && (() => {
          const coverFiles = (album.files || []).filter(
            (f: any) => f.file_type === 'cover' || f.file_type === 'image' || f.file_type === 'video_cover'
          );
          return (
            <TrackInfoDialog
              open={coverInfoOpen}
              onClose={() => setCoverInfoOpen(false)}
              trackTitle="Album Cover"
              dialogTitle="Artwork Info"
              detailsTitle="Artwork Details"
              artistName={album.artist_name}
              albumTitle={album.title}
              files={coverFiles as TrackFileInfo[]}
            />
          );
        })()}

        {/* Release Group Releases Section */}
        {releaseAvailability && releaseAvailability.releases.length > 0 ? (
          <div className={styles.sectionSpacing}>
            <div className={styles.sectionHeader}>
              <Title2>Releases</Title2>
            </div>
            <ReleaseSwitcher
              availability={releaseAvailability}
              currentReleaseMbid={album.selected_release_mbid || album.stereo_release_mbid || album.spatial_release_mbid}
              includeSpatial={includeSpatial}
              pendingSelectionKey={pendingSelectionKey}
              onSelect={handleSelectReleaseForSlot}
            />
          </div>
        ) : otherVersions.length > 0 ? (
          <div className={styles.sectionSpacing}>
            <div className={styles.sectionHeader}>
              <Title2>Other releases</Title2>
            </div>
            <div className={styles.carousel}>
              {otherVersions.map((version) => {
                const year = version.release_date ? new Date(version.release_date).getFullYear() : '';
                const isSelectedEdition = Boolean(version.id) && [
                  album.stereo_release_mbid,
                  album.spatial_release_mbid,
                  album.selected_release_mbid,
                ].includes(version.id);
                const subtitle = [isSelectedEdition ? 'Selected edition' : null, version.version, year]
                  .filter(Boolean)
                  .join(' · ');
                return renderMiniAlbumCard(version, subtitle, undefined, { to: null });
              })}
            </div>
          </div>
        ) : null}
      </div >
    </DynamicBrandProvider>
  );
};

export default AlbumPage;
