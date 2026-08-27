import {
  Button,
  Caption1,
  Menu,
  MenuButton,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  FolderArrowRight20Filled,
  FolderArrowRight20Regular,
  MusicNote224Regular,
} from "@fluentui/react-icons";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { VideoAlbumRefContract, VideoDetailContract } from "@contracts/media";
import { editionTabLabel } from "@/pages/album/editionDisplay";
import { mediaCoverSrc } from "@/utils/artwork";
import { navigateToAlbum, navigateToAlbumTrack } from "@/utils/albumNavigation";
import { formatDescriptiveTrackPosition } from "@/utils/trackPosition";
import { AppTooltip } from "./AppTooltip";
import type { VideoPlacementRelatedTrack } from "./videoPlacementLabels";

type PlacementUpdate =
  | { mode: "separated" }
  | { mode: "inline"; inlineTrackId: number; placementLibraryId: number };

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0, width: "100%" },
  headingRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: tokens.spacingHorizontalS, minWidth: 0 },
  label: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  list: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: tokens.spacingVerticalXS,
    width: "100%",
    minWidth: 0,
    "@media (min-width: 640px)": { gridTemplateColumns: "repeat(2, minmax(200px, 1fr))", gap: tokens.spacingHorizontalS },
    "@media (min-width: 960px)": { gridTemplateColumns: "repeat(3, minmax(220px, 1fr))" },
  },
  row: {
    display: "flex",
    alignItems: "stretch",
    minWidth: 0,
    width: "100%",
    border: `${tokens.strokeWidthThin} solid transparent`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorSubtleBackground,
    transitionProperty: "background-color, box-shadow, transform",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": { backgroundColor: tokens.colorNeutralBackgroundAlpha, boxShadow: tokens.shadow4, transform: "translateY(-1px)" },
  },
  navigation: {
    display: "flex",
    alignItems: "center",
    flex: 1,
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    margin: 0,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: "transparent",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":focus-visible": { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: "-2px" },
  },
  cover: { width: "40px", height: "40px", borderRadius: tokens.borderRadiusSmall, objectFit: "cover", backgroundColor: tokens.colorNeutralBackground3, flexShrink: 0 },
  coverPlaceholder: { width: "40px", height: "40px", borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: tokens.colorNeutralForeground4 },
  info: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  title: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  subtitle: { color: tokens.colorNeutralForeground3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  placementSlot: { display: "flex", alignItems: "center", paddingRight: tokens.spacingHorizontalXS },
  placementButton: { minWidth: "32px", color: tokens.colorNeutralForeground2 },
  selectedPlacementButton: { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2 },
  placementText: { "@media (max-width: 639px)": { display: "none" } },
  footer: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
});

function editionLabel(track: VideoPlacementRelatedTrack): string {
  const label = editionTabLabel({
    title: track.edition_title ?? track.album_title ?? null,
    disambiguation: track.edition_disambiguation ?? null,
    country: track.edition_country ?? null,
    mediaFormats: track.edition_media_formats ?? [],
    trackCount: track.edition_track_count ?? null,
  }, track.album_title);
  const year = String(track.edition_date || "").slice(0, 4);
  return [label, year || null, track.library_name || null].filter(Boolean).join(" · ");
}

function placementKey(track: VideoPlacementRelatedTrack): string {
  return `${track.id}:${track.placement_library_id ?? ""}`;
}

