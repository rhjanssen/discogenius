import { Fragment, useState, useCallback, useMemo, useLayoutEffect, useRef, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { formatDurationSeconds } from "@/utils/format";
import {
  AvatarGroup,
  AvatarGroupItem,
  Badge,
  Button,
  Card,
  Text,
  Title1,
  Title2,
  Tooltip,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
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
  MusicNote224Regular,
  ChevronDown16Regular,
  CheckmarkCircle16Filled,
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
import { parseWimpLinks } from "@/utils/wimpLinks";
import { formatMetadataAttribution } from "@/utils/date";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import { getAlbumPath, getAlbumRouteTrackTarget } from "@/utils/albumNavigation";
import { getAlbumCover } from "@/utils/tidalImages";
import {
  detailActionGlassButtonStyles,
  detailActionPrimaryButtonStyles,
  standardDetailActionButtonStyles,
} from "@/components/media/detailActionStyles";
import { ActionOverflowMenu, type OverflowAction } from "@/components/overflow/ActionOverflowMenu";

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
    width: "168px",
    height: "168px",
    objectFit: "cover",
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow28,
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "200px",
      height: "200px",
    },
    "@media (min-width: 768px)": {
      width: "220px",
      height: "220px",
      boxShadow: tokens.shadow64,
    },
  },
  coverPlaceholder: {
    width: "168px",
    height: "168px",
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    color: tokens.colorNeutralForeground4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    "@media (min-width: 480px)": {
      width: "200px",
      height: "200px",
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
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    width: "100%",
    alignItems: "center",
    textAlign: "center",
    "@media (min-width: 768px)": {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      textAlign: "left",
      gap: tokens.spacingVerticalM,
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
    rowGap: tokens.spacingVerticalS,
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
    "@media (min-width: 768px)": {
      justifyContent: "flex-start",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      marginTop: tokens.spacingVerticalM,
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingHorizontalXS,
    "& .fui-Button__content": {
      fontSize: tokens.fontSizeBase200,
      lineHeight: tokens.lineHeightBase200,
      marginLeft: "0 !important",
      whiteSpace: "nowrap",
    },
    "& .fui-Button__icon": {
      marginRight: 0,
      flexShrink: 0,
    },
    "@media (min-width: 768px)": {
      ...standardDetailActionButtonStyles["@media (min-width: 768px)"],
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
    flex: "1 1 0",
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
  // Similar Albums Section
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
  // Edition cards in the "Other releases" / "Similar albums" grids use the
  // shared card surface from useCardStyles (components/cards/cardStyles.ts) via
  // MediaCard. This page-specific key only highlights the edition currently
  // being viewed.
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
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(10px)",
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  },
  albumFilesHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  releaseSwitcher: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    width: "100%",
  },
  releaseRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    "@media (min-width: 820px)": {
      gridTemplateColumns: "minmax(0, 1fr) auto",
      alignItems: "center",
      gap: tokens.spacingHorizontalL,
    },
  },
  releaseMain: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  releaseTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  releaseTitle: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  releaseMeta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground2,
  },
  releaseAvailability: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  releaseSlotActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    "@media (min-width: 820px)": {
      justifyContent: "flex-end",
      flexWrap: "nowrap",
    },
  },
  unavailableText: {
    color: tokens.colorNeutralForeground3,
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
const SWITCHABLE_SLOTS = ["stereo", "spatial"] as const;
type SwitchableSlot = (typeof SWITCHABLE_SLOTS)[number];

function slotLabel(slot: SwitchableSlot): string {
  return slot === "spatial" ? "Spatial" : "Stereo";
}

function providerDisplayName(provider?: string | null): string {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!normalized) return "Provider";
  if (normalized === "tidal") return "TIDAL";
  if (normalized.startsWith("apple")) return "Apple Music";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function releaseYear(date?: string | null): string | null {
  if (!date) return null;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? String(year) : date.slice(0, 4) || null;
}

function releaseCountryLabel(country?: string | null): string | null {
  const text = String(country || "").trim();
  if (!text || text === "[]") return null;
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item || "").replace(/^\[|\]$/g, "").trim())
          .filter(Boolean)
          .join(", ") || null;
      }
    } catch {
      return text;
    }
  }
  return text.replace(/^\[|\]$/g, "").trim() || null;
}

function releaseDisambiguationLabel(disambiguation?: string | null): string | null {
  const text = String(disambiguation || "").trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function releaseCountLabel(count: number | null | undefined, singular: string, plural: string): string | null {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function releaseStatusLabel(status?: string | null): string | null {
  const text = String(status || "").trim();
  if (!text || text.toLowerCase() === "official") return null;
  return text;
}

function releaseMetaParts(release: ReleaseGroupAvailability["releases"][number]): string[] {
  return [
    releaseYear(release.date),
    releaseCountryLabel(release.country),
    releaseCountLabel(release.mediumCount, "medium", "media"),
    releaseCountLabel(release.trackCount, "track", "tracks"),
    release.format ? `[${release.format}]` : null,
    release.duration ? formatDurationSeconds(release.duration) : null,
    releaseStatusLabel(release.status),
  ].filter((part): part is string => Boolean(part));
}

function isSpatialQuality(quality?: string | null): boolean {
  const normalized = String(quality || "").toUpperCase();
  return normalized.includes("ATMOS") || normalized.includes("SPATIAL") || normalized.includes("360");
}

function chooseAvailabilityForSlot(
  release: ReleaseGroupAvailability["releases"][number],
  slot: SwitchableSlot,
): ReleaseGroupAvailability["releases"][number]["availability"][number] | null {
  const exact = release.availability.find((offer) => String(offer.librarySlot || "").toLowerCase() === slot);
  if (exact) return exact;
  if (slot === "spatial") {
    return release.availability.find((offer) => isSpatialQuality(offer.quality)) ?? null;
  }
  return release.availability.find((offer) => !isSpatialQuality(offer.quality)) ?? release.availability[0] ?? null;
}

interface ReleaseSwitcherProps {
  availability: ReleaseGroupAvailability;
  currentReleaseMbid?: string | null;
  pendingSelectionKey?: string | null;
  onSelect: (slot: SwitchableSlot, releaseMbid: string, offer: ReleaseGroupAvailability["releases"][number]["availability"][number]) => void;
}

function ReleaseSwitcher({
  availability,
  currentReleaseMbid,
  pendingSelectionKey,
  onSelect,
}: ReleaseSwitcherProps) {
  const styles = useStyles();
  const releases = availability.releases;

  if (releases.length === 0) {
    return null;
  }

  return (
    <div className={styles.releaseSwitcher}>
      {releases.map((release) => {
        const disambiguation = releaseDisambiguationLabel(release.disambiguation);
        const metaParts = releaseMetaParts(release);
        const selectedSlots = SWITCHABLE_SLOTS.filter((slot) => availability.selectedReleaseBySlot[slot] === release.releaseMbid);
        const providerOffers = Array.from(release.availability.reduce((deduped, offer) => {
          const slot = String(offer.librarySlot || "").toLowerCase();
          if (slot !== "stereo" && slot !== "spatial") {
            return deduped;
          }
          const key = `${offer.provider || ""}|${slot}|${offer.quality || ""}`;
          if (!deduped.has(key)) {
            deduped.set(key, {
              slot,
              quality: offer.quality,
              provider: offer.provider,
              matchStatus: offer.status,
              providerAlbumId: offer.providerAlbumId,
              selectedReleaseMbid: release.releaseMbid,
            } satisfies ProviderQualityOffer);
          }
          return deduped;
        }, new Map<string, ProviderQualityOffer>()).values());

        return (
          <Card key={release.releaseMbid} className={styles.releaseRow}>
            <div className={styles.releaseMain}>
              <div className={styles.releaseTitleRow}>
                <Text weight="semibold" className={styles.releaseTitle}>
                  {release.title || "Untitled release"}
                </Text>
                {disambiguation ? (
                  <Badge appearance="outline" color="subtle">{disambiguation}</Badge>
                ) : null}
                {release.releaseMbid === currentReleaseMbid ? (
                  <Badge appearance="outline" color="subtle">Current page</Badge>
                ) : null}
                {selectedSlots.map((slot) => (
                  <Badge key={slot} appearance="tint" color="success">{slotLabel(slot)}</Badge>
                ))}
              </div>
              <div className={styles.releaseMeta}>
                {metaParts.length > 0 ? <Text size={200}>{metaParts.join(" · ")}</Text> : null}
                <Tooltip content={release.releaseMbid} relationship="label">
                  <Text size={100}>{release.releaseMbid}</Text>
                </Tooltip>
              </div>
              <div className={styles.releaseAvailability}>
                {providerOffers.length > 0 ? (
                  <ProviderQualityRow offers={providerOffers} size="small" />
                ) : (
                  <Text size={200} className={styles.unavailableText}>No matched provider offer</Text>
                )}
              </div>
            </div>
            <div className={styles.releaseSlotActions}>
              {SWITCHABLE_SLOTS.map((slot) => {
                const offer = chooseAvailabilityForSlot(release, slot);
                const selected = availability.selectedReleaseBySlot[slot] === release.releaseMbid;
                const pending = pendingSelectionKey === `${slot}:${release.releaseMbid}`;
                const disabled = !offer || selected || Boolean(pendingSelectionKey);
                const providerName = providerDisplayName(offer?.provider);
                const buttonLabel = selected ? `${slotLabel(slot)} selected` : `Use for ${slotLabel(slot)}`;
                return (
                  <Button
                    key={slot}
                    size="small"
                    appearance={selected ? "primary" : "secondary"}
                    disabled={disabled}
                    onClick={() => offer ? onSelect(slot, release.releaseMbid, offer) : undefined}
                    title={offer ? `${buttonLabel} from ${providerName}` : `No ${slotLabel(slot).toLowerCase()} offer for this release`}
                  >
                    {pending ? "Saving..." : buttonLabel}
                  </Button>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

const AlbumPage = () => {
  const styles = useStyles();
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { toggleMonitor, toggleLock, isTogglingMonitor, isTogglingLock } = useMonitoring();
  const { downloadingTracks, handleDownloadTrack } = useTrackQueueActions();

  const { getProgressByProviderId } = useQueueStatus();
  const [downloadingAlbum, setDownloadingAlbum] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [coverInfoOpen, setCoverInfoOpen] = useState(false);
  const [coverImageFailed, setCoverImageFailed] = useState(false);
  const [providerCoverImageFailed, setProviderCoverImageFailed] = useState(false);
  const [pendingSelectionKey, setPendingSelectionKey] = useState<string | null>(null);
  const handledTrackScrollKeyRef = useRef<string | null>(null);

  const { data: pageData, isLoading: loading, error, refetch } = useAlbumPage(albumId);
  const album = pageData?.album ?? null;
  const tracks = pageData?.tracks ?? EMPTY_ALBUM_TRACKS;

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
  const similarAlbums = useMemo(() => {
    const items = pageData?.similarAlbums ?? [];

    return items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const popularityDiff = (Number(right.item.popularity || 0) - Number(left.item.popularity || 0));
        if (popularityDiff !== 0) {
          return popularityDiff;
        }

        return left.index - right.index;
      })
      .map(({ item }) => item);
  }, [pageData?.similarAlbums]);
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
  const albumSkyHookArtworkUrl = album ? (album.cover_art_url || null) : null;
  const albumProviderArtworkUrl = album
    ? getAlbumCover((album as any).provider_cover_id, "large")
    : null;
  const albumStoredArtworkUrl = album
    ? (getAlbumCover(album.cover || album.cover_id, "large") || album.cover || album.cover_id || null)
    : null;
  const albumStoredFallbackUrl = albumStoredArtworkUrl
    && albumStoredArtworkUrl !== albumSkyHookArtworkUrl
    && albumStoredArtworkUrl !== albumProviderArtworkUrl
    ? albumStoredArtworkUrl
    : null;
  const albumArtworkUrl = album
    ? (
      albumSkyHookArtworkUrl && !coverImageFailed
        ? albumSkyHookArtworkUrl
        : albumProviderArtworkUrl && !providerCoverImageFailed
          ? albumProviderArtworkUrl
          : albumStoredFallbackUrl
    )
    : undefined;
  const albumBrandColor = useArtworkBrandColor({
    artworkUrl: albumArtworkUrl,
    brandKeyColor: album?.vibrant_color ?? null,
    // MusicBrainz-canonical albums have no provider vibrant_color, so derive
    // the accent from the cover like the artist/video pages do — otherwise
    // brand-driven UI (seekbar, buttons) stays on the default orange while
    // UltraBlur already shows the artwork tint.
    deriveBrandFromArtwork: true,
  });

  useEffect(() => {
    setCoverImageFailed(false);
    setProviderCoverImageFailed(false);
  }, [albumSkyHookArtworkUrl, albumProviderArtworkUrl]);

  const isMonitored = !!album?.is_monitored;
  const isLocked = !!album?.monitored_lock;
  const hasStereoOffer = Boolean(album?.stereo_provider_id);
  const hasSpatialOffer = Boolean(album?.spatial_provider_id);
  const hasAnyProviderOffer = hasStereoOffer || hasSpatialOffer;
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

  const albumActions: OverflowAction[] = [
    { key: 'monitor', label: isMonitored ? 'Unmonitor' : 'Monitor', disabled: isTogglingMonitor || isLocked, onClick: handleToggleMonitor },
    { key: 'lock', label: isLocked ? 'Unlock' : 'Lock', disabled: isTogglingLock, onClick: handleToggleLock },
    { key: 'download', label: downloadingAlbum ? 'Adding...' : 'Download selected', disabled: downloadingAlbum || !hasAnyProviderOffer, onClick: handleDownloadPrimary },
    ...(album?.stereo_provider_id ? [{ key: 'download-stereo', label: 'Download stereo', disabled: downloadingAlbum, onClick: () => handleDownloadAlbum('stereo') }] : []),
    ...(album?.spatial_provider_id ? [{ key: 'download-spatial', label: 'Download spatial', disabled: downloadingAlbum, onClick: () => handleDownloadAlbum('spatial') }] : []),
  ];

  /** Open track info dialog */
  const showIngestSkeleton = Boolean(activity?.scanning) && tracks.length === 0;

  if (loading || showIngestSkeleton) {
    return (
      <DetailPageSkeleton
        artShape="rounded"
        content="tracks"
        rows={8}
        className={styles.container}
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
        imageUrl={getAlbumCover(item.cover_id || item.cover, "medium") || item.cover_id || item.cover || null}
        fallbackImageUrl={getAlbumCover(item.provider_cover_id, "medium")}
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
                      src={albumArtworkUrl}
                      alt={album.title}
                      className={styles.coverArt}
                      decoding="async"
                      onError={() => {
                        if (albumSkyHookArtworkUrl && !coverImageFailed && albumProviderArtworkUrl) {
                          setCoverImageFailed(true);
                        } else {
                          setProviderCoverImageFailed(true);
                        }
                      }}
                    />
                  ) : (
                    <div className={styles.coverPlaceholder}>
                      <MusicNote224Regular />
                    </div>
                  )}
                  {hasCoverFile && (
                    <div
                      className={styles.coverOverlay}
                      onClick={() => setCoverInfoOpen(true)}
                      title="Artwork info"
                    >
                      <Info24Regular className={styles.coverInfoIcon} />
                    </div>
                  )}
                </div>
              );
            })()}
            <div className={styles.albumInfo}>
              <Title1 className={styles.albumTitle}>{album.title}</Title1>

              <div
                className={styles.artistInfo}
              >
                {renderAlbumArtists()}
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
                      icon={isMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
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
                        icon={isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />}
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
                          icon={<ArrowDownload24Regular />}
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
                              icon={<ChevronDown16Regular />}
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
                        icon={<ArrowDownload24Regular />}
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
            icon={<MusicNote224Regular />}
            minHeight="220px"
          />
        ) : (
          <TrackList
            tracks={tracks}
            showArtist
            showQuality={true}
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

        {/* Similar Albums Section */}
        {
          similarAlbums.length > 0 && (
            <div className={styles.sectionSpacing}>
              <div className={styles.sectionHeader}>
                <Title2>Similar Albums</Title2>
              </div>
              <div className={styles.carousel}>
                {similarAlbums.map((similarAlbum) => {
                  const year = similarAlbum.release_date ? new Date(similarAlbum.release_date).getFullYear() : '';
                  const subtitle = [similarAlbum.artist_name, year].filter(Boolean).join(' · ');
                  const sProgress = getProgressByProviderId(String(similarAlbum.id));
                  return renderMiniAlbumCard(similarAlbum, subtitle, sProgress);
                })}
              </div>
            </div>
          )
        }
      </div >
    </DynamicBrandProvider>
  );
};

export default AlbumPage;