export function VideoAlbumAffiliation({
  albums,
  placement,
  relatedTracks,
  disabled = false,
  onPlacementChange,
  showKeepAction = false,
  keepDisabled = false,
  onKeep,
  className,
}: {
  albums: VideoAlbumRefContract[];
  placement: VideoDetailContract["placement"];
  relatedTracks: VideoPlacementRelatedTrack[];
  disabled?: boolean;
  onPlacementChange: (placement: PlacementUpdate) => void;
  showKeepAction?: boolean;
  keepDisabled?: boolean;
  onKeep?: () => void;
  className?: string;
}) {
  const styles = useStyles();
  const navigate = useNavigate();
  const [showUnmonitored, setShowUnmonitored] = useState(false);
  const monitoredAlbums = useMemo(() => albums.filter((album) => album.is_monitored), [albums]);
  const currentTrack = placement?.mode === "inline"
    ? relatedTracks.find((track) => track.id === placement.inline_track_id
      && (track.placement_library_id == null || track.placement_library_id === placement.placement_library_id))
    : undefined;
  const currentAlbumId = currentTrack?.album_id ?? null;
  const hasMonitoredAlbums = monitoredAlbums.length > 0;
  const hiddenUnmonitoredCount = albums.filter((album) => !album.is_monitored && album.id !== currentAlbumId).length;
  const visibleAlbums = hasMonitoredAlbums && !showUnmonitored
    ? albums.filter((album) => album.is_monitored || album.id === currentAlbumId)
    : albums;
  const separated = placement?.mode !== "inline";

  if (albums.length === 0) return null;

  return (
    <section className={mergeClasses(styles.root, className)} aria-labelledby="video-appears-on-heading">
      <div className={styles.headingRow}>
        <Caption1 id="video-appears-on-heading" className={styles.label}>Appears on</Caption1>
        {hasMonitoredAlbums && hiddenUnmonitoredCount > 0 ? (
          <Button appearance="subtle" size="small" aria-expanded={showUnmonitored} aria-controls="video-appears-on-list" onClick={() => setShowUnmonitored((value) => !value)}>
            {showUnmonitored ? "Hide unmonitored" : `Show ${hiddenUnmonitoredCount} unmonitored`}
          </Button>
        ) : null}
      </div>
      <div id="video-appears-on-list" className={styles.list}>
        {visibleAlbums.map((album) => {
          const coverUrl = mediaCoverSrc(album) || undefined;
          const position = formatDescriptiveTrackPosition(album);
          const targets = relatedTracks.filter((track) => track.album_id === album.id && track.placement_library_id != null);
          const selectedTarget = targets.find((track) => track.id === placement?.inline_track_id && track.placement_library_id === placement.placement_library_id);
          const goToAlbum = () => album.track_mbid
            ? navigateToAlbumTrack(navigate, album.id, album.track_mbid)
            : navigateToAlbum(navigate, album.id);
          const placementControl = (() => {
            if (targets.length === 0) return null;
            if (targets.length === 1) {
              const target = targets[0];
              const selected = Boolean(selectedTarget);
              return (
                <AppTooltip content={selected ? "This video is stored beside this album" : `Store beside ${album.title}`} relationship="label">
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={selected ? <FolderArrowRight20Filled /> : <FolderArrowRight20Regular />}
                    className={mergeClasses(styles.placementButton, selected && styles.selectedPlacementButton)}
                    aria-current={selected ? "location" : undefined}
                    onClick={() => onPlacementChange({ mode: "inline", inlineTrackId: target.id, placementLibraryId: target.placement_library_id! })}
                    disabled={disabled || selected}
                  >
                    {selected ? <span className={styles.placementText}>Placed here</span> : null}
                  </Button>
                </AppTooltip>
              );
            }
            return (
              <Menu
                checkedValues={{ placement: selectedTarget ? [placementKey(selectedTarget)] : [] }}
                onCheckedValueChange={(_, data) => {
                  const target = targets.find((candidate) => placementKey(candidate) === data.checkedItems[0]);
                  if (target?.placement_library_id != null) {
                    onPlacementChange({ mode: "inline", inlineTrackId: target.id, placementLibraryId: target.placement_library_id });
                  }
                }}
              >
                <MenuTrigger disableButtonEnhancement>
                  <MenuButton
                    appearance="subtle"
                    size="small"
                    icon={selectedTarget ? <FolderArrowRight20Filled /> : <FolderArrowRight20Regular />}
                    className={mergeClasses(styles.placementButton, selectedTarget && styles.selectedPlacementButton)}
                    aria-label={`Choose an edition of ${album.title} for this video file`}
                    aria-current={selectedTarget ? "location" : undefined}
                    disabled={disabled}
                  >
                    {selectedTarget ? <span className={styles.placementText}>Placed here</span> : null}
                  </MenuButton>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {targets.map((target) => (
                      <MenuItemRadio key={placementKey(target)} name="placement" value={placementKey(target)}>
                        {editionLabel(target)}
                      </MenuItemRadio>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            );
          })();

          return (
            <div key={album.id} className={styles.row}>
              <button
                type="button"
                className={styles.navigation}
                onClick={goToAlbum}
                aria-label={position ? `Open album ${album.title}, ${position}` : `Open album ${album.title}`}
              >
                {coverUrl ? <img src={coverUrl} alt="" className={styles.cover} /> : (
                  <div className={styles.coverPlaceholder} aria-hidden="true"><MusicNote224Regular /></div>
                )}
                <div className={styles.info}>
                  <Text className={styles.title}>{album.title}</Text>
                  {position ? <Caption1 className={styles.subtitle}>{position}</Caption1> : null}
                </div>
              </button>
              {placementControl ? <div className={styles.placementSlot}>{placementControl}</div> : null}
            </div>
          );
        })}
      </div>
      <div className={styles.footer}>
        <Button
          appearance="subtle"
          size="small"
          icon={separated ? <FolderArrowRight20Filled /> : <FolderArrowRight20Regular />}
          className={mergeClasses(separated && styles.selectedPlacementButton)}
          aria-current={separated ? "location" : undefined}
          disabled={disabled || separated}
          onClick={() => onPlacementChange({ mode: "separated" })}
        >
          {separated ? "Stored in Video library" : "Use Video library"}
        </Button>
        {showKeepAction && onKeep ? (
          <Button appearance="subtle" size="small" disabled={keepDisabled} onClick={onKeep}>Keep in library</Button>
        ) : null}
      </div>
    </section>
  );
}
